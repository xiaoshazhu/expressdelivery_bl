import { useRef, useState } from 'react';
import type { Field, Mapping, QueryResult, Row } from './types';

const seed: Row[] = [
  { id: 'demo1', number: 'JD002938475610', carrier: '京东', info: '' },
  { id: 'demo2', number: 'SF1392847562010', carrier: '顺丰', info: '' },
  { id: 'demo3', number: '9892837465102', carrier: '邮政', info: '' },
  { id: 'demo4', number: 'ANE938475610', carrier: '安能', info: '' },
  { id: 'demo5', number: 'KYE938475610', carrier: '跨越', info: '' },
  { id: 'demo6', number: 'HLL938475610', carrier: '货拉拉', info: '货拉拉 · 请联系司机确认送达时间' },
];
const carriers = ['自动识别', '京东', '邮政', '安能', '跨越', '顺丰', '货拉拉'];
type Session = { token: string; mode: 'demo' | 'feishu'; expiresAt: number; fields: Field[] };
const API_BASE = String(import.meta.env.VITE_API_BASE_URL || '').replace(/\/+$/, '');
const apiUrl = (path: string) => `${API_BASE}${path}`;
async function api<T>(route: string, data: unknown, token = ''): Promise<T> {
  const response = await fetch(apiUrl(`/api/${route}`), { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(data), signal: AbortSignal.timeout(30000) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error?.message || '请求失败');
  return result;
}
export default function App() {
  const [mode, setMode] = useState<'demo' | 'feishu'>('demo');
  const [session, setSession] = useState<Session | null>(null);
  const [appToken, setAppToken] = useState(''); const [tableId, setTableId] = useState(''); const [code, setCode] = useState('');
  const [fields, setFields] = useState<Field[]>([]); const [mapping, setMapping] = useState<Mapping>({ number: '', info: '' });
  const [rows, setRows] = useState<Row[]>([]); const [carrier, setCarrier] = useState('自动识别');
  const [busy, setBusy] = useState(false); const lock = useRef(false); const stop = useRef(false);
  const [notice, setNotice] = useState('选择演示模式即可体验。真实飞书模式使用你在自定义插件中复制的授权码。');
  const [progress, setProgress] = useState({ done: 0, total: 0, ok: 0, fail: 0, skipped: 0 });
  const [selected, setSelected] = useState<QueryResult | null>(null);
  const [page, setPage] = useState(0); const [workflow, setWorkflow] = useState(false);
  const update = (id: string, patch: Partial<Row>) => setRows(old => old.map(r => r.id === id ? { ...r, ...patch } : r));
  async function action(task: () => Promise<void>) {
    if (lock.current) return;
    lock.current = true; setBusy(true);
    try { await task(); } catch (error) { setNotice(error instanceof Error ? error.message : '操作失败'); }
    finally { lock.current = false; setBusy(false); }
  }
  async function connect() {
    await action(async () => {
      const result = await api<Session>('connect', { mode, appToken: appToken.trim(), tableId: tableId.trim(), personalBaseToken: code.trim() });
      setSession(result); setCode(''); setFields(result.fields); setMapping({ number: '', info: '' }); setRows(mode === 'demo' ? seed.map(r => ({ ...r })) : []); setPage(0);
      setNotice(mode === 'demo' ? '演示已就绪，所有轨迹均为模拟数据。可直接点击本行查询或一键查询。' : '飞书授权已验证。请初始化字段或选择已有的两个文本字段。当前快递接口仍为模拟模式。');
    });
  }
  async function initialize() {
    await action(async () => {
      if (!session) return;
      if (session.mode === 'demo') { setRows(seed.map(r => ({ ...r }))); setSelected(null); setProgress({ done: 0, total: 0, ok: 0, fail: 0, skipped: 0 }); setNotice('已恢复 6 条演示运单。示例单号并非真实物流单。'); return; }
      const data = await api<{ fields: Field[]; mapping: Mapping }>('base/initialize', {}, session.token);
      setFields(data.fields); setMapping(data.mapping);
      const result = await api<{ rows: Row[] }>('base/rows', { mapping: data.mapping }, session.token);
      setRows(result.rows); setPage(0); setNotice('已创建或复用「快递单号」「快递信息」。第三列原生按钮请按工作流说明配置。');
    });
  }
  async function reload() {
    await action(async () => {
      if (!session) return;
      const result = await api<{ rows: Row[] }>('base/rows', { mapping }, session.token);
      setRows(result.rows); setPage(0); setNotice(`已加载当前数据表中授权可读的 ${result.rows.length} 行，包含当前视图筛选隐藏的记录。`);
    });
  }
  async function run(targetRows: Row[]) {
    await action(async () => {
      if (!session) throw new Error('请先连接');
      stop.current = false;
      let ok = 0, fail = 0, skipped = 0, done = 0;
      setProgress({ total: targetRows.length, done, ok, fail, skipped });
      setNotice('正在查询；只有查询成功的记录才会更新快递信息。');
      for (const row of targetRows) {
        if (stop.current) break;
        if (!row.number.trim()) { skipped++; done++; }
        else {
          update(row.id, { state: 'loading', error: '' });
          try {
            const chosen = row.carrier || carrier;
            const result = await api<QueryResult & { resultText: string }>(session.mode === 'demo' ? 'query' : 'base/query-record', session.mode === 'demo' ? { number: row.number, carrier: chosen } : { recordId: row.id, mapping, carrier: chosen }, session.token);
            update(row.id, { info: result.resultText, state: 'success', error: '' }); setSelected(result); ok++;
          } catch (error) { update(row.id, { state: 'error', error: error instanceof Error ? error.message : '查询失败' }); fail++; }
          done++;
          // 平滑发起请求，避免一键批量瞬时冲击服务商；取消不回滚已完成写入。
          if (done < targetRows.length) await new Promise(resolve => setTimeout(resolve, 550));
        }
        setProgress({ total: targetRows.length, done, ok, fail, skipped });
      }
      setNotice(`${stop.current ? '已停止后续查询' : '本次查询完成'}：成功 ${ok}，失败 ${fail}，空单号跳过 ${skipped}。${session.mode === 'feishu' ? '成功项已写回飞书。' : ''}`);
    });
  }
  const successes = rows.filter(r => r.state === 'success').length;
  const failures = rows.filter(r => r.state === 'error').length;
  const visible = rows.slice(page * 20, (page + 1) * 20);
  return <div className="app-shell">
    <header><div className="brand-icon">↗</div><div><h1>运单助手 <span>DEMO</span></h1><p>多维表格 · 快递查询边栏插件</p></div><span className="connection"><i className={session ? 'on' : ''} />{session ? '已连接' : '未连接'}</span></header>
    <div className="demo-banner"><b>模拟轨迹环境</b><span>已接入飞书官方前后端 SDK；真实物流服务待接入。</span></div>
    <main>
      <section className="config card">
        <div className="section-heading"><div><small>01 / CONNECT</small><h2>连接与配置</h2></div><span className="tag">无需企业自建应用</span></div>
        <div className="segmented"><button disabled={!!session || busy} className={mode === 'demo' ? 'active' : ''} onClick={() => setMode('demo')}>演示数据</button><button disabled={!!session || busy} className={mode === 'feishu' ? 'active' : ''} onClick={() => setMode('feishu')}>飞书多维表格</button></div>
        {mode === 'feishu' ? <>
          <p className="help">在多维表格「自定义插件 → 获取授权码」中启用并复制。授权码仅在连接时发送至本 demo 后端，最长在内存保存 1 小时。</p>
          <label>多维表格 appToken<input disabled={!!session || busy} value={appToken} onChange={e => setAppToken(e.target.value)} placeholder="Base 标识，不是企业应用 App ID" /></label>
          <label>数据表 tableId<input disabled={!!session || busy} value={tableId} onChange={e => setTableId(e.target.value)} placeholder="tbl…" /></label>
          <button className="link-button" disabled={!!session || busy} onClick={() => action(async () => { const { bitable } = await import('@lark-base-open/js-sdk'); const selection = await Promise.race([bitable.base.getSelection(), new Promise<never>((_, reject) => setTimeout(() => reject(new Error('请在飞书边栏内使用自动识别，或手工填写标识。')), 5000))]); setAppToken(selection.baseId || ''); setTableId(selection.tableId || ''); })}>从当前飞书边栏读取表格标识</button>
          {!session && <label>飞书授权码<input type="password" autoComplete="off" value={code} onChange={e => setCode(e.target.value)} placeholder="personalBaseToken / pt-…" /></label>}
        </> : <p className="help">无需授权码。体验京东、邮政、安能、跨越、顺丰运单；“货拉拉”展示手动维护流程。</p>}
        {!session ? <button className="primary wide" disabled={busy || (mode === 'feishu' && (!code || !tableId || !appToken))} onClick={connect}>{busy ? '正在连接…' : mode === 'demo' ? '进入演示' : '验证授权并连接'}</button> : <button className="wide" disabled={busy} onClick={() => action(async () => { await api('disconnect', {}, session.token); setSession(null); setRows([]); setSelected(null); setFields([]); setNotice('已断开连接，后端会话及授权码引用已清除。'); })}>断开连接</button>}
        <div className="divider" />
        <label>默认承运商<input list="carriers" value={carrier} disabled={busy} onChange={e => setCarrier(e.target.value)} placeholder="选择或输入承运商" /><datalist id="carriers">{carriers.map(c => <option key={c}>{c}</option>)}</datalist></label>
        <p className="help">可输入自定义名称。演示数据中的单行设置优先；真实表格未配置承运商列时使用此默认值。</p>
        {session?.mode === 'feishu' && <>
          {(['number', 'info'] as const).map(key => <label key={key}>{key === 'number' ? '单号字段' : '结果字段'}<select disabled={busy} value={mapping[key]} onChange={e => setMapping({ ...mapping, [key]: e.target.value })}><option value="">选择文本字段</option>{fields.filter(f => f.type === 1).map(f => <option value={f.id} key={f.id}>{f.name}</option>)}</select></label>)}
          <button className="wide" disabled={busy || !mapping.number || !mapping.info || mapping.number === mapping.info} onClick={reload}>加载全部记录</button>
        </>}
        <button className="wide" disabled={!session || busy} onClick={initialize}>{session?.mode === 'feishu' ? '创建 / 复用单号和信息列' : '恢复演示运单'}</button>
        <div className="batch-box"><h3>批量查询</h3><p>范围：当前数据表全部已加载记录</p><button className="primary wide" disabled={!session || !rows.length || busy} onClick={() => run([...rows])}>↻ 一键查询全部运单 <span>{rows.length}</span></button>{busy && <button className="wide" onClick={() => { stop.current = true; }}>停止后续查询</button>}<button className="wide" disabled={!failures || busy} onClick={() => run(rows.filter(r => r.state === 'error'))}>重试失败项（{failures}）</button></div>
        <button className="link-button" onClick={() => setWorkflow(!workflow)}>如何配置表格里的按钮列 ↗</button>
        {workflow && <div className="help workflow"><b>原生按钮列需要一次工作流配置</b><ol><li>在表格新增「查询快递」按钮字段。</li><li>关联“点击按钮时”工作流，HTTP POST 到部署后的 /api/workflow/query。</li><li>传入本行单号和承运商，使用后端会话令牌鉴权。</li><li>将响应 resultText 写入触发记录的「快递信息」。</li></ol><p>具体请求样例见 docs/按钮工作流配置.md。Demo 令牌 1 小时失效，正式版需独立、可撤销的工作流凭证；目前未在真实飞书工作流验证。</p></div>}
      </section>
      <section className="workspace">
        <div className="stats"><div><span>全部运单</span><b>{rows.length.toString().padStart(2, '0')}</b></div><div><span>已更新记录</span><b className="green">{successes.toString().padStart(2, '0')}</b></div><div><span>待处理异常</span><b className="orange">{failures.toString().padStart(2, '0')}</b></div></div>
        <div className="notice" role="status">{notice}</div>
        {progress.total > 0 && <div className="progress"><progress max={progress.total} value={progress.done} /><span>{progress.done} / {progress.total}</span></div>}
        <div className="card records"><div className="section-heading"><div><small>02 / SHIPMENTS</small><h2>{mode === 'demo' ? '运单工作台' : '已连接数据表'}</h2></div><span className="tag">{mode === 'demo' ? '本地演示表' : tableId}</span></div>
          <p className="help">三列交互预览：快递单号 / 快递信息 / 查询按钮。此处按钮属于插件界面，飞书原生按钮需配置工作流。</p>
          <div className="table-wrap"><table><thead><tr><th>快递单号</th><th>快递信息</th><th>操作</th></tr></thead><tbody>{visible.map(row => <tr key={row.id}><td><input aria-label={`${row.id} 快递单号`} disabled={busy || mode === 'feishu'} value={row.number} onChange={e => update(row.id, { number: e.target.value, state: undefined, error: '', info: '' })} /><div className="carrier">{mode === 'demo' ? <input aria-label={`${row.id} 承运商`} disabled={busy} list="carriers" value={row.carrier} onChange={e => update(row.id, { carrier: e.target.value, state: undefined, error: '' })} /> : carrier}</div></td><td><span className={`row-state ${row.state || ''}`}>{row.state === 'loading' ? '查询中…' : row.state === 'success' ? '已更新' : row.state === 'error' ? '需要处理' : '待查询'}</span><p className="tracking-info">{row.info || '查询后自动写入物流信息'}</p>{row.error && <p className="error">{row.error}</p>}</td><td><button className="query-button" disabled={busy || !session} onClick={() => run([row])}>查询</button></td></tr>)}</tbody></table></div>
          {!rows.length && <div className="empty"><span>▤</span><h3>运单将在这里显示</h3><p>先连接演示数据，或授权飞书表格并加载记录。</p></div>}
          {rows.length > 20 && <div className="pagination"><button disabled={page === 0 || busy} onClick={() => setPage(page - 1)}>上一页</button><span>{page + 1} / {Math.ceil(rows.length / 20)}</span><button disabled={(page + 1) * 20 >= rows.length || busy} onClick={() => setPage(page + 1)}>下一页</button></div>}
        </div>
        {selected && <div className="card detail"><div className="section-heading"><div><small>03 / TRACKING</small><h2>最近一次成功查询</h2></div><span className="tag">模拟轨迹</span></div><p className="detail-number">{selected.carrier} · {selected.number}</p><ol className="timeline">{selected.events.map((event, i) => <li key={i}><b>{event.content}</b><time>{new Date(event.time).toLocaleString('zh-CN')}</time></li>)}</ol></div>}
        <footer>飞书官方 SDK · personalBaseToken 授权 · 查询失败保留已有信息</footer>
      </section>
    </main>
  </div>;
}
