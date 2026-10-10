
export class ApiError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
export const carriers = ['自动识别', '京东', '邮政', '安能', '跨越', '顺丰'];

const phoneCarrierRules = [
  { code: 'SF', name: '顺丰速运', carrier: /^(?:SF|顺丰|顺丰速运)$/i, number: /^SF/i },
  { code: 'ZTO', name: '中通快递', carrier: /^(?:ZTO|中通|中通快递)$/i, number: /^ZTO/i },
  { code: 'KYE', name: '跨越速运', carrier: /^(?:KYE|跨越|跨越速运)$/i, number: /^KYE/i },
];

export function phoneRequirement(number, carrier = '自动识别') {
  const selected = String(carrier || '自动识别').trim();
  return phoneCarrierRules.find(rule => rule.carrier.test(selected) || (selected === '自动识别' && rule.number.test(number))) || null;
}

export function normalizePhone(value) {
  let phone = String(value || '').replace(/[\s+-]/g, '');
  if (/^861[3-9]\d{9}$/.test(phone)) phone = phone.slice(2);
  return phone;
}

export function validateQuery(body) {
  if (!body || typeof body !== 'object') throw new ApiError(400, 'INVALID_INPUT', '请求格式错误');
  const number = typeof body.number === 'string' ? body.number.trim() : '';
  const carrier = typeof body.carrier === 'string' ? body.carrier.trim() : '自动识别';
  if (!/^[A-Za-z0-9-]{6,32}$/.test(number)) throw new ApiError(400, 'INVALID_NUMBER', '单号须为 6–32 位字母、数字或连字符');
  if (!carrier || carrier.length > 30) throw new ApiError(400, 'INVALID_CARRIER', '请填写 1–30 字的承运商名称');
  const phone = normalizePhone(body.phone);
  if (phone && !/^(?:\d{4}|1[3-9]\d{9})$/.test(phone)) throw new ApiError(400, 'INVALID_PHONE', '手机号须为 11 位中国大陆手机号或后四位数字');
  return { number, carrier, phone };
}
export function formatResultText(result) {
  const lines = [
    `快递公司：${result.carrier}${result.carrierCode ? `（${result.carrierCode}）` : ''}`,
    `运单号：${result.number}`,
    ...(result.state ? [`当前状态：${result.state}`] : []),
    `最新信息：${result.summary}`,
    `查询时间：${result.queriedAt}`,
  ];
  if (result.events?.length) {
    lines.push('物流轨迹：');
    for (const item of result.events.slice(0, 50)) lines.push(`${item.time || '时间未知'}  ${item.content}${item.location ? `（${item.location}）` : ''}`);
    if (result.events.length > 50) lines.push(`其余 ${result.events.length - 50} 条轨迹请在边栏查看`);
  }
  const text = lines.join('\n');
  return text.length > 10000 ? `${text.slice(0, 9980)}\n…内容已截断` : text;
}
export function createService({ mode = 'mock', now = Date.now, provider, billing } = {}) {
  let minute = 0, count = 0;
  return {
    async query(input) {
      const { number, carrier, phone } = validateQuery(input);
      await billing?.assertAvailable(input?.tenantKey);
      if (mode !== 'mock') {
        const requirement = phoneRequirement(number, carrier);
        if (requirement && !phone) throw new ApiError(400, 'PHONE_REQUIRED', `${requirement.name}查询需要收件人或寄件人手机号（完整号码或后四位）；请填写并映射“核验手机号”列`);
      }
      const currentMinute = Math.floor(now() / 60000);
      if (currentMinute !== minute) { minute = currentMinute; count = 0; }
      if (++count > 120) throw new ApiError(429, 'RATE_LIMIT', '演示服务每分钟最多查询 120 次，请稍后再试');
      if (mode !== 'mock') {
        if (!provider) throw new ApiError(503, 'PROVIDER_NOT_CONFIGURED', '真实物流接口未配置，请检查服务端环境变量');
        const result = await provider.query({ number, carrier, phone });
        await billing?.consume(input?.tenantKey, 1, { idempotencyKey: input?.idempotencyKey, recordId: input?.recordId, number, carrier });
        return result;
      }
      if (!carriers.includes(carrier)) throw new ApiError(422, 'MANUAL_CARRIER', `已保留承运商「${carrier}」，当前没有轨迹接口，请手工更新物流信息`);
      if (number.endsWith('0000')) throw new ApiError(404, 'NO_TRACKING', '模拟场景：暂无物流轨迹');
      const resolved = carrier === '自动识别' ? (number.startsWith('JD') ? '京东' : number.startsWith('SF') ? '顺丰' : '邮政') : carrier;
      const queriedAt = new Date(now()).toISOString();
      const time = new Date(now() - 3600000).toISOString();
      const result = { number, carrier: resolved, mock: true, queriedAt, summary: `【模拟数据】${resolved} · 运输中 · 快件已到达分拨中心`, events: [{ time, content: '【模拟数据】快件已到达分拨中心' }, { time: new Date(now() - 86400000).toISOString(), content: '【模拟数据】承运商已揽收' }] };
      await billing?.consume(input?.tenantKey, 1, { idempotencyKey: input?.idempotencyKey, recordId: input?.recordId, number, carrier });
      return result;
    },
  };
}
