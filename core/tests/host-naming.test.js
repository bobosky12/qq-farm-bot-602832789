// 连接宿主的命名与开关：默认必须关闭（否则现有部署会被动走远程通道）。
const assert = require('node:assert/strict');
const test = require('node:test');

const { isSocketHostEnabled, createHostToken, hostPipeName } = require('../dist/host/naming');

test('默认关闭：没有 FARM_SOCKET_HOST=1 时不启用连接宿主', () => {
    assert.equal(isSocketHostEnabled({}), false);
    assert.equal(isSocketHostEnabled({ FARM_SOCKET_HOST: '0', FARM_HOST_PIPE: 'p', FARM_HOST_TOKEN: 't' }), false);
    assert.equal(isSocketHostEnabled({ FARM_SOCKET_HOST: 'true' }), false);
});

test('显式开启才算启用', () => {
    assert.equal(isSocketHostEnabled({ FARM_SOCKET_HOST: '1' }), true);
});

test('共享令牌每次生成都不同且长度足够', () => {
    const a = createHostToken();
    const b = createHostToken();
    assert.match(a, /^[0-9a-f]{48}$/);
    assert.notEqual(a, b);
});

test('管道名按账号隔离，并过滤非法字符', () => {
    const one = hostPipeName('1');
    const two = hostPipeName('2');
    assert.notEqual(one, two);
    const tricky = hostPipeName('a/b\\c');
    assert.equal(/[/\\]/.test(tricky.replace(/^\\\\\.\\pipe\\/, '')), false, '非法字符必须被替换');
    assert.match(tricky, /qqfarm-host-/);
});
