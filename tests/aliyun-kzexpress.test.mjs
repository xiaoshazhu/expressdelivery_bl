import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createAliyunKzExpressProvider,
} from '../server/providers/aliyun-kzexpress.mjs';
import { createService, formatResultText } from '../server/service.mjs';

test('阿里云快递接口缺少 AppCode 时拒绝创建适配器', () => {
  assert.throws(() => createAliyunKzExpressProvider({ appCode: '' }), { code: 'PROVIDER_NOT_CONFIGURED' });
});

test('阿里云快递接口使用 APPCODE 表单请求并映射物流轨迹', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify({
      msg: '成功', success: true, code: 200,
      data: {
        cpCode: 'JD', mailNo: 'JD1234567890', theLastMessage: '快件已签收',
        logisticsCompanyName: '京东快递', logisticsStatusDesc: '已签收', logisticsStatus: 'SIGN',
        logisticsTraceDetailList: [
          { time: 1718767062000, desc: '顺丰速运已收取快件', areaName: '温州市', logisticsStatus: 'ACCEPT' },
          { time: 1718849806000, desc: '您的快件已签收', areaName: '宁波市', logisticsStatus: 'SIGN' },
        ],
      },
    }), { headers: { 'Content-Type': 'application/json' } });
  };
  let now = Date.parse('2026-09-15T05:00:00.000Z');
  const provider = createAliyunKzExpressProvider({ appCode: 'test-app-code', fetchImpl, now: () => now });
  const service = createService({ mode: 'aliyun_kzexpress', provider, now: () => now });
  const result = await service.query({ number: 'JD1234567890', carrier: '京东', phone: '13800138000' });
  assert.equal(result.mock, false);
  assert.equal(result.carrierCode, 'JD');
  assert.equal(result.events[0].content, '您的快件已签收');
  assert.equal(calls[0].url, 'https://kzexpress.market.alicloudapi.com/api-mall/api/express/query');
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.headers.Authorization, 'APPCODE test-app-code');
  assert.equal(calls[0].options.body.get('expressNo'), 'JD1234567890');
  assert.equal(calls[0].options.body.get('mobile'), '13800138000');
  assert.equal(calls[0].options.body.get('cpCode'), 'JD');
  assert.match(formatResultText(result), /京东快递[\s\S]*已签收/);

  now += 60_000;
  const cached = await service.query({ number: 'JD1234567890', carrier: '京东', phone: '13800138000' });
  assert.equal(cached.cached, true);
  assert.equal(calls.length, 1);
});

test('自动识别时不传 cpCode，按需传 mobile', async () => {
  let submitted;
  const fetchImpl = async (_url, options) => {
    submitted = options.body;
    return new Response(JSON.stringify({ success: true, code: 200, data: { cpCode: 'JD', mailNo: 'JD123456789', logisticsCompanyName: '京东快递', logisticsStatusDesc: '运输中', theLastMessage: '正在运输', logisticsTraceDetailList: [] } }), { headers: { 'Content-Type': 'application/json' } });
  };
  const provider = createAliyunKzExpressProvider({ appCode: 'test', fetchImpl });
  await provider.query({ number: 'JD123456789', carrier: '自动识别', phone: '' });
  assert.equal(submitted.has('cpCode'), false);
  assert.equal(submitted.has('mobile'), false);
});

test('阿里云网关区分套餐用尽和 AppCode 错误', async () => {
  const quota = createAliyunKzExpressProvider({ appCode: 'test', fetchImpl: async () => new Response('{"message":"Quota Exhausted"}', { status: 403, headers: { 'Content-Type': 'application/json' } }) });
  await assert.rejects(quota.query({ number: 'JD123456789', carrier: '京东' }), { code: 'PROVIDER_QUOTA_EXHAUSTED' });
  const credential = createAliyunKzExpressProvider({ appCode: 'test', fetchImpl: async () => new Response('{"message":"Unauthorized"}', { status: 403, headers: { 'Content-Type': 'application/json' } }) });
  await assert.rejects(credential.query({ number: 'JD123456789', carrier: '京东' }), { code: 'PROVIDER_CREDENTIAL' });
});

test('顺丰和中通明确指定公司时要求手机号', async () => {
  const provider = createAliyunKzExpressProvider({ appCode: 'test', fetchImpl: async () => { throw new Error('不应联网'); } });
  await assert.rejects(provider.query({ number: 'SF1234567890', carrier: '顺丰' }), { code: 'PHONE_REQUIRED' });
  await assert.rejects(provider.query({ number: 'SF1234567890', carrier: '自动识别' }), { code: 'PHONE_REQUIRED' });
  await assert.rejects(provider.query({ number: 'ZTO123456789', carrier: 'ZTO' }), { code: 'PHONE_REQUIRED' });
});

test('阿里云查询接受完整手机号或后四位，均与单号一起提交', async () => {
  const calls = [];
  const provider = createAliyunKzExpressProvider({ appCode: 'test', fetchImpl: async (_url, options) => {
    calls.push(options.body);
    return new Response(JSON.stringify({ success: true, code: 200, data: { cpCode: 'SF', mailNo: 'SF1234567890', receiverPhone: '13800138000', theLastMessage: '运输中' } }));
  } });
  const service = createService({ mode: 'aliyun_kzexpress', provider });
  await service.query({ number: 'SF1234567890', carrier: '顺丰', phone: '5678' });
  assert.equal(calls[0].get('expressNo'), 'SF1234567890');
  assert.equal(calls[0].get('mobile'), '5678');
  await service.query({ number: 'SF1234567890', carrier: '顺丰', phone: '+86 138-0013-8000' });
  assert.equal(calls[1].get('expressNo'), 'SF1234567890');
  assert.equal(calls[1].get('mobile'), '13800138000');
  assert.equal(calls.length, 2);
});

test('阿里云拒绝手机号或查询失败时不返回轨迹', async () => {
  for (const payload of [
    { success: false, code: 400, msg: '手机号校验失败', data: { theLastMessage: '旧轨迹' } },
    { success: false, code: 200, msg: '手机号校验失败', data: { theLastMessage: '旧轨迹' } },
  ]) {
    const provider = createAliyunKzExpressProvider({ appCode: 'test', fetchImpl: async () => new Response(JSON.stringify(payload)) });
    await assert.rejects(provider.query({ number: 'SF1234567890', carrier: '顺丰', phone: '13800138000' }), { code: 'PHONE_INVALID' });
  }
});

test('阿里云空轨迹或错误运单号不作为查询成功', async () => {
  const cases = [
    [{ success: true, code: 200, data: { cpCode: 'JD', mailNo: 'JD1234567890', logisticsTraceDetailList: [] } }, 'NO_TRACKING'],
    [{ success: true, code: 200, data: { cpCode: 'JD', mailNo: 'JD9999999999', theLastMessage: '运输中' } }, 'PROVIDER_NUMBER_MISMATCH'],
  ];
  for (const [payload, code] of cases) {
    const provider = createAliyunKzExpressProvider({ appCode: 'test', fetchImpl: async () => new Response(JSON.stringify(payload)) });
    await assert.rejects(provider.query({ number: 'JD1234567890', carrier: '京东', phone: '13800138000' }), { code });
  }
});

test('纯数字单号自动识别为顺丰时，缺少手机号不写回结果', async () => {
  const provider = createAliyunKzExpressProvider({ appCode: 'test', fetchImpl: async () => new Response(JSON.stringify({
    success: true, code: 200, data: { cpCode: 'SF', mailNo: '123456789012', theLastMessage: '运输中' },
  })) });
  await assert.rejects(provider.query({ number: '123456789012', carrier: '自动识别', phone: '' }), { code: 'PHONE_REQUIRED' });
});

test('不同手机号的阿里云成功结果按手机号隔离缓存', async () => {
  const mobiles = [];
  const provider = createAliyunKzExpressProvider({ appCode: 'test', fetchImpl: async (_url, options) => {
    mobiles.push(options.body.get('mobile'));
    return new Response(JSON.stringify({ success: true, code: 200, data: {
      cpCode: 'SF', mailNo: 'SF1234567890', theLastMessage: '快件已签收',
    } }));
  } });
  await provider.query({ number: 'SF1234567890', carrier: '顺丰', phone: '13800138000' });
  await provider.query({ number: 'SF1234567890', carrier: '顺丰', phone: '13800138001' });
  assert.deepEqual(mobiles, ['13800138000', '13800138001']);
});
