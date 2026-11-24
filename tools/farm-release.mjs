#!/usr/bin/env node
/**
 * 面板在线更新 / 版本回滚的执行器。
 *
 * 由后端以 **脱离父进程** 的方式拉起（detached + unref），因此可以在执行过程中把后端本身
 * 杀掉再重启，而不会把自己一起干掉。这是整套在线更新能成立的前提。
 *
 * 之所以放在 `tools/` 下用纯 .mjs 而不是编进 `core/dist`：
 *   - 更新过程中 `core/dist` 会被整个覆盖，执行器不能依赖正在被替换的东西；
 *   - 回滚时源码会通过 `git reset --hard` 退到旧提交，执行器不能依赖「当前版本的编译产物」。
 *
 * 命令：
 *   node tools/farm-release.mjs update   [--backend-pid N]
 *   node tools/farm-release.mjs rollback --release <releaseId> [--backend-pid N]
 *   node tools/farm-release.mjs snapshot
 *
 * 进度写到 `FARM_UPDATE_JOB_FILE`（由后端传入），后端重启后仍然读得到。
 */

import { createRequire } from 'node:module';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SELF_PATH = fileURLToPath(import.meta.url);

/**
 * 仓库根：从自身位置往上找同时具备 `.git` 与 `version.json` 的目录。
 *
 * 不能简单写成 `HERE/..`——执行器平时跑在 `core/runtime/runner/` 的稳定副本里，
 * 往上两级是 `core/`，不是仓库根。
 */
function findRepoRoot(startDir) {
    const explicit = process.env.FARM_REPO_ROOT;
    if (explicit && fs.existsSync(explicit)) return path.resolve(explicit);

    let cursor = path.resolve(startDir);
    for (let depth = 0; depth < 6; depth += 1) {
        if (fs.existsSync(path.join(cursor, '.git')) && fs.existsSync(path.join(cursor, 'version.json'))) return cursor;
        const parent = path.dirname(cursor);
        if (parent === cursor) break;
        cursor = parent;
    }
    return path.resolve(startDir, '..');
}

const REPO_ROOT = findRepoRoot(HERE);

/** 布局实现：稳定目录里和自己并排放着一份，没有才回退到工作树源码。 */
function loadLayout() {
    const sibling = path.join(HERE, 'release-layout.js');
    if (fs.existsSync(sibling)) return require(sibling);
    return require(path.join(REPO_ROOT, 'core', 'src', 'services', 'release-layout.js'));
}

const layout = loadLayout();

const JOB_FILE = process.env.FARM_UPDATE_JOB_FILE || path.join(layout.resolveRuntimeDir(REPO_ROOT), 'update-job.json');
const MAX_RECENT_LINES = 40;
const COMMAND_TIMEOUT_MS = 10 * 60 * 1000;
const RELEASES_KEEP = Math.max(1, Number(process.env.FARM_RELEASES_KEEP) || 3);
const ADMIN_PORT = Number(process.env.ADMIN_PORT) || 3007;
/** 等新服务答话的上限。首启动要跑一遍宿主与账号初始化，给足 2 分钟。 */
const SERVICE_PROBE_TIMEOUT_MS = 120000;
const STABLE_MARK = 'FARM_RUNNER_STABLE';

// ==================== 自我保全 ====================

/**
 * 干活之前先把自己搬到不受 git 影响的位置。
 *
 * 回滚会 `git reset --hard` 到旧提交；如果那个提交里还没有 `tools/farm-release.mjs`
 * （例如回滚到本功能上线之前的版本），执行器会把自己从磁盘上删掉，剩下的启动步骤就没人做了。
 * 实测踩过：`git reset` 之后下一次调用直接 `Cannot find module ...tools/farm-release.mjs`。
 *
 * 所以先把执行器与 `release-layout.js` 复制到 `core/runtime/runner/`（已被 `.gitignore`
 * 忽略，`git reset` / `git pull` 都不碰），再从副本重跑一次，然后由副本完成全部工作。
 * 后端拉起时直接用的就是副本路径，这里会判定「已经在副本里」而不再重跑。
 */
async function ensureRunningFromStableCopy() {
    if (process.env[STABLE_MARK] === '1') return false;

    const stable = layout.installStableRunner(REPO_ROOT);
    if (!stable.installed || !fs.existsSync(stable.runnerPath)) return false;
    if (path.resolve(stable.runnerPath) === path.resolve(SELF_PATH)) return false;

    console.log(`[自举] 改用稳定副本执行：${path.relative(REPO_ROOT, stable.runnerPath)}`);
    const child = spawn(process.execPath, [stable.runnerPath, ...process.argv.slice(2)], {
        cwd: REPO_ROOT,
        env: { ...process.env, [STABLE_MARK]: '1', FARM_REPO_ROOT: REPO_ROOT },
        stdio: 'inherit',
        windowsHide: true,
    });
    const code = await new Promise((resolve) => {
        child.once('error', () => resolve(1));
        child.once('close', (exitCode) => resolve(exitCode === null ? 1 : exitCode));
    });
    process.exit(code);
}

await ensureRunningFromStableCopy();

// ==================== 作业状态 ====================

function readJob() {
    return layout.readJsonSafe(JOB_FILE, null) || {
        id: `manual_${Date.now()}`,
        action: 'update',
        status: 'running',
        phase: '准备中',
        startedAt: Date.now(),
        updatedAt: Date.now(),
        recentLines: [],
    };
}

function writeJob(job) {
    job.updatedAt = Date.now();
    job.recentLines = (job.recentLines || []).slice(-MAX_RECENT_LINES);
    layout.writeJsonAtomic(JOB_FILE, job);
}

const currentJob = readJob();

function logLine(line) {
    const text = String(line ?? '');
    if (!text) return;
    for (const part of text.split('\n')) {
        const trimmed = part.trimEnd();
        if (!trimmed) continue;
        console.log(trimmed);
        currentJob.recentLines = [...(currentJob.recentLines || []), trimmed].slice(-MAX_RECENT_LINES);
    }
    writeJob(currentJob);
}

function setPhase(phase, detail) {
    currentJob.phase = phase;
    if (detail !== undefined) currentJob.detail = String(detail);
    logLine(`[阶段] ${phase}${detail ? ` — ${detail}` : ''}`);
}

function failJob(message) {
    currentJob.status = 'failed';
    currentJob.error = String(message || '执行失败');
    currentJob.finishedAt = Date.now();
    setPhase('执行失败', currentJob.error);
    writeJob(currentJob);
}

function succeedJob(detail) {
    currentJob.status = 'succeeded';
    currentJob.finishedAt = Date.now();
    setPhase('已完成', detail || '');
    writeJob(currentJob);
}

// 无论怎么退出都要把结果落盘，否则面板会一直显示「进行中」。
process.on('uncaughtException', (err) => {
    failJob(err?.stack || err?.message || String(err));
    process.exit(1);
});
process.on('unhandledRejection', (err) => {
    failJob(err?.stack || err?.message || String(err));
    process.exit(1);
});

// ==================== 子进程 ====================

function runCommand(command, args, options = {}) {
    const timeoutMs = options.timeoutMs || COMMAND_TIMEOUT_MS;
    return new Promise((resolve) => {
        let child;
        try {
            child = spawn(command, args, {
                cwd: options.cwd || REPO_ROOT,
                env: { ...process.env, ...(options.env || {}) },
                stdio: ['ignore', 'pipe', 'pipe'],
                windowsHide: true,
            });
        }
        catch (err) {
            resolve({ code: -1, output: String(err?.message || err) });
            return;
        }

        let buffer = '';
        const collect = (chunk) => {
            buffer += chunk.toString();
            const lines = buffer.split('\n');
            buffer = lines.pop() ?? '';
            for (const line of lines) {
                if (line.trim()) logLine(line);
            }
        };
        child.stdout?.on('data', collect);
        child.stderr?.on('data', collect);

        const timer = setTimeout(() => {
            logLine(`[超时] 命令超过 ${Math.round(timeoutMs / 1000)} 秒未结束，已终止：${command} ${args.join(' ')}`);
            try {
                child.kill('SIGKILL');
            }
            catch {
                // 已退出则忽略。
            }
        }, timeoutMs);

        child.once('error', (err) => {
            clearTimeout(timer);
            resolve({ code: -1, output: `${buffer}\n${err?.message || err}`.trim() });
        });
        child.once('close', (code) => {
            clearTimeout(timer);
            if (buffer.trim()) logLine(buffer);
            resolve({ code: code === null ? -1 : code, output: buffer });
        });
    });
}

function git(args, options = {}) {
    return runCommand('git', args, options);
}

/** 同步版 git，只用在「走哪条分支」的判断上，取一小段文本。 */
function gitSync(args) {
    try {
        return execFileSync('git', args, {
            cwd: REPO_ROOT,
            encoding: 'utf8',
            timeout: 20000,
            windowsHide: true,
        });
    }
    catch {
        return '';
    }
}

/** 探测到的 shell，检测一次就缓存：`isAlive` 是同步函数，没有 await 的机会。 */
let cachedShell = '';

async function detectShell() {
    if (cachedShell) return cachedShell;
    const probeCmd = process.platform === 'win32' ? 'where' : 'which';
    const candidates = process.platform === 'win32' ? ['bash.exe', 'bash'] : ['bash', 'sh'];
    for (const candidate of candidates) {
        const probe = await runCommand(probeCmd, [candidate], { timeoutMs: 15000 });
        if (probe.code === 0) {
            cachedShell = candidate;
            return candidate;
        }
    }
    return '';
}

/**
 * 交给 shell 再判一次存活。
 *
 * Windows 上 `start.sh` 用 `nohup setsid node … &` 启动，写进 `app_dev.pid` 的是 **MSYS pid**：
 * `process.kill(msysPid, 0)` 会抛 ESRCH，而 `bash -c 'kill -0 msysPid'` 是通的。只信
 * `process.kill` 会把活得好好的服务判成「没起来」，进而触发一次多余的回滚。
 */
function shellAlive(pid) {
    const shell = cachedShell || (process.platform === 'win32' ? 'bash' : 'sh');
    try {
        execFileSync(shell, ['-c', `kill -0 ${Number(pid)} 2>/dev/null`], {
            stdio: 'ignore',
            timeout: 8000,
            windowsHide: true,
        });
        return true;
    }
    catch {
        return false;
    }
}

function isAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (err) {
        if (err?.code === 'EPERM') return true;
    }
    // 两个命名空间都要问：本机 pid 查不到，不代表 MSYS pid 查不到。
    return shellAlive(pid);
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 优雅停掉后端。
 *
 * 两条路径，优先走第一条：
 *   1. `app_dev.pid` 里有一个活着的进程 → 用项目自带的 `stop.sh`。它会按**进程组**整组结束，
 *      把 client.js fork 出来的宿主子进程一起带走。只杀父进程会留下一堆孤儿宿主进程占着
 *      会话 socket，重启后新旧宿主打架，比不重启更糟。
 *   2. pid 文件不存在（手动 `node client.js` 起的）→ 直接结束；POSIX 上再补一刀进程组。
 */
async function stopBackend(targetPid, shell) {
    const pidFile = path.join(REPO_ROOT, 'app_dev.pid');
    let recorded = 0;
    try {
        recorded = Number(fs.readFileSync(pidFile, 'utf8').trim()) || 0;
    }
    catch {
        recorded = 0;
    }

    // 调用方没给 pid（例如上一次启动半途失败），但 pid 文件里有一个活着的进程：
    // 那个进程同样占着端口，必须一并收掉，否则新进程会 EADDRINUSE。
    let pid = targetPid;
    if (!isAlive(pid) && isAlive(recorded)) {
        logLine(`[停止] 未拿到目标 PID，改用 pid 文件里的 ${recorded}`);
        pid = recorded;
    }

    if (!isAlive(pid)) {
        logLine(`[停止] 后端进程 ${pid} 已不在运行`);
        return true;
    }
    setPhase('正在停止旧服务', `PID ${pid}`);

    // 只要 pid 文件里有一个活着的服务，就走 stop.sh：它按**进程组**整组结束，把 client.js
    // fork 出来的宿主子进程一起带走。只杀父进程会留下孤儿宿主占着会话 socket，重启后新旧
    // 宿主打架，比不重启更糟。也不要卡 `recorded === pid`——Windows 上拿到的是 MSYS pid，
    // 和 pid 文件里的值未必一致，卡这个条件会静默退化成「只杀父进程」。
    if (shell && isAlive(recorded) && fs.existsSync(path.join(REPO_ROOT, 'stop.sh'))) {
        logLine('[停止] 使用 stop.sh 整套停止（含 fork 出来的宿主子进程）');
        const result = await runCommand(shell, ['stop.sh'], { timeoutMs: 120000 });
        if (result.code === 0 && !isAlive(pid) && !isAlive(recorded)) return true;
        logLine('[停止] stop.sh 未能确认退出，回退到直接结束进程');
    }

    const sendSignal = (signal, group) => {
        try {
            process.kill(group && process.platform !== 'win32' ? -pid : pid, signal);
        }
        catch {
            // 进程组不存在（没有 setsid）或已退出，交给下一轮判定。
        }
    };

    sendSignal('SIGTERM', true);
    if (process.platform === 'win32') sendSignal('SIGTERM', false);

    for (let i = 0; i < 60; i += 1) {
        if (!isAlive(pid)) {
            logLine(`[停止] 后端进程 ${pid} 已退出`);
            return true;
        }
        await sleep(500);
    }

    logLine(`[停止] 后端进程 ${pid} 30 秒未退出，强制结束`);
    sendSignal('SIGKILL', true);
    if (process.platform === 'win32') sendSignal('SIGKILL', false);
    await sleep(500);
    return !isAlive(pid);
}

function readVersionJson() {
    const raw = layout.readJsonSafe(path.join(REPO_ROOT, 'version.json'), {}) || {};
    return {
        version: typeof raw.version === 'string' ? raw.version : '',
        build: Number(raw.build) || 0,
    };
}

function readCommitInfo() {
    const commit = gitSync(['rev-parse', 'HEAD']).trim();
    return {
        commit,
        shortCommit: commit ? commit.slice(0, 7) : '',
        commitSubject: gitSync(['log', '-1', '--format=%s']).trim(),
    };
}

// ==================== 版本归档 ====================

const releasesDir = () => layout.resolveReleasesDir(REPO_ROOT);
const runtimeDir = () => layout.resolveRuntimeDir(REPO_ROOT);

/**
 * 归档当前产物。
 *
 * 如果 active 里已经有一个提交号相同的后端版本，直接复用，避免每次更新都把同一份产物再拷一遍。
 */
function snapshotCurrent(reason) {
    const info = readCommitInfo();
    if (!info.commit) return { backendId: null, webId: null };

    const state = layout.readActiveState(runtimeDir());
    const activeId = state.backend.active;
    if (activeId) {
        const activeDir = path.join(releasesDir(), activeId);
        const meta = layout.readReleaseMeta(activeDir);
        if (meta && meta.commit === info.commit && layout.parseReleaseId(activeId)) {
            logLine(`[归档] 当前版本已归档为 ${activeId}（${reason}），跳过重复归档`);
            return { backendId: activeId, webId: state.web.active || null };
        }
    }

    if (!fs.existsSync(path.join(REPO_ROOT, 'core', 'dist'))) {
        logLine('[归档] 当前没有构建产物，跳过');
        return { backendId: null, webId: null };
    }

    const ver = readVersionJson();
    const shared = {
        repoRoot: REPO_ROOT,
        commit: info.commit,
        shortCommit: info.shortCommit,
        commitSubject: info.commitSubject,
        version: ver.version,
        build: ver.build,
        // 一次构建产出的后端与前端归档必须共用同一个时间戳：配对、回滚找配套前端
        // 全靠这个后缀，各取各的时钟会出现「后端有配套、前端找不到」。
        stamp: layout.formatStamp(new Date()),
    };

    const backend = layout.snapshotRelease({ ...shared, kind: 'backend' });
    logLine(`[归档] 后端产物已归档为 ${backend.releaseId}`);

    let webId = null;
    if (fs.existsSync(path.join(REPO_ROOT, 'web', 'dist'))) {
        const web = layout.snapshotRelease({ ...shared, kind: 'web' });
        webId = web.releaseId;
        logLine(`[归档] 前端产物已归档为 ${web.releaseId}`);
    }
    return { backendId: backend.releaseId, webId };
}

function activatePair(ids, previous) {
    const state = layout.readActiveState(runtimeDir());
    const nextSlot = (slot, id) => {
        if (!id) return slot;
        const prev = previous && previous[slot === state.backend ? 'backendId' : 'webId'];
        return {
            active: id,
            previous: prev && prev !== id ? prev : slot.previous,
            history: [id, ...slot.history.filter((item) => item !== id)].slice(0, 20),
        };
    };
    const backendSlot = nextSlot(state.backend, ids.backendId);
    const webSlot = nextSlot(state.web, ids.webId);
    layout.writeActiveState(runtimeDir(), { backend: backendSlot, web: webSlot });
}

function pruneTo(keep) {
    try {
        const removed = layout.pruneReleases({
            releasesDir: releasesDir(),
            keep,
            active: layout.readActiveState(runtimeDir()),
        });
        if (removed.length) logLine(`[清理] 已删除旧版本：${removed.join('、')}`);
    }
    catch (err) {
        logLine(`[清理] 旧版本清理失败（不影响更新）：${err?.message || err}`);
    }
}

/**
 * 找出与后端归档配套的前端归档。
 *
 * 优先按同一时间戳精确匹配（同一次构建生成的一对）；时间戳对不上时退回按提交号找——
 * 历史归档里可能有「同一提交、不同时间」拍摄的两份，那也是同一份代码，可以配。
 */
function findPairedWebRelease(backendReleaseId, commit) {
    const exact = `web-${String(backendReleaseId).replace(/^backend-/, '')}`;
    if (fs.existsSync(path.join(releasesDir(), exact))) return exact;
    if (!commit) return '';
    const candidates = layout.listReleaseDirs(releasesDir())
        .filter((item) => item.kind === 'web')
        .map((item) => ({ id: item.releaseId, meta: layout.readReleaseMeta(item.dir) }))
        .filter((item) => item.meta && item.meta.commit === commit);
    return candidates.length ? candidates[0].id : '';
}

// ==================== 重启 ====================

/**
 * 服务能不能答话。
 *
 * 这才是「重启成功」的判据——pid 活着只说明进程没崩，端口可能还没监听、宿主可能正在退出。
 * `/api/game-version` 不需要鉴权，且返回里带 `botVersion`（注意字段在顶层，不在 `data` 里）。
 */
async function probeService() {
    try {
        const response = await fetch(`http://127.0.0.1:${ADMIN_PORT}/api/game-version`, {
            signal: AbortSignal.timeout(5000),
        });
        if (!response.ok) return null;
        const body = await response.json();
        if (!body || body.ok === false) return null;
        return {
            clientVersion: String(body.clientVersion || ''),
            botVersion: String(body.botVersion || ''),
        };
    }
    catch {
        // 连不上就是还没起来，由调用方决定等多久。
        return null;
    }
}

async function waitForService(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const probe = await probeService();
        if (probe) return probe;
        if (Date.now() >= deadline) return null;
        await sleep(1000);
    }
}

async function restartService(backendPid) {
    const shell = await detectShell();
    if (!shell) {
        throw new Error('找不到 bash，无法执行 start.sh。请手动运行 bash ./start.sh');
    }
    await stopBackend(backendPid, shell);
    setPhase('正在启动新服务');
    const result = await runCommand(shell, ['start.sh'], { cwd: REPO_ROOT });
    if (result.code !== 0) {
        throw new Error(`start.sh 执行失败（退出码 ${result.code}），详见日志。`);
    }

    let newPid = 0;
    try {
        newPid = Number(fs.readFileSync(path.join(REPO_ROOT, 'app_dev.pid'), 'utf8').trim()) || 0;
    }
    catch {
        newPid = 0;
    }

    setPhase('等待服务就绪', `探测 127.0.0.1:${ADMIN_PORT}/api/game-version`);
    const probe = await waitForService(SERVICE_PROBE_TIMEOUT_MS);
    if (!probe) {
        const aliveNote = newPid && isAlive(newPid)
            ? `进程 ${newPid} 还在，但接口 ${Math.round(SERVICE_PROBE_TIMEOUT_MS / 1000)} 秒内没有响应`
            : `进程 ${newPid || '未知'} 已退出`;
        throw new Error(`新服务没有就绪：${aliveNote}，请查看 app_dev.log。`);
    }
    logLine(`[启动] 新服务已就绪，PID ${newPid || '未知'}，运行版本 ${probe.botVersion || '未知'}`);
    return newPid;
}

// ==================== 更新 / 回滚 ====================

function parseArgs(argv) {
    const args = { _: [] };
    for (let i = 0; i < argv.length; i += 1) {
        const token = argv[i];
        if (!token.startsWith('--')) {
            args._.push(token);
            continue;
        }
        const key = token.slice(2);
        const next = argv[i + 1];
        if (next && !next.startsWith('--')) {
            args[key] = next;
            i += 1;
        }
        else {
            args[key] = true;
        }
    }
    return args;
}

const DEPENDENCY_FILES = [
    'package.json',
    'pnpm-workspace.yaml',
    'pnpm-lock.yaml',
    'core/package.json',
    'web/package.json',
];

function dependencyFilesChanged(fromCommit, toCommit) {
    if (!fromCommit || !toCommit || fromCommit === toCommit) return false;
    const diff = gitSync(['diff', '--name-only', fromCommit, toCommit, '--', ...DEPENDENCY_FILES]);
    const changed = new Set(String(diff || '').split('\n').map((line) => line.trim()).filter(Boolean));
    return DEPENDENCY_FILES.some((file) => changed.has(file));
}

async function installDependencies() {
    setPhase('安装依赖', '依赖清单有变化');
    const viaPnpm = await runCommand('pnpm', ['install', '--frozen-lockfile']);
    if (viaPnpm.code === 0) return true;
    logLine('[依赖] pnpm 直接调用失败，尝试 corepack pnpm');
    const viaCorepack = await runCommand('corepack', ['pnpm', 'install', '--frozen-lockfile']);
    if (viaCorepack.code === 0) return true;
    logLine('[警告] 依赖安装失败，继续尝试构建（多数情况下仍能成功）');
    return false;
}

/** 重启失败时把服务和源码都退回来，避免留下「更新失败 + 服务已停」的死局。 */
async function recoverTo(ids, commit, reason) {
    if (!ids.backendId || !commit) return false;
    setPhase('正在自动回滚', `恢复到 ${ids.backendId}`);
    const reset = await git(['reset', '--hard', commit]);
    if (reset.code !== 0) logLine('[回滚] git reset 失败，需要手动处理');
    try {
        layout.restoreRelease({ repoRoot: REPO_ROOT, releaseId: ids.backendId });
        if (ids.webId && fs.existsSync(path.join(releasesDir(), ids.webId))) {
            layout.restoreRelease({ repoRoot: REPO_ROOT, releaseId: ids.webId });
        }
        activatePair(ids, {});
        await restartService(0);
        failJob(`${reason}；已自动回滚到 ${ids.backendId}`);
        return true;
    }
    catch (err) {
        failJob(`${reason}；自动回滚也失败了：${err?.message || err}。请手动执行 bash ./start.sh 并检查日志。`);
        return false;
    }
}

async function doUpdate(args) {
    const backendPid = Number(args['backend-pid']) || 0;
    const oldCommit = gitSync(['rev-parse', 'HEAD']).trim();
    if (oldCommit) currentJob.fromCommit = oldCommit.slice(0, 7);

    setPhase('归档当前版本', '回滚就靠这一步');
    const previous = snapshotCurrent('更新前备份');

    setPhase('拉取代码');
    const pull = await git(['pull', '--ff-only']);
    if (pull.code !== 0) {
        failJob('git pull 失败，代码未变更，服务保持运行。');
        return false;
    }
    const newCommit = gitSync(['rev-parse', 'HEAD']).trim();
    if (newCommit) currentJob.targetCommit = newCommit.slice(0, 7);
    if (oldCommit && newCommit && oldCommit === newCommit) {
        logLine('[拉取] 没有新的远端提交，继续重建并重启');
    }

    if (dependencyFilesChanged(oldCommit, newCommit)) {
        await installDependencies();
    }
    else {
        logLine('[依赖] 依赖清单未变化，跳过安装');
    }

    setPhase('重启并构建', 'start.sh 会按需重建前后端');
    try {
        await restartService(backendPid);
    }
    catch (err) {
        logLine(`[失败] ${err?.message || err}`);
        if (!(await recoverTo(previous, oldCommit, `更新失败：${err?.message || err}`))) {
            failJob(`更新失败：${err?.message || err}`);
        }
        return false;
    }

    setPhase('归档新版本');
    const current = snapshotCurrent('更新后归档');
    activatePair(current, previous);
    pruneTo(RELEASES_KEEP);
    succeedJob(`已更新到 ${(newCommit || '').slice(0, 7)}`);
    return true;
}

async function doRollback(args) {
    const backendPid = Number(args['backend-pid']) || 0;
    const releaseId = String(args.release || '').trim();
    if (!releaseId) {
        failJob('缺少 --release 参数');
        return false;
    }
    const parsed = layout.parseReleaseId(releaseId);
    if (!parsed || parsed.kind !== 'backend') {
        failJob(`无效的后端版本目录：${releaseId}`);
        return false;
    }
    const meta = layout.readReleaseMeta(path.join(releasesDir(), releaseId));
    if (!meta || !meta.commit) {
        failJob(`版本 ${releaseId} 缺少提交信息，无法对齐源码`);
        return false;
    }
    const targetCommit = String(meta.commit);
    currentJob.releaseId = releaseId;
    currentJob.targetCommit = targetCommit.slice(0, 7);

    setPhase('归档当前版本', '保证回滚本身可逆');
    const current = snapshotCurrent('回滚前备份');
    const oldCommit = gitSync(['rev-parse', 'HEAD']).trim();
    if (oldCommit) currentJob.fromCommit = oldCommit.slice(0, 7);

    setPhase('对齐源码', `git reset --hard ${targetCommit.slice(0, 7)}`);
    const reset = await git(['reset', '--hard', targetCommit]);
    if (reset.code !== 0) {
        failJob('git reset 失败，源码未变更，服务保持运行。');
        return false;
    }

    setPhase('恢复构建产物', releaseId);
    try {
        layout.restoreRelease({ repoRoot: REPO_ROOT, releaseId });
        const webId = findPairedWebRelease(releaseId, meta.commit);
        if (webId) {
            layout.restoreRelease({ repoRoot: REPO_ROOT, releaseId: webId });
            logLine(`[恢复] 前端产物同步恢复为 ${webId}`);
        }
        else {
            logLine('[恢复] 没找到配套的前端产物，前端将由 start.sh 重新构建');
        }
    }
    catch (err) {
        failJob(`恢复产物失败：${err?.message || err}`);
        return false;
    }

    setPhase('重启服务');
    try {
        await restartService(backendPid);
    }
    catch (err) {
        logLine(`[失败] ${err?.message || err}`);
        const restored = await recoverTo(current, oldCommit, `回滚失败：${err?.message || err}`);
        if (!restored) {
            failJob(`回滚失败：${err?.message || err}`);
        }
        return false;
    }

    activatePair(
        { backendId: releaseId, webId: findPairedWebRelease(releaseId, meta.commit) },
        current,
    );
    succeedJob(`已回滚到 ${releaseId}`);
    return true;
}

async function doSnapshot() {
    setPhase('归档当前版本');
    const ids = snapshotCurrent('手动归档');
    if (!ids.backendId) {
        failJob('没有可归档的构建产物');
        return false;
    }
    activatePair(ids, {});
    succeedJob(`已归档 ${ids.backendId}`);
    return true;
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const command = args._[0] || 'update';

    // 上一轮的失败原因会留在作业文件里。不清掉的话这一轮成功之后，面板上会同时显示
    // 「已完成」和上一轮的 error，看起来像「成功了但又报错」。
    if (currentJob.status !== 'running') {
        currentJob.status = 'running';
        currentJob.error = undefined;
        currentJob.finishedAt = undefined;
        currentJob.startedAt = Date.now();
        currentJob.recentLines = [];
    }
    currentJob.pid = process.pid;
    currentJob.action = command === 'rollback' || command === 'snapshot' ? command : 'update';
    writeJob(currentJob);

    logLine(`[启动] 执行器开始工作：${command}（PID ${process.pid}）`);
    logLine(`[执行器] 位置 ${path.relative(REPO_ROOT, SELF_PATH) || SELF_PATH}`);

    let ok = false;
    if (command === 'rollback') ok = await doRollback(args);
    else if (command === 'snapshot') ok = await doSnapshot();
    else ok = await doUpdate(args);
    process.exit(ok ? 0 : 1);
}

main().catch((err) => {
    failJob(err?.stack || err?.message || String(err));
    process.exit(1);
});
