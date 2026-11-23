export {};

/**
 * 连接宿主进程入口：每个账号一个，由主进程 fork。
 *
 * 环境变量（由 worker-manager 注入）：
 *   FARM_HOST_ACCOUNT_ID  账号 id（用于日志与管道命名）
 *   FARM_HOST_PIPE        与 worker 通信的管道路径
 *   FARM_HOST_TOKEN       管道共享密钥（worker 首帧 hello 必须携带）
 *
 * 生命周期：宿主不随 worker 停止而退出；只有主进程 stop 账号或进程收到 SIGTERM 时才关闭，
 * 这样业务 worker 重启（热更新）期间游戏连接与心跳保持不断。
 */

const { HostServer } = require('./host-server');

const accountId = String(process.env.FARM_HOST_ACCOUNT_ID || '');
const pipeName = String(process.env.FARM_HOST_PIPE || '');
const token = String(process.env.FARM_HOST_TOKEN || '');

if (!pipeName || !token) {
    console.error('[host] 缺少 FARM_HOST_PIPE / FARM_HOST_TOKEN，连接宿主无法启动');
    process.exit(2);
}

const server = new HostServer({ accountId, pipeName, token });

function shutdown(reason: string): void {
    try {
        server.shutdown(reason);
    } catch {}
    setTimeout(() => process.exit(0), 50).unref?.();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
// 主进程退出（热更新 / 被 kill）时 IPC 通道会断：这里只记一笔，**不退出**。
// 连接与心跳继续跑，等新主进程起来后按 data/host-registry.json 重新 attach；
// 若一直没人接管，HostServer 的看门狗会在闲置超时后自行回收。
process.on('disconnect', () => {
    console.warn('[host] 主进程已退出，连接与心跳继续保持，等待重新接管');
});
// 父进程控制台消失后 stdout 写入会抛 EPIPE，不能让它把宿主带崩。
for (const stream of [process.stdout, process.stderr] as any[]) {
    try { stream?.on?.('error', () => {}); } catch {}
}
process.on('uncaughtException', (error: any) => {
    console.error(`[host] 未捕获异常: ${error?.stack || error}`);
});
process.on('unhandledRejection', (reason: any) => {
    console.error(`[host] 未处理的 Promise 拒绝: ${reason?.stack || reason}`);
});

server.listen().then(() => {
    // 告知主进程「宿主已就绪」，主进程随后才允许 worker 启动。
    try { process.send?.({ type: 'host_ready', accountId }); } catch {}
}).catch((error: any) => {
    console.error(`[host] 启动失败: ${error?.message || error}`);
    process.exit(1);
});
