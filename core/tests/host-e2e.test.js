// 连接宿主端到端：进程真的 fork 起来，连假网关、心跳、推送缓存、重挂接管都要成立。
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fork } = require('node:child_process');
const { WebSocketServer } = require('ws');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqfarm-host-e2e-'));
process.env.FARM_HOST_REGISTRY = path.join(dir, 'host-registry.json');

const { types, loadProto } = require('../dist/utils/proto');
const { HostClient } = require('../dist/host/host-client');

const TOKEN = 'e2e-token';
const PIPE = process.platform === 'win32'
    ? `\\\\.\\pipe\\qqfarm-e2e-${process.pid}`
    : path.join(dir, 'host.sock');

let protoReady = null;
function ensureProto() {
    if (!protoReady) protoReady = loadProto();
    return protoReady;
}

function waitFor(predicate, timeoutMs = 8000, label = '条件') {
    const started = Date.now();
    return new Promise((resolve, reject) => {
        const tick = () => {
            let value;
            try { value = predicate(); } catch { value = null; }
            if (value) return resolve(value);
            if (Date.now() - started > timeoutMs) return reject(new Error(`等待${label}超时`));
            setTimeout(tick, 50);
        };
        tick();
    });
}

function startFakeGateway() {
    const received = [];
    const server = new WebSocketServer({ port: 0 });
    server.on('connection', socket => {
        socket.on('message', data => {
            const msg = types.GateMessage.decode(Buffer.isBuffer(data) ? data : Buffer.from(data));
            const meta = msg.meta || {};
            received.push({ service: String(meta.service_name || ''), method: String(meta.method_name || ''), type: Number(meta.message_type) || 0 });
            if (String(meta.method_name) === 'Heartbeat') {
                const reply = types.GateMessage.encode(types.GateMessage.create({
                    meta: {
                        service_name: meta.service_name,
                        method_name: meta.method_name,
                        message_type: 2,
                        client_seq: meta.client_seq,
                        server_seq: 1,
                        error_code: 0,
                    },
                    body: types.HeartbeatReply.encode(types.HeartbeatReply.create({ server_time: 1700000000000 })).finish(),
                })).finish();
                socket.send(reply);
            }
        });
        socket.on('error', () => {});
        server._socket = socket;
    });
    return new Promise(resolve => {
        server.on('listening', () => resolve({ server, received, port: server.address().port }));
    });
}

function startHostProcess() {
    return new Promise((resolve, reject) => {
        const entry = path.join(__dirname, '..', 'dist', 'host', 'host-entry.js');
        const child = fork(entry, [], {
            stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
            env: {
                ...process.env,
                FARM_HOST_ACCOUNT_ID: 'e2e-account',
                FARM_HOST_PIPE: PIPE,
                FARM_HOST_TOKEN: TOKEN,
            },
        });
        const timer = setTimeout(() => reject(new Error('宿主启动超时')), 8000);
        child.on('message', msg => {
            if (msg && msg.type === 'host_ready') {
                clearTimeout(timer);
                resolve(child);
            }
        });
        child.on('exit', code => { clearTimeout(timer); reject(new Error(`宿主提前退出 code=${code}`)); });
    });
}

function attachClient(onFrame) {
    return new Promise((resolve, reject) => {
        const client = new HostClient({ pipeName: PIPE, token: TOKEN, logger: { warn() {} } });
        if (onFrame) client.onFrame(onFrame);
        client.attach().then(info => resolve({ client, info })).catch(reject);
    });
}

test('宿主进程：心跳在宿主、推送缓存补发、重挂接管同一条连接', { timeout: 30000 }, async () => {
    await ensureProto();
    const gateway = await startFakeGateway();
    const host = await startHostProcess();
    try {
        // 注册表必须已经落盘：主进程重启后靠它找回这条连接。
        const { findLiveHost } = require('../dist/host/registry');
        const registered = findLiveHost('e2e-account', PIPE);
        assert.ok(registered, '宿主启动后必须登记到注册表');
        assert.equal(registered.pid, host.pid);
        assert.equal(registered.token, TOKEN, '令牌要一起落盘，否则新主进程接管不了管道');

        const { client, info } = await attachClient();
        assert.equal(info.connected, false, '刚起来的宿主还没有网关连接');

        const frames = [];
        client.onFrame(frame => frames.push(frame));
        client.connectGateway(`ws://127.0.0.1:${gateway.port}`, { Origin: 'https://gate-obt.nqf.qq.com' });
        await waitFor(() => frames.some(frame => frame.meta.t === 'open'), 8000, '网关打开');

        client.sendSession({
            gid: 42,
            openId: 'open-42',
            clientVersion: '1.17.0.4_20261117',
            heartbeatInterval: 200,
            state: { name: 'E2E', level: 12, unlockedSceneIds: [1] },
        });
        await waitFor(() => gateway.received.some(item => item.method === 'Heartbeat'), 8000, '宿主心跳');
        await waitFor(() => frames.some(frame => frame.meta.t === 'server-time'), 8000, '心跳回包转给 worker');

        // worker 断开（模拟热重启），宿主继续心跳；这期间的推送要缓存。
        client.detach();
        const before = gateway.received.filter(item => item.method === 'Heartbeat').length;
        await waitFor(() => gateway.received.filter(item => item.method === 'Heartbeat').length > before, 8000, '断链后心跳继续');

        gateway.server._socket.send(types.GateMessage.encode(types.GateMessage.create({
            meta: { service_name: 'gamepb.farmpb.FarmService', method_name: 'FarmNotify', message_type: 3 },
            body: Buffer.from([9, 9, 9]),
        })).finish());

        // 新 worker 重新挂上去：拿到存活会话 + 快照，并收到补发的推送。
        const replay = [];
        const second = await attachClient(frame => { if (frame.meta.t === 'notify') replay.push(frame); });
        assert.equal(second.info.connected, true, '重挂后应看到存活的网关连接');
        assert.equal(second.info.session.gid, 42);
        assert.equal(second.info.session.state.name, 'E2E');
        assert.equal(second.info.session.state.level, 12);

        await waitFor(() => replay.length > 0, 5000, '补发缓存的推送');
        assert.deepEqual(replay[0].body, Buffer.from([9, 9, 9]));
        assert.equal(replay[0].meta.replay, true, '补发的事件必须标记 replay');
        second.client.detach();
    } finally {
        try { host.kill('SIGTERM'); } catch {}
        try { gateway.server.close(); } catch {}
    }
});
