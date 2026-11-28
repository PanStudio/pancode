// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { doesNotMatch, match, notStrictEqual, ok, strictEqual } from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { loadDomains } from "../../src/core/domain-loader.js";
import { telemetryHub } from "../../src/core/telemetry/hub.js";
import type { AgentsContract } from "../../src/domains/agents/index.js";
import { AgentsDomainModule } from "../../src/domains/agents/module.js";
import { ConfigDomainModule } from "../../src/domains/config/module.js";
import { createContextDomainModule } from "../../src/domains/context/module.js";
import { ExtensionsDomainModule } from "../../src/domains/extensions/module.js";
import { ensurePancodeState } from "../../src/domains/install/index.js";
import { InteropDomainModule } from "../../src/domains/interop/module.js";
import { createMiddlewareDomain } from "../../src/domains/middleware/module.js";
import { PluginsDomainModule } from "../../src/domains/plugins/module.js";
import { createPromptsDomainModule } from "../../src/domains/prompts/module.js";
import type { ProvidersContract } from "../../src/domains/providers/index.js";
import { ResourcesDomainModule } from "../../src/domains/resources/module.js";
import { SafetyDomainModule } from "../../src/domains/safety/module.js";
import { SessionDomainModule } from "../../src/domains/session/module.js";
import { createTurnContext } from "../../src/session-control/turn-context.js";
import type { TurnMiddleware } from "../../src/session-control/turn-middleware.js";
import { type AgentRuntime, createTurnState } from "../../src/session-control/turn-state.js";
import { type IsolatedPancodeEnv, isolatePancodeEnv } from "../harness/scratch-env.js";

describe("external-agent settings reach the session prompt cache", { concurrency: false }, () => {
	let scratch: IsolatedPancodeEnv;
	let originalCwd: string;

	beforeEach(async () => {
		scratch = await isolatePancodeEnv("pancode-external-agent-prompt-");
		originalCwd = process.cwd();
		const cwd = join(scratch.dir, "workspace");
		mkdirSync(cwd);
		process.chdir(cwd);
		ensurePancodeState();
	});

	afterEach(() => {
		process.chdir(originalCwd);
		scratch.restore();
	});

	it("reflects additions, command edits, and removals without invalidating for unrelated settings", async () => {
		const loaded = await loadDomains([
			ConfigDomainModule,
			SafetyDomainModule,
			ExtensionsDomainModule,
			PluginsDomainModule,
			ResourcesDomainModule,
			AgentsDomainModule,
			SessionDomainModule,
			createContextDomainModule({ noContextFiles: true }),
			createMiddlewareDomain().module,
			InteropDomainModule,
			createPromptsDomainModule({ noContextFiles: true }),
		]);
		try {
			const config = loaded.getContract("config");
			const agents = loaded.getContract("agents");
			const prompts = loaded.getContract("prompts");
			ok(config?.update && agents && prompts);
			const turn = createTurnContext({
				state: createTurnState("off"),
				getSettings: config.get,
				prompts,
				// Runtime metadata suffices: this path compiles prompts without a model request.
				providers: { getRuntime: () => undefined } as unknown as ProvidersContract,
				middleware: {} as TurnMiddleware,
				emitNotice: () => {},
			});
			const runtime = {
				targetId: "local",
				runtimeId: "llama.cpp",
				wireModelId: "model",
				runtimeResolution: {
					capabilityDecisions: { tools: true },
					contextWindowDetails: { effectiveContextWindow: 32_768, contextWindowSource: "loaded" },
				},
				agent: {
					state: {
						systemPrompt: "",
						thinkingLevel: "off",
						messages: [],
						tools: [{ name: "dispatch", description: "Dispatch", parameters: { type: "object", properties: {} } }],
					},
				},
			} as unknown as AgentRuntime;
			try {
				const first = await turn.ensureSessionPrompt(runtime);
				ok(first);
				const epoch = prompts.inputEpoch();
				config.update((settings) => {
					settings.fleet.history.maxRuns = 50;
				}, "settings-ui");
				strictEqual(prompts.inputEpoch(), epoch);
				strictEqual(await turn.ensureSessionPrompt(runtime), first, "unrelated settings preserve the cached object");

				config.update((settings) => {
					settings.integrations.externalAgents.entries = [{ id: "catalog-fixture", command: "fixture-one", args: [] }];
				}, "settings-ui");
				ok(agents.getSpec("catalog-fixture"));
				const added = await turn.ensureSessionPrompt(runtime);
				match(added?.systemPrompt ?? "", /catalog-fixture.*fixture-one/u);
				notStrictEqual(prompts.inputEpoch(), epoch);
				strictEqual(await turn.ensureSessionPrompt(runtime), added);

				config.update((settings) => {
					const agent = settings.integrations.externalAgents.entries[0];
					ok(agent);
					agent.command = "fixture-two";
				}, "settings-ui");
				const edited = await turn.ensureSessionPrompt(runtime);
				match(edited?.systemPrompt ?? "", /catalog-fixture.*fixture-two/u);
				doesNotMatch(edited?.systemPrompt ?? "", /fixture-one/u);

				config.update((settings) => {
					settings.integrations.externalAgents.entries = [];
				}, "settings-ui");
				strictEqual(agents.getSpec("catalog-fixture"), null);
				const removed = await turn.ensureSessionPrompt(runtime);
				ok(removed);
				doesNotMatch(removed.systemPrompt, /catalog-fixture/u);
				strictEqual(removed.systemPrompt, first.systemPrompt);
			} finally {
				turn.dispose();
			}
		} finally {
			await loaded.stop();
		}
	});

	it("stops observing config when the agents lifecycle ends", async () => {
		const loaded = await loadDomains([ConfigDomainModule]);
		try {
			const config = loaded.getContract("config");
			ok(config?.update);
			const agents = await AgentsDomainModule.createExtension({ bus: telemetryHub(), getContract: loaded.getContract });
			const contract = agents.contract as AgentsContract;
			try {
				await agents.extension.start();
				const initial = contract.revision();
				config.update((settings) => {
					settings.integrations.externalAgents.entries = [{ id: "catalog-fixture", command: "fixture", args: [] }];
				}, "settings-ui");
				notStrictEqual(contract.revision(), initial);
			} finally {
				await agents.extension.stop?.();
			}
			const stopped = contract.revision();
			config.update((settings) => {
				settings.integrations.externalAgents.entries = [];
			}, "settings-ui");
			strictEqual(contract.revision(), stopped);
		} finally {
			await loaded.stop();
		}
	});
});
