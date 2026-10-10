#!/usr/bin/env node

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { BaseService } from './service/baseService.js';
import { BaseMCPServer } from './service/mcpServer.js';
import { Command } from 'commander';
import { currentVersion } from './utils/version.js';
import fs from 'fs';
import { sessionManager } from './service/sessionManager.js';
const main = async () => {
    const program = new Command();
    program.name('base-mcp').description('Base MCP Tool').version(currentVersion);
    program
        .description('Start Base MCP Service')
        .option('-p, --personal-base-token <personalBaseToken>', 'Personal Base Token')
        .option('-a, --app-token <appToken>', 'App Token')
        .action(async (options) => {
            let fileOptions = {};
            if (options.config) {
                try {
                    const configContent = fs.readFileSync(options.config, 'utf-8');
                    fileOptions = JSON.parse(configContent);
                } catch (err) {
                    console.error('Failed to read config file:', err);
                    process.exit(1);
                }
            }
            const mergedOptions = { ...fileOptions, ...options, transport: 'stdio' };
            const baseService = new BaseService(mergedOptions);
            const server = new BaseMCPServer(baseService);

            const transport = new StdioServerTransport();
            sessionManager.createSession(server.stdioUUID, options.appToken, options.personalBaseToken, transport);
            await server.connect(transport);
        });

    await program.parseAsync();
};

await main();