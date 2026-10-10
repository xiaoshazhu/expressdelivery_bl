import { ApiError } from './service.mjs';

export function createPlatformClient({ baseUrl = process.env.PLATFORM_API_URL, token = process.env.PLATFORM_API_TOKEN || process.env.API_TOKEN, pluginId = process.env.PLUGIN_ID, fetchImpl = fetch, timeoutMs = 10000 } = {}) {
  const root = String(baseUrl || '').replace(/\/+$/, '');
  if (!root || !token) return null;
  async function call(method, pathname, body) {
    try {
      const response = await fetchImpl(`${root}${pathname}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(pluginId ? { 'X-Plugin-Id': pluginId } : {}) },
        body: method === 'GET' ? undefined : JSON.stringify(body || {}),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const raw = await response.text();
      let value; try { value = raw ? JSON.parse(raw) : {}; } catch { value = { message: raw }; }
      if (!response.ok || (value.code !== undefined && ![0, 200].includes(Number(value.code)))) throw new ApiError(response.status >= 500 ? 502 : response.status, value.code || 'PLATFORM_ERROR', value.message || value.msg || '线上平台请求失败');
      return value.data ?? value;
    } catch (err) {
      if (err instanceof ApiError) throw err;
      throw new ApiError(503, 'PLATFORM_UNAVAILABLE', `无法连接管理平台 (${root}): ${err.message}`);
    }
  }
  return {
    getBillingConfig: () => call('GET', '/api/plugin/billing/config'),
    updateBillingConfig: schema => call('POST', '/api/plugin/billing/update', schema),
    syncLicense: payload => call('POST', '/api/plugin/license/sync', payload),
    refundOrder: orderId => call('POST', '/api/plugin/order/refund', { order_id: orderId }),
    enterpriseStatus: tenantKey => call('GET', `/api/plugin/enterprise/status?tenant_key=${encodeURIComponent(tenantKey)}`),
    registerEnterprise: ({ tenantKey, enterpriseName, enterpriseType }) => call('POST', '/api/plugin/enterprise/register', { tenant_key: tenantKey, tenantKey, enterprise_name: enterpriseName, enterpriseName, enterprise_type: enterpriseType, enterpriseType }),
    redeemCoupon: ({ tenantKey, couponCode }) => call('POST', '/api/plugin/coupon/redeem', {
      tenant_key: tenantKey,
      tenantKey,
      coupon_code: couponCode,
      couponCode,
      plugin_id: pluginId,
    }),
    getAnnouncements: () => call('GET', process.env.PLATFORM_ANNOUNCEMENT_PATH || '/api/plugin/announcements'),
  };
}
