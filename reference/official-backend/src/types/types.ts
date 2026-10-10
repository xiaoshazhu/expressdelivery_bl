import { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { z } from 'zod';
import { RecordFieldsSchema } from './fieldValueSchemas.js';
import { FieldSchema } from './fieldSchemas.js';

// ========== Base Response Schemas ==========
export const ResponseSchema = (dataSchema: z.ZodType<object>) =>
  z.object({
    code: z.number(),
    data: dataSchema,
  });

// ========== View Related Schemas ==========
export const ViewSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.string(),
});

// ========== Table Related Schemas ==========
export const TableSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  primaryFieldId: z.string(),
  fields: z.array(FieldSchema),
  // views: z.array(ViewSchema),
});

export const GetAppTokenArgsSchema = z.object({
  url: z.string(),
  // user_access_token: z.string(),
});

export const BaseSchemaResponseSchema = z.object({
  tables: z.array(TableSchema),
});

export const CommonTableArgsSchema = z.object({
  table_id: z.string(),
  // app_token: z.string(),
  // user_access_token: z.string(),
});

export const CreateTableArgsSchema = z
  .object({
    table: z.object({
      name: z.string(),
      fields: z
        .array(FieldSchema)
        .describe(
          `Table fields. Rules: At least one field must be specified. The type of the primary (first) field must be one of: 1, 2, 5, 13, 15, 20, 22.`,
        ),
    }),
    // user_access_token: z.string(),
    // app_token: z.string(),
  })
  .describe('create a table');

export const CreateTableResponseSchema = z.object({
  table_id: z.string().optional(),
  default_view_id: z.string().optional(),
  field_id_list: z.array(z.string()).optional(),
});

export const TableResponseSchema = z.object({
  name: z.string().optional(),
  revision: z.number().optional(),
  table_id: z.string().optional(),
});

export const ListTablesResponseSchema = z.array(TableResponseSchema);

// ========== API Argument Schemas ==========
export const ListRecordsArgsSchema = z.object({
  table_id: z.string(),
  // app_token: z.string(),
  // user_access_token: z.string(),
  field_names: z
    .string()
    .optional()
    .describe('Use name rather than id to specify the fields to return.It needs to be formatted as a JSON array string'),
  // sort: z.array(z.string()).optional(),
  // filter: z.string().optional().describe('eg. AND(CurrentValue.[订单号].contains("004"),CurrentValue.[订单日期]= TODAY())'),
  recordLength: z.number().optional().default(20),
});

export const ListTablesArgsSchema = z.object({
  // app_token: z.string(),
  // user_access_token: z.string(),
  // length: z.number().optional(),
});

export const GetTableSchemaArgsSchema = z.object({
  table_id: z.string(),
});

export const RecordArgsSchema = z.object({
  // app_token: z.string(),
  table_id: z.string(),
  record_id: z.string(),
  // user_access_token: z.string(),
});

export const CreateRecordArgsSchema = z
  .object({
    table_id: z.string(),
    fields: RecordFieldsSchema,
    // user_access_token: z.string(),
  })
  .describe(
    `文本Text：填写字符串格式的值; 数字Number：填写数字格式的值; 单选SingleSelect：填写选项值，对于新的选项值，将会创建一个新的选项; 多选MultiSelect：填写多个选项值，对于新的选项值，将会创建一个新的选项。如果填写多个相同的新选项值，将会创建多个相同的选项; 日期DateTime：填写毫秒级时间戳; 复选框Checkbox：填写 true 或 false; 条码Barcode：填写条码值; 人员User：填写用户的open_id、union_id 或 user_id，类型需要与 user_id_type 指定的类型一致; 电话号码Phone：填写文本内容, 纯数字; 超链接Url：遵循格式 { text: '链接文本', link: 'https://www.123.com' }; 附件Attachment：FileSchema, 填写附件 token，需要先调用上传素材或分片上传素材接口将附件上传至该多维表格中; 单向关联Lookup：数组，填写被关联表的记录 ID; 双向关联DuplexLink：数组，填写被关联表的记录 ID; 地理位置Location：填写经纬度坐标，用,拼接，例如"123.124,123.124"`,
  );

export const CreateBatchRecordArgsSchema = z.object({
  path: CommonTableArgsSchema,
  records: z.array(
    z.object({
      fields: RecordFieldsSchema,
    }),
  ),
  // user_access_token: z.string(),
});
export const UpdateRecordArgsSchema = z.object({
  path: RecordArgsSchema,
  fields: z.record(z.string(), z.any()).describe('fields类型与create_record的fields类型一样'),
  // user_access_token: z.string(),
});

// export const DeleteRecordsArgsSchema = z.object({
//   baseId: z.string(),
//   tableId: z.string(),
//   recordIds: z.array(z.string()),
// });

// export const CreateTableArgsSchema = z.object({
//   name: z.string().describe('Name for the new table. Must be unique in the base.'),
//   fields: z.array(FieldSchema).describe(`Table fields. Rules:
// - At least one field must be specified.
// - The primary (first) field must be one of: single line text, long text, date, phone number, email, URL, number, currency, percent, duration, formula, autonumber, barcode.
// `),
// });

export const UpdateTableArgsSchema = z.object({
  name: z.string(),
  path: CommonTableArgsSchema,
  // user_access_token: z.string(),
});

export const CreateFieldArgsSchema = z.object({
  path: CommonTableArgsSchema,
  field: z.record(z.string(), z.any()).describe('field类型与create_table的fields数组里元素类型一样'),
  // user_access_token: z.string(),
});

export const CreateBaseArgsSchema = z.object({
  // user_access_token: z.string().describe('User access token for base tools calling'),
  name: z.string(),
  folder_token: z.string().optional().describe('Folder token where the base will be created'),
});

export const UpdateBaseArgsSchema = z.object({
  app_token: z.string(),
  name: z.string().optional(),
  folder_token: z.string().optional().describe('New folder token for the base'),
  // user_access_token: z.string(),
});

export const GetBaseArgsSchema = z.object({
  app_token: z.string().describe('ID of the base to get'),
  // user_access_token: z.string(),
});

export const CopyBaseArgsSchema = z.object({
  app_token: z.string(),
  folder_token: z.string().optional(),
  // user_access_token: z.string(),
});

export const ListFieldsArgsSchema = z.object({
  length: z.number().optional(),
  path: CommonTableArgsSchema,
  // user_access_token: z.string(),
});

export const CommonFieldArgsSchema = z.object({
  field_id: z.string(),
  table_id: z.string(),
  // user_access_token: z.string(),
});

export const UpdateFieldArgsSchema = z.object({
  field: z.record(z.string(), z.any()).describe('field类型与create_table的fields数组里元素类型一样'),
  path: CommonFieldArgsSchema,
  // user_access_token: z.string(),
});

export const AppSchema = z.object({
  app_token: z.string().optional(),
  name: z.string().optional(),
  revision: z.number().optional(),
  is_advanced: z.boolean().optional(),
  time_zone: z.string().optional(),
  formula_type: z.number().optional(),
  advance_version: z.enum(['v1', 'v2']).optional(),
});

// ========== Type Definitions ==========
export type ListTablesResponse = z.infer<typeof ListTablesResponseSchema>;
export type BaseSchemaResponse = z.infer<typeof BaseSchemaResponseSchema>;
export type Table = z.infer<typeof TableSchema>;
export type Field = z.infer<typeof FieldSchema>;
export type App = z.infer<typeof AppSchema>;
export type GetAppTokenArgs = z.infer<typeof GetAppTokenArgsSchema>;
export type ListRecordsArgs = z.infer<typeof ListRecordsArgsSchema>;
export type ListTablesArgs = z.infer<typeof ListTablesArgsSchema>;
export type TableResponse = z.infer<typeof TableResponseSchema>;
export type RecordArgs = z.infer<typeof RecordArgsSchema>;
export type CreateTableArgs = z.infer<typeof CreateTableArgsSchema>;
export type CreateTableResponse = z.infer<typeof CreateTableResponseSchema>;
export type UpdateTableArgs = z.infer<typeof UpdateTableArgsSchema>;
export type UpdateFieldArgs = z.infer<typeof UpdateFieldArgsSchema>;
export type CommonTableArgs = z.infer<typeof CommonTableArgsSchema>;
export type CreateBaseArgs = z.infer<typeof CreateBaseArgsSchema>;
export type UpdateBaseArgs = z.infer<typeof UpdateBaseArgsSchema>;
export type GetBaseArgs = z.infer<typeof GetBaseArgsSchema>;
export type CopyBaseArgs = z.infer<typeof CopyBaseArgsSchema>;
export type CreateRecordArgs = z.infer<typeof CreateRecordArgsSchema>;
export type UpdateRecordArgs = z.infer<typeof UpdateRecordArgsSchema>;
export type CreateBatchRecordArgs = z.infer<typeof CreateBatchRecordArgsSchema>;
// export type DeleteRecordsArgs = z.infer<typeof DeleteRecordsArgsSchema>;
// export type GetRecordArgs = z.infer<typeof RecordArgsSchema>;
export type CreateFieldArgs = z.infer<typeof CreateFieldArgsSchema>;
export type CommonFieldArgs = z.infer<typeof CommonFieldArgsSchema>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type FieldSet = Record<string, any>;

export type BaseRecord = {
  fields: Record<
    string,
    | string
    | number
    | boolean
    | {
        text?: string;
        link?: string;
      }
    | {
        location?: string;
        pname?: string;
        cityname?: string;
        adname?: string;
        address?: string;
        name?: string;
        full_address?: string;
      }
    | Array<{
        id?: string;
        name?: string;
        avatar_url?: string;
      }>
    | Array<string>
    | Array<{
        id?: string;
        name?: string;
        en_name?: string;
        email?: string;
        avatar_url?: string;
      }>
    | Array<{
        file_token?: string;
        name?: string;
        type?: string;
        size?: number;
        url?: string;
        tmp_url?: string;
      }>
  >;
  record_id?: string | undefined;
  created_by?:
    | {
        id?: string | undefined;
        name?: string | undefined;
        en_name?: string | undefined;
        email?: string | undefined;
        avatar_url?: string | undefined;
      }
    | undefined;
  created_time?: number | undefined;
  last_modified_by?:
    | {
        id?: string | undefined;
        name?: string | undefined;
        en_name?: string | undefined;
        email?: string | undefined;
        avatar_url?: string | undefined;
      }
    | undefined;
  last_modified_time?: number | undefined;
};

// ========== Auth Response Types ==========
export interface AuthResponse {
  authUrl?: string;
  message?: string;
}

export interface IBaseService {
  listRecords(listRecordsArgs: ListRecordsArgs, sessionId?: string): Promise<AuthResponse | any>;
  listTables(listTablesArgs: ListTablesArgs, sessionId?: string): Promise<AuthResponse | ListTablesResponse>;
  createTable(data: CreateTableArgs, sessionId?: string): Promise<AuthResponse | TableResponse>;
  updateTable(updateTableArgs: UpdateTableArgs, sessionId?: string): Promise<AuthResponse | { name?: string }>;
  deleteTable(deleteTableArgs: CommonTableArgs, sessionId?: string): Promise<AuthResponse | { success?: boolean }>;
  listFields(listFieldsArgs: ListFieldsArgs, sessionId?: string): Promise<AuthResponse | Field[]>;
  createField(createFieldArgs: CreateFieldArgs, sessionId?: string): Promise<AuthResponse | Field>;
  updateField(updateFieldArgs: UpdateFieldArgs, sessionId?: string): Promise<AuthResponse | Field>;
  deleteField(deleteFieldArgs: CommonFieldArgs, sessionId?: string): Promise<AuthResponse | { success?: boolean }>;
  createRecord(createRecordArgs: CreateRecordArgs, sessionId?: string): Promise<AuthResponse | BaseRecord>;
  updateRecord(updateRecordArgs: UpdateRecordArgs, sessionId?: string): Promise<AuthResponse | BaseRecord>;
  deleteRecord(deleteRecordArgs: RecordArgs, sessionId?: string): Promise<AuthResponse | { success?: boolean }>;
  getRecord(getRecordArgs: RecordArgs, sessionId?: string): Promise<AuthResponse | BaseRecord>;
}

export interface IBaseMCPServer {
  stdioUUID: string;
  connect(transport: Transport): Promise<void>;
}

export interface Prompt {
  id: string;
  name: string;
  content: string;
  description: string | undefined;
  tags: string[] | undefined;
  createdAt: number;
  updatedAt: number;
  version: number | undefined;
  isEnabled: boolean | undefined;
  category: string | undefined;
  parameters: PromptParameter[] | undefined;
}

export interface PromptParameter {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'array' | 'object';
  description: string | undefined;
  required: boolean | undefined;
  defaultValue: any | undefined;
}

export interface CreatePromptRequest {
  name: string;
  content: string;
  description?: string;
  tags?: string[];
  category?: string;
  parameters?: PromptParameter[];
}

export interface UpdatePromptRequest {
  name?: string;
  content?: string;
  description?: string;
  tags?: string[];
  isEnabled?: boolean;
  category?: string;
  parameters?: PromptParameter[];
}

export interface TextResourceArgument {
  name: string;
  description: string | undefined;
  required: boolean | undefined;
}

export interface TextResource {
  id: string;
  name: string;
  description: string | undefined;
  arguments: TextResourceArgument[] | undefined;
  createdAt: number;
  updatedAt: number;
}

export interface CreateTextResourceRequest {
  name: string;
  description?: string;
  arguments?: TextResourceArgument[];
}

export interface UpdateTextResourceRequest {
  name?: string;
  description?: string;
  arguments?: TextResourceArgument[];
}

// export type ListFieldsParams = z.infer<typeof ListFieldsParamsSchema>;
export type ListFieldsArgs = z.infer<typeof ListFieldsArgsSchema>;
