import { bitable, FieldType, type ITable } from '@lark-base-open/js-sdk';
import type { Mapping, Row } from './types';

// 与官方模板相同的宿主入口；不使用企业自建应用或 tenant_access_token。
export async function connectBase() {
  const table = await bitable.base.getActiveTable();
  return { table, name: await table.getName(), fields: await table.getFieldMetaList() };
}
export async function ensureFields(table: ITable): Promise<Mapping> {
  const fields = await table.getFieldMetaList();
  const mapping: Mapping = { number: '', info: '' };
  for (const [key, name] of [['number', '快递单号'], ['info', '快递信息']] as const) {
    const found = fields.find(f => f.name === name);
    if (found && found.type !== FieldType.Text) throw new Error(`已有「${name}」不是文本字段，请先手动选择文本列。`);
    mapping[key] = found?.id || await table.addField({ type: FieldType.Text, name });
  }
  return mapping;
}
export async function readRows(table: ITable, mapping: Mapping): Promise<Row[]> {
  if (!mapping.number || !mapping.info || mapping.number === mapping.info) throw new Error('请选择两个不同的文本字段。');
  const fields = await table.getFieldMetaList();
  for (const id of [mapping.number, mapping.info]) if (!fields.some(f => f.id === id && f.type === FieldType.Text)) throw new Error('字段已删除或类型不符，请重新配置。');
  const rows: Row[] = [];
  let pageToken: number | undefined;
  do {
    const page = await table.getRecordsByPage({ pageSize: 200, pageToken, stringValue: true });
    for (const record of page.records) rows.push({ id: record.recordId, number: String(record.fields[mapping.number] ?? ''), info: String(record.fields[mapping.info] ?? '') });
    if (!page.hasMore) break;
    if (page.pageToken === undefined || page.pageToken === pageToken) throw new Error('分页游标异常，请重新加载。');
    pageToken = page.pageToken;
  } while (true);
  return rows;
}
export async function writeInfo(table: ITable, mapping: Mapping, row: Row, info: string) {
  // 查询期间运单被编辑时，不把旧运单的结果写进新运单。
  const current = await table.getCellString(mapping.number, row.id);
  if (current.trim() !== row.number.trim()) throw new Error('查询期间单号已变更，本次结果未写回，请重新查询。');
  const ok = await table.setCellValue(mapping.info, row.id, info);
  if (!ok) throw new Error('查询成功，但写回失败，请检查记录及字段编辑权限。');
}
