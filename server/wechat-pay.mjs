import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/**
 * 微信支付 API v3 核心驱动
 * 遵从《微信支付开发者文档》Native 扫码支付规范
 */
export function createWeChatPay(options = {}) {
  const mchId = String(options.mchId || process.env.WECHAT_MCH_ID || '').trim();
  const serialNo = String(options.serialNo || process.env.WECHAT_CERT_SERIAL_NO || '').trim();
  const appId = String(options.appId || process.env.WECHAT_APP_ID || '').trim();
  const apiV3Key = String(options.apiV3Key || process.env.WECHAT_API_V3_KEY || '').trim();
  const notifyCertSerial = String(options.notifyCertSerial || process.env.WECHAT_NOTIFY_CERT_SERIAL_NO || '').trim();
  const notifyUrl = String(options.notifyUrl || process.env.WECHAT_NOTIFY_URL || 'http://127.0.0.1:8791/api/pay/wechat/notify').trim();
  const pollingOnly = String(process.env.PAYMENT_POLLING_ONLY ?? 'true').toLowerCase() === 'true';
  const notifyUrlValid = /^https:\/\/[^\s/]+(?:\/[^\s]*)?$/i.test(notifyUrl) || (pollingOnly && /^http:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?(?:\/[^\s]*)?$/i.test(notifyUrl));

  // 私钥候选查找路径
  const keyCandidates = [
    options.keyPath,
    process.env.WECHAT_KEY_PATH,
    path.resolve(process.cwd(), '../paymentLogic/certs/apiclient_key.pem'),
    path.resolve('D:/高原安项目/快递/paymentLogic/certs/apiclient_key.pem'),
    path.resolve('certs/apiclient_key.pem'),
  ].filter(Boolean);

  let privateKey = '';
  for (const candidate of keyCandidates) {
    try {
      if (fs.existsSync(candidate)) {
        privateKey = fs.readFileSync(candidate, 'utf8');
        break;
      }
    } catch (_) {}
  }
  if (!privateKey) {
    console.warn('[WeChatPay] 暂未读取到微信支付商户私钥，将以 Mock 模拟支付模式启动');
  }

  const isConfigured = Boolean(mchId && serialNo && appId && apiV3Key && privateKey && notifyUrlValid);

  /**
   * 生成微信支付 v3 签名及 Authorization Header
   */
  function buildAuthHeader(method, canonicalUrl, bodyStr = '') {
    if (!privateKey) return '';
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const nonce = crypto.randomBytes(16).toString('hex');
    const message = `${method.toUpperCase()}\n${canonicalUrl}\n${timestamp}\n${nonce}\n${bodyStr}\n`;
    
    const signer = crypto.createSign('RSA-SHA256');
    signer.update(message);
    const signature = signer.sign(privateKey, 'base64');

    return `WECHATPAY2-SHA256-RSA2048 mchid="${mchId}",nonce_str="${nonce}",signature="${signature}",timestamp="${timestamp}",serial_no="${serialNo}"`;
  }

  /**
   * 创建 Native 扫码支付订单
   * @param {Object} param0 
   * @param {string} param0.orderId 商户单号
   * @param {number} param0.amount 金额（元）
   * @param {string} param0.description 商品描述
   * @returns {Promise<{ codeUrl: string, isMock: boolean, orderId: string, amount: number }>}
   */
  async function createNativeOrder({ orderId, amount, description = '快递查询额度套餐' }) {
    const amountCents = Math.round(Number(amount) * 100);

    if (process.env.MOCK_PAY === 'true') {
      const mockCodeUrl = `weixin://wxpay/bizpayurl?pr=mock_${orderId}`;
      return {
        codeUrl: mockCodeUrl,
        isMock: true,
        orderId,
        amount,
        amountCents,
        notice: !isConfigured ? '未配置正式微信支付 AppID/凭证，当前为演示模拟模式' : '已开启 MOCK_PAY 模拟模式',
      };
    }
    if (!isConfigured) throw new Error('微信支付未配置完整：请检查微信凭证、WECHAT_NOTIFY_URL；无公网回调时可启用 PAYMENT_POLLING_ONLY=true');

    try {
      const canonicalUrl = '/v3/pay/transactions/native';
      const requestUrl = `https://api.mch.weixin.qq.com${canonicalUrl}`;
      const payload = {
        appid: appId,
        mchid: mchId,
        description,
        out_trade_no: orderId,
        notify_url: notifyUrl,
        amount: {
          total: amountCents,
          currency: 'CNY',
        },
      };

      const bodyStr = JSON.stringify(payload);
      const authHeader = buildAuthHeader('POST', canonicalUrl, bodyStr);

      const res = await fetch(requestUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'Authorization': authHeader,
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 ExpressFieldShortcut/1.0',
        },
        body: bodyStr,
      });

      const resData = await res.json().catch(() => ({}));
      if (res.ok && typeof resData.code_url === 'string' && /^weixin:\/\/wxpay\//i.test(resData.code_url)) {
        return {
          codeUrl: resData.code_url,
          isMock: false,
          orderId,
          amount,
          amountCents,
        };
      }

      if (res.ok && resData.code_url) throw new Error('微信支付返回的 code_url 不是 Native 支付链接，已拒绝生成二维码');

      console.warn(`[WeChatPay] 微信 Native 下单返回异常状态 ${res.status}:`, resData);
      throw new Error(`微信 Native 下单失败（HTTP ${res.status}）：${resData.message || resData.code || '未知错误'}`);
    } catch (err) {
      console.warn('[WeChatPay] 请求微信支付 Native API 发生异常:', err.message);
      throw err;
    }
  }

  /**
   * 查询微信支付订单状态
   * @param {string} orderId 
   * @returns {Promise<{ isPaid: boolean, tradeState: string, transactionId?: string }>}
   */
  async function queryOrder(orderId) {
    if (process.env.MOCK_PAY === 'true') {
      return { isPaid: false, tradeState: 'MOCK_PENDING' };
    }
    if (!isConfigured) throw new Error('微信支付未配置完整');

    try {
      const canonicalUrl = `/v3/pay/transactions/out-trade-no/${encodeURIComponent(orderId)}?mchid=${encodeURIComponent(mchId)}`;
      const requestUrl = `https://api.mch.weixin.qq.com${canonicalUrl}`;
      const authHeader = buildAuthHeader('GET', canonicalUrl, '');

      const res = await fetch(requestUrl, {
        method: 'GET',
        headers: {
          'Accept': 'application/json',
          'Authorization': authHeader,
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 ExpressFieldShortcut/1.0',
        },
      });

      const resData = await res.json().catch(() => ({}));
      if (res.ok && resData.trade_state) {
        return {
          isPaid: resData.trade_state === 'SUCCESS',
          tradeState: resData.trade_state,
          transactionId: resData.transaction_id,
          successTime: resData.success_time,
          raw: resData,
        };
      }
      return { isPaid: false, tradeState: resData.trade_state || 'NOTPAY', raw: resData };
    } catch (err) {
      return { isPaid: false, tradeState: 'QUERY_ERROR', error: err.message };
    }
  }

  return {
    mchId,
    serialNo,
    appId,
    isConfigured,
    createNativeOrder,
    queryOrder,
    verifyNotify({ timestamp, nonce, signature, body, serial }) {
      if (!timestamp || !nonce || !signature || !body || !serial) return false;
      if (notifyCertSerial && serial !== notifyCertSerial) return false;
      const certCandidates = [
        options.certPath,
        process.env.WECHAT_CERT_PATH,
        path.resolve(process.cwd(), '../paymentLogic/certs/wechat_provided_cert.pem'),
        path.resolve('D:/高原安项目/快递/paymentLogic/certs/wechat_provided_cert.pem'),
        path.resolve('certs/wechat_provided_cert.pem'),
      ].filter(Boolean);
      let certPath = '';
      for (const candidate of certCandidates) {
        if (fs.existsSync(candidate)) { certPath = candidate; break; }
      }
      if (!certPath) return false;
      const certificate = fs.readFileSync(certPath, 'utf8');
      try {
        const verifier = crypto.createVerify('RSA-SHA256');
        verifier.update(`${timestamp}\n${nonce}\n${body}\n`);
        return verifier.verify(certificate, signature, 'base64');
      } catch {
        return false;
      }
    },
    decryptNotifyResource(resource) {
      if (!resource?.ciphertext || !resource?.nonce || !resource?.associated_data || !apiV3Key) throw new Error('微信支付通知缺少解密参数');
      const decipher = crypto.createDecipheriv('aes-256-gcm', Buffer.from(apiV3Key, 'utf8'), Buffer.from(resource.nonce, 'utf8'));
      decipher.setAAD(Buffer.from(resource.associated_data, 'utf8'));
      const encrypted = Buffer.from(resource.ciphertext, 'base64');
      const authTag = encrypted.subarray(encrypted.length - 16);
      const ciphertext = encrypted.subarray(0, encrypted.length - 16);
      decipher.setAuthTag(authTag);
      return JSON.parse(Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8'));
    },
  };
}
