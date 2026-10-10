import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema, CallToolResult, ListToolsResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  ListRecordsArgsSchema,
  ListTablesArgsSchema,
  CreateRecordArgsSchema,
  UpdateRecordArgsSchema,
  CreateTableArgsSchema,
  UpdateTableArgsSchema,
  IBaseService,
  IBaseMCPServer,
  UpdateFieldArgsSchema,
  ListFieldsArgsSchema,
  CreateFieldArgsSchema,
  CommonFieldArgsSchema,
  CommonTableArgsSchema,
  RecordArgsSchema,
} from '../types/types.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { currentVersion } from '../utils/version.js';
import { logToFile, uuid } from '../utils/utils.js';
import { EToolType, toolList } from './toolList.js';

const formatToolResponse = (data: unknown, isError = false): CallToolResult => {
  return {
    content: [
      {
        type: 'text',
        mimeType: 'application/json',
        text: JSON.stringify(data),
      },
    ],
    isError,
  };
};

export class BaseMCPServer implements IBaseMCPServer {
  private server: Server;

  private baseService: IBaseService;

  stdioUUID: string;

  constructor(baseService: IBaseService) {
    this.baseService = baseService;
    this.stdioUUID = uuid();
    this.server = new Server(
      {
        name: 'base-mcp-server',
        version: currentVersion,
      },
      {
        capabilities: {
          resources: {},
          tools: {},
        },
      },
    );
    this.initializeHandlers();
  }

  private initializeHandlers(): void {
    this.server.setRequestHandler(ListToolsRequestSchema, this.handleListTools.bind(this));
    this.server.setRequestHandler(CallToolRequestSchema, this.handleCallTool.bind(this));
  }

  private async handleListTools(): Promise<ListToolsResult> {
    // 收集所有tools（包括注释掉的）inputSchema

    return {
      tools: toolList,
    };
  }

  private async handleCallTool(request: z.infer<typeof CallToolRequestSchema>): Promise<CallToolResult> {
    try {
      const transport = this.server.transport;
      let sessionId = transport?.sessionId as string;
      if (transport instanceof SSEServerTransport) {
      } else if (transport instanceof StdioServerTransport) {
        sessionId = this.stdioUUID;
      }

      if (!sessionId) {
        throw new Error('Session ID is required');
      }

      switch (request.params.name) {
        case EToolType.ListTables: {
          const args = ListTablesArgsSchema.parse(request.params.arguments);
          const records = await this.baseService.listTables(args, sessionId);
          return formatToolResponse(records);
        }
        case EToolType.CreateTable: {
          const args = CreateTableArgsSchema.parse(request.params.arguments);
          const table = await this.baseService.createTable(args, sessionId);
          return formatToolResponse(table);
        }
        case EToolType.UpdateTable: {
          const args = UpdateTableArgsSchema.parse(request.params.arguments);
          const table = await this.baseService.updateTable(args, sessionId);
          return formatToolResponse(table);
        }
        case EToolType.DeleteTable: {
          const args = CommonTableArgsSchema.parse(request.params.arguments);
          const table = await this.baseService.deleteTable(args, sessionId);
          return formatToolResponse(table);
        }
        case EToolType.ListRecords: {
          const args = ListRecordsArgsSchema.parse(request.params.arguments);
          const records = await this.baseService.listRecords(args, sessionId);
          return formatToolResponse(records);
        }
        case EToolType.ListFields: {
          const args = ListFieldsArgsSchema.parse(request.params.arguments);
          const fields = await this.baseService.listFields(args, sessionId);
          return formatToolResponse(fields);
        }
        case EToolType.CreateField: {
          const args = CreateFieldArgsSchema.parse(request.params.arguments);
          const field = await this.baseService.createField(args, sessionId);
          return formatToolResponse(field);
        }
        case EToolType.UpdateField: {
          const args = UpdateFieldArgsSchema.parse(request.params.arguments);
          const field = await this.baseService.updateField(args, sessionId);
          return formatToolResponse(field);
        }
        case EToolType.DeleteField: {
          const args = CommonFieldArgsSchema.parse(request.params.arguments);
          const res = await this.baseService.deleteField(args, sessionId);
          return formatToolResponse(res);
        }
        case EToolType.CreateRecord: {
          const args = CreateRecordArgsSchema.parse(request.params.arguments);
          const record = await this.baseService.createRecord(args, sessionId);
          return formatToolResponse(record);
        }
        case EToolType.DeleteRecord: {
          const args = RecordArgsSchema.parse(request.params.arguments);
          const res = await this.baseService.deleteRecord(args, sessionId);
          return formatToolResponse(res);
        }
        case EToolType.UpdateRecord: {
          const args = UpdateRecordArgsSchema.parse(request.params.arguments);
          const record = await this.baseService.updateRecord(args, sessionId);
          return formatToolResponse(record);
        }
        case EToolType.GetRecord: {
          const args = RecordArgsSchema.parse(request.params.arguments);
          const record = await this.baseService.getRecord(args, sessionId);
          return formatToolResponse(record);
        }
        default: {
          throw new Error(`Unknown tool: ${request.params.name}`);
        }
      }
    } catch (error: any) {
      const errorMessage = error?.response?.data
        ? JSON.stringify(error?.response?.data)
        : error instanceof Error
          ? error.message
          : JSON.stringify(error);
      return formatToolResponse(`Error in tool ${request.params.name}: ${errorMessage}`, true);
    }
  }

  async connect(transport: Transport): Promise<void> {
    await this.server.connect(transport);
  }

  async close(): Promise<void> {
    await this.server.close();
  }
}
