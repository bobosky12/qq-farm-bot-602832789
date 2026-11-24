export {};

/**
 * 前端构建信息：让后端知道「现在服务器上摆着的这份前端是哪个版本」。
 *
 * 用途只有一个——浏览器标签页里跑的 JS 可能是刷新之前加载的旧包。更新完成后后端会通过
 * socket 广播当前前端构建号，前端拿自己的构建号一比就知道要不要提示刷新，避免出现
 * 「更新成功但界面看起来没变」的错觉。
 */

const fs = require('node:fs');
const path = require('node:path');

export interface WebBuildInfo {
    buildId: string;
    appVersion: string;
    appBuild: number;
    builtAt: number;
}

let cached: { filePath: string; mtimeMs: number; size: number; info: WebBuildInfo | null } | null = null;

function resolveWebDistDir(repoRoot: string): string {
    return path.join(path.resolve(repoRoot), 'web', 'dist');
}

function readWebBuildInfo(repoRoot: string): WebBuildInfo | null {
    const filePath = path.join(resolveWebDistDir(repoRoot), 'version.json');
    try {
        const stat = fs.statSync(filePath);
        if (cached
            && cached.filePath === filePath
            && cached.mtimeMs === stat.mtimeMs
            && cached.size === stat.size) {
            return cached.info;
        }
        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        const buildId = typeof parsed?.buildId === 'string' ? parsed.buildId.trim() : '';
        const info: WebBuildInfo | null = buildId
            ? {
                buildId,
                appVersion: typeof parsed?.appVersion === 'string' ? parsed.appVersion.trim() : '',
                appBuild: Number(parsed?.appBuild) || 0,
                builtAt: Number(parsed?.builtAt) || 0,
            }
            : null;
        cached = { filePath, mtimeMs: stat.mtimeMs, size: stat.size, info };
        return info;
    }
    catch {
        cached = null;
        return null;
    }
}

function getActiveWebBuildId(repoRoot: string): string {
    return readWebBuildInfo(repoRoot)?.buildId || '';
}

module.exports = {
    readWebBuildInfo,
    getActiveWebBuildId,
};
