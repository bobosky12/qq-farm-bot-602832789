// 连接宿主注册表：主进程重启后靠它找回上一条连接。
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqfarm-host-registry-'));
process.env.FARM_HOST_REGISTRY = path.join(dir, 'host-registry.json');

const {
    registryFile,
    readHostRegistry,
    isProcessAlive,
    findLiveHost,
    upsertHostEntry,
    removeHostEntry,
} = require('../dist/host/registry');

test('注册表落在 FARM_HOST_REGISTRY 指定的位置，缺失时当空表', () => {
    assert.equal(registryFile(), process.env.FARM_HOST_REGISTRY);
    assert.deepEqual(readHostRegistry(), {});
});

test('登记后能按账号找回；pid 已死的条目会被清掉', () => {
    upsertHostEntry({ accountId: 'acc-1', pipe: 'pipe-a', token: 'token-a', pid: process.pid });
    const live = findLiveHost('acc-1', 'pipe-a');
    assert.ok(live, '当前进程一定活着，条目应可复用');
    assert.equal(live.token, 'token-a');
    assert.equal(live.pid, process.pid);

    upsertHostEntry({ accountId: 'acc-dead', pipe: 'pipe-b', token: 'token-b', pid: 999999 });
    assert.equal(findLiveHost('acc-dead', 'pipe-b'), null, 'pid 不存在时不能复用');
    assert.equal(readHostRegistry()['acc-dead'], undefined, '死条目必须顺手删掉');
});

test('管道名不一致视为账号被重建：不复用旧条目', () => {
    upsertHostEntry({ accountId: 'acc-2', pipe: 'pipe-old', token: 'token-old', pid: process.pid });
    assert.equal(findLiveHost('acc-2', 'pipe-new'), null);
    assert.equal(readHostRegistry()['acc-2'], undefined);
});

test('只删除自己的条目：旧宿主退出不能抹掉新宿主', () => {
    upsertHostEntry({ accountId: 'acc-3', pipe: 'pipe-c', token: 'token-c', pid: process.pid });
    removeHostEntry('acc-3', 999999);
    assert.ok(readHostRegistry()['acc-3'], 'pid 不匹配时保留');
    removeHostEntry('acc-3', process.pid);
    assert.equal(readHostRegistry()['acc-3'], undefined);
});

test('isProcessAlive 对非法 pid 返回 false', () => {
    assert.equal(isProcessAlive(0), false);
    assert.equal(isProcessAlive(-1), false);
    assert.equal(isProcessAlive(process.pid), true);
});
