import { useEffect, useRef, useState } from 'react';
import type { Selection } from '@lark-base-open/js-sdk';
import type { Field, Mapping, QueryResult, Row } from './types';
import './sidebar.css';

type Context = { baseId: string; tableId: string; name: string; recordId: string | null };
type Session = { token: string; fields: Field[] };
type AutoQueryResult = ({ queried: true } & QueryResult) | { queried: false; skipped: true; code: string; reason: string };
type BillingStatus = { active: boolean; enforced: boolean; trialClaimed?: boolean; billingType: 'quota' | 'duration' | null; usedQuota: number; maxQuota: number; remainingQuota: number | null; expireTime: string | null };
type EnterpriseStatus = { registered: boolean; name: string; enterpriseType?: string };
type RechargePlan = { plan_id: string; name: string; quota?: number; days?: number; price: number; enabled: boolean; billing_type: string; description?: string };
type PaymentOrder = { orderId: string; amount: number; qrImage?: string | null; isMock?: boolean; notice?: string };
type Announcement = { id: string; title: string; content: string; level?: string; linkUrl?: string; updatedAt?: string | null };

const FALLBACK_PLANS: RechargePlan[] = [
  { plan_id: 'express_1000', name: '1,000 次查询包', billing_type: 'quota', quota: 1000, price: 12, enabled: true, description: '1,000 次快递查询额度（折合 0.012元/次）' },
  { plan_id: 'express_5000', name: '5,000 次查询包', billing_type: 'quota', quota: 5000, price: 50, enabled: true, description: '5,000 次快递查询额度（折合 0.010元/次）' },
  { plan_id: 'express_10000', name: '10,000 次查询包', billing_type: 'quota', quota: 10000, price: 90, enabled: true, description: '10,000 次快递查询额度（折合 0.009元/次）' },
];

const API_BASE = String(import.meta.env.VITE_API_BASE_URL || '').replace(/\/+$/, '');
const apiUrl = (path: string) => `${API_BASE}${path}`;

async function post<T>(route: string, body: unknown, token = ''): Promise<T> {
  const response = await fetch(apiUrl(`/api/${route}`), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error?.message || value.message || '请求失败');
  return value;
}

function formatQuota(num?: number | null): string {
  if (num === null || num === undefined) return '0';
  if (num >= 10000) {
    const w = (num / 10000).toFixed(1).replace(/\.0$/, '');
    return `${w}万`;
  }
  return num.toLocaleString();
}

const DEFAULT_TENANT_KEY = '';
const trialOfferSeenKey = (tenant: string) => `express-sidebar:trial-offer-seen:${tenant}`;

function hasSeenTrialOffer(tenant: string): boolean {
  try { return window.localStorage.getItem(trialOfferSeenKey(tenant)) === '1'; } catch { return false; }
}

function markTrialOfferSeen(tenant: string): void {
  try { window.localStorage.setItem(trialOfferSeenKey(tenant), '1'); } catch { /* Storage may be unavailable in an embedded browser. */ }
}

export default function Sidebar() {
  const embedded = window.parent !== window;
  const [context, setContext] = useState<Context | null>(null);
  const [tenantKey, setTenantKey] = useState<string>(DEFAULT_TENANT_KEY);
  const tenantKeyRef = useRef<string>(DEFAULT_TENANT_KEY);
  const currentTenant = () => tenantKeyRef.current || tenantKey || DEFAULT_TENANT_KEY;
  const active = useRef<Context | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [billing, setBilling] = useState<BillingStatus | null>(null);
  const [enterprise, setEnterprise] = useState<EnterpriseStatus | null>(null);
  const isEnterpriseFilled = Boolean(enterprise?.name && enterprise.name.trim() !== '' && enterprise.name.trim() !== '-');

  // 模态弹窗状态
  const [authModalOpen, setAuthModalOpen] = useState(false);
  const [couponModalOpen, setCouponModalOpen] = useState(false);
  const [couponCode, setCouponCode] = useState('');
  const [couponBusy, setCouponBusy] = useState(false);
  const [couponMessage, setCouponMessage] = useState<{ text: string; success: boolean } | null>(null);

  const [trialOfferOpen, setTrialOfferOpen] = useState(false);
  const [enterpriseOpen, setEnterpriseOpen] = useState(false);
  const [enterpriseName, setEnterpriseName] = useState('');
  const [enterpriseType, setEnterpriseType] = useState('');
  const [offerEligible, setOfferEligible] = useState(false);
  const [pendingTrial, setPendingTrial] = useState(false);

  const [rechargeOpen, setRechargeOpen] = useState(false);
  const [pendingRecharge, setPendingRecharge] = useState(false);
  const [rechargePlans, setRechargePlans] = useState<RechargePlan[]>([]);
  const [rechargeLoading, setRechargeLoading] = useState(false);
  const [rechargeError, setRechargeError] = useState('');

  const [paymentPlan, setPaymentPlan] = useState<RechargePlan | null>(null);
  const [paymentOrder, setPaymentOrder] = useState<PaymentOrder | null>(null);
  const [paymentBusy, setPaymentBusy] = useState(false);
  const [paymentError, setPaymentError] = useState('');
  const [paymentPaid, setPaymentPaid] = useState(false);
  const [pendingPurchase, setPendingPurchase] = useState<RechargePlan | null>(null);

  const [feedbackModalOpen, setFeedbackModalOpen] = useState(false);
  const [feedbackContent, setFeedbackContent] = useState('');
  const [feedbackContact, setFeedbackContact] = useState('');
  const [feedbackBusy, setFeedbackBusy] = useState(false);
  const [feedbackSuccess, setFeedbackSuccess] = useState(false);

  const [refundModalOpen, setRefundModalOpen] = useState(false);
  const [refundOrderId, setRefundOrderId] = useState('');
  const [refundBusy, setRefundBusy] = useState(false);
  const [refundResult, setRefundResult] = useState('');

  const [provider, setProvider] = useState<{ mode: 'loading' | 'mock' | 'kuaidi100' | 'aliyun_kzexpress' | 'error'; configured: boolean }>({ mode: 'loading', configured: false });
  const [announcements, setAnnouncements] = useState<Announcement[]>([]);
  const [globalLinkUrl, setGlobalLinkUrl] = useState('');
  const [groupUrl, setGroupUrl] = useState('');
  const credential = useRef<Session | null>(null);
  const [code, setCode] = useState('');
  const [mapping, setMapping] = useState<Mapping>({ number: '', info: '' });
  const [carrier, setCarrier] = useState('自动识别');
  const [autoQuery, setAutoQuery] = useState(true);
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const lock = useRef(false);
  const cancelled = useRef(false);
  const [message, setMessage] = useState('');
  const [progress, setProgress] = useState({ done: 0, total: 0, ok: 0, failed: 0, skipped: 0 });
  const [failed, setFailed] = useState<Row[]>([]);
  const [last, setLast] = useState<QueryResult | null>(null);
  const revision = useRef(0);
  const recognize = useRef<() => Promise<void>>(async () => { });

  const openAnnouncementLink = (itemLink?: string) => {
    const target = itemLink?.trim();
    if (!target) return;
    try {
      const url = new URL(target);
      if (url.protocol === 'https:' || url.protocol === 'http:') window.open(url.href, '_blank', 'noopener,noreferrer');
    } catch {
      // Ignore invalid or unconfigured announcement URLs.
    }
  };

  const OFFICIAL_GROUP_URL = 'https://applink.feishu.cn/client/chat/chatter/add_by_link?link_token=c23v2186-e36c-42c9-a6e3-1bf381411a98';

  const openOfficialGroup = () => {
    window.open(OFFICIAL_GROUP_URL, '_blank', 'noopener,noreferrer');
  };

  // 1. 服务健康检测与模式识别
  useEffect(() => {
    fetch(apiUrl('/api/health'))
      .then(r => r.json())
      .then(v => setProvider({ mode: ['kuaidi100', 'aliyun_kzexpress'].includes(v.providerMode) ? v.providerMode : 'mock', configured: !!v.providerConfigured }))
      .catch(() => setProvider({ mode: 'error', configured: false }));
  }, []);

  // 2. 接收插件管理平台与 SDK 的公告及交流群地址
  const loadAnnouncements = () => {
    fetch(apiUrl('/api/announcement'))
      .then(r => (r.ok ? r.json() : null))
      .then(v => {
        if (v?.announcement?.linkUrl) setGlobalLinkUrl(v.announcement.linkUrl);
        if (v?.groupUrl) setGroupUrl(v.groupUrl);
        if (Array.isArray(v?.announcements)) {
          setAnnouncements(v.announcements);
        } else if (v?.announcement?.text) {
          setAnnouncements([{ id: '1', title: v.announcement.text, content: '', level: 'info', linkUrl: v.announcement.linkUrl || '' }]);
        }
      })
      .catch(() => { });
  };

  useEffect(() => {
    loadAnnouncements();
    const timer = window.setInterval(loadAnnouncements, 30000);
    return () => window.clearInterval(timer);
  }, []);

  // 3. 刷新套餐与企业信息（转圈样式）
  const refreshBilling = async () => {
    if (refreshing || !currentTenant()) return;
    setRefreshing(true);
    const key = currentTenant();
    try {
      const [licRes, entRes] = await Promise.all([
        fetch(apiUrl(`/api/license/status?tenant=${encodeURIComponent(key)}`)),
        fetch(apiUrl(`/api/enterprise/status?tenant=${encodeURIComponent(key)}`)),
        new Promise(resolve => setTimeout(resolve, 600)),
      ]);
      if (licRes.ok) {
        const d = await licRes.json();
        setBilling(d.license);
        const eligible = Boolean(d.license && d.license.trialClaimed === false);
        setOfferEligible(eligible);
      }
      if (entRes.ok) {
        const e = await entRes.json();
        setEnterprise(e);
        if (e.name) setEnterpriseName(e.name);
        if (e.enterpriseType) setEnterpriseType(e.enterpriseType);
      }
    } catch (_) {
    } finally {
      setRefreshing(false);
    }
  };

  // 4. 监听飞书宿主环境
  useEffect(() => {
    if (!embedded) return;
    let disposed = false;
    let sequence = 0;
    const off: (() => void)[] = [];
    const timer = setTimeout(() => {
      if (!disposed && !active.current) setMessage('尚未连接飞书宿主。请确认是通过「自定义插件 → 新增插件」打开，再点击重新识别。');
    }, 10000);

    import('@lark-base-open/js-sdk').then(async ({ bitable }) => {
      if (disposed) return;
      async function select(selection: Selection) {
        const request = ++sequence;
        if (disposed) return;
        const previous = active.current;
        if (selection.baseId === previous?.baseId && selection.tableId === previous?.tableId) {
          const next = { ...previous, recordId: selection.recordId };
          active.current = next;
          setContext(next);
          return;
        }
        revision.current++;
        cancelled.current = true;
        const old = credential.current;
        credential.current = null;
        setSession(null);
        setCode('');
        if (old) void post('disconnect', {}, old.token).catch(() => { });
        active.current = null;
        setContext(null);
        setMapping({ number: '', info: '' });
        setLast(null);
        setFailed([]);
        setProgress({ done: 0, total: 0, ok: 0, failed: 0, skipped: 0 });
        if (!selection.baseId || !selection.tableId) {
          setMessage('请先在飞书左侧选择一个数据表。');
          return;
        }
        const table = await bitable.base.getTableById(selection.tableId);
        const name = await table.getName();
        if (disposed || request !== sequence) return;
        const next = { baseId: selection.baseId, tableId: selection.tableId, recordId: selection.recordId, name };
        active.current = next;
        setContext(next);
        // 重要：切勿将 tenantKey 设为 selection.baseId（baseId 是数据表 AppToken，非企业组织 TenantKey）
        setMessage('');
      }

      const handle = async (selection?: Selection) => {
        try {
          await select(selection || (await bitable.base.getSelection()));
        } catch {
          if (!disposed) setMessage('读取当前数据表失败，请重新识别或重新打开插件。');
        }
      };

      recognize.current = () => handle();
      off.push(bitable.base.onSelectionChange(event => void handle(event.data)));
      const theme = (value: string) => {
        if (!disposed) document.documentElement.dataset.sidebarTheme = value === 'DARK' ? 'dark' : 'light';
      };
      off.push(bitable.bridge.onThemeChange(event => theme(event.data.theme)));
      void bitable.bridge.getTheme().then(theme).catch(() => { });
      try {
        const bridgeKey = await bitable.bridge.getTenantKey();
        if (!disposed && bridgeKey && bridgeKey.trim()) {
          tenantKeyRef.current = bridgeKey.trim();
          setTenantKey(bridgeKey.trim());
        }
      } catch (err) {
        console.warn('获取飞书企业 TenantKey 异常:', err);
      }
      await handle();
    }).catch(() => {
      if (!disposed) setMessage('飞书 SDK 加载失败，请检查网络后重新打开插件。');
    });

    return () => {
      disposed = true;
      clearTimeout(timer);
      off.forEach(fn => fn());
      delete document.documentElement.dataset.sidebarTheme;
    };
  }, [embedded]);

  // 5. 监听 session 变化刷新计费（确保始终以当前企业配额为准，不因表格未连接清空）
  useEffect(() => {
    if (tenantKey) void refreshBilling();
  }, [session?.token, tenantKey]);

  // 6. 企业状态与试用资格初始化
  useEffect(() => {
    const trustedTenant = currentTenant();
    if (!trustedTenant) return;
    let disposed = false;
    Promise.all([
      fetch(apiUrl(`/api/enterprise/status?tenant=${encodeURIComponent(trustedTenant)}`)).then(r => (r.ok ? r.json() : null)).catch(() => null),
      fetch(apiUrl(`/api/license/status?tenant=${encodeURIComponent(trustedTenant)}`)).then(r => (r.ok ? r.json() : null)).catch(() => null),
    ]).then(([ent, licRes]) => {
      if (disposed) return;
      if (ent) {
        setEnterprise(ent);
        if (ent.name) setEnterpriseName(ent.name);
        if (ent.enterpriseType) setEnterpriseType(ent.enterpriseType);
      }
      const license = licRes?.license;
      if (license) setBilling(license);
      const eligible = Boolean(license && license.trialClaimed === false);
      setOfferEligible(eligible);
      if (eligible && !hasSeenTrialOffer(trustedTenant)) {
        markTrialOfferSeen(trustedTenant);
        setTrialOfferOpen(true);
      }
    });
    return () => { disposed = true; };
  }, [tenantKey]);

  // 7. 自动查询监听
  useEffect(() => {
    if (!embedded || !autoQuery || !context?.tableId || !session || !mapping.number || !mapping.info || mapping.number === mapping.info) return;
    let disposed = false;
    const version = revision.current;
    const timers = new Map<string, number>();
    const running = new Set<string>();
    const rerun = new Set<string>();
    const off: (() => void)[] = [];

    const execute = async (recordId: string) => {
      timers.delete(recordId);
      if (disposed || version !== revision.current) return;
      if (running.has(recordId)) { rerun.add(recordId); return; }
      const currentSession = credential.current;
      if (!currentSession) return;
      running.add(recordId);
      try {
        const result = await post<AutoQueryResult>('base/auto-query-record', { recordId, mapping, carrier }, currentSession.token);
        if (disposed || version !== revision.current) return;
        if (result.queried) {
          setLast(result);
          setMessage(`已自动查询并写回：${result.number} · ${result.carrier}`);
          void refreshBilling();
        } else {
          setMessage(`自动查询已等待：${result.reason}`);
        }
      } catch (error) {
        if (!disposed && version === revision.current) setMessage(`自动查询失败：${error instanceof Error ? error.message : '请求失败'}`);
      } finally {
        running.delete(recordId);
        if (rerun.delete(recordId) && !disposed) schedule(recordId);
      }
    };

    const schedule = (recordId: string) => {
      if (!recordId || disposed) return;
      const old = timers.get(recordId);
      if (old) window.clearTimeout(old);
      timers.set(recordId, window.setTimeout(() => void execute(recordId), 1200));
    };

    import('@lark-base-open/js-sdk').then(async ({ bitable }) => {
      const table = await bitable.base.getTableById(context.tableId);
      if (disposed) return;
      off.push(table.onRecordAdd(event => event.data.forEach(schedule)));
      off.push(table.onRecordModify(event => {
        const watched = new Set([mapping.number, mapping.phone, mapping.carrier].filter(Boolean));
        if (event.data.fieldIds.some(fieldId => watched.has(fieldId))) schedule(event.data.recordId);
      }));
    }).catch(() => {
      if (!disposed) setMessage('自动查询监听启动失败，请重新打开插件。');
    });

    return () => {
      disposed = true;
      timers.forEach(timer => window.clearTimeout(timer));
      off.forEach(fn => fn());
    };
  }, [embedded, autoQuery, context?.tableId, session?.token, mapping.number, mapping.info, mapping.phone, mapping.carrier, carrier]);

  // 8. 轮询订单支付状态
  useEffect(() => {
    if (!paymentOrder?.orderId || paymentPaid) return;
    let disposed = false;
    const timer = window.setInterval(async () => {
      try {
        const result = await post<{ isPaid?: boolean }>('pay/wechat/query-order', { orderId: paymentOrder.orderId });
        if (disposed || !result.isPaid) return;
        setPaymentPaid(true);
        await refreshBilling();
      } catch (_) { }
    }, 2500);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [paymentOrder?.orderId, paymentPaid, tenantKey, context?.baseId]);

  // 9. 支付成功后自动关闭所有弹窗并返回主页
  useEffect(() => {
    if (!paymentPaid) return;
    const timer = window.setTimeout(() => {
      setPaymentPlan(null);
      setPaymentOrder(null);
      setRechargeOpen(false);
      setPaymentPaid(false);
      setMessage('支付成功，套餐额度已自动充值到账！');
      void refreshBilling();
    }, 1500);
    return () => window.clearTimeout(timer);
  }, [paymentPaid]);

  // 执行通用业务动作
  async function act(task: (version: number) => Promise<void>) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    const version = revision.current;
    try {
      await task(version);
    } catch (error) {
      if (version === revision.current) {
        const msg = error instanceof Error ? error.message : '操作失败';
        if (msg.includes('会话失效') || msg.includes('请先连接')) {
          credential.current = null;
          setSession(null);
        }
        setMessage(msg);
      }
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }

  // 授权码连接
  async function connect(tokenValue?: string) {
    const targetCode = String(tokenValue !== undefined ? tokenValue : code).trim();
    if (!targetCode) {
      setMessage('请输入飞书个人授权码 (Personal Base Token)');
      return;
    }
    await act(async version => {
      const current = active.current;
      if (!current) throw new Error('请先选择数据表');
      const result = await post<Session>('connect', {
        mode: 'feishu',
        appToken: current.baseId,
        tableId: current.tableId,
        tenantKey: currentTenant(),
        personalBaseToken: targetCode,
      });
      if (version !== revision.current) {
        await post('disconnect', {}, result.token);
        return;
      }
      credential.current = result;
      setSession(result);
      setCode('');
      setAuthModalOpen(false);
      setMapping({
        number: result.fields.find(f => f.name === '快递单号' && f.type === 1)?.id || '',
        info: result.fields.find(f => f.name === '快递信息' && f.type === 1)?.id || '',
        carrier: result.fields.find(f => f.name === '快递公司' && f.type === 1)?.id || '',
        phone: result.fields.find(f => f.name === '核验手机号' && f.type === 1)?.id || '',
      });
      setMessage('已完成授权配置并连接数据表！');
      void refreshBilling();
    });
  }

  // 领取试用套餐
  async function enterpriseForAction(tenant: string): Promise<EnterpriseStatus> {
    const response = await fetch(apiUrl(`/api/enterprise/status?tenant=${encodeURIComponent(tenant)}`));
    const value = await response.json();
    if (!response.ok) throw new Error(value.error?.message || '检查企业信息失败，请重试');
    setEnterprise(value);
    if (value.name) setEnterpriseName(value.name);
    if (value.enterpriseType) setEnterpriseType(value.enterpriseType);
    return value;
  }

  async function claimTrial(registeredNow = false) {
    const trustedTenant = currentTenant();
    if (!trustedTenant) {
      setMessage('未获取到当前租户标识');
      return;
    }
    let registeredEnterprise = enterprise;
    if (!registeredNow) {
      try { registeredEnterprise = await enterpriseForAction(trustedTenant); }
      catch (error) { setMessage(error instanceof Error ? error.message : '检查企业信息失败'); return; }
    }
    const resolvedName = (registeredNow ? enterpriseName : registeredEnterprise?.name || '').trim();
    if ((!registeredEnterprise?.registered && !registeredNow) || !resolvedName) {
      setPendingTrial(true);
      setEnterpriseOpen(true);
      return;
    }
    await act(async () => {
      const value = await post<BillingStatus & { registered?: boolean; enterprise?: EnterpriseStatus }>('billing/claim-trial', {
        tenantKey: trustedTenant,
        enterpriseName: resolvedName,
        enterpriseType: enterpriseType.trim() || enterprise?.enterpriseType || '',
      });
      if (value.enterprise) {
        setEnterprise(value.enterprise);
      } else if (resolvedName) {
        setEnterprise(prev => ({ registered: true, name: resolvedName, enterpriseType: prev?.enterpriseType || enterpriseType.trim() }));
      }
      setTrialOfferOpen(false);
      setEnterpriseOpen(false);
      setPendingTrial(false);
      setOfferEligible(false);
      setBilling(value);
      setMessage('试用套餐已领取，已为您开通 15 次免费查询额度！');
    });
  }

  // 兑换码兑换
  async function handleRedeemCoupon() {
    if (!couponCode.trim()) {
      setCouponMessage({ text: '请输入有效的兑换码', success: false });
      return;
    }
    setCouponBusy(true);
    setCouponMessage(null);
    try {
      const key = currentTenant();
      const result = await post<{ ok: boolean; message: string; license: BillingStatus }>('billing/redeem-coupon', {
        tenantKey: key,
        couponCode: couponCode.trim(),
      });
      setCouponMessage({ text: result.message || '兑换成功！', success: true });
      if (result.license) setBilling(result.license);
      setTimeout(() => {
        setCouponModalOpen(false);
        setCouponCode('');
        setCouponMessage(null);
      }, 1500);
    } catch (err) {
      setCouponMessage({ text: err instanceof Error ? err.message : '兑换失败，请检查兑换码是否有效', success: false });
    } finally {
      setCouponBusy(false);
    }
  }

  // 打开充值续费弹窗（拉取平台受控的实时套餐）
  async function openRecharge(registeredNow = false) {
    const key = currentTenant();
    if (!key) { setMessage('未获取到当前租户标识'); return; }
    let registeredEnterprise = enterprise;
    if (!registeredNow) {
      try { registeredEnterprise = await enterpriseForAction(key); }
      catch (error) { setMessage(error instanceof Error ? error.message : '检查企业信息失败'); return; }
    }
    if (!registeredNow && (!registeredEnterprise?.registered || !registeredEnterprise.name?.trim() || registeredEnterprise.name === '-')) {
      setPendingRecharge(true);
      setEnterpriseOpen(true);
      setMessage('请先完善当前企业信息后再进行充值');
      return;
    }
    setPendingRecharge(false);
    setRechargeOpen(true);
    setRechargeLoading(true);
    setRechargeError('');
    try {
      const response = await fetch(apiUrl(`/api/license/status?tenant=${encodeURIComponent(key)}`));
      const result = await response.json();
      if (!response.ok) throw new Error(result.error?.message || '读取套餐失败');
      const plans = (result.config?.plans || []) as RechargePlan[];
      setRechargePlans(plans.filter(plan => plan.enabled && plan.billing_type === 'quota' && plan.price > 0));
    } catch (error) {
      setRechargePlans(FALLBACK_PLANS);
      setRechargeError(`平台配置同步异常，显示预设套餐（${error instanceof Error ? error.message : '网络故障'}）`);
    } finally {
      setRechargeLoading(false);
    }
  }

  // 开始购买套餐（生成真实微信支付 Native 二维码）
  async function startPurchase(plan: RechargePlan, skipEnterpriseCheck = false) {
    const key = currentTenant();
    setPaymentError('');
    if (!skipEnterpriseCheck && (!enterprise?.registered || !isEnterpriseFilled)) {
      setPendingPurchase(plan);
      setEnterpriseOpen(true);
      return;
    }
    setPaymentPlan(plan);
    setPaymentOrder(null);
    setPaymentPaid(false);
    setPaymentBusy(true);
    try {
      const result = await post<PaymentOrder>('pay/wechat/create-order', { tenantKey: key, planId: plan.plan_id });
      setPaymentOrder(result);
    } catch (error) {
      setPaymentError(error instanceof Error ? error.message : '创建订单失败');
    } finally {
      setPaymentBusy(false);
    }
  }

  // 登记企业信息
  async function submitEnterprise() {
    const key = currentTenant();
    if (!enterpriseName.trim() || enterpriseName.trim() === '-') {
      setMessage('请输入有效的企业名称');
      return;
    }
    setPaymentBusy(true);
    try {
      await post('billing/register-enterprise', {
        tenantKey: key,
        enterpriseName: enterpriseName.trim(),
        enterpriseType: enterpriseType.trim(),
      });
      setEnterprise({ registered: true, name: enterpriseName.trim(), enterpriseType: enterpriseType.trim() });
      setEnterpriseOpen(false);
      if (pendingPurchase) {
        const plan = pendingPurchase;
        setPendingPurchase(null);
        await startPurchase(plan, true);
      } else if (pendingTrial) {
        await claimTrial(true);
      } else if (pendingRecharge) {
        await openRecharge(true);
      } else {
        setMessage('企业信息保存成功！');
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '登记企业失败');
    } finally {
      setPaymentBusy(false);
    }
  }

  // 申请退款处理
  async function handleRefund() {
    if (!refundOrderId.trim()) {
      setRefundResult('请输入需要申请退款的订单号');
      return;
    }
    setRefundBusy(true);
    setRefundResult('');
    try {
      const res = await post<{ alreadyRefunded?: boolean; message?: string }>('billing/refund', {
        orderId: refundOrderId.trim(),
      });
      setRefundResult(res.alreadyRefunded ? '该订单此前已完成退款' : '退款申请已受理成功，款项将原路返还');
      await refreshBilling();
    } catch (e) {
      setRefundResult(e instanceof Error ? e.message : '退款申请失败');
    } finally {
      setRefundBusy(false);
    }
  }

  // 提交官方交流群反馈
  async function submitFeedback() {
    if (!feedbackContent.trim()) {
      setMessage('请输入反馈内容');
      return;
    }
    setFeedbackBusy(true);
    try {
      await post('feedback', {
        tenantKey: currentTenant(),
        content: feedbackContent.trim(),
        contact: feedbackContact.trim(),
      });
      setFeedbackSuccess(true);
      setTimeout(() => {
        setFeedbackModalOpen(false);
        setFeedbackContent('');
        setFeedbackContact('');
        setFeedbackSuccess(false);
      }, 1800);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : '提交反馈失败');
    } finally {
      setFeedbackBusy(false);
    }
  }

  // 初始化表格列
  async function initialize() {
    await act(async version => {
      if (!session) return;
      const result = await post<{ mapping: Mapping; fields: Field[] }>('base/initialize', {}, session.token);
      if (version !== revision.current) return;
      setMapping(previous => ({
        ...result.mapping,
        carrier: result.fields.some(f => f.id === previous.carrier && f.type === 1)
          ? previous.carrier : result.fields.find(f => f.name === '快递公司' && f.type === 1)?.id || '',
        phone: result.fields.some(f => f.id === previous.phone && f.type === 1)
          ? previous.phone : result.fields.find(f => f.name === '核验手机号' && f.type === 1)?.id || '',
      }));
      const next = { ...session, fields: result.fields };
      credential.current = next;
      setSession(next);
      setMessage('已在飞书数据表创建或复用「快递单号」「快递信息」列。');
    });
  }

  // 执行查询
  async function query(scope: 'current' | 'all' | 'failed') {
    await act(async version => {
      if (!session) return;
      cancelled.current = false;
      setLast(null);
      setMessage('正在读取当前数据表中的记录…');
      const { rows } = await post<{ rows: Row[] }>('base/rows', { mapping }, session.token);
      if (version !== revision.current) return;
      const currentId = active.current?.recordId;
      const targets = scope === 'current' ? rows.filter(r => r.id === currentId) : scope === 'failed' ? rows.filter(r => failed.some(f => f.id === r.id)) : rows;
      if (!targets.length) throw new Error(scope === 'current' ? '请先在飞书表格中点击需要查询的那一行。' : '没有可查询的记录。');
      const failures: Row[] = [];
      const stats = { done: 0, total: targets.length, ok: 0, failed: 0, skipped: 0 };
      setProgress({ ...stats });
      setFailed([]);
      for (const row of targets) {
        if (cancelled.current || version !== revision.current) break;
        if (!row.number.trim()) stats.skipped++;
        else {
          setMessage(`正在查询 ${stats.done + 1}/${stats.total}：${row.number}`);
          try {
            const result = await post<QueryResult>('base/query-record', { recordId: row.id, mapping, carrier }, session.token);
            stats.ok++;
            if (version === revision.current) setLast(result);
            void refreshBilling();
          } catch (error) {
            stats.failed++;
            failures.push({ ...row, error: error instanceof Error ? error.message : '查询失败' });
          }
        }
        stats.done++;
        if (version !== revision.current) return;
        setProgress({ ...stats });
        setFailed([...failures]);
        if (stats.done < stats.total) await new Promise(resolve => setTimeout(resolve, 550));
      }
      if (version === revision.current) setMessage(`${cancelled.current ? '已停止后续查询' : '查询完成'}：成功 ${stats.ok}，失败 ${stats.failed}，空单号跳过 ${stats.skipped}。成功结果已写入飞书表格。`);
    });
  }

  const ready = !!session && !!mapping.number && !!mapping.info && mapping.number !== mapping.info && !busy;

  return (
    <div className="sidebar-app">
      {/* 1. 顶部公告栏（接收管理平台信息，悬停暂停且展示跳转提示） */}
      {announcements.length > 0 && (
        <section
          className="sidebar-announcement"
          aria-label="平台公告"
          title="仅配置了链接的公告可以点击跳转"
        >
          <span className="sidebar-announcement-label">公告</span>
          <div className="sidebar-announcement-track">
            {announcements.map(item => (
              item.linkUrl?.trim() ? (
                <a
                  className={`sidebar-announcement-item level-${item.level || 'info'} has-link`}
                  key={item.id}
                  href={item.linkUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={e => {
                    e.preventDefault();
                    e.stopPropagation();
                    openAnnouncementLink(item.linkUrl);
                  }}
                >
                  <b>{item.title}</b>
                  {item.content && `：${item.content}`}
                  <span style={{ marginLeft: '4px', opacity: 0.85 }}>↗</span>
                </a>
              ) : (
                <span className={`sidebar-announcement-item level-${item.level || 'info'} no-link`} key={item.id}>
                  <b>{item.title}</b>
                  {item.content && `：${item.content}`}
                </span>
              )
            ))}
          </div>
          <div className="sidebar-announcement-tooltip">仅配置了链接的公告可以点击跳转</div>
        </section>
      )}

      {/* 2. 套餐额度卡片（精准对齐电子签名截图 1） */}
      <section className="sidebar-billing-card" aria-label="套餐额度">
        <div className="sidebar-billing-header">
          <div className="sidebar-billing-title-group">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="2" y="5" width="20" height="14" rx="2" />
              <line x1="2" y1="10" x2="22" y2="10" />
            </svg>
            <span>套餐额度</span>
            <button
              type="button"
              className={`sidebar-refresh-btn ${refreshing ? 'is-spinning' : ''}`}
              title={refreshing ? '正在刷新额度…' : '刷新额度'}
              aria-label="刷新额度"
              onClick={() => void refreshBilling()}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.19" />
              </svg>
            </button>
          </div>

          <div className="sidebar-billing-actions">
            <div className="sidebar-billing-actions-row">
              <button type="button" className="btn-auth-config" onClick={() => setAuthModalOpen(true)}>
                ⚙️ 授权码配置
              </button>
              <button type="button" className="btn-recharge" onClick={() => void openRecharge()}>
                充值续费
              </button>
            </div>
            <button type="button" className="btn-coupon" onClick={() => setCouponModalOpen(true)}>
              🎟️ 兑换码
            </button>
          </div>
        </div>

        <div className="sidebar-billing-main">
          <div className="sidebar-billing-quota-text">
            剩余额度: <span className="quota-highlight">{billing?.remainingQuota ?? 0}</span> 次
          </div>
        </div>

        <div className="sidebar-billing-divider" />

        <div className="sidebar-billing-meta">
          <span>企业额度: {formatQuota(billing?.maxQuota)} 次</span>
          <span>企业用量: {billing?.usedQuota ?? 0} 次</span>
        </div>

        {offerEligible && (
          <div className="sidebar-billing-trial-bar">
            <span style={{ fontSize: '12px', color: '#eb2f96' }}>🎁 新企业赠送 15 次体验查询</span>
            <button type="button" className="sidebar-billing-trial" onClick={() => setTrialOfferOpen(true)}>
              免费领取试用
            </button>
          </div>
        )}
      </section>

      {/* 3. 温馨提示卡片（精准对齐电子签名截图 1） */}
      <section className="sidebar-tips-card" aria-label="温馨提示">
        <div className="sidebar-tips-title">温馨提示</div>
        <div className="sidebar-tips-alert">
          ⚠️ 重要：使用前必须先完成「授权码配置」，否则无法查询物流信息。
        </div>
        <ul className="sidebar-tips-list">
          <li>1、切换数据表格之后，请重新打开插件页面</li>
          <li>2、操作将消耗套餐次数（1条记录 = 1次）</li>
          <li>3、批量查询只针对未填写/未完成查询的数据行</li>
        </ul>
      </section>


      {!embedded ? (
        <section className="sidebar-panel">
          <h2>添加到飞书边栏</h2>
          <ol>
            <li>打开你的多维表格，点击右上角插件图标。</li>
            <li>进入「自定义插件」，点击「新增插件」。</li>
            <li>将下方地址填入插件运行地址，保存并打开。</li>
          </ol>
          <label>
            插件运行地址
            <input readOnly value={`${window.location.origin}/`} onFocus={e => e.target.select()} />
          </label>
          <p className="sidebar-help">本地联调时，此电脑需要保持服务运行。正式上架将使用公开 HTTPS 地址。</p>
          <a href="/?demo=1">查看独立模拟测试页</a>
        </section>
      ) : (
        <>
          {/* 4. 当前表格与字段配置 */}
          <section className="sidebar-panel">
            <h2>当前数据表</h2>
            <strong>{context?.name || '等待飞书连接…'}</strong>
            <p className="sidebar-help">
              {context ? (context.recordId ? '已选中一行，可单独查询。' : '点击表格中的任意一行，可单独针对该行查询。') : '请在多维表格中打开本插件。'}
            </p>
            <details>
              <summary>连接信息</summary>
              <p className="sidebar-help">
                Base：{context?.baseId || '未识别'}<br />
                数据表：{context?.tableId || '未识别'}
              </p>
              <button disabled={busy} onClick={() => recognize.current()}>重新识别</button>
            </details>
          </section>

          <section className="sidebar-panel">
            <h2>批量配置与字段映射</h2>
            {!session ? (
              <div className="sidebar-direct-auth">
                <div className="sidebar-auth-row">
                  <input
                    type="password"
                    className="sidebar-auth-input"
                    value={code}
                    disabled={busy}
                    onChange={e => setCode(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === 'Enter' && code.trim() && !busy) {
                        void connect(code);
                      }
                    }}
                    placeholder="请输入飞书个人授权码 (Personal Base Token)"
                  />
                </div>
                <div className="sidebar-auth-row" style={{ marginTop: '10px' }}>
                  <button
                    type="button"
                    className="primary sidebar-connect-btn"
                    disabled={!code.trim() || busy}
                    onClick={() => void connect(code)}
                  >
                    {busy ? '正在连接数据表…' : '连接数据表'}
                  </button>
                </div>
              </div>
            ) : (
              <>
                <p className="sidebar-help" style={{ color: '#277658' }}>✓ 数据表已成功连接授权。</p>
                {(['number', 'info', 'carrier', 'phone'] as const).map(key => (
                  <label key={key}>
                    {key === 'number' ? '快递单号列（必选）' : key === 'info' ? '快递信息列（必选）' : key === 'carrier' ? '快递公司列（可选）' : '核验手机号列（可选）'}
                    <select value={mapping[key] || ''} disabled={busy} onChange={e => setMapping({ ...mapping, [key]: e.target.value })}>
                      <option value="">{key === 'number' || key === 'info' ? '请选择文本字段' : '不使用此辅助列'}</option>
                      {session.fields.filter(f => f.type === 1).map(f => (
                        <option key={f.id} value={f.id}>{f.name}</option>
                      ))}
                    </select>
                  </label>
                ))}
                <p className="sidebar-help">顺丰、中通、跨越请映射收/寄件手机号列，可填完整 11 位或后四位；查询时与单号一起提交阿里云。批量混合快递建议映射“快递公司”列。</p>
                <button className="wide" disabled={busy} onClick={initialize}>在当前表创建 / 复用单号与信息列</button>
                <button className="wide" disabled={busy} onClick={() => act(async () => {
                  await post('disconnect', {}, session.token);
                  credential.current = null;
                  setSession(null);
                  setMessage('已清除当前表格授权连接。');
                })}>
                  断开并清除授权
                </button>
              </>
            )}
          </section>

          {/* 5. 快递查询操作 */}
          <section className="sidebar-panel">
            <h2>查询物流轨迹</h2>
            <label>
              承运商识别模式
              <input list="sidebar-carriers" value={carrier} disabled={busy} onChange={e => setCarrier(e.target.value)} />
              <datalist id="sidebar-carriers">
                {['自动识别', '京东', '邮政', '安能', '跨越', '顺丰', '中通', '货拉拉'].map(c => (
                  <option key={c}>{c}</option>
                ))}
              </datalist>
            </label>
            <label className="sidebar-toggle">
              <input type="checkbox" checked={autoQuery} disabled={!session} onChange={e => setAutoQuery(e.target.checked)} />
              自动查询新增或修改的记录（单号变动后 1.2 秒内自动执行）
            </label>
            <button className="wide" disabled={!ready || !context?.recordId} onClick={() => query('current')} title={!context?.recordId ? '先点击表格中该行的单元格使其成为当前行；勾选复选框不会提供活动行 ID' : ''}>
              查询表格中选中的这一行
            </button>
            {!context?.recordId && <p className="sidebar-help">当前无法识别活动行。请点击该行任意单元格（不要只勾选左侧复选框）后再查询；按钮启用后仍查询不到时，请查看下方失败原因。</p>}
            <button className="primary wide" disabled={!ready} onClick={() => query('all')}>
              一键查询当前表全部运单
            </button>
            {busy && (
              <button className="wide" onClick={() => { cancelled.current = true; }}>
                停止后续查询
              </button>
            )}
            {failed.length > 0 && (
              <button className="wide" disabled={!ready} onClick={() => query('failed')}>
                重试失败记录（{failed.length} 条）
              </button>
            )}
          </section>
        </>
      )}

      {/* 6. 反馈与支持卡片（精准对齐电子签名截图 2 & 5） */}
      <section className="sidebar-feedback-card" aria-label="反馈与支持">
        <div className="sidebar-feedback-title">
          <span>💬</span>
          <span>反馈与支持</span>
        </div>
        <div className="sidebar-feedback-desc">
          如在使用中遇到问题、发现不当内容或有任何建议，欢迎加入官方交流群反馈，我们将及时响应处理。
        </div>
        <div className="sidebar-feedback-action">
          <button type="button" className="sidebar-feedback-btn" onClick={openOfficialGroup}>
            <span>💬</span>
            <span>加入官方交流群</span>
          </button>
        </div>
      </section>

      {/* 运行状态信息：仅在执行中、有失败/完成或查询反馈时显示，静态引导文案不显示 */}
      {message && (busy || message.includes('失败') || message.includes('完成') || message.includes('错误') || message.includes('写回')) && (
        <div className="sidebar-message" role="status">{message}</div>
      )}

      {progress.total > 0 && (
        <section className="sidebar-panel">
          <progress max={progress.total} value={progress.done} style={{ width: '100%', height: '8px' }} />
          <p>{progress.done} / {progress.total} · 成功 {progress.ok} · 失败 {progress.failed} · 空单号跳过 {statsSkipped(progress.skipped)}</p>
        </section>
      )}

      {failed.length > 0 && (
        <section className="sidebar-panel">
          <h2>异常排查</h2>
          {failed.slice(0, 10).map(row => (
            <p className="sidebar-help" key={row.id}><b>{row.number}</b>：{row.error}</p>
          ))}
        </section>
      )}

      {last && (
        <section className="sidebar-panel">
          <h2>最新查询轨迹</h2>
          <strong>{last.number} · {last.carrier}</strong>
          <p className="sidebar-help">{last.summary}</p>
          {last.events.slice(0, 5).map((e, i) => (
            <p className="sidebar-help" key={i}>{e.content}<br /><span style={{ fontSize: '11px', color: '#999' }}>{new Date(e.time).toLocaleString()}</span></p>
          ))}
        </section>
      )}

      {/* 弹窗 1：系统初始化配置（授权码配置，精准对齐截图 4） */}
      {authModalOpen && (
        <div className="sidebar-modal-backdrop" role="presentation">
          <div className="sidebar-modal" role="dialog" aria-modal="true" aria-label="系统初始化配置">
            <div className="sidebar-modal-header">
              <h2>系统初始化配置</h2>
              <button className="sidebar-modal-close" aria-label="关闭" onClick={() => setAuthModalOpen(false)}>×</button>
            </div>
            <div className="sidebar-modal-body">
              <div className="sidebar-auth-alert">
                系统尚未初始化。请输入您的飞书个人授权码 (Personal Base Token) 以连接 Bitable 数据表。
              </div>
              <label>
                个人授权码
                <input
                  type="text"
                  autoComplete="off"
                  value={code}
                  disabled={busy}
                  onChange={e => setCode(e.target.value)}
                  placeholder="请输入飞书个人授权码 (Personal Base Token)"
                />
              </label>
              <div className="sidebar-auth-guide">
                <h4>如何获取授权码？</h4>
                <ul className="sidebar-auth-steps">
                  <li><span className="sidebar-auth-step-num">1</span>点击多维表格右上角的「插件」，然后点击「自定义插件」</li>
                  <li><span className="sidebar-auth-step-num">2</span>在弹窗列表中找到当前插件并点击「获取授权码」</li>
                  <li><span className="sidebar-auth-step-num">3</span>复制生成的个人授权码并粘贴到上方输入框</li>
                </ul>
              </div>
              <div className="sidebar-modal-actions">
                <button type="button" onClick={() => setAuthModalOpen(false)}>取消</button>
                <button type="button" className="primary" disabled={!code.trim() || busy} onClick={() => void connect()}>
                  确定
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 弹窗 2：兑换码兑换（精准对齐截图 3） */}
      {couponModalOpen && (
        <div className="sidebar-modal-backdrop" role="presentation">
          <div className="sidebar-modal" role="dialog" aria-modal="true" aria-label="兑换码兑换">
            <div className="sidebar-modal-header">
              <h2>兑换码兑换</h2>
              <button className="sidebar-modal-close" aria-label="关闭" onClick={() => setCouponModalOpen(false)}>×</button>
            </div>
            <div className="sidebar-modal-body">
              <div className="sidebar-coupon-desc">
                请输入您的兑换码，系统将为您自动开通或延长对应的套餐：
              </div>
              <label>
                <span style={{ color: '#f53f3f' }}>* </span>兑换码
                <input
                  type="text"
                  value={couponCode}
                  disabled={couponBusy}
                  onChange={e => setCouponCode(e.target.value)}
                  placeholder="请输入您的兑换码..."
                />
              </label>
              {couponMessage && (
                <div className={`sidebar-coupon-msg ${couponMessage.success ? 'success' : 'error'}`}>
                  {couponMessage.text}
                </div>
              )}
              <div className="sidebar-modal-actions">
                <button type="button" onClick={() => setCouponModalOpen(false)}>取消</button>
                <button type="button" className="primary" disabled={!couponCode.trim() || couponBusy} onClick={() => void handleRedeemCoupon()}>
                  {couponBusy ? '兑换中…' : '立即兑换'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 弹窗 3：完善企业信息 */}
      {enterpriseOpen && (
        <div className="sidebar-modal-backdrop" role="presentation">
          <div className="sidebar-modal" role="dialog" aria-modal="true">
            <div className="sidebar-modal-header">
              <h2>完善企业信息</h2>
              <button className="sidebar-modal-close" onClick={() => { setEnterpriseOpen(false); setPendingPurchase(null); setPendingTrial(false); setPendingRecharge(false); }}>×</button>
            </div>
            <div className="sidebar-modal-body">
              <p className="sidebar-help">企业名称用于识别企业授权归属与开票开通，必填；企业类型可选。</p>
              <label>
                企业名称（必填）
                <input value={enterpriseName} onChange={e => setEnterpriseName(e.target.value)} maxLength={256} placeholder="如：西藏高原安生物科技有限公司" />
              </label>
              <label>
                企业类型（选填）
                <input value={enterpriseType} onChange={e => setEnterpriseType(e.target.value)} maxLength={256} placeholder="如：电商物流 / 供应链" />
              </label>
              <div className="sidebar-modal-actions">
                <button type="button" onClick={() => { setEnterpriseOpen(false); setPendingPurchase(null); setPendingTrial(false); setPendingRecharge(false); }}>取消</button>
                <button type="button" className="primary" disabled={!enterpriseName.trim() || busy || paymentBusy} onClick={() => void submitEnterprise()}>
                  {pendingPurchase ? '登记并继续支付' : pendingRecharge ? '登记并继续充值' : pendingTrial ? '登记并领取 15 次' : '提交保存'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 弹窗 4：充值续费（受控套餐列表，紧凑单屏无滚动） */}
      {rechargeOpen && (
        <div className="sidebar-modal-backdrop" role="presentation">
          <div className="sidebar-modal" role="dialog" aria-modal="true" aria-label="充值续费">
            <div className="sidebar-modal-header">
              <h2>充值续费</h2>
              <button className="sidebar-modal-close" aria-label="关闭" onClick={() => setRechargeOpen(false)}>×</button>
            </div>
            <div className="sidebar-modal-body">
              {rechargeLoading ? (
                <p className="sidebar-help">正在同步平台套餐配置…</p>
              ) : (
                <>
                  {rechargeError && (
                    <p className="sidebar-help" role="alert" style={{ color: '#d9363e' }}>
                      {rechargeError} <button type="button" onClick={() => void openRecharge()}>重试</button>
                    </p>
                  )}
                  <div className="sidebar-recharge-grid">
                    {offerEligible && (
                      <div className="sidebar-recharge-card" key="plan_trial_15" style={{ borderColor: '#52c41a', background: 'rgba(82, 196, 26, 0.05)' }}>
                        <div style={{ fontSize: '11px', color: '#52c41a', fontWeight: 'bold' }}>新企业特惠</div>
                        <strong>免费体验包</strong>
                        <span>15 次查询</span>
                        <b style={{ color: '#52c41a' }}>¥0 (免费)</b>
                        <button
                          type="button"
                          style={{ background: '#52c41a', color: '#fff', border: 'none' }}
                          onClick={() => {
                            setRechargeOpen(false);
                            void claimTrial();
                          }}
                        >
                          立即领取 15 次
                        </button>
                      </div>
                    )}
                    {rechargePlans.map(plan => (
                      <div className="sidebar-recharge-card" key={plan.plan_id}>
                        <strong>{plan.name}</strong>
                        <span>{`${(plan.quota || 0).toLocaleString()} 次查询`}</span>
                        <b>¥{plan.price}</b>
                        <button type="button" onClick={() => void startPurchase(plan)}>
                          立即购买
                        </button>
                      </div>
                    ))}
                    {!offerEligible && rechargePlans.length === 0 && <p className="sidebar-help">目前没有可购买的套餐。</p>}
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* 弹窗 5：微信真实 Native 二维码支付 */}
      {paymentPlan && (
        <div className="sidebar-modal-backdrop" role="presentation">
          <div className="sidebar-modal" role="dialog" aria-modal="true" aria-label="微信支付">
            <div className="sidebar-modal-header">
              <h2>微信支付</h2>
              <button className="sidebar-modal-close" aria-label="关闭" onClick={() => { setPaymentPlan(null); setPaymentOrder(null); }}>×</button>
            </div>
            <div className="sidebar-modal-body">
              <div className="sidebar-payment-summary">
                <span>购买套餐：</span>
                <strong>{paymentPlan.name}</strong>
                <span>订单号：</span>
                <strong style={{ fontSize: '11px', wordBreak: 'break-all' }}>{paymentOrder?.orderId || '创建中…'}</strong>
                <span>支付金额：</span>
                <b>¥{paymentPlan.price}</b>
              </div>

              {paymentBusy && <p className="sidebar-help">正在连接微信支付生成二维码…</p>}
              {paymentError && <p className="sidebar-help" role="alert" style={{ color: '#d9363e' }}>{paymentError}</p>}

              {paymentPaid ? (
                <div className="sidebar-payment-success">
                  <b>✓ 支付成功</b>
                  <span>套餐查询额度已到账，正在自动返回主页…</span>
                  <button
                    type="button"
                    className="primary"
                    style={{ marginTop: '12px' }}
                    onClick={() => {
                      setPaymentPlan(null);
                      setPaymentOrder(null);
                      setRechargeOpen(false);
                      setPaymentPaid(false);
                      void refreshBilling();
                    }}
                  >
                    返回主页
                  </button>
                </div>
              ) : (
                paymentOrder && (
                  <>
                    <div className="sidebar-payment-qr">
                      {paymentOrder.qrImage ? (
                        <img src={paymentOrder.qrImage} alt="微信支付二维码" />
                      ) : (
                        <div className="sidebar-payment-mock">模拟支付模式</div>
                      )}
                      <span>请使用微信 App 扫码完成支付</span>
                    </div>
                  </>
                )
              )}
            </div>
          </div>
        </div>
      )}

      {/* 弹窗 6：订单退款申请 */}
      {refundModalOpen && (
        <div className="sidebar-modal-backdrop" role="presentation">
          <div className="sidebar-modal" role="dialog" aria-modal="true" aria-label="退款申请">
            <div className="sidebar-modal-header">
              <h2>订单退款申请</h2>
              <button className="sidebar-modal-close" onClick={() => setRefundModalOpen(false)}>×</button>
            </div>
            <div className="sidebar-modal-body">
              <p className="sidebar-help">支持 7 天内未消费额度全额原路退款；退款成功后对应套餐额度将自动扣减。</p>
              <label>
                订单号
                <input
                  type="text"
                  value={refundOrderId}
                  disabled={refundBusy}
                  onChange={e => setRefundOrderId(e.target.value)}
                  placeholder="请输入 ORD_ 开头的订单号"
                />
              </label>
              {refundResult && (
                <p className="sidebar-help" style={{ color: refundResult.includes('成功') ? '#52c41a' : '#f53f3f' }}>
                  {refundResult}
                </p>
              )}
              <div className="sidebar-modal-actions">
                <button type="button" onClick={() => setRefundModalOpen(false)}>取消</button>
                <button type="button" className="primary" disabled={!refundOrderId.trim() || refundBusy} onClick={() => void handleRefund()}>
                  {refundBusy ? '处理中…' : '申请退款'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 弹窗 7：加入官方交流群与反馈支持（精准对齐截图 2 & 5） */}
      {feedbackModalOpen && (
        <div className="sidebar-modal-backdrop" role="presentation">
          <div className="sidebar-modal" role="dialog" aria-modal="true" aria-label="官方交流群与反馈">
            <div className="sidebar-modal-header">
              <h2>官方交流群与反馈支持</h2>
              <button className="sidebar-modal-close" onClick={() => setFeedbackModalOpen(false)}>×</button>
            </div>
            <div className="sidebar-modal-body">
              <div className="sidebar-group-box">
                <div className="sidebar-group-qr">
                  <svg viewBox="0 0 100 100" fill="#1677ff">
                    <path d="M15 15h30v30h-30z M55 15h30v30h-30z M15 55h30v30h-30z M60 60h10v10h-10z M75 60h10v10h-10z M60 75h10v10h-10z M75 75h10v10h-10z" />
                  </svg>
                </div>
                <div className="sidebar-group-info">
                  <strong>扫码加入官方交流群</strong><br />
                  💬 官方客服微信：<b>ahsz_support</b><br />
                  📮 技术支持邮箱：<b>support@ahsz.com</b><br />
                  🕒 服务时间：工作日 9:00 - 18:00
                </div>
              </div>

              <div className="sidebar-feedback-form">
                <label>
                  意见或问题反馈
                  <textarea
                    rows={3}
                    value={feedbackContent}
                    onChange={e => setFeedbackContent(e.target.value)}
                    placeholder="请描述您在使用过程中遇到的问题或改进建议…"
                  />
                </label>
                <label>
                  联系方式（手机号/邮箱/飞书，选填）
                  <input
                    type="text"
                    value={feedbackContact}
                    onChange={e => setFeedbackContact(e.target.value)}
                    placeholder="以便工作人员快速回复您"
                  />
                </label>
              </div>

              {feedbackSuccess && (
                <p className="sidebar-help" style={{ color: '#52c41a', textAlign: 'center' }}>
                  ✓ 反馈已收到，工作人员将在工作时间内及时处理！
                </p>
              )}

              <div className="sidebar-modal-actions">
                <button type="button" onClick={() => setFeedbackModalOpen(false)}>关闭</button>
                <button type="button" className="primary" disabled={!feedbackContent.trim() || feedbackBusy} onClick={() => void submitFeedback()}>
                  {feedbackBusy ? '提交中…' : '提交反馈'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 弹窗 8：免费试用领取提示 */}
      {trialOfferOpen && (
        <div className="sidebar-modal-backdrop" role="presentation">
          <div className="sidebar-modal" role="dialog" aria-modal="true">
            <div className="sidebar-modal-header">
              <h2>领取免费试用套餐</h2>
              <button className="sidebar-modal-close" onClick={() => {
                setTrialOfferOpen(false);
              }}>×</button>
            </div>
            <div className="sidebar-modal-body">
              <p className="sidebar-help">
                {isEnterpriseFilled
                  ? `检测到当前企业已登记（${enterprise?.name}），新企业可免费领取 15 次物流轨迹查询额度。是否现在开通？`
                  : '新企业/团队可免费领取 15 次物流轨迹查询额度。是否现在开通？'}
              </p>
              <div className="sidebar-modal-actions">
                <button type="button" onClick={() => {
                  setTrialOfferOpen(false);
                }}>
                  暂不领取
                </button>
                <button type="button" className="primary" onClick={() => {
                  setTrialOfferOpen(false);
                  void claimTrial();
                }}>
                  立即领取 15 次
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function statsSkipped(skipped: number): string {
  return `${skipped}`;
}
