import { BaseClient } from '@lark-base-open/node-sdk';
import { ApiError, formatResultText } from './service.mjs';

const quiet = { debug() {}, info() {}, warn() {}, error() {}, trace() {} };
function unwrap(response) {
  if (response.code !== 0) throw new ApiError(502, 'FEISHU_ERROR', `飞书请求失败（${response.code}），请检查授权码、表格权限及参数`);
  return response.data || {};
}
export class BaseGateway {
  constructor({ appToken, personalBaseToken, tableId, tenantKey }, client) {
    if (![appToken, tableId].every(v => typeof v === 'string' && /^[A-Za-z0-9_-]{5,100}$/.test(v)) || typeof personalBaseToken !== 'string' || personalBaseToken.length < 8 || personalBaseToken.length > 512) throw new ApiError(400, 'BASE_CONFIG', '请填写有效的 appToken、tableId 和飞书授权码');
    this.appToken = appToken;
    this.tenantKey = typeof tenantKey === 'string' && tenantKey.trim() ? tenantKey.trim() : appToken;
    this.tableId = tableId;
    this.client = client || new BaseClient({ appToken, personalBaseToken, logger: quiet });
    if (!client) this.client.httpInstance.defaults.timeout = 15000;
  }
  async fields() {
    const items = []; let page_token;
    do {
      const data = unwrap(await this.client.base.appTableField.list({ path: { table_id: this.tableId }, params: { page_size: 100, page_token } }));
      items.push(...(data.items || []));
      if (!data.has_more) break;
      if (!data.page_token || data.page_token === page_token) throw new ApiError(502, 'PAGINATION', '飞书分页异常');
      page_token = data.page_token;
    } while (true);
    return items.map(f => ({ id: f.field_id, name: f.field_name, type: f.type }));
  }
  async mapping(mapping) {
    const fields = await this.fields();
    const number = fields.find(f => f.id === mapping?.number && f.type === 1);
    const info = fields.find(f => f.id === mapping?.info && f.type === 1);
    if (!number || !info || number.id === info.id) throw new ApiError(400, 'FIELD_MAPPING', '请选择两个不同的文本字段');
    const optional = {};
    for (const key of ['carrier', 'phone']) {
      if (!mapping?.[key]) continue;
      const field = fields.find(f => f.id === mapping[key] && f.type === 1);
      if (!field) throw new ApiError(400, 'FIELD_MAPPING', `${key === 'carrier' ? '快递公司' : '核验手机号'}字段必须是文本字段`);
      optional[key] = field.name;
    }
    return { number: number.name, info: info.name, ...optional };
  }
  async initialize() {
    const fields = await this.fields(); const mapping = {};
    // 先检查所有同名字段，防止类型冲突时产生部分改动。
    for (const name of ['快递单号', '快递信息']) if (fields.some(f => f.name === name && f.type !== 1)) throw new ApiError(409, 'FIELD_CONFLICT', `已有「${name}」不是文本字段，请手动映射`);
    for (const [key, name] of [['number', '快递单号'], ['info', '快递信息']]) {
      const existing = fields.find(f => f.name === name);
      if (existing) mapping[key] = existing.id;
      else {
        const data = unwrap(await this.client.base.appTableField.create({ path: { table_id: this.tableId }, data: { field_name: name, type: 1 } }));
        mapping[key] = data.field.field_id;
      }
    }
    return { mapping, fields: await this.fields(), buttonRequiresWorkflow: true };
  }
  async rows(mapping) {
    const names = await this.mapping(mapping); const rows = []; let page_token;
    do {
      const data = unwrap(await this.client.base.appTableRecord.list({ path: { table_id: this.tableId }, params: { page_size: 100, page_token } }));
      for (const r of data.items || []) rows.push({ id: r.record_id, number: plain(r.fields[names.number]), info: plain(r.fields[names.info]), carrier: names.carrier ? plain(r.fields[names.carrier]) : '', phone: names.phone ? plain(r.fields[names.phone]) : '' });
      if (!data.has_more) break;
      if (!data.page_token || data.page_token === page_token) throw new ApiError(502, 'PAGINATION', '飞书分页异常');
      page_token = data.page_token;
    } while (true);
    return rows;
  }
  async queryRecord(body, service) {
    if (typeof body.recordId !== 'string' || !/^rec[A-Za-z0-9]+$/.test(body.recordId)) throw new ApiError(400, 'RECORD_ID', '记录 ID 无效');
    const names = await this.mapping(body.mapping);
    const path = { table_id: this.tableId, record_id: body.recordId };
    const initial = unwrap(await this.client.base.appTableRecord.get({ path })).record;
    const number = plain(initial.fields[names.number]).trim();
    const oldInfo = plain(initial.fields[names.info]);
    const carrier = names.carrier ? plain(initial.fields[names.carrier]) || body.carrier : body.carrier;
    const phone = names.phone ? plain(initial.fields[names.phone]) : body.phone;
    const idempotencyKey = typeof body.requestId === 'string' && body.requestId.trim() ? body.requestId.trim() : `record:${this.appToken}:${body.recordId}:${number}`;
    let result;
    try {
      result = await service.query({ number, carrier, phone, tenantKey: this.tenantKey, recordId: body.recordId, idempotencyKey });
    } catch (error) {
      if (error instanceof ApiError && ['INVALID_PHONE', 'PHONE_REQUIRED', 'PHONE_INVALID'].includes(error.code) && oldInfo) {
        const current = unwrap(await this.client.base.appTableRecord.get({ path })).record;
        if (plain(current.fields[names.number]).trim() === number && plain(current.fields[names.info]) === oldInfo &&
          (!names.phone || plain(current.fields[names.phone]) === plain(initial.fields[names.phone])) &&
          (!names.carrier || plain(current.fields[names.carrier]) === plain(initial.fields[names.carrier]))) {
          unwrap(await this.client.base.appTableRecord.update({ path, data: { fields: { [names.info]: '' } } }));
        }
      }
      throw error;
    }
    const current = unwrap(await this.client.base.appTableRecord.get({ path })).record;
    if (plain(current.fields[names.number]).trim() !== number || plain(current.fields[names.info]) !== oldInfo ||
      (names.phone && plain(current.fields[names.phone]) !== plain(initial.fields[names.phone])) ||
      (names.carrier && plain(current.fields[names.carrier]) !== plain(initial.fields[names.carrier]))) throw new ApiError(409, 'RECORD_CHANGED', '查询期间本行已被编辑，结果未写回，请重新查询');
    const resultText = formatResultText(result);
    unwrap(await this.client.base.appTableRecord.update({ path, data: { fields: { [names.info]: resultText } } }));
    return { ...result, resultText, written: true };
  }

  async autoQueryRecord(body, service) {
    try {
      return { queried: true, ...(await this.queryRecord(body, service)) };
    } catch (error) {
      // 自动监听时，未填完或格式错误的记录只跳过，不调用物流服务商，也不写入错误文本。
      if (error instanceof ApiError && ['INVALID_NUMBER', 'INVALID_PHONE', 'PHONE_REQUIRED'].includes(error.code)) {
        return { queried: false, skipped: true, code: error.code, reason: error.message };
      }
      throw error;
    }
  }
}
function plain(value) { return typeof value === 'string' ? value : Array.isArray(value) ? value.map(v => v.text || '').join('') : ''; }
