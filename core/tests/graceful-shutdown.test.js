/**
 * 容器停服：别把滚动中的 refreshtoken 切在中间。
 *
 * 背景（一次真实事故）：
 *   `docker stop` 发 SIGTERM → node 当时是 PID 1 且**没有注册 handler** →
 *   内核对 PID 1 的「默认动作」信号不执行终止 → docker 等 10 秒宽限期后 SIGKILL。
 *   这一刀正落在「服务端已经把旧 refreshtoken 作废、新值还没写盘」的窗口里，
 *   账号从此留下一个死 token，之后每次启动都 -109，只能重新扫码。
 *
 * 修法由两半组成，缺一不可：
 *   1. `core/client.ts` 显式注册 SIGTERM/SIGINT，先 `waitForCredentialIdle` 再停账号退出；
 *      注册 handler 之后内核会正常投递，PID 1 身份不再是障碍。
 *   2. `docker-compose.yml` 的 `init: true` 让 tini 当 PID 1，负责回收 worker 僵尸进程。
 *
 * 这里锁住这两半以及「保活要先于自动登录装上」这个顺序。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.join(__dirname, '..', '..');

function read(relative) {
    return fs.readFileSync(path.join(REPO_ROOT, relative), 'utf8');
}

const { waitForCredentialIdle, credentialBusyCount } = require('../dist/services/wx-credential');

test('停服钩子：显式接管 SIGTERM / SIGINT，而不是依赖进程默认动作', () => {
    const source = read('core/client.ts');
    assert.match(source, /process\.on\('SIGTERM'/, '不注册 SIGTERM，容器里就等于把进程交给 SIGKILL');
    assert.match(source, /process\.on\('SIGINT'/);
    assert.match(source, /waitForCredentialIdle/, '退出前必须等在途凭证操作收尾');
    assert.match(source, /stopAllAccounts/, '退出前要停掉账号，别留半截连接');
    assert.match(source, /gracefulShutdown/);
});

test('停服钩子只装在主进程，worker 不重复接管', () => {
    const source = read('core/client.ts');
    const guard = source.indexOf('if (!isWorkerProcess)');
    assert.ok(guard > 0, '信号注册要放在 !isWorkerProcess 分支里');
    const after = source.slice(guard);
    assert.match(after, /process\.on\('SIGTERM'/);
});

test('compose 给容器注入 init，worker 子进程有 init 收尸', () => {
    const compose = read('docker-compose.yml');
    assert.match(compose, /^\s{4}init:\s*true\s*$/m, 'compose 要有 init: true');
});

test('waitForCredentialIdle：空闲时立即返回，超时也不会卡住停服', async () => {
    assert.equal(credentialBusyCount(), 0);
    const startedAt = Date.now();
    const drained = await waitForCredentialIdle(5000);
    assert.equal(drained, true);
    assert.ok(Date.now() - startedAt < 1000, '空闲时不该等满宽限期');

    // 宽限期设为 0 也必须立刻返回，绝不能把 docker stop 拖过超时
    const second = await waitForCredentialIdle(0);
    assert.equal(second, true);
});

test('保活先于自动登录装上：启动批次的掉线同样有人兜', () => {
    const source = read('core/src/runtime/runtime-engine.ts');
    const startBlock = source.slice(source.indexOf('async function start('));
    const keepAliveCall = startBlock.indexOf('startAccountKeepAlive();');
    const autoStartCall = startBlock.indexOf('await startAllAccounts()');
    assert.ok(keepAliveCall > 0, 'start() 里要调用 startAccountKeepAlive');
    assert.ok(autoStartCall > 0, 'start() 里要调用 startAllAccounts');
    assert.ok(
        keepAliveCall < autoStartCall,
        '保活必须排在自动登录之前：否则启动批次的掉线落在「依赖还没注入」的空窗里，'
        + 'wx-keepalive 的 log() 在依赖缺失时是静默 no-op，连一条「N 秒后重登」都不会留下',
    );
});

test('自动登录的成功日志不再提前写死「已自动登录」', () => {
    const source = read('core/src/runtime/runtime-engine.ts');
    // 只盯 addAccountLog 的实际调用，注释里为了说明历史可以提到旧文案。
    const loginLogs = [...source.matchAll(/addAccountLog\('auto_login'[^\n]*/g)].map(match => match[0]);
    assert.ok(loginLogs.length > 0, '要有一条自动登录的账号日志');
    for (const line of loginLogs) {
        assert.ok(
            !line.includes('已随服务启动自动登录'),
            'startAccount 返回 true 只代表已发起，网关 400 可能 1 秒后才到；'
            + '这时日志里留着一条成功记录会把排查带偏',
        );
    }
    assert.match(source, /已发起自动登录/);
});
