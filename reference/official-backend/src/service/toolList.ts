import { zodToJsonSchema } from 'zod-to-json-schema';
import { ListToolsResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import {
  ListRecordsArgsSchema,
  ListTablesArgsSchema,
  CreateRecordArgsSchema,
  UpdateRecordArgsSchema,
  CreateTableArgsSchema,
  UpdateFieldArgsSchema,
  ListFieldsArgsSchema,
  CreateFieldArgsSchema,
  CommonFieldArgsSchema,
  CommonTableArgsSchema,
  RecordArgsSchema,
  UpdateTableArgsSchema,
} from '../types/types.js';

export enum EToolType {
  ListRecords = 'list_records',
  ListTables = 'list_tables',
  CreateTable = 'create_table',
  DeleteTable = 'delete_table',
  UpdateTable = 'update_table',
  ListFields = 'list_fields',
  CreateField = 'create_field',
  UpdateField = 'update_field',
  DeleteField = 'delete_field',
  CreateRecord = 'create_record',
  DeleteRecord = 'delete_record',
  UpdateRecord = 'update_record',
  GetRecord = 'get_record',
}

const removeSchemaProperty = (obj: any) => {
  if (typeof obj !== 'object' || obj === null) return;
  delete obj['$schema'];
  Object.values(obj).forEach(removeSchemaProperty);
};

const getInputSchema = (schema: z.ZodType<object>): ListToolsResult['tools'][0]['inputSchema'] => {
  let jsonSchema = zodToJsonSchema(schema, {
    // $refStrategy: 'none'
  });
  removeSchemaProperty(jsonSchema);
  if (!('type' in jsonSchema) || jsonSchema.type !== 'object') {
    throw new Error(
      `Invalid input schema to convert in base-mcp-server: expected an object but got ${'type' in jsonSchema ? jsonSchema.type : 'no type'}`,
    );
  }
  return { ...jsonSchema, type: 'object' };
};

export const toolList = [
  {
    name: EToolType.ListRecords,
    description: 'List records from a table',
    inputSchema: getInputSchema(ListRecordsArgsSchema),
  },
  {
    name: EToolType.ListTables,
    description: 'List tables from a app',
    inputSchema: getInputSchema(ListTablesArgsSchema),
  },
  {
    name: EToolType.CreateTable,
    description:
      '在一个base app（多维表格） 中创建表单。需要事先获取app token。让用户直接提供app token或者一个base的url，如果没有，用creat_base创建一个app获取app token， 不要伪造app token',
    inputSchema: getInputSchema(CreateTableArgsSchema),
  },
  {
    name: EToolType.UpdateTable,
    description: '更新一个base app（多维表格）中的表单，如果返回了url，用markdown格式显示这个url，并引导用户访问这个url',
    inputSchema: getInputSchema(UpdateTableArgsSchema),
  },
  {
    name: EToolType.DeleteTable,
    description: 'Delete a table in a base app（多维表格）',
    inputSchema: getInputSchema(CommonTableArgsSchema),
  },
  {
    name: EToolType.ListFields,
    description:
      'Get field information for a form in a base app (多维表格). If a URL is returned, display this URL in Markdown format and guide the user to visit this URL.',
    inputSchema: getInputSchema(ListFieldsArgsSchema),
  },
  {
    name: EToolType.CreateField,
    description:
      'Create a field in a form in a base app (多维表格). If a URL is returned, display this URL in Markdown format and guide the user to visit this URL.',
    inputSchema: getInputSchema(CreateFieldArgsSchema),
  },
  {
    name: EToolType.UpdateField,
    description:
      'Update a field in a form in a base app (多维表格). If a URL is returned, display this URL in Markdown format and guide the user to visit this URL.',
    inputSchema: getInputSchema(UpdateFieldArgsSchema),
  },
  {
    name: EToolType.DeleteField,
    description:
      'Delete a field in a form in a base app (多维表格). If a URL is returned, display this URL in Markdown format and guide the user to visit this URL.',
    inputSchema: getInputSchema(CommonFieldArgsSchema),
  },
  {
    name: EToolType.CreateRecord,
    description: 'Create a record in a table.',
    inputSchema: getInputSchema(CreateRecordArgsSchema),
  },
  {
    name: EToolType.DeleteRecord,
    description: 'Delete a record from a table',
    inputSchema: getInputSchema(RecordArgsSchema),
  },
  {
    name: EToolType.UpdateRecord,
    description: 'Update an existing record in a table',
    inputSchema: getInputSchema(UpdateRecordArgsSchema),
  },
  {
    name: EToolType.GetRecord,
    description: 'Get a single record by ID',
    inputSchema: getInputSchema(RecordArgsSchema),
  },
];
