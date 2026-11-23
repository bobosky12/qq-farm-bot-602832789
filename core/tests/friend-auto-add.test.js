// 主动加好友（BUGDey v2.18.12 移植）：协议、号池与分享链接解析。
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqfarm-friend-pool-'));
process.env.FARM_FRIEND_POOL_FILE = path.join(dir, 'friend-pool.json');

const pool = require('../dist/services/friend/pool');
const { parseShareLink } = require('../dist/services/invite');
const { types, loadProto } = require('../dist/utils/proto');

test('协议：ApplyFriend 与拜访分享字段都已接入', async () => {
    const friendProto = fs.readFileSync(path.join(__dirname, '..', 'src', 'proto', 'friendpb.proto'), 'utf8');
    const visitProto = fs.readFileSync(path.join(__dirname, '..', 'src', 'proto', 'visitpb.proto'), 'utf8');
    const userProto = fs.readFileSync(path.join(__dirname, '..', 'src', 'proto', 'userpb.proto'), 'utf8');
    assert.match(friendProto, /message ApplyFriendRequest/)
    assert.match(friendProto, /string apply_token = 2/)
    assert.match(visitProto, /string share_key = 7/)
    assert.match(visitProto, /string apply_token = 10/)
    assert.match(userProto, /int32 visit_by_share_key = 6/)
    assert.match(userProto, /message SetUserSettingsRequest/)

    await loadProto()
    assert.ok(types.ApplyFriendRequest, 'ApplyFriendRequest 必须注册')
    assert.ok(types.SetUserSettingsRequest, 'SetUserSettingsRequest 必须注册')
    const body = types.ApplyFriendRequest.encode(types.ApplyFriendRequest.create({
        gid: 123, apply_token: 'token:123', source: 0,
    })).finish()
    const decoded = types.ApplyFriendRequest.decode(body)
    assert.equal(String(decoded.gid), '123')
    assert.equal(decoded.apply_token, 'token:123')
});

test('分享链接解析：支持整段 URL 与 share_key / card_time', () => {
    const parsed = parseShareLink('https://example.com/?uid=123&openid=o-1&share_key=abc123&share_source=7&card_time=2026-11-23')
    assert.equal(parsed.uid, '123')
    assert.equal(parsed.openid, 'o-1')
    assert.equal(parsed.shareKey, 'abc123')
    assert.equal(parsed.cardTime, '2026-11-23')
});

test('号池：导入、按账号隔离状态、每日上限', () => {
    const result = pool.upsertItems([
        { uid: '1001', openid: 'o-1001', shareKey: 'key-1' },
        { uid: '1002', openid: 'o-1002', shareKey: 'key-2' },
    ])
    assert.equal(result.added, 2)

    assert.equal(pool.getStatusMap('acc-A')['1001'], 'new')
    pool.markApplied('acc-A', '1001')
    assert.equal(pool.getStatusMap('acc-A')['1001'], 'pending')
    assert.equal(pool.getStatusMap('acc-B')['1001'], 'new', '申请状态不能串到别的账号')

    const snapshot = pool.snapshot('acc-A')
    assert.equal(snapshot.total, 2)
    assert.equal(snapshot.counts.pending, 1)
    assert.equal(snapshot.items.find(item => item.uid === '1001').applyCount, 1)

    assert.equal(pool.dailyLimitBlocked('acc-A'), false)
    pool.markDailyLimit('acc-A', 'code=1005027')
    assert.equal(pool.dailyLimitBlocked('acc-A'), true)
    assert.equal(pool.dailyLimitBlocked('acc-B'), false)
    pool.clearDailyLimit('acc-A')
    assert.equal(pool.dailyLimitBlocked('acc-A'), false)
});

test('号池：同一个人换 uid 仍按 openid 去重', () => {
    const result = pool.upsertItems([
        { uid: '2001', openid: 'o-same', shareKey: 'key-a' },
        { uid: '2002', openid: 'o-same', shareKey: 'key-b', cardTime: '2026-11-24' },
    ])
    assert.equal(result.added, 1, '同一 openid 的两次导入只新增 1 条，第二次更新第一条')
    assert.equal(pool.snapshot('acc-A').total, 3, '上一条测试 2 条 + 本次去重后 1 条')
    assert.ok(!pool.snapshot('acc-A').items.some(item => item.uid === '2002'))
    assert.equal(pool.snapshot('acc-A').items.find(item => item.uid === '2001').shareKey, 'key-b', '更新的卡片覆盖旧分享 key')
});
