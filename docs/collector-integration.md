# 采集器接轨说明（card-collector → 好友号池）

> 对应外部压缩包「采集好友强制添加-最新.zip」。本文说明这套软件各部件怎么用、
> 它与本面板之间的接口契约，以及本项目已实现的兼容层与协议修正。

## 1. 这套软件由三部分组成

| 部件 | 文件 | 作用 |
|---|---|---|
| 采集器 A（注入版） | `card-collector/collect.py` | 用 WeChatFerry 挂在 PC 微信上收消息，抓 QQ 农场小程序分享卡片 |
| 采集器 B（HTTP 推送版） | `card-collector/server.py` | 起一个本地 HTTP 服务（默认 `127.0.0.1:9898`），由 pywxrobot4 的推送插件把消息 POST 过来 |
| 参考面板 | `qq-farm-nodata.tar.gz` | 另一个 qq-farm 分支的完整源码，含「自动加好友」全套实现（本文协议细节的来源） |

两个采集器做的事完全一样：从卡片 XML/文本里抠出 `uid / openid / share_source / share_key`，
写一行到 `cards.txt`，同时把这条推给面板的号池。

## 2. 采集器怎么用

### 2.1 前置条件

- **collect.py**：PC 微信 `3.9.12.51` + WeChatFerry `v39.5.2`（注入式，版本必须配对），`pip install wcferry requests`
- **server.py**：微信 `4.1.1.19` + pywxrobot4 的 HTTP 推送插件，把「消息回调地址」填成 `http://127.0.0.1:9898`，`pip install requests`（不需要 wcferry）

两个脚本都只做「收消息 → 抽参数 → 转发」，不碰游戏协议，所以对游戏账号零风险。

### 2.2 配置（全部走环境变量）

```bash
PANEL_URL=http://127.0.0.1:3008     # 面板地址，默认写的是别人服务器 106.54.15.183:3007，必须改
PANEL_USER=admin                    # 面板登录用户名
PANEL_PASS=你的面板密码              # collect.py 默认 admin；server.py 里硬编码了一个别人环境的密码，必须覆盖
ACCOUNT_ID=1                        # 只影响 x-account-id 头，号池本身全账号共享
AUTO_IMPORT=1                       # 1 = 边采集边推面板；0 = 只落 cards.txt
IMPORT_BATCH_SEC=30                 # 仅 collect.py：攒够 30 秒批量推一次
OUT_FILE=cards.txt                  # 本地留档，重跑不会丢
TARGET_APPID=wx5306c5978fdb76e4     # 只认这个 appid 的卡片（留空则收所有带 share_key 的链接）
```

启动：

```bash
python collect.py     # 或
python server.py
```

验证：`curl http://127.0.0.1:9898/` 返回 `card-collector ok, seen=N`；微信里收到一张农场分享卡片后 N 会加 1。

### 2.3 卡片长什么样

采集器只认带 `share_key=` 的文本，抽四个参数：

```
uid=1239179400&openid=oL61MvmwhnI-S9LTtVq1G2XCK59o&share_source=8&doc_id=5&share_key=0a92333c57ac4fb98be66890f58e966a
```

- `uid` 就是游戏 GID，必须纯数字，否则整条丢弃
- `share_key` 是 32 位十六进制串，**没有它这张卡片没法用**
- `openid` 是分享者的 openid，**强制添加必须靠它**，缺了只能走申请
- `share_source` 落到协议的 `share_cfg_id`

## 3. 采集器 → 面板的接口契约

采集器对面板只有两个请求，都是它写死的，**改面板比改采集器划算**：

| 请求 | 路径 | 结构 |
|---|---|---|
| 登录取 token | `POST /api/login` | body `{username, password}` → 读 `data.token`，缓存 30 分钟，401 时强制刷新重试一次 |
| 导入号池 | `POST /api/auto-friend/pool/import` | body `{users:[{gid, shareKey, openid?, shareCfgId?}]}`，头 `x-admin-token` + `x-account-id` → 读 `data.added / data.updated / data.skipped` |

本项目已按这份契约实现（见 §5），采集器端**一行代码都不用改**。

## 4. 参考面板里的「强制添加」——本项目原实现缺的那一块

参考实现的 `AUTO-FRIEND.md` 与反编译交叉验证后，加好友有两条链路：

| 方式 | 流程 | 需要 | 结果 |
|---|---|---|---|
| 申请添加 | `VisitService.Enter(reason=5, share_key)` → 回包 `apply_token` → `FriendService.ApplyFriend(gid, apply_token)` | gid + share_key + 拜访开关 | 发申请，等对方同意 |
| 强制添加 | `UserService.ReportArkClick(sharer_id, sharer_open_id, scene_id, share_cfg_id, share_key)` | gid + share_key + **openid** | 服务端几秒内直接绑定，无需同意 |

强制添加的本质是「模拟玩家点开这张分享卡片」。反编译里玩家点卡片时只发这一个请求
（`game.resolved.fixed.js:105846`），服务端随即完成好友绑定。

**本项目原来的坑**：`userpb.proto` 里把字段号写反了，而且漏了 `share_key`：

```
旧（错）: sharer_id=1, sharer_open_id=2, share_cfg_id=3, scene_id=4              // 没有 share_key
新（对）: sharer_id=1, sharer_open_id=2, scene_id=3, share_cfg_id=4, share_key=5
```

字段 3 一个是 int64 一个是 string，wire type 对不上，服务端直接当未知字段跳过——
所以旧链路「上报点击」跑得通、日志也正常，但从来没真正加过人。这也是本项目的
`invite.ts` 注释里写「旧链路只发 ReportArkClick，不会真正发出好友申请」的真实原因。

### 强制添加的硬约束（实测结论，来自参考实现）

1. `sharer_open_id` **必须与 share_key 的主人一致**，否则服务端不绑定（0/6 vs 3/3 对照实验）。
   采集器抓的是同一张卡片里的 uid/openid/share_key，天然匹配；手工拼的数据很容易错。
2. 对方好友位满时绑定失败，同步回包不报错，**只能事后查好友列表或看回包 `relation.is_friend`**。
3. 回包 `ReportArkClickReply.relation.is_friend` 是唯一可靠的当场判据，本项目已按它记账。
4. 申请方式有每日上限，撞到错误码 `1005027` 当天就不要再试（已做熔断）。

## 5. 本项目做了什么（v3.35.4）

### 5.1 协议修正

- `core/src/proto/userpb.proto`：`ReportArkClickRequest` 字段号改为 `scene_id=3 / share_cfg_id=4` 并补 `share_key=5`；`ReportArkClickReply` 补 `relation`
- `core/src/proto/corepb.proto`：新增 `RelationInfo { is_friend=1, is_community_member=2, is_stranger=3 }`
- `core/src/proto/visitpb.proto`：`EnterReply` 补 `host_at_home=6 / host_relation=7 / unix_milli=8 / is_tourist=9` 与 `HostRelationInfo`

### 5.2 服务层

- `invite.ts`
  - `sendReportArkClick(sharerId, sharerOpenId, shareSource, shareKey, sceneId='1007')`：带 share_key，返回解码后的回包
  - `forceAddSharer(item)`：强制直加，缺 openid/uid/shareKey 时本地跳过不发请求
  - `enterSharer`：额外解析 `host_relation.is_friend`、`is_tourist`、`brief_dog_info.dog_id`，Enter 顺手把昵称/等级/犬种回填号池
  - `applyInviteList(items, { mode })`：`mode='force'` 走直加（不查拜访开关、不做 Enter），`mode='apply'` 走原链路
- `friend/pool.ts`
  - 号池条目新增 `dogBreed` / `identifiedAt`；申请状态新增 `mode` / `arkBound`
  - `markArkApplied(accountId, uid, bound)`：`bound=true` 记好友，`false` 留 `pending` 下一轮再试（不判死）
  - `updateProfile` 支持犬种回填

### 5.3 采集器兼容层

- `POST /api/auto-friend/pool/import`：吃 `{users:[...]}`，返回 `{ok:true, data:{added, updated, skipped, parsed}}`
- `GET /api/auto-friend/pool`：与 `/api/friends/pool` 等价
- `normalizePoolItem` 统一字段别名：`uid/gid/sharer_id`、`openid/openId/sharer_open_id`、`shareKey/share_key`、`shareSource/share_source/shareCfgId`、`cardTime/card_time/at`
- 规则调整：**uid 必填，openid 与 shareKey 至少有一个**（旧版强制 openid，把只带 shareKey 的合法卡片也丢了）

### 5.4 界面

设置 → 好友申请 新增：

- 「强制添加 / 申请添加」切换（默认强制），按钮文案与结果统计随模式变化
- 可展开的「接采集器」配置块，直接给出本机 `PANEL_URL` 与全套环境变量
- 号池列表显示犬种，缺 openid 的条目直接标注「缺 openid」

## 6. 接轨操作步骤

1. 面板启动，拿到实际地址（本机调试是 `http://127.0.0.1:3008`）
2. 采集器按 §2.2 设环境变量，特别是 `PANEL_URL` 和 `PANEL_PASS`
3. 启动采集器，让微信收到一张农场分享卡片
4. 面板 设置 → 好友申请 里应看到该条自动出现（状态「未申请」）
5. 勾选 → 点「批量强制添加」

自测（不依赖微信，直接打接口）：

```bash
TOKEN=$(curl -s -X POST http://127.0.0.1:3008/api/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"你的密码"}' | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).data.token))")

curl -s -X POST http://127.0.0.1:3008/api/auto-friend/pool/import \
  -H 'Content-Type: application/json' -H "x-admin-token: $TOKEN" -H 'x-account-id: 1' \
  -d '{"users":[{"gid":1217640671,"shareKey":"<32位>","openid":"oL61...","shareCfgId":8}]}'
# 期望：{"ok":true,"data":{"added":1,"updated":0,"skipped":0,"parsed":1}}
```

## 7. 日志关键字

| 关键字 | 含义 |
|---|---|
| `开始强制添加好友：N 个候选` | 批次启动 |
| `已强制添加 uid=... isFriend=true` | 服务端确认绑定成功 |
| `强制添加未绑定（openid 与 share_key 可能不匹配）` | 请求发出但没绑上，检查卡片是否同一人所发 |
| `今日好友申请已达上限` | 撞 `1005027`，当天停 |
| `缺 openid 无法强制添加` | 该卡片只能走申请模式 |
| `未开启「好友功能 · 点击分享链接可拜访好友」` | 申请模式被 `1002007` 挡住，面板会自动尝试打开 |

## 8. 仍然存在的限制

- `share_key` 的有效期与次数由服务端控制，不可见；失效的卡片会记为失败
- 强制添加依赖 openid 与 share_key 同源，手工拼数据不可靠——**始终用采集器原始卡片**
- 对方好友位满时无法当场发现，需要事后核对好友列表
- 采集器是注入式（collect.py）或挂在机器人上（server.py），微信版本必须配对，升级微信会导致失效
- 面板与采集器之间没有鉴权之外的防重放，局域网内使用即可，不要直接暴露公网
