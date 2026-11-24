const test = require('node:test');
const assert = require('node:assert/strict');
const { createRuntimeState } = require('../dist/runtime/runtime-state');

function makeLogs() {
    return [
        { time: '2026-11-24 10:00:00', ts: 1, tag: '农场', msg: 'a', meta: { module: 'farm', event: 'farm_cycle' } },
        { time: '2026-11-24 10:01:00', ts: 2, tag: '好友', msg: 'b', meta: { module: 'friend', event: 'friend_cycle' } },
        { time: '2026-11-24 10:02:00', ts: 3, tag: '仓库', msg: 'c', meta: { module: 'warehouse', event: 'seed_buy' } },
        { time: '2026-11-24 10:03:00', ts: 4, tag: '牧场', msg: 'd', meta: { module: 'ranch', event: 'ranch_feed' } },
        { time: '2026-11-24 10:04:00', ts: 5, tag: '系统', msg: 'e', meta: { module: 'system', event: '' } },
    ];
}

function makeState() {
    const state = createRuntimeState({ store: { getConfigSnapshot: () => ({ automation: {} }) } });
    state.globalLogs.push(...makeLogs());
    return state;
}

test('单个 module 过滤仍生效', () => {
    const state = makeState();
    const out = state.filterLogs(state.globalLogs, { module: 'ranch' });
    assert.equal(out.length, 1);
    assert.equal(out[0].meta.event, 'ranch_feed');
});

test('逗号分隔多 module 过滤：农场含降级的 friend/warehouse', () => {
    const state = makeState();
    const out = state.filterLogs(state.globalLogs, { module: 'farm,friend,warehouse' });
    assert.equal(out.length, 3);
    assert.deepEqual(out.map(l => l.meta.module).sort(), ['farm', 'friend', 'warehouse']);
});

test('system 多选匹配含系统标签', () => {
    const state = makeState();
    state.globalLogs.push({ time: '2026-11-24 10:05:00', ts: 6, tag: '错误', msg: 'f', meta: {} });
    const out = state.filterLogs(state.globalLogs, { module: 'system' });
    assert.equal(out.length, 2);
});

test('meta.module 为空时回退到 tag：否则切小号后牧场日志整段消失', () => {
    const state = createRuntimeState({ store: { getConfigSnapshot: () => ({ automation: {} }) } });
    // 真实日志里 meta.module 大多为空，归属只体现在中文 tag 上。
    state.globalLogs.push(
        { time: '2026-11-24 10:00:00', ts: 1, tag: '牧场', msg: '喂养', meta: { event: 'ranch_feed' } },
        { time: '2026-11-24 10:01:00', ts: 2, tag: '好友', msg: '巡查', meta: { event: 'friend_cycle' } },
    );
    assert.equal(state.filterLogs(state.globalLogs, { module: 'ranch' }).length, 1);
    assert.equal(state.filterLogs(state.globalLogs, { module: 'ranch' })[0].msg, '喂养');
    assert.equal(state.filterLogs(state.globalLogs, { module: 'farm,friend,warehouse' }).length, 1);
    assert.equal(state.filterLogs(state.globalLogs, { module: 'farm,friend,warehouse' })[0].msg, '巡查');
});

test('未登记的中文 tag 不会被任何模块筛中，但「所有模块」照常返回', () => {
    const state = createRuntimeState({ store: { getConfigSnapshot: () => ({ automation: {} }) } });
    state.globalLogs.push({ time: '2026-11-24 10:00:00', ts: 1, tag: '未知来源', msg: 'x', meta: {} });
    assert.equal(state.filterLogs(state.globalLogs, { module: 'ranch' }).length, 0);
    assert.equal(state.filterLogs(state.globalLogs, { module: '' }).length, 1);
});
