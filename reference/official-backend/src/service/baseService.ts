/* eslint-disable no-case-declarations */
/* eslint-disable no-restricted-syntax */
import {
  IBaseService,
  CreateTableArgs,
  CreateTableResponse,
  CreateBaseArgs,
  UpdateBaseArgs,
  GetBaseArgs,
  CopyBaseArgs,
  ListRecordsArgs,
  ListTablesArgs,
  CommonTableArgs,
  ListFieldsArgs,
  CreateFieldArgs,
  UpdateTableArgs,
  CommonFieldArgs,
  UpdateFieldArgs,
  CreateRecordArgs,
  UpdateRecordArgs,
  RecordArgs,
  CreateBatchRecordArgs,
} from '../types/types.js';
import { FieldType } from '../types/enums.js';
import { sessionManager } from './sessionManager.js';
// import { Client, withUserAccessToken } from '@larksuiteoapi/node-sdk';
import { BaseClient } from '@lark-base-open/node-sdk';

// 发npm包先写死，后续优化
const isDev = true;
// const isDev = process.env.NODE_ENV === 'development';

const BASE_AUTHORIZE_URL = 'https://bytedance.feishu-boe.net/space/api/bitable/base_ai/v1/authorize/get_token';

const optionHandler = (value: any, options: any[]) => {
  const optVal = value?.toString?.() ?? value ?? null;
  const option = options?.find((opt) => opt.id === optVal);
  return option ? option.name : optVal;
};

export class BaseService implements IBaseService {
  serviceType: 'sse' | 'stdio' = 'sse';
  _personalBaseToken: string | undefined;
  _appToken: string | undefined;
  _client: BaseClient | undefined;
  constructor(options?: { transport: 'sse' | 'stdio'; personalBaseToken: string; appToken: string }) {
    this.serviceType = options?.transport || 'sse';
    if (this.serviceType === 'stdio' && options) {
      this._personalBaseToken = options.personalBaseToken || process.env.PERSONAL_BASE_TOKEN;
      this._appToken = options.appToken || process.env.APP_TOKEN;
      if (!this._personalBaseToken || !this._appToken) {
        throw new Error('personalBaseToken and appToken must be set');
      }
      this._client = new BaseClient({
        appToken: this._appToken,
        personalBaseToken: this._personalBaseToken,
        logger: {
          info: (...args: any[]) => {},
          error: (...args: any[]) => {
            console.error(...args);
          },
          warn: (...args: any[]) => {},
          debug: (...args: any[]) => {},
          trace: (...args: any[]) => {},
        },
      });
    }
  }

  private getClient(sessionId?: string): BaseClient {
    // logToFile('getClient', !!this._client, this.serviceType);
    if (this._client) {
      return this._client!;
    }

    // sse 模式下，每次调用tools都创建一个client
    const session = sessionManager.getSession(sessionId!);
    if (!session) {
      throw new Error('Session not found');
    }

    return new BaseClient({
      appToken: session.appToken || '',
      personalBaseToken: session.personalBaseToken || '',
    });
  }

  async listRecords(args: ListRecordsArgs, sessionId?: string) {
    const client = this.getClient();
    const params = {
      page_size: 10,
      field_names: args.field_names,
    };

    const records = [];

    try {
      for await (const item of await client.base.appTableRecord.listWithIterator({
        path: args,
        params,
      })) {
        if (item?.items) {
          records.push(...item.items);
        }
        if (args?.recordLength && records.length >= args.recordLength) {
          break;
        }
      }
    } catch (error) {
      throw new Error(`Failed to list records: ${error}`);
    }

    return {
      records,
    };
  }

  async listTables(args: ListTablesArgs, sessionId?: string) {
    const client = this.getClient();
    const tables = [];

    try {
      for await (const item of await client.base.appTable.listWithIterator({
        params: {
          page_size: 20,
        },
      })) {
        if (item?.items) {
          tables.push(...item.items);
        }
      }
    } catch (error) {
      throw new Error(`Failed to list tables: ${error}`);
    }

    return tables;
  }

  async deleteTable(args: CommonTableArgs, sessionId?: string) {
    const client = this.getClient();
    const { data, code, msg } = await client.base.appTable.delete({
      path: args,
    });

    if (code != 0) {
      throw new Error(`Failed to delete table: ${msg}`);
    }

    return { success: true };
  }

  async updateTable(args: UpdateTableArgs, sessionId?: string) {
    const client = this.getClient();
    const { data, code, msg } = await client.base.appTable.patch({
      data: {
        name: args.name,
      },
      path: args.path,
    });

    if (code != 0) {
      throw new Error(`Failed to update table: ${msg}`);
    }

    return data?.name ? { name: data?.name } : {};
  }

  async listFields(args: ListFieldsArgs, sessionId?: string) {
    const client = this.getClient();
    const fields = [];
    for await (const item of await client.base.appTableField.listWithIterator({
      path: args.path,
    })) {
      if (item?.items) {
        fields.push(...item.items);
      }
      if (args.length && fields.length >= args.length) {
        break;
      }
    }
    return fields.map((field) => ({
      ...field,
      description: typeof field.description === 'string' ? { text: field.description } : field.description,
    }));
  }

  async createField(createFieldArgs: CreateFieldArgs, sessionId?: string) {
    const client = this.getClient();
    const { data, code, msg } = await client.base.appTableField.create({
      //@ts-expect-error
      data: createFieldArgs.field,
      path: createFieldArgs.path,
    });

    if (code != 0) {
      throw new Error(`Failed to create field: ${msg}`);
    }

    return data?.field!;
  }

  async deleteField(args: CommonFieldArgs, sessionId?: string) {
    const client = this.getClient();
    const { data, code, msg } = await client.base.appTableField.delete({
      path: args,
    });

    if (code != 0) {
      throw new Error(`Failed to delete field: ${msg}`);
    }

    return { success: true };
  }

  async updateField(args: UpdateFieldArgs, sessionId?: string) {
    const client = this.getClient();
    const data = await client.base.appTableField.update({
      //@ts-expect-error
      data: args.field,
      path: args.path,
    });

    if (data.code != 0) {
      throw new Error(`Failed to update field: ${JSON.stringify(data)}`);
    }

    return data?.data?.field!;
  }

  async createRecord(args: CreateRecordArgs, sessionId?: string) {
    const client = this.getClient();
    const data = await client.base.appTableRecord.create({
      data: {
        fields: args.fields,
      },
      path: {
        table_id: args.table_id,
      },
    });

    if (data.code != 0) {
      throw new Error(`Failed to create record: ${JSON.stringify(data)}`);
    }

    return data?.data?.record || { fields: {} };
  }

  async updateRecord(args: UpdateRecordArgs, sessionId?: string) {
    const client = this.getClient();
    const data = await client.base.appTableRecord.update({
      data: {
        fields: args.fields,
      },
      path: args.path,
    });

    if (data.code != 0) {
      throw new Error(`Failed to update record: ${JSON.stringify(data)}`);
    }

    return data?.data?.record || { fields: {} };
  }

  async deleteRecord(args: RecordArgs, sessionId?: string) {
    const client = this.getClient();
    const { data, code, msg } = await client.base.appTableRecord.delete({
      path: args,
    });

    if (code != 0) {
      throw new Error(`Failed to delete record: ${msg}`);
    }

    return { success: true };
  }

  async getRecord(args: RecordArgs, sessionId?: string) {
    const client = this.getClient();
    const { data, code, msg } = await client.base.appTableRecord.get({
      path: args,
    });

    if (code != 0) {
      throw new Error(`Failed to get record: ${msg}`);
    }

    return data?.record!;
  }

  async createBatchRecord(args: CreateBatchRecordArgs, sessionId?: string) {
    const client = this.getClient();
    const { data, code, msg } = await client.base.appTableRecord.batchCreate({
      data: {
        records: args.records,
      },
      path: args.path,
    });

    if (code != 0) {
      throw new Error(`Failed to create batch record: ${msg}`);
    }

    return data?.records || [];
  }

  async createTable(args: CreateTableArgs, sessionId?: string) {
    const client = this.getClient();
    const data = await client.base.appTable.create({
      data: {
        // @ts-expect-error sdk此api目前ui_type枚举值类型没对齐开放平台和其他api（少了个email），先忽略
        table: args.table,
      },
    });

    if (data.code != 0 || !data.data?.table_id || !data.data.field_id_list?.length) {
      throw new Error(`Failed to create table: ${JSON.stringify(data)}`);
    }
    return data.data!;
  }
}
