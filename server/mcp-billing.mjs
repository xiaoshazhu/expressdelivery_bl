import { ApiError } from './service.mjs';

// MCP/平台计费适配器：余额、扣次、支付下单、回调和退款均由外部账本负责。
// 路径可通过环境变量覆盖，方便“字段捷径”与普通收款模式使用不同入口。
export function createMcpBillingClient({ baseUrl = process.env.MCP_BILLING_URL, token = process.env.MCP_BILLING_TOKEN, fetchImpl = fetch, timeoutMs = 15000 } = {}) {
  if (!baseUrl || !token) throw new ApiError(503, 'MCP_BILLING_NOT_CONFIGURED', 'MCP 计费服务尚未配置');
  const root = String(baseUrl).replace(/\/+$/, '');
  const paths = {
    balance: process.env.MCP_BALANCE_PATH || '/balance',
    consume: process.env.MCP_CONSUME_PATH || '/usage/consume',
    createOrder: process.env.MCP_CREATE_ORDER_PATH || '/payments/orders',
    callback: process.env.MCP_PAYMENT_CALLBACK_PATH || '/payments/callback',
    refund: process.env.MCP_REFUND_PATH || '/payments/refund',
    orderStatus: process.env.MCP_ORDER_STATUS_PATH || '/payments/order-status',
  };
  async function call(method, path, body, query = {}) {
    const url = new URL(root + path);
    for (const [key, value] of Object.entries(query)) if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
    const response = await fetchImpl(url, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': body?.idempotencyKey || '' }, body: method === 'GET' ? undefined : JSON.stringify(body || {}), signal: AbortSignal.timeout(timeoutMs) });
    const raw = await response.text();
    let data; try { data = raw ? JSON.parse(raw) : {}; } catch { data = { message: raw }; }
    if (!response.ok) throw new ApiError(response.status >= 500 ? 502 : response.status, data.code || 'MCP_BILLING_ERROR', data.message || data.error || `MCP 计费请求失败（HTTP ${response.status}）`);
    return data.data ?? data;
  }
  return {
    getBalance: ({ tenantKey }) => call('GET', paths.balance, null, { tenant_key: tenantKey }),
    consume: payload => call('POST', paths.consume, payload),
    createOrder: payload => call('POST', paths.createOrder, payload),
    paymentCallback: payload => call('POST', paths.callback, payload),
    refund: payload => call('POST', paths.refund, payload),
    orderStatus: ({ orderId }) => call('GET', paths.orderStatus, null, { order_id: orderId }),
  };
}

