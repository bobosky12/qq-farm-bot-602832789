// 宿主传输的 worker 侧：热重启后不需要 Code，直接用宿主回报的会话快照恢复 userState。
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqfarm-host-transport-'));
const PIPE = process.platform === 'win32'
    ? `\\\\.\\pipe\\qqfarm-transport-${process.pid}`
    : path.join(dir, 'host.sock');

const { encodeFrame, createFrameDecoder } = require('../dist/host/frame');

function startFakeHost(session) {
    const sockets = new Set();
    const server = net.createServer(socket => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
        const decode = createFrameDecoder(frame => {
            if (frame.meta.t === 'hello') {
                socket.write(encodeFrame({
                    t: 'hello-ok',
                    accountId: '1',
                    connected: true,
                    session,
                    bufferedNotifies: 0,
                }));
            }
        });
        socket.on('data', chunk => decode(chunk));
        socket.on('error', () => {});
    });
    return new Promise(resolve => server.listen(PIPE, () => resolve({ server, sockets })));
}

test('worker attach 到已有存活会话：不要求 Code，userState 按快照回填', { timeout: 15000 }, async () => {
    const session = {
        gid: 4242,
        openId: 'open-4242',
        clientVersion: '1.17.0.4_20261117',
        heartbeatInterval: 25000,
        state: {
            name: '测试号',
            level: 88,
            gold: 123456,
            exp: 789,
            avatarUrl: 'https://example/avatar.png',
            unlockedSceneIds: [1, 2, 7],
            serverTime: Date.now(),
        },
    };
    const { server, sockets } = await startFakeHost(session);
    process.env.FARM_SOCKET_HOST = '1';
    process.env.FARM_HOST_PIPE = PIPE;
    process.env.FARM_HOST_TOKEN = 'transport-token';

    const { connect, cleanup, getUserState, getInboundSilenceMs } = require('../dist/utils/network');
    try {
        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('复用会话分支没有触发登录成功回调')), 8000);
            connect(null, () => {
                clearTimeout(timer);
                resolve();
            });
        });

        const state = getUserState();
        assert.equal(state.gid, 4242, 'gid 必须来自宿主会话');
        assert.equal(state.openId, 'open-4242');
        assert.equal(state.name, '测试号', '昵称必须回填，不能停在「未知」');
        assert.equal(state.level, 88);
        assert.equal(state.gold, 123456);
        assert.deepEqual(state.unlockedSceneIds, [1, 2, 7], '已解锁场景决定牧场切换，必须回填');

        // 回归：宿主模式必须刷新入站时间，否则「连接无响应」误判把自动额度从 180/60s 压到 24/60s。
        await new Promise(resolve => setTimeout(resolve, 150));
        const before = getInboundSilenceMs();
        assert.ok(before > 100, '等待后应有入站静默时间');
        for (const socket of sockets) socket.write(encodeFrame({ t: 'server-time', serverTime: Date.now() }));
        await new Promise(resolve => setTimeout(resolve, 80));
        assert.ok(getInboundSilenceMs() < before, '宿主转发入站帧后必须重置入站静默时间');
    } finally {
        cleanup('测试收尾');
        server.close();
    }
});
