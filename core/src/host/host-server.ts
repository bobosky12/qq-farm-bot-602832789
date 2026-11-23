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

const { types } = require('../utils/proto');
const cryptoWasm = require('../utils/crypto-wasm');
const { GatewayTokenProvider } = require('../utils/gateway-token');
const { MAX_HEARTBEAT_MISSES, shouldTerminateForHeartbeat, shouldTerminateForSilence } = require('../utils/keepalive-policy');
const { startAceRuntime, stopAceRuntime } = require('../services/ace');
const { encodeFrame, createFrameDecoder } = require('./frame');

/** 宿主自己的 seq 段：从 100 万起，和 worker 的 1,2,3… 不冲突。 */
const HOST_SEQ_BASE = 1_000_000;
const HEARTBEAT_REQUEST_TIMEOUT = 8000;
const HEARTBEAT_RETRY_DELAY = 3000;
const DEFAULT_HEARTBEAT_INTERVAL = 25000;
const CONNECT_TIMEOUT = 20000;

function toNum(value: any): number {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
}

function toLong(value: number): any {
    // proto 的 int64 接受 number/string/BigInt；这里统一用 BigInt 避免精度问题。
    return BigInt(Math.trunc(Number(value) || 0));
}

class HostServer {
    accountId: string;
    pipeName: string;
    token: string;
    server: any = null;
    worker: any = null;
    decoder: any = null;
    socket: any = null;
    socketReady: boolean = false;
    hostSeq: number = HOST_SEQ_BASE;
    serverSeq: number = 0;
    tokens: any = new GatewayTokenProvider();
    /** 宿主自己发起的请求（心跳 / ACE）的回包等待表。 */
    pending: Map<number, any> = new Map();
    heartbeat: { attempts: number; replies: number; failures: number; misses: number } = { attempts: 0, replies: 0, failures: 0, misses: 0 };
    heartbeatTimer: any = null;
    retryTimer: any = null;
    beatInFlight: boolean = false;
    session: { gid: number; openId: string; clientVersion: string; heartbeatInterval: number } | null = null;
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
        return new Promise((resolve, reject) => {
            const server = net.createServer(socket => this.onWorkerConnection(socket));
            server.on('error', (error: any) => {
                this.warn(`管道监听失败: ${error?.message || error}`);
                reject(error);
            });
            server.listen(this.pipeName, () => {
                this.log(`连接宿主已就绪，管道 ${this.pipeName}`);
                resolve();
            });
            this.server = server;
        });
    }

    onWorkerConnection(socket: any): void {
        // 单 worker 模型：新连接直接替换旧连接（worker 重启后重新 attach）。
        if (this.worker && this.worker !== socket) {
            try { this.worker.destroy(); } catch {}
        }
        this.worker = socket;
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
                    session: this.session ? { ...this.session } : null,
                });
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
        this.closeGateway('重新建连', false);
        this.generation += 1;
        const generation = this.generation;
        this.socketReady = false;
        this.serverSeq = 0;
        this.tokens.clear();
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

        // 宿主自己发起的心跳 / ACE 回包：就地消费，不下发 worker。
        if (messageType === 2 && clientSeq >= HOST_SEQ_BASE) {
            const pending = this.pending.get(clientSeq);
            if (pending) {
                this.pending.delete(clientSeq);
                clearTimeout(pending.timer);
                const errorCode = toNum(meta.error_code);
                if (errorCode !== 0) pending.reject(new Error(`${meta.service_name}.${meta.method_name} code=${errorCode} ${meta.error_message || ''}`));
                else pending.resolve({ body: msg.body, meta });
            }
            return;
        }

        // Notify：body 是 EventMessage 字节，业务解码在 worker（事件类型随业务演进）。
        if (messageType === 3) {
            this.sendToWorker({
                t: 'notify',
                service: String(meta.service_name || ''),
                method: String(meta.method_name || ''),
            }, Buffer.isBuffer(msg.body) ? msg.body : Buffer.alloc(0));
            return;
        }

        // Response：把信封里的路由信息与明文 body 一起给 worker。
        this.sendToWorker({
            t: 'msg',
            seq: clientSeq,
            errorCode: toNum(meta.error_code),
            errorMessage: String(meta.error_message || ''),
            service: String(meta.service_name || ''),
            method: String(meta.method_name || ''),
            serverSeq,
        }, Buffer.isBuffer(msg.body) ? msg.body : Buffer.alloc(0));
    }

    // ==================== 出站 ====================

    /** worker 的请求：加密 + token + 信封后发出，回包由 onGatewayMessage 转回 worker。 */
    async forwardRpc(seq: number, service: string, method: string, body?: Buffer): Promise<void> {
        try {
            await this.dispatch(seq, service, method, body);
        } catch (error: any) {
            this.sendToWorker({ t: 'send-err', seq, message: String(error?.message || error) });
        }
    }

    /** 宿主自己发起的请求（心跳 / ACE）：走 HOST_SEQ_BASE 段并就地等回包。 */
    request(service: string, method: string, body?: Buffer, timeoutMs: number = HEARTBEAT_REQUEST_TIMEOUT): Promise<any> {
        const seq = this.hostSeq;
        this.hostSeq += 1;
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
    }

    // ==================== 会话（登录成功后由 worker 同步） ====================

    async applySession(meta: any): Promise<void> {
        const gid = toNum(meta.gid);
        const openId = String(meta.openId || '');
        const clientVersion = String(meta.clientVersion || '');
        const heartbeatInterval = Number(meta.heartbeatInterval) > 0 ? Number(meta.heartbeatInterval) : DEFAULT_HEARTBEAT_INTERVAL;
        this.session = { gid, openId, clientVersion, heartbeatInterval };
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
        this.log(`心跳已启动（间隔 ${interval}ms）`);
        void this.beat(false);
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
        } catch {
            this.heartbeat.failures += 1;
            this.heartbeat.misses += 1;
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
        try {
            startAceRuntime((service: string, method: string, body: Buffer, timeoutMs?: number) => (
                this.request(service, method, body, timeoutMs || 10000)
            ));
            this.log('ACE 运行时已启动（宿主内）');
        } catch (error: any) {
            this.warn(`ACE 启动失败: ${error?.message || error}`);
        }
    }

    stopAce(): void {
        try { stopAceRuntime(false); } catch {}
    }

    // ==================== 生命周期 ====================

    shutdown(reason: string): void {
        if (this.closed) return;
        this.closed = true;
        this.closeGateway(reason, false);
        this.stopAce();
        if (this.worker) {
            try { this.worker.destroy(); } catch {}
            this.worker = null;
        }
        if (this.server) {
            try { this.server.close(); } catch {}
            this.server = null;
        }
        this.log(`连接宿主退出: ${reason}`);
    }

    getDiagnostics(): any {
        return {
            accountId: this.accountId,
            connected: this.socketReady,
            session: this.session,
            heartbeat: { ...this.heartbeat },
            inboundSilenceMs: Date.now() - this.lastInboundAt,
            pendingHostRequests: this.pending.size,
            workerAttached: !!this.worker,
        };
    }
}

/** 生成宿主与 worker 之间的共享密钥 / 管道名：见 ./naming（主进程也用它）。 */
const { createHostToken, hostPipeName } = require('./naming');

module.exports = { HostServer, createHostToken, hostPipeName };
