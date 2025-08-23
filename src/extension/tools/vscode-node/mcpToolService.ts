/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as vscode from 'vscode';
/* eslint-disable import/no-restricted-paths */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CancellationError, LanguageModelTextPart, LanguageModelToolInformation, LanguageModelToolResult } from 'vscode';
import { ILogService } from '../../../platform/log/common/logService';
import { Lazy } from '../../../util/vs/base/common/lazy';
import { IInstantiationService } from '../../../util/vs/platform/instantiation/common/instantiation';
import { getContributedToolName, getToolName, mapContributedToolNamesInSchema, mapContributedToolNamesInString, ToolName } from '../common/toolNames';
import { ICopilotTool } from '../common/toolsRegistry';
import { BaseToolsService } from '../common/toolsService';
// eslint-disable-next-line no-duplicate-imports
import { LanguageModelToolResult2 } from 'vscode';
// eslint-disable-next-line local/no-test-imports
import { logger } from '../../../../test/simulationLogger';

type McpServers = {
	servers: {
		[key: string]: {
			type: string;
			command: string;
			args: string[];
			env?: Record<string, string>;
			cwd?: string;
		};
	};
}

export class McpToolsService extends BaseToolsService {
	declare _serviceBrand: undefined;
	private readonly _copilotTools: Lazy<Map<ToolName, ICopilotTool<any>>>;
	private mcpTools: vscode.LanguageModelToolInformation[] = [];
	private readonly mcp!: Client;

	get tools(): ReadonlyArray<vscode.LanguageModelToolInformation> {
		return this.mcpTools.map(tool => {
			return {
				...tool,
				name: getToolName(tool.name),
				description: mapContributedToolNamesInString(tool.description),
				inputSchema: tool.inputSchema && mapContributedToolNamesInSchema(tool.inputSchema),
			};
		});
	}

	public get copilotTools() {
		return this._copilotTools.value;
	}

	constructor(
		@IInstantiationService instantiationService: IInstantiationService,
		@ILogService logService: ILogService
	) {
		super(logService);
		this._copilotTools = new Lazy(() => new Map());
		logger.info(`MCP_CONFIG_FILE environment variable: ${process.env.MCP_CONFIG_FILE}`);
		if (process.env.MCP_CONFIG_FILE !== undefined) {
			logger.info(`Loading MCP config from: ${process.env.MCP_CONFIG_FILE}`);
			this.mcp = new Client({ name: 'mcp-simulation-client', version: '1.0.0' });
			const config = fs.readFileSync(process.env.MCP_CONFIG_FILE, 'utf8');
			logger.info(`MCP config contents: ${config}`);
			const mcpServers: McpServers = JSON.parse(config);

			for (const [name, server] of Object.entries(mcpServers.servers)) {
				logger.info(`Setting up MCP server: ${name} with config: ${JSON.stringify(server)}`);
				let transport;
				const configuredEnv = server.env ? Object.fromEntries(Object.entries(server.env).map(([key, value]) => [key, replaceEnvVariables(value)])) : undefined;
				// combine env with process.env, ensuring all values are strings (no undefined)
				const rawEnv = configuredEnv ? { ...process.env, ...configuredEnv } : process.env;
				const combinedEnv: Record<string, string> = {};
				for (const [key, value] of Object.entries(rawEnv)) {
					if (typeof value === 'string') {
						combinedEnv[key] = value;
					}
				}

				if (server.type === 'stdio') {
					const resolvedCommand = replaceEnvVariables(server.command);
					const resolvedArgs = server.args.map(arg => replaceEnvVariables(arg));
					const resolvedCwd = server.cwd ? replaceEnvVariables(server.cwd) : undefined;

					logger.info(`Resolved MCP command: ${resolvedCommand}`);
					logger.info(`Resolved MCP args: ${JSON.stringify(resolvedArgs)}`);
					logger.info(`Resolved MCP cwd: ${resolvedCwd}`);
					logger.info(`AGENT_UPGRADE_ASSISTANT_CLI_PATH: ${process.env.AGENT_UPGRADE_ASSISTANT_CLI_PATH}`);

					// Check if the executable exists and is accessible
					if (!fs.existsSync(resolvedCommand)) {
						logger.error(`MCP executable not found: ${resolvedCommand}`);
						continue;
					}

					// Check file permissions and try to fix t	hem
					try {
						const stats = fs.statSync(resolvedCommand);
						logger.info(`File permissions for ${resolvedCommand}: ${stats.mode.toString(8)}`);

						// Make sure the file is executable (add execute permissions)
						fs.chmodSync(resolvedCommand, 0o755);
						logger.info(`Set execute permissions for: ${resolvedCommand}`);
					} catch (permError) {
						logger.error(`Failed to set permissions for ${resolvedCommand}: ${permError}`);
					}

					// Test the command first to capture any startup errors
					logger.info(`Testing MCP command before creating transport...`);
					const { spawn } = require('child_process');
					const testProcess = spawn(resolvedCommand, resolvedArgs, {
						env: combinedEnv,
						cwd: resolvedCwd,
						stdio: ['pipe', 'pipe', 'pipe']
					});

					let testOutput = '';
					let testErrors = '';

					testProcess.stdout.on('data', (data: Buffer) => {
						testOutput += data.toString();
						logger.info(`MCP test stdout: ${data.toString()}`);
					});

					testProcess.stderr.on('data', (data: Buffer) => {
						testErrors += data.toString();
						logger.error(`MCP test stderr: ${data.toString()}`);
					});

					testProcess.on('close', (code: number) => {
						logger.info(`MCP test process exited with code: ${code}`);
						if (code !== 0) {
							logger.error(`MCP test process failed with code ${code}`);
							logger.error(`MCP test stdout: ${testOutput}`);
							logger.error(`MCP test stderr: ${testErrors}`);
						}
					});

					testProcess.on('error', (error: Error) => {
						logger.error(`MCP test process error: ${error.message}`);
						logger.error(`MCP test process error stack: ${error.stack}`);
					});

					// Wait a bit to see if the process starts successfully
					setTimeout(() => {
						if (!testProcess.killed) {
							logger.info(`MCP test process seems to be running, killing it and proceeding with actual connection`);
							testProcess.kill();
						}
					}, 2000);

					transport = new StdioClientTransport({
						command: resolvedCommand,
						args: resolvedArgs,
						env: combinedEnv,
						stderr: 'inherit', // Default behavior, can be customized if needed
						cwd: resolvedCwd,
					});
				} else {
					logger.warn(`Unsupported MCP transport type: ${server.type} for server ${name}`);
					continue; // Unsupported transport type
				}
				this.mcp.connect(transport).then(async () => {
					logger.info(`Successfully connected to MCP server: ${name}`);
					try {
						const mcpTools = (await this.mcp.listTools()).tools;
						logger.info(`Retrieved ${mcpTools.length} tools from MCP server ${name}: ${JSON.stringify(mcpTools.map((t: any) => t.name))}`);
						for (const tool of mcpTools) {
							const info: LanguageModelToolInformation = {
								name: tool.name,
								description: tool.description as string,
								inputSchema: tool.inputSchema,
								tags: ['vscode_editing'],
								source: undefined
							};
							this.mcpTools.push(info);
						}
						logger.info(`Connected to MCP server with transport ${JSON.stringify(transport)} and tools: ${JSON.stringify(this.mcpTools)}`);
					} catch (toolError) {
						logger.error(`Failed to list tools from MCP server ${name}: ${toolError}`);
					}
				}).catch((error: any) => {
					logger.error(`Failed to connect to MCP server ${name}: ${error}`);
					logger.error(`Error type: ${typeof error}`);
					logger.error(`Error message: ${error.message}`);
					logger.error(`Error stack: ${error.stack}`);
					if (error.code) {
						logger.error(`Error code: ${error.code}`);
					}
					if (error.errno) {
						logger.error(`Error errno: ${error.errno}`);
					}
					if (error.syscall) {
						logger.error(`Error syscall: ${error.syscall}`);
					}
				});
			}
		} else {
			logger.info('MCP_CONFIG_FILE environment variable not set, skipping MCP initialization');
		}
	}

	async invokeTool(name: string | ToolName, options: vscode.LanguageModelToolInvocationOptions<Object>, token: vscode.CancellationToken): Promise<LanguageModelToolResult | LanguageModelToolResult2> {
		this._onWillInvokeTool.fire({ toolName: name });
		const result = await this.mcp?.callTool({
			name: name,
			arguments: options.input as Record<string, unknown>,
		});
		if (!result) {
			throw new CancellationError();
		}
		const parts = [];
		for (const part of result.content as { text: string }[]) {
			parts.push(new LanguageModelTextPart(part.text as string));
		}
		return new LanguageModelToolResult(parts);
	}

	override getCopilotTool(name: string): ICopilotTool<any> | undefined {
		const tool = this._copilotTools.value.get(name as ToolName);
		return tool;
	}

	getTool(name: string | ToolName): vscode.LanguageModelToolInformation | undefined {
		return this.tools.find(tool => tool.name === name);
	}

	getToolByToolReferenceName(name: string): vscode.LanguageModelToolInformation | undefined {
		// Can't actually implement this in prod, name is not exposed
		throw new Error('This method for tests only');
	}

	getEnabledTools(request: vscode.ChatRequest, filter?: (tool: vscode.LanguageModelToolInformation) => boolean | undefined): vscode.LanguageModelToolInformation[] {
		const toolMap = new Map(this.tools.map(t => [t.name, t]));

		return this.tools.filter(tool => {
			// 0. Check if the tool was disabled via the tool picker. If so, it must be disabled here
			const toolPickerSelection = request.tools.get(getContributedToolName(tool.name));
			if (toolPickerSelection === false) {
				return false;
			}

			// 1. Check for what the consumer wants explicitly
			const explicit = filter?.(tool);
			if (explicit !== undefined) {
				return explicit;
			}

			// 2. Check if the request's tools explicitly asked for this tool to be enabled
			for (const ref of request.toolReferences) {
				const usedTool = toolMap.get(ref.name);
				if (usedTool?.tags.includes(`enable_other_tool_${tool.name}`)) {
					return true;
				}
			}

			// 3. If this tool is neither enabled nor disabled, then consumer didn't have opportunity to enable/disable it.
			// This can happen when a tool is added during another tool call (e.g. installExt tool installs an extension that contributes tools).
			if (toolPickerSelection === undefined && tool.tags.includes('extension_installed_by_tool')) {
				return true;
			}

			// Tool was enabled via tool picker
			if (toolPickerSelection === true) {
				return true;
			}

			return false;
		});
	}
}

function replaceEnvVariables(str: string): string {
	return str.replace(/\$\{([^}]+)\}/g, (match: string, varName: string) => {
		return process.env[varName] || '';
	});
}