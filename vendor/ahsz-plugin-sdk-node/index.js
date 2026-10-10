const express = require('express');
const WebSocket = require('ws');
const os = require('os');
const fs = require('fs');
const path = require('path');
const {
    DefaultFileAnnouncementAdapter,
    normalizeAnnouncement
} = require('./announcement-config');
const AhszPluginExtensions = require('./extensions');

const HTTP_TRAFFIC_TRACKED = Symbol('ahszSdkHttpTrafficTracked');
const NODE_HTTP_ROUTES = new Map([
    ['GET', new Set([
        '/api/health',
        '/api/plugin/billing/config',
        '/api/plugin/capabilities',
        '/api/plugin/announcement',
        '/api/plugin/ai-config',
        '/api/plugin/ai-pricing',
        '/api/subscription/enterprise-status'
    ])],
    ['POST', new Set([
        '/api/plugin/billing/update',
        '/api/plugin/announcement',
        '/api/plugin/ai-config',
        '/api/plugin/ai-pricing',
        '/api/plugin/license/sync',
        '/api/plugin/order/refund',
        '/api/subscription/register-enterprise',
        '/api/subscription/redeem-coupon'
    ])]
]);

/**
 * 安汇数智统一插件对接 SDK - Node.js 实现
 * 
 */
/**
 * 默认的文件套餐配置适配器，代理 packages.json
 */
class DefaultFileBillingAdapter {
    constructor(configPath) {
        this.configPath = configPath || process.env.BILLING_CONFIG_PATH || path.join(process.cwd(), 'packages.json');
        this.writeLock = false;
    }

    async getConfig() {
        if (!fs.existsSync(this.configPath)) {
            throw new Error('[AHSZ SDK] Config file ' + this.configPath + ' not found');
        }
        try {
            const data = fs.readFileSync(this.configPath, 'utf8');
            return JSON.parse(data);
        } catch (e) {
            throw new Error('[AHSZ SDK] Invalid packages config JSON: ' + e.message);
        }
    }

    async updateConfig(newConfig) {
        if (this.writeLock) {
            throw new Error('[AHSZ SDK] Write lock conflict for packages config');
        }
        this.writeLock = true;
        const tmpPath = this.configPath + '.tmp.' + Date.now() + '.' + Math.random().toString(36).substring(2, 7);
        try {
            fs.writeFileSync(tmpPath, JSON.stringify(newConfig, null, 4), 'utf8');
            const fd = fs.openSync(tmpPath, 'r+');
            fs.fsyncSync(fd);
            fs.closeSync(fd);
            fs.renameSync(tmpPath, this.configPath);
            return true;
        } catch (e) {
            try { fs.unlinkSync(tmpPath); } catch (_) {}
            throw e;
        } finally {
            this.writeLock = false;
        }
    }
}

class AhszPluginSDK {
    constructor(config) {
        // 1. 启动配置强校验
        if (!config) throw new Error('[AHSZ SDK] Config object is missing');
        if (!config.pluginId) throw new Error('[AHSZ SDK] PLUGIN_ID is required and cannot be empty');
        if (!config.apiToken) throw new Error('[AHSZ SDK] API_TOKEN is required and cannot be empty');
        if (!config.platformUrl) throw new Error('[AHSZ SDK] PLATFORM_API_URL is required and cannot be empty');
        if (!config.platformWsUrl) throw new Error('[AHSZ SDK] PLATFORM_WS_URL is required and cannot be empty');

        // 读取数据库配置。
        this.dbHost = config.dbHost || process.env.DB_HOST;
        this.dbPort = config.dbPort || process.env.DB_PORT;
        this.dbUser = config.dbUser || process.env.DB_USER;
        this.dbPassword = config.dbPassword || process.env.DB_PASSWORD;
        this.dbName = config.dbName || process.env.DB_NAME;

        // 数据库配置完整性检测
        const dbConfigKeys = [this.dbHost, this.dbUser, this.dbPassword, this.dbName];
        const providedDbKeys = dbConfigKeys.filter(Boolean).length;
        if (providedDbKeys > 0 && providedDbKeys < dbConfigKeys.length) {
            throw new Error('[AHSZ SDK] Database configuration is incomplete. dbHost, dbUser, dbPassword, and dbName must all be provided if any are specified.');
        }

        // 2. 必须注册业务适配器 (若提供了数据库配置，则自动装配 MySQL 适配器，Adapters 变为可选)
        const hasDbConfig = !!this.dbHost;
        if (!hasDbConfig) {
            if (!config.healthAdapter) throw new Error('[AHSZ SDK] HealthAdapter must be registered when dbConfig is absent');
            if (!config.licenseAdapter) throw new Error('[AHSZ SDK] LicenseAdapter must be registered when dbConfig is absent');
            if (!config.orderAdapter) throw new Error('[AHSZ SDK] OrderAdapter must be registered when dbConfig is absent');
        }

        this.pluginId = config.pluginId;
        this.apiToken = config.apiToken;
        this.platformUrl = config.platformUrl.replace(/\/+$/, '');
        this.platformWsUrl = config.platformWsUrl;
        
        // 自动根据平台 URL 生成 Origin，防止生产白名单拦截
        let autoOrigin = '';
        try {
            const originUrl = new URL(this.platformUrl);
            autoOrigin = `${originUrl.protocol}//${originUrl.host}`;
        } catch (e) {}
        this.platformWsOrigin = config.platformWsOrigin || autoOrigin;

        this.logFilePath = config.logFilePath || path.join(process.cwd(), 'app.log');
        const parsedInterval = Number(config.metricsInterval);
        this.metricsInterval = (Number.isFinite(parsedInterval) && parsedInterval >= 5) ? Math.floor(parsedInterval) : 5;

        this.healthAdapter = config.healthAdapter;
        this.licenseAdapter = config.licenseAdapter;
        this.orderAdapter = config.orderAdapter;
        // 可选扩展能力。未注册时不会改变任何既有插件行为，平台可通过
        // /api/plugin/capabilities 判断是否展示对应的管理入口。
        this.aiConfigAdapter = config.aiConfigAdapter
            && typeof config.aiConfigAdapter.list === 'function'
            && typeof config.aiConfigAdapter.save === 'function'
            ? config.aiConfigAdapter
            : null;
        this.aiPricingAdapter = config.aiPricingAdapter
            && typeof config.aiPricingAdapter.list === 'function'
            && typeof config.aiPricingAdapter.save === 'function'
            ? config.aiPricingAdapter
            : null;
        const customAnnouncementAdapter = config.announcementAdapter
            && typeof config.announcementAdapter.get === 'function'
            && typeof config.announcementAdapter.save === 'function'
            ? config.announcementAdapter
            : null;

        // 现有插件的自定义适配器始终优先，确保营销地图等已上线插件无感升级。
        // 新插件配置公告文件路径后，可直接使用 SDK 内置的多公告存储能力。
        const rawAnnouncementPath = config.announcementConfigPath || process.env.ANNOUNCEMENT_CONFIG_PATH;
        this.announcementConfigPath = rawAnnouncementPath ? path.resolve(rawAnnouncementPath) : '';
        this.announcementAdapter = customAnnouncementAdapter
            || (this.announcementConfigPath ? new DefaultFileAnnouncementAdapter(this.announcementConfigPath) : null);

        // 支持套餐配置文件绝对路径指定与多进程 WebSocket 控制。
        const rawPath = config.billingConfigPath || process.env.BILLING_CONFIG_PATH;
        this.billingConfigPath = rawPath ? path.resolve(rawPath) : rawPath;
        this.wsEnabled = config.wsEnabled !== false && process.env.AHSZ_WS_ENABLED !== 'false';
        this.instanceId = config.instanceId || process.env.AHSZ_INSTANCE_ID || 'default-instance';

        const rawRoot = config.pluginRootPath || process.env.PLUGIN_ROOT_PATH || process.cwd();
        this.pluginRootPath = path.resolve(rawRoot);

        // 如果未注册 billingAdapter，启用内置的文件套餐适配器。
        if (config.billingAdapter) {
            this.billingAdapter = config.billingAdapter;
        } else {
            this.billingAdapter = new DefaultFileBillingAdapter(this.billingConfigPath);
        }

        this.router = express.Router();
        this.setupRoutes();

        // 运行状态与定时器
        this.ready = false;
        this.notReadyReason = 'Initializing database and files...';
        this.started = false;
        this.intervals = [];
        this.ws = null;
        this.isWsAlive = false;
        this.lastCpuUsage = null;
        this.wsWriteQueue = [];
        this.isWsWriting = false;
        this.wsReconnectDelay = 5000;
        this.isReportingLog = false; // 防重入上报标志

        // 资源监控与流量估算统计变量
        this.globalCpuUsage = 0.0;
        this.diskUsage = -1.0;
        this.logSize = 0.0;
        this.pluginDiskUsage = 0.0;
        this.startTime = Math.floor(Date.now() / 1000);

        // 流量估算计量变量
        this.networkInBytes = 0;
        this.networkOutBytes = 0;
        this.networkInRate = 0.0;
        this.networkOutRate = 0.0;
        this.lastNetworkTime = Date.now();

        // 启动内置 MySQL 自愈校验自检流程，马某。
        this.initPromise = this.initDatabase().catch(err => {
            this.ready = false;
            this.notReadyReason = err.message;
            console.error("[AHSZ SDK] Database initialization failed:", err.message);
        });
    }

    // 供插件自有的公开公告接口复用；SDK 管理接口与插件展示端共享同一份数据。
    async getAnnouncement() {
        if (!this.announcementAdapter) {
            throw new Error('[AHSZ SDK] Announcement capability is not configured');
        }
        return this.announcementAdapter.get();
    }

    async saveAnnouncement(payload) {
        if (!this.announcementAdapter) {
            throw new Error('[AHSZ SDK] Announcement capability is not configured');
        }
        return this.announcementAdapter.save(payload);
    }

    // 自动挂载路由
    setupRoutes() {
        // 1. HTTP 健康探活校验 (GET /api/health)
        this.router.get('/api/health', this.authMiddleware.bind(this), async (req, res) => {
            if (!this.ready) {
                return res.status(503).json({
                    code: 503,
                    status: 'unhealthy',
                    message: 'SDK is not ready: ' + this.notReadyReason
                });
            }
            try {
                const checkResult = await this.healthAdapter.check();
                if (!checkResult || !checkResult.healthy) {
                    return res.status(503).json({
                        code: 503,
                        status: 'unhealthy',
                        message: checkResult ? checkResult.message : 'Database check failed'
                    });
                }
                res.status(200).json({
                    code: 0,
                    status: 'healthy',
                    timestamp: new Date().toISOString()
                });
            } catch (err) {
                res.status(503).json({ code: 503, status: 'unhealthy', message: 'Health check failed: ' + err.message });
            }
        });

        // 2. 平台拉取插件套餐配置 (GET /api/plugin/billing/config)
        this.router.get('/api/plugin/billing/config', this.authMiddleware.bind(this), async (req, res) => {
            if (!this.ready) return res.status(503).json({ code: 503, message: 'SDK is not ready: ' + this.notReadyReason });
            try {
                const schema = await this.billingAdapter.getConfig();
                res.status(200).json(schema);
            } catch (err) {
                this.reportError(err, '/api/plugin/billing/config');
                res.status(500).json({ code: 500, message: 'Internal Server Error' });
            }
        });

        // 3. 平台更新/新增套餐配置 (POST /api/plugin/billing/update)
        this.router.post('/api/plugin/billing/update', this.authMiddleware.bind(this), async (req, res) => {
            if (!this.ready) return res.status(503).json({ code: 503, message: 'SDK is not ready: ' + this.notReadyReason });
            try {
                const schema = req.body;
                try {
                    this.validatePlans(schema);
                } catch (ve) {
                    return res.status(400).json({ code: 400, message: ve.message });
                }

                // 写入数据
                await this.billingAdapter.updateConfig(schema);

                // 强制回读验证逻辑。
                const verifiedSchema = await this.billingAdapter.getConfig();
                const normalizePlans = (plans) => {
                    if (!Array.isArray(plans)) return plans;
                    return plans.map(p => {
                        if (!p || typeof p !== 'object') return p;
                        const np = {};
                        for (const k of Object.keys(p)) {
                            if (typeof p[k] === 'string') {
                                np[k] = p[k].trim();
                            } else {
                                np[k] = p[k];
                            }
                        }
                        return np;
                    }).sort((a, b) => String(a.plan_id).localeCompare(String(b.plan_id)));
                };

                const getNormalizedField = (s, key) => {
                    const val = s[key];
                    if (key === 'plans') return normalizePlans(val);
                    if (typeof val === 'string') return val.trim();
                    return val;
                };

                const mismatch = ['schema_version', 'revision', 'currency', 'unit', 'plans'].some(key => {
                    return JSON.stringify(getNormalizedField(schema, key)) !== JSON.stringify(getNormalizedField(verifiedSchema, key));
                });

                if (mismatch) {
                    this.reportError(new Error('Verification failed: readback config mismatch with written config'), '/api/plugin/billing/update');
                    return res.status(500).json({ code: 500, message: 'Internal Server Error' });
                }

                res.status(200).json({ code: 0, message: 'success' });
            } catch (err) {
                this.reportError(err, '/api/plugin/billing/update');
                res.status(500).json({ code: 500, message: 'Internal Server Error' });
            }
        });

        // 可选能力发现。该接口始终存在，旧插件不注册适配器时明确返回 false。
        this.router.get('/api/plugin/capabilities', this.authMiddleware.bind(this), async (req, res) => {
            res.status(200).json({
                code: 0,
                capabilities: {
                    aiConfig: !!this.aiConfigAdapter,
                    aiPricing: !!this.aiPricingAdapter,
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
                const result = await this.getAnnouncement();
                res.status(200).json(result);
            } catch (err) {
                this.reportError(err, '/api/plugin/announcement');
                res.status(500).json({ code: 500, message: 'Internal Server Error' });
            }
        });

        this.router.post('/api/plugin/announcement', this.authMiddleware.bind(this), async (req, res) => {
            if (!this.announcementAdapter) {
                return res.status(404).json({ code: 'CAPABILITY_NOT_SUPPORTED', message: 'Announcement capability is not supported' });
            }
            if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
                return res.status(400).json({ code: 400, message: 'Announcement payload must be an object' });
            }
            try {
                const result = await this.saveAnnouncement(req.body);
                res.status(200).json(result);
            } catch (err) {
                this.reportError(err, '/api/plugin/announcement');
                res.status(400).json({ code: 400, message: err.message || 'Invalid announcement payload' });
            }
        });

        this.router.get('/api/plugin/ai-config', this.authMiddleware.bind(this), async (req, res) => {
            if (!this.aiConfigAdapter) {
                return res.status(404).json({ code: 'CAPABILITY_NOT_SUPPORTED', message: 'AI config capability is not supported' });
            }
            try {
                const result = await this.aiConfigAdapter.list();
                res.status(200).json(result);
            } catch (err) {
                this.reportError(err, '/api/plugin/ai-config');
                res.status(500).json({ code: 500, message: 'Internal Server Error' });
            }
        });

        this.router.post('/api/plugin/ai-config', this.authMiddleware.bind(this), async (req, res) => {
            if (!this.aiConfigAdapter) {
                return res.status(404).json({ code: 'CAPABILITY_NOT_SUPPORTED', message: 'AI config capability is not supported' });
            }
            if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
                return res.status(400).json({ code: 400, message: 'AI config payload must be an object' });
            }
            try {
                const result = await this.aiConfigAdapter.save(req.body);
                res.status(200).json(result);
            } catch (err) {
                this.reportError(err, '/api/plugin/ai-config');
                res.status(400).json({ code: 400, message: err.message || 'Invalid AI config payload' });
            }
        });

        this.router.get('/api/plugin/ai-pricing', this.authMiddleware.bind(this), async (req, res) => {
            if (!this.aiPricingAdapter) {
                return res.status(404).json({ code: 'CAPABILITY_NOT_SUPPORTED', message: 'AI pricing capability is not supported' });
            }
            try {
                const result = await this.aiPricingAdapter.list();
                res.status(200).json(result);
            } catch (err) {
                this.reportError(err, '/api/plugin/ai-pricing');
                res.status(500).json({ code: 500, message: 'Internal Server Error' });
            }
        });

        this.router.post('/api/plugin/ai-pricing', this.authMiddleware.bind(this), async (req, res) => {
            if (!this.aiPricingAdapter) {
                return res.status(404).json({ code: 'CAPABILITY_NOT_SUPPORTED', message: 'AI pricing capability is not supported' });
            }
            if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
                return res.status(400).json({ code: 400, message: 'AI pricing payload must be an object' });
            }
            try {
                const result = await this.aiPricingAdapter.save(req.body);
                res.status(200).json(result);
            } catch (err) {
                this.reportError(err, '/api/plugin/ai-pricing');
                res.status(400).json({ code: 400, message: err.message || 'Invalid AI pricing payload' });
            }
        });

        // 4. 平台下发企业授权最终值进行覆盖同步 (POST /api/plugin/license/sync)
        this.router.post('/api/plugin/license/sync', this.authMiddleware.bind(this), async (req, res) => {
            if (!this.ready) return res.status(503).json({ code: 503, message: 'SDK is not ready: ' + this.notReadyReason });
            try {
                const data = req.body;
                if (!data.tenant_key) return res.status(400).json({ code: 400, message: 'tenant_key is required' });
                if (!data.billing_type) return res.status(400).json({ code: 400, message: 'billing_type is required' });
                if (data.used_quota === undefined || data.used_quota === null) return res.status(400).json({ code: 400, message: 'used_quota is required' });
                if (data.max_quota === undefined || data.max_quota === null) return res.status(400).json({ code: 400, message: 'max_quota is required' });

                if (data.billing_type !== 'quota' && data.billing_type !== 'duration') {
                    return res.status(400).json({ code: 400, message: 'billing_type must be either quota or duration' });
                }

                if (typeof data.used_quota !== 'number' || !Number.isInteger(data.used_quota) || data.used_quota < 0) {
                    return res.status(400).json({ code: 400, message: 'used_quota must be a non-negative integer' });
                }
                if (typeof data.max_quota !== 'number' || !Number.isInteger(data.max_quota) || data.max_quota < 0) {
                    return res.status(400).json({ code: 400, message: 'max_quota must be a non-negative integer' });
                }

                // 0是合法值，必须被识别。
                const payload = {
                    tenantKey: data.tenant_key,
                    billingType: data.billing_type,
                    usedQuota: data.used_quota,
                    maxQuota: data.max_quota,
                    expireTime: data.expire_time ? new Date(data.expire_time) : null
                };

                await this.licenseAdapter.syncFinalLicense(payload);
                res.status(200).json({ code: 0, message: 'success' });
            } catch (err) {
                this.reportError(err, '/api/plugin/license/sync');
                res.status(500).json({ code: 500, message: 'Internal Server Error' });
            }
        });

        // 5. 平台通知插件订单退款 (POST /api/plugin/order/refund)
        this.router.post('/api/plugin/order/refund', this.authMiddleware.bind(this), async (req, res) => {
            if (!this.ready) return res.status(503).json({ code: 503, message: 'SDK is not ready: ' + this.notReadyReason });
            try {
                const { order_id, status } = req.body;
                if (!order_id) return res.status(400).json({ code: 400, message: 'order_id is required' });
                if (status !== 'REFUNDED') return res.status(400).json({ code: 400, message: 'status must be REFUNDED' });

                // 调用退款订单适配器，包含事务与行锁逻辑
                const result = await this.orderAdapter.markRefunded(order_id);
                
                // 强类型契约校验，必须包含 tenantKey 且 alreadyRefunded 为布尔值
                if (!result || typeof result.tenantKey !== 'string' || !result.tenantKey.trim() || typeof result.alreadyRefunded !== 'boolean') {
                    this.reportError(new Error('Invalid markRefunded adapter response contract'), '/api/plugin/order/refund');
                    return res.status(500).json({ code: 500, message: 'Internal Server Error' });
                }

                res.status(200).json({ code: 0, message: 'success' });
            } catch (err) {
                this.reportError(err, '/api/plugin/order/refund');
                res.status(500).json({ code: 500, message: 'Internal Server Error' });
            }
        });

        // 6. 企业授权状态查询代理 (GET /api/subscription/enterprise-status)
        this.router.get('/api/subscription/enterprise-status', async (req, res) => {
            if (!this.ready) return res.status(503).json({ code: 503, message: 'SDK is not ready: ' + this.notReadyReason });
            try {
                const tenantKey = req.query.tenant_key;
                if (!tenantKey || typeof tenantKey !== 'string' || tenantKey.length > 256) {
                    return res.status(400).json({ code: 400, message: 'Missing or too long tenant_key (max 256 characters)' });
                }
                const result = await this.queryEnterpriseStatus(tenantKey);
                res.status(200).json(result);
            } catch (err) {
                this.reportError(err, '/api/subscription/enterprise-status');
                res.status(500).json({ code: 500, message: 'Internal Server Error' });
            }
        });

        // 7. 企业开通注册代理 (POST /api/subscription/register-enterprise)
        this.router.post('/api/subscription/register-enterprise', async (req, res) => {
            if (!this.ready) return res.status(503).json({ code: 503, message: 'SDK is not ready: ' + this.notReadyReason });
            try {
                const body = req.body || {};
                const { tenantKey, enterpriseName } = body;
                const hasEnterpriseType = Object.prototype.hasOwnProperty.call(body, 'enterpriseType');
                const enterpriseType = hasEnterpriseType ? body.enterpriseType : undefined;
                const normalizedEnterpriseType = typeof enterpriseType === 'string'
                    ? enterpriseType.trim()
                    : enterpriseType;
                if (!tenantKey || typeof tenantKey !== 'string' || tenantKey.length > 256 ||
                    !enterpriseName || typeof enterpriseName !== 'string' || enterpriseName.length > 256 ||
                    (hasEnterpriseType && (typeof enterpriseType !== 'string' || Array.from(normalizedEnterpriseType).length > 256))) {
                    return res.status(400).json({ code: 400, message: 'Invalid tenantKey, enterpriseName or enterpriseType parameters (max 256 characters; enterpriseType is optional)' });
                }
                const result = hasEnterpriseType
                    ? await this.registerEnterprise(tenantKey, enterpriseName, normalizedEnterpriseType)
                    : await this.registerEnterprise(tenantKey, enterpriseName);
                res.status(200).json(result);
            } catch (err) {
                this.reportError(err, '/api/subscription/register-enterprise');
                res.status(500).json({ code: 500, message: 'Internal Server Error' });
            }
        });

        // 8. 兑换码核销代理 (POST /api/subscription/redeem-coupon)
        this.router.post('/api/subscription/redeem-coupon', async (req, res) => {
            if (!this.ready) return res.status(503).json({ code: 503, message: 'SDK is not ready: ' + this.notReadyReason });
            try {
                const { tenantKey, couponCode } = req.body;
                if (!tenantKey || typeof tenantKey !== 'string' || tenantKey.length > 256 ||
                    !couponCode || typeof couponCode !== 'string' || couponCode.length > 256) {
                    return res.status(400).json({ code: 400, message: 'Invalid tenantKey or couponCode parameters (max 256 characters)' });
                }
                const result = await this.redeemCoupon(tenantKey, couponCode);
                res.status(200).json(result);
            } catch (err) {
                const statusCode = Number(err && err.statusCode);
                const isBusinessError = statusCode >= 400 && statusCode < 500;
                if (!isBusinessError) {
                    this.reportError(err, '/api/subscription/redeem-coupon');
                }
                const responseStatus = isBusinessError ? statusCode : 500;
                const responseBody = {
                    code: (isBusinessError && err.platformCode) || responseStatus,
                    message: isBusinessError ? err.message : 'Internal Server Error'
                };
                if (isBusinessError && err.platformResponse && err.platformResponse.data !== undefined) {
                    responseBody.data = err.platformResponse.data;
                }
                res.status(responseStatus).json(responseBody);
            }
        });
    }

    // Bearer Token 强鉴权中间件
    authMiddleware(req, res, next) {
        const authHeader = req.headers['authorization'];
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ code: 401, message: 'Missing or invalid authorization header' });
        }
        const token = authHeader.substring(7);
        if (token !== this.apiToken) {
            return res.status(403).json({ code: 403, message: 'Invalid API Token' });
        }
        next();
    }

    // 启动 WebSocket 指标上报及系统指标定时抓取，马某。
    async start() {
        if (this.started) return;
        this.started = true;
        this.startMetricsSchedules();

        if (this.initPromise) {
            try {
                await this.initPromise;
            } catch (err) {}
        }

        if (this.ready && this.wsEnabled) {
            this.connectToPlatformWS();
        } else if (!this.ready) {
            console.warn("[AHSZ SDK] SDK is NOT ready. WebSocket telemetry client disabled.");
            const checkInterval = setInterval(async () => {
                // 每次重试时重新执行数据库和套餐校验，实现启动失败自愈
                await this.initDatabase();
                if (this.ready) {
                    clearInterval(checkInterval);
                    if (this.wsEnabled) {
                        this.connectToPlatformWS();
                    }
                }
            }, 10000);
            this.intervals.push(checkInterval);
        } else {
            console.log("[AHSZ SDK] WebSocket telemetry disabled on this instance (AHSZ_WS_ENABLED=false).");
        }
    }

    // 安全关闭/注销 SDK，释放所有连接和定时器
    stop() {
        this.started = false;
        this.intervals.forEach(clearInterval);
        this.intervals = [];
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
        if (this.pool) {
            this.pool.end().catch(() => {});
            this.pool = null;
        }
    }

    // 区分各项指标采集周期，减轻磁盘及 CPU I/O 开销
    startMetricsSchedules() {
        // A. 进程 CPU 占用率采集
        const cpuTimer = setInterval(() => {
            this.globalCpuUsage = this.getCPUUsage();
        }, this.metricsInterval * 1000);
        this.intervals.push(cpuTimer);

        // B. 日志体积及主机磁盘占用采集 (30秒周期)
        const diskLogTimer = setInterval(() => {
            // 1. 磁盘占比
            try {
                if (fs.statfsSync) {
                    const stats = fs.statfsSync('/');
                    const total = stats.bsize * stats.blocks;
                    // 使用 bfree (绝对物理空闲块)，与金蝶连接器插件及宝塔面板保持 10.8% 统计口径一致
                    const free = stats.bsize * stats.bfree;
                    this.diskUsage = parseFloat((((total - free) / total) * 100).toFixed(1));
                }
            } catch (e) { this.diskUsage = -1.0; }

            // 2. 日志占用大小
            try {
                if (fs.existsSync(this.logFilePath)) {
                    const stats = fs.statSync(this.logFilePath);
                    this.logSize = parseFloat((stats.size / (1024 * 1024)).toFixed(3));
                } else {
                    this.logSize = 0.0;
                }
            } catch (e) { this.logSize = 0.0; }
        }, 30000);
        this.intervals.push(diskLogTimer);

        // C. 插件目录大小采集 (5分钟周期)
        const scanDirSize = () => {
            try {
                this.pluginDiskUsage = parseFloat((this.getDirSize(this.pluginRootPath) / (1024 * 1024)).toFixed(2));
            } catch (e) { this.pluginDiskUsage = 0.0; }
        };
        scanDirSize();
        const dirSizeTimer = setInterval(scanDirSize, 300000);
        this.intervals.push(dirSizeTimer);
    }

    // 指数退避重连与保活
    connectToPlatformWS() {
        if (!this.started) return;

        const wsUrl = `${this.platformWsUrl}?plugin_id=${encodeURIComponent(this.pluginId)}&token=${encodeURIComponent(this.apiToken)}`;
        console.log(`[AHSZ SDK] Connecting plugin ${this.pluginId} to platform WSS...`);

        const wsOptions = {};
        if (this.platformWsOrigin) {
            wsOptions.origin = this.platformWsOrigin;
        }

        this.ws = new WebSocket(wsUrl, wsOptions);
        let heartbeatInterval = null;

        this.ws.on('open', () => {
            console.log(`[AHSZ SDK] WebSocket connection successfully established.`);
            this.wsReconnectDelay = 5000; // 重置延迟
            this.isWsAlive = true;

            // 心跳帧保活与发送 (metricsInterval周期)
            heartbeatInterval = setInterval(() => {
                if (!this.isWsAlive) {
                    console.warn('[AHSZ SDK] WebSocket connection lost (Ping response timeout). Reconnecting...');
                    this.ws.close();
                    return;
                }
                this.isWsAlive = false;
                this.ws.ping();
                this.pushMetrics();
            }, this.metricsInterval * 1000);
        });

        this.ws.on('pong', () => {
            this.isWsAlive = true; // 收到回复，证明连接活跃
        });

        this.ws.on('close', (code, reason) => {
            console.warn(`[AHSZ SDK] WebSocket connection closed (code: ${code}). Reconnecting...`);
            if (heartbeatInterval) clearInterval(heartbeatInterval);
            
            if (this.started) {
                // 增加随机抖动延迟 (0.5s - 1.5s Jitter)，防重连风暴
                const jitter = Math.random() * 1000;
                setTimeout(() => {
                    this.wsReconnectDelay = Math.min(this.wsReconnectDelay * 2, 60000);
                    this.connectToPlatformWS();
                }, this.wsReconnectDelay + jitter);
            }
        });

        this.ws.on('error', (err) => {
            console.error('[AHSZ SDK] WebSocket error occurred:', err.message);
            this.ws.close();
        });
    }

    // 性能指标推送逻辑
    pushMetrics() {
        try {
            // 计算自上次心跳以来的流量速率（KB/s）
            const now = Date.now();
            const duration = (now - this.lastNetworkTime) / 1000;
            if (duration > 0) {
                this.networkInRate = parseFloat(((this.networkInBytes / 1024) / duration).toFixed(2));
                this.networkOutRate = parseFloat(((this.networkOutBytes / 1024) / duration).toFixed(2));
            }
            this.networkInBytes = 0;
            this.networkOutBytes = 0;
            this.lastNetworkTime = now;

            // 当前进程内存百分比 (RSS / Host Total)
            const memUsage = parseFloat(((process.memoryUsage().rss / os.totalmem()) * 100).toFixed(1));
            const openHandles = process._getActiveHandles ? process._getActiveHandles().length : -1;
            const processThreads = process.env.UV_THREADPOOL_SIZE ? parseInt(process.env.UV_THREADPOOL_SIZE, 10) + 3 : -1;
            const connectionCount = process._getActiveRequests ? process._getActiveRequests().length : -1;

            const payload = JSON.stringify({
                type: 'metrics',
                cpu_usage: this.globalCpuUsage,
                memory_usage: memUsage,
                disk_usage: this.diskUsage,
                plugin_disk_usage: this.pluginDiskUsage,
                log_size: this.logSize,
                network_in: this.networkInRate,
                network_out: this.networkOutRate,
                process_threads: processThreads,
                open_handles: openHandles,
                connection_count: connectionCount,
                uptime: Math.floor((Date.now() / 1000) - this.startTime)
            });

            this.wsQueueSend(payload);
        } catch (err) {
            console.error('[AHSZ SDK] Failed to push metrics payload:', err.message);
        }
    }

    // 单连接单队列防写冲突控制
    wsQueueSend(message) {
        this.wsWriteQueue.push(message);
        if (this.isWsWriting) return;
        this.processWsWriteQueue();
    }

    processWsWriteQueue() {
        if (this.wsWriteQueue.length === 0) {
            this.isWsWriting = false;
            return;
        }

        this.isWsWriting = true;
        const msg = this.wsWriteQueue.shift();

        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(msg, (err) => {
                if (err) {
                    console.error('[AHSZ SDK] WS Send Error:', err.message);
                }
                process.nextTick(() => this.processWsWriteQueue());
            });
        } else {
            process.nextTick(() => this.processWsWriteQueue());
        }
    }

    // 统一封装平台请求 HTTP 客户端，增加业务 code 校验
    makeRequest(apiPath, method, payload = null) {
        return new Promise((resolve, reject) => {
            const urlStr = `${this.platformUrl}${apiPath}`;
            const parsedUrl = new URL(urlStr);
            const client = parsedUrl.protocol === 'https:' ? require('https') : require('http');

            const options = {
                hostname: parsedUrl.hostname,
                port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
                path: parsedUrl.pathname + parsedUrl.search,
                method: method,
                headers: {
                    'Authorization': `Bearer ${this.apiToken}`,
                    'Content-Type': 'application/json'
                },
                timeout: 5000 // 5秒强超时约束
            };

            const req = client.request(options, (res) => {
                let body = '';
                res.on('data', chunk => body += chunk);
                res.on('end', () => {
                    let json = null;
                    try {
                        json = body ? JSON.parse(body) : {};
                    } catch (parseError) {
                        if (res.statusCode >= 200 && res.statusCode < 300) {
                            return reject(parseError);
                        }
                    }

                    // 必须先读取平台响应正文，再根据状态码抛错，避免丢失业务提示。
                    if (res.statusCode < 200 || res.statusCode >= 300) {
                        const message = json && (json.message || json.msg)
                            ? (json.message || json.msg)
                            : `[AHSZ SDK] Platform HTTP Request failed with status: ${res.statusCode}`;
                        const error = new Error(message);
                        error.name = 'AhszPlatformRequestError';
                        error.statusCode = res.statusCode;
                        error.platformCode = (json && json.data && json.data.error_code)
                            || (json && json.code)
                            || res.statusCode;
                        error.platformResponse = json || { message: body };
                        return reject(error);
                    }

                    try {
                        // 强制校验平台业务级响应代码 code，支持 0 或 200 为成功代码
                        if (json && json.code !== undefined && json.code !== 0 && json.code !== 200) {
                            const businessCode = Number(json.code);
                            const error = new Error(json.message || json.msg || 'Unknown platform business error');
                            error.name = 'AhszPlatformRequestError';
                            error.statusCode = businessCode >= 400 && businessCode < 500
                                ? businessCode
                                : 502;
                            error.platformCode = (json.data && json.data.error_code) || json.code;
                            error.platformResponse = json;
                            return reject(error);
                        }
                        resolve(json);
                    } catch (e) {
                        reject(e);
                    }
                });
            });

            req.on('timeout', () => {
                req.destroy();
                reject(new Error('[AHSZ SDK] Platform HTTP Request Timeout'));
            });

            req.on('error', err => reject(err));

            if (payload) {
                req.write(JSON.stringify(payload));
            }
            req.end();
        });
    }

    // 1. 查询企业在平台端状态
    async queryEnterpriseStatus(tenantKey) {
        return this.makeRequest(`/api/plugin/enterprise/status?tenant_key=${encodeURIComponent(tenantKey)}`, 'GET');
    }

    // 2. 向平台端注册已开通插件企业
    async registerEnterprise(tenantKey, enterpriseName, enterpriseType) {
        const payload = {
            tenantKey,
            enterpriseName
        };
        if (enterpriseType !== undefined) {
            if (typeof enterpriseType !== 'string') {
                throw new TypeError('enterpriseType must be a string with at most 256 characters');
            }
            const normalizedEnterpriseType = enterpriseType.trim();
            if (Array.from(normalizedEnterpriseType).length > 256) {
                throw new RangeError('enterpriseType must be a string with at most 256 characters');
            }
            payload.enterpriseType = normalizedEnterpriseType;
        }
        return this.makeRequest('/api/plugin/enterprise/register', 'POST', payload);
    }

    // 3. 兑换码核销
    async redeemCoupon(tenantKey, couponCode) {
        return this.makeRequest('/api/plugin/coupon/redeem', 'POST', {
            tenant_key: tenantKey,
            coupon_code: couponCode,
            plugin_id: this.pluginId
        });
    }

    async reportLog(logData) {
        if (!this.lastErrors) {
            this.lastErrors = new Map();
            this.globalLogTimes = [];
        }
        if (this.lastErrors.size > 100) {
            this.lastErrors.clear();
        }
        const msg = logData.message || 'Unknown plugin error';
        const now = Date.now();
        const lastTime = this.lastErrors.get(msg);
        if (lastTime && (now - lastTime) < 5000) {
            return;
        }
        this.lastErrors.set(msg, now);

        // 全局限流：每分钟最多 20 条日志
        if (this.globalLogTimes.length >= 20) {
            const oldest = this.globalLogTimes[0];
            if ((now - oldest) < 60000) {
                return;
            }
            this.globalLogTimes.shift();
        }
        this.globalLogTimes.push(now);

        try {
            const payload = {
                level: logData.level || 'error',
                message: msg,
                stackTrace: logData.stackTrace ? logData.stackTrace.substring(0, 2000) : '', // 限制长度
                requestPath: logData.requestPath || '',
                tenantKey: logData.tenantKey || ''
            };

            await this.makeRequest('/api/v1/plugin/log/report', 'POST', payload);
        } catch (err) {
            // 失败后降级写入本地日志
            const localLogLine = `[AHSZ SDK LOCAL FALLBACK] [${new Date().toISOString()}] Failed to report exception: ${err.message}. Original payload: ${JSON.stringify(logData)}\n`;
            try {
                fs.appendFileSync(this.logFilePath, localLogLine);
            } catch (e) {
                console.error('[AHSZ SDK] Failed to write local fallback log:', e.message);
            }
        }
    }

    // 主动报错上报快捷封装方法
    reportError(error, context = '') {
        this.reportLog({
            level: 'error',
            message: `${context ? `[${context}] ` : ''}${error.message || String(error)}`,
            stackTrace: error.stack || '',
            requestPath: context || 'Application Handler'
        });
    }

    // 一键安装全局未捕获异常上报，崩溃后退出进程以防带病运行
    installGlobalErrorHandlers() {
        process.on('uncaughtException', (err) => {
            console.error('[AHSZ SDK] Uncaught Exception detected:', err);
            this.reportError(err, 'Node Uncaught Exception');
            // 留出2秒让网络请求异步发送完成，然后安全退出
            setTimeout(() => {
                process.exit(1);
            }, 2000);
        });

        process.on('unhandledRejection', (reason) => {
            console.error('[AHSZ SDK] Unhandled Promise Rejection detected:', reason);
            const err = reason instanceof Error ? reason : new Error(String(reason));
            this.reportError(err, 'Node Unhandled Rejection');
        });
    }

    // 套餐配置结构深度校验：校验 plans 字段、类型、价格和使能状态。
    validatePlans(schema) {
        if (!schema || typeof schema.schema_version !== 'number' || !Number.isInteger(schema.schema_version) || schema.schema_version !== 1) {
            throw new Error('[AHSZ SDK] schema_version is required and must be strictly equal to 1');
        }
        if (typeof schema.revision !== 'number' || !Number.isInteger(schema.revision) || schema.revision < 1) {
            throw new Error('[AHSZ SDK] revision is required and must be a positive integer >= 1');
        }
        if (typeof schema.currency !== 'string' || !schema.currency.trim()) {
            throw new Error('[AHSZ SDK] currency is required and must be a non-empty string');
        }
        if (schema.hasOwnProperty('unit') && (typeof schema.unit !== 'string' || !schema.unit.trim())) {
            throw new Error('[AHSZ SDK] unit must be a string');
        }
        if (!schema.plans || !Array.isArray(schema.plans)) {
            throw new Error('[AHSZ SDK] Invalid billing schema format: plans array is missing or invalid');
        }
        const planIds = new Set();
        for (const plan of schema.plans) {
            if (!plan.plan_id || typeof plan.plan_id !== 'string') {
                throw new Error('[AHSZ SDK] plan_id is required and must be a string');
            }
            const pid = plan.plan_id.trim();
            if (!pid) {
                throw new Error('[AHSZ SDK] plan_id is required and must be a non-empty string');
            }
            if (planIds.has(pid)) {
                throw new Error(`[AHSZ SDK] Duplicate plan_id: ${pid}`);
            }
            planIds.add(pid);

            if (!plan.name || typeof plan.name !== 'string') {
                throw new Error('[AHSZ SDK] plan name is required and must be a string');
            }
            const name = plan.name.trim();
            if (!name) {
                throw new Error('[AHSZ SDK] name is required and must be a non-empty string');
            }

            if (plan.billing_type !== 'quota' && plan.billing_type !== 'duration') {
                throw new Error('[AHSZ SDK] billing_type must be quota or duration');
            }
            if (plan.billing_type === 'quota') {
                if (typeof plan.quota !== 'number' || !Number.isInteger(plan.quota) || plan.quota <= 0) {
                    throw new Error('[AHSZ SDK] quota must be a positive integer');
                }
            }
            if (plan.billing_type === 'duration') {
                if (typeof plan.days !== 'number' || !Number.isInteger(plan.days) || plan.days <= 0) {
                    throw new Error('[AHSZ SDK] days must be a positive integer');
                }
            }
            if (typeof plan.price !== 'number' || !Number.isFinite(plan.price) || plan.price < 0) {
                throw new Error('[AHSZ SDK] price must be a non-negative finite number');
            }
            if (typeof plan.enabled !== 'boolean') {
                throw new Error('[AHSZ SDK] enabled must be a boolean');
            }
            if (plan.hasOwnProperty('description') && typeof plan.description !== 'string') {
                throw new Error('[AHSZ SDK] description must be a string');
            }
        }
    }

    // 计算当前插件进程 CPU 占用百分比 (0.0% ~ 100.0%)
    getCPUUsage() {
        const startTime = process.hrtime();
        const startUsage = process.cpuUsage();
        
        if (!this.lastCpuUsage) {
            this.lastCpuUsage = { time: startTime, usage: startUsage };
            return 0.0;
        }
        
        const last = this.lastCpuUsage;
        const elapsedHrTime = process.hrtime(last.time);
        const elapsedMicroseconds = (elapsedHrTime[0] * 1e6) + (elapsedHrTime[1] / 1e3);
        
        const currentUsage = process.cpuUsage();
        const userDiff = currentUsage.user - last.usage.user;
        const sysDiff = currentUsage.system - last.usage.system;
        
        this.lastCpuUsage = { time: startTime, usage: currentUsage };
        
        if (elapsedMicroseconds === 0) return 0.0;
        
        const cpus = os.cpus().length;
        const cpuPercent = ((userDiff + sysDiff) / elapsedMicroseconds * 100) / cpus;
        return parseFloat(cpuPercent.toFixed(1));
    }

    // 递归文件目录获取字节大小
    getDirSize(dirPath) {
        let size = 0;
        try {
            const files = fs.readdirSync(dirPath);
            for (const file of files) {
                if (file === 'node_modules' || file === '.git') continue;
                const filePath = path.join(dirPath, file);
                const stat = fs.statSync(filePath);
                if (stat.isFile()) {
                    size += stat.size;
                } else if (stat.isDirectory()) {
                    size += this.getDirSize(filePath);
                }
            }
        } catch (e) {}
        return size;
    }

    async initDatabase() {
        this.ready = false;
        try {
            const conf = await this.billingAdapter.getConfig();
            this.validatePlans(conf);
        } catch (e) {
            this.ready = false;
            this.notReadyReason = e.message;
            console.error("[AHSZ SDK] Packages configuration validation failed: " + e.message);
            return;
        }
        if (!this.dbHost) {
            this.ready = true;
            this.notReadyReason = "";
            return;
        }

        if (this.pool) {
            try {
                await this.pool.end();
            } catch (e) {}
            this.pool = null;
        }

        const mysql = require('mysql2/promise');
        this.pool = mysql.createPool({
            host: this.dbHost,
            port: Number(this.dbPort) || 3306,
            user: this.dbUser,
            password: this.dbPassword,
            database: this.dbName,
            waitForConnections: true,
            connectionLimit: 5,
            queueLimit: 0
        });

        // 仅对表和视图做只读同步校验，不自建，校验失败进入 notReady
        try {
            const conn = await this.pool.getConnection();
            try {
                // 1. 验证 platform_license_view 存在及结构
                await conn.query(`SELECT tenant_key, billing_type, used_quota, max_quota, expire_time FROM platform_license_view LIMIT 1`);

                // 2. 验证 platform_order_view 存在及结构
                await conn.query(`SELECT order_id, tenant_key, plan, amount, status, created_at, updated_at_raw, updated_at, third_party_no, pay_channel, days, quota FROM platform_order_view LIMIT 1`);

                // 3. 物理表防呆校验（仅在未注册自定义适配器的标准表模式下校验）
                if (!this.licenseAdapter) {
                    await conn.query(`SELECT tenant_key FROM platform_license LIMIT 1`);
                }
                if (!this.orderAdapter) {
                    await conn.query(`SELECT order_id FROM platform_order LIMIT 1`);
                }

                this.ready = true;
                this.notReadyReason = "";
                console.log("[AHSZ SDK] Database views and connections validated successfully. SDK is Ready.");
            } finally {
                conn.release();
            }
        } catch (e) {
            this.ready = false;
            this.notReadyReason = "Database schema check failed: " + e.message;
            console.error("[AHSZ SDK] Database validation failed: ", e.message);
            return;
        }

        // 装配默认 MySQL 适配器，自检对齐
        this.healthAdapter = this.healthAdapter || {
            check: async () => {
                await this.pool.query("SELECT 1");
                return { healthy: true };
            }
        };

        this.licenseAdapter = this.licenseAdapter || {
            syncFinalLicense: async (license) => {
                if (!this.ready) throw new Error("SDK is not ready: " + this.notReadyReason);
                await this.pool.query(`
                    INSERT INTO platform_license (tenant_key, billing_type, used_quota, max_quota, expire_time, update_time)
                    VALUES (?, ?, ?, ?, ?, NOW())
                    ON DUPLICATE KEY UPDATE
                        billing_type=VALUES(billing_type),
                        used_quota=VALUES(used_quota),
                        max_quota=VALUES(max_quota),
                        expire_time=VALUES(expire_time),
                        update_time=NOW()
                `, [license.tenantKey, license.billingType, license.usedQuota, license.maxQuota, license.expireTime]);
                return true;
            }
        };

        this.orderAdapter = this.orderAdapter || {
            markRefunded: async (orderId) => {
                if (!this.ready) throw new Error("SDK is not ready: " + this.notReadyReason);
                const conn = await this.pool.getConnection();
                try {
                    await conn.beginTransaction();

                    // 1. 锁订单行并查询订单状态
                    const [orders] = await conn.query(`SELECT * FROM platform_order WHERE order_id = ? FOR UPDATE`, [orderId]);
                    if (orders.length === 0) {
                        await conn.rollback();
                        throw new Error(`Order ${orderId} not found`);
                    }
                    const order = orders[0];

                    // 2. 幂等性检查
                    if (order.status === 'REFUNDED') {
                        await conn.commit();
                        return { tenantKey: order.tenant_key, alreadyRefunded: true };
                    }

                    // 3. 更新订单状态为 REFUNDED
                    await conn.query(
                        `UPDATE platform_order SET status = 'REFUNDED', updated_at = NOW() WHERE order_id = ?`,
                        [orderId]
                    );

                    await conn.commit();
                    return { tenantKey: order.tenant_key, alreadyRefunded: false };
                } catch (err) {
                    await conn.rollback();
                    throw err;
                } finally {
                    conn.release();
                }
            }
        };
    }

    // 确保全局异常处理只安装一次；Express 与原生 HTTP 两种接入方式共享此状态。
    ensureGlobalErrorHandlers() {
        if (!this.globalErrorHandlersInstalled) {
            this.installGlobalErrorHandlers();
            this.globalErrorHandlersInstalled = true;
        }
    }

    // 统一统计 SDK HTTP 路由流量，防止同一响应对象被重复包装。
    trackHttpTraffic(req, res, next) {
        if (res[HTTP_TRAFFIC_TRACKED]) {
            next();
            return;
        }
        res[HTTP_TRAFFIC_TRACKED] = true;

        if (req.headers['content-length']) {
            this.networkInBytes += parseInt(req.headers['content-length'], 10);
        } else {
            this.networkInBytes += (req.url.length + JSON.stringify(req.headers).length);
        }

        const oldWrite = res.write;
        const oldEnd = res.end;

        res.write = (chunk, ...args) => {
            if (chunk) {
                if (Buffer.isBuffer(chunk)) {
                    this.networkOutBytes += chunk.length;
                } else if (typeof chunk === 'string') {
                    this.networkOutBytes += Buffer.byteLength(chunk);
                }
            }
            return oldWrite.apply(res, [chunk, ...args]);
        };

        res.end = (chunk, ...args) => {
            if (chunk) {
                if (Buffer.isBuffer(chunk)) {
                    this.networkOutBytes += chunk.length;
                } else if (typeof chunk === 'string') {
                    this.networkOutBytes += Buffer.byteLength(chunk);
                }
            }
            return oldEnd.apply(res, [chunk, ...args]);
        };

        next();
    }

    // Express 与原生 HTTP 适配器共用同一错误响应和平台日志上报逻辑。
    handleHttpRouteError(err, req, res, next) {
        this.reportError(err, req.path);
        if (res.headersSent) {
            return next(err);
        }
        res.status(500).json({ code: 500, message: 'Internal Server Error' });
    }

    /**
     * 判断原生 Node HTTP 请求是否属于 SDK 路由。
     * 未匹配请求必须交还宿主插件处理，SDK 不会抢占宿主业务路由。
     */
    matchesNodeHttpRequest(req) {
        const method = String(req && req.method || '').trim().toUpperCase();
        const routes = NODE_HTTP_ROUTES.get(method);
        if (!routes) return false;

        let pathname;
        try {
            pathname = new URL(req.url || '/', 'http://127.0.0.1').pathname;
        } catch (_) {
            return false;
        }
        if (pathname.length > 1) {
            pathname = pathname.replace(/\/+$/, '');
        }
        return routes.has(pathname);
    }

    /**
     * 创建可挂入原生 http.createServer 的 SDK Handler。
     *
     * 返回值既可直接调用，也提供 matches/handle 方法：
     *   const handler = sdk.createNodeHttpHandler();
     *   if (handler.matches(req)) return handler.handle(req, res);
     */
    createNodeHttpHandler(options = {}) {
        const installGlobalErrorHandlers = options.installGlobalErrorHandlers !== false;
        if (installGlobalErrorHandlers) {
            this.ensureGlobalErrorHandlers();
        }

        const app = express();
        app.disable('x-powered-by');
        app.use(express.json({
            limit: options.jsonLimit || '1mb'
        }));
        app.use(this.trackHttpTraffic.bind(this));
        app.use(this.router);
        app.use(this.handleHttpRouteError.bind(this));
        app.use((req, res) => {
            res.status(404).json({ code: 404, message: 'SDK route not found' });
        });

        const handle = (req, res) => app(req, res);
        handle.matches = this.matchesNodeHttpRequest.bind(this);
        handle.handle = handle;
        return handle;
    }

    // 简短别名，方便仅使用原生 Node HTTP 的宿主项目。
    createHttpHandler(options = {}) {
        return this.createNodeHttpHandler(options);
    }

    // 一键安装挂载到 express app 上，并集成全局流量估算拦截中间件与全局异常捕获。
    mount(app) {
        this.ensureGlobalErrorHandlers();
        app.use(this.trackHttpTraffic.bind(this));

        // 注册底座路由
        app.use(this.router);

        // 注册全局错误捕获中间件，实现零代码异常日志捕获
        app.use(this.handleHttpRouteError.bind(this));
    }
}

AhszPluginSDK.DefaultFileAnnouncementAdapter = DefaultFileAnnouncementAdapter;
AhszPluginSDK.normalizeAnnouncement = normalizeAnnouncement;
AhszPluginSDK.Extensions = AhszPluginExtensions;

module.exports = AhszPluginSDK;
