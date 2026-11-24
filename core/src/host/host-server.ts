export {};

/**
 * 连接宿主（socket host）：每条游戏连接一个进程，只做「传输层」。
 *
 * 职责（**不含任何 gamepb.* 业务协议**）：
 *   1. 持有 WebSocket（握手参数由业务 worker 提供，宿主不解析）
 *   2. 上行加密（TSDK encryptBuffer）+ 网关 token + GateMessage 信封
 *   3. 心跳（自造帧、漏拍补发、静默判死）——worker 重启期间心跳不断
 *   4. ACE/TSDK 运行时（AntiData 上报、processReceivedData、heartbeat_tick）
 *   5. 把入站信封解成「service/method/明文 body」转给 worker；notify 原样转 EventMessage 字节
 *
 * 因此：业务 proto、自动化调度、静态配置、数据迁移、前端 UI 全部可以在 worker 侧
 * 热重启而不影响这条连接；只有「握手参数格式 / 信封 / 心跳帧 / ACE 协议」变更
 * 才需要重启宿主（那时必然掉线）。
 *
 * 与 worker 的通道：Windows named pipe / 其它平台 Unix socket，帧格式见 ./frame。
 */

const net = require('node:net');
const WebSocket = require('ws');

const { types, loadProto } = require('../utils/proto');
const { toLong, toNum } = require('../utils/utils');
const cryptoWasm = require('../utils/crypto-wasm');
const { GatewayTokenProvider } = require('../utils/gateway-token');
const { MAX_HEARTBEAT_MISSES, shouldTerminateForHeartbeat, shouldTerminateForSilence } = require('../utils/keepalive-policy');
const { startAceRuntime, stopAceRuntime } = require('../services/ace');
const { encodeFrame, createFrameDecoder } = require('./frame');
const { upsertHostEntry, removeHostEntry } = require('./registry');

/** 线程序号与宿主 seq 段：网关只接受连续序号，因此由宿主统一分配（见 allocSeq）。 */
const HEARTBEAT_REQUEST_TIMEOUT = 8000;
const HEARTBEAT_RETRY_DELAY = 3000;
const DEFAULT_HEARTBEAT_INTERVAL = 25000;
const CONNECT_TIMEOUT = 20000;

/** 断线期间缓存的推送事件：条数、字节、存活时间都设上限，避免宿主被撑爆。 */
const MAX_BUFFERED_NOTIFIES = 512;
const MAX_BUFFERED_NOTIFY_BYTES = 8 * 1024 * 1024;
const BUFFERED_NOTIFY_TTL_MS = 120000;
/** 没有业务 worker 接管多久后自行退出（主进程崩溃 / 被 kill 时的兜底回收）。 */
const HOST_ORPHAN_IDLE_MS = Math.max(60000, Number(process.env.FARM_HOST_IDLE_MS) || 15 * 60 * 1000);
/** 刚起来还没连上网关、也没 worker 时的启动宽限：主进程可能正忙，不能一刀切。 */
const HOST_NO_CONNECTION_GRACE_MS = 2 * 60 * 1000;
/** 注册表 / 空闲检查间隔。 */
const WATCHDOG_INTERVAL = 30000;

class HostServer {
    accountId: string;
    pipeName: string;
    token: string;
    server: any = null;
    worker: any = null;
    decoder: any = null;
    socket: any = null;
    socketReady: boolean = false;
    hostSeq: number = 0;
    serverSeq: number = 0;
    tokens: any = new GatewayTokenProvider();
    /** 宿主自己发起的请求（心跳 / ACE）的回包等待表，键是线程序号。 */
    pending: Map<number, any> = new Map();
    /**
     * 线程序号 → 业务 worker 的请求号。
     *
     * 网关对 client_seq 的连续性敏感：宿主另起一段序号（比如从 100 万开始）发出的请求，
     * 服务器连回包都不给。所以序号统一由宿主分配，worker 只提供自己的请求号用于回调配对。
     */
    seqMap: Map<number, number> = new Map();
    heartbeat: { attempts: number; replies: number; failures: number; misses: number } = { attempts: 0, replies: 0, failures: 0, misses: 0 };
    heartbeatTimer: any = null;
    retryTimer: any = null;
    beatInFlight: boolean = false;
    /** 最近一次「业务 worker 自己发心跳」的时间：worker 在线时宿主心跳让路。 */
    lastWorkerHeartbeatAt: number = 0;
    session: { gid: number; openId: string; clientVersion: string; heartbeatInterval: number } | null = null;
    /** worker 交来的会话快照（昵称/等级/金币/已解锁场景…）：宿主只存不解析，attach 时原样还回去。 */
    sessionState: any = null;
    /** 当前网关目标（url + 握手头指纹），用于「重复 connect 不重连」。 */
    gatewayTarget: string = '';
    /** worker 离线期间收到的推送：重新 attach 后补发，避免热重启丢事件。 */
    notifyBuffer: Array<{ service: string; method: string; body: Buffer; at: number }> = [];
    notifyBufferBytes: number = 0;
    droppedNotifies: number = 0;
    aceStarted: boolean = false;
    watchdogTimer: any = null;
    lastWorkerAttachAt: number = Date.now();
    lastInboundAt: number = Date.now();
    lastHeartbeatAt: number = Date.now();
    closed: boolean = false;
    generation: number = 0;
    logger: any;

    constructor(options: { accountId: string; pipeName: string; token: string; logger?: any }) {
        this.accountId = String(options.accountId || '');
        this.pipeName = options.pipeName;
        this.token = options.token;
        this.logger = options.logger || console;
    }

    log(message: string): void {
        this.logger.log(`[host:${this.accountId}] ${message}`);
    }

    warn(message: string): void {
        this.logger.warn(`[host:${this.accountId}] ${message}`);
    }

    // ==================== 管道服务 ====================

    listen(): Promise<void> {
        // 宿主是独立进程，proto 不会像 worker 那样被业务层提前加载：
        // GateMessage 信封与心跳请求都在这里用，必须先加载完再对外宣称就绪。
        return Promise.resolve(loadProto()).then(() => new Promise<void>((resolve, reject) => {
            const server = net.createServer(socket => this.onWorkerConnection(socket));
            server.on('error', (error: any) => {
                this.warn(`管道监听失败: ${error?.message || error}`);
                reject(error);
            });
            server.listen(this.pipeName, () => {
                this.log(`连接宿主已就绪，管道 ${this.pipeName}`);
                // 先登记再回 ready：主进程重启后靠这份注册表找回这条连接。
                upsertHostEntry({
                    accountId: this.accountId,
                    pipe: this.pipeName,
                    token: this.token,
                    pid: process.pid,
                    startedAt: Date.now(),
                });
                this.startWatchdog();
                resolve();
            });
            this.server = server;
        }));
    }

    onWorkerConnection(socket: any): void {
        // 单 worker 模型：新连接直接替换旧连接（worker 重启后重新 attach）。
        if (this.worker && this.worker !== socket) {
            try { this.worker.destroy(); } catch {}
        }
        this.worker = socket;
        this.lastWorkerAttachAt = Date.now();
        this.decoder = createFrameDecoder(frame => this.onWorkerFrame(frame));
        socket.on('data', (chunk: Buffer) => {
            try {
                this.decoder(chunk);
            } catch (error: any) {
                this.warn(`管道帧解码失败，断开 worker: ${error?.message || error}`);
                try { socket.destroy(); } catch {}
            }
        });
        socket.on('error', (error: any) => this.warn(`管道错误: ${error?.message || error}`));
        socket.on('close', () => {
            if (this.worker === socket) {
                this.worker = null;
                this.lastWorkerAttachAt = Date.now();
                this.log('业务 worker 已断开；连接与心跳继续保持，等待重新 attach');
            }
        });
        this.log('业务 worker 已连接');
    }

    sendToWorker(meta: Record<string, any>, body?: Buffer): void {
        if (!this.worker || this.worker.destroyed) return;
        try {
            this.worker.write(encodeFrame(meta, body));
        } catch (error: any) {
            this.warn(`向 worker 写帧失败: ${error?.message || error}`);
        }
    }

    onWorkerFrame(frame: { meta: any; body?: Buffer }): void {
        const meta = frame.meta || {};
        switch (meta.t) {
            case 'hello':
                if (String(meta.token || '') !== this.token) {
                    this.warn('worker 鉴权失败，断开');
                    try { this.worker?.destroy(); } catch {}
                    return;
                }
                this.sendToWorker({
                    t: 'hello-ok',
                    accountId: this.accountId,
                    connected: this.socketReady,
                    session: this.session ? { ...this.session, state: this.sessionState } : null,
                    bufferedNotifies: this.notifyBuffer.length,
                });
                // 新 worker 的请求号从头开始：旧的映射一律作废，避免把迟到回包串到新请求上。
                this.seqMap.clear();
                // hello-ok 之后立刻补发断线期间的推送：业务 worker 已完成初始化再收事件。
                this.replayBufferedNotifies();
                return;
            case 'connect':
                void this.connectGateway(String(meta.url || ''), meta.headers || {});
                return;
            case 'req':
                void this.forwardRpc(toNum(meta.seq), String(meta.service || ''), String(meta.method || ''), frame.body);
                return;
            case 'session':
                void this.applySession(meta);
                return;
            case 'session-state':
                this.sessionState = meta.state && typeof meta.state === 'object' ? meta.state : null;
                return;
            case 'close':
                this.closeGateway('worker 请求关闭', true);
                return;
            default:
                this.warn(`未知的 worker 指令: ${String(meta.t)}`);
        }
    }

    // ==================== 网关连接 ====================

    async connectGateway(url: string, headers: Record<string, any>): Promise<void> {
        if (!url) {
            this.sendToWorker({ t: 'connect-err', message: '缺少网关地址' });
            return;
        }
        const target = `${url}::${JSON.stringify(headers || {})}`;
        // 幂等：同一条连接上重复下发的 connect（worker 重试 / attach 后补发登录）直接复用，
        // 否则每次热重启都会把好端端的游戏连接拆掉重连。
        if (this.socketReady && this.gatewayTarget === target) {
            this.log('收到重复建连指令，复用现有连接');
            this.sendToWorker({ t: 'open' });
            if (this.session) this.sendToWorker({ t: 'session-ok', reused: true });
            return;
        }
        this.closeGateway('重新建连', false);
        this.generation += 1;
        const generation = this.generation;
        this.gatewayTarget = target;
        this.socketReady = false;
        this.serverSeq = 0;
        this.hostSeq = 0;
        this.seqMap.clear();
        this.tokens.clear();
        this.session = null;
        this.lastInboundAt = Date.now();
        this.lastHeartbeatAt = Date.now();
        this.heartbeat = { attempts: 0, replies: 0, failures: 0, misses: 0 };

        let socket: any;
        try {
            socket = new WebSocket(url, { handshakeTimeout: CONNECT_TIMEOUT, headers });
        } catch (error: any) {
            this.sendToWorker({ t: 'connect-err', message: String(error?.message || error) });
            return;
        }
        this.socket = socket;
        socket.binaryType = 'arraybuffer';

        socket.on('open', () => {
            if (generation !== this.generation) return;
            this.socketReady = true;
            this.log(`网关已连接${this.session ? '' : '（等待 worker 完成登录）'}`);
            this.sendToWorker({ t: 'open' });
        });

        socket.on('message', (data: any) => {
            if (generation !== this.generation) return;
            try {
                this.onGatewayMessage(Buffer.isBuffer(data) ? data : Buffer.from(data));
            } catch (error: any) {
                this.warn(`入站帧处理失败: ${error?.message || error}`);
            }
        });

        socket.on('close', (code: number, reason: any) => {
            if (generation !== this.generation) return;
            this.socketReady = false;
            // 连接已断：清掉会话，避免新 worker attach 时误以为「宿主还有存活会话」直接复用。
            this.session = null;
            this.gatewayTarget = '';
            this.failAllPending(new Error(`连接已断开 code=${code}`));
            this.stopHeartbeat();
            this.log(`网关连接已断开 (code=${code}${reason ? `, ${reason}` : ''})`);
            this.sendToWorker({ t: 'close', code: Number(code) || 0, reason: String(reason || '') });
        });

        socket.on('error', (error: any) => {
            if (generation !== this.generation) return;
            this.warn(`网关连接错误: ${error?.message || error}`);
            this.sendToWorker({ t: 'socket-error', message: String(error?.message || error) });
        });
    }

    closeGateway(reason: string, notifyWorker: boolean): void {
        this.generation += 1;
        this.stopHeartbeat();
        this.stopAce();
        this.failAllPending(new Error(`连接关闭: ${reason}`));
        const socket = this.socket;
        this.socket = null;
        this.socketReady = false;
        if (socket) {
            try { (socket as any).terminate(); } catch {}
        }
        if (notifyWorker) this.sendToWorker({ t: 'close', code: 0, reason });
    }

    /** 入站：宿主只解信封，不碰业务 proto。 */
    onGatewayMessage(buffer: Buffer): void {
        this.lastInboundAt = Date.now();
        const msg: any = types.GateMessage.decode(buffer);
        const meta = msg.meta;
        if (!meta) return;
        const serverSeq = toNum(meta.server_seq);
        if (serverSeq > this.serverSeq) this.serverSeq = serverSeq;

        const clientSeq = toNum(meta.client_seq);
        const messageType = toNum(meta.message_type);
        if (String(process.env.FARM_HOST_DEBUG || '') === '1') {
            this.log(`入站 type=${messageType} ${String(meta.service_name || '')}.${String(meta.method_name || '')} client=${clientSeq} server=${serverSeq} body=${Buffer.isBuffer(msg.body) ? msg.body.length : 0}`);
        }

        // 宿主自己发起的心跳 / ACE 回包：就地消费，不下发 worker。
        if (messageType === 2 && this.pending.has(clientSeq)) {
            const pending = this.pending.get(clientSeq);
            this.pending.delete(clientSeq);
            clearTimeout(pending.timer);
            const errorCode = toNum(meta.error_code);
            if (errorCode !== 0) pending.reject(new Error(`${meta.service_name}.${meta.method_name} code=${errorCode} ${meta.error_message || ''}`));
            else pending.resolve({ body: msg.body, meta });
            return;
        }

        // Notify：body 是 EventMessage 字节，业务解码在 worker（事件类型随业务演进）。
        if (messageType === 3) {
            const service = String(meta.service_name || '');
            const method = String(meta.method_name || '');
            const body = Buffer.isBuffer(msg.body) ? msg.body : Buffer.alloc(0);
            // 热重启窗口内没有 worker：先缓存，attach 后补发，别把事件直接丢掉。
            if (!this.worker || this.worker.destroyed) {
                this.bufferNotify(service, method, body);
                return;
            }
            this.sendToWorker({ t: 'notify', service, method }, body);
            return;
        }

        // Response：把信封里的路由信息与明文 body 一起给 worker。
        // 网关回的是线程序号，这里换回 worker 自己的请求号，业务层回调才能配对。
        const workerSeq = this.seqMap.get(clientSeq);
        if (workerSeq === undefined) {
            // 迟到的回包（业务层已超时 / worker 已重启）：直接丢弃，不能串到新请求上。
            return;
        }
        this.seqMap.delete(clientSeq);
        this.sendToWorker({
            t: 'msg',
            seq: workerSeq,
            errorCode: toNum(meta.error_code),
            errorMessage: String(meta.error_message || ''),
            service: String(meta.service_name || ''),
            method: String(meta.method_name || ''),
            serverSeq,
        }, Buffer.isBuffer(msg.body) ? msg.body : Buffer.alloc(0));
    }

    // ==================== 推送缓存（worker 热重启窗口） ====================

    /** 缓存一条推送：超时 / 超量都按「先进先出」丢弃，并记账给 worker 一个缺口提示。 */
    bufferNotify(service: string, method: string, body: Buffer): void {
        const now = Date.now();
        this.pruneNotifyBuffer(now);
        this.notifyBuffer.push({ service, method, body, at: now });
        this.notifyBufferBytes += body.length;
        while (this.notifyBuffer.length > MAX_BUFFERED_NOTIFIES || this.notifyBufferBytes > MAX_BUFFERED_NOTIFY_BYTES) {
            const dropped = this.notifyBuffer.shift();
            if (!dropped) break;
            this.notifyBufferBytes -= dropped.body.length;
            this.droppedNotifies += 1;
        }
    }

    pruneNotifyBuffer(now: number = Date.now()): void {
        while (this.notifyBuffer.length) {
            const head = this.notifyBuffer[0];
            if (now - head.at <= BUFFERED_NOTIFY_TTL_MS) break;
            this.notifyBuffer.shift();
            this.notifyBufferBytes -= head.body.length;
            this.droppedNotifies += 1;
        }
    }

    /** worker 重新 attach 后补发缓存事件；有丢弃时先发一条缺口提示，让业务层做一次全量巡查。 */
    replayBufferedNotifies(): void {
        if (!this.worker || this.worker.destroyed) return;
        const now = Date.now();
        this.pruneNotifyBuffer(now);
        const pending = this.notifyBuffer;
        this.notifyBuffer = [];
        this.notifyBufferBytes = 0;
        for (const entry of pending) {
            this.sendToWorker({
                t: 'notify',
                service: entry.service,
                method: entry.method,
                replay: true,
                ageMs: Math.max(0, now - entry.at),
            }, entry.body);
        }
        if (this.droppedNotifies > 0) {
            this.sendToWorker({ t: 'notify-gap', dropped: this.droppedNotifies });
            this.droppedNotifies = 0;
        }
        if (pending.length > 0) this.log(`已补发 ${pending.length} 条 worker 离线期间的推送事件`);
    }

    // ==================== 出站 ====================
    /** worker 的请求：加密 + token + 信封后发出，回包由 onGatewayMessage 转回 worker。 */
    async forwardRpc(seq: number, service: string, method: string, body?: Buffer): Promise<void> {
        // 业务层自己发的心跳：记一笔，宿主心跳据此让路（避免两条心跳流交叉序号）。
        if (method === 'Heartbeat' && service.endsWith('UserService')) {
            this.lastWorkerHeartbeatAt = Date.now();
        }
        if (!this.socketReady || !this.socket) {
            this.sendToWorker({ t: 'send-err', seq, message: '连接未打开' });
            return;
        }
        const wireSeq = this.allocSeq();
        this.seqMap.set(wireSeq, seq);
        this.trimSeqMap();
        try {
            await this.dispatch(wireSeq, service, method, body);
        } catch (error: any) {
            this.seqMap.delete(wireSeq);
            this.sendToWorker({ t: 'send-err', seq, message: String(error?.message || error) });
        }
    }

    /** 全连接唯一序号源：worker 请求与宿主自己的心跳 / ACE 共用，保证 client_seq 连续。 */
    allocSeq(): number {
        this.hostSeq += 1;
        return this.hostSeq;
    }

    /** 业务层超时的请求不会有人来取回包，映射表按上限裁掉最旧的，避免常驻增长。 */
    trimSeqMap(): void {
        if (this.seqMap.size <= 4096) return;
        const excess = this.seqMap.size - 4096;
        let removed = 0;
        for (const key of this.seqMap.keys()) {
            this.seqMap.delete(key);
            removed += 1;
            if (removed >= excess) break;
        }
    }

    /** 宿主自己发起的请求（心跳 / ACE）：与业务请求共用序号源，就地等回包。 */
    request(service: string, method: string, body?: Buffer, timeoutMs: number = HEARTBEAT_REQUEST_TIMEOUT): Promise<any> {
        const seq = this.allocSeq();
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(seq);
                reject(new Error(`请求超时：${method}（宿主未收到回包）`));
            }, Math.max(1000, Number(timeoutMs) || HEARTBEAT_REQUEST_TIMEOUT));
            this.pending.set(seq, { resolve, reject, timer });
            this.dispatch(seq, service, method, body).catch((error: any) => {
                this.pending.delete(seq);
                clearTimeout(timer);
                reject(error);
            });
        });
    }

    async dispatch(seq: number, service: string, method: string, body?: Buffer): Promise<void> {
        if (!this.socketReady || !this.socket) throw new Error('连接未打开');
        const plain = body && body.length ? body : Buffer.alloc(0);
        const encrypted = plain.length ? await cryptoWasm.encryptBuffer(plain) : plain;
        const message = types.GateMessage.create({
            meta: {
                service_name: service,
                method_name: method,
                message_type: 1,
                client_seq: toLong(seq),
                server_seq: toLong(this.serverSeq),
            },
            body: encrypted,
            token: this.tokens.next(),
        });
        const encoded = types.GateMessage.encode(message).finish();
        this.socket.send(encoded);
    }

    failAllPending(error: Error): void {
        for (const [, entry] of this.pending) {
            clearTimeout(entry.timer);
            try { entry.reject(error); } catch {}
        }
        this.pending.clear();
        this.seqMap.clear();
    }

    // ==================== 会话（登录成功后由 worker 同步） ====================

    async applySession(meta: any): Promise<void> {
        const gid = toNum(meta.gid);
        const openId = String(meta.openId || '');
        const clientVersion = String(meta.clientVersion || '');
        const heartbeatInterval = Number(meta.heartbeatInterval) > 0 ? Number(meta.heartbeatInterval) : DEFAULT_HEARTBEAT_INTERVAL;
        if (meta.state && typeof meta.state === 'object') this.sessionState = meta.state;
        const previous = this.session;
        this.session = { gid, openId, clientVersion, heartbeatInterval };

        // 幂等：同一个会话重复下发（worker 重试 / 登录流程重入）不重启心跳，
        // 否则每次都会清掉在途心跳并多起一个定时器。
        const sameSession = !!previous && previous.gid === gid && previous.openId === openId
            && this.heartbeatTimer;
        if (sameSession) {
            this.log(`会话重复下发（gid=${gid}），保持现有心跳与 ACE`);
            this.sendToWorker({ t: 'session-ok', reused: true });
            return;
        }

        this.log(`已接管会话：gid=${gid} ver=${clientVersion} 心跳=${heartbeatInterval}ms`);

        // TSDK 与连接会话绑定：bindUser 之后才能加密上行、上报 AntiData。
        try {
            if (openId) {
                await cryptoWasm.bindUser(openId);
                const staged = this.tokens.stageInitToken(cryptoWasm.getEncryptedInitInfo());
                if (staged > 0) this.log(`TSDK 初始化凭据已就绪: ${staged} 字符，将随下一条请求发送`);
            }
        } catch (error: any) {
            this.warn(`TSDK 初始化失败: ${error?.message || error}`);
        }

        this.startHeartbeat();
        this.startAce();
        this.sendToWorker({ t: 'session-ok' });
    }

    // ==================== 心跳 ====================

    startHeartbeat(): void {
        this.stopHeartbeat();
        const interval = this.session?.heartbeatInterval || DEFAULT_HEARTBEAT_INTERVAL;
        this.lastHeartbeatAt = Date.now();
        this.heartbeatTimer = setInterval(() => { void this.beat(false); }, interval);
        this.log(`心跳已启动（间隔 ${interval}ms，worker 在线时由业务层发）`);
    }

    stopHeartbeat(): void {
        if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
        if (this.retryTimer) clearTimeout(this.retryTimer);
        this.heartbeatTimer = null;
        this.retryTimer = null;
        this.beatInFlight = false;
    }

    async beat(isRetry: boolean): Promise<void> {
        if (this.beatInFlight || !this.socketReady || !this.session?.gid) return;
        // worker 在线时心跳由业务层发（序号连续、失败计数也在业务层）：
        // 这里只要看到它还在发，就不插一条宿主心跳去抢序号。
        if (this.worker) {
            const interval = this.session?.heartbeatInterval || DEFAULT_HEARTBEAT_INTERVAL;
            // worker 在线时让路：它自己按 25s 节奏发心跳，宿主只在它彻底不出声时才补位。
            const lastAlive = Math.max(this.lastWorkerHeartbeatAt, this.lastWorkerAttachAt);
            if (Date.now() - lastAlive < interval * 2.5) return;
        }
        this.beatInFlight = true;
        this.heartbeat.attempts += 1;
        try {
            const body = Buffer.from(types.HeartbeatRequest.encode(types.HeartbeatRequest.create({
                gid: toLong(this.session.gid),
                client_version: this.session.clientVersion,
                field_3: toLong(0),
            })).finish());
            const { body: replyBody } = await this.request('gamepb.userpb.UserService', 'Heartbeat', body, HEARTBEAT_REQUEST_TIMEOUT);
            this.heartbeat.replies += 1;
            this.heartbeat.misses = 0;
            this.lastHeartbeatAt = Date.now();
            if (this.retryTimer) {
                clearTimeout(this.retryTimer);
                this.retryTimer = null;
            }
            // 心跳回包带回服务器时间：告诉 worker，让它校正业务时间轴。
            try {
                const reply = types.HeartbeatReply.decode(replyBody);
                const serverTime = toNum(reply.server_time);
                if (serverTime > 0) this.sendToWorker({ t: 'server-time', serverTime });
            } catch {}
        } catch (error: any) {
            this.heartbeat.failures += 1;
            this.heartbeat.misses += 1;
            // 发送阶段就失败（加密未就绪 / 连接被替换）和「发出去了但没回包」必须能分辨，
            // 否则日志里只剩「心跳未响应」，排查时看不出是本地加密挂了还是网关不回。
            const sendError = String(error?.message || error || '');
            if (this.heartbeat.failures === 1 || this.heartbeat.failures % 10 === 0) {
                this.warn(`心跳请求失败: ${sendError}`);
            }
            if (this.heartbeat.misses === 1 && !isRetry) {
                this.warn(`心跳未响应，${Math.round(HEARTBEAT_RETRY_DELAY / 1000)} 秒后补发一次`);
                this.retryTimer = setTimeout(() => { void this.beat(true); }, HEARTBEAT_RETRY_DELAY);
                return;
            }
            const inboundSilenceMs = Date.now() - this.lastInboundAt;
            const heartbeatSilenceMs = Date.now() - this.lastHeartbeatAt;
            this.warn(`心跳未响应（漏拍 ${this.heartbeat.misses}/${MAX_HEARTBEAT_MISSES}，距上次心跳 ${Math.round(heartbeatSilenceMs / 1000)} 秒，连接无入站数据 ${Math.round(inboundSilenceMs / 1000)} 秒）`);
            if (!shouldTerminateForHeartbeat(this.heartbeat.misses, inboundSilenceMs)
                && !shouldTerminateForSilence(this.heartbeat.misses, inboundSilenceMs)) return;
            this.warn('连续心跳超时且连接无入站数据，判定连接已死');
            this.sendToWorker({
                t: 'dead',
                reason: `${Math.round(inboundSilenceMs / 1000)} 秒无入站数据，连续 ${this.heartbeat.misses} 次心跳失败`,
            });
            this.closeGateway('心跳判死', false);
        } finally {
            this.beatInFlight = false;
        }
    }

    // ==================== ACE ====================

    startAce(): void {
        if (this.aceStarted) return;
        try {
            startAceRuntime((service: string, method: string, body: Buffer, timeoutMs?: number) => (
                this.request(service, method, body, timeoutMs || 10000)
            ));
            this.aceStarted = true;
            this.log('ACE 运行时已启动（宿主内）');
        } catch (error: any) {
            this.warn(`ACE 启动失败: ${error?.message || error}`);
        }
    }

    stopAce(): void {
        if (!this.aceStarted) return;
        this.aceStarted = false;
        try { stopAceRuntime(false); } catch {}
    }

    // ==================== 生命周期 ====================

    /**
     * 空闲看门狗：主进程崩溃 / 被 kill 后宿主会变成孤儿，连接还在但没人消费业务事件。
     * 超过 HOST_ORPHAN_IDLE_MS 没有 worker attach 就自行退出，避免长期占着游戏会话。
     */
    startWatchdog(): void {
        if (this.watchdogTimer) clearInterval(this.watchdogTimer);
        this.watchdogTimer = setInterval(() => this.checkIdle(), WATCHDOG_INTERVAL);
        this.watchdogTimer.unref?.();
    }

    checkIdle(): void {
        if (this.closed) return;
        if (this.worker) {
            this.lastWorkerAttachAt = Date.now();
            return;
        }
        const idleMs = Date.now() - this.lastWorkerAttachAt;
        // 没有连接也没有 worker：给 2 分钟启动窗口（主进程可能正忙），过了就回收。
        if (!this.socketReady) {
            if (idleMs > Math.min(HOST_ORPHAN_IDLE_MS, HOST_NO_CONNECTION_GRACE_MS)) {
                this.shutdown('无业务 worker 且网关未连接');
            }
            return;
        }
        if (idleMs > HOST_ORPHAN_IDLE_MS) {
            this.shutdown(`${Math.round(HOST_ORPHAN_IDLE_MS / 60000)} 分钟没有业务 worker 接管`);
        }
    }

    shutdown(reason: string): void {
        if (this.closed) return;
        this.closed = true;
        this.closeGateway(reason, false);
        this.stopAce();
        if (this.watchdogTimer) {
            clearInterval(this.watchdogTimer);
            this.watchdogTimer = null;
        }
        if (this.worker) {
            try { this.worker.destroy(); } catch {}
            this.worker = null;
        }
        if (this.server) {
            try { this.server.close(); } catch {}
            this.server = null;
        }
        removeHostEntry(this.accountId, process.pid);
        this.log(`连接宿主退出: ${reason}`);
    }

    getDiagnostics(): any {
        return {
            accountId: this.accountId,
            connected: this.socketReady,
            session: this.session,
            sessionState: this.sessionState,
            heartbeat: { ...this.heartbeat },
            inboundSilenceMs: Date.now() - this.lastInboundAt,
            pendingHostRequests: this.pending.size,
            workerAttached: !!this.worker,
            bufferedNotifies: this.notifyBuffer.length,
            droppedNotifies: this.droppedNotifies,
            aceStarted: this.aceStarted,
        };
    }
}

/** 生成宿主与 worker 之间的共享密钥 / 管道名：见 ./naming（主进程也用它）。 */
const { createHostToken, hostPipeName } = require('./naming');

module.exports = { HostServer, createHostToken, hostPipeName };
