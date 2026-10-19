import http from 'node:http';
import fs from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import AhszPluginSDK from 'ahsz-plugin-sdk-node';
import { ApiError, createService, formatResultText } from './service.mjs';
import { createSessions } from './sessions.mjs';
import { createKuaidi100Provider } from './providers/kuaidi100.mjs';
import { createAliyunKzExpressProvider } from './providers/aliyun-kzexpress.mjs';
import { createBilling } from './billing.mjs';
import { createWeChatPay } from './wechat-pay.mjs';
import { createMcpBillingClient } from './mcp-billing.mjs';
import { qrSvgDataUrl } from './qr.mjs';
import { createPlatformClient } from './platform.mjs';

// Public invitation URL; it contains no backend credential or service token.
const OFFICIAL_GROUP_URL = 'https://applink.feishu.cn/client/chat/chatter/add_by_link?link_token=c23v2186-e36c-42c9-a6e3-1bf381411a98';
const OFFICIAL_GROUP_ANNOUNCEMENT = '加入官方交流群，领享30次免费查询次数。';

// 自动加载 .env 环境变量文件，防止直接 node 执行时丢失配置
try {
  const envPath = path.resolve('.env');
  if (fs.existsSync(envPath) && typeof process.loadEnvFile === 'function') {
    process.loadEnvFile(envPath);
  }
} catch (_) { }

async function readBody(req, maxBytes = 32768) {
  let body = '', size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new ApiError(413, 'BODY_TOO_LARGE', '请求过大');
    body += chunk;
  }
  return body;
}

const requiredTenant = value => {
  const tenant = String(value || '').trim();
  if (!tenant) throw new ApiError(401, 'TENANT_REQUIRED', '未识别当前企业，请从飞书企业工作台打开插件');
  return tenant;
};

export function createServer(options = {}) {
  const mcpBilling = options.mcpBilling || (process.env.MCP_BILLING_URL ? createMcpBillingClient() : null);
  const platform = options.platform || createPlatformClient();
  let billing;

  const isTest = process.env.NODE_ENV === 'test' || process.execArgv.includes('--test') || Boolean(process.env.NODE_TEST_CONTEXT);
  const fallbackLink = process.env.FEISHU_GROUP_URL || OFFICIAL_GROUP_URL;

  // 初始化安汇数智官方统一接入 SDK
  const sdk = options.sdk !== undefined ? options.sdk : (isTest ? null : new AhszPluginSDK({
    pluginId: process.env.PLUGIN_ID || 'plg_express_assistant',
    apiToken: process.env.API_TOKEN || '',
    platformUrl: process.env.PLATFORM_API_URL || 'http://127.0.0.1:9000',
    platformWsUrl: process.env.PLATFORM_WS_URL || 'ws://127.0.0.1:9000/api/v1/ws/plugin',
    platformWsOrigin: process.env.PLATFORM_WS_ORIGIN || 'http://127.0.0.1:9000',
    dbHost: process.env.DB_HOST || '127.0.0.1',
    dbPort: Number(process.env.DB_PORT || 3306),
    dbUser: process.env.DB_USER || 'root',
    dbPassword: process.env.DB_PASSWORD || '',
    dbName: process.env.DB_NAME || 'gya_express',
    billingConfigPath: path.resolve(process.env.BILLING_CONFIG_PATH || './packages.json'),
    announcementConfigPath: path.resolve(process.env.ANNOUNCEMENT_CONFIG_PATH || './announcements.json'),
    logFilePath: path.resolve(process.env.LOG_FILE_PATH || './app.log'),
    pluginRootPath: path.resolve('.'),
    metricsInterval: 5,
    wsEnabled: process.env.AHSZ_WS_ENABLED !== 'false',
    instanceId: process.env.AHSZ_INSTANCE_ID || 'express-sidebar-main',
    orderAdapter: {
      markRefunded: async (orderId) => billing.markRefunded(orderId),
    },
    licenseAdapter: {
      syncFinalLicense: async (payload) => billing.syncLicense({
        tenant_key: payload.tenantKey || payload.tenant_key,
        billing_type: payload.billingType || payload.billing_type,
        used_quota: payload.usedQuota ?? payload.used_quota,
        max_quota: payload.maxQuota ?? payload.max_quota,
        expire_time: payload.expireTime || payload.expire_time,
      }),
      syncLicense: async (payload) => billing.syncLicense(payload),
    },
  }));

  billing = options.billing || createBilling({
    configPath: process.env.BILLING_CONFIG_PATH || path.resolve('packages.json'),
    enforce: process.env.BILLING_ENFORCE !== 'false',
    mcp: mcpBilling,
    platform,
    sdk,
  });

  const service = createService({ ...options, billing });
  const sessions = createSessions(options);
  const wechatPay = options.wechatPay || createWeChatPay(options);
  let pushedAnnouncements = [];
  const sdkHandler = sdk ? sdk.createNodeHttpHandler() : null;

  const server = http.createServer(async (req, res) => {
    // 跨域支持，方便飞书沙箱及前端调用
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, DELETE');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const send = (status, value) => {
      res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      });
      res.end(JSON.stringify(value));
    };

    try {
      const url = new URL(req.url, 'http://localhost');

      // 1. GET 路由
      if (req.method === 'GET') {
        // 健康检查接口：若携带 Bearer Token 则交给 SDK 处理平台健康检测；否则返回边栏前端所需状态
        if (url.pathname === '/api/health') {
          if (req.headers.authorization && sdkHandler.matches(req)) {
            sdkHandler.handle(req, res);
            return;
          }
          return send(200, {
            ok: true,
            providerMode: options.mode || process.env.PROVIDER_MODE || 'mock',
            providerConfigured: Boolean(options.provider || process.env.ALIYUN_EXPRESS_APPCODE),
            billingEnforced: billing.enforce,
            wechatPayConfigured: wechatPay.isConfigured,
            platformConfigured: Boolean(platform),
            productionReady: false,
            sdkReady: sdk.ready,
          });
        }

        // 统一 SDK 标准管理路由（如平台读取套餐、能力、公告）
        if (sdkHandler?.matches(req)) {
          sdkHandler.handle(req, res);
          return;
        }

        // 边栏前端公开公告接口：与 SDK announcement 保持一致并返回结构化列表
        if (url.pathname === '/api/announcement') {
          let announcements = [];
          let announcementData = null;
          if (sdk) {
            try {
              const resData = await sdk.getAnnouncement();
              announcementData = resData?.announcement;
              if (announcementData?.enabled) {
                if (Array.isArray(announcementData.items) && announcementData.items.length > 0) {
                  announcements = announcementData.items.filter(item => item && item.enabled !== false).map(item => ({
                    id: String(item.id || Math.random()),
                    title: String(item.text || item.title || '公告'),
                    content: '',
                    level: String(item.level || 'info'),
                    // Multi-item announcements must use their own URL. A legacy global URL
                    // must never make an unlinked item appear clickable.
                    linkUrl: item.linkUrl || item.link_url || item.url || '',
                    updatedAt: announcementData.updatedAt || null,
                  }));
                } else if (announcementData.text) {
                  announcements = [{
                    id: 'announcement-1',
                    title: String(announcementData.text),
                    content: '',
                    level: 'info',
                    linkUrl: announcementData.linkUrl || fallbackLink,
                    updatedAt: announcementData.updatedAt || null,
                  }];
                }
              }
            } catch (e) {
              console.warn('[Announcement] SDK 读取公告失败:', e.message);
            }
          } else {
            try {
              const raw = await readFile(path.resolve(process.env.ANNOUNCEMENT_CONFIG_PATH || './announcements.json'), 'utf8');
              const data = JSON.parse(raw);
              if (data?.enabled) {
                announcementData = data;
                if (Array.isArray(data.items)) {
                  announcements = data.items.filter(item => item && item.enabled !== false).map(item => ({
                    id: String(item.id || Math.random()),
                    title: String(item.text || item.title || '公告'),
                    content: '',
                    level: 'info',
                    linkUrl: item.linkUrl || item.link_url || item.url || '',
                    updatedAt: data.updatedAt || null,
                  }));
                }
              }
            } catch (_) { }
          }

          if (!announcements.length && pushedAnnouncements.length) {
            announcements = pushedAnnouncements;
          }

          if (!announcements.length) {
            announcements = [{
              id: 'official-group',
              title: OFFICIAL_GROUP_ANNOUNCEMENT,
              content: '',
              level: 'info',
              linkUrl: fallbackLink,
              updatedAt: null,
            }];
          }

          const resolvedGroupUrl = fallbackLink;

          return send(200, {
            ok: true,
            code: 0,
            announcements,
            announcement: announcementData,
            groupUrl: resolvedGroupUrl,
          });
        }

        if (url.pathname === '/api/license/status') {
          const tenantKey = requiredTenant(url.searchParams.get('tenant'));
          return send(200, {
            ok: true,
            license: await billing.status(tenantKey),
            config: await billing.getConfig(),
          });
        }

        if (url.pathname === '/api/enterprise/status' || url.pathname === '/api/subscription/enterprise-status') {
          const tenantKey = requiredTenant(url.searchParams.get('tenant'));
          return send(200, await billing.enterpriseStatus(tenantKey));
        }

        // 微信收银台页面
        if (['/pay', '/pay.html', '/cashier'].includes(url.pathname)) {
          const cashierPath = fileURLToPath(new URL('../public/pay.html', import.meta.url));
          const htmlBytes = await readFile(cashierPath, 'utf8');
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'X-Content-Type-Options': 'nosniff' });
          res.end(htmlBytes);
          return;
        }
      }

      // 2. POST 路由
      if (url.pathname.startsWith('/api/')) {
        // SDK 标准 POST 路由（如平台下发套餐 /api/plugin/billing/update、同步授权 /api/plugin/license/sync、退款 /api/plugin/order/refund 等）
        if (sdkHandler?.matches(req)) {
          sdkHandler.handle(req, res);
          return;
        }

        if (req.method !== 'POST') throw new ApiError(405, 'METHOD_NOT_ALLOWED', '请使用 POST 请求');
        const allowedPaths = [
          '/api/connect',
          '/api/disconnect',
          '/api/query',
          '/api/workflow/query',
          '/api/base/initialize',
          '/api/base/rows',
          '/api/base/query-record',
          '/api/base/auto-query-record',
          '/api/billing/status',
          '/api/billing/claim-trial',
          '/api/billing/register-enterprise',
          '/api/subscription/register-enterprise',
          '/api/subscription/claim-trial',
          '/api/billing/redeem-coupon',
          '/api/subscription/redeem-coupon',
          '/api/feedback',
          '/api/billing/create-order',
          '/api/pay/create-order',
          '/api/pay/wechat/create-order',
          '/api/pay/query-order',
          '/api/pay/wechat/query-order',
          '/api/pay/mock-pay',
          '/api/pay/wechat/mock-pay',
          '/api/pay/wechat/notify',
          '/api/billing/payment-callback',
          '/api/billing/order-status',
          '/api/billing/refund',
          '/api/license/check-and-consume',
          '/api/plugin/billing/update',
          '/api/plugin/license/sync',
          '/api/plugin/order/refund',
        ];
        if (!allowedPaths.includes(url.pathname)) throw new ApiError(404, 'NOT_FOUND', '接口不存在');
        if (!(req.headers['content-type'] || '').includes('application/json')) throw new ApiError(415, 'CONTENT_TYPE', '请使用 application/json');

        let body = '', size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 32768) throw new ApiError(413, 'BODY_TOO_LARGE', '请求过大');
          body += chunk;
        }
        let data;
        try {
          data = JSON.parse(body);
        } catch {
          throw new ApiError(400, 'INVALID_JSON', 'JSON 格式错误');
        }

        // 字段捷径额度校验与消耗接口
        if (url.pathname === '/api/license/check-and-consume') {
          return send(200, await billing.checkAndConsume(data?.tenantKey, data?.units || 1, { idempotencyKey: data?.idempotencyKey, source: 'field_shortcut', fieldId: data?.fieldId }));
        }

        if (url.pathname === '/api/billing/register-enterprise' || url.pathname === '/api/subscription/register-enterprise') {
          const tenantKey = requiredTenant(data?.tenantKey || data?.tenant_key);
          return send(200, await billing.registerEnterprise({ tenantKey, enterpriseName: data?.enterpriseName || data?.enterprise_name, enterpriseType: data?.enterpriseType || data?.enterprise_type || '' }));
        }
        if (url.pathname === '/api/billing/claim-trial' || url.pathname === '/api/subscription/claim-trial') {
          const tenantKey = requiredTenant(data?.tenantKey || data?.tenant_key);
          return send(200, await billing.claimTrial({ tenantKey, enterpriseName: data?.enterpriseName || data?.enterprise_name, enterpriseType: data?.enterpriseType || data?.enterprise_type || '' }));
        }

        if (url.pathname === '/api/billing/redeem-coupon' || url.pathname === '/api/subscription/redeem-coupon') {
          const tenantKey = requiredTenant(data?.tenantKey || data?.tenant_key);
          const couponCode = data?.couponCode || data?.coupon_code || '';
          return send(200, await billing.redeemCoupon({ tenantKey, couponCode }));
        }

        if (url.pathname === '/api/feedback') {
          const tenantKey = requiredTenant(data?.tenantKey);
          const content = String(data?.content || '').trim();
          const contact = String(data?.contact || '').trim();
          console.log(`[Feedback] 收到租户 [${tenantKey}] 反馈:`, { content, contact, time: new Date().toISOString() });
          return send(200, { ok: true, message: '反馈已收到，我们将及时响应处理，感谢您的支持！' });
        }

        if (url.pathname === '/api/billing/payment-callback') return send(200, await billing.paymentCallback(data));
        if (url.pathname === '/api/pay/wechat/notify') {
          const verified = wechatPay.verifyNotify({
            timestamp: req.headers['wechatpay-timestamp'],
            nonce: req.headers['wechatpay-nonce'],
            signature: req.headers['wechatpay-signature'],
            serial: req.headers['wechatpay-serial'],
            body,
          });
          if (!verified) throw new ApiError(401, 'WECHAT_NOTIFY_SIGNATURE', '微信支付通知验签失败');
          const event = data?.resource ? wechatPay.decryptNotifyResource(data.resource) : data;
          if (event?.trade_state !== 'SUCCESS') return send(200, { code: 'SUCCESS', message: '非成功交易通知已确认' });
          const result = await billing.paymentCallback({
            order_id: event?.out_trade_no,
            transaction_id: event?.transaction_id,
            pay_channel: 'wxpay',
            trade_state: event?.trade_state,
          });
          return send(200, { code: 'SUCCESS', message: '成功', ...result });
        }
        if (url.pathname === '/api/billing/order-status') {
          const orderId = data?.orderId || data?.order_id;
          if (billing.external) return send(200, await billing.orderStatus(orderId));
          const order = await billing.getOrder(orderId);
          if (!order) throw new ApiError(404, 'ORDER_NOT_FOUND', '订单不存在');
          return send(200, { order, license: await billing.status(order.tenantKey) });
        }
        if (url.pathname === '/api/billing/refund') return send(200, await billing.refund(data?.orderId || data?.order_id));

        // 微信扫码下单（兼容 /api/pay/wechat/create-order 与 /api/pay/create-order）
        if (url.pathname === '/api/pay/wechat/create-order' || url.pathname === '/api/pay/create-order') {
          const tenantKey = requiredTenant(data?.tenantKey);
          const enterprise = await billing.enterpriseStatus(tenantKey);
          if (!enterprise.lookupUnavailable && (!enterprise.registered || !enterprise.name?.trim() || enterprise.name === '-')) throw new ApiError(403, 'ENTERPRISE_REQUIRED', '请先完善企业信息后再充值');
          const order = await billing.createOrder({ tenantKey, planId: data?.planId, payChannel: 'wxpay' });
          if (billing.external) return send(200, order);
          const config = await billing.getConfig();
          const plan = config.plans.find(p => p.plan_id === data?.planId);
          const wxRes = await wechatPay.createNativeOrder({
            orderId: order.orderId,
            amount: order.amount,
            description: plan ? `${plan.name}（${plan.quota}次）` : '快递物流查询套餐包',
          });
          return send(200, {
            ...order,
            ...wxRes,
            qrImage: qrSvgDataUrl(wxRes.codeUrl),
            codeUrl: wxRes.codeUrl,
            planName: plan?.name,
            quota: plan?.quota,
          });
        }

        // 微信扫码查单与入账（兼容 /api/pay/wechat/query-order 与 /api/pay/query-order）
        if (url.pathname === '/api/pay/wechat/query-order' || url.pathname === '/api/pay/query-order') {
          const orderId = data?.orderId || data?.order_id;
          if (billing.external) return send(200, await billing.orderStatus(orderId));
          const order = await billing.getOrder(orderId);
          if (!order) throw new ApiError(404, 'ORDER_NOT_FOUND', '订单不存在');
          if (order.status === 'PAID') {
            return send(200, { isPaid: true, order, license: await billing.status(order.tenantKey) });
          }
          const wxRes = await wechatPay.queryOrder(orderId);
          if (wxRes.isPaid) {
            const result = await billing.payOrder(orderId, { transactionId: wxRes.transactionId, payChannel: 'wxpay' });
            return send(200, { isPaid: true, order: result.order, license: result.license });
          }
          return send(200, { isPaid: false, tradeState: wxRes.tradeState || order.status });
        }

        // 微信模拟支付（开发测试专用，兼容 /api/pay/wechat/mock-pay 与 /api/pay/mock-pay）
        if (url.pathname === '/api/pay/wechat/mock-pay' || url.pathname === '/api/pay/mock-pay') {
          const orderId = data?.orderId || data?.order_id;
          if (billing.external) return send(200, await billing.paymentCallback({ orderId, transactionId: `MOCK_WX_${Date.now()}`, payChannel: 'wxpay' }));
          const order = await billing.getOrder(orderId);
          if (!order) throw new ApiError(404, 'ORDER_NOT_FOUND', '订单不存在');
          const result = await billing.payOrder(orderId, { transactionId: `MOCK_WX_${Date.now()}`, payChannel: 'wxpay' });
          return send(200, { isPaid: true, ok: true, order: result.order, license: result.license });
        }

        if (url.pathname === '/api/connect') return send(200, await sessions.connect(data));
        const token = (req.headers.authorization || '').replace(/^Bearer /, '');
        if (url.pathname === '/api/plugin/billing/update') { requirePlatformToken(req); return send(200, await billing.setConfig(data)); }
        if (url.pathname === '/api/plugin/license/sync') { requirePlatformToken(req); return send(200, await billing.syncLicense(data)); }
        if (url.pathname === '/api/plugin/order/refund') { requirePlatformToken(req); return send(200, await billing.markRefunded(data?.order_id)); }
        const session = sessions.get(token);
        if (url.pathname === '/api/disconnect') { sessions.remove(token); return send(200, { ok: true }); }
        if (url.pathname === '/api/billing/status') return send(200, await billing.status(session.gateway?.tenantKey || session.gateway?.appToken || `session:${token}`));
        if (url.pathname === '/api/billing/create-order') return send(200, await billing.createOrder({ ...data, tenantKey: session.gateway?.tenantKey || session.gateway?.appToken || `session:${token}` }));
        if (url.pathname.startsWith('/api/base/')) {
          if (!session.gateway) throw new ApiError(400, 'FEISHU_REQUIRED', '需要先连接真实飞书表格');
          if (url.pathname.endsWith('/initialize')) return send(200, await session.gateway.initialize(data));
          if (url.pathname.endsWith('/rows')) return send(200, { rows: await session.gateway.rows(data?.mapping) });
          if (url.pathname.endsWith('/auto-query-record')) return send(200, await session.gateway.autoQueryRecord(data, service));
          return send(200, await session.gateway.queryRecord(data, service));
        }
        const sessionTenant = session.gateway?.tenantKey || session.gateway?.appToken || `session:${token}`;
        const requestId = String(req.headers['idempotency-key'] || data?.idempotencyKey || '').trim();
        const result = await service.query({ ...data, tenantKey: sessionTenant, ...(requestId ? { idempotencyKey: requestId } : {}) });
        return send(200, { ...result, resultText: formatResultText(result) });
      }

      // 3. 静态文件分发：/app/* 为飞书边栏插件，其余路径为官网
      if (req.method !== 'GET') throw new ApiError(405, 'METHOD_NOT_ALLOWED', '请求方法不支持');

      const distRoot = fileURLToPath(new URL('../dist/', import.meta.url));
      const siteRoot = fileURLToPath(new URL('../site/', import.meta.url));
      const MIME = {
        '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
        '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
        '.gif': 'image/gif', '.ico': 'image/x-icon', '.webp': 'image/webp', '.json': 'application/json; charset=utf-8',
      };

      let baseDir, rel;
      if (url.pathname === '/app' || url.pathname.startsWith('/app/')) {
        baseDir = distRoot;
        rel = url.pathname.slice('/app'.length).replace(/^\/+/, '');
        if (!rel) rel = 'index.html';
      } else {
        baseDir = siteRoot;
        rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
        if (!rel) rel = 'index.html';
      }

      const target = path.resolve(baseDir, rel);
      if (!target.startsWith(baseDir)) throw new ApiError(403, 'FORBIDDEN', '路径不可访问');
      let bytes;
      try {
        bytes = await readFile(target);
      } catch {
        throw new ApiError(404, 'NOT_FOUND', '页面不存在');
      }
      const mime = MIME[path.extname(target).toLowerCase()] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': mime, 'X-Content-Type-Options': 'nosniff' });
      res.end(bytes);
    } catch (error) {
      const isApiError = error instanceof ApiError;
      const safeDetail = process.env.NODE_ENV === 'production' ? '服务异常，请稍后重试' : (error instanceof Error && error.message ? error.message : '未知服务异常');
      console.error(`[HTTP ${req.method} ${req.url}]`, error instanceof Error ? `${error.name}: ${error.message}\n${error.stack}` : error);
      if (error?.cause) console.error(`[HTTP ${req.method} ${req.url}] Cause:`, error.cause);
      send(isApiError ? error.status : 500, { error: { code: error.code || 'INTERNAL_ERROR', message: isApiError ? error.message : safeDetail } });
    }
  });

  const originalClose = server.close.bind(server);
  server.close = function (cb) {
    sessions.close();
    if (typeof server.closeAllConnections === 'function') {
      try { server.closeAllConnections(); } catch (_) { }
    } else if (typeof server.closeIdleConnections === 'function') {
      try { server.closeIdleConnections(); } catch (_) { }
    }
    (async () => {
      try {
        if (billing?.close) await billing.close();
      } catch (_) { }
      try {
        if (sdk) {
          if (sdk.initPromise) await sdk.initPromise.catch(() => { });
          sdk.stop();
          if (sdk.pool) {
            await sdk.pool.end().catch(() => { });
            sdk.pool = null;
          }
        }
      } catch (_) { }
    })().finally(() => {
      originalClose(cb);
    });
    return server;
  };
  server.sdk = sdk;
  server.requestTimeout = 30000;
  return server;
}

function requirePlatformToken(req) {
  const expected = String(process.env.API_TOKEN || '').trim();
  const actual = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  if (!expected) throw new ApiError(503, 'BILLING_NOT_CONFIGURED', '计费平台 API_TOKEN 尚未配置');
  if (!actual || actual !== expected) throw new ApiError(403, 'BILLING_FORBIDDEN', '计费平台鉴权失败');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.env.NODE_ENV === 'production' && process.env.ALLOW_PRODUCTION !== 'true') {
    throw new Error('确认上线请在 .env 中设置 ALLOW_PRODUCTION=true（并已配置真实数据库、物流 AppCode 与计费），再以生产环境启动。');
  }
  const mode = process.env.PROVIDER_MODE || 'mock';
  let provider;
  if (mode === 'kuaidi100') provider = createKuaidi100Provider({ key: process.env.KUAIDI100_KEY, customer: process.env.KUAIDI100_CUSTOMER });
  if (mode === 'aliyun_kzexpress' && process.env.ALIYUN_EXPRESS_APPCODE) provider = createAliyunKzExpressProvider({ appCode: process.env.ALIYUN_EXPRESS_APPCODE });
  const server = createServer({ mode, provider });
  const port = Number(process.env.PORT || 8791);
  const host = process.env.HOST || '127.0.0.1';
  server.listen(port, host, async () => {
    console.log(`[ExpressFieldServer] Running at: http://${host}:${port}`);
    try {
      await server.sdk.start();
      console.log(`[AHSZ SDK] Successfully started and connected.`);
    } catch (err) {
      console.warn(`[AHSZ SDK] Start warning:`, err.message);
    }
  });

  const shutdown = () => {
    console.log('[Server] Gracefully shutting down...');
    server.close(() => {
      process.exit(0);
    });
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  process.on('uncaughtException', err => {
    console.error('[Server] Uncaught exception:', err);
  });
  process.on('unhandledRejection', reason => {
    console.warn('[Server] Unhandled rejection:', reason);
  });
}
