/**
 * 版本归档（releases/）的目录布局与读写。
 *
 * 这里刻意写成**纯 CommonJS、零依赖**的普通 JS：同一个文件既被编译后的后端
 * （`release-store.ts` → `dist/services/release-layout.js`）引用，也被脱离后端运行的
 * 更新执行器（`tools/farm-release.mjs`）引用。执行器必须能在「后端已经死掉、甚至正在被
 * 覆盖」的时间窗里工作，所以它不能依赖任何后端服务、环境或构建产物——只能依赖这个文件。
 *
 * 目录布局：
 *   <repo>/releases/backend-<yyyyMMddHHmmss>-<shortsha>/{release-meta.json, client.js, dist/}
 *   <repo>/releases/web-<yyyyMMddHHmmss>-<shortsha>/{release-meta.json, dist/}
 *   <repo>/core/runtime/active-releases.json
 *   <repo>/core/runtime/update-job.json
 *
 * `release-meta.json` 是快照自带的版本信息，回滚时**只读它，不执行快照里的代码**。
 */

const fs = require('node:fs');
const path = require('node:path');

const RELEASE_META_FILENAME = 'release-meta.json';
const ACTIVE_STATE_FILENAME = 'active-releases.json';
const RELEASES_DIRNAME = 'releases';
const RUNTIME_DIRNAME = path.join('core', 'runtime');

/** 快照里每种归档各自需要保全的产物，路径相对于仓库根。 */
const RELEASE_ARTIFACTS = {
    backend: ['core/client.js', 'core/dist'],
    web: ['web/dist'],
};

const BACKEND_ID_RE = /^backend-\d{14}-[0-9a-z]+$/;
const WEB_ID_RE = /^web-\d{14}-[0-9a-z]+$/;
const ANY_ID_RE = /^(?:backend|web)-\d{14}-[0-9a-z]+$/;

function createReleaseError(message, statusCode, code) {
    return Object.assign(new Error(message), {
        statusCode: statusCode || 400,
        code: code || 'RELEASE_ERROR',
    });
}

/** 仓库根：优先环境变量，其次从 appRoot（core/）往上找 `.git`。 */
function resolveRepoRoot(appRoot) {
    const explicit = process.env.FARM_REPO_ROOT;
    if (explicit && fs.existsSync(explicit)) return path.resolve(explicit);

    let cursor = path.resolve(appRoot || process.cwd());
    for (let depth = 0; depth < 5; depth += 1) {
        if (fs.existsSync(path.join(cursor, '.git'))) return cursor;
        const parent = path.dirname(cursor);
        if (parent === cursor) break;
        cursor = parent;
    }
    return path.resolve(appRoot || process.cwd(), '..');
}

function resolveReleasesDir(repoRoot, explicit) {
    if (explicit) return path.resolve(explicit);
    if (process.env.FARM_RELEASES_DIR) return path.resolve(process.env.FARM_RELEASES_DIR);
    return path.join(path.resolve(repoRoot), RELEASES_DIRNAME);
}

function resolveRuntimeDir(repoRoot, explicit) {
    if (explicit) return path.resolve(explicit);
    if (process.env.FARM_RUNTIME_DIR) return path.resolve(process.env.FARM_RUNTIME_DIR);
    return path.join(path.resolve(repoRoot), RUNTIME_DIRNAME);
}

function pad2(value) {
    return String(value).padStart(2, '0');
}

/** 统一的 UTC 时间戳，避免跨时区部署时目录名排序错乱。 */
function formatStamp(date) {
    const d = date instanceof Date ? date : new Date(date || Date.now());
    return [
        d.getUTCFullYear(),
        pad2(d.getUTCMonth() + 1),
        pad2(d.getUTCDate()),
        pad2(d.getUTCHours()),
        pad2(d.getUTCMinutes()),
        pad2(d.getUTCSeconds()),
    ].join('');
}

function buildReleaseId(kind, stamp, shortCommit) {
    const sha = String(shortCommit || '').trim().toLowerCase().replace(/[^0-9a-z]/g, '').slice(0, 12) || 'nocommit';
    return `${kind}-${stamp}-${sha}`;
}

function parseReleaseId(releaseId) {
    const value = String(releaseId || '');
    const match = /^(backend|web)-(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})-([0-9a-z]+)$/.exec(value);
    if (!match) return null;
    const [, kind, y, mo, d, h, mi, s, sha] = match;
    return {
        releaseId: value,
        kind,
        shortCommit: sha,
        createdAt: Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)),
    };
}

function isValidReleaseId(kind, releaseId) {
    const value = String(releaseId || '');
    if (kind === 'backend') return BACKEND_ID_RE.test(value);
    if (kind === 'web') return WEB_ID_RE.test(value);
    return ANY_ID_RE.test(value);
}

function readJsonSafe(filename, fallback) {
    try {
        const text = fs.readFileSync(filename, 'utf8');
        if (!text.trim()) return fallback;
        const parsed = JSON.parse(text);
        return parsed == null ? fallback : parsed;
    }
    catch {
        return fallback;
    }
}

function writeJsonAtomic(filename, value) {
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    const tmp = `${filename}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, filename);
}

function readReleaseMeta(releaseDir) {
    return readJsonSafe(path.join(releaseDir, RELEASE_META_FILENAME), null);
}

function writeReleaseMeta(releaseDir, meta) {
    writeJsonAtomic(path.join(releaseDir, RELEASE_META_FILENAME), meta);
}

function emptySlot() {
    return { active: null, previous: null, history: [] };
}

function readActiveState(runtimeDir) {
    const raw = readJsonSafe(path.join(runtimeDir, ACTIVE_STATE_FILENAME), {}) || {};
    const normalize = (slot) => ({
        active: typeof slot?.active === 'string' && slot.active ? slot.active : null,
        previous: typeof slot?.previous === 'string' && slot.previous ? slot.previous : null,
        history: Array.isArray(slot?.history)
            ? slot.history.map((v) => String(v)).filter(Boolean).slice(0, 20)
            : [],
    });
    return {
        backend: normalize(raw.backend || emptySlot()),
        web: normalize(raw.web || emptySlot()),
        updatedAt: Number(raw.updatedAt) || 0,
    };
}

function writeActiveState(runtimeDir, state) {
    writeJsonAtomic(path.join(runtimeDir, ACTIVE_STATE_FILENAME), {
        backend: state.backend || emptySlot(),
        web: state.web || emptySlot(),
        updatedAt: Date.now(),
    });
}

/** 把某个归档记为当前版本：原来的 active 落到 previous，历史只留最近 20 条。 */
function activateRelease(runtimeDir, kind, releaseId) {
    const state = readActiveState(runtimeDir);
    const slot = state[kind] || emptySlot();
    if (slot.active === releaseId) {
        state[kind] = slot;
        writeActiveState(runtimeDir, state);
        return state;
    }
    const history = [releaseId, ...slot.history.filter((id) => id !== releaseId)].slice(0, 20);
    state[kind] = {
        active: releaseId,
        previous: slot.active && slot.active !== releaseId ? slot.active : slot.previous,
        history,
    };
    writeActiveState(runtimeDir, state);
    return state;
}

function dirSizeBytes(dir) {
    let total = 0;
    const pending = [dir];
    while (pending.length) {
        const current = pending.pop();
        let entries;
        try {
            entries = fs.readdirSync(current, { withFileTypes: true });
        }
        catch (err) {
            if (err && (err.code === 'ENOENT' || err.code === 'EACCES')) continue;
            throw err;
        }
        for (const entry of entries) {
            const child = path.join(current, entry.name);
            if (entry.isDirectory()) {
                pending.push(child);
            }
            else if (entry.isFile()) {
                try {
                    total += fs.statSync(child).size;
                }
                catch {
                    // 归档可能正在被清理，统计时忽略即可。
                }
            }
        }
    }
    return total;
}

function listReleaseDirs(releasesDir) {
    let entries = [];
    try {
        entries = fs.readdirSync(releasesDir, { withFileTypes: true });
    }
    catch (err) {
        if (err && err.code === 'ENOENT') return [];
        throw err;
    }
    const result = [];
    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const parsed = parseReleaseId(entry.name);
        if (!parsed) continue;
        result.push({
            ...parsed,
            dir: path.join(releasesDir, entry.name),
        });
    }
    result.sort((a, b) => b.createdAt - a.createdAt);
    return result;
}

function copyArtifact(source, target) {
    if (!fs.existsSync(source)) return false;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    // 快照/恢复都先清干净目标，避免上一版的残留文件混进来。
    fs.rmSync(target, { recursive: true, force: true });
    fs.cpSync(source, target, { recursive: true, force: true, dereference: true });
    return true;
}

/**
 * 把仓库里**当前已经构建好**的产物归档成一个版本。
 *
 * 只归档产物（`core/dist`、`core/client.js`、`web/dist`），不归档 `core/src`：
 * 源码由 git 负责，回滚时 `git reset --hard` 会把源码带回旧提交，两边不会打架。
 */
function snapshotRelease(options) {
    const opts = options || {};
    const repoRoot = path.resolve(opts.repoRoot);
    const kind = opts.kind === 'web' ? 'web' : 'backend';
    const releasesDir = resolveReleasesDir(repoRoot, opts.releasesDir);

    const artifacts = RELEASE_ARTIFACTS[kind];
    const missing = artifacts.filter((relative) => !fs.existsSync(path.join(repoRoot, relative)));
    if (missing.length) {
        throw createReleaseError(`缺少构建产物，无法归档：${missing.join('、')}`, 409, 'RELEASE_ARTIFACTS_MISSING');
    }

    const stamp = opts.stamp || formatStamp(opts.now ? new Date(opts.now) : new Date());
    const releaseId = buildReleaseId(kind, stamp, opts.shortCommit || opts.commit);
    const releaseDir = path.join(releasesDir, releaseId);

    fs.mkdirSync(releaseDir, { recursive: true });
    for (const relative of artifacts) {
        const target = path.join(releaseDir, relative === 'core/dist' ? 'dist' : relative === 'web/dist' ? 'dist' : path.basename(relative));
        copyArtifact(path.join(repoRoot, relative), target);
    }

    const meta = {
        releaseId,
        kind,
        commit: String(opts.commit || ''),
        shortCommit: String(opts.shortCommit || '').slice(0, 12),
        commitSubject: String(opts.commitSubject || ''),
        version: String(opts.version || ''),
        build: Number(opts.build) || 0,
        createdAt: Date.now(),
        artifactSizeBytes: dirSizeBytes(releaseDir),
    };
    writeReleaseMeta(releaseDir, meta);
    return { releaseId, dir: releaseDir, meta };
}

/** 把归档产物覆盖回仓库。调用方负责先 `git reset --hard` 对齐源码。 */
function restoreRelease(options) {
    const opts = options || {};
    const repoRoot = path.resolve(opts.repoRoot);
    const releasesDir = resolveReleasesDir(repoRoot, opts.releasesDir);
    const parsed = parseReleaseId(opts.releaseId);
    if (!parsed) {
        throw createReleaseError(`无效的版本目录名称：${String(opts.releaseId || '')}`, 400, 'INVALID_RELEASE_ID');
    }
    const releaseDir = path.join(releasesDir, parsed.releaseId);
    if (!fs.existsSync(releaseDir)) {
        throw createReleaseError(`版本目录不存在：${parsed.releaseId}`, 404, 'RELEASE_NOT_FOUND');
    }

    const meta = readReleaseMeta(releaseDir) || {};
    if (parsed.kind === 'backend') {
        copyArtifact(path.join(releaseDir, 'client.js'), path.join(repoRoot, 'core', 'client.js'));
        copyArtifact(path.join(releaseDir, 'dist'), path.join(repoRoot, 'core', 'dist'));
    }
    else {
        copyArtifact(path.join(releaseDir, 'dist'), path.join(repoRoot, 'web', 'dist'));
    }
    return { releaseId: parsed.releaseId, kind: parsed.kind, meta };
}

function deleteReleaseDir(releasesDir, releaseId) {
    const parsed = parseReleaseId(releaseId);
    if (!parsed) {
        throw createReleaseError(`无效的版本目录名称：${String(releaseId || '')}`, 400, 'INVALID_RELEASE_ID');
    }
    const releaseDir = path.join(releasesDir, parsed.releaseId);
    const sizeBefore = dirSizeBytes(releaseDir);
    fs.rmSync(releaseDir, { recursive: true, force: true });
    return { releaseId: parsed.releaseId, freedBytes: sizeBefore };
}

/** 只保留最近 N 个版本，`keep = 0` 表示全部保留。 */
function pruneReleases(options) {
    const opts = options || {};
    const keep = Math.max(0, Number(opts.keep) || 0);
    if (!keep) return [];
    const groups = { backend: [], web: [] };
    for (const item of listReleaseDirs(opts.releasesDir)) groups[item.kind].push(item);
    const removed = [];
    for (const kind of Object.keys(groups)) {
        const keepIds = new Set(groups[kind].slice(0, keep).map((item) => item.releaseId));
        const active = opts.active && opts.active[kind] ? opts.active[kind].active : null;
        for (const item of groups[kind]) {
            if (keepIds.has(item.releaseId) || item.releaseId === active) continue;
            removed.push(deleteReleaseDir(opts.releasesDir, item.releaseId).releaseId);
        }
    }
    return removed;
}

module.exports = {
    RELEASE_META_FILENAME,
    ACTIVE_STATE_FILENAME,
    RELEASE_ARTIFACTS,
    resolveRepoRoot,
    resolveReleasesDir,
    resolveRuntimeDir,
    formatStamp,
    buildReleaseId,
    parseReleaseId,
    isValidReleaseId,
    readJsonSafe,
    writeJsonAtomic,
    readReleaseMeta,
    readActiveState,
    writeActiveState,
    activateRelease,
    dirSizeBytes,
    listReleaseDirs,
    snapshotRelease,
    restoreRelease,
    deleteReleaseDir,
    pruneReleases,
};
