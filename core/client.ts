export {};
/**
 * 主程序 - 进程管理器
 * 负责启动 Web 面板，并管理多个 Bot 子进程
 */
const path = require('node:path');
const fs = require('node:fs');

// tsx/bun 直接跑 client.ts 时用 src，避免 stale dist 缺新路由。
// node client.js / 打包产物仍优先加载已编译的 dist。
const runningFromSource = /\.[cm]?tsx?$/.test(__filename);
const distDir = path.join(__dirname, 'dist');
const baseDir = !runningFromSource && fs.existsSync(distDir) ? './dist' : './src';

const {
    startAdminServer,
    emitRealtimeStatus,
    emitRealtimeLog,
    emitRealtimeAccountLog,
} = require(`${baseDir}/controllers/admin`);
const { createRuntimeEngine } = require(`${baseDir}/runtime/runtime-engine`);
const { createModuleLogger } = require(`${baseDir}/services/logger`);
const mainLogger = createModuleLogger('main');

// 最后一道网：漏到进程级的 Promise 拒绝只记日志，不让进程退出。
//
// 主进程管着所有账号，因为一次 HTTP 请求里的意外抛错导致全部掉线是不划算的
// （实测 `/api/friend-blacklist` 在 provider 返回非数组时会一击打死服务）。
// 真正的修法在 controllers/admin/index.ts 的 guardAsyncRoutes：把路由抛错转成 500。
// 这里只兜住「还没被兜住」的残余，避免一个未预料的拒绝直接终止服务。
process.on('unhandledRejection', (reason: any) => {
    mainLogger.error('unhandled rejection at process level', {
        error: String((reason && reason.message) || reason),
        stack: String((reason && reason.stack) || '').split('\n').slice(0, 4).join(' | '),
    });
});

// 未捕获的同步异常会让进程处于未知状态，继续跑风险更大：记录完整堆栈后退出，
// 交给容器重启，至少日志里能查到真正原因（默认行为只会打到 stdout）。
process.on('uncaughtException', (error: any) => {
    mainLogger.error('uncaught exception, exiting', {
        error: String((error && error.message) || error),
        stack: String((error && error.stack) || '').split('\n').slice(0, 8).join(' | '),
    });
    process.exit(1);
});

// 打包后 worker 由当前可执行文件以 --worker 模式启动
const isWorkerProcess: boolean = process.env.FARM_WORKER === '1';

/** 主进程的运行引擎句柄：停服钩子要拿它停账号，所以不能只在 else 分支里当局部变量。 */
let runtimeEngineRef: any = null;

if (isWorkerProcess) {
    require(`${baseDir}/core/worker`);
} else {
    // 服务启动自动登录：默认开启，可用 FARM_AUTO_START_ACCOUNTS=0 或系统设置关闭。
    const store = require(`${baseDir}/models/store`);
    const { resolveAutoStartAccounts } = require(`${baseDir}/config/config`);
    const savedSystemConfig = typeof store.getSystemConfig === 'function' ? store.getSystemConfig() : null;
    const autoStartAccounts = resolveAutoStartAccounts(savedSystemConfig?.autoStartAccounts);
    mainLogger.info('auto login on boot', { autoStartAccounts });

    const runtimeEngine = createRuntimeEngine({
        processRef: process,
        mainEntryPath: __filename,
        startAdminServer,
        onStatusSync: (accountId: string, status: any) => {
            emitRealtimeStatus(accountId, status);
        },
        onLog: (entry: any, accountId?: string) => {
            // 确保日志条目包含 accountId
            if (accountId && entry) {
                entry.accountId = accountId;
            }
            emitRealtimeLog(entry);
        },
        onAccountLog: (entry: any) => {
            emitRealtimeAccountLog(entry);
        },
    });
    runtimeEngineRef = runtimeEngine;

    runtimeEngine.start({
        startAdminServer: true,
        autoStartAccounts,
    }).catch((err: any) => {
        mainLogger.error('runtime bootstrap failed', { error: err && err.message ? err.message : String(err) });
    });
}

/** 停服时等凭证操作收尾的上限。微信换码一次通常 1~3 秒，5 秒足够，再长会拖慢 docker stop。 */
const CREDENTIAL_DRAIN_TIMEOUT_MS = 5000;

/**
 * 优雅停服。
 *
 * 容器里 node 直接当 PID 1（`CMD ["node", "client.js"]`），而 Linux 内核对 PID 1 的
 * **默认动作**信号处理是「直接忽略」——SIGTERM 没有注册 handler 时内核不会终止它，
 * `docker stop` 等完宽限期后一律 SIGKILL。这一刀正好会切断
 * 「refreshtoken 已刷新、新值还没落盘」的窗口：服务端已经把旧 token 作废了，本地却还是旧值，
 * 于是账号里永久留下一个死 token，之后每次启动都是 -109，只能重新扫码。
 *
 * 所以这里显式接管信号：先等在途凭证操作收尾，再停账号，最后正常退出。
 * 显式注册 handler 之后内核会正常投递信号，PID 1 身份不再是障碍；
 * compose 里的 `init: true` 另行负责回收僵尸子进程，两件事互不替代。
 */
let shuttingDown = false;
async function gracefulShutdown(signal: string): Promise<void> {
    if (shuttingDown) {
        mainLogger.warn('graceful shutdown already in progress', { signal });
        return;
    }
    shuttingDown = true;
    const startedAt = Date.now();
    mainLogger.info('graceful shutdown begin', { signal });
    try {
        const { waitForCredentialIdle, credentialBusyCount } = require(`${baseDir}/services/wx-credential`);
        const pending = Number(credentialBusyCount()) || 0;
        if (pending > 0) {
            const drained = await waitForCredentialIdle(CREDENTIAL_DRAIN_TIMEOUT_MS);
            mainLogger.info('credential drain finished', {
                pending,
                drained: !!drained,
                elapsedMs: Date.now() - startedAt,
            });
        }
    }
    catch (err: any) {
        mainLogger.warn('credential drain failed', { error: String(err && err.message ? err.message : err) });
    }
    try {
        if (runtimeEngineRef && typeof runtimeEngineRef.stopAllAccounts === 'function') {
            runtimeEngineRef.stopAllAccounts();
        }
    }
    catch (err: any) {
        mainLogger.warn('stop all accounts failed', { error: String(err && err.message ? err.message : err) });
    }
    mainLogger.info('graceful shutdown done', { elapsedMs: Date.now() - startedAt });
    process.exit(0);
}

// worker 不需要这套：它由主进程 fork/终止，而且凭证刷新只在主进程里跑。
if (!isWorkerProcess) {
    process.on('SIGTERM', () => { void gracefulShutdown('SIGTERM'); });
    process.on('SIGINT', () => { void gracefulShutdown('SIGINT'); });
}
