// 连接宿主的热重启语义：推送缓存补发、会话快照回填、重复建连不拆链路。
const assert = require('node:assert/strict');
const test = require('node:test');

const { HostServer } = require('../dist/host/host-server');
const { types, loadProto } = require('../dist/utils/proto');
const { createFrameDecoder } = require('../dist/host/frame');

// proto 是懒加载的：宿主真正跑起来之前会先 loadProto()，测试里也要显式加载。
require('node:test').before(async () => { await loadProto(); });

function fakeWorker() {
    const frames = [];
    const decoder = createFrameDecoder(frame => frames.push(frame));
    return {
        destroyed: false,
        frames,
        write(buffer) { decoder(buffer); },
        destroy() { this.destroyed = true; },
    };
}

function notifyFrame(service, method, body) {
    return types.GateMessage.encode(types.GateMessage.create({
        meta: { service_name: service, method_name: method, message_type: 3 },
        body,
    })).finish();
}

function makeServer() {
    return new HostServer({ accountId: 'acc-test', pipeName: 'pipe-test', token: 'tok', logger: { log() {}, warn() {} } });
}

test('worker 不在时推送进缓存，attach 后按序补发并标记 replay', () => {
    const server = makeServer();
    const first = Buffer.from([1, 2, 3]);
    const second = Buffer.from([4, 5]);
    server.onGatewayMessage(notifyFrame('gamepb.farmpb.FarmService', 'FarmNotify', first));
    server.onGatewayMessage(notifyFrame('gamepb.userpb.UserService', 'ItemNotify', second));
    assert.equal(server.notifyBuffer.length, 2, '没有 worker 时必须缓存而不是丢弃');

    server.worker = fakeWorker();
    server.onWorkerFrame({ meta: { t: 'hello', token: 'tok' } });

    const kinds = server.worker.frames.map(frame => frame.meta.t);
    assert.deepEqual(kinds, ['hello-ok', 'notify', 'notify']);
    const replayed = server.worker.frames.slice(1);
    assert.equal(replayed[0].meta.replay, true);
    assert.equal(replayed[0].meta.service, 'gamepb.farmpb.FarmService');
    assert.deepEqual(replayed[0].body, first);
    assert.deepEqual(replayed[1].body, second);
    assert.equal(server.notifyBuffer.length, 0, '补发后清空缓存');
});

test('缓存超量时丢最旧的，并给 worker 一个缺口提示', () => {
    const server = makeServer();
    for (let i = 0; i < 700; i += 1) {
        server.onGatewayMessage(notifyFrame('svc', 'Notify', Buffer.alloc(8, i & 0xFF)));
    }
    assert.ok(server.notifyBuffer.length <= 512, '缓存条数必须有上限');
    assert.ok(server.droppedNotifies > 0, '丢弃必须记账');

    server.worker = fakeWorker();
    server.onWorkerFrame({ meta: { t: 'hello', token: 'tok' } });
    const gap = server.worker.frames.find(frame => frame.meta.t === 'notify-gap');
    assert.ok(gap, '必须下发缺口提示');
    assert.ok(gap.meta.dropped > 0);
    assert.equal(server.droppedNotifies, 0, '提示过后清零');
});

test('hello-ok 带回会话与快照：热重启的 worker 不用重新登录', () => {
    const server = makeServer();
    server.session = { gid: 123, openId: 'open-1', clientVersion: '1.17.0.4_20261117', heartbeatInterval: 25000 };
    server.sessionState = { name: '神拽°', level: 88, unlockedSceneIds: [1, 2] };
    server.socketReady = true;
    server.worker = fakeWorker();
    server.onWorkerFrame({ meta: { t: 'hello', token: 'tok' } });

    const hello = server.worker.frames[0];
    assert.equal(hello.meta.t, 'hello-ok');
    assert.equal(hello.meta.connected, true);
    assert.equal(hello.meta.session.gid, 123);
    assert.equal(hello.meta.session.state.name, '神拽°');
    assert.equal(hello.meta.session.state.level, 88);
    assert.deepEqual(hello.meta.session.state.unlockedSceneIds, [1, 2]);
});

test('session-state 指令只更新快照，不影响会话与心跳', () => {
    const server = makeServer();
    server.session = { gid: 1, openId: 'o', clientVersion: 'v', heartbeatInterval: 25000 };
    server.worker = fakeWorker();
    server.onWorkerFrame({ meta: { t: 'session-state', state: { level: 30 } } });
    assert.equal(server.sessionState.level, 30);
    assert.equal(server.session.gid, 1);
});

test('重复下发同一条 connect 不会拆掉已有连接', async () => {
    const server = makeServer();
    const url = 'wss://gate.example/ws?ver=1';
    const headers = { Origin: 'https://gate-obt.nqf.qq.com' };
    server.socketReady = true;
    server.gatewayTarget = `${url}::${JSON.stringify(headers)}`;
    server.session = { gid: 7, openId: 'o', clientVersion: 'v', heartbeatInterval: 25000 };
    server.worker = fakeWorker();

    await server.connectGateway(url, headers);

    const kinds = server.worker.frames.map(frame => frame.meta.t);
    assert.deepEqual(kinds, ['open', 'session-ok']);
    assert.equal(server.generation, 0, '复用路径不应触发重连代数变化');
});

test('worker 鉴权失败直接断开，不下发 hello-ok', () => {
    const server = makeServer();
    const worker = fakeWorker();
    server.worker = worker;
    server.onWorkerFrame({ meta: { t: 'hello', token: 'wrong' } });
    assert.equal(worker.frames.length, 0);
    assert.equal(worker.destroyed, true);
});

test('看门狗：刚起来没连上网关时给启动窗口，超时才回收；有连接时按闲置上限回收', () => {
    const fresh = makeServer();
    fresh.checkIdle();
    assert.equal(fresh.closed, false, '刚起来的宿主不能被立刻回收');

    const stale = makeServer();
    stale.lastWorkerAttachAt = Date.now() - 3 * 60 * 1000;
    stale.socketReady = false;
    stale.checkIdle();
    assert.equal(stale.closed, true, '超过启动宽限且没有连接/worker 必须退出');

    const connected = makeServer();
    connected.socketReady = true;
    connected.lastWorkerAttachAt = Date.now() - 60 * 1000;
    connected.checkIdle();
    assert.equal(connected.closed, false, '连接还在时要等满闲置上限');

    const orphan = makeServer();
    orphan.socketReady = true;
    orphan.lastWorkerAttachAt = Date.now() - 20 * 60 * 1000;
    orphan.checkIdle();
    assert.equal(orphan.closed, true, '长时间没人接管必须退出，避免占着游戏会话');
});

test('宿主模式建连必须先判断可复用会话、再要求 Code，并在 open 后由 worker 发登录', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'utils', 'network.ts'), 'utf8');
    const start = source.indexOf('async function connectViaHost');
    assert.ok(start > 0, 'connectViaHost 必须存在');
    const rest = source.slice(start);
    const end = rest.indexOf('function connect(code');
    const body = rest.slice(0, end > 0 ? end : rest.length);

    const attachAt = body.indexOf('attachHostClient');
    const codeAt = body.indexOf('if (!authCode)');
    assert.ok(attachAt > 0 && codeAt > 0, '复用判断与 Code 校验都必须存在');
    assert.ok(attachAt < codeAt, '先 attach 判断宿主是否已有存活会话，再决定要不要 Code');

    assert.ok(body.includes("adapter.on('open'"), '网关打开事件必须绑定到登录流程');
    assert.ok(body.includes('sendLogin(context'), 'open 之后必须由业务层发 PlayerLogin');
});
