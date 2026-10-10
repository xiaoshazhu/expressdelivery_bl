import { createHash } from 'node:crypto';
import { ApiError } from '../service.mjs';

const aliases = new Map(Object.entries({
  '京东': 'jd', '京东物流': 'jd', '京东快递': 'jd', '京东快运': 'jingdongkuaiyun',
  '邮政': 'youzhengguonei', '邮政快递': 'youzhengguonei', '邮政快递包裹': 'youzhengguonei', 'EMS': 'ems', '中国邮政': 'chinapost',
  '安能': 'annengwuliu', '安能快运': 'annengwuliu', '跨越': 'kuayue', '跨越速运': 'kuayue',
  '顺丰': 'shunfeng', '顺丰速运': 'shunfeng', '顺丰快运': 'shunfengkuaiyun',
  '中通': 'zhongtong', '中通快递': 'zhongtong', '中通快运': 'zhongtongkuaiyun',
  '圆通': 'yuantong', '圆通速递': 'yuantong', '申通': 'shentong', '韵达': 'yunda', '极兔': 'jtexpress', '德邦': 'debangkuaidi',
}));
const stateNames = { '0': '在途', '1': '揽收', '2': '疑难', '3': '签收', '4': '退签', '5': '派件', '6': '退回', '7': '转投', '8': '清关', '10': '待清关', '11': '清关中', '12': '已清关', '13': '清关异常', '14': '拒签' };
const phoneRequired = new Set(['shunfeng', 'shunfengkuaiyun', 'zhongtong']);
function normalizeCode(value) {
  const input = value.trim();
  const known = aliases.get(input) || aliases.get(input.toUpperCase());
  if (known) return known;
  if (/^[a-z][a-z0-9_-]{1,49}$/.test(input)) return input;
  throw new ApiError(422, 'UNKNOWN_CARRIER', `未识别承运商「${input}」，请填写快递100公司编码或使用自动识别`);
}
function normalizePhone(value) {
  if (!value) return '';
  const phone = String(value).trim();
  if (!/^[0-9-]{4,30}$/.test(phone)) throw new ApiError(400, 'INVALID_PHONE', '核验手机号格式错误，可填写完整号码或后四位');
  return phone;
}
async function json(response) {
  let data;
  try { data = await response.json(); } catch { throw new ApiError(502, 'PROVIDER_RESPONSE', '快递100返回了无法解析的响应'); }
  if (!response.ok) throw new ApiError(502, 'PROVIDER_HTTP', `快递100服务异常（HTTP ${response.status}）`);
  return data;
}
export function createKuaidi100Provider({ key, customer, fetchImpl = fetch, queryUrl = 'https://poll.kuaidi100.com/poll/query.do', recognizeUrl = 'https://www.kuaidi100.com/autonumber/auto', now = Date.now, cacheTtlMs = 30 * 60 * 1000 }) {
  if (!key || !customer) throw new ApiError(503, 'PROVIDER_NOT_CONFIGURED', '请在服务端配置 KUAIDI100_KEY 和 KUAIDI100_CUSTOMER');
  const cache = new Map();
  async function recognize(number) {
    const url = new URL(recognizeUrl); url.searchParams.set('num', number); url.searchParams.set('key', key);
    const data = await json(await fetchImpl(url, { signal: AbortSignal.timeout(10000) }));
    if (!Array.isArray(data) || !data[0]?.comCode) throw new ApiError(404, 'CARRIER_NOT_RECOGNIZED', data?.message || '无法自动识别快递公司，请在快递公司列填写公司编码');
    return { code: data[0].comCode, name: data[0].name || data[0].comCode };
  }
  return {
    async query({ number, carrier, phone }) {
      const identified = carrier === '自动识别' ? await recognize(number) : { code: normalizeCode(carrier), name: carrier };
      const verifiedPhone = normalizePhone(phone);
      if (phoneRequired.has(identified.code) && !verifiedPhone) throw new ApiError(400, 'PHONE_REQUIRED', `${identified.name}查询需要收件人或寄件人手机号；请映射「核验手机号」文本列`);
      const cacheKey = `${identified.code}:${number}:${verifiedPhone}`;
      const cached = cache.get(cacheKey);
      if (cached && cached.expiresAt > now()) return { ...cached.result, cached: true };
      const param = JSON.stringify({ com: identified.code, num: number, ...(verifiedPhone ? { phone: verifiedPhone } : {}), resultv2: '4', order: 'desc', show: '0' });
      const sign = createHash('sha256').update(param + key + customer).digest('hex').toUpperCase();
      const body = new URLSearchParams({ customer, sign, signType: 'SHA256', param });
      const data = await json(await fetchImpl(queryUrl, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body, signal: AbortSignal.timeout(15000) }));
      const responseStatus = String(data.status || data.returnCode || '');
      if (responseStatus !== '200') {
        const status = responseStatus;
        if (status === '601') throw new ApiError(402, 'PROVIDER_QUOTA_EXHAUSTED', '快递100实时查询没有可用单量，请在企业管理后台的“账户概览 → 立即充值”购买查询套餐');
        if (status === '600') throw new ApiError(402, 'PROVIDER_ACCOUNT_OR_BALANCE', '快递100账号或授权 Key 无效，或账户没有可用余额；请检查当前账号并充值实时查询套餐');
        if (status === '503') throw new ApiError(502, 'PROVIDER_SIGNATURE', '快递100签名验证失败，请核对同一账号下的 key 与 customer');
        if (status === '504') throw new ApiError(429, 'PROVIDER_RATE_LIMIT', '快递100限制了频繁查询，请降低频率并按提示等待后再试');
        if (status === '408') throw new ApiError(400, 'PHONE_INVALID', '快递公司未通过手机号核验，请填写正确的收件人或寄件人手机号');
        if (status === '500') throw new ApiError(404, 'NO_TRACKING', '暂未查询到物流信息，请核对快递公司、单号及是否已经发货');
        if (status === '401') throw new ApiError(422, 'UNSUPPORTED_CARRIER', '账号不支持该快递公司，或快递公司识别错误');
        if (status === '501' || status === '502') throw new ApiError(502, 'PROVIDER_UNAVAILABLE', '快递100服务暂时异常，请稍后再试');
        throw new ApiError(422, 'PROVIDER_ERROR', `快递100查询失败：${data.message || status || '未知错误'}`);
      }
      const items = Array.isArray(data.data) ? data.data : [];
      if (!items.length) throw new ApiError(404, 'NO_TRACKING', '快递100暂未返回物流轨迹');
      const queriedAt = new Date(now()).toISOString();
      const state = stateNames[String(data.state)] || items[0]?.status || '状态未知';
      const result = { number: data.nu || number, carrier: identified.name, carrierCode: data.com || identified.code, state, mock: false, queriedAt, summary: `${identified.name} · ${state} · ${items[0].context}`, events: items.map(item => ({ time: item.ftime || item.time, content: item.context, status: item.status || '', location: item.location || '' })) };
      cache.set(cacheKey, { result, expiresAt: now() + cacheTtlMs });
      return result;
    },
  };
}
