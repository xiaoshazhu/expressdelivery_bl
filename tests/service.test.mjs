import test from 'node:test';
import assert from 'node:assert/strict';
import { ApiError, createService, validateQuery, phoneRequirement } from '../server/service.mjs';
import { createSessions } from '../server/sessions.mjs';
import { BaseGateway } from '../server/base-gateway.mjs';
import { createServer } from '../server/index.mjs';
import { createBilling, defaultBillingConfig } from '../server/billing.mjs';
import { createMcpBillingClient } from '../server/mcp-billing.mjs';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

test('校验单号、去除首尾空格、保留前导零', () => {
  assert.equal(validateQuery({ number: ' 0012345678 ' }).number, '0012345678');
  assert.throws(() => validateQuery({ number: '<script>' }), /单号/);
  assert.throws(() => validateQuery({ number: '' }), /单号/);
  assert.throws(() => validateQuery({ number: '1'.repeat(33) }), /6–32/);
  assert.throws(() => validateQuery({ number: 'SF123456', phone: '12345' }), /手机号/);
  assert.equal(validateQuery({ number: 'SF123456', phone: '+86 138-0013-8000' }).phone, '13800138000');
  assert.equal(phoneRequirement('ZTO123456', '自动识别').code, 'ZTO');
});
test('五个指定承运商都标记模拟，货拉拉不伪造轨迹', async () => {
  const service = createService();
  for (const carrier of ['京东', '邮政', '安能', '跨越', '顺丰']) {
    const result = await service.query({ number: '123456789', carrier });
    assert.equal(result.carrier, carrier); assert.equal(result.mock, true); assert.match(result.summary, /模拟数据/);
  }
  await assert.rejects(service.query({ number: '123456789', carrier: '货拉拉' }), { code: 'MANUAL_CARRIER' });
  await assert.rejects(service.query({ number: '12340000' }), { code: 'NO_TRACKING' });
});
test('真实服务商未配置时拒绝查询，不回退模拟数据', async () => {
  await assert.rejects(createService({ mode: 'live' }).query({ number: '123456789' }), { code: 'PROVIDER_NOT_CONFIGURED' });
});
test('真实查询在进入供应商前拦截需要手机号的前缀', async () => {
  let calls = 0;
  const service = createService({ mode: 'live', provider: { query: async () => { calls++; } } });
  await assert.rejects(service.query({ number: 'ZTO123456789', carrier: '自动识别' }), { code: 'PHONE_REQUIRED' });
  assert.equal(calls, 0);
});
test('计费套餐、授权同步、成功查询扣次和退款具备幂等基础', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'express-billing-'));
  const billing = createBilling({ configPath: path.join(dir, 'packages.json'), statePath: path.join(dir, 'billing-state.json'), enforce: true });
  assert.deepEqual((await billing.getConfig()).plans.map(plan => plan.plan_id), defaultBillingConfig.plans.map(plan => plan.plan_id));
  await billing.syncLicense({ tenant_key: 'base123', billing_type: 'quota', used_quota: 0, max_quota: 2 });
  const service = createService({ billing, provider: { query: async input => ({ number: input.number, carrier: '京东', mock: false, queriedAt: new Date().toISOString(), summary: 'ok', events: [] }) } });
  await service.query({ number: 'JD123456789', carrier: '京东', tenantKey: 'base123' });
  assert.equal((await billing.status('base123')).remainingQuota, 1);
  const order = await billing.createOrder({ tenantKey: 'base123', planId: 'query_100' });
  assert.equal(order.status, 'PENDING');
  await assert.rejects(billing.refund(order.orderId), { code: 'ORDER_NOT_PAID' });
  await billing.payOrder(order.orderId);
  assert.equal((await billing.status('base123')).maxQuota, 102);
  assert.deepEqual(await billing.refund(order.orderId), { tenantKey: 'base123', alreadyRefunded: false });
  assert.equal((await billing.status('base123')).maxQuota, 2);
  assert.equal((await billing.status('base123')).remainingQuota, 1);
  assert.deepEqual(await billing.refund(order.orderId), { tenantKey: 'base123', alreadyRefunded: true });
  assert.match(await readFile(path.join(dir, 'packages.json'), 'utf8'), /query_100/);
});

test('新企业须先登记才能领取一次免费额度，订单渠道写入中文', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'express-trial-'));
  const billing = createBilling({ configPath: path.join(dir, 'packages.json'), statePath: path.join(dir, 'billing-state.json'), enforce: true, useDb: false });
  const initial = await billing.status('new-enterprise');
  assert.equal(initial.remainingQuota, 0);
  assert.equal(initial.trialClaimed, false);
  await assert.rejects(billing.assertAvailable('new-enterprise'), { code: 'BILLING_EXHAUSTED' });
  await assert.rejects(billing.claimTrial({ tenantKey: 'new-enterprise', enterpriseName: '不可跳过登记' }), { code: 'ENTERPRISE_REQUIRED' });
  await billing.registerEnterprise({ tenantKey: 'new-enterprise', enterpriseName: '测试企业' });
  const granted = await billing.claimTrial({ tenantKey: 'new-enterprise' });
  assert.equal(granted.remainingQuota, 15);
  assert.equal(granted.trialClaimed, true);
  assert.ok(!Number.isNaN(Date.parse(granted.trialClaimedAt)));
  await billing.consume('new-enterprise');
  await billing.syncLicense({ tenant_key: 'new-enterprise', billing_type: 'quota', used_quota: 0, max_quota: 0 });
  assert.equal((await billing.status('new-enterprise')).maxQuota, 15);
  assert.equal((await billing.status('new-enterprise')).usedQuota, 1);
  assert.equal((await billing.status('new-enterprise')).trialClaimedAt, granted.trialClaimedAt);
  const reloaded = createBilling({ configPath: path.join(dir, 'packages.json'), statePath: path.join(dir, 'billing-state.json'), enforce: true, useDb: false });
  assert.equal((await reloaded.status('new-enterprise')).trialClaimedAt, granted.trialClaimedAt);
  await assert.rejects(billing.claimTrial({ tenantKey: 'new-enterprise' }), { code: 'TRIAL_ALREADY_CLAIMED' });
  const order = await billing.createOrder({ tenantKey: 'new-enterprise', planId: 'query_100', payChannel: 'wxpay' });
  assert.equal(order.payChannel, '微信支付');
  await billing.payOrder(order.orderId);
  await billing.syncLicense({ tenant_key: 'new-enterprise', billing_type: 'quota', used_quota: 0, max_quota: 0 });
  assert.equal((await billing.status('new-enterprise')).maxQuota, 115);
  await billing.refund(order.orderId);
  await billing.syncLicense({ tenant_key: 'new-enterprise', billing_type: 'quota', used_quota: 0, max_quota: 0 });
  assert.equal((await billing.status('new-enterprise')).maxQuota, 15);
  await billing.close();
});
test('SDK 管理平台企业状态决定是否需要登记，不能用本地旧信息跳过', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'express-enterprise-'));
  let platformEnterprise = null;
  const sdk = {
    queryEnterpriseStatus: async () => ({ data: platformEnterprise ? { registered: true, name: platformEnterprise } : { registered: false } }),
    registerEnterprise: async (_tenantKey, name) => ({ data: { name } }),
  };
  const billing = createBilling({ configPath: path.join(dir, 'packages.json'), statePath: path.join(dir, 'billing-state.json'), useDb: false, sdk });
  await billing.registerEnterprise({ tenantKey: 'tenant-enterprise', enterpriseName: '本地旧名称' });
  assert.deepEqual(await billing.enterpriseStatus('tenant-enterprise'), { registered: false, name: '', enterpriseType: '' });
  platformEnterprise = '平台已登记名称';
  assert.deepEqual(await billing.enterpriseStatus('tenant-enterprise'), { registered: true, name: '平台已登记名称', enterpriseType: '' });
  sdk.queryEnterpriseStatus = async () => { throw new Error('平台连接失败'); };
  assert.deepEqual(await billing.enterpriseStatus('tenant-enterprise'), { registered: true, name: '平台已登记名称', enterpriseType: '', lookupUnavailable: true });
  assert.deepEqual(await billing.enterpriseStatus('new-enterprise'), { registered: false, name: '', enterpriseType: '', lookupUnavailable: true });
  const grantedDuringOutage = await billing.claimTrial({ tenantKey: 'new-enterprise' });
  assert.equal(grantedDuringOutage.trialClaimed, true);
  await assert.rejects(billing.claimTrial({ tenantKey: 'new-enterprise' }), { code: 'TRIAL_ALREADY_CLAIMED' });
  sdk.queryEnterpriseStatus = async () => { throw Object.assign(new Error('鉴权失败'), { statusCode: 401 }); };
  await assert.rejects(billing.enterpriseStatus('tenant-enterprise'), { code: 'ENTERPRISE_LOOKUP', status: 401 });
  await billing.close();
});
test('平台退款通知只标记订单，最终同步只收回该订单的一千次并保留兑换额度', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'express-refund-'));
  const billing = createBilling({ configPath: path.join(dir, 'packages.json'), statePath: path.join(dir, 'billing-state.json'), enforce: true, useDb: false, sdk: { redeemCoupon: async () => ({ data: { quota: 1000 } }) } });
  await billing.syncLicense({ tenant_key: 'coupon-enterprise', billing_type: 'quota', used_quota: 0, max_quota: 10 });
  await billing.redeemCoupon({ tenantKey: 'coupon-enterprise', couponCode: 'COUPON-1000' });
  assert.equal((await billing.status('coupon-enterprise')).maxQuota, 1010);
  const order = await billing.createOrder({ tenantKey: 'coupon-enterprise', planId: 'query_1000' });
  await billing.payOrder(order.orderId);
  assert.equal((await billing.status('coupon-enterprise')).maxQuota, 2010);
  assert.deepEqual(await billing.markRefunded(order.orderId), { tenantKey: 'coupon-enterprise', alreadyRefunded: false });
  assert.equal((await billing.status('coupon-enterprise')).maxQuota, 2010);
  assert.deepEqual(await billing.markRefunded(order.orderId), { tenantKey: 'coupon-enterprise', alreadyRefunded: true });
  await billing.syncLicense({ tenant_key: 'coupon-enterprise', billing_type: 'quota', used_quota: 0, max_quota: 10 });
  assert.equal((await billing.status('coupon-enterprise')).maxQuota, 1010);
  await billing.syncLicense({ tenant_key: 'coupon-enterprise', billing_type: 'quota', used_quota: 0, max_quota: 10 });
  assert.equal((await billing.status('coupon-enterprise')).maxQuota, 1010);
  await billing.close();
});
test('兑换码额度记在最大额度，旧负数使用量无损迁移', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'express-coupon-'));
  const statePath = path.join(dir, 'billing-state.json');
  const configPath = path.join(dir, 'packages.json');
  await writeFile(statePath, JSON.stringify({ licenses: [{ tenantKey: 'legacy-coupon', billingType: 'quota', maxQuota: 1010, usedQuota: -1000 }], orders: [], enterprises: [], consumed: [] }));
  const legacy = createBilling({ configPath, statePath, enforce: true, useDb: false });
  const normalized = await legacy.status('legacy-coupon');
  assert.equal(normalized.maxQuota, 2010);
  assert.equal(normalized.usedQuota, 0);
  assert.equal(normalized.remainingQuota, 2010);
  await legacy.close();

  const billing = createBilling({ configPath, statePath: path.join(dir, 'new-state.json'), enforce: true, useDb: false, sdk: { redeemCoupon: async () => ({ data: { quota: 1000 } }) } });
  await billing.syncLicense({ tenant_key: 'new-coupon', billing_type: 'quota', used_quota: 0, max_quota: 10 });
  await billing.redeemCoupon({ tenantKey: 'new-coupon', couponCode: 'COUPON-ONE' });
  assert.equal((await billing.status('new-coupon')).maxQuota, 1010);
  assert.equal((await billing.status('new-coupon')).usedQuota, 0);
  await billing.redeemCoupon({ tenantKey: 'new-coupon', couponCode: 'COUPON-ONE' });
  assert.equal((await billing.status('new-coupon')).maxQuota, 1010);
  await billing.close();
});
test('管理平台兑换失败时不赠送本地模拟额度', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'express-coupon-error-'));
  const billing = createBilling({
    configPath: path.join(dir, 'packages.json'),
    statePath: path.join(dir, 'billing-state.json'),
    enforce: true,
    useDb: false,
    sdk: { redeemCoupon: async () => { throw Object.assign(new Error('HTTP 502'), { statusCode: 502 }); } },
  });
  await assert.rejects(billing.redeemCoupon({ tenantKey: 'coupon-error', couponCode: 'VIP-888' }), /兑换服务暂时不可用/);
  assert.equal((await billing.status('coupon-error')).maxQuota, 0);
  await billing.close();
});
test('MCP 计费四项能力可调用且携带动态金额与幂等键', async () => {
  const requests = [];
  const client = createMcpBillingClient({ baseUrl: 'https://billing.test/api', token: 'test-token', fetchImpl: async (url, options) => {
    requests.push({ url: String(url), options });
    const path = new URL(url).pathname;
    const body = path.endsWith('/balance') ? { active: true, remainingQuota: 9 } : path.endsWith('/payments/orders') ? { orderId: 'ord_1', amount: 69, status: 'PENDING' } : path.endsWith('/payments/callback') ? { orderId: 'ord_1', status: 'PAID', alreadyPaid: false } : path.endsWith('/payments/refund') ? { orderId: 'ord_1', alreadyRefunded: false } : { ok: true };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } });
  const billing = createBilling({ mcp: client, enforce: true });
  assert.equal((await billing.status('tenant_1')).remainingQuota, 9);
  await billing.consume('tenant_1', 1, { idempotencyKey: 'query:record:1' });
  const order = await billing.createOrder({ tenantKey: 'tenant_1', planId: 'express_1000', payChannel: 'field_shortcut' });
  assert.equal(order.orderId, 'ord_1');
  assert.equal((await billing.paymentCallback({ orderId: 'ord_1' })).status, 'PAID');
  assert.equal((await billing.refund('ord_1')).alreadyRefunded, false);
  assert.match(requests.find(item => item.url.endsWith('/payments/orders')).options.body, /"amount":(12|0\.01|0\.02)/);
  assert.equal(requests.find(item => item.url.endsWith('/usage/consume')).options.headers['Idempotency-Key'], 'query:record:1');
});
test('会话仅在授权验证成功后签发，过期和断开后不能访问', async () => {
  let now = 1000;
  const sessions = createSessions({ now: () => now, gatewayFactory: () => ({ fields: async () => { throw new Error('无权限'); } }) });
  try {
    await assert.rejects(sessions.connect({ mode: 'feishu' }), /无权限/);
    const demo = await sessions.connect({ mode: 'demo' });
    assert.equal(sessions.get(demo.token).gateway, null);
    now += 3600001; assert.throws(() => sessions.get(demo.token), { code: 'SESSION_EXPIRED' });
    const next = await sessions.connect({ mode: 'demo' }); sessions.remove(next.token);
    assert.throws(() => sessions.get(next.token), { code: 'SESSION_EXPIRED' });
  } finally { sessions.close(); }
});
function fakeGateway({ changed = false, number = '123456789', info = '' } = {}) {
  const writes = []; let gets = 0;
  const table = {
    appTableField: { list: async () => ({ code: 0, data: { items: [{ field_id: 'fld1', field_name: '快递单号', type: 1 }, { field_id: 'fld2', field_name: '快递信息', type: 1 }] } }) },
    appTableRecord: {
      list: async ({ params }) => ({ code: 0, data: { items: [{ record_id: params.page_token ? 'rec2' : 'rec1', fields: { 快递单号: params.page_token ? '987654321' : '001234567', 快递信息: '旧信息' } }], has_more: !params.page_token, page_token: 'next' } }),
      get: async () => ({ code: 0, data: { record: { fields: { 快递单号: ++gets > 1 && changed ? 'changed' : number, 快递信息: info } } } }),
      update: async data => { writes.push(data); return { code: 0 }; },
    },
  };
  return { writes, gateway: new BaseGateway({ appToken: 'base123', personalBaseToken: 'pt-test-only', tableId: 'tbl123' }, { base: table }) };
}
test('后端分页读取所有记录并保留单号前导零', async () => {
  const { gateway } = fakeGateway(); const rows = await gateway.rows({ number: 'fld1', info: 'fld2' });
  assert.equal(rows.length, 2); assert.equal(rows[0].number, '001234567');
});
test('只写回指定结果字段，禁止输入输出字段相同', async () => {
  const { gateway, writes } = fakeGateway();
  await gateway.queryRecord({ recordId: 'rec1', mapping: { number: 'fld1', info: 'fld2' } }, createService());
  assert.equal(writes.length, 1); assert.deepEqual(Object.keys(writes[0].data.fields), ['快递信息']);
  await assert.rejects(gateway.mapping({ number: 'fld1', info: 'fld1' }), { code: 'FIELD_MAPPING' });
});
test('已有查询结果时跳过且不调用查询服务或写回', async () => {
  const { gateway, writes } = fakeGateway({ info: '已有物流轨迹' });
  const result = await gateway.queryRecord({ recordId: 'rec1', mapping: { number: 'fld1', info: 'fld2' } }, {
    query: async () => { throw new Error('不应再次查询或扣费'); },
  });
  assert.equal(result.skipped, true);
  assert.match(result.reason, /不重复消耗/);
  assert.equal(writes.length, 0);
});
test('自动更新输入字段后重新查询已有结果并写回新信息', async () => {
  const { gateway, writes } = fakeGateway({ number: 'SF123456789', info: '快递公司：顺丰速运\n运单号：SF123456789\n旧轨迹' });
  let calls = 0;
  const result = await gateway.autoQueryRecord({ recordId: 'rec1', mapping: { number: 'fld1', info: 'fld2' }, refresh: true, requestId: 'auto:rec1:changed' }, {
    query: async input => {
      calls++;
      assert.equal(input.idempotencyKey, 'auto:rec1:changed');
      return { number: input.number, carrier: '顺丰速运', summary: '运输中', queriedAt: new Date().toISOString(), events: [] };
    },
  });
  assert.equal(result.queried, true);
  assert.equal(calls, 1);
  assert.match(writes[0].data.fields['快递信息'], /运输中/);
});
test('运单号改变后可查询新运单，同一运单仍不重复查询', async () => {
  const { gateway, writes } = fakeGateway({ number: 'SF123456789', info: '快递公司：顺丰速运\n运单号：SF000000000\n旧轨迹' });
  let calls = 0;
  await gateway.queryRecord({ recordId: 'rec1', mapping: { number: 'fld1', info: 'fld2' } }, { query: async () => {
    calls++;
    return { number: 'SF123456789', carrier: '顺丰速运', summary: '已揽收', queriedAt: new Date().toISOString(), events: [] };
  } });
  assert.equal(calls, 1);
  assert.equal(writes.length, 1);
});
test('与字段捷径一致，单号和可选手机号可映射数字字段', async () => {
  const fields = [
    { field_id: 'fld1', field_name: '快递单号', type: 2 },
    { field_id: 'fld2', field_name: '核验手机号', type: 2 },
    { field_id: 'fld3', field_name: '快递信息', type: 1 },
  ];
  const gateway = new BaseGateway({ appToken: 'base123', personalBaseToken: 'pt-test-only', tableId: 'tbl123' }, { base: {
    appTableField: { list: async () => ({ code: 0, data: { items: fields, has_more: false } }) },
    appTableRecord: { list: async () => ({ code: 0, data: { items: [{ record_id: 'rec1', fields: { 快递单号: 123456789, 核验手机号: 13800138000, 快递信息: '' } }], has_more: false } }) },
  } });
  const mapping = { number: 'fld1', phone: 'fld2', info: 'fld3' };
  assert.equal((await gateway.initialize({ fieldNames: { number: '快递单号', phone: '核验手机号', info: '快递信息' } })).mapping.phone, 'fld2');
  assert.deepEqual((await gateway.rows(mapping)).map(row => [row.number, row.phone]), [['123456789', '13800138000']]);
});
test('批量配置创建详情字段并将一次查询结果写入对应列', async () => {
  const fields = [
    { id: 'fld1', name: '快递单号', type: 1 },
    { id: 'fld2', name: '快递信息', type: 1 },
  ];
  const writes = [];
  const client = { base: {
    appTableField: {
      list: async () => ({ code: 0, data: { items: fields.map(field => ({ field_id: field.id, field_name: field.name, type: field.type })), has_more: false } }),
      create: async ({ data }) => {
        const field = { id: `fld${fields.length + 1}`, name: data.field_name, type: data.type };
        fields.push(field);
        return { code: 0, data: { field: { field_id: field.id } } };
      },
    },
    appTableRecord: {
      get: async () => ({ code: 0, data: { record: { fields: { 快递单号: 'SF123456789', 快递信息: '' } } } }),
      update: async ({ data }) => { writes.push(data.fields); return { code: 0 }; },
    },
  } };
  const gateway = new BaseGateway({ appToken: 'base123', personalBaseToken: 'pt-test-only', tableId: 'tbl123' }, client);
  const setup = await gateway.initialize({ fieldNames: { number: '快递单号', phone: '', info: '快递信息' }, enabledOutputs: ['summary', 'trackingNumber', 'carrierName', 'queriedAt', 'trace'] });
  assert.equal(fields.find(field => field.name === '查询时间').type, 5);
  assert.equal(setup.mapping.outputs.trackingNumber, 'fld1');
  await gateway.queryRecord({ recordId: 'rec1', mapping: setup.mapping, carrier: '自动识别' }, { query: async () => ({
    number: 'SF123456789', carrier: '顺丰速运', summary: '运输中', queriedAt: '2026-10-13T05:40:00.000Z',
    events: [{ time: '2026-10-13T04:00:00.000Z', content: '已揽收' }],
  }) });
  assert.equal(writes.length, 1);
  assert.equal(writes[0]['物流摘要'], '运输中');
  assert.equal(writes[0]['快递公司'], '顺丰速运');
  assert.equal(writes[0]['查询时间'], Date.parse('2026-10-13T05:40:00.000Z'));
  assert.match(writes[0]['完整轨迹'], /已揽收/);
  assert.equal(Object.hasOwn(writes[0], '快递单号'), false);
});
test('查询期间单号变更，阻止写回旧轨迹', async () => {
  const { gateway, writes } = fakeGateway({ changed: true });
  await assert.rejects(gateway.queryRecord({ recordId: 'rec1', mapping: { number: 'fld1', info: 'fld2' } }, createService()), { code: 'RECORD_CHANGED' });
  assert.equal(writes.length, 0);
});
test('查询使用表格本行完整手机号，号码变化时不写回旧结果', async () => {
  const writes = [];
  const requested = [];
  let currentPhone = '13800138000';
  const fields = { 快递单号: 'SF1234567890', 快递信息: '', 核验手机号: currentPhone };
  const table = {
    appTableField: { list: async () => ({ code: 0, data: { items: [
      { field_id: 'fld1', field_name: '快递单号', type: 1 },
      { field_id: 'fld2', field_name: '快递信息', type: 1 },
      { field_id: 'fld3', field_name: '核验手机号', type: 1 },
    ] } }) },
    appTableRecord: {
      get: async () => ({ code: 0, data: { record: { fields: { ...fields, 核验手机号: currentPhone } } } }),
      update: async data => { writes.push(data); return { code: 0 }; },
    },
  };
  const gateway = new BaseGateway({ appToken: 'base123', personalBaseToken: 'pt-test-only', tableId: 'tbl123' }, { base: table });
  const service = createService({ mode: 'aliyun_kzexpress', provider: { query: async input => {
    requested.push(input);
    return { number: input.number, carrier: '顺丰', summary: '运输中', mock: false, queriedAt: new Date().toISOString(), events: [] };
  } } });
  const body = { recordId: 'rec1', mapping: { number: 'fld1', info: 'fld2', phone: 'fld3' }, phone: '13900139000', carrier: '顺丰' };
  await gateway.queryRecord(body, service);
  assert.equal(requested[0].phone, '13800138000');
  assert.equal(writes.length, 1);
  currentPhone = '13900139000';
  await gateway.queryRecord(body, { query: async input => {
    requested.push(input);
    currentPhone = '13700137000';
    return { number: input.number, carrier: '顺丰', summary: '运输中', mock: false, queriedAt: new Date().toISOString(), events: [] };
  } }).then(() => assert.fail('手机号变化后不应写回'), error => assert.equal(error.code, 'RECORD_CHANGED'));
  assert.equal(requested[1].phone, '13900139000');
  assert.equal(writes.length, 1);
});
test('自动查询手机号缺失时跳过，不写入查询结果', async () => {
  const { gateway, writes } = fakeGateway({ number: 'ZTO123456789' });
  const result = await gateway.autoQueryRecord({ recordId: 'rec1', mapping: { number: 'fld1', info: 'fld2' } }, createService({ mode: 'live', provider: { query: async () => { throw new Error('不应调用'); } } }));
  assert.equal(result.queried, false);
  assert.equal(result.skipped, true);
  assert.equal(result.code, 'PHONE_REQUIRED');
  assert.equal(writes.length, 0);
});
test('初始化复用字段捷径已有列，仅创建缺失列并返回映射', async () => {
  const fields = [
    { field_id: 'fld_no', field_name: '快递单号', type: 1 },
    { field_id: 'fld_result', field_name: '物流查询结果', type: 1 },
    { field_id: 'fld_phone', field_name: '核验手机号', type: 1 },
  ];
  const created = [];
  const gateway = new BaseGateway({ appToken: 'app12345', tableId: 'tbl12345', personalBaseToken: 'token12345678' }, {
    base: { appTableField: {
      list: async () => ({ code: 0, data: { items: fields, has_more: false } }),
      create: async ({ data }) => {
        created.push(data.field_name);
        const field = { field_id: `fld_${fields.length}`, field_name: data.field_name, type: data.type };
        fields.push(field);
        return { code: 0, data: { field } };
      },
    } },
  });
  const result = await gateway.initialize({ fieldNames: {
    number: '快递单号', info: '物流查询结果', phone: '核验手机号', carrier: '快递公司', time: '查询时间',
  } });
  assert.deepEqual(created, []);
  assert.equal(result.mapping.number, 'fld_no');
  assert.equal(result.mapping.info, 'fld_result');
  assert.equal(result.mapping.phone, 'fld_phone');
  assert.equal(result.fields.length, 3);
});
test('飞书授权失败时显示原始错误说明与重新授权指引', async () => {
  const gateway = new BaseGateway({ appToken: 'app12345', tableId: 'tbl12345', personalBaseToken: 'token12345678' }, {
    base: { appTableField: { list: async () => ({ code: 1011, msg: 'personal token is invalid' }) } },
  });
  await assert.rejects(gateway.fields(), error => error.code === 'FEISHU_ERROR' &&
    error.message.includes('personal token is invalid') && error.message.includes('重新在当前多维表格获取授权码'));
});
test('供应商拒绝手机号时不写入查询结果', async () => {
  const { gateway, writes } = fakeGateway({ number: 'SF1234567890' });
  await assert.rejects(gateway.queryRecord({ recordId: 'rec1', mapping: { number: 'fld1', info: 'fld2' } }, {
    query: async () => { throw new ApiError(400, 'PHONE_INVALID', '手机号查询失败'); },
  }), { code: 'PHONE_INVALID' });
  assert.deepEqual(writes.map(write => write.data.fields), []);
});
test('HTTP 鉴权、错误体、工作流输出以及 demo/真实飞书隔离', async () => {
  const server = createServer({ billing: { assertAvailable: async () => {}, consume: async () => {} } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/`;
  const post = (route, body, token) => fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token || ''}` }, body: JSON.stringify(body) });
  try {
    assert.equal((await post('query', { number: '123456789' })).status, 401);
    const session = await (await post('connect', { mode: 'demo' })).json();
    assert.equal((await post('base/initialize', {}, session.token)).status, 400);
    const response = await post('workflow/query', { number: '123456789', carrier: '京东' }, session.token);
    assert.equal(response.status, 200); assert.match((await response.json()).resultText, /模拟数据[\s\S]*物流轨迹/);
    const malformed = await fetch(base + 'connect', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{oops' });
    assert.equal(malformed.status, 400);
    await post('disconnect', {}, session.token);
    assert.equal((await post('query', { number: '123456789' }, session.token)).status, 401);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
