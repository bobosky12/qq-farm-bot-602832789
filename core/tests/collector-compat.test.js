/**
 * 采集器（card-collector）兼容层。
 *
 * 外部采集器打的是 /api/auto-friend/pool/import，body {users:[{gid,shareKey,openid,shareCfgId}]}，
 * 只认 data.added / data.updated / data.skipped。这里锁住字段映射与容错规则，
 * 避免以后改号池结构时把采集器悄悄打坏（对方脚本不归我们改）。
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-farm-collector-'));
process.env.FARM_FRIEND_POOL_FILE = path.join(tmpDir, 'friend-pool.json');

const { normalizePoolItem, parsePoolLine } = require('../dist/controllers/admin/friend-routes');
const pool = require('../dist/services/friend/pool');

test('采集器字段 gid/shareKey/openid/shareCfgId 映射成号池字段', () => {
    const item = normalizePoolItem({
        gid: 1239179400, shareKey: 'k-abc', openid: 'oL61Mvmw', shareCfgId: 8,
    });

    assert.equal(item.uid, '1239179400');
    assert.equal(item.openid, 'oL61Mvmw');
    assert.equal(item.shareKey, 'k-abc');
    assert.equal(item.shareSource, '8', 'shareCfgId 要落到 shareSource');
});

test('缺 openid 也收：申请模式不需要它，强制模式才需要', () => {
    const item = normalizePoolItem({ gid: 1217640671, shareKey: 'k-def' });

    assert.equal(item.uid, '1217640671');
    assert.equal(item.openid, '');
    assert.equal(item.shareKey, 'k-def');
});

test('uid 非法或 shareKey/openid 全空的行直接丢弃', () => {
    assert.equal(normalizePoolItem({ gid: 'abc', shareKey: 'k' }), null);
    assert.equal(normalizePoolItem({ gid: 0, shareKey: 'k' }), null);
    assert.equal(normalizePoolItem({ gid: 12345 }), null, '既没 openid 也没 shareKey，进来也没用');
    assert.equal(normalizePoolItem(null), null);
});

test('逐行文本解析能吃下采集日志的时间前缀与问号变体', () => {
    const withPrefix = parsePoolLine(
        '2026-07-26 02:00:51 | uid=1217640671&openid=oL61Mvw&share_source=1&doc_id=0&share_key=6836e7abc',
    );
    assert.equal(withPrefix.uid, '1217640671');
    assert.equal(withPrefix.shareKey, '6836e7abc');
    assert.equal(withPrefix.shareSource, '1');
    assert.equal(withPrefix.cardTime, '2026-07-26 02:00:51');

    const withQuestion = parsePoolLine('?uid=123&openid=op&share_source=8&share_key=k1');
    assert.equal(withQuestion.uid, '123');
    assert.equal(withQuestion.shareKey, 'k1');
});

test('导入口径：同一条重复推送只算更新，不重复建条目', () => {
    const first = pool.upsertItems([normalizePoolItem({ gid: 555, shareKey: 'k1', openid: 'op1', shareCfgId: 8 })]);
    assert.deepEqual(first, { added: 1, updated: 0 });

    const second = pool.upsertItems([normalizePoolItem({ gid: 555, shareKey: 'k1', openid: 'op1', shareCfgId: 8 })]);
    assert.deepEqual(second, { added: 0, updated: 1 });

    const snapshot = pool.snapshot('1');
    assert.equal(snapshot.items.filter(item => item.uid === '555').length, 1);
});

test('识别回填：犬种与等级写回号池，快照能读到', () => {
    pool.upsertItems([normalizePoolItem({ gid: 666, shareKey: 'k2', openid: 'op2' })]);
    pool.updateProfile('666', { name: '测试号', level: 118, dogBreed: '柯基' });

    const item = pool.snapshot('1').items.find(entry => entry.uid === '666');
    assert.equal(item.name, '测试号');
    assert.equal(item.level, 118);
    assert.equal(item.dogBreed, '柯基');
    assert.ok(item.identifiedAt > 0);
});

test('强制直加记账：回包 is_friend=true 记成好友，false 留 pending 等下一轮', () => {
    pool.upsertItems([
        normalizePoolItem({ gid: 777, shareKey: 'k3', openid: 'op3' }),
        normalizePoolItem({ gid: 778, shareKey: 'k4', openid: 'op4' }),
    ]);

    pool.markArkApplied('1', '777', true);
    pool.markArkApplied('1', '778', false);

    const snapshot = pool.snapshot('1');
    const bound = snapshot.items.find(entry => entry.uid === '777');
    const unbound = snapshot.items.find(entry => entry.uid === '778');

    assert.equal(bound.status, 'friend');
    assert.equal(bound.mode, 'force');
    assert.equal(bound.arkBound, true);
    assert.equal(unbound.status, 'pending', '没绑上不能判死，卡片可能还能用');
    assert.equal(unbound.arkBound, false);
});
