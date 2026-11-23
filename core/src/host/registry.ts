export {};

/**
 * 连接宿主注册表：把「账号 → 宿主管道名 / 令牌 / PID」落盘。
 *
 * 为什么需要它：宿主进程是独立进程，主进程重启（热更新、崩溃拉起）时它继续持有
 * 游戏连接。新主进程必须能找回这条管道并拿到同一个令牌，否则接管不了这条连接，
 * 连接就只能等宿主闲置回收后重新登录。
 *
 * 落盘位置：data/host-registry.json（可用 FARM_HOST_REGISTRY 覆盖，测试用）。
 */

const fs = require('node:fs');
const path = require('node:path');
const { getDataFile } = require('../config/runtime-paths');

const REGISTRY_VERSION = 1;

function registryFile(): string {
    const override = String(process.env.FARM_HOST_REGISTRY || '').trim();
    return override || getDataFile('host-registry.json');
}

function ensureParent(file: string): void {
    const dir = path.dirname(file);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

/** 读取注册表；文件缺失 / 损坏一律当作空表（不能因为一份坏文件挡住账号启动）。 */
function readHostRegistry(): Record<string, any> {
    try {
        const parsed = JSON.parse(fs.readFileSync(registryFile(), 'utf8'));
        const hosts = parsed && typeof parsed === 'object' ? parsed.hosts : null;
        return hosts && typeof hosts === 'object' ? hosts : {};
    } catch {
        return {};
    }
}

/** 原子写：先写临时文件再改名，避免主进程与宿主同时写时读到半截 JSON。 */
function writeHostRegistry(hosts: Record<string, any>): void {
    const file = registryFile();
    try {
        ensureParent(file);
        const tmp = `${file}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify({ version: REGISTRY_VERSION, hosts }, null, 2), 'utf8');
        fs.renameSync(tmp, file);
    } catch {
        // 注册表只是加速接管：写失败时退化为「重新起宿主」，不影响账号运行。
    }
}

/** 进程是否存在：EPERM 说明进程在但不属于当前用户，同样算「活着」。 */
function isProcessAlive(pid: any): boolean {
    const value = Number(pid) || 0;
    if (value <= 0) return false;
    try {
        process.kill(value, 0);
        return true;
    } catch (error: any) {
        return String(error?.code || '') === 'EPERM';
    }
}

/** 找出该账号仍然存活的宿主；管道名不一致说明账号被重建过，旧条目直接丢弃。 */
function findLiveHost(accountId: string, expectedPipe?: string): any {
    const id = String(accountId || '');
    if (!id) return null;
    const hosts = readHostRegistry();
    const entry = hosts[id];
    if (!entry) return null;
    const pipe = String(entry.pipe || '');
    const token = String(entry.token || '');
    if (!pipe || !token) {
        removeHostEntry(id);
        return null;
    }
    if (expectedPipe && pipe !== expectedPipe) {
        removeHostEntry(id);
        return null;
    }
    if (!isProcessAlive(entry.pid)) {
        removeHostEntry(id);
        return null;
    }
    return {
        accountId: id,
        pipe,
        token,
        pid: Number(entry.pid) || 0,
        startedAt: Number(entry.startedAt) || 0,
    };
}

function upsertHostEntry(entry: { accountId: string; pipe: string; token: string; pid: number; startedAt?: number }): void {
    const id = String(entry?.accountId || '');
    if (!id || !entry.pipe || !entry.token) return;
    const hosts = readHostRegistry();
    hosts[id] = {
        pipe: String(entry.pipe),
        token: String(entry.token),
        pid: Number(entry.pid) || 0,
        startedAt: Number(entry.startedAt) || Date.now(),
    };
    writeHostRegistry(hosts);
}

/** 只删自己的条目：避免旧宿主退出时把新宿主的注册信息一起抹掉。 */
function removeHostEntry(accountId: string, pid?: number): void {
    const id = String(accountId || '');
    if (!id) return;
    const hosts = readHostRegistry();
    const entry = hosts[id];
    if (!entry) return;
    if (pid !== undefined && Number(entry.pid) !== Number(pid)) return;
    delete hosts[id];
    writeHostRegistry(hosts);
}

module.exports = {
    registryFile,
    readHostRegistry,
    writeHostRegistry,
    isProcessAlive,
    findLiveHost,
    upsertHostEntry,
    removeHostEntry,
};
