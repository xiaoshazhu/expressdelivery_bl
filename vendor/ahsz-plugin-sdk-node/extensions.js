'use strict';

const express = require('express');
const path = require('path');
const { DefaultFileAnnouncementAdapter } = require('./announcement-config');

const EXTENSION_HTTP_ROUTES = new Map([
    ['GET', new Set([
        '/api/plugin/capabilities',
        '/api/plugin/announcement'
    ])],
    ['POST', new Set([
        '/api/plugin/announcement'
    ])]
]);

/**
 * 旧插件扩展能力模式。
 *
 * 只挂载能力发现和公告管理接口，不注册健康检查、套餐、授权、退款、
 * 企业登记、WebSocket 或指标上报，用于金蝶连接器、电子签名等已有手动接口的插件。
 */
class AhszPluginExtensions {
    constructor(config = {}) {
        this.apiToken = config.apiToken || process.env.API_TOKEN;
        if (!this.apiToken) {
            throw new Error('[AHSZ SDK] API_TOKEN is required for extension routes');
        }

        const customAnnouncementAdapter = config.announcementAdapter
            && typeof config.announcementAdapter.get === 'function'
            && typeof config.announcementAdapter.save === 'function'
            ? config.announcementAdapter
            : null;
        const rawAnnouncementPath = config.announcementConfigPath || process.env.ANNOUNCEMENT_CONFIG_PATH;
        this.announcementConfigPath = rawAnnouncementPath ? path.resolve(rawAnnouncementPath) : '';
        this.announcementAdapter = customAnnouncementAdapter
            || (this.announcementConfigPath ? new DefaultFileAnnouncementAdapter(this.announcementConfigPath) : null);

        this.router = express.Router();
        this.jsonParser = express.json({ limit: config.jsonLimit || '1mb' });
        this.setupRoutes();
    }

    authMiddleware(req, res, next) {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ code: 401, message: 'Missing or invalid authorization header' });
        }
        if (authHeader.substring(7) !== this.apiToken) {
            return res.status(403).json({ code: 403, message: 'Invalid API Token' });
        }
        next();
    }

    setupRoutes() {
        this.router.get('/api/plugin/capabilities', this.authMiddleware.bind(this), (req, res) => {
            res.status(200).json({
                code: 0,
                capabilities: {
                    aiConfig: false,
                    aiPricing: false,
                    announcement: !!this.announcementAdapter,
                    announcementLinks: !!this.announcementAdapter && this.announcementAdapter.supportsLinks === true,
                    announcementItems: !!this.announcementAdapter && this.announcementAdapter.supportsMultipleItems === true
                }
            });
        });

        this.router.get('/api/plugin/announcement', this.authMiddleware.bind(this), async (req, res) => {
            if (!this.announcementAdapter) {
                return res.status(404).json({ code: 'CAPABILITY_NOT_SUPPORTED', message: 'Announcement capability is not supported' });
            }
            try {
                res.status(200).json(await this.announcementAdapter.get());
            } catch (_) {
                res.status(500).json({ code: 500, message: 'Internal Server Error' });
            }
        });

        this.router.post(
            '/api/plugin/announcement',
            this.jsonParser,
            this.authMiddleware.bind(this),
            async (req, res) => {
                if (!this.announcementAdapter) {
                    return res.status(404).json({ code: 'CAPABILITY_NOT_SUPPORTED', message: 'Announcement capability is not supported' });
                }
                if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
                    return res.status(400).json({ code: 400, message: 'Announcement payload must be an object' });
                }
                try {
                    res.status(200).json(await this.announcementAdapter.save(req.body));
                } catch (error) {
                    res.status(400).json({ code: 400, message: error.message || 'Invalid announcement payload' });
                }
            }
        );
    }

    matchesNodeHttpRequest(req) {
        const method = String(req && req.method || '').trim().toUpperCase();
        const routes = EXTENSION_HTTP_ROUTES.get(method);
        if (!routes) return false;
        try {
            let pathname = new URL(req.url || '/', 'http://127.0.0.1').pathname;
            if (pathname.length > 1) pathname = pathname.replace(/\/+$/, '');
            return routes.has(pathname);
        } catch (_) {
            return false;
        }
    }

    // Express 旧插件：在现有手动路由之后、404 处理之前挂载。
    mount(app) {
        app.use(this.router);
        return this;
    }

    // 原生 node:http 旧插件：仅匹配三个扩展接口，其他请求继续交给旧业务处理器。
    createNodeHttpHandler() {
        const app = express();
        app.disable('x-powered-by');
        app.use(this.router);
        app.use((req, res) => res.status(404).json({ code: 404, message: 'SDK extension route not found' }));
        const handle = (req, res) => app(req, res);
        handle.matches = this.matchesNodeHttpRequest.bind(this);
        handle.handle = handle;
        return handle;
    }
}

module.exports = AhszPluginExtensions;
