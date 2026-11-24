import type { Application } from 'express';
import type { Server } from 'node:http';
import type { Server as SocketIOServer } from 'socket.io';
export {};

/**
 * AdminContext factory
 * Creates and holds all shared state for the admin server.
 */

export interface AdminContext {
    tokens: Set<string>;
    app: Application | null;
    server: Server | null;
    io: SocketIOServer | null;
    provider: any;
    /** 在线更新与版本回滚服务；初始化失败时为 null，路由层会给出明确原因。 */
    systemUpdate: any | null;
}

function createAdminContext(dataProvider: any, options: { systemUpdate?: any } = {}): AdminContext {
    const tokens = new Set<string>();
    return {
        tokens,
        app: null,
        server: null,
        io: null,
        provider: dataProvider,
        systemUpdate: options.systemUpdate || null,
    };
}

module.exports = { createAdminContext };
