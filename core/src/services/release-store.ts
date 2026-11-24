import type { ReleaseCompatInfo } from './release-compat';
export {};

/**
 * 版本归档的查询层：把 `releases/` 目录翻译成面板能直接渲染的列表。
 *
 * 只读，不写目录、不碰源码。归档的写入与恢复都交给 `release-layout.js`（后端与更新执行器
 * 共用同一份实现），这里只额外叠加三样东西：后端与前端按同一次构建配对、与当前运行版本
 * 的兼容性判定、以及总览统计。
 */

const fs = require('node:fs');
const path = require('node:path');
const layout = require('./release-layout');
const releaseCompat = require('./release-compat');

export interface RollbackReleaseItem {
    releaseId: string;
    kind: 'backend' | 'web';
    createdAt: number;
    commit: string;
    shortCommit: string;
    commitSubject: string;
    version: string;
    build: number;
    /** 同一次构建配对出来的另一种归档。后端回滚必须带上配套的前端。 */
    pairedReleaseId: string;
    sizeBytes: number;
    isActive: boolean;
    isPrevious: boolean;
    canRollback: boolean;
    canDelete: boolean;
    compat: ReleaseCompatInfo;
}

export interface ReleasesSummary {
    totalCount: number;
    rollbackableCount: number;
    incompatibleCount: number;
    totalSizeBytes: number;
    incompatibleSizeBytes: number;
    orphanWebCount: number;
    orphanSizeBytes: number;
    activeBackendId: string;
    activeWebId: string;
    activeVersion: string;
    activeBuild: number;
}

function readLiveVersions(repoRoot: string): { qq: string; wx: string } | null {
    return releaseCompat.readReleaseVersions(path.join(repoRoot, 'core'));
}

function pairKeyOf(releaseId: string): string {
    const match = /^(?:backend|web)-(\d{14}-[0-9a-z]+)$/.exec(String(releaseId || ''));
    return match ? match[1] : '';
}

function readLiveVersionJson(repoRoot: string): { version: string; build: number } {
    const raw = layout.readJsonSafe(path.join(repoRoot, 'version.json'), {}) || {};
    return {
        version: typeof raw.version === 'string' ? raw.version : '',
        build: Number(raw.build) || 0,
    };
}

/**
 * 列出全部归档。
 *
 * `active` 为空时（例如刚升级、还没跑过第一次归档）把最新的一条当作当前版本，
 * 否则面板会出现「一个版本都不是当前」的怪异状态。
 */
function listReleases(options: { repoRoot: string; releasesDir?: string | null }): {
    releases: RollbackReleaseItem[];
    active: any;
    summary: ReleasesSummary;
} {
    const repoRoot = path.resolve(options.repoRoot);
    const releasesDir = layout.resolveReleasesDir(repoRoot, options.releasesDir);
    const runtimeDir = layout.resolveRuntimeDir(repoRoot);
    const active = layout.readActiveState(runtimeDir);
    const liveVersions = readLiveVersions(repoRoot);
    const live = readLiveVersionJson(repoRoot);
    const dirs = layout.listReleaseDirs(releasesDir);

    const byId = new Map<string, any>();
    for (const item of dirs) byId.set(item.releaseId, item);

    // 配对：先按「同一次构建」的时间戳后缀精确匹配；时间戳对不上时退回按提交号，
    // 因为同一提交可能在不同时间被归档过多次，它们跑的是同一份代码。
    const pairIndex = new Map<string, string>();
    const commitIndex = new Map<string, string[]>();
    for (const item of dirs) {
        const meta = layout.readReleaseMeta(item.dir) || {};
        const commit = typeof meta.commit === 'string' ? meta.commit : '';
        const key = `${item.kind}:${commit}`;
        if (commit) commitIndex.set(key, [...(commitIndex.get(key) || []), item.releaseId]);
    }
    for (const item of dirs) {
        const key = pairKeyOf(item.releaseId);
        const otherKind = item.kind === 'backend' ? 'web' : 'backend';
        if (key && byId.has(`${otherKind}-${key}`)) {
            pairIndex.set(item.releaseId, `${otherKind}-${key}`);
            continue;
        }
        const meta = layout.readReleaseMeta(item.dir) || {};
        const fallback = commitIndex.get(`${otherKind}:${meta.commit || ''}`);
        if (fallback && fallback.length) pairIndex.set(item.releaseId, fallback[0]);
    }

    const activeBackendId = active.backend.active
        || (dirs.find((item) => item.kind === 'backend') || {}).releaseId
        || '';
    const activeWebId = active.web.active
        || (dirs.find((item) => item.kind === 'web') || {}).releaseId
        || '';

    // 只有后端归档里带客户端版本常量（dist/config/config.js）。前端归档本身没有这个文件，
    // 直接判定会永远「不兼容」，所以先算完后端的结论，前端沿用配套后端的那一份。
    const compatByRelease = new Map<string, ReleaseCompatInfo>();
    for (const item of dirs) {
        if (item.kind !== 'backend') continue;
        const versions = releaseCompat.readReleaseVersions(item.dir);
        compatByRelease.set(item.releaseId, releaseCompat.compareReleaseVersions(versions, liveVersions));
    }

    const releases: RollbackReleaseItem[] = [];
    for (const item of dirs) {
        const meta = layout.readReleaseMeta(item.dir) || {};
        const pairedId = pairIndex.get(item.releaseId) || '';
        const compat: ReleaseCompatInfo = item.kind === 'backend'
            ? (compatByRelease.get(item.releaseId) || { compatible: false, outdated: true, reasons: ['无法读取版本信息'] })
            : (compatByRelease.get(pairedId) || { compatible: true, outdated: false, reasons: [] });
        const isActive = item.kind === 'backend' ? item.releaseId === activeBackendId : item.releaseId === activeWebId;
        const isPrevious = item.kind === 'backend'
            ? item.releaseId === active.backend.previous
            : item.releaseId === active.web.previous;
        const artifactIntact = fs.existsSync(path.join(item.dir, 'release-meta.json'))
            && (item.kind === 'backend'
                ? fs.existsSync(path.join(item.dir, 'dist')) && fs.existsSync(path.join(item.dir, 'client.js'))
                : fs.existsSync(path.join(item.dir, 'dist')));
        releases.push({
            releaseId: item.releaseId,
            kind: item.kind,
            createdAt: Number(meta.createdAt) || item.createdAt,
            commit: typeof meta.commit === 'string' ? meta.commit : '',
            shortCommit: typeof meta.shortCommit === 'string' && meta.shortCommit ? meta.shortCommit : item.shortCommit,
            commitSubject: typeof meta.commitSubject === 'string' ? meta.commitSubject : '',
            version: typeof meta.version === 'string' ? meta.version : '',
            build: Number(meta.build) || 0,
            pairedReleaseId: pairedId,
            sizeBytes: Number(meta.artifactSizeBytes) || 0,
            isActive,
            isPrevious,
            canRollback: artifactIntact && !isActive,
            canDelete: !isActive && !isPrevious,
            compat,
        });
    }

    const activeBackend = releases.find((item) => item.releaseId === activeBackendId);
    const summary: ReleasesSummary = {
        totalCount: releases.length,
        rollbackableCount: releases.filter((item) => item.canRollback).length,
        incompatibleCount: releases.filter((item) => !item.compat.compatible).length,
        totalSizeBytes: releases.reduce((sum, item) => sum + item.sizeBytes, 0),
        incompatibleSizeBytes: releases
            .filter((item) => !item.compat.compatible)
            .reduce((sum, item) => sum + item.sizeBytes, 0),
        orphanWebCount: releases.filter((item) => item.kind === 'web' && !item.pairedReleaseId).length,
        orphanSizeBytes: releases
            .filter((item) => item.kind === 'web' && !item.pairedReleaseId)
            .reduce((sum, item) => sum + item.sizeBytes, 0),
        activeBackendId,
        activeWebId,
        // 归档里记的是「这个快照构建时的版本」，比磁盘上的 version.json 更贴近真正在跑的代码。
        activeVersion: activeBackend?.version || live.version,
        activeBuild: activeBackend?.build || live.build,
    };

    return { releases, active, summary };
}

module.exports = {
    listReleases,
};
