export {};

/**
 * 连接宿主的命名与开关（主进程 / 宿主 / worker 三方共用的小模块）。
 *
 * 单独成文件的原因：主进程只需要「管道名 + 共享令牌 + 是否启用」，
 * 不应该为了这三个函数去加载 host-server（它会拉起 ws / proto / TSDK / ACE）。
 */

const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');

/** 主进程侧开关：FARM_SOCKET_HOST=1 时才启用「连接宿主」，默认保持原有直连行为。 */
function isSocketHostEnabled(env: any = process.env): boolean {
    return String(env?.FARM_SOCKET_HOST || '') === '1';
}

/** 宿主与 worker 之间的共享密钥：每次启动宿主重新生成，避免本机其它进程随意接管。 */
function createHostToken(): string {
    return crypto.randomBytes(24).toString('hex');
}

/** 每条连接一个管道名（Windows named pipe / 其它平台 Unix socket）。 */
function hostPipeName(accountId: string): string {
    const safe = String(accountId || 'default').replace(/[^\w-]/g, '_');
    if (process.platform === 'win32') return `\\\\.\\pipe\\qqfarm-host-${safe}`;
    return path.join(os.tmpdir(), `qqfarm-host-${safe}.sock`);
}

module.exports = { isSocketHostEnabled, createHostToken, hostPipeName };
