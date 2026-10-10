import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createKuaidi100Provider } from '../server/providers/kuaidi100.mjs';
import { createService, formatResultText } from '../server/service.mjs';

test('快递100凭证缺失时拒绝启动真实适配器', () => {
  assert.throws(() => createKuaidi100Provider({ key: '', customer: '' }), { code: 'PROVIDER_NOT_CONFIGURED' });
});

test('快递100真实查询使用 SHA256 签名并映射完整轨迹', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), options });
    return new Response(JSON.stringify({ status: '200', state: '3', com: 'jd', nu: 'JD001234567890', data: [
      { ftime: '2026-09-15 12:00:00', context: '已签收', status: '签收', location: '上海市' },
      { ftime: '2026-09-14 10:00:00', context: '运输中', status: '在途' },
    ] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  let now = Date.parse('2026-09-15T05:00:00.000Z');
  const provider = createKuaidi100Provider({ key: 'test-key', customer: 'test-customer', fetchImpl, now: () => now });
  const service = createService({ mode: 'kuaidi100', provider, now: () => now });
  const result = await service.query({ number: 'JD001234567890', carrier: '京东' });
  assert.equal(result.mock, false);
  assert.equal(result.carrierCode, 'jd');
  assert.equal(result.state, '签收');
  assert.equal(result.events.length, 2);
  const body = calls[0].options.body;
  const param = body.get('param');
  assert.equal(body.get('customer'), 'test-customer');
  assert.equal(body.get('signType'), 'SHA256');
  assert.equal(body.get('sign'), createHash('sha256').update(param + 'test-key' + 'test-customer').digest('hex').toUpperCase());
  assert.match(formatResultText(result), /物流轨迹：[\s\S]*已签收[\s\S]*运输中/);

  now += 60_000;
  const cached = await service.query({ number: 'JD001234567890', carrier: '京东' });
  assert.equal(cached.cached, true);
  assert.equal(calls.length, 1);
});

test('自动识别后，顺丰和中通缺少手机号时不发起收费查询', async () => {
  let queryCalls = 0;
  const fetchImpl = async (url) => {
    if (String(url).includes('/autonumber/')) return new Response(JSON.stringify([{ comCode: 'shunfeng', name: '顺丰速运' }]), { headers: { 'Content-Type': 'application/json' } });
    queryCalls++;
    return new Response('{}', { headers: { 'Content-Type': 'application/json' } });
  };
  const provider = createKuaidi100Provider({ key: 'key', customer: 'customer', fetchImpl });
  await assert.rejects(provider.query({ number: 'SF1234567890', carrier: '自动识别' }), { code: 'PHONE_REQUIRED' });
  assert.equal(queryCalls, 0);
});

test('未知中文承运商不会伪装成已有快递', async () => {
  const provider = createKuaidi100Provider({ key: 'key', customer: 'customer', fetchImpl: async () => { throw new Error('不应联网'); } });
  await assert.rejects(provider.query({ number: '123456789', carrier: '货拉拉' }), { code: 'UNKNOWN_CARRIER' });
});

test('快递100返回 601 时明确提示充值实时查询单量', async () => {
  const fetchImpl = async () => new Response(JSON.stringify({ result: false, returnCode: '601', message: 'key已过期' }), { headers: { 'Content-Type': 'application/json' } });
  const provider = createKuaidi100Provider({ key: 'key', customer: 'customer', fetchImpl });
  await assert.rejects(provider.query({ number: 'JD1234567890', carrier: '京东' }), error => {
    assert.equal(error.code, 'PROVIDER_QUOTA_EXHAUSTED');
    assert.equal(error.status, 402);
    assert.match(error.message, /账户概览.*立即充值/);
    return true;
  });
});
