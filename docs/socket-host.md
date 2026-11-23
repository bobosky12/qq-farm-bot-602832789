# 连接宿主（Socket Host）

> 目标：**只要底层游戏 Socket 不断，其余一切都能热更新** —— 业务协议、自动化调度、静态配置、数据表结构、前端、甚至整个主进程。

## 1. 为什么要拆

原来 WS 连接、心跳、上行加密、TSDK/ACE 全在业务 worker 里。worker 一重启（改代码、崩溃、换配置），
连接就断，账号必须重新拿 Code 登录；Code 是一次性的、微信会过期，于是「改个前端文案 → 账号掉线重登」。

拆开之后：

```
主进程（面板 / 调度 / 账号库）
  └── 连接宿主（每账号一个独立进程，detached）
        ├── WebSocket（握手参数由 worker 提供，宿主不解析）
        ├── 上行加密（TSDK encryptBuffer）+ 网关 token + GateMessage 信封
        ├── 心跳（worker 在线时由业务层发；worker 不在时宿主接管）
        ├── ACE / AntiData 运行时
        └── named pipe ⇄ 业务 worker（可随时换掉）
              ├── 业务 proto 编解码
              ├── 农场 / 牧场 / 活动自动化
              ├── 数据落盘与迁移
              └── 静态配置
```

宿主的职责边界：**只碰「传输层」**，不 `require` 任何 `gamepb.*` 业务协议。
入站的 Response 只解 `GateMessage` 信封，把 `service / method / 明文 body` 转给 worker；
Notify 则把 `EventMessage` 原始字节转过去，事件类型由业务层解释（这样新增事件类型不需要重启宿主）。

## 2. 开关

| 环境变量 | 作用 |
| --- | --- |
| `FARM_SOCKET_HOST=1` | 启用连接宿主；不设时完全走原来的 worker 内直连（默认关闭，不影响现有部署） |
| `FARM_HOST_IDLE_MS` | 没有 worker 接管多久后宿主自行退出，默认 15 分钟 |
| `FARM_HOST_REGISTRY` | 注册表文件路径覆盖（默认 `data/host-registry.json`，测试用） |
| `FARM_HOST_DEBUG=1` | 打印入站信封（排查用，量大） |

开启后 worker 强制走 **fork 进程模型**：宿主信息（管道名 / 令牌）是按进程的环境变量注入的，
线程之间共享 `process.env`，无法按账号隔离。打包版（pkg）不支持宿主，会自动保持直连。

## 3. 关键不变量

### 3.1 client_seq 由宿主统一分配

**网关只接受连续序号。** 宿主如果另起一段序号（例如从 100 万开始）发请求，服务器不回包 —— 心跳和
AntiData 会静默超时，表现就是「连接看着还在，但心跳一直漏拍」。

所以：

- worker 发请求时带的是**自己的请求号**（用于回调配对），宿主转发时换成 `allocSeq()` 分配的线程序号，
  并记录 `线程序号 → worker 请求号`；
- 回包按线程序号找回 worker 请求号再下发；找不到映射（业务层已超时 / worker 已重启）直接丢弃，
  绝不能把迟到回包串到新请求上；
- 宿主自己发的心跳 / ACE 也用同一个序号源。

改动这条链路时，务必跑 `core/tests/host-e2e.test.js`：它用一个假网关验证心跳、AntiData 这类
「宿主自己发起」的请求也能拿到回包。

### 3.2 心跳归属

- **worker 在线**：心跳由 worker 发（`startHeartbeat`），失败计数、补发、判死都在业务层，
  宿主看到 `Heartbeat` 请求就让路，不插自己的心跳去抢序号；
- **worker 不在**（热重启窗口 / 崩溃）：宿主接管，用统一序号继续发，`server-time` 回包照常转给 worker；
- 判死策略两边一致：3 次漏拍 + 30 秒无入站，或 2 次漏拍 + 60 秒无入站（`keepalive-policy.ts`）。

### 3.3 会话快照

登录成功后 worker 把 `{gid, openId, clientVersion, heartbeatInterval, state}` 交给宿主，
`state` 是**不透明快照**（昵称 / 等级 / 金币 / 已解锁场景 / 服务器时间…），宿主只存不解析。
worker 每 30 秒把变化推一次（`session-state`）。

worker 热重启后 `attach` 拿回快照，直接回填 `userState` 并复用连接 —— **不需要 Code，也不会重发 PlayerLogin**。

### 3.4 推送缓存

worker 不在时收到的 Notify 进环形缓存（512 条 / 8MB / 120 秒），重新 attach 后按序补发并标记 `replay: true`；
超量或超时丢弃时先下发 `notify-gap`，业务层据此做一次全量校正。

## 4. 进程生命周期

- 宿主由主进程 `fork(detached: true)` 起来，**不随 worker 停止而退出**，也不随主进程退出而退出；
- 启动时在 `data/host-registry.json` 登记 `{账号: {pipe, token, pid, startedAt}}`；
- 主进程重启（热更新）后，`ensureHostProcess` 先查注册表：pid 还活着就**直接接管**这条管道与令牌，
  连接和会话都还在，账号不需要重新登录；
- 没人接管的宿主由看门狗回收：无 worker 且网关未连接立即退出，否则 15 分钟后退出；
- 用户主动停号时 worker 会先让宿主关闭网关连接，再断开管道，宿主随即退出。

## 5. 热更新边界

| 改动 | 需要重启宿主？ |
| --- | --- |
| 前端 / 接口 / 自动化逻辑 / 业务 proto / 配置 / 数据迁移 | 否（worker 重启即可） |
| 心跳间隔 / 重试策略 | 否（属于 worker 侧调度；宿主只在自己接管时用 `heartbeatInterval`） |
| 握手参数（URL 参数、UA、版本号） | 否（每次 `connect` 由 worker 传） |
| `GateMessage` 信封结构、`client_seq` 语义、心跳帧格式、TSDK/ACE 协议 | **是**（这类改动本来就会断线） |

## 6. 排查

```bash
# 宿主注册表
cat data/host-registry.json

# 宿主是否活着（pid 来自注册表）
ps -p <pid>          # Windows: Get-Process -Id <pid>

# 入站信封（临时开关，日志量很大）
FARM_SOCKET_HOST=1 FARM_HOST_DEBUG=1 node client.js
```

典型症状对照：

| 现象 | 原因 |
| --- | --- |
| 「心跳未响应」但业务请求正常 | 宿主用了自己的序号段发心跳（见 §3.1） |
| 「已复用宿主存活连接」后状态是空的 | worker 没推 `state` 快照（见 §3.3） |
| 主进程重启后账号重新登录 | 注册表丢失 / pid 判断失败 / 宿主已被看门狗回收 |
| `连接宿主不可用，回退到 worker 内直连` | 管道没起来（宿主崩溃或开关被关），会自动降级，不影响可用性 |
