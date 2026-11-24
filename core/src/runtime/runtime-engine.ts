export {};
const { fork } = require('node:child_process');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const store = require('../models/store');
const { updateRuntimeConfig } = require('../config/config');
const { sendPushooMessage } = require('../services/push');
const { createDataProvider } = require('./data-provider');
const { createReloginReminderService } = require('./relogin-reminder');
const { createRuntimeState } = require('./runtime-state');
const { createWorkerManager } = require('./worker-manager');
const { startWxKeepAlive, stopWxKeepAlive, applyWxKeepAliveConfig, notifyAccountOffline, cancelPendingRelogin } = require('../services/wx-keepalive');
const { recordAutoRefreshSuccess, recordAutoRefreshFailure } = require('../services/preflight-stats');

const OPERATION_KEYS = ['harvest', 'water', 'weed', 'bug', 'farming', 'fertilize', 'plant', 'steal', 'helpWater', 'helpWeed', 'helpBug', 'goldenBugClear', 'goldenBugPut', 'taskClaim', 'sell', 'upgrade', 'levelUp', 'tongQiGift'];

interface RuntimeEngineOptions {
    processRef?: any;
    mainEntryPath?: string;
    workerScriptPath?: string;
    runtimeMode?: string;
    onStatusSync?: (accountId: string, status: any, accountName?: string) => void;
    onLog?: (entry: any, accountId?: string, accountName?: string) => void;
    onAccountLog?: (entry: any) => void;
    startAdminServer?: (dataProvider: any) => void;
}

function createRuntimeEngine(options: RuntimeEngineOptions = {}) {
    const processRef = options.processRef || process;
    // Detect if running from source (tsx) or compiled (node)
    const isRunningFromSource = __dirname.includes(`${path.sep}src${path.sep}`);
    const fileExt = isRunningFromSource ? '.ts' : '.js';
    const mainEntryPath = options.mainEntryPath || path.join(__dirname, `../../client${fileExt}`);
    const workerScriptPath = options.workerScriptPath || path.join(__dirname, `../core/worker${fileExt}`);
    const runtimeMode = String(options.runtimeMode || processRef.env.FARM_RUNTIME_MODE || 'thread').toLowerCase();
    const onStatusSync = typeof options.onStatusSync === 'function' ? options.onStatusSync : null;
    const onLog = typeof options.onLog === 'function' ? options.onLog : null;
    const onAccountLog = typeof options.onAccountLog === 'function' ? options.onAccountLog : null;
    const startAdminServer = typeof options.startAdminServer === 'function' ? options.startAdminServer : null;

    const runtimeState = createRuntimeState({
        store,
        operationKeys: OPERATION_KEYS,
    });
    const {
        workers,
        globalLogs: GLOBAL_LOGS,
        accountLogs: ACCOUNT_LOGS,
        runtimeEvents,
        nextConfigRevision,
        buildConfigSnapshotForAccount,
        log,
        addAccountLog,
        normalizeStatusForPanel,
        buildDefaultStatus,
        filterLogs,
    } = runtimeState;

    const reloginReminder = createReloginReminderService({
        store,
        sendPushooMessage,
        log,
    });

    const {
        getOfflineAutoDeleteMs,
        triggerOfflineReminder,
        sendConfiguredPush,
    } = reloginReminder;

    // 保活回调要在 workerManager 之后才能拿到 restartWorker，这里用一层间接引用避免循环依赖。
    const wxKeepAliveBridge: { notify?: (accountId: string, accountName: string, reason: string) => void } = {};

    const { startWorker, stopWorker, restartWorker, callWorkerApi, stopAllHosts } = createWorkerManager({
        fork,
        WorkerThread: Worker,
        runtimeMode,
        processRef,
        mainEntryPath,
        workerScriptPath,
        workers,
        globalLogs: GLOBAL_LOGS,
        log,
        addAccountLog,
        normalizeStatusForPanel,
        buildConfigSnapshotForAccount,
        getOfflineAutoDeleteMs,
        triggerOfflineReminder,
        sendConfiguredPush,
        addOrUpdateAccount: store.addOrUpdateAccount,
        deleteAccount: store.deleteAccount,
        onStatusSync: (accountId: string, status: any, accountName?: string) => {
            runtimeEvents.emit('status', { accountId, status, accountName });
            if (onStatusSync) onStatusSync(accountId, status, accountName);
        },
        onWorkerLog: (entry: any, accountId: string, accountName?: string) => {
            runtimeEvents.emit('worker_log', { entry, accountId, accountName });
            if (onLog) onLog(entry, accountId, accountName);
        },
        onAccountOffline: (accountId: string, accountName: string, reason: string) => {
            if (typeof wxKeepAliveBridge.notify === 'function') wxKeepAliveBridge.notify(accountId, accountName, reason);
        },
    });

    wxKeepAliveBridge.notify = (accountId: string, _accountName: string, reason: string) => {
        notifyAccountOffline(accountId, reason);
    };

    function startAccountKeepAlive(): void {
        startWxKeepAlive({
            restartWorker: (account: any) => restartWorker(account),
            isAccountRunning: (accountId: string) => !!workers[String(accountId)],
            log,
            addAccountLog,
            // 自动续期账本：只记到期前预防 / 掉线重登，供账号卡片展示无人值守结果。
            recordPreflightResult: (accountId: string, ok: boolean, at: number) => {
                if (ok) recordAutoRefreshSuccess(accountId, at);
                else recordAutoRefreshFailure(accountId, at);
            },
        });
    }
    const dataProvider = createDataProvider({
        workers,
        globalLogs: GLOBAL_LOGS,
        accountLogs: ACCOUNT_LOGS,
        store,
        getAccounts: store.getAccounts,
        callWorkerApi,
        buildDefaultStatus,
        normalizeStatusForPanel,
        filterLogs,
        addAccountLog,
        nextConfigRevision,
        broadcastConfigToWorkers,
        buildConfigSnapshotForAccount,
        broadcastGameConfigReload,
        startWorker,
        stopWorker,
        restartWorker,
        // 手动停止 / 启动 / 重启要先撤掉「等待重登」，否则定时器到点会把账号拉回来。
        cancelPendingRelogin,
    });

    runtimeEvents.on('log', (entry: any) => {
        if (onLog) onLog(entry, entry && entry.accountId ? entry.accountId : '', entry && entry.accountName ? entry.accountName : '');
    });
    runtimeEvents.on('account_log', (entry: any) => {
        if (onAccountLog) onAccountLog(entry);
    });

    function broadcastConfigToWorkers(targetAccountId = ''): void {
        const targetId = String(targetAccountId || '').trim();
        for (const [accId, worker] of Object.entries(workers)) {
            if (targetId && String(accId) !== targetId) continue;
            const snapshot = buildConfigSnapshotForAccount(accId);
            try {
                (worker as any).process.send({ type: 'config_sync', config: snapshot });
            } catch {
                // ignore IPC failures for exited workers
            }
        }
    }

    function broadcastGameConfigReload(): void {
        for (const worker of Object.values(workers)) {
            try {
                (worker as any).process.send({ type: 'reload_config' });
            } catch {
                // ignore IPC failures for exited workers
            }
        }
    }

    /**
     * 服务启动后自动登录已保存的账号。
     * 必须走 dataProvider.startAccount：微信账号会在启动前用长效凭证续期换 Code，
     * 直接 startWorker 会拿 accounts.json 里已被消费的一次性旧 Code 建立连接而被网关拒绝。
     */
    async function startAllAccounts(): Promise<void> {
        const accounts = (store.getAccounts().accounts || []);
        if (!accounts.length) {
            log('系统', '未发现账号，请访问管理面板添加账号');
            return;
        }
        log('系统', `发现 ${accounts.length} 个账号，正在自动登录...`);
        for (let i = 0; i < accounts.length; i += 1) {
            const acc: any = accounts[i];
            const id = String(acc.id || '');
            const name = String(acc.name || acc.nick || id);
            try {
                const started = await dataProvider.startAccount(id);
                if (started === false) {
                    // 换码失败且凭证已失效：账号根本没起来，日志已经由 startAccount 写明原因，
                    // 这里只补一条汇总，避免再写一次「已自动登录」的假成功。
                    log('错误', `账号 ${name} 未能自动登录，详见账号日志`, { accountId: id, accountName: name });
                }
                else {
                    // 「已发起」而不是「已登录」：startAccount 返回 true 只代表换码/fork 这一步走完了，
                    // 真正有没有连上要看后面的状态推送。之前这里直接写「已随服务启动自动登录」，
                    // 而容器里网关 400 常常在 1 秒后就到，日志却留着一条成功记录，排查时会被带偏。
                    addAccountLog('auto_login', `账号 ${name} 已发起自动登录，等待连接结果`, id, name);
                }
            }
            catch (error: any) {
                log('错误', `账号 ${name} 自动登录失败: ${(error && error.message) || String(error)}`, {
                    accountId: id,
                    accountName: name,
                });
            }
            // 多账号错峰启动，避免同时建连打满网关与登录限流。
            if (i < accounts.length - 1) {
                await new Promise(resolve => setTimeout(resolve, 1500));
            }
        }
    }

    async function start(options: { startAdminServer?: boolean; autoStartAccounts?: boolean } = {}): Promise<void> {
        const shouldStartAdminServer = options.startAdminServer !== false;
        const shouldAutoStartAccounts = options.autoStartAccounts !== false;

        const savedSystemConfig = store.getSystemConfig();
        if (savedSystemConfig) {
            updateRuntimeConfig(savedSystemConfig);
            log('系统', `已加载系统配置: serverUrl=${savedSystemConfig.serverUrl}, clientVersion=${savedSystemConfig.clientVersion}, platform=${savedSystemConfig.platform}`);
        }

        if (shouldStartAdminServer && startAdminServer) {
            startAdminServer(dataProvider);
        }

        // 保活必须**先于**自动登录装上：启动批次的账号照样会掉线，而且这批最脆弱
        // （容器刚起来时 DNS/网络可能还没就绪、换码大概率失败）。之前它排在自动登录之后，
        // 启动期那几次掉线落在「保活依赖还没注入」的空窗里——`wx-keepalive` 的 log()
        // 在依赖缺失时是静默 no-op，连一条「N 秒后自动重登」都不会留下，账号就此停住。
        startAccountKeepAlive();

        if (shouldAutoStartAccounts) {
            await startAllAccounts();
        }
    }

    function stopAllAccounts(): void {
        for (const accountId of Object.keys(workers)) {
            stopWorker(accountId);
        }
        // 连接宿主不随 worker 退出：主进程整体停服时统一回收，避免孤儿进程占着连接。
        stopAllHosts();
    }

    return {
        store,
        runtimeEvents,
        workers,
        dataProvider,
        start,
        startAllAccounts,
        stopAllAccounts,
        broadcastConfigToWorkers,
        broadcastGameConfigReload,
        startWorker,
        stopWorker,
        restartWorker,
        callWorkerApi,
        log,
        addAccountLog,
        startAccountKeepAlive,
        stopAccountKeepAlive: stopWxKeepAlive,
        applyAccountKeepAliveConfig: applyWxKeepAliveConfig,
    };
}

module.exports = {
    createRuntimeEngine,
};
