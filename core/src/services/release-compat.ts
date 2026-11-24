export {};

/**
 * 版本归档兼容性判定。
 *
 * 版本归档（releases/ 目录）里放的是**已经构建好**的产物快照。回滚时直接把快照覆盖回
 * `core/dist`、`core/client.js`、`web/dist` 即可，不需要重新构建。这里只负责「这个旧快照
 * 还能不能跟当前的游戏服务端说上话」——判断依据是腾讯客户端版本号，写在构建产物里，
 * 所以只读文件、绝不 require 旧代码（旧代码可能有副作用，也可能依赖已经不存在的模块）。
 */

const fs = require('node:fs');
const path = require('node:path');

const RELEASE_META_FILENAME = 'release-meta.json';

function readOptionalText(filename: string): string {
    try {
        return fs.readFileSync(filename, 'utf8');
    }
    catch (err: any) {
        if (err?.code === 'ENOENT') return '';
        return '';
    }
}

function readReleaseMeta(dir: string): any {
    const text = readOptionalText(path.join(dir, RELEASE_META_FILENAME));
    if (!text) return null;
    try {
        return JSON.parse(text);
    }
    catch {
        return null;
    }
}

/**
 * 从快照里正则抠出客户端版本号，不执行快照里的任何代码。
 *
 * `dist/config/config.js` 是构建产物，常量以 `const DEFAULT_CLIENT_VERSION = '...'` 形式
 * 出现在文本里，正则足够稳；比 require 安全得多。
 */
function readReleaseVersions(dir: string): { qq: string; wx: string } | null {
    if (!dir) return null;
    const config = readOptionalText(path.join(dir, 'dist', 'config', 'config.js'));
    if (!config) return null;
    const qq = /\bDEFAULT_CLIENT_VERSION\s*=\s*['"]([^'"]+)['"]/.exec(config)?.[1];
    const wx = /\bDEFAULT_WX_CLIENT_VERSION\s*=\s*['"]([^'"]+)['"]/.exec(config)?.[1];
    if (!qq || !wx) return null;
    return { qq, wx };
}

export interface ReleaseCompatInfo {
    compatible: boolean;
    outdated: boolean;
    reasons: string[];
}

/**
 * 比对快照与当前运行版本。
 *
 * 返回 `compatible === false` 时**不阻断**回滚，只是让面板提示风险，由用户二次确认——
 * 游戏客户端版本升级往往只是小版本号变动，旧构建通常照样能用，一刀切禁止反而会把
 * 用户卡死在「新版有 BUG、旧版不给回」的境地。
 */
function compareReleaseVersions(
    target: { qq: string; wx: string } | null,
    current: { qq: string; wx: string } | null,
): ReleaseCompatInfo {
    if (!target) {
        return { compatible: false, outdated: true, reasons: ['备份缺少版本信息，无法确认可回滚性'] };
    }
    if (!current) {
        return { compatible: true, outdated: false, reasons: [] };
    }
    const reasons: string[] = [];
    if (target.qq !== current.qq) reasons.push(`QQ 客户端版本不同（${target.qq} ≠ ${current.qq}）`);
    if (target.wx !== current.wx) reasons.push(`微信客户端版本不同（${target.wx} ≠ ${current.wx}）`);
    return { compatible: reasons.length === 0, outdated: reasons.length > 0, reasons };
}

module.exports = {
    RELEASE_META_FILENAME,
    readReleaseMeta,
    readReleaseVersions,
    compareReleaseVersions,
};
