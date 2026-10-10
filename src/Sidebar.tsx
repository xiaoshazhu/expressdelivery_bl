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

async function post<T>(route: string, body: unknown, token = '', timeoutMs = 30000, externalSignal?: AbortSignal): Promise<T> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  const abort = () => controller.abort();
  if (externalSignal?.aborted) abort();
  else externalSignal?.addEventListener('abort', abort, { once: true });
  let response: Response;
  try {
    response = await fetch(apiUrl(`/api/${route}`), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (error) {
    if (controller.signal.aborted) throw new Error('连接超时，请检查宝塔 Node 项目是否运行，再重试');
    throw error;
  } finally {
    window.clearTimeout(timer);
    externalSignal?.removeEventListener('abort', abort);
  }
  let value: any;
  try { value = await response.json(); }
  catch { throw new Error(`服务器返回异常（HTTP ${response.status}），请检查 Node 项目日志`); }
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
const authCodeKey = (tenant: string, baseId: string) => `express-sidebar:auth:${tenant}:${baseId}`;
type FieldNameKey = 'number' | 'phone' | 'info';
const DEFAULT_FIELD_NAMES: Record<FieldNameKey, string> = {
  number: '快递单号', phone: '核验手机号', info: '快递信息',
};
const FIELD_ALIASES: Record<FieldNameKey, string[]> = {
  number: ['快递单号', '运单号'], phone: ['核验手机号', '手机号码', '手机号'],
  info: ['快递信息', '物流查询结果', '物流信息'],
};
function matchField(fields: Field[], key: FieldNameKey): Field | undefined {
  return FIELD_ALIASES[key].map(name => fields.find(field => field.name === name && field.type === 1)).find(Boolean);
}
function mappingFromFields(fields: Field[]): Mapping {
  return {
    number: matchField(fields, 'number')?.id || '', info: matchField(fields, 'info')?.id || '',
    phone: matchField(fields, 'phone')?.id || '',
  };
}

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

  // 模态弹窗状态
  const [authModalOpen, setAuthModalOpen] = useState(false);
  const [authError, setAuthError] = useState('');
  const [helpOpen, setHelpOpen] = useState(false);
  const [couponModalOpen, setCouponModalOpen] = useState(false);
  const [couponCode, setCouponCode] = useState('');
  const [couponBusy, setCouponBusy] = useState(false);
  const [couponMessage, setCouponMessage] = useState<{ text: string; success: boolean } | null>(null);

  const [trialOfferOpen, setTrialOfferOpen] = useState(false);
  const [enterpriseOpen, setEnterpriseOpen] = useState(false);
  const [enterpriseName, setEnterpriseName] = useState('');
  const [enterpriseType, setEnterpriseType] = useState('');
  const [enterpriseError, setEnterpriseError] = useState('');
  const [offerEligible, setOfferEligible] = useState(false);
  const [pendingTrial, setPendingTrial] = useState(false);

  const [rechargeOpen, setRechargeOpen] = useState(false);
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
  const authAttempt = useRef(0);
  const authRequest = useRef<AbortController | null>(null);
  const closeAuth = () => {
    authAttempt.current++;
    authRequest.current?.abort();
    authRequest.current = null;
    setAuthModalOpen(false);
    setCode('');
    setAuthError('');
  };
  const openAuth = () => {
    setCode('');
    setAuthError('');
    setAuthModalOpen(true);
  };
  const [mapping, setMapping] = useState<Mapping>({ number: '', info: '' });
  const [knownFields, setKnownFields] = useState<Field[]>([]);
  const [fieldNames, setFieldNames] = useState(DEFAULT_FIELD_NAMES);
  const [fieldsOpen, setFieldsOpen] = useState(true);
  const [initialized, setInitialized] = useState(false);
  const [queryScope, setQueryScope] = useState<'current' | 'empty' | 'all'>('current');
  const [previewRows, setPreviewRows] = useState<Row[] | null>(null);
  const [previewError, setPreviewError] = useState('');
  const [previewNonce, setPreviewNonce] = useState(0);
  const [trialPanelOpen, setTrialPanelOpen] = useState(true);
  const [carrier, setCarrier] = useState('自动识别');
  const [autoQuery, setAutoQuery] = useState(false);
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

  const openOfficialGroup = () => {
    try {
      const target = new URL(groupUrl);
      if (target.protocol === 'https:' || target.protocol === 'http:') {
        window.open(target.href, '_blank', 'noopener,noreferrer');
        return;
      }
    } catch { /* The group link has not been configured yet. */ }
    setMessage('官方交流群暂未配置，请稍后再试');
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
        setKnownFields([]);
        setFieldNames(DEFAULT_FIELD_NAMES);
        setInitialized(false);
        setPreviewRows(null);
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
        void table.getFieldMetaList().then(items => {
          if (disposed || request !== sequence || credential.current) return;
          const existingFields: Field[] = items.map(field => ({ id: field.id, name: field.name, type: Number(field.type) }));
          setKnownFields(existingFields);
          setMapping(mappingFromFields(existingFields));
          setFieldNames(Object.fromEntries((Object.keys(DEFAULT_FIELD_NAMES) as FieldNameKey[])
            .map(key => [key, matchField(existingFields, key)?.name || DEFAULT_FIELD_NAMES[key]])) as Record<FieldNameKey, string>);
        }).catch(() => { /* 授权前无法读取字段时，连接成功后由服务端同步。 */ });
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
      }
      const license = licRes?.license;
      if (license) setBilling(license);
      const eligible = Boolean(license && license.trialClaimed === false);
      setOfferEligible(eligible);
      if (eligible && session && !hasSeenTrialOffer(trustedTenant)) {
        markTrialOfferSeen(trustedTenant);
        setTrialOfferOpen(true);
      }
    });
    return () => { disposed = true; };
  }, [tenantKey, session?.token]);

  // 每个企业与多维表格只录入一次授权码，切换表格时自动重建短期会话。
  useEffect(() => {
    if (!embedded || !context || !tenantKey || session || busy) return;
    let saved = '';
    try { saved = window.localStorage.getItem(authCodeKey(tenantKey, context.baseId)) || ''; } catch { /* Storage may be unavailable. */ }
    if (saved) void connect(saved);
    else setAuthModalOpen(true);
  }, [embedded, context?.baseId, context?.tableId, tenantKey, session?.token]);

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

    const schedule = (recordId: string, delay = 1200) => {
      if (!recordId || disposed) return;
      const old = timers.get(recordId);
      if (old) window.clearTimeout(old);
      timers.set(recordId, window.setTimeout(() => void execute(recordId), delay));
    };

    import('@lark-base-open/js-sdk').then(async ({ bitable }) => {
      const table = await bitable.base.getTableById(context.tableId);
      if (disposed) return;
      off.push(table.onRecordAdd(event => event.data.forEach(recordId => schedule(recordId))));
      off.push(table.onRecordModify(event => {
        const watched = new Set([mapping.number, mapping.phone, mapping.carrier].filter(Boolean));
        if (event.data.fieldIds.some(fieldId => watched.has(fieldId))) schedule(event.data.recordId);
      }));
      void post<{ rows: Row[] }>('base/rows', { mapping }, session.token)
        .then(({ rows }) => {
          if (!disposed) rows.filter(row => row.number.trim() && !row.info.trim())
            .forEach((row, index) => schedule(row.id, 1200 + index * 650));
        })
        .catch(error => { if (!disposed) setMessage(`自动扫描失败：${error instanceof Error ? error.message : '读取记录失败'}`); });
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
      setAuthError('请输入飞书个人授权码');
      return;
    }
    if (lock.current) return;
    const attempt = ++authAttempt.current;
    const request = new AbortController();
    authRequest.current = request;
    lock.current = true;
    setBusy(true);
    setAuthError('');
    const version = revision.current;
    try {
      const current = active.current;
      if (!current) throw new Error('请先选择数据表');
      const result = await post<Session>('connect', {
        mode: 'feishu',
        appToken: current.baseId,
        tableId: current.tableId,
        tenantKey: currentTenant(),
        personalBaseToken: targetCode,
      }, '', 18000, request.signal);
      if (version !== revision.current || attempt !== authAttempt.current) {
        await post('disconnect', {}, result.token);
        return;
      }
      credential.current = result;
      setSession(result);
      setKnownFields(result.fields);
      try { window.localStorage.setItem(authCodeKey(currentTenant(), current.baseId), targetCode); } catch { /* Storage may be unavailable. */ }
      closeAuth();
      setMapping(mappingFromFields(result.fields));
      setInitialized(false);
      setFieldNames(Object.fromEntries((Object.keys(DEFAULT_FIELD_NAMES) as FieldNameKey[])
        .map(key => [key, matchField(result.fields, key)?.name || DEFAULT_FIELD_NAMES[key]])) as Record<FieldNameKey, string>);
      setFieldsOpen(!mappingFromFields(result.fields).number || !mappingFromFields(result.fields).info);
      setMessage('已完成授权配置并连接数据表！');
      if (offerEligible && !hasSeenTrialOffer(currentTenant())) {
        markTrialOfferSeen(currentTenant());
        setTrialOfferOpen(true);
      }
      void refreshBilling();
    } catch (error) {
      if (attempt !== authAttempt.current) return;
      const detail = error instanceof Error ? error.message : '授权码验证失败';
      if (tokenValue !== undefined && tokenValue !== code) {
        try { window.localStorage.removeItem(authCodeKey(currentTenant(), active.current?.baseId || '')); } catch { /* Storage may be unavailable. */ }
      }
      setAuthError(detail);
      setAuthModalOpen(true);
      setMessage(`授权连接失败：${detail}`);
    } finally {
      if (authRequest.current === request) authRequest.current = null;
      lock.current = false;
      setBusy(false);
    }
  }

  // 领取试用套餐
  async function enterpriseForAction(tenant: string): Promise<EnterpriseStatus> {
    const response = await fetch(apiUrl(`/api/enterprise/status?tenant=${encodeURIComponent(tenant)}`));
    const value = await response.json();
    if (!response.ok) throw new Error(value.error?.message || '检查企业信息失败，请重试');
    setEnterprise(value);
    return value;
  }

  function showEnterpriseForm(action: 'trial' | 'purchase', plan?: RechargePlan) {
    setEnterpriseName('');
    setEnterpriseType('');
    setEnterpriseError('');
    setPendingTrial(action === 'trial');
    setPendingPurchase(action === 'purchase' ? plan || null : null);
    setEnterpriseOpen(true);
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
      catch (error) { setMessage(error instanceof Error ? error.message : '查询企业信息失败'); return; }
      if (!registeredEnterprise.registered || !registeredEnterprise.name?.trim() || registeredEnterprise.name === '-') {
        showEnterpriseForm('trial');
        return;
      }
    }
    const resolvedName = (registeredNow ? enterpriseName : registeredEnterprise?.name || '').trim();
    if (!resolvedName) { setMessage('请填写企业名称后领取'); return; }
    await act(async () => {
      const value = await post<BillingStatus & { registered?: boolean; enterprise?: EnterpriseStatus }>('billing/claim-trial', {
        tenantKey: trustedTenant,
        enterpriseName: resolvedName,
        enterpriseType: registeredNow ? enterpriseType.trim() : registeredEnterprise?.enterpriseType || '',
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
  async function openRecharge() {
    const key = currentTenant();
    if (!key) { setMessage('未获取到当前租户标识'); return; }
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
    if (!skipEnterpriseCheck) {
      let registeredEnterprise: EnterpriseStatus;
      try { registeredEnterprise = await enterpriseForAction(key); }
      catch (error) { setMessage(error instanceof Error ? error.message : '查询企业信息失败'); return; }
      if (!registeredEnterprise.registered || !registeredEnterprise.name?.trim() || registeredEnterprise.name === '-') {
        showEnterpriseForm('purchase', plan);
        return;
      }
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
      setEnterpriseError('请输入有效的企业名称');
      return;
    }
    setPaymentBusy(true);
    setMessage('');
    setEnterpriseError('');
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
      } else {
        setMessage('企业信息保存成功！');
      }
    } catch (error) {
      setEnterpriseError(error instanceof Error ? error.message : '登记企业失败');
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
      const result = await post<{ mapping: Mapping; fields: Field[] }>('base/initialize', { fieldNames }, session.token);
      if (version !== revision.current) return;
      setMapping(result.mapping);
      setKnownFields(result.fields);
      setFieldsOpen(false);
      setInitialized(true);
      setPreviewNonce(value => value + 1);
      const next = { ...session, fields: result.fields };
      credential.current = next;
      setSession(next);
      setMessage('表格结构已初始化：已有字段直接复用，缺少的字段已创建。');
    });
  }

  function skipInitialize() {
    const fields = session?.fields || knownFields;
    const next = Object.fromEntries((Object.keys(fieldNames) as FieldNameKey[]).map(key => [
      key, fields.find(field => field.name === fieldNames[key].trim() && field.type === 1)?.id || '',
    ])) as Mapping;
    setMapping(next);
    setFieldsOpen(false);
    setInitialized(false);
    setMessage(next.number && next.info ? '已匹配现有字段，可以开始查询。' : '未找到单号或信息文本字段，请展开字段配置并初始化表格。');
  }

  // 执行查询
  const targetsForScope = (rows: Row[], scope: 'current' | 'empty' | 'all', selectedId: string | null) =>
    scope === 'current' ? rows.filter(row => row.id === selectedId) : scope === 'empty' ? rows.filter(row => !row.info.trim()) : rows;

  useEffect(() => {
    if (!session || !mapping.number || !mapping.info || mapping.number === mapping.info) {
      setPreviewRows(null);
      setPreviewError('');
      return;
    }
    let disposed = false;
    setPreviewRows(null);
    post<{ rows: Row[] }>('base/rows', { mapping }, session.token).then(result => {
      if (!disposed) { setPreviewRows(result.rows); setPreviewError(''); }
    }).catch(error => {
      if (!disposed) setPreviewError(error instanceof Error ? error.message : '读取记录失败');
    });
    return () => { disposed = true; };
  }, [session?.token, mapping.number, mapping.phone, mapping.info, mapping.carrier, mapping.time, previewNonce]);

  async function query(scope: 'current' | 'empty' | 'all') {
    await act(async version => {
      if (!session) return;
      cancelled.current = false;
      setLast(null);
      setMessage('正在读取当前数据表中的记录…');
      const { rows } = await post<{ rows: Row[] }>('base/rows', { mapping }, session.token);
      if (version !== revision.current) return;
      const currentId = active.current?.recordId;
      const targets = targetsForScope(rows, scope, currentId || null);
      if (!targets.length) throw new Error(scope === 'current' ? '请先在飞书表格中点击需要查询的那一行。' : '没有可查询的记录。');
      const requiredQuota = targets.filter(row => row.number.trim()).length;
      if (billing?.billingType === 'quota' && (billing.remainingQuota ?? 0) < requiredQuota) throw new Error(`当前额度不足：本次需要 ${requiredQuota} 次，剩余 ${billing.remainingQuota ?? 0} 次。请先领取体验额度或充值。`);
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
      setPreviewNonce(value => value + 1);
    });
  }

  const ready = !!session && !!mapping.number && !!mapping.info && mapping.number !== mapping.info && !busy;
  const previewTargets = previewRows ? targetsForScope(previewRows, queryScope, context?.recordId || null) : [];
  const requiredQuota = previewTargets.filter(row => row.number.trim()).length;
  const quotaInsufficient = billing?.billingType === 'quota' && requiredQuota > (billing.remainingQuota ?? 0);

  return (
    <div className="sidebar-app">
      <header className="sidebar-topbar">
        <span className="sidebar-topbar-icon" aria-hidden="true">▦</span>
        <strong>运单助手</strong>
        <button type="button" onClick={() => setHelpOpen(true)}>使用教程</button>
      </header>
      <main className="sidebar-content">
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
            <button type="button" className="btn-auth-config" onClick={openAuth}>
              授权码配置
            </button>
            <button type="button" className="btn-recharge" onClick={() => void openRecharge()}>
              充值续费
            </button>
            <button type="button" className="btn-coupon" onClick={() => setCouponModalOpen(true)}>
              兑换码
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

        <div className="sidebar-trial-fold">
          <button type="button" className="sidebar-trial-toggle" onClick={() => setTrialPanelOpen(value => !value)}>
            <span>免费体验额度{billing?.trialClaimed ? '（已领取）' : ''}</span><span>{trialPanelOpen ? '▲' : '▼'}</span>
          </button>
          {trialPanelOpen && <div className="sidebar-trial-content">
            <p>每个企业限领 15 次，免费使用。</p>
            <button type="button" className="primary" disabled={!offerEligible} onClick={() => { setEnterpriseName(''); setTrialOfferOpen(true); }}>
              {billing?.trialClaimed ? '已领取' : '获取体验额度'}
            </button>
          </div>}
        </div>
      </section>

      {/* 温馨提示 */}
      <section className="sidebar-tips-card" aria-label="温馨提示">
        <div className="sidebar-tips-heading">
          <div className="sidebar-tips-title">温馨提示</div>
          <details className="sidebar-tips-more">
            <summary aria-label="其他注意事项">?</summary>
            <ol>
              <li>切换数据表后，请重新打开插件页面</li>
              <li>查询将消耗套餐次数（1 条单号 = 1 次）</li>
              <li>批量查询只针对尚无结果的数据行</li>
            </ol>
          </details>
        </div>
        <p className="sidebar-tips-text"><strong>顺丰、跨越、中通等平台必须填写手机号码</strong>（收／寄件人手机号或后四位），否则接口会返回查询失败并退回额度。</p>
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
          <section className="sidebar-panel sidebar-config-card">
            <div className="sidebar-section-heading">
              <h2>批量配置</h2>
              <span className={ready ? 'sidebar-status ready' : 'sidebar-status'}>{session ? (mapping.number && mapping.info ? '已就绪' : '待初始化表格') : '待授权'}</span>
            </div>
            <p className="sidebar-help">当前数据表：{context?.name || '等待飞书连接…'}。系统按单号自动识别快递公司，需要手机号核验时读取对应字段。</p>
            {!session && <div className="sidebar-auth-needed">
              <p>尚未完成授权码配置，暂不能配置字段与查询。</p>
              <button type="button" className="primary" onClick={openAuth}>去配置授权码</button>
            </div>}
            <div className={session ? 'sidebar-field-box' : 'sidebar-field-box disabled'}>
              <button type="button" className="sidebar-field-toggle" disabled={!session} onClick={() => setFieldsOpen(value => !value)}>
                <span>✎　初始化表格结构</span>
                <span className={mapping.number && mapping.info ? 'sidebar-status ready' : 'sidebar-status'}>{mapping.number && mapping.info ? (initialized ? '已初始化' : '已匹配') : '未初始化'}</span>
                <span>{fieldsOpen ? '▲' : '▼'}</span>
              </button>
              {fieldsOpen ? <div className="sidebar-field-body">
                <p className="sidebar-help">已读取当前表格的 {knownFields.length} 个字段。已有同名文本字段直接复用，缺少的字段才会创建，不覆盖数据。</p>
                {knownFields.length > 0 && <p className="sidebar-known-fields">现有字段：{knownFields.map(field => field.name).join('、')}</p>}
                {([
                  ['number', '快递单号字段名称（必填）'],
                  ['phone', '核验手机号字段名称（顺丰／跨越等必填）'],
                  ['info', '快递信息字段名称'],
                ] as [FieldNameKey, string][]).map(([key, label]) => (
                  <label key={key}>{label}
                    <input value={fieldNames[key]} disabled={!session || busy} onChange={e => setFieldNames(previous => ({ ...previous, [key]: e.target.value }))} />
                  </label>
                ))}
                <div className="sidebar-field-actions">
                  <button type="button" className="primary" disabled={!session || busy} onClick={() => void initialize()}>{busy ? '正在处理…' : '初始化表格结构'}</button>
                  <button type="button" disabled={!session || busy} onClick={skipInitialize}>跳过</button>
                </div>
                <p className="sidebar-help">如果现有字段名称不同，可修改上方名称后点“跳过”直接匹配。</p>
              </div> : <p className="sidebar-field-summary">已按【{(['number', 'phone', 'info'] as FieldNameKey[]).filter(key => Boolean(mapping[key])).map(key => fieldNames[key]).join(' / ') || '尚未匹配字段'}】建立字段，点击展开可修改字段名称或重新初始化。</p>}
            </div>
            {session && <button type="button" className="sidebar-disconnect" disabled={busy} onClick={() => act(async () => {
              await post('disconnect', {}, session.token);
              credential.current = null;
              setSession(null);
              if (context) try { window.localStorage.removeItem(authCodeKey(currentTenant(), context.baseId)); } catch { /* Storage may be unavailable. */ }
              setMessage('已清除当前表格授权连接。');
            })}>断开并清除授权</button>}
          </section>

          <section className="sidebar-panel sidebar-query-card">
            <h2>批量查询</h2>
            <div className="sidebar-segmented" role="group" aria-label="查询触发模式">
              <button type="button" className={!autoQuery ? 'selected' : ''} onClick={() => setAutoQuery(false)}>手动触发</button>
              <button type="button" className={autoQuery ? 'selected' : ''} disabled={!ready} onClick={() => setAutoQuery(true)}>自动触发</button>
            </div>
            <p className="sidebar-help">{autoQuery ? '边栏打开期间，新增或修改的记录会在单号变化后自动查询并写回。' : '选择查询范围后手动触发，查询结果会写回当前表格。'}</p>
            {!ready && <p className="sidebar-help">请先完成授权码配置与表格字段匹配。</p>}
            {ready && !autoQuery && <>
              <div className="sidebar-query-scopes">
                <label><input type="radio" name="query-scope" checked={queryScope === 'current'} onChange={() => setQueryScope('current')} />当前选中记录 <span>{previewRows ? previewRows.filter(row => row.id === context?.recordId).length : '…'} 条</span></label>
                <label><input type="radio" name="query-scope" checked={queryScope === 'empty'} onChange={() => setQueryScope('empty')} />仅无结果的记录 <span>{previewRows ? previewRows.filter(row => !row.info.trim()).length : '…'} 条</span></label>
                <label><input type="radio" name="query-scope" checked={queryScope === 'all'} onChange={() => setQueryScope('all')} />当前数据表全部记录 <span>{previewRows ? previewRows.length : '…'} 条</span></label>
              </div>
              {previewError && <p className="sidebar-help" role="alert">记录预览失败：{previewError}</p>}
              {queryScope === 'current' && !context?.recordId && <p className="sidebar-help">请点击要查询的行内任意单元格。</p>}
              <div className="sidebar-query-cost">本次消耗 {requiredQuota} 次 <span>查询后剩余 {billing?.remainingQuota === null ? '不限' : Math.max(0, (billing?.remainingQuota ?? 0) - requiredQuota)} 次</span></div>
              {quotaInsufficient && <p className="sidebar-quota-warning">当前额度 {billing?.remainingQuota ?? 0} 次，本次需要 {requiredQuota} 次，请先领取体验额度或充值。</p>}
              <button type="button" className="primary sidebar-run-query" disabled={!ready || !previewRows || requiredQuota === 0 || quotaInsufficient || (queryScope === 'current' && !context?.recordId)} onClick={() => void query(queryScope)}>开始查询 {requiredQuota} 条</button>
            </>}
            {autoQuery && ready && <div className="sidebar-auto-status">自动触发已开启 · 等待表格记录变化<button type="button" onClick={() => setAutoQuery(false)}>暂停自动查询</button></div>}
            {busy && <button type="button" className="sidebar-stop-query" onClick={() => { cancelled.current = true; }}>停止后续查询</button>}
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

      {/* 所有操作状态和错误都可见，避免用户误以为按钮无响应。 */}
      {message && (
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

      </main>

      {/* 弹窗 1：系统初始化配置（授权码配置） */}
      {authModalOpen && (
        <div className="sidebar-modal-backdrop" role="presentation">
          <div className="sidebar-modal sidebar-auth-modal" role="dialog" aria-modal="true" aria-label="系统初始化配置">
            <div className="sidebar-modal-header">
              <h2>系统初始化配置</h2>
              <button className="sidebar-modal-close" aria-label="关闭" onClick={closeAuth}>×</button>
            </div>
            <div className="sidebar-modal-body">
              <div className="sidebar-auth-alert">
                首次使用请输入飞书多维表格授权码，验证后保存在当前浏览器中，并按企业和多维表格区分；下次自动连接。
              </div>
              <label>
                个人授权码
                <input
                  type="password"
                  autoComplete="off"
                  value={code}
                  disabled={busy}
                  onChange={e => setCode(e.target.value)}
                  placeholder="请输入飞书个人授权码 (Personal Base Token)"
                />
              </label>
              {authError && <div className="sidebar-auth-error" role="alert">{authError}</div>}
              {busy && <div className="sidebar-auth-loading" role="status">正在验证授权码并读取当前表格字段，请稍候…</div>}
              <div className="sidebar-auth-guide">
                <h4>如何获取授权码？</h4>
                <ol className="sidebar-auth-steps">
                  {[
                    ['第一步', '点击多维表格右上角的拼图图标，选择底部「自定义插件」'],
                    ['第二步', '点击上方「获取授权码」'],
                    ['第三步', '勾选「启用授权码」'],
                    ['第四步', '点击「复制」，再粘贴到上方输入框'],
                  ].map(([step, description], index) => (
                    <li className="sidebar-auth-step" key={step}>
                      <div className="sidebar-auth-step-title">
                        <span className="sidebar-auth-step-num">{index + 1}</span>
                        <span>{description}</span>
                      </div>
                      <img src={`${import.meta.env.BASE_URL}guide/auth-step-${index + 1}.png`} alt={`${step}：${description}`} loading="lazy" />
                    </li>
                  ))}
                </ol>
              </div>
            </div>
            <div className="sidebar-modal-actions">
              <button type="button" onClick={closeAuth}>取消</button>
              <button type="button" className="primary" disabled={!code.trim() || busy} onClick={() => void connect()}>
                {busy ? '正在连接…' : '确定'}
              </button>
            </div>
          </div>
        </div>
      )}

      {helpOpen && <div className="sidebar-modal-backdrop" role="presentation">
        <div className="sidebar-modal sidebar-help-modal" role="dialog" aria-modal="true" aria-label="使用教程">
          <div className="sidebar-modal-header"><h2>使用教程</h2><button className="sidebar-modal-close" aria-label="关闭" onClick={() => setHelpOpen(false)}>×</button></div>
          <div className="sidebar-modal-body">
            <a className="sidebar-help-gif-link" href={`${import.meta.env.BASE_URL}guide/sidebar-workflow.gif`} target="_blank" rel="noopener noreferrer" aria-label="查看原尺寸使用教程动图">
              <img className="sidebar-help-gif" src={`${import.meta.env.BASE_URL}guide/sidebar-workflow.gif`} alt="运单助手使用流程动图" />
            </a>
            <p className="sidebar-help-gif-hint">点击动图可查看原尺寸。</p>
          </div>
          <div className="sidebar-modal-actions"><button type="button" onClick={() => setHelpOpen(false)}>关闭</button></div>
        </div>
      </div>}

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
              <button className="sidebar-modal-close" onClick={() => { setEnterpriseOpen(false); setPendingPurchase(null); setPendingTrial(false); }}>×</button>
            </div>
            <div className="sidebar-modal-body">
              <p className="sidebar-help">企业名称用于识别企业授权归属与开票开通，必填；企业类型可选。</p>
              <label>
                企业名称（必填）
                <input value={enterpriseName} onChange={e => setEnterpriseName(e.target.value)} maxLength={256} />
              </label>
              <label>
                企业类型（选填）
                <input value={enterpriseType} onChange={e => setEnterpriseType(e.target.value)} maxLength={256} placeholder="如：电商物流 / 供应链" />
              </label>
              {enterpriseError && <p className="sidebar-quota-warning" role="alert">{enterpriseError}</p>}
              <div className="sidebar-modal-actions">
                <button type="button" onClick={() => { setEnterpriseOpen(false); setPendingPurchase(null); setPendingTrial(false); }}>取消</button>
                <button type="button" className="primary" disabled={!enterpriseName.trim() || busy || paymentBusy} onClick={() => void submitEnterprise()}>
                  {pendingPurchase ? '登记并继续支付' : pendingTrial ? '登记并领取 15 次' : '提交保存'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 弹窗 4：充值续费（受控套餐列表，紧凑单屏无滚动） */}
      {rechargeOpen && !enterpriseOpen && (
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
              <h2>领取 15 次体验额度</h2>
              <button className="sidebar-modal-close" onClick={() => {
                setTrialOfferOpen(false);
                setEnterpriseName('');
              }}>×</button>
            </div>
            <div className="sidebar-modal-body">
              <p className="sidebar-help">每个企业限领一次，即时到账，用完不自动扣费。是否领取 15 次免费查询额度？</p>
              <div className="sidebar-modal-actions">
                <button type="button" onClick={() => {
                  setTrialOfferOpen(false);
                  setEnterpriseName('');
                }}>
                  暂不领取
                </button>
                <button type="button" className="primary" disabled={busy} onClick={() => { setTrialOfferOpen(false); void claimTrial(); }}>
                  确认领取
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
