import type { Application, Request, Response } from 'express';
import type { AdminContext } from './context';
export {};

/**
 * 面板在线更新与版本回滚接口。
 *
 * 全部挂在管理端鉴权之后（由 index.ts 统一 `createAuthRequired`）。这里只做参数收敛与
 * 错误码透传：`system-update` 服务抛出的错误自带 `statusCode`，直接用它回应，避免所有
 * 失败都被压成 500 让面板分不清「参数不对」和「服务器炸了」。
 */

const { createAuthRequired } = require('./middleware');
const { readCountOr } = require('../../utils/input-guards');

function respondError(res: Response, err: any, fallback = 'SYSTEM_UPDATE_ERROR'): void {
    const statusCode = Number(err?.statusCode);
    res.status(Number.isFinite(statusCode) && statusCode >= 400 && statusCode < 600 ? statusCode : 500).json({
        ok: false,
        error: err?.message || '操作失败',
        code: err?.code || fallback,
    });
}

function mountSystemUpdateRoutes(app: Application, ctx: AdminContext): void {
    app.use('/api/system-update', createAuthRequired(ctx));

    if (!ctx.systemUpdate) {
        // 没有实例时给出明确原因，而不是 404 让面板猜。
        app.get('/api/system-update/status', (_req: Request, res: Response) => {
            res.json({
                ok: true,
                data: {
                    mode: 'unknown',
                    gitSupported: false,
                    unsupportedReason: '在线更新服务未初始化',
                    applySupported: false,
                    applyUnsupportedReason: '在线更新服务未初始化',
                    releases: [],
                    releasesSummary: null,
                    job: null,
                },
            });
        });
        app.use('/api/system-update', (_req: Request, res: Response) => {
            res.status(503).json({ ok: false, error: '在线更新服务未初始化', code: 'SERVICE_UNAVAILABLE' });
        });
        return;
    }

    const service = ctx.systemUpdate;

    app.get('/api/system-update/status', async (_req: Request, res: Response) => {
        try {
            res.json({ ok: true, data: await service.getStatus() });
        }
        catch (e: any) {
            respondError(res, e);
        }
    });

    app.post('/api/system-update/check', async (_req: Request, res: Response) => {
        try {
            const status = await service.checkForUpdates();
            res.json({ ok: true, data: status });
        }
        catch (e: any) {
            respondError(res, e, 'GIT_FETCH_FAILED');
        }
    });

    app.post('/api/system-update/pull', async (_req: Request, res: Response) => {
        try {
            const result = await service.pullUpdates();
            res.json({ ok: true, data: result });
        }
        catch (e: any) {
            respondError(res, e, 'GIT_PULL_FAILED');
        }
    });

    app.post('/api/system-update/apply', async (req: Request, res: Response) => {
        try {
            const pullFirst = (req.body && req.body.pullFirst) !== false;
            const result = await service.applyUpdate({ pullFirst });
            res.json({ ok: true, data: result });
        }
        catch (e: any) {
            respondError(res, e, 'APPLY_FAILED');
        }
    });

    app.post('/api/system-update/rollback', async (req: Request, res: Response) => {
        try {
            const body = req.body || {};
            const result = await service.rollback({
                releaseId: typeof body.releaseId === 'string' ? body.releaseId : '',
                confirmIncompatible: body.confirmIncompatible === true,
            });
            res.json({ ok: true, data: result });
        }
        catch (e: any) {
            respondError(res, e, 'ROLLBACK_FAILED');
        }
    });

    app.post('/api/system-update/releases/delete', async (req: Request, res: Response) => {
        try {
            const body = req.body || {};
            const result = await service.deleteReleases({
                releaseIds: Array.isArray(body.releaseIds) ? body.releaseIds : [],
                cleanOrphans: body.cleanOrphans === true,
            });
            res.json({ ok: true, data: result });
        }
        catch (e: any) {
            respondError(res, e, 'DELETE_RELEASE_FAILED');
        }
    });

    app.get('/api/system-update/job', (req: Request, res: Response) => {
        try {
            // 日志尾巴长度：非法值回落到 60，上限 300，避免一次请求把整个日志文件拉回来。
            const tail = readCountOr(req.query.tail, 60, 'tail', 300);
            res.json({
                ok: true,
                data: {
                    job: service.readJob(),
                    log: service.readJobLog(tail),
                },
            });
        }
        catch (e: any) {
            respondError(res, e);
        }
    });
}

module.exports = { mountSystemUpdateRoutes };
