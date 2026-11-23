/**
 * 好友牧场赠牧草（v3.35.7 同步上游 c3c5e5e）的接线护栏。
 *
 * 这条链路横跨 actions / friends / state / 前端面板四层，任何一层掉链子都不会报错，
 * 只会表现为「点赠送没反应」或「牧草余量永远是 0」，所以用静态断言把关键接线钉住：
 *   - actions.addGrass 带 hostGid 时走 withFriendVisit（而不是进自己农场）
 *   - friends 导出 withFriendVisit
 *   - state 在 hostGid 分支回填 grassAvailable（前端才知道能送多少）
 *   - 面板确实把 hostGid 传下来
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const read = relative => fs.readFileSync(path.join(__dirname, '..', relative), 'utf8');

const actions = read('src/services/ranch/actions.ts');
const friends = read('src/services/ranch/friends.ts');
const state = read('src/services/ranch/state.ts');
const panel = read('../web/src/components/ranch/RanchFriendsPanel.vue');

test('actions：addGrass 带 hostGid 时进入好友农场，而不是自己农场', () => {
    assert.match(actions, /function inActionScene\(/, '要有 action 场景分流函数');
    assert.match(actions, /action === 'addGrass' && input\.hostGid !== undefined/, '按 addGrass + hostGid 判定好友赠送');
    assert.match(actions, /withFriendVisit\(input\.hostGid/, '好友赠送必须走 withFriendVisit');
    assert.match(actions, /plan\.payload\.host_gid = raw\.recipient\.gid/, '请求体要带上对方 gid');
});

test('actions：赠牧草的目标与回包校验单独处理', () => {
    assert.match(actions, /ranch:addGrass:\$\{before\.recipient\.gid\}/, '花费目标要按好友维度区分');
    assert.match(actions, /好友牧草机回包不匹配/, '回包 feed_count 不足要判异常');
    assert.match(actions, /已向\$\{before\.recipient\.name\}赠送/, '完成提示带对方昵称');
});

test('actions：本地 operateCore 拆分保留（好友动作短路到 friends 服务）', () => {
    assert.match(actions, /async function operateCore\(/, 'operateCore 是本地拆分，不能被上游 operate 覆盖');
    assert.match(actions, /async function operate\(/, '对外入口仍是 operate');
});

test('friends：导出 withFriendVisit，并保留牧场动作计数', () => {
    assert.match(friends, /async function withFriendVisit\(/, '要有好友农场访问包装');
    assert.match(friends, /module\.exports = \{[^}]*withFriendVisit/, 'withFriendVisit 必须导出');
    assert.match(friends, /recordRanchAction\('steal'\)|recordRanchAction\(plan\.action\)/, '偷取/互动计数不能丢');
});

test('state：好友视图回填 grassAvailable，且好友列表失败不打成 500', () => {
    assert.match(state, /state\.friendRanch\.grassAvailable = \(BigInt\(grass\.total\) - BigInt\(grass\.locked\)\)\.toString\(\)/, '牧草余量 = 总数 - 锁定');
    assert.match(state, /friendsError = String\(/, '好友列表读取失败要降级成可读错误');
});

test('前端：面板按好友传 hostGid，并按余量与容量夹取数量', () => {
    assert.match(panel, /request\('addGrass', \{ hostGid: targetDetail\.gid/, '赠送请求要带 hostGid');
    assert.match(panel, /grassAvailableOf/, '要读后端回填的牧草余量');
    assert.match(panel, /Math\.min\(Number\(grassAvailableOf/, '赠送数量不能超过可用余量');
});
