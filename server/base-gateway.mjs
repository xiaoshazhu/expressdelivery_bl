import { BaseClient } from '@lark-base-open/node-sdk';
import { ApiError, formatResultText } from './service.mjs';

const quiet = { debug() {}, info() {}, warn() {}, error() {}, trace() {} };
const outputFields = { summary: ['物流摘要', 1], trackingNumber: ['快递单号', 1], carrierName: ['快递公司', 1], carrierCode: ['快递公司编码', 1], status: ['物流状态', 1], latest: ['最新轨迹', 1], queriedAt: ['查询时间', 5], trace: ['完整轨迹', 1] };
function unwrap(response) {
  if (response.code !== 0) {
    const detail = typeof response.msg === 'string' ? response.msg.trim() : '';
    const hint = Number(response.code) === 1011 ? '请重新在当前多维表格获取授权码，确认已启用授权码后复制完整内容' : '请检查授权码、表格权限及参数';
    throw new ApiError(502, 'FEISHU_ERROR', `飞书请求失败（${response.code}${detail ? `：${detail}` : ''}）。${hint}`);
  }
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
    const number = fields.find(f => f.id === mapping?.number && [1, 2].includes(f.type));
    const info = fields.find(f => f.id === mapping?.info && f.type === 1);
    if (!number || !info || number.id === info.id) throw new ApiError(400, 'FIELD_MAPPING', '请选择两个不同的文本字段');
    const optional = {};
    for (const key of ['phone', 'carrier', 'trigger']) {
      if (!mapping?.[key]) continue;
      const field = fields.find(f => f.id === mapping[key] && [1, 2].includes(f.type));
      if (!field) throw new ApiError(400, 'FIELD_MAPPING', `所选${key === 'phone' ? '核验手机号' : key === 'carrier' ? '快递公司' : '刷新触发'}字段必须是文本或数字字段`);
      optional[key] = field.name;
    }
    const outputs = {};
    for (const [key, id] of Object.entries(mapping?.outputs || {})) {
      if (!outputFields[key] || !id) continue;
      const field = fields.find(f => f.id === id && (key === 'queriedAt' ? f.type === 5 : [1, 2].includes(f.type)));
      if (!field) throw new ApiError(400, 'FIELD_MAPPING', `结果字段“${outputFields[key][0]}”已变化，请重新初始化`);
      outputs[key] = field.name;
    }
    return { number: number.name, info: info.name, ...optional, outputs };
  }
  async initialize(options = {}) {
    const defaults = { number: '快递单号', phone: '核验手机号', info: '快递信息' };
    const requested = options.fieldNames && typeof options.fieldNames === 'object' ? options.fieldNames : {};
    const names = Object.fromEntries(Object.entries(defaults).map(([key, fallback]) => [key, String(requested[key] ?? fallback).trim()]));
    if (!names.number || !names.info) throw new ApiError(400, 'FIELD_NAME', '快递单号和快递信息字段名称不能为空');
    const activeNames = Object.values(names).filter(Boolean);
    if (activeNames.some(name => name.length > 100) || new Set(activeNames).size !== activeNames.length) throw new ApiError(400, 'FIELD_NAME', '字段名称不能重复且不能超过 100 字');
    const fields = await this.fields(); const mapping = {};
    // 先检查所有同名字段，防止类型冲突时产生部分改动。
    for (const [key, name] of Object.entries(names)) if (name && fields.some(f => f.name === name && (key === 'info' ? f.type !== 1 : ![1, 2].includes(f.type)))) throw new ApiError(409, 'FIELD_CONFLICT', `已有「${name}」不是可用的${key === 'info' ? '文本' : '文本或数字'}字段，请修改名称`);
    for (const key of options.enabledOutputs || []) {
      const definition = outputFields[key];
      if (!definition || key === 'trackingNumber') continue;
      const [name, type] = definition;
      if (name === names.info) throw new ApiError(409, 'FIELD_CONFLICT', `结果字段“${name}”不能同时保存完整快递信息，请修改完整结果字段名称`);
      if (name === names.number) throw new ApiError(409, 'FIELD_CONFLICT', `结果字段“${name}”不能覆盖快递单号输入字段，请修改输入字段名称`);
      const existing = fields.find(f => f.name === name);
      if (existing && existing.type !== type) throw new ApiError(409, 'FIELD_CONFLICT', `已有“${name}”字段类型不匹配，请修改该字段类型`);
    }
    for (const [key, name] of Object.entries(names)) {
      if (!name) continue;
      const existing = fields.find(f => f.name === name);
      if (existing) mapping[key] = existing.id;
      else {
        const data = unwrap(await this.client.base.appTableField.create({ path: { table_id: this.tableId }, data: { field_name: name, type: 1 } }));
        mapping[key] = data.field.field_id;
      }
    }
    for (const key of ['carrier', 'trigger']) {
      const id = options.optionalMapping?.[key];
      if (!id) continue;
      if (!fields.some(field => field.id === id && [1, 2].includes(field.type))) throw new ApiError(400, 'FIELD_MAPPING', '可选输入字段已变化，请重新选择');
      mapping[key] = id;
    }
    for (const key of options.enabledOutputs || []) {
      const definition = outputFields[key];
      if (!definition) continue;
      if (key === 'trackingNumber') { mapping.outputs ||= {}; mapping.outputs[key] = mapping.number; continue; }
      const [name, type] = definition;
      const existing = fields.find(f => f.name === name);
      if (existing && existing.type !== type) throw new ApiError(409, 'FIELD_CONFLICT', `已有“${name}”字段类型不匹配，请修改该字段类型`);
      let id = existing?.id;
      if (!id) {
        const data = unwrap(await this.client.base.appTableField.create({ path: { table_id: this.tableId }, data: { field_name: name, type, ...(type === 5 ? { property: { date_formatter: 'yyyy-MM-dd HH:mm' } } : {}) } }));
        id = data.field.field_id;
        fields.push({ id, name, type });
      }
      mapping.outputs ||= {};
      mapping.outputs[key] = id;
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
    const oldQueriedNumber = oldInfo.match(/^运单号：([^\n]+)/m)?.[1]?.trim();
    if (oldInfo.trim() && (!oldQueriedNumber || oldQueriedNumber === number)) return { skipped: true, reason: '已有查询结果，不重复消耗次数' };
    const carrier = names.carrier ? plain(initial.fields[names.carrier]).trim() || body.carrier : body.carrier;
    const phone = names.phone ? plain(initial.fields[names.phone]) : body.phone;
    const idempotencyKey = typeof body.requestId === 'string' && body.requestId.trim() ? body.requestId.trim() : `record:${this.appToken}:${body.recordId}:${number}`;
    let result;
    try {
      result = await service.query({ number, carrier, phone, tenantKey: this.tenantKey, recordId: body.recordId, idempotencyKey });
    } catch (error) {
      if (error instanceof ApiError && ['INVALID_PHONE', 'PHONE_REQUIRED', 'PHONE_INVALID'].includes(error.code) && oldInfo) {
        const current = unwrap(await this.client.base.appTableRecord.get({ path })).record;
        if (plain(current.fields[names.number]).trim() === number && plain(current.fields[names.info]) === oldInfo &&
          (!names.phone || plain(current.fields[names.phone]) === plain(initial.fields[names.phone]))) {
          unwrap(await this.client.base.appTableRecord.update({ path, data: { fields: { [names.info]: '' } } }));
        }
      }
      throw error;
    }
    const current = unwrap(await this.client.base.appTableRecord.get({ path })).record;
    if (plain(current.fields[names.number]).trim() !== number || plain(current.fields[names.info]) !== oldInfo ||
      (names.phone && plain(current.fields[names.phone]) !== plain(initial.fields[names.phone]))) throw new ApiError(409, 'RECORD_CHANGED', '查询期间本行已被编辑，结果未写回，请重新查询');
    const resultText = formatResultText(result);
    const fields = { [names.info]: resultText };
    const latest = result.events?.[0]?.content || result.summary || '';
    const trace = (result.events || []).map(item => `${item.time || ''} ${item.content || ''}${item.location ? `（${item.location}）` : ''}`.trim()).join('\n');
    const values = { summary: result.summary || '', carrierName: result.carrier || '', carrierCode: result.carrierCode || '', status: result.state || '', latest, queriedAt: Date.parse(result.queriedAt), trace };
    for (const [key, fieldName] of Object.entries(names.outputs || {})) {
      if (key === 'trackingNumber' || fieldName === names.info || fieldName === names.number) continue;
      if (key === 'queriedAt' && !Number.isFinite(values.queriedAt)) continue;
      fields[fieldName] = values[key] ?? '';
    }
    unwrap(await this.client.base.appTableRecord.update({ path, data: { fields } }));
    return { ...result, resultText, written: true };
  }

  async autoQueryRecord(body, service) {
    try {
      const result = await this.queryRecord(body, service);
      return { queried: !result.skipped, ...result };
    } catch (error) {
      // 自动监听时，未填完或格式错误的记录只跳过，不调用物流服务商，也不写入错误文本。
      if (error instanceof ApiError && ['INVALID_NUMBER', 'INVALID_PHONE', 'PHONE_REQUIRED'].includes(error.code)) {
        return { queried: false, skipped: true, code: error.code, reason: error.message };
      }
      throw error;
    }
  }
}
function plain(value) { return typeof value === 'string' || typeof value === 'number' ? String(value) : Array.isArray(value) ? value.map(v => v.text || '').join('') : ''; }
