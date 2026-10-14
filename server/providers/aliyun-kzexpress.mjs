import { ApiError, normalizePhone, phoneRequirement } from '../service.mjs';

const ENDPOINT = 'https://kzexpress.market.alicloudapi.com/api-mall/api/express/query';
const aliases = new Map(Object.entries({
  '京东': 'JD', '京东物流': 'JD', '京东快递': 'JD',
  '邮政': 'POSTB', '中国邮政': 'POSTB', '邮政快递包裹': 'POSTB', 'EMS': 'EMS',
  '安能': 'ANE56', '安能物流': 'ANE56', '安能快运': 'ANE56',
  '跨越': 'KYE', '跨越速运': 'KYE',
  '顺丰': 'SF', '顺丰速运': 'SF',
  '中通': 'ZTO', '中通快递': 'ZTO',
  '圆通': 'YTO', '圆通速递': 'YTO',
  '申通': 'STO', '申通快递': 'STO',
  '韵达': 'YUNDA', '韵达速递': 'YUNDA',
  '极兔': 'JTSD', '极兔速递': 'JTSD',
  '德邦': 'DBL', '德邦快递': 'DBL', '德邦物流': 'DBL',
}));
const mobileRequired = new Set(['SF', 'ZTO', 'KYE']);

function carrierCode(value) {
  if (!value || value === '自动识别') return '';
  const input = String(value).trim();
  const known = aliases.get(input) || aliases.get(input.toUpperCase());
  if (known) return known;
  if (/^[A-Za-z0-9_-]{2,64}$/.test(input)) return input.toUpperCase();
  throw new ApiError(422, 'UNKNOWN_CARRIER', `未识别快递公司「${input}」，请填写该阿里云商品的 cpCode 或使用自动识别`);
}

function mobileValue(value) {
  if (!value) return '';
  const mobile = normalizePhone(value);
  if (!/^(?:\d{4}|1[3-9]\d{9})$/.test(mobile)) throw new ApiError(400, 'INVALID_PHONE', '阿里云快递查询手机号须为完整 11 位或后四位数字');
  return mobile;
}

function messageOf(data, fallback = '') {
  return String(data?.msg || data?.message || data?.Message || data?.errorMsg || fallback || '').trim();
}

async function parseResponse(response) {
  const raw = await response.text();
  let data;
  try { data = raw ? JSON.parse(raw) : {}; } catch { data = {}; }
  if (response.ok) return data;
  const detail = `${messageOf(data, raw.slice(0, 200))} ${response.headers.get('x-ca-error-message') || ''}`.trim();
  if (response.status === 403 && /quota|exhausted|次数|额度/i.test(detail)) throw new ApiError(402, 'PROVIDER_QUOTA_EXHAUSTED', '阿里云市场快递查询套餐次数已用完，请在“云市场 → 已购买的服务”中续购当前商品');
  if (response.status === 401 || response.status === 403) throw new ApiError(401, 'PROVIDER_CREDENTIAL', '阿里云 AppCode 无效或不属于当前快递查询商品，请在云市场已购买服务中重新复制 AppCode');
  if (response.status === 429) throw new ApiError(429, 'PROVIDER_RATE_LIMIT', '阿里云市场接口请求过于频繁，请稍后重试');
  throw new ApiError(502, 'PROVIDER_HTTP', `阿里云市场接口异常（HTTP ${response.status}${detail ? `：${detail}` : ''}）`);
}

function eventTime(value) {
  if (typeof value === 'number' || /^\d{11,}$/.test(String(value || ''))) {
    const date = new Date(Number(value));
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }
  return String(value || '');
}

export function createAliyunKzExpressProvider({ appCode, fetchImpl = fetch, endpoint = ENDPOINT, now = Date.now, cacheTtlMs = 30 * 60 * 1000 } = {}) {
  if (!appCode?.trim()) throw new ApiError(503, 'PROVIDER_NOT_CONFIGURED', '请在服务端配置 ALIYUN_EXPRESS_APPCODE');
  const url = new URL(endpoint);
  if (url.protocol !== 'https:' || url.hostname !== 'kzexpress.market.alicloudapi.com') throw new ApiError(500, 'PROVIDER_ENDPOINT', '阿里云快递查询地址不受信任');
  const cache = new Map();

  return {
    async query({ number, carrier, phone }) {
      const cpCode = carrierCode(carrier);
      const mobile = mobileValue(phone);
      const effectiveCpCode = cpCode || phoneRequirement(number, carrier)?.code || '';
      if (mobileRequired.has(effectiveCpCode) && !mobile) {
        const name = effectiveCpCode === 'SF' ? '顺丰速运' : effectiveCpCode === 'KYE' ? '跨越速运' : (carrier || '此快递');
        throw new ApiError(400, 'PHONE_REQUIRED', `${name}查询需要收件人或寄件人手机号（完整号码或后四位）；请在“核验手机号”列中填写`);
      }
      const cacheKey = `${effectiveCpCode || cpCode || 'AUTO'}:${number}:${mobile}`;
      const cached = cache.get(cacheKey);
      if (cached && cached.expiresAt > now()) return { ...cached.result, cached: true };

      const body = new URLSearchParams({ expressNo: number });
      if (mobile) body.set('mobile', mobile);
      if (cpCode || effectiveCpCode) body.set('cpCode', cpCode || effectiveCpCode);
      const response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: {
          Authorization: `APPCODE ${appCode.trim()}`,
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        },
        body,
        signal: AbortSignal.timeout(15000),
      });
      const payload = await parseResponse(response);
      const success = payload.success === true && String(payload.code) === '200';
      if (!success || !payload.data) {
        const detail = messageOf(payload, '未知错误');
        if (/quota|exhausted|次数|额度/i.test(detail)) throw new ApiError(402, 'PROVIDER_QUOTA_EXHAUSTED', '阿里云市场快递查询套餐次数已用完，请续购当前商品');
        if (/手机(?:号|号码|后四位|验证|校验)|mobile|phone/i.test(detail)) {
          if (!mobile) throw new ApiError(400, 'PHONE_REQUIRED', `阿里云接口要求核验手机号：${detail}`);
          throw new ApiError(400, 'PHONE_INVALID', `阿里云未通过手机号核验：${detail}`);
        }
        if (/无轨迹|未查询|不存在|暂无/i.test(detail)) throw new ApiError(404, 'NO_TRACKING', '暂未查询到物流轨迹，请核对快递公司、单号及是否已经发货');
        throw new ApiError(422, 'PROVIDER_ERROR', `阿里云快递查询失败：${detail}`);
      }

      const data = payload.data;
      if (mobileRequired.has(String(data.cpCode || '').toUpperCase()) && !mobile) throw new ApiError(400, 'PHONE_REQUIRED', '该快递公司需要收/寄件手机号（完整号码或后四位）；请填写并映射“核验手机号”列');
      if (data.mailNo && String(data.mailNo).trim().toUpperCase() !== number.toUpperCase()) throw new ApiError(502, 'PROVIDER_NUMBER_MISMATCH', '阿里云返回的运单号与请求单号不一致，结果未写入');
      if (effectiveCpCode && data.cpCode && String(data.cpCode).toUpperCase() !== effectiveCpCode) throw new ApiError(502, 'PROVIDER_CARRIER_MISMATCH', '阿里云返回的快递公司与请求公司不一致，结果未写入');
      const rawEvents = Array.isArray(data.logisticsTraceDetailList) ? data.logisticsTraceDetailList : [];
      const events = rawEvents.map(item => ({
        time: eventTime(item.time),
        content: String(item.desc || ''),
        status: String(item.subLogisticsStatus || item.logisticsStatus || ''),
        location: String(item.areaName || ''),
      })).filter(item => item.content).sort((a, b) => Date.parse(b.time) - Date.parse(a.time));
      if (!events.length && !String(data.theLastMessage || '').trim()) throw new ApiError(404, 'NO_TRACKING', '阿里云未返回物流轨迹，请核对本行快递单号、手机号和快递公司');
      const latest = String(data.theLastMessage || events[0]?.content || '已查询到物流信息');
      const state = String(data.logisticsStatusDesc || data.logisticsStatus || '状态未知');
      const company = String(data.logisticsCompanyName || data.cpCode || cpCode || '自动识别');
      const result = {
        number: String(data.mailNo || number),
        carrier: company,
        carrierCode: String(data.cpCode || cpCode || ''),
        state,
        mock: false,
        queriedAt: new Date(now()).toISOString(),
        summary: `${company} · ${state} · ${latest}`,
        events,
      };
      cache.set(cacheKey, { result, expiresAt: now() + cacheTtlMs });
      return result;
    },
  };
}
