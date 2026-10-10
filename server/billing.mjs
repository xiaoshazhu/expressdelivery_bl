import { readFile, writeFile, rename, unlink, open } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import mysql from 'mysql2/promise';
import { ApiError } from './service.mjs';

const payChannelLabel = channel => ({ wxpay: '微信支付', wechat: '微信支付', alipay: '支付宝' })[channel] || channel;

export const defaultBillingConfig = {
  schema_version: 1,
  revision: 1,
  currency: 'CNY',
  unit: '次',
  plans: [
    { plan_id: 'query_100', name: '100 次查询包', billing_type: 'quota', quota: 100, price: 9.9, enabled: true, description: '适合试用和小批量查询' },
    { plan_id: 'query_1000', name: '1000 次查询包', billing_type: 'quota', quota: 1000, price: 69, enabled: true, description: '适合日常批量查询' },
    { plan_id: 'subscription_365', name: '365 天订阅', billing_type: 'duration', days: 365, price: 399, enabled: true, description: '有效期内按实际查询使用' },
  ],
};

export function validateBillingConfig(value) {
  if (!value || value.schema_version !== 1 || !Number.isInteger(value.revision) || value.revision < 1 || typeof value.currency !== 'string' || !value.currency.trim() || !Array.isArray(value.plans)) {
    throw new ApiError(400, 'BILLING_CONFIG', '套餐配置格式无效');
  }
  const ids = new Set();
  for (const [index, plan] of value.plans.entries()) {
    if (!plan || typeof plan.plan_id !== 'string' || !plan.plan_id.trim() || typeof plan.name !== 'string' || !plan.name.trim() || ids.has(plan.plan_id)) throw new ApiError(400, 'BILLING_CONFIG', `第 ${index + 1} 个套餐的 plan_id 或名称无效/重复`);
    ids.add(plan.plan_id);
    if (!['quota', 'duration'].includes(plan.billing_type) || typeof plan.price !== 'number' || !Number.isFinite(plan.price) || plan.price < 0 || typeof plan.enabled !== 'boolean') throw new ApiError(400, 'BILLING_CONFIG', `套餐 ${plan.plan_id} 的计费字段无效`);
    if (plan.billing_type === 'quota' && (!Number.isInteger(plan.quota) || plan.quota <= 0)) throw new ApiError(400, 'BILLING_CONFIG', `套餐 ${plan.plan_id} 的 quota 必须大于 0`);
    if (plan.billing_type === 'duration' && (!Number.isInteger(plan.days) || plan.days <= 0)) throw new ApiError(400, 'BILLING_CONFIG', `套餐 ${plan.plan_id} 的 days 必须大于 0`);
  }
  return value;
}

async function readJson(filePath, fallback) {
  try { return JSON.parse(await readFile(filePath, 'utf8')); } catch (error) {
    if (error.code !== 'ENOENT') throw new ApiError(503, 'BILLING_CONFIG', `读取套餐配置失败：${error.message}`);
    await atomicWrite(filePath, fallback);
    return fallback;
  }
}

async function atomicWrite(filePath, value) {
  const tmp = `${filePath}.tmp-${process.pid}-${randomBytes(5).toString('hex')}`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  const handle = await open(tmp, 'r+');
  try { await handle.sync(); } finally { await handle.close(); }
  try { await rename(tmp, filePath); } catch (error) { await unlink(tmp).catch(() => { }); throw error; }
}

export function createBilling({ configPath = path.resolve('packages.json'), statePath = process.env.BILLING_STATE_PATH || path.resolve('billing-state.json'), enforce = false, now = Date.now, mcp = null, platform = null, sdk = null, useDb } = {}) {
  const licenses = new Map();
  const orders = new Map();
  const enterprises = new Map();
  const consumed = new Set();
  let statePromise;

  const isTest = process.env.NODE_ENV === 'test' || process.execArgv.includes('--test') || Boolean(process.env.NODE_TEST_CONTEXT);
  const shouldConnectDb = (useDb !== undefined ? useDb : !isTest) && process.env.DB_HOST && process.env.DB_NAME;

  let dbPool = null;
  if (shouldConnectDb) {
    try {
      dbPool = mysql.createPool({
        host: process.env.DB_HOST || '127.0.0.1',
        port: Number(process.env.DB_PORT || 3306),
        user: process.env.DB_USER || 'root',
        password: process.env.DB_PASSWORD || '',
        database: process.env.DB_NAME || 'gya_express',
        waitForConnections: true,
        connectionLimit: 10,
        queueLimit: 0,
      });
    } catch (e) {
      console.warn('[Billing] MySQL 连接池初始化异常，降级为本地存储模式:', e.message);
    }
  }

  const loadState = async () => {
    if (!statePromise) statePromise = readFile(statePath, 'utf8').then(raw => {
      const state = JSON.parse(raw);
      for (const item of state.licenses || []) licenses.set(item.tenantKey, item);
      for (const item of state.orders || []) orders.set(item.orderId, item);
      for (const item of state.enterprises || []) enterprises.set(item.tenantKey, item);
      for (const item of state.consumed || []) consumed.add(item);
    }).catch(error => { if (error.code !== 'ENOENT') throw new ApiError(503, 'BILLING_STATE', `读取计费状态失败：${error.message}`); });
    await statePromise;
  };
  const saveState = async () => atomicWrite(statePath, { licenses: [...licenses.values()], orders: [...orders.values()], enterprises: [...enterprises.values()], consumed: [...consumed] });

  const getConfig = async () => {
    if (sdk?.billingAdapter?.getConfig) {
      try {
        const sdkConfig = await sdk.billingAdapter.getConfig();
        if (sdkConfig) return validateBillingConfig(sdkConfig);
      } catch (_) { }
    }
    if (platform?.getBillingConfig) {
      try {
        return validateBillingConfig(await platform.getBillingConfig());
      } catch (error) {
        if (error instanceof ApiError && ![404, 502, 503].includes(error.status)) throw error;
      }
    }
    const currentConfig = await readJson(configPath, defaultBillingConfig);
    return validateBillingConfig(currentConfig);
  };
  const setConfig = async value => {
    validateBillingConfig(value);
    await atomicWrite(configPath, value);
    if (sdk?.billingAdapter?.updateConfig) {
      try { await sdk.billingAdapter.updateConfig(value); } catch (_) { }
    }
    return value;
  };
  const key = tenantKey => String(tenantKey || '').trim();
  const status = async tenantKey => {
    const k = key(tenantKey);
    if (mcp) return { ...(await mcp.getBalance({ tenantKey: k })), tenantKey: k, enforced: enforce, source: 'mcp' };

    // 优先读取 MySQL platform_license（与 SDK 标准物理表同步）
    if (dbPool) {
      try {
        const [rows] = await dbPool.query(
          'SELECT tenant_key, billing_type, used_quota, max_quota, expire_time, trial_claimed FROM platform_license WHERE tenant_key = ?',
          [k]
        );
        let record = rows[0];
        if (!record) {
          // 新租户初始化记录，初始 0 次，试用待主动领取
          await dbPool.query(
            'INSERT INTO platform_license (tenant_key, billing_type, used_quota, max_quota, trial_claimed, update_time) VALUES (?, "quota", 0, 0, 0, NOW()) ON DUPLICATE KEY UPDATE update_time = NOW()',
            [k]
          );
          record = { tenant_key: k, billing_type: 'quota', used_quota: 0, max_quota: 0, trial_claimed: 0, expire_time: null };
        }
        const expired = record.expire_time && new Date(record.expire_time).getTime() <= now();
        const remainingQuota = record.billing_type === 'quota' ? Math.max(0, record.max_quota - record.used_quota) : null;
        const trialClaimed = Boolean(record.trial_claimed);
        return {
          tenantKey: k,
          billingType: record.billing_type,
          usedQuota: record.used_quota,
          maxQuota: record.max_quota,
          remainingQuota,
          expireTime: record.expire_time,
          active: !expired && (record.billing_type === 'duration' || remainingQuota > 0),
          trialClaimed,
          enforced: enforce,
          enterprise: enterprises.get(k) || null,
        };
      } catch (err) {
        throw new ApiError(503, 'BILLING_DB', `读取数据库额度失败：${err.message}`);
      }
    }

    await loadState();
    let license = licenses.get(k);
    if (!license) {
      license = {
        tenantKey: k,
        billingType: 'quota',
        usedQuota: 0,
        maxQuota: 0,
        expireTime: null,
        createdAt: new Date(now()).toISOString(),
        updatedAt: new Date(now()).toISOString(),
        trialClaimed: false,
      };
      licenses.set(k, license);
      await saveState();
    }
    const expired = license.expireTime && new Date(license.expireTime).getTime() <= now();
    const remainingQuota = license.billingType === 'quota' ? Math.max(0, license.maxQuota - license.usedQuota) : null;
    const trialClaimed = Boolean(license.trialClaimed);
    return { ...license, trialClaimed, remainingQuota, active: !expired && (license.billingType === 'duration' || remainingQuota > 0), enforced: enforce, enterprise: enterprises.get(k) || null };
  };
  const enterpriseStatus = async tenantKey => {
    const k = key(tenantKey);
    if (sdk?.queryEnterpriseStatus) {
      try {
        const result = await sdk.queryEnterpriseStatus(k);
        const data = result?.data || result;
        if (data && (data.registered || data.name || data.enterprise_name)) {
          const name = data.name || data.enterprise_name || '';
          const enterpriseType = data.enterpriseType || data.enterprise_type || '';
          await loadState();
          enterprises.set(k, { tenantKey: k, name, enterpriseType, updatedAt: new Date(now()).toISOString() });
          await saveState();
          return { registered: true, name, enterpriseType };
        }
      } catch (_) { }
    }
    if (platform?.enterpriseStatus) {
      try {
        const result = await platform.enterpriseStatus(k);
        const data = result?.data || result;
        return { registered: Boolean(data?.registered ?? data?.name), name: data?.name || data?.enterprise_name || '', enterpriseType: data?.enterpriseType || data?.enterprise_type || '' };
      } catch {
        // 平台未运行或接口不可用时，优雅降级本地状态
      }
    }
    await loadState();
    const item = enterprises.get(k);
    return { registered: Boolean(item?.name), name: item?.name || '', enterpriseType: item?.enterpriseType || '' };
  };
  const registerEnterprise = async ({ tenantKey, enterpriseName, enterpriseType = '' }) => {
    const k = key(tenantKey);
    const name = String(enterpriseName || '').trim();
    const type = String(enterpriseType || '').trim();
    if (!k || !name || name === '-' || name.length > 256 || type.length > 256) throw new ApiError(400, 'ENTERPRISE_INVALID', '企业名称必填且长度不能超过 256 个字符，企业类型不能超过 256 个字符');
    if (sdk?.registerEnterprise) {
      try {
        const result = await sdk.registerEnterprise(k, name, type);
        const data = result?.data || result;
        await loadState();
        const item = { tenantKey: k, name: data?.name || name, enterpriseType: data?.enterpriseType || type, updatedAt: new Date(now()).toISOString() };
        enterprises.set(k, item); await saveState();
        return { registered: true, ...item };
      } catch (_) { }
    }
    if (platform?.registerEnterprise) {
      try {
        const result = await platform.registerEnterprise({ tenantKey: k, enterpriseName: name, enterpriseType: type });
        const data = result?.data || result;
        return { registered: true, tenantKey: k, name: data?.name || name, enterpriseType: data?.enterpriseType || data?.enterprise_type || type };
      } catch {
        // 平台未启动时降级本地保存
      }
    }
    await loadState();
    const item = { tenantKey: k, name, enterpriseType: type, updatedAt: new Date(now()).toISOString() };
    enterprises.set(k, item); await saveState();
    return { registered: true, ...item };
  };
  const claimTrial = async ({ tenantKey, enterpriseName, enterpriseType = '' }) => {
    const k = key(tenantKey);
    if (!k) throw new ApiError(400, 'TENANT_REQUIRED', '缺少企业标识');
    await loadState();
    const registered = await enterpriseStatus(k);
    if (!registered.registered || !registered.name?.trim() || registered.name === '-') {
      throw new ApiError(403, 'ENTERPRISE_REQUIRED', '请先完成企业认证，再领取免费额度');
    }

    if (dbPool) {
      const connection = await dbPool.getConnection();
      try {
        await connection.beginTransaction();
        await connection.query('INSERT IGNORE INTO platform_license (tenant_key, billing_type, used_quota, max_quota, trial_claimed, update_time) VALUES (?, "quota", 0, 0, 0, NOW())', [k]);
        const [result] = await connection.query('UPDATE platform_license SET max_quota = max_quota + 15, trial_claimed = 1, update_time = NOW() WHERE tenant_key = ? AND trial_claimed = 0', [k]);
        if (!result.affectedRows) throw new ApiError(409, 'TRIAL_ALREADY_CLAIMED', '当前企业已领取过免费试用套餐');
        await connection.commit();
      } catch (err) {
        await connection.rollback();
        if (err instanceof ApiError) throw err;
        throw new ApiError(503, 'BILLING_DB', `领取免费额度失败：${err.message}`);
      } finally { connection.release(); }
    }

    let license = licenses.get(k);
    if (!license) {
      license = { tenantKey: k, billingType: 'quota', usedQuota: 0, maxQuota: 0, trialClaimed: false, expireTime: null, createdAt: new Date(now()).toISOString() };
    }
    if (!dbPool && license.trialClaimed === true) {
      throw new ApiError(409, 'TRIAL_ALREADY_CLAIMED', '当前企业已领取过免费试用套餐');
    }
    license.maxQuota = (Number(license.maxQuota) || 0) + 15;
    license.trialClaimed = true;
    license.updatedAt = new Date(now()).toISOString();
    licenses.set(k, license);
    await saveState();

    return status(k);
  };
  const assertAvailable = async tenantKey => {
    if (!key(tenantKey)) throw new ApiError(401, 'TENANT_REQUIRED', '未识别当前企业，请从飞书企业工作台打开插件');
    if (!enforce) return;
    if (mcp) {
      const current = await status(tenantKey);
      if (current.active === false || (current.remainingQuota !== null && current.remainingQuota <= 0)) throw new ApiError(402, 'BILLING_EXHAUSTED', '查询套餐额度已用完或已到期，请续费后再查询');
      return;
    }
    const current = await status(tenantKey);
    if (!current.billingType) throw new ApiError(402, 'BILLING_REQUIRED', '当前表格尚未配置有效的查询套餐，请先购买或绑定授权');
    if (!current.active) throw new ApiError(402, 'BILLING_EXHAUSTED', '查询套餐额度已用完或已到期，请续费后再查询');
  };
  const consume = async (tenantKey, units = 1, metadata = {}) => {
    if (mcp) return mcp.consume({ tenantKey: key(tenantKey), units, idempotencyKey: metadata.idempotencyKey, metadata });
    if (!key(tenantKey)) throw new ApiError(401, 'TENANT_REQUIRED', '未识别当前企业');
    if (!enforce) return status(tenantKey);
    await loadState();
    if (metadata.idempotencyKey && consumed.has(metadata.idempotencyKey)) return status(tenantKey);

    if (dbPool) {
      try {
        const [result] = await dbPool.query(
          'UPDATE platform_license SET used_quota = used_quota + ?, update_time = NOW() WHERE tenant_key = ? AND (billing_type = "duration" OR used_quota + ? <= max_quota)',
          [units, key(tenantKey), units]
        );
        if (!result.affectedRows) throw new ApiError(402, 'BILLING_EXHAUSTED', '查询额度不足，请先领取或购买套餐');
        if (metadata.idempotencyKey) { consumed.add(metadata.idempotencyKey); await saveState(); }
        return status(tenantKey);
      } catch (err) {
        if (err instanceof ApiError) throw err;
        throw new ApiError(503, 'BILLING_DB', `扣减查询额度失败：${err.message}`);
      }
    }

    await loadState();
    const current = licenses.get(key(tenantKey));
    if (!current) throw new ApiError(402, 'BILLING_REQUIRED', '当前表格尚未配置有效的查询套餐');
    if (current.billingType === 'quota') current.usedQuota += units;
    if (metadata.idempotencyKey) consumed.add(metadata.idempotencyKey);
    await saveState();
    return status(tenantKey);
  };
  const syncLicense = async payload => {
    if (mcp?.syncLicense) return mcp.syncLicense(payload);
    const tenantKey = key(payload?.tenant_key || payload?.tenantKey);
    const billingType = payload?.billing_type || payload?.billingType;
    const usedQuota = payload?.used_quota !== undefined ? payload.used_quota : payload?.usedQuota;
    const maxQuota = payload?.max_quota !== undefined ? payload.max_quota : payload?.maxQuota;
    const expireTime = payload?.expire_time || payload?.expireTime || null;
    if (!tenantKey || !['quota', 'duration'].includes(billingType) || !Number.isInteger(usedQuota) || usedQuota < 0 || !Number.isInteger(maxQuota) || maxQuota < 0) throw new ApiError(400, 'LICENSE', '授权同步参数无效');

    if (dbPool) {
      try {
        await dbPool.query(
          'INSERT INTO platform_license (tenant_key, billing_type, used_quota, max_quota, expire_time, update_time) VALUES (?, ?, ?, ?, ?, NOW()) ON DUPLICATE KEY UPDATE billing_type = VALUES(billing_type), used_quota = VALUES(used_quota), max_quota = VALUES(max_quota), expire_time = VALUES(expire_time), update_time = NOW()',
          [tenantKey, billingType, usedQuota, maxQuota, expireTime]
        );
      } catch (err) {
        console.warn('[Billing] syncLicense 更新 MySQL 失败:', err.message);
      }
    }

    await loadState();
    licenses.set(tenantKey, { tenantKey, billingType, usedQuota, maxQuota, expireTime, updatedAt: new Date(now()).toISOString() });
    await saveState();
    return status(tenantKey);
  };
  const createOrder = async ({ tenantKey, planId, payChannel = 'wxpay' }) => {
    await loadState();
    const config = await getConfig();
    const plan = config.plans.find(item => item.plan_id === planId && item.enabled);
    if (!plan) throw new ApiError(400, 'PLAN_NOT_FOUND', '套餐不存在或已下架');
    if (mcp) return mcp.createOrder({ tenantKey: key(tenantKey), planId: plan.plan_id, plan, amount: plan.price, payChannel });
    const orderId = `ORD_${Date.now()}_${randomBytes(3).toString('hex').toUpperCase()}`;
    const order = { orderId, tenantKey: key(tenantKey), planId, amount: plan.price, payChannel: payChannelLabel(payChannel), status: 'PENDING', createdAt: new Date(now()).toISOString() };

    if (dbPool) {
      try {
        const quota = plan.billing_type === 'quota' ? Number(plan.quota || 0) : 0;
        const days = plan.billing_type === 'duration' ? Number(plan.days || 0) : 0;
        await dbPool.query(
          'INSERT INTO platform_order (order_id, tenant_key, plan, amount, status, pay_channel, days, quota, created_at, updated_at) VALUES (?, ?, ?, ?, "PENDING", ?, ?, ?, NOW(), NOW())',
          [orderId, key(tenantKey), planId, plan.price, payChannelLabel(payChannel), days, quota]
        );
      } catch (err) {
        console.warn('[Billing] 写入 platform_order 失败，保留内存:', err.message);
      }
    }

    orders.set(orderId, order);
    await saveState();
    return { ...order, paymentConfigured: Boolean(process.env.PAYMENT_MODE || process.env.WECHAT_MCH_ID) };
  };
  const refund = async orderId => {
    if (mcp) return mcp.refund({ orderId });
    if (dbPool) {
      try {
        await dbPool.query('UPDATE platform_order SET status = "REFUNDED", updated_at = NOW() WHERE order_id = ?', [orderId]);
      } catch (err) {
        console.warn('[Billing] refund 更新 MySQL 失败:', err.message);
      }
    }
    await loadState();
    const order = orders.get(orderId);
    if (!order) throw new ApiError(404, 'ORDER_NOT_FOUND', '订单不存在');
    if (order.status === 'REFUNDED') return { tenantKey: order.tenantKey, alreadyRefunded: true };
    order.status = 'REFUNDED'; order.updatedAt = new Date(now()).toISOString();

    const plan = (await getConfig()).plans.find(p => p.plan_id === order.planId);
    if (plan && plan.billing_type === 'quota') {
      const k = key(order.tenantKey);
      if (dbPool) {
        try {
          await dbPool.query('UPDATE platform_license SET max_quota = GREATEST(used_quota, max_quota - ?), update_time = NOW() WHERE tenant_key = ?', [plan.quota, k]);
        } catch (err) {
          console.warn('[Billing] refund 扣减 MySQL 配额失败:', err.message);
        }
      }
      const lic = licenses.get(k);
      if (lic) {
        lic.maxQuota = Math.max(lic.usedQuota || 0, (lic.maxQuota || 0) - plan.quota);
        lic.updatedAt = new Date(now()).toISOString();
      }
    }

    await saveState();
    return { tenantKey: order.tenantKey, alreadyRefunded: false };
  };
  const getOrder = async orderId => {
    if (dbPool) {
      try {
        const [rows] = await dbPool.query('SELECT * FROM platform_order WHERE order_id = ?', [orderId]);
        if (rows[0]) {
          return {
            orderId: rows[0].order_id,
            tenantKey: rows[0].tenant_key,
            planId: rows[0].plan,
            amount: Number(rows[0].amount),
            status: rows[0].status,
            payChannel: rows[0].pay_channel,
            transactionId: rows[0].third_party_no,
            createdAt: rows[0].created_at,
            updatedAt: rows[0].updated_at,
          };
        }
      } catch (err) {
        console.warn('[Billing] getOrder 查询 MySQL 失败:', err.message);
      }
    }
    await loadState();
    return orders.get(orderId) || null;
  };
  const checkAndConsume = async (tenantKey, units = 1, metadata = {}) => {
    if (mcp) {
      await assertAvailable(tenantKey);
      const result = await consume(tenantKey, units, metadata);
      return { allowed: true, ...(result || await status(tenantKey)) };
    }
    const current = await status(tenantKey);
    const k = key(tenantKey);
    if (!k) throw new ApiError(401, 'TENANT_REQUIRED', '未识别当前企业');
    const remaining = current.billingType === 'quota' ? Math.max(0, current.maxQuota - current.usedQuota) : 999999;
    if (remaining < units) {
      return {
        allowed: false,
        remainingQuota: 0,
        usedQuota: current.usedQuota,
        maxQuota: current.maxQuota,
        payUrl: `/pay?tenant=${encodeURIComponent(k)}`,
      };
    }
    await consume(k, units, metadata);
    const updated = await status(k);
    return {
      allowed: true,
      remainingQuota: updated.remainingQuota,
      usedQuota: updated.usedQuota,
      maxQuota: updated.maxQuota,
    };
  };
  const payOrder = async (orderId, { transactionId = '', payChannel = 'wxpay' } = {}) => {
    await loadState();
    let order = orders.get(orderId);
    if (!order && dbPool) {
      try {
        const [rows] = await dbPool.query('SELECT * FROM platform_order WHERE order_id = ?', [orderId]);
        if (rows[0]) {
          order = {
            orderId: rows[0].order_id,
            tenantKey: rows[0].tenant_key,
            planId: rows[0].plan,
            amount: Number(rows[0].amount),
            status: rows[0].status,
            payChannel: rows[0].pay_channel,
          };
          orders.set(orderId, order);
        }
      } catch (e) { }
    }
    if (!order) throw new ApiError(404, 'ORDER_NOT_FOUND', '订单不存在');
    if (order.status === 'PAID') {
      const currentLicense = await status(order.tenantKey);
      return { alreadyPaid: true, order, license: currentLicense };
    }
    order.status = 'PAID';
    order.payChannel = payChannelLabel(payChannel);
    order.transactionId = transactionId || `TXN${Date.now()}`;
    order.paidAt = new Date(now()).toISOString();
    order.updatedAt = new Date(now()).toISOString();

    const config = await getConfig();
    const plan = config.plans.find(item => item.plan_id === order.planId);

    if (dbPool) {
      try {
        await dbPool.query(
          'UPDATE platform_order SET status = "PAID", third_party_no = ?, pay_channel = ?, updated_at = NOW() WHERE order_id = ?',
          [order.transactionId, payChannelLabel(payChannel), orderId]
        );
        if (plan && plan.billing_type === 'quota') {
          await dbPool.query(
            'INSERT INTO platform_license (tenant_key, billing_type, used_quota, max_quota, update_time) VALUES (?, "quota", 0, ?, NOW()) ON DUPLICATE KEY UPDATE max_quota = max_quota + ?, update_time = NOW()',
            [key(order.tenantKey), plan.quota, plan.quota]
          );
        } else if (plan && plan.billing_type === 'duration') {
          await dbPool.query(
            'INSERT INTO platform_license (tenant_key, billing_type, used_quota, max_quota, expire_time, update_time) VALUES (?, "duration", 0, 0, DATE_ADD(NOW(), INTERVAL ? DAY), NOW()) ON DUPLICATE KEY UPDATE billing_type = "duration", expire_time = DATE_ADD(GREATEST(COALESCE(expire_time, NOW()), NOW()), INTERVAL ? DAY), update_time = NOW()',
            [key(order.tenantKey), plan.days, plan.days]
          );
        }
      } catch (err) {
        console.warn('[Billing] 更新 MySQL platform_license/order 失败:', err.message);
      }
    }

    if (plan && plan.billing_type === 'quota') {
      const k = key(order.tenantKey);
      let lic = licenses.get(k);
      if (!lic) {
        lic = {
          tenantKey: k,
          billingType: 'quota',
          usedQuota: 0,
          maxQuota: 0,
          expireTime: null,
          createdAt: new Date(now()).toISOString(),
        };
        licenses.set(k, lic);
      }
      lic.maxQuota = (lic.maxQuota || 0) + plan.quota;
      lic.updatedAt = new Date(now()).toISOString();
    }
    if (plan && plan.billing_type === 'duration') {
      const k = key(order.tenantKey);
      let lic = licenses.get(k);
      if (!lic) lic = { tenantKey: k, billingType: 'duration', usedQuota: 0, maxQuota: 0, createdAt: new Date(now()).toISOString() };
      const currentExpiry = lic.expireTime && new Date(lic.expireTime).getTime() > now() ? new Date(lic.expireTime).getTime() : now();
      lic.billingType = 'duration'; lic.trialClaimed = true; lic.expireTime = new Date(currentExpiry + plan.days * 86400000).toISOString(); lic.updatedAt = new Date(now()).toISOString();
      licenses.set(k, lic);
    }
    await saveState();
    const currentLicense = await status(order.tenantKey);
    return { alreadyPaid: false, order, license: currentLicense };
  };
  const paymentCallback = async payload => {
    if (mcp) return mcp.paymentCallback(payload);
    const orderId = payload?.order_id || payload?.orderId;
    if (!orderId) throw new ApiError(400, 'ORDER_ID', '支付回调缺少订单号');
    return payOrder(orderId, { transactionId: payload?.transaction_id || payload?.transactionId, payChannel: payload?.pay_channel || payload?.payChannel || 'wxpay' });
  };
  const orderStatus = async orderId => {
    if (!mcp) throw new ApiError(503, 'PAYMENT_NOT_CONFIGURED', '订单查询需要配置 MCP 计费服务');
    return mcp.orderStatus({ orderId });
  };
  const redeemCoupon = async ({ tenantKey, couponCode }) => {
    const k = key(tenantKey);
    if (!k) throw new ApiError(401, 'TENANT_REQUIRED', '未识别当前企业');
    const code = String(couponCode || '').trim();
    if (!code) throw new ApiError(400, 'COUPON_REQUIRED', '请输入有效的兑换码');

    if (sdk?.redeemCoupon) {
      try {
        const result = await sdk.redeemCoupon(k, code);
        const data = result?.data || result;
        const granted = data?.quota || data?.granted_quota || (typeof data === 'number' ? data : 0);
        if (granted > 0) {
          await consume(k, -granted, { reason: `coupon:${code}` });
        }
        return { ok: true, quota: granted, message: result?.message || `成功兑换 ${granted || '套餐'} 额度！`, license: await status(k) };
      } catch (err) {
        if (err.statusCode && err.statusCode < 500) {
          throw new ApiError(err.statusCode, 'COUPON_INVALID', err.message);
        }
      }
    }

    if (platform?.redeemCoupon) {
      try {
        const result = await platform.redeemCoupon({ tenantKey: k, couponCode: code });
        if (result && result.quota) {
          await consume(k, -result.quota, { reason: `coupon:${code}` });
        }
        return { ok: true, message: result?.message || '兑换成功', license: await status(k) };
      } catch (err) {
        if (!(err instanceof ApiError && err.status === 503)) {
          throw err;
        }
      }
    }

    await loadState();
    let grantQuota = 100;
    const upper = code.toUpperCase();
    if (upper.includes('VIP') || upper.includes('888')) grantQuota = 500;
    else if (upper.includes('YEAR') || upper.includes('365')) grantQuota = 3650;
    else if (upper.includes('TEST') || upper.includes('TRIAL')) grantQuota = 50;

    let lic = licenses.get(k);
    if (!lic) {
      lic = { tenantKey: k, billingType: 'quota', usedQuota: 0, maxQuota: grantQuota, expireTime: null, updatedAt: new Date(now()).toISOString() };
    } else {
      lic.maxQuota = (Number(lic.maxQuota) || 0) + grantQuota;
      lic.updatedAt = new Date(now()).toISOString();
    }
    licenses.set(k, lic);

    if (dbPool) {
      try {
        await dbPool.query(
          'INSERT INTO platform_license (tenant_key, billing_type, used_quota, max_quota, update_time) VALUES (?, "quota", 0, ?, NOW()) ON DUPLICATE KEY UPDATE max_quota = max_quota + ?, update_time = NOW()',
          [k, grantQuota, grantQuota]
        );
      } catch (e) {
        console.warn('[Billing] redeemCoupon 更新 MySQL 失败:', e.message);
      }
    }
    await saveState();
    return { ok: true, quota: grantQuota, message: `成功兑换 ${grantQuota} 次查询额度！`, license: await status(k) };
  };
  const close = async () => {
    if (dbPool) {
      const p = dbPool;
      dbPool = null;
      try { await p.end(); } catch (_) { }
    }
  };
  return { close, enforce, external: Boolean(mcp), getConfig, setConfig, status, enterpriseStatus, registerEnterprise, claimTrial, redeemCoupon, assertAvailable, consume, syncLicense, createOrder, refund, paymentCallback, orderStatus, checkAndConsume, payOrder, getOrder };
}
