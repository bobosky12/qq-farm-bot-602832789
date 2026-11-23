export {};

/**
 * 业务 worker 侧的宿主客户端：把「发往网关的请求」转发给连接宿主进程。
 *
 * 为什么需要它：socket / 心跳 / 上行加密 / ACE 都在宿主里，worker 重启时连接不断；
 * 业务层（proto、调度、配置、数据）随时热更新，只需要重新 attach 到同一个宿主。
 *
 * 通道：本地管道（Windows named pipe / Unix socket），帧格式见 ./frame。
 */

const net = require('node:net');
const { encodeFrame, createFrameDecoder } = require('./frame');

const RECONNECT_DELAY = 1000;
const MAX_RECONNECT_ATTEMPTS = 10;

class HostClient {
    pipeName: string;
    token: string;
    socket: any = null;
    decoder: any = null;
    connected: boolean = false;
    closing: boolean = false;
    handlers: Array<(frame: { meta: any; body?: Buffer }) => void> = [];
    /** 连接宿主的等待（握手 + attach）完成后才允许业务层发请求。 */
    readyPromise: Promise<any> | null = null;
    readyResolve: ((value: any) => void) | null = null;
    readyReject: ((error: Error) => void) | null = null;
    helloInfo: any = null;
    logger: any;

    constructor(options: { pipeName: string; token: string; logger?: any }) {
        this.pipeName = options.pipeName;
        this.token = options.token;
        this.logger = options.logger || console;
    }

    onFrame(handler: (frame: { meta: any; body?: Buffer }) => void): void {
        this.handlers.push(handler);
    }

    emit(frame: { meta: any; body?: Buffer }): void {
        for (const handler of this.handlers) {
            try {
                handler(frame);
            } catch (error: any) {
                this.logger.warn?.(`[host-client] 处理宿主消息失败: ${error?.message || error}`);
            }
        }
    }

    /** 连接宿主并完成 hello 握手；返回宿主回报的会话摘要（可直接复用已登录会话）。 */
    attach(): Promise<any> {
        if (this.readyPromise) return this.readyPromise;
        this.readyPromise = new Promise((resolve, reject) => {
            this.readyResolve = resolve;
            this.readyReject = reject;
        });
        this.openSocket(0);
        return this.readyPromise;
    }

    openSocket(attempt: number): void {
        if (this.closing) return;
        const socket = net.createConnection(this.pipeName);
        this.socket = socket;
        this.decoder = createFrameDecoder(frame => this.onFrameFromHost(frame));

        socket.on('connect', () => {
            this.connected = true;
            this.send({ t: 'hello', token: this.token });
        });
        socket.on('data', (chunk: Buffer) => {
            try {
                this.decoder(chunk);
            } catch (error: any) {
                this.logger.warn?.(`[host-client] 帧解码失败: ${error?.message || error}`);
                try { socket.destroy(); } catch {}
            }
        });
        socket.on('error', (error: any) => {
            this.logger.warn?.(`[host-client] 管道错误: ${error?.message || error}`);
        });
        socket.on('close', () => {
            this.connected = false;
            if (this.closing) return;
            if (attempt < MAX_RECONNECT_ATTEMPTS) {
                setTimeout(() => this.openSocket(attempt + 1), RECONNECT_DELAY);
            } else {
                this.failReady(new Error('连接宿主不可用（重试次数已用尽）'));
            }
        });
    }

    onFrameFromHost(frame: { meta: any; body?: Buffer }): void {
        const meta = frame.meta || {};
        if (meta.t === 'hello-ok') {
            this.helloInfo = meta;
            this.readyResolve?.({ connected: !!meta.connected, session: meta.session || null });
            return;
        }
        this.emit(frame);
    }

    send(meta: Record<string, any>, body?: Buffer): void {
        if (!this.socket || this.socket.destroyed) throw new Error('连接宿主不可用');
        this.socket.write(encodeFrame(meta, body));
    }

    /** 让宿主按 worker 给的握手参数建连（握手参数仍由业务层决定，宿主不解析）。 */
    connectGateway(url: string, headers: Record<string, any>): void {
        this.send({ t: 'connect', url, headers });
    }

    /** 转发一条业务请求：body 是**明文** protobuf，加密与信封由宿主完成。 */
    sendRpc(seq: number, service: string, method: string, body?: Buffer): void {
        this.send({ t: 'req', seq, service, method }, body);
    }

    /** 登录成功后把会话参数交给宿主，由它启动心跳与 ACE。 */
    sendSession(session: { gid: number; openId: string; clientVersion: string; heartbeatInterval?: number }): void {
        this.send({ t: 'session', ...session });
    }

    /** 请求宿主关闭网关连接（用户主动停号 / 重新登录时用）。 */
    requestGatewayClose(): void {
        try { this.send({ t: 'close' }); } catch {}
    }

    /**
     * 只断开与宿主的管道，**不关闭网关连接**。
     * worker 热重启（崩溃、代码更新）走这条路径：宿主继续持有 socket 与心跳，
     * 新 worker attach 后可以直接复用会话。
     */
    detach(): void {
        this.closing = true;
        try { this.socket?.destroy(); } catch {}
        this.socket = null;
        this.connected = false;
    }

    close(): void {
        this.closing = true;
        try { this.socket?.destroy(); } catch {}
        this.socket = null;
        this.connected = false;
    }

    failReady(error: Error): void {
        this.readyReject?.(error);
        this.readyResolve = null;
        this.readyReject = null;
    }
}

module.exports = { HostClient };
