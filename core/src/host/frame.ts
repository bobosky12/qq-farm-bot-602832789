export {};

/**
 * 连接宿主（host）与业务 worker 之间的本地管道帧格式。
 *
 * 设计目标：worker 重启时宿主能继续持有游戏连接，所以两者之间只传「稳定结构」：
 *   - 出站：业务层的 service/method + **未加密**的 protobuf body（由宿主加密、加 token、编信封）
 *   - 入站：宿主解出的 service/method + 明文 body（下行不加密），或 notify 的原始 EventMessage 字节
 *
 * 帧：`[4B 总长(不含头)][JSON 元数据][body 原始字节]`
 * JSON 里带 bodyLength 描述尾部二进制段长度，避免 base64 的 33% 膨胀。
 *
 * 约束：宿主**不认识**任何 gamepb.* 业务消息，业务协议升级不需要重启宿主。
 */

/** 单帧上限：活动回包、图鉴列表可能较大，但 16MB 足够且能挡住异常数据。 */
const MAX_FRAME_BYTES = 16 * 1024 * 1024;

interface FramePayload {
    meta: Record<string, any>;
    body?: Buffer;
}

function encodeFrame(meta: Record<string, any>, body?: Buffer): Buffer {
    const bodyBuffer = Buffer.isBuffer(body) ? body : Buffer.alloc(0);
    const metaWithLength = { ...meta, bodyLength: bodyBuffer.length };
    const metaBytes = Buffer.from(JSON.stringify(metaWithLength), 'utf8');
    const total = 4 + metaBytes.length + bodyBuffer.length;
    if (total > MAX_FRAME_BYTES) throw new Error(`管道帧过大: ${total} 字节`);
    const head = Buffer.alloc(4);
    head.writeUInt32BE(metaBytes.length, 0);
    return Buffer.concat([head, metaBytes, bodyBuffer]);
}

/**
 * 增量解码器：TCP/管道不保证一次 read 就是一帧，这里按累积缓冲切帧。
 * 单帧超限直接抛错，由调用方断开连接（避免恶意/损坏数据把内存吃满）。
 */
function createFrameDecoder(onFrame: (frame: FramePayload) => void): (chunk: Buffer) => void {
    let buffer: any = Buffer.alloc(0);
    return (chunk: Buffer): void => {
        if (!chunk || !chunk.length) return;
        buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
        for (;;) {
            if (buffer.length < 4) return;
            const metaLength = buffer.readUInt32BE(0);
            if (metaLength <= 0 || metaLength > MAX_FRAME_BYTES) throw new Error(`管道帧元数据长度异常: ${metaLength}`);
            if (buffer.length < 4 + metaLength) return;
            const metaBytes = buffer.subarray(4, 4 + metaLength);
            let meta: any;
            try {
                meta = JSON.parse(metaBytes.toString('utf8'));
            } catch {
                throw new Error('管道帧元数据不是合法 JSON');
            }
            const bodyLength = Number(meta?.bodyLength) || 0;
            if (bodyLength < 0 || bodyLength > MAX_FRAME_BYTES) throw new Error(`管道帧 body 长度异常: ${bodyLength}`);
            const frameEnd = 4 + metaLength + bodyLength;
            if (buffer.length < frameEnd) return;
            const body = bodyLength ? Buffer.from(buffer.subarray(4 + metaLength, frameEnd)) : undefined;
            buffer = buffer.subarray(frameEnd);
            delete meta.bodyLength;
            onFrame({ meta, body });
        }
    };
}

module.exports = { encodeFrame, createFrameDecoder, MAX_FRAME_BYTES };
