# 面板在线更新与版本回滚

设置页 → 「版本与更新」里可以在浏览器里完成三件事：检查远端有没有新提交、一键拉取并重建重启、回退到任意一次历史构建。本文说明它怎么工作、边界在哪、出问题怎么救。

## 1. 为什么不是上游那套

上游 `liyangpengs/qq-farm-bot` 的 PR #181 / #182 也做了这件事，但它的实现绑在**会话宿主架构**上：`packages/session-contract` 提供 IPC 协议与进程锁，`tools/service-control.mjs` 负责启停托管，游戏会话跑在独立进程里，所以「后端重启但玩家不掉线」成立。

本项目已经有自己的连接宿主（见 [socket-host.md](socket-host.md)），启动链是 `start.sh` → `node core/client.js`，用 `version.json` + git hooks 管版本。把上游整套搬进来等于换掉部署方式，收益（热重启不掉线）和风险（两套宿主抢 WS 会话）不成比例。

所以这里只提取「更新与回滚」这件事本身，**不引入任何新的进程架构**：

```
面板点击 → 后端 spawn(detached) → tools/farm-release.mjs → git pull → start.sh 重建重启
                                      ↑
                            它必须活得比后端久
```

## 2. 参与的四样东西

| 组件 | 位置 | 职责 |
| --- | --- | --- |
| `release-layout.js` | `core/src/services/` | 纯 CommonJS 零依赖。归档目录命名、快照、恢复、清理、激活状态。后端与执行器**共用这一份** |
| `release-store.ts` | `core/src/services/` | 只读查询层：后端/前端配对、与当前客户端版本的兼容性、总览统计 |
| `system-update.ts` | `core/src/services/` | 环境探测、git 检查/拉取、作业状态机、把执行器拉起来、回滚前置校验 |
| `farm-release.mjs` | `tools/` | 真正干活的执行器。`update` / `rollback` / `snapshot` 三个命令 |

执行器必须是独立 `.mjs`，不能编进 `core/dist`：更新时 `core/dist` 正在被整个覆盖；回滚时源码还会 `git reset` 回旧提交。它不能依赖任何正在被替换的东西。

## 3. 目录布局

```
<repo>/releases/
  backend-20261124044746-e686e1d/{release-meta.json, client.js, dist/}
  web-20261124044746-e686e1d/{release-meta.json, dist/}
<repo>/core/runtime/
  active-releases.json   # { backend: {active, previous, history}, web: {...} }
  update-job.json        # 作业状态（面板轮询读它）
  update-job.log         # 执行器完整日志
  update.lock            # 发布互斥（当前未使用，保留给外部脚本）
```

- 目录名 = `<kind>-<UTC 时间戳>-<短提交>`。**同一次构建的后端与前端共用同一个时间戳**，配对就靠这个后缀；跨秒拍摄的历史归档按提交号兜底配对。
- 两个目录都写进了 `.gitignore`。不忽略的话「工作区必须干净」这条前置检查永远过不去。
- `release-meta.json` 自带版本号、提交号与体积。回滚**只读它，不执行快照里的代码**。
- 默认保留最近 3 份（`FARM_RELEASES_KEEP`），运行中与上一版永不自动清理。一份约 47 MB（后端 6 MB + 前端 41 MB）。

## 4. 更新流程

1. 归档当前产物（回滚点）
2. `git pull --ff-only`
3. 依赖清单（`package.json` / `pnpm-lock.yaml` / `pnpm-workspace.yaml`）有变化才 `pnpm install --frozen-lockfile`
4. 停服 → `bash start.sh`（它自己按 mtime 判断要重建前端还是后端，装完就拉起新进程）
5. 归档新产物，更新 `active-releases.json`，清理超出保留份数的旧版本

失败时**自动回滚**：`git reset --hard` 回原提交 → 恢复旧产物 → 再次 `start.sh`，然后把失败原因写进作业状态。

> 宁可「更新没成功但服务还在」，不要「更新没成功且服务已停」。后者在无人的 NAS 上就是彻底停摆。

## 5. 回滚流程

1. 归档当前产物（保证回滚本身可逆）
2. `git reset --hard <归档记录的提交>`
3. 把归档产物覆盖回 `core/dist`、`core/client.js`、`web/dist`（配套前端一起）
4. 停服 → `bash start.sh`

不重新构建，几十秒完成。注意 `version.json` 会跟着 `git reset` 一起退回——**版本号会短暂回退，下次更新会重新升上去**，这是刻意的：让源码树保持干净比让版本号单调更重要。

前置拒绝条件（任何一条都会明确报错而不是硬来）：

- 工作区有未提交改动 → `DIRTY_WORKTREE`
- 当前分支有**未推送**的本地提交 → `AHEAD_OF_UPSTREAM`（回滚会丢掉它们）
- 目标提交已不在本地仓库 → `COMMIT_MISSING`（先 fetch）
- 选了当前正在运行的版本 / 归档不完整 → `RELEASE_NOT_ROLLBACKABLE`
- 目标不是后端归档 → `WRONG_RELEASE_KIND`（前端必须跟随配套后端）
- 与当前客户端版本不兼容 → `RELEASE_INCOMPATIBLE`，面板二次确认后可继续

## 6. 停服为什么要按进程组

后端会 `fork` 出连接宿主子进程（`core/src/host/`）。只对父进程发 `SIGTERM` 会留下一堆孤儿宿主占着会话 socket，重启后新旧宿主互相打架，比不重启更糟。

所以执行器的顺序是：

1. `app_dev.pid` 记的就是当前后端 → 跑 `bash stop.sh`（它按进程组整组结束，30 秒不退就 `SIGKILL`）
2. 没有 pid 文件（手动 `node client.js` 起的）→ 直接结束，POSIX 上再补一刀 `-pid` 进程组

## 7. 面板怎么知道「更新完成了」

服务在更新过程中会自己死掉几秒到几分钟，接口必然打不通。所以：

- 轮询期间网络错误只标记 `reconnecting`，**不写错误态**——否则那几分钟满屏红字
- 总时限 12 分钟，超过就报「等待结果超时，请刷新查看当前版本」
- 服务回来后读 `core/runtime/update-job.json`，`status` 不是 `running` 即结束
- 状态写着 `running` 但 pid 已死（被 `kill -9` 或机器重启）→ 判定失败并落盘，避免永远转圈

前端构建新增 `web/dist/version.json`：

```json
{ "buildId": "3.35.8-238-1795496178724", "appVersion": "3.35.8", "appBuild": 238, "builtAt": 1795496178724 }
```

`buildId` 同时被烘焙进 bundle（`__APP_BUILD_ID__`）。后端报告当前服务器上的 `buildId`，前端一比就知道标签页里是不是旧 bundle，是就提示刷新。入口 `index.html` 设了 `no-store`，保证刷新能立刻拿到引用新 bundle 的 HTML。

## 8. 支持范围与限制

| 运行形态 | 检查更新 | 一键更新 / 回滚 |
| --- | --- | --- |
| 源码 + git + `start.sh` 启动 | ✅ | ✅ |
| 源码 + git，手动 `node client.js` 启动 | ✅ | ⚠️ 能跑，但停服退回直接杀进程，宿主子进程可能残留 |
| Docker 容器 | ✅ | ❌ 容器内重启自身等于打死容器，请拉取后重建镜像 |
| 单文件打包（pkg） | ❌ | ❌ |

其他限制：

- 只支持 `--ff-only` 拉取。本地分叉过就先手动处理。
- 更新会重启服务，**游戏连接会断**。免扫码续期能不能接上取决于授权还有效；`code` 已失效的账号需要重新扫码。
- 重启由 `start.sh` 负责，所以**不要用 systemd / pm2 之类的外部守护**同时管这个进程，否则杀掉后会和外部的自动重启打架。
- 归档不包含 `core/src`：源码交给 git，产物交给归档，两边各管一摊。

## 9. 排障

| 现象 | 先看哪里 |
| --- | --- |
| 点「立即更新」没反应 | `core/runtime/update-job.json` 的 `error`；`update-job.log` 末尾 |
| 一直显示「服务正在重启」 | `app_dev.log` 是否在增长；端口 3007 是否被别的进程占了 |
| 更新后登录状态全丢 | 预期行为，重启会断连接；看账号授权是否还能自动续期 |
| 更新成功但界面没变 | 面板应提示「面板已更新，点此刷新」；强制 `Ctrl+F5` |
| 回滚报「有未推送的本地提交」 | `git log @{u}..HEAD`，推上去或 `git reset --hard @{u}` 再来 |
| 归档占用太大 | 面板里删单个版本，或调小 `FARM_RELEASES_KEEP`，或点「清理孤儿」 |

手工排查命令：

```bash
# 当前归档与激活状态
cat core/runtime/active-releases.json

# 上一次作业结果
cat core/runtime/update-job.json

# 强制给当前版本拍一张快照（不重启、不更新）
node tools/farm-release.mjs snapshot
```
