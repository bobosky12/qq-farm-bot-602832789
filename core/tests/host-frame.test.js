// 连接宿主与 worker 之间的管道帧：分片、粘包、超限都必须正确。
const assert = require('node:assert/strict');
const test = require('node:test');

const { encodeFrame, createFrameDecoder, MAX_FRAME_BYTES } = require('../dist/host/frame');

test('单帧编解码：元数据与二进制 body 都能还原', () => {
    const body = Buffer.from([0x01, 0x02, 0x03, 0xff]);
    const frameBytes = encodeFrame({ t: 'req', seq: 7, service: 'gamepb.userpb.UserService' }, body);
    const received = [];
    const decode = createFrameDecoder(frame => received.push(frame));
    decode(frameBytes);
    assert.equal(received.length, 1);
    assert.equal(received[0].meta.t, 'req');
    assert.equal(received[0].meta.seq, 7);
    assert.equal(received[0].meta.service, 'gamepb.userpb.UserService');
    assert.equal(received[0].meta.bodyLength, undefined, 'bodyLength 是传输细节，不应泄漏给业务层');
    assert.deepEqual(received[0].body, body);
});

test('无 body 的帧 body 为 undefined，且能连续解码多帧（粘包）', () => {
    const a = encodeFrame({ t: 'hello', token: 'x' });
    const b = encodeFrame({ t: 'close' });
    const received = [];
    const decode = createFrameDecoder(frame => received.push(frame));
    decode(Buffer.concat([a, b]));
    assert.equal(received.length, 2);
    assert.equal(received[0].meta.t, 'hello');
    assert.equal(received[0].body, undefined);
    assert.equal(received[1].meta.t, 'close');
});

test('按字节逐段投递（TCP 分片）仍能正确切帧', () => {
    const body = Buffer.alloc(64, 0xab);
    const frameBytes = encodeFrame({ t: 'msg', seq: 42 }, body);
    const received = [];
    const decode = createFrameDecoder(frame => received.push(frame));
    for (const byte of frameBytes) decode(Buffer.from([byte]));
    assert.equal(received.length, 1);
    assert.equal(received[0].meta.seq, 42);
    assert.equal(received[0].body.length, 64);
});

test('元数据长度异常时抛错（避免损坏数据把内存吃满）', () => {
    const head = Buffer.alloc(4);
    head.writeUInt32BE(MAX_FRAME_BYTES + 1, 0);
    const decode = createFrameDecoder(() => {});
    assert.throws(() => decode(head), /元数据长度异常/);
});

test('元数据不是合法 JSON 时抛错', () => {
    const payload = Buffer.from('not-json', 'utf8');
    const head = Buffer.alloc(4);
    head.writeUInt32BE(payload.length, 0);
    const decode = createFrameDecoder(() => {});
    assert.throws(() => decode(Buffer.concat([head, payload])), /不是合法 JSON/);
});
