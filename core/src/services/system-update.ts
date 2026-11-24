import type { ReleasesSummary, RollbackReleaseItem } from './release-store';
export {};

/**
 * 面板在线更新与版本回滚。
 *
 * 设计要点（和上游 liyang 版最大的不同）：这里**不引入会话宿主架构**。上游把游戏会话搬到
 * 独立进程，再用 `tools/service-control.mjs` 托管启停；本仓库的启动方式是 `start.sh` +
 * `node core/client.js`，直接搬过来会把启动链整个换掉。所以这里改成：
 *
 *   1. 「更新」= git 拉取 + 重新安装依赖 + 重新构建 + 归档旧产物 + 重启；
 *   2. 「回滚」= git 回到归档记录的提交 + 把归档产物覆盖回去 + 重启（不重新构建）；
 *   3. 真正的执行动作放在 `tools/farm-release.mjs` 里，由后端以 **脱离父进程** 的方式拉起。
 *      必须脱离，因为执行到一半要杀掉后端自己——如果执行器和后端同生共死，更新永远只做一半。
 *
 * 所有跨进程状态都落盘在 `core/runtime/`：作业状态、日志、互斥锁。后端重启后接着读，
 * 面板刷新也能看到上一次更新的结果。
 */

const { execFile, spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const layout = require('./release-layout');
const releaseStore = require('./release-store');
const webBuildInfo = require('./web-build-info');

export interface IncomingCommitInfo {
    hash: string;
    shortHash: string;
    subject: string;
    author: string;
    timestampMs: number;
}

export interface PanelUpdateJobState {
    id: string;
    action: 'update' | 'rollback' | 'snapshot';
    pid?: number;
    status: 'running' | 'succeeded' | 'failed';
    phase: string;
    detail?: string;
    startedAt: number;
    updatedAt: number;
    finishedAt?: number;
    exitCode?: number | null;
    error?: string;
    fromCommit?: string;
    targetCommit?: string;
    releaseId?: string;
    recentLines: string[];
}

/**
 * 远端版本信息：**不依赖 git** 的检查通道。
 *
 * 容器里既没有 `.git` 也没有 git 命令，`git fetch` 那条路彻底走不通，但「有没有新版本」
 * 这件事仍然可以回答——直接读远端仓库的 `version.json` 比版本号即可。这样 NAS 用户
 * 在面板上至少能看到「远端已经是 v3.36.3」，再去宿主机重建镜像，而不是对着一句
 * 「没有找到 git 仓库（/app）」猜。
 */
export interface RemoteVersionInfo {
    /** 远端仓库坐标 owner/repo，仅用于展示与诊断。 */
    repo: string;
    branch: string;
    version: string;
    build: number;
    summary: string;
    commit: string;
    /** 远端 version.json 的 updatedAt（ISO 字符串原样透传）。 */
    updatedAt: string;
}

export interface SystemUpdateStatus {
    mode: 'source' | 'docker' | 'packaged' | 'unknown';
    gitSupported: boolean;
    unsupportedReason: string;
    applySupported: boolean;
    applyUnsupportedReason: string;
    repoRoot: string;
    branch: string;
    detached: boolean;
    commit: string;
    shortCommit: string;
    commitSubject: string;
    startupCommit: string;
    needsApply: boolean;
    upstream: string;
    remote: string;
    remoteBranch: string;
    behindCount: number;
    aheadCount: number;
    dirtyFiles: string[];
    incomingCommits: IncomingCommitInfo[];
    canCheck: boolean;
    canPull: boolean;
    canApply: boolean;
    jobBusy: boolean;
    lastCheckedAt: number | null;
    lastCheckError: string;
    lastPulledAt: number | null;
    job: PanelUpdateJobState | null;
    releases: RollbackReleaseItem[];
    releasesSummary: ReleasesSummary;
    webBuildId: string;
    webVersion: string;

    /** 本地版本（读仓库根的 version.json，容器里同样存在）。 */
    localVersion: string;
    localBuild: number;
    /** 远端版本；未查过时为 null。 */
    remoteVersion: RemoteVersionInfo | null;
    /** 远端版本与本地不一致（按 build 号比较，build 相同再比版本号字符串）。 */
    hasNewVersion: boolean;
    remoteCheckedAt: number | null;
    remoteCheckError: string;
    /** 容器部署时给用户在宿主机执行的命令，前端直接展示成可复制文本。 */
    deployCommand: string;
}

export interface SystemUpdateServiceOptions {
    repoRoot?: string | null;
    runtimeDir?: string;
    releasesDir?: string;
    isPackaged?: boolean;
    spawnRunner?: typeof spawn;
    execGit?: (cwd: string, args: string[]) => Promise<string>;
    now?: () => number;
    /** 远端版本检查用的 fetch，测试时注入假实现。 */
    fetchImpl?: typeof fetch;
    /** 远端仓库坐标 owner/repo；默认从 package.json 的 repository 解析。 */
    remoteRepo?: string;
    /** 远端分支，默认 main。 */
    remoteBranch?: string;
    /**
     * 强制运行模式。
     *
     * 不传时按 `process.pkg` 与 `/.dockerenv` 自动判定。留这个口子主要是为了测试——
     * 容器模式的分支逻辑（文案、能否检查、部署命令）跟真实文件系统无关，不该非得
     * 跑进容器才能验证；顺手也给特殊部署留了覆盖手段。
     */
    mode?: SystemUpdateStatus['mode'];
}

const JOB_FILENAME = 'update-job.json';
const JOB_LOG_FILENAME = 'update-job.log';
const LOCK_FILENAME = 'update.lock';
const MAX_RECENT_LINES = 40;

function createUpdateError(message: string, statusCode = 400, code = 'SYSTEM_UPDATE_ERROR'): Error {
    return Object.assign(new Error(message), { statusCode, code });
}

function defaultExecGit(cwd: string, args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
        execFile('git', args, {
            cwd,
            env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
            timeout: 30000,
            maxBuffer: 4 * 1024 * 1024,
            windowsHide: true,
        }, (err: any, stdout: string, stderr: string) => {
            if (!err) {
                resolve(String(stdout || ''));
                return;
            }
            const detail = String(stderr || stdout || err.message || 'Git 执行失败').trim();
            reject(Object.assign(new Error(detail), {
                code: err?.code || 'GIT_EXEC_FAILED',
                statusCode: 400,
            }));
        });
    });
}

function isProcessAlive(pid: number): boolean {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (err: any) {
        return err?.code === 'EPERM';
    }
}

function readJobState(runtimeDir: string): PanelUpdateJobState | null {
    const raw = layout.readJsonSafe(path.join(runtimeDir, JOB_FILENAME), null);
    if (!raw || typeof raw !== 'object') return null;
    const status = raw.status === 'succeeded' || raw.status === 'failed' ? raw.status : 'running';
    return {
        id: String(raw.id || ''),
        action: raw.action === 'rollback' ? 'rollback' : raw.action === 'snapshot' ? 'snapshot' : 'update',
        pid: Number(raw.pid) || undefined,
        status,
        phase: String(raw.phase || ''),
        detail: typeof raw.detail === 'string' ? raw.detail : '',
        startedAt: Number(raw.startedAt) || 0,
        updatedAt: Number(raw.updatedAt) || 0,
        finishedAt: Number(raw.finishedAt) || undefined,
        exitCode: raw.exitCode === undefined ? undefined : raw.exitCode,
        error: typeof raw.error === 'string' ? raw.error : undefined,
        fromCommit: typeof raw.fromCommit === 'string' ? raw.fromCommit : undefined,
        targetCommit: typeof raw.targetCommit === 'string' ? raw.targetCommit : undefined,
        releaseId: typeof raw.releaseId === 'string' ? raw.releaseId : undefined,
        recentLines: Array.isArray(raw.recentLines)
            ? raw.recentLines.map((line: unknown) => String(line)).slice(-MAX_RECENT_LINES)
            : [],
    };
}

/**
 * 作业「还在跑」的判定：状态写着 running，并且 pid 还活着。
 *
 * 只看状态位是不够的——执行器被 kill -9 或者机器重启时状态文件永远停在 running，
 * 面板会一直显示「更新中」并且拒绝新任务。这里叠一层 pid 活性检查，顺便把尸检结果
 * 落回状态文件，让用户看到一条明确的失败原因，而不是无限转圈。
 */
function readJobStateResolved(runtimeDir: string): PanelUpdateJobState | null {
    const job = readJobState(runtimeDir);
    if (!job || job.status !== 'running') return job;
    if (isProcessAlive(job.pid as number)) return job;
    const interred: PanelUpdateJobState = {
        ...job,
        status: 'failed',
        phase: '任务已中断',
        error: '更新进程已退出，但没有来得及写入结果（可能被强制结束或机器重启）。',
        finishedAt: job.updatedAt || Date.now(),
    };
    try {
        layout.writeJsonAtomic(path.join(runtimeDir, JOB_FILENAME), interred);
    }
    catch {
        // 写不进去也不影响返回的判定结果。
    }
    return interred;
}

function isDeployLockAlive(runtimeDir: string): boolean {
    const raw = layout.readJsonSafe(path.join(runtimeDir, LOCK_FILENAME), null);
    if (!raw) return false;
    return isProcessAlive(Number(raw.pid));
}

function parsePorcelain(stdout: string): string[] {
    return String(stdout || '')
        .split('\n')
        .map((line) => line.trimEnd())
        .filter(Boolean)
        .map((line) => line.slice(3).trim())
        .filter(Boolean)
        .slice(0, 50);
}

const VERSION_FILENAME = 'version.json';
const DEFAULT_REMOTE_BRANCH = 'main';
/** 容器重建命令：前端直接展示成可复制文本，用户贴到宿主机项目目录下就能用。 */
const DOCKER_DEPLOY_COMMAND = 'git pull --ff-only && docker compose up -d --build';

/**
 * 把各种写法的仓库地址收敛成 `owner/repo`。
 *
 * 支持 `owner/repo`、`https://github.com/owner/repo(.git)`、`git@github.com:owner/repo`、
 * `ssh://git@host/owner/repo`。解析不出来返回空串——调用方会用默认值兜底，而不是抛错。
 */
function normalizeRepoSlug(input: unknown): string {
    const raw = String(input || '').trim()
        .replace(/^git\+/, '')
        .replace(/\.git$/i, '')
        .replace(/\/+$/, '');
    if (!raw) return '';
    const matched = /(?:^|[/@:])([\w.-]+)\/([\w.-]+)$/.exec(raw);
    if (!matched) return '';
    return `${matched[1]}/${matched[2]}`;
}

/**
 * 远端仓库坐标：环境变量 > package.json 的 repository > 内置默认值。
 *
 * 容器里没有 `.git`，所以读不到 origin 地址；`package.json` 是被打进镜像的
 * （Dockerfile 的 prod-deps 阶段会 COPY 根 package.json），因此这条兜底在
 * 源码部署和容器部署下都成立。
 */
function resolveRemoteRepo(repoRoot: string, explicit?: string): string {
    const fromOptions = normalizeRepoSlug(explicit);
    if (fromOptions) return fromOptions;
    const fromEnv = normalizeRepoSlug(process.env.FARM_UPDATE_REPO);
    if (fromEnv) return fromEnv;
    for (const relative of ['package.json', path.join('core', 'package.json')]) {
        const data: any = layout.readJsonSafe(path.join(repoRoot, relative), null);
        const repository = data && typeof data === 'object' ? data.repository : null;
        const url = typeof repository === 'string'
            ? repository
            : (repository && typeof repository === 'object' ? repository.url : '');
        const slug = normalizeRepoSlug(url);
        if (slug) return slug;
    }
    return '';
}

/** 本地版本：读仓库根的 version.json（容器里同样存在，web 构建与面板版本都用它）。 */
function readLocalVersion(repoRoot: string): { version: string, build: number } {
    const data: any = layout.readJsonSafe(path.join(repoRoot, VERSION_FILENAME), {}) || {};
    return {
        version: String(data.version || '').trim(),
        build: Number(data.build) || 0,
    };
}

/**
 * 远端是否更新。
 *
 * 先比 `build`（单调递增的次数，最可靠），再退到语义化版本字符串比较——
 * 只比字符串的话 `3.9.0` 会被判成比 `3.10.0` 新。
 */
function isRemoteNewer(remote: { version: string, build: number }, local: { version: string, build: number }): boolean {
    if (!remote.version && !remote.build) return false;
    if (remote.build && local.build && remote.build !== local.build) return remote.build > local.build;
    if (!remote.version || remote.version === local.version) return false;
    if (!local.version) return true;
    const parse = (value: string) => String(value)
        .replace(/^v/i, '')
        .split('.')
        .map((part) => Number(part) || 0);
    const a = parse(remote.version);
    const b = parse(local.version);
    for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
        const x = a[i] || 0;
        const y = b[i] || 0;
        if (x !== y) return x > y;
    }
    return false;
}

function createSystemUpdateService(options: SystemUpdateServiceOptions = {}) {
    const now = options.now || Date.now;
    const execGit = options.execGit || defaultExecGit;
    const spawnRunner = options.spawnRunner || spawn;
    const isPackaged = options.isPackaged ?? !!(process as any).pkg;

    const appRoot = path.join(__dirname, '..', '..');
    const repoRoot = options.repoRoot
        ? path.resolve(options.repoRoot)
        : layout.resolveRepoRoot(appRoot);
    const runtimeDir = layout.resolveRuntimeDir(repoRoot, options.runtimeDir);
    const releasesDir = layout.resolveReleasesDir(repoRoot, options.releasesDir);
    const remoteRepo = resolveRemoteRepo(repoRoot, options.remoteRepo);
    const remoteBranch = String(options.remoteBranch || process.env.FARM_UPDATE_BRANCH || DEFAULT_REMOTE_BRANCH).trim()
        || DEFAULT_REMOTE_BRANCH;
    // Node 20 自带全局 fetch；允许注入是为了测试里不打真实网络。
    const fetchImpl: typeof fetch = options.fetchImpl || ((...args: Parameters<typeof fetch>) => fetch(...args));

    let startupCommit = '';
    let startupCommitReady = false;
    let lastCheckedAt: number | null = null;
    let lastCheckError = '';
    let lastPulledAt: number | null = null;
    let remoteVersion: RemoteVersionInfo | null = null;
    let remoteCheckedAt: number | null = null;
    let remoteCheckError = '';
    let opChain: Promise<any> = Promise.resolve();

    /** 串行化「检查/拉取/发起更新」这类会互相踩的操作，避免并发点两次。 */
    function withOpMutex<T>(fn: () => Promise<T>): Promise<T> {
        const run = opChain.then(fn, fn);
        opChain = run.then(() => undefined, () => undefined);
        return run;
    }

    async function readStartupCommit(): Promise<string> {
        if (startupCommitReady) return startupCommit;
        startupCommitReady = true;
        try {
            startupCommit = (await execGit(repoRoot, ['rev-parse', 'HEAD'])).trim();
        }
        catch {
            startupCommit = '';
        }
        return startupCommit;
    }

    async function detectEnv() {
        const mode: SystemUpdateStatus['mode'] = options.mode
            ? options.mode
            : (isPackaged ? 'packaged' : (fs.existsSync('/.dockerenv') ? 'docker' : 'source'));
        // 真正拉起的是 core/runtime/runner/ 下的稳定副本，不是工作树里的 tools/farm-release.mjs：
        // 回滚会 git reset，工作树里的执行器可能正在被删掉（详见 release-layout 的说明）。
        layout.installStableRunner(repoRoot);
        const runnerPath = layout.locateRunner(repoRoot);
        let unsupportedReason = '';
        let applyUnsupportedReason = '';

        if (mode === 'packaged') {
            unsupportedReason = '当前是打包运行（单文件可执行），不包含 git 仓库，无法在线更新。';
        }
        else if (mode === 'docker') {
            // 容器里没有 `.git`、没有 git 命令、也没有更新执行器——这三件事都是镜像结构决定的，
            // 不是「部署坏了」。所以先按容器语义给出能执行的指引，不再把源码部署的诊断搬过来：
            // 否则 NAS 用户会看到「没有找到 git 仓库（/app）」「缺少更新执行器」，两头都无从下手，
            // 而真正该做的事（宿主机重建镜像）一个字都没提。
            unsupportedReason = '当前运行在 Docker 容器内：版本由镜像决定，容器内不提供 git 更新。'
                + `请在宿主机项目目录执行 ${DOCKER_DEPLOY_COMMAND} 重建容器。`;
        }
        else if (!fs.existsSync(path.join(repoRoot, '.git'))) {
            unsupportedReason = `没有找到 git 仓库（${repoRoot}），无法在线更新。`;
        }

        let gitSupported = !unsupportedReason;
        if (gitSupported) {
            try {
                await execGit(repoRoot, ['rev-parse', '--is-inside-work-tree']);
            }
            catch {
                gitSupported = false;
                unsupportedReason = 'git 命令不可用或当前目录不是工作树。';
            }
        }

        if (mode === 'docker') {
            // 容器内重启进程只会把容器打死，代码改动也随容器重建消失；更新只能发生在宿主机。
            // 这里不再去看执行器是否存在——那属于源码部署的判定，放在容器语境里只会误导。
            applyUnsupportedReason = `容器内部无法重启自身，也不该在容器里改代码：请在宿主机项目目录执行 ${DOCKER_DEPLOY_COMMAND}。`;
        }
        else if (!fs.existsSync(runnerPath)) {
            applyUnsupportedReason = '缺少更新执行器（tools/farm-release.mjs），拉取代码后需要手动重启服务。';
        }

        return {
            mode,
            repoRoot,
            runtimeDir,
            releasesDir,
            gitSupported,
            unsupportedReason,
            applySupported: gitSupported && !applyUnsupportedReason,
            applyUnsupportedReason,
            runnerPath,
        };
    }

    /**
     * 不依赖 git 的远端版本检查：直接读远端仓库的 `version.json` 比版本号。
     *
     * 这条通道专门服务容器/打包部署——它们没有 `.git`，但「远端有没有新版本」这个问题
     * 仍然有答案。刻意不抛错：网络不通时返回带 `remoteCheckError` 的状态，
     * 让面板显示「检查失败：原因」，而不是弹一个看不懂的 400。
     */
    async function fetchRemoteVersion(): Promise<RemoteVersionInfo> {
        if (!remoteRepo) {
            throw new Error('未配置远端仓库坐标（可设置 FARM_UPDATE_REPO=owner/repo）');
        }
        const url = `https://api.github.com/repos/${remoteRepo}/contents/${VERSION_FILENAME}`
            + `?ref=${encodeURIComponent(remoteBranch)}`;
        const headers: Record<string, string> = {
            // raw 直接返回文件正文，省掉 base64 解码与「是不是 API 包装」的分支。
            'Accept': 'application/vnd.github.raw',
            'User-Agent': 'qq-farm-bot-updater',
        };
        const token = String(process.env.FARM_UPDATE_TOKEN || '').trim();
        if (token) headers.Authorization = `Bearer ${token}`;

        const res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(15000) });
        if (!res.ok) {
            const hint = res.status === 404
                ? `远端仓库或分支不存在（${remoteRepo}@${remoteBranch}）`
                : res.status === 403
                    ? '接口限流或无权访问（可设置 FARM_UPDATE_TOKEN 提高额度）'
                    : `HTTP ${res.status}`;
            throw new Error(hint);
        }
        const text = await res.text();
        let parsed: any;
        try {
            parsed = JSON.parse(text);
        }
        catch {
            throw new Error('远端 version.json 不是合法 JSON');
        }
        // 带 Accept: raw 时是文件正文；万一被代理改写回 API 包装，这里兼容一下。
        if (parsed && typeof parsed === 'object' && typeof parsed.content === 'string' && parsed.encoding === 'base64') {
            parsed = JSON.parse(Buffer.from(parsed.content, 'base64').toString('utf8'));
        }
        const version = String(parsed?.version || '').trim();
        const build = Number(parsed?.build) || 0;
        if (!version && !build) throw new Error('远端 version.json 缺少版本号');
        const head = Array.isArray(parsed?.history) ? parsed.history[0] : null;
        return {
            repo: remoteRepo,
            branch: remoteBranch,
            version,
            build,
            summary: String(head?.summary || '').trim(),
            commit: String(head?.commit || '').trim(),
            updatedAt: String(parsed?.updatedAt || '').trim(),
        };
    }

    async function checkRemoteVersion(): Promise<SystemUpdateStatus> {
        try {
            remoteVersion = await fetchRemoteVersion();
            remoteCheckError = '';
        }
        catch (err: any) {
            remoteVersion = null;
            remoteCheckError = String(err?.message || err || '检查远端版本失败');
        }
        remoteCheckedAt = now();
        lastCheckedAt = remoteCheckedAt;
        lastCheckError = remoteCheckError;
        return getStatus();
    }

    async function inspectRepoLocal() {
        const commit = (await execGit(repoRoot, ['rev-parse', 'HEAD'])).trim();
        const branchRaw = (await execGit(repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
        const detached = !branchRaw || branchRaw === 'HEAD';
        const shortCommit = (await execGit(repoRoot, ['rev-parse', '--short=7', 'HEAD'])).trim();
        let commitSubject = '';
        try {
            commitSubject = (await execGit(repoRoot, ['log', '-1', '--format=%s'])).trim();
        }
        catch {
            commitSubject = '';
        }

        let upstream = '';
        if (!detached) {
            try {
                upstream = (await execGit(repoRoot, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])).trim();
            }
            catch {
                upstream = '';
            }
        }
        const remote = upstream.includes('/') ? upstream.split('/')[0] : '';
        const remoteBranch = upstream.includes('/') ? upstream.slice(upstream.indexOf('/') + 1) : '';

        const dirtyFiles = parsePorcelain(await execGit(repoRoot, ['status', '--porcelain=v1', '-uall']).catch(() => ''));

        let behindCount = 0;
        let aheadCount = 0;
        if (upstream) {
            try {
                const counts = (await execGit(repoRoot, ['rev-list', '--left-right', '--count', `${upstream}...HEAD`])).trim();
                const [behind, ahead] = counts.split(/\s+/).map((value) => Number(value) || 0);
                behindCount = behind || 0;
                aheadCount = ahead || 0;
            }
            catch {
                behindCount = 0;
                aheadCount = 0;
            }
        }

        let incomingCommits: IncomingCommitInfo[] = [];
        if (upstream && behindCount > 0) {
            try {
                const raw = await execGit(repoRoot, [
                    'log',
                    '--format=%H%x1F%h%x1F%s%x1F%an%x1F%ct',
                    '-n',
                    '30',
                    `HEAD..${upstream}`,
                ]);
                incomingCommits = raw.split('\n').filter(Boolean).map((line) => {
                    const [hash, shortHash, subject, author, ts] = line.split('\x1F');
                    return {
                        hash: hash || '',
                        shortHash: shortHash || '',
                        subject: subject || '',
                        author: author || '',
                        timestampMs: (Number(ts) || 0) * 1000,
                    };
                });
            }
            catch {
                incomingCommits = [];
            }
        }

        return {
            commit,
            shortCommit,
            commitSubject,
            branch: detached ? '' : branchRaw,
            detached,
            upstream,
            remote,
            remoteBranch,
            dirtyFiles,
            behindCount,
            aheadCount,
            incomingCommits,
        };
    }

    function assertUpdatable(repo: { detached: boolean; upstream: string; remote: string; remoteBranch: string }): void {
        if (repo.detached || !repo.upstream || !repo.remote || !repo.remoteBranch) {
            throw createUpdateError('当前分支没有跟踪远端分支，无法在线更新。', 400, 'NO_UPSTREAM');
        }
    }

    async function getStatus(): Promise<SystemUpdateStatus> {
        const envInfo = await detectEnv();
        const startup = await readStartupCommit();
        const snapshot = releaseStore.listReleases({ repoRoot, releasesDir });
        const job = readJobStateResolved(runtimeDir);
        const jobBusy = Boolean(job && job.status === 'running') || isDeployLockAlive(runtimeDir);
        const webInfo = webBuildInfo.readWebBuildInfo(repoRoot);
        const local = readLocalVersion(repoRoot);

        const base: SystemUpdateStatus = {
            mode: envInfo.mode,
            gitSupported: envInfo.gitSupported,
            unsupportedReason: envInfo.unsupportedReason,
            applySupported: envInfo.applySupported,
            applyUnsupportedReason: envInfo.applyUnsupportedReason,
            repoRoot,
            branch: '',
            detached: false,
            commit: '',
            shortCommit: '',
            commitSubject: '',
            startupCommit: startup,
            needsApply: false,
            upstream: '',
            remote: '',
            remoteBranch: '',
            behindCount: 0,
            aheadCount: 0,
            dirtyFiles: [],
            incomingCommits: [],
            // 「能检查」不再等同于「能 git fetch」：容器与打包部署走远端 version.json 那条通道，
            // 照样能回答「有没有新版本」。能不能拉取/应用仍然是 git 部署独有的。
            canCheck: !envInfo.gitSupported,
            canPull: false,
            canApply: false,
            jobBusy,
            lastCheckedAt,
            lastCheckError,
            lastPulledAt,
            job,
            releases: snapshot.releases,
            releasesSummary: snapshot.summary,
            webBuildId: webInfo?.buildId || '',
            webVersion: webInfo?.appVersion || snapshot.summary.activeVersion,
            localVersion: local.version,
            localBuild: local.build,
            remoteVersion,
            hasNewVersion: remoteVersion ? isRemoteNewer(remoteVersion, local) : false,
            remoteCheckedAt,
            remoteCheckError,
            deployCommand: envInfo.mode === 'docker' ? DOCKER_DEPLOY_COMMAND : '',
        };

        if (!envInfo.gitSupported) return base;

        let repo;
        try {
            repo = await inspectRepoLocal();
        }
        catch (err: any) {
            return { ...base, lastCheckError: err?.message || '读取 git 状态失败' };
        }

        const canCheck = Boolean(!repo.detached && repo.upstream);
        return {
            ...base,
            ...repo,
            needsApply: Boolean(startup && repo.commit && startup !== repo.commit),
            canCheck,
            canPull: canCheck && repo.behindCount > 0 && repo.dirtyFiles.length === 0,
            // 脏工作区不能动：pull 会冲突、回滚会丢改动。这里如实反映，前端不用再猜一遍。
            canApply: envInfo.applySupported && !jobBusy && repo.dirtyFiles.length === 0,
        };
    }

    async function runCheckUnlocked() {
        const envInfo = await detectEnv();
        if (!envInfo.gitSupported) {
            throw createUpdateError(envInfo.unsupportedReason || '当前运行方式不支持更新', 400, 'UNSUPPORTED_ENVIRONMENT');
        }
        const before = await inspectRepoLocal();
        assertUpdatable(before);
        try {
            await execGit(repoRoot, ['fetch', '--prune', before.remote]);
            lastCheckedAt = now();
            lastCheckError = '';
        }
        catch (err: any) {
            lastCheckedAt = now();
            lastCheckError = String(err?.message || '拉取远端信息失败');
            throw createUpdateError(`检查更新失败：${lastCheckError}`, 400, 'GIT_FETCH_FAILED');
        }
        return getStatus();
    }

    /**
     * 检查更新。
     *
     * 两条通道由运行方式决定，前端只管点按钮：
     *   - 有 git（源码部署）：`git fetch` 后比对本地与上游的提交数与提交列表；
     *   - 没有 git（容器/打包）：读远端仓库的 `version.json` 比版本号，至少能回答
     *     「远端是不是已经有新版本」，而不是把「没有 git 仓库」当成检查失败。
     */
    const checkForUpdates = () => withOpMutex(async () => {
        const envInfo = await detectEnv();
        if (!envInfo.gitSupported) return checkRemoteVersion();
        return runCheckUnlocked();
    });

    const pullUpdates = () => withOpMutex(async () => {
        const envInfo = await detectEnv();
        if (!envInfo.gitSupported) {
            throw createUpdateError(envInfo.unsupportedReason || '当前运行方式不支持更新', 400, 'UNSUPPORTED_ENVIRONMENT');
        }
        const repo = await inspectRepoLocal();
        assertUpdatable(repo);
        if (repo.dirtyFiles.length) {
            throw createUpdateError(`工作区有 ${repo.dirtyFiles.length} 个未提交改动，请先提交或还原。`, 409, 'DIRTY_WORKTREE');
        }
        if (repo.behindCount === 0) {
            return { pulled: false, fromCommit: repo.shortCommit, toCommit: repo.shortCommit, status: await getStatus() };
        }
        const fromCommit = repo.shortCommit;
        try {
            await execGit(repoRoot, ['pull', '--ff-only', repo.remote, repo.remoteBranch]);
            lastPulledAt = now();
        }
        catch (err: any) {
            throw createUpdateError(`拉取代码失败：${err?.message || 'git pull 执行失败'}`, 400, 'GIT_PULL_FAILED');
        }
        const status = await getStatus();
        return {
            pulled: status.shortCommit !== fromCommit,
            fromCommit,
            toCommit: status.shortCommit,
            status,
        };
    });

    function jobFilePath(): string {
        return path.join(runtimeDir, JOB_FILENAME);
    }

    /** 拉起脱离父进程的执行器。父进程随时可能被它杀掉，所以必须 detached + unref。 */
    async function launchRunner(params: {
        args: string[];
        action: PanelUpdateJobState['action'];
        phase: string;
        recentLine: string;
        fromCommit?: string;
        targetCommit?: string;
        releaseId?: string;
    }): Promise<PanelUpdateJobState> {
        const envInfo = await detectEnv();
        fs.mkdirSync(runtimeDir, { recursive: true });
        const jobFile = jobFilePath();
        const logFile = path.join(runtimeDir, JOB_LOG_FILENAME);
        const startedAt = now();
        const initialJob: PanelUpdateJobState = {
            id: `${params.action}_${crypto.randomUUID().slice(0, 8)}`,
            action: params.action,
            status: 'running',
            phase: params.phase,
            detail: '',
            startedAt,
            updatedAt: startedAt,
            fromCommit: params.fromCommit,
            targetCommit: params.targetCommit,
            releaseId: params.releaseId,
            recentLines: [params.recentLine],
        };

        const outFd = fs.openSync(logFile, 'w');
        try {
            layout.writeJsonAtomic(jobFile, initialJob);
            const child = spawnRunner(process.execPath, [envInfo.runnerPath, ...params.args], {
                cwd: repoRoot,
                env: {
                    ...process.env,
                    NODE_ENV: process.env.NODE_ENV || 'production',
                    FARM_REPO_ROOT: repoRoot,
                    FARM_RUNTIME_DIR: runtimeDir,
                    FARM_RELEASES_DIR: releasesDir,
                    FARM_UPDATE_JOB_FILE: jobFile,
                },
                detached: true,
                stdio: ['ignore', outFd, outFd] as any,
                windowsHide: true,
            });
            await new Promise<void>((resolve, reject) => {
                child.once('error', reject);
                child.once('spawn', resolve);
            });
            initialJob.pid = child.pid;
            child.unref();
        }
        catch (err: any) {
            const failedJob: PanelUpdateJobState = {
                ...initialJob,
                status: 'failed',
                finishedAt: now(),
                error: err?.message || '无法启动更新进程',
            };
            layout.writeJsonAtomic(jobFile, failedJob);
            throw createUpdateError(`启动后台任务失败：${err?.message || err}`, 500, 'SPAWN_UPDATE_FAILED');
        }
        finally {
            fs.closeSync(outFd);
        }
        return initialJob;
    }

    function assertNotBusy(): void {
        const job = readJobStateResolved(runtimeDir);
        if (job && job.status === 'running') {
            throw createUpdateError('已有更新任务正在运行，请等待结束后再操作。', 409, 'UPDATE_BUSY');
        }
        if (isDeployLockAlive(runtimeDir)) {
            throw createUpdateError('已有发布任务正在运行，请稍后再试。', 409, 'UPDATE_BUSY');
        }
    }

    const applyUpdate = (applyOptions: { pullFirst?: boolean } = {}) => withOpMutex(async () => {
        await readStartupCommit();
        const envInfo = await detectEnv();
        if (!envInfo.gitSupported) {
            throw createUpdateError(envInfo.unsupportedReason || '当前运行方式不支持更新', 400, 'UNSUPPORTED_ENVIRONMENT');
        }
        if (!envInfo.applySupported) {
            throw createUpdateError(envInfo.applyUnsupportedReason || '当前运行方式不支持面板一键更新', 400, 'APPLY_UNSUPPORTED');
        }
        assertNotBusy();

        if (applyOptions.pullFirst !== false) {
            const before = await inspectRepoLocal();
            assertUpdatable(before);
            if (before.dirtyFiles.length) {
                throw createUpdateError(`工作区有 ${before.dirtyFiles.length} 个未提交改动，请先提交或还原后再更新。`, 409, 'DIRTY_WORKTREE');
            }
            await runCheckUnlocked();
            const repo = await inspectRepoLocal();
            if (repo.behindCount > 0) {
                await execGit(repoRoot, ['pull', '--ff-only', repo.remote, repo.remoteBranch]);
                lastPulledAt = now();
            }
        }

        const repo = await inspectRepoLocal();
        const startup = await readStartupCommit();
        const needsRebuildOnly = Boolean(startup && repo.commit === startup && repo.behindCount === 0);
        if (needsRebuildOnly) {
            throw createUpdateError('代码已是最新且运行中的就是这份代码，不需要更新。', 400, 'NOTHING_TO_APPLY');
        }

        const job = await launchRunner({
            args: ['update'],
            action: 'update',
            phase: '正在后台启动更新流程',
            recentLine: '[更新] 已受理，正在拉起后台更新进程…',
            fromCommit: startup ? startup.slice(0, 7) : repo.shortCommit,
            targetCommit: repo.shortCommit,
        });
        return { job, status: await getStatus() };
    });

    const rollback = (params: { releaseId?: string; confirmIncompatible?: boolean } = {}) => withOpMutex(async () => {
        await readStartupCommit();
        const envInfo = await detectEnv();
        if (!envInfo.gitSupported) {
            throw createUpdateError(envInfo.unsupportedReason || '当前运行方式不支持回滚', 400, 'UNSUPPORTED_ENVIRONMENT');
        }
        if (!envInfo.applySupported) {
            throw createUpdateError(envInfo.applyUnsupportedReason || '当前运行方式不支持面板一键回滚', 400, 'APPLY_UNSUPPORTED');
        }
        assertNotBusy();

        const snapshot = releaseStore.listReleases({ repoRoot, releasesDir });
        const requested = typeof params.releaseId === 'string' && params.releaseId.trim()
            ? params.releaseId.trim()
            : (snapshot.active.backend.previous || '');
        if (!requested) {
            throw createUpdateError('没有可回滚的历史版本，先执行一次更新让系统归档当前版本。', 400, 'NO_ROLLBACK_TARGET');
        }
        const target = snapshot.releases.find((item) => item.releaseId === requested);
        if (!target) {
            throw createUpdateError(`找不到版本 ${requested}，可能已被清理。`, 404, 'RELEASE_NOT_FOUND');
        }
        if (target.kind !== 'backend') {
            throw createUpdateError('回滚必须选择后端版本，前端会跟随同一次构建一起回退。', 400, 'WRONG_RELEASE_KIND');
        }
        if (!target.canRollback) {
            throw createUpdateError('该版本是当前运行版本或归档不完整，无法回滚。', 400, 'RELEASE_NOT_ROLLBACKABLE');
        }
        if (!target.compat.compatible && !params.confirmIncompatible) {
            throw createUpdateError(`该版本与当前客户端版本不匹配：${target.compat.reasons.join('；')}`, 409, 'RELEASE_INCOMPATIBLE');
        }

        const repo = await inspectRepoLocal();
        if (repo.dirtyFiles.length) {
            throw createUpdateError(`工作区有 ${repo.dirtyFiles.length} 个未提交改动，请先提交或还原后再回滚。`, 409, 'DIRTY_WORKTREE');
        }
        if (repo.aheadCount > 0) {
            throw createUpdateError('当前分支有未推送的本地提交，回滚会丢掉它们，请先推送或重置。', 409, 'AHEAD_OF_UPSTREAM');
        }
        if (!target.commit) {
            throw createUpdateError('该版本归档没有记录提交号，无法对齐源码。', 400, 'RELEASE_MISSING_COMMIT');
        }
        try {
            await execGit(repoRoot, ['cat-file', '-e', `${target.commit}^{commit}`]);
        }
        catch {
            throw createUpdateError(`提交 ${target.shortCommit} 已不在本地仓库中，请先 fetch 后再回滚。`, 400, 'COMMIT_MISSING');
        }

        const job = await launchRunner({
            args: ['rollback', '--release', target.releaseId],
            action: 'rollback',
            phase: '正在后台启动回滚流程',
            recentLine: `[回滚] 目标版本 ${target.releaseId}（${target.shortCommit}）`,
            fromCommit: repo.shortCommit,
            targetCommit: target.shortCommit,
            releaseId: target.releaseId,
        });
        return { job, status: await getStatus() };
    });

    const deleteReleases = (params: { releaseIds?: string[]; cleanOrphans?: boolean } = {}) => withOpMutex(async () => {
        assertNotBusy();
        const snapshot = releaseStore.listReleases({ repoRoot, releasesDir });
        const deletable = new Set(
            snapshot.releases.filter((item) => item.canDelete).map((item) => item.releaseId),
        );
        const targets = new Set<string>();

        if (Array.isArray(params.releaseIds)) {
            for (const raw of params.releaseIds) {
                const id = String(raw || '').trim();
                if (!id) continue;
                if (!deletable.has(id)) {
                    throw createUpdateError(`版本 ${id} 正在使用中或不可删除。`, 400, 'RELEASE_NOT_DELETABLE');
                }
                targets.add(id);
            }
        }
        if (params.cleanOrphans) {
            const backendKeys = new Set(
                snapshot.releases
                    .filter((item) => item.kind === 'backend')
                    .map((item) => item.releaseId.replace(/^backend-/, '')),
            );
            for (const item of snapshot.releases) {
                if (item.kind !== 'web') continue;
                if (item.isActive) continue;
                const key = item.releaseId.replace(/^web-/, '');
                if (!backendKeys.has(key) && item.canDelete) targets.add(item.releaseId);
            }
        }
        if (!targets.size) {
            throw createUpdateError('没有需要删除的版本。', 400, 'NOTHING_TO_DELETE');
        }

        const deleted: string[] = [];
        let freedBytes = 0;
        for (const releaseId of targets) {
            const result = layout.deleteReleaseDir(releasesDir, releaseId);
            deleted.push(result.releaseId);
            freedBytes += Number(result.freedBytes) || 0;
        }
        return { deleted, freedBytes, status: await getStatus() };
    });

    function readJobLog(tailLines = 80): string {
        try {
            const text = fs.readFileSync(path.join(runtimeDir, JOB_LOG_FILENAME), 'utf8');
            const lines = text.split('\n');
            return lines.slice(Math.max(0, lines.length - tailLines)).join('\n');
        }
        catch {
            return '';
        }
    }

    return {
        repoRoot,
        runtimeDir,
        releasesDir,
        remoteRepo,
        remoteBranch,
        detectEnv,
        getStatus,
        checkForUpdates,
        checkRemoteVersion,
        pullUpdates,
        applyUpdate,
        rollback,
        deleteReleases,
        readJob: () => readJobStateResolved(runtimeDir),
        readJobLog,
    };
}

module.exports = {
    createSystemUpdateService,
};
