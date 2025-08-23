/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// Allow importing vscode here. eslint does not let us exclude this path: https://github.com/import-js/eslint-plugin-import/issues/2800
/* eslint-disable import/no-restricted-paths */

import * as fs from 'fs';
import * as path from 'path';
import type { CancellationToken, ChatRequest, LanguageModelTool, LanguageModelToolInformation, LanguageModelToolInvocationOptions, LanguageModelToolResult } from 'vscode';
import { getToolName, ToolName } from '../../../src/extension/tools/common/toolNames';
import { ICopilotTool } from '../../../src/extension/tools/common/toolsRegistry';
import { BaseToolsService, IToolsService } from '../../../src/extension/tools/common/toolsService';
import { getPackagejsonToolsForTest } from '../../../src/extension/tools/node/test/testToolsService';
import { McpToolsService } from '../../../src/extension/tools/vscode-node/mcpToolService';
import { ToolsContribution } from '../../../src/extension/tools/vscode-node/tools';
import { ToolsService } from '../../../src/extension/tools/vscode-node/toolsService';
import { packageJson } from '../../../src/platform/env/common/packagejson';
import { ILogService } from '../../../src/platform/log/common/logService';
import { raceTimeout } from '../../../src/util/vs/base/common/async';
import { CancellationError } from '../../../src/util/vs/base/common/errors';
import { Iterable } from '../../../src/util/vs/base/common/iterator';
import { observableValue } from '../../../src/util/vs/base/common/observableInternal';
import { IInstantiationService } from '../../../src/util/vs/platform/instantiation/common/instantiation';
import { logger } from '../../simulationLogger';

export class SimulationExtHostToolsService extends BaseToolsService implements IToolsService {
	declare readonly _serviceBrand: undefined;

	private readonly _inner: IToolsService;
	private readonly _mcpToolService: IToolsService;
	private readonly _overrides = new Map<ToolName | string, { info: LanguageModelToolInformation; tool: ICopilotTool<any> }>();
	private _lmToolRegistration?: ToolsContribution;

	override get onWillInvokeTool() {
		return this._inner.onWillInvokeTool;
	}

	get tools() {
		this.ensureToolsRegistered();
		const allTools = [
			...this._inner.tools.filter(t => !this._disabledTools.has(t.name) && !this._overrides.has(t.name)),
			...Iterable.map(this._overrides.values(), i => i.info),
			...this._mcpToolService.tools.filter(t => !this._disabledTools.has(t.name) && !this._overrides.has(t.name))
		];

		this.logAllToolsToFile(allTools);
		return allTools;
	}

	get copilotTools() {
		const r = new Map([
			...this._inner.copilotTools,
			...Iterable.map(this._overrides, ([k, v]): [ToolName, ICopilotTool<any>] => [k as ToolName, v.tool]),
		]);
		for (const name of this._disabledTools) {
			r.delete(name as ToolName);
		}

		this.logCopilotToolsToFile(r);

		return r;
	}

	private logAllToolsToFile(allTools: LanguageModelToolInformation[]) {
		try {
			const outputDir = process.env.OUTPUT_DIR || './';
			const logFile = path.join(outputDir, 'all_tools_debug.log');

			const debugInfo = {
				timestamp: new Date().toISOString(),
				totalTools: allTools.length,
				mcpConfigFile: process.env.MCP_CONFIG_FILE,
				mcpConfigExists: process.env.MCP_CONFIG_FILE ? fs.existsSync(process.env.MCP_CONFIG_FILE) : false,
				innerToolsCount: this._inner.tools.length,
				mcpToolsCount: this._mcpToolService.tools.length,
				overridesCount: this._overrides.size,
				disabledToolsCount: this._disabledTools.size,
				disabledTools: Array.from(this._disabledTools),
				tools: allTools.map(tool => ({
					name: tool.name,
					description: tool.description,
					tags: tool.tags,
					hasInputSchema: !!tool.inputSchema,
				})),
				innerTools: this._inner.tools.map(tool => ({
					name: tool.name,
					description: tool.description,
					tags: tool.tags,
				})),
				mcpTools: this._mcpToolService.tools.map(tool => ({
					name: tool.name,
					description: tool.description,
					tags: tool.tags,
				})),
			};

			fs.writeFileSync(logFile, JSON.stringify(debugInfo, null, 2));
			logger.info(`SimulationExtHostToolsService: Logged all tools to ${logFile}`);
		} catch (error) {
			logger.error(`SimulationExtHostToolsService: Failed to log tools to file: ${error}`);
		}
	}

	private logCopilotToolsToFile(copilotTools: Map<ToolName, ICopilotTool<any>>) {
		try {
			const outputDir = process.env.OUTPUT_DIR || './';
			const logFile = path.join(outputDir, 'copilot_tools_debug.log');

			const debugInfo = {
				timestamp: new Date().toISOString(),
				totalCopilotTools: copilotTools.size,
				mcpConfigFile: process.env.MCP_CONFIG_FILE,
				mcpConfigExists: process.env.MCP_CONFIG_FILE ? fs.existsSync(process.env.MCP_CONFIG_FILE) : false,
				innerCopilotToolsCount: this._inner.copilotTools.size,
				mcpCopilotToolsCount: this._mcpToolService.copilotTools.size,
				overridesCount: this._overrides.size,
				disabledToolsCount: this._disabledTools.size,
				disabledTools: Array.from(this._disabledTools),
				copilotTools: Array.from(copilotTools.entries()).map(([name, tool]) => ({
					name,
					toolType: tool.constructor.name,
					hasInvoke: typeof tool.invoke === 'function',
					toolString: tool.toString(),
				})),
				innerCopilotTools: Array.from(this._inner.copilotTools.entries()).map(([name, tool]) => ({
					name,
					toolType: tool.constructor.name,
					source: 'inner',
				})),
				mcpCopilotTools: Array.from(this._mcpToolService.copilotTools.entries()).map(([name, tool]) => ({
					name,
					toolType: tool.constructor.name,
					source: 'mcp',
				})),
				overrideCopilotTools: Array.from(this._overrides.entries()).map(([name, override]) => ({
					name,
					toolType: override.tool.constructor.name,
					source: 'override',
				})),
			};

			fs.writeFileSync(logFile, JSON.stringify(debugInfo, null, 2));
			logger.info(`SimulationExtHostToolsService: Logged copilot tools to ${logFile}`);
		} catch (error) {
			logger.error(`SimulationExtHostToolsService: Failed to log copilot tools to file: ${error}`);
		}
	}

	constructor(
		private readonly _disabledTools: Set<string>,
		@ILogService logService: ILogService,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super(logService);
		this._inner = instantiationService.createInstance(ToolsService);
		this._mcpToolService = instantiationService.createInstance(McpToolsService);

		// register the contribution so that our tools are on vscode.lm.tools
		setImmediate(() => this.ensureToolsRegistered());
	}

	private ensureToolsRegistered() {
		this._lmToolRegistration ??= new ToolsContribution(this, {} as any, { threshold: observableValue(this, 128) } as any);
	}

	getCopilotTool(name: string): ICopilotTool<any> | undefined {
		return this._disabledTools.has(name) ? undefined : (this._overrides.get(name)?.tool || this._inner.getCopilotTool(name));
	}

	async invokeTool(name: string, options: LanguageModelToolInvocationOptions<unknown>, token: CancellationToken): Promise<LanguageModelToolResult> {
		logger.debug('SimulationExtHostToolsService.invokeTool', name, JSON.stringify(options.input));
		const start = Date.now();
		let err: Error | undefined;
		try {
			const toolName = getToolName(name) as ToolName;
			const tool = this._overrides.get(toolName)?.tool;
			if (tool) {
				this._onWillInvokeTool.fire({ toolName });
				const result = await tool.invoke(options, token);
				if (!result) {
					throw new CancellationError();
				}

				return result;
			}

			const r = await raceTimeout(Promise.resolve(this._inner.invokeTool(name, options, token)), 1800_000);
			if (!r) {
				throw new Error(`Tool call timed out after 60 seconds`);
			}
			return r;
		} catch (e) {
			err = e;
			throw e;
		} finally {
			logger.debug(`SimulationExtHostToolsService.invokeTool ${name} done in ${Date.now() - start}ms` + (err ? ` with error: ${err.message}` : ''));
		}
	}

	getTool(name: string): LanguageModelToolInformation | undefined {
		return this._disabledTools.has(name) ? undefined : (this._overrides.get(name)?.info || this._inner.getTool(name));
	}

	getToolByToolReferenceName(toolReferenceName: string): LanguageModelToolInformation | undefined {
		const contributedTool = packageJson.contributes.languageModelTools.find(tool => tool.toolReferenceName === toolReferenceName && tool.canBeReferencedInPrompt);
		if (contributedTool) {
			return {
				name: contributedTool.name,
				description: contributedTool.modelDescription,
				inputSchema: contributedTool.inputSchema,
				source: undefined,
				tags: []
			};
		}

		return undefined;
	}

	getEnabledTools(request: ChatRequest, filter?: (tool: LanguageModelToolInformation) => boolean | undefined): LanguageModelToolInformation[] {
		const packageJsonTools = getPackagejsonToolsForTest();
		return this.tools.filter(tool => filter?.(tool) ?? (!this._disabledTools.has(getToolName(tool.name)) && packageJsonTools.has(tool.name)));
	}

	addTestToolOverride(info: LanguageModelToolInformation, tool: LanguageModelTool<unknown>): void {
		if (!this._disabledTools.has(info.name)) {
			this._overrides.set(info.name as ToolName, { tool, info });
		}
	}
}
