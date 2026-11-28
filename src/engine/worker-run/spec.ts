// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

/**
 * A native worker run's spec decode and process setup: the checks that land
 * before any model call, then the fresh process's provider, settings and
 * safety state and the run's synthesized model.
 */

import { configureGuardrails, guardrailValuesFromSettings } from "../../core/guardrails.js";
import { workerSandboxConfinesWrites, workerSandboxReadableRoots } from "../../core/sandbox/worker-process.js";
import { readLayeredSettings } from "../../core/settings-layers.js";
import { agentSkillToolPolicy } from "../../core/skill-activation.js";
import { ToolNames } from "../../core/tool-names.js";
import { parseWorkerResultContract } from "../../domains/agents/result-contract.js";
import { internalHelperResultSchema } from "../../domains/agents/result-contract-schema.js";
import { applyModelCapabilityPatch } from "../../domains/providers/index.js";
import { createProfileKnowledgeBase } from "../../domains/providers/profile-knowledge.js";
import type { KnowledgeBase } from "../../domains/providers/types/knowledge-base.js";
import { setValidationWrappers } from "../../domains/safety/check-prefix.js";
import { registerFauxFromEnv } from "../ai.js";
import { registerPancodeApiProviders, setGlobalDefaultMaxOutputTokens } from "../apis/index.js";
import { assertResponseSchemaRuntime } from "../worker-result-contract.js";
import type { WorkerRunInput } from "../worker-run-types.js";
import { createWorkerSafety } from "../worker-tools.js";

let kbSingleton: KnowledgeBase | null = null;

function getKnowledgeBase(): KnowledgeBase {
	if (kbSingleton) return kbSingleton;
	// Stdout is the NDJSON lane, so a profile file or overlay that fails to load is left silent here;
	// the orchestrator reports it once and the worker resolves from the live server instead.
	kbSingleton = createProfileKnowledgeBase();
	return kbSingleton;
}

/**
 * Whether the resolved runtime mediates tool calls at all. Exported so the
 * worker entry attests the same tool surface this run will actually build.
 */
export function workerProviderSupportsTools(input: WorkerRunInput): boolean {
	const runtimeDecision = input.runtimeResolution?.capabilities.tools;
	if (runtimeDecision !== undefined) return runtimeDecision === true;
	if (typeof input.modelCapabilities?.tools === "boolean") return input.modelCapabilities.tools;
	return input.runtime.defaultCapabilities.tools === true;
}

/** Check the wire spec before any model call and derive what the run reads from its contract. */
export function decodeWorkerSpec(input: WorkerRunInput) {
	assertResponseSchemaRuntime(input);
	if (input.contextSeed && input.runtime.kind !== "http")
		throw new Error("worker context: history seeds require a native Pi runtime");
	// The wire carries the contract as data; the one strict parser owns its
	// shape. The worker subprocess may not import it (it stays slim), so the
	// check lands here, before any model call. The wire parser, not the recipe
	// one: a dispatch request may override the seated recipe's postcondition
	// with a kind the coordinator authors, and the recipe parser refusing those
	// killed every council vote member with a fatal spec error.
	if (input.resultContract !== undefined) parseWorkerResultContract(input.resultContract, "WorkerSpec.resultContract");
	const mutationResult = input.resultContract?.kind === "mutation-report";
	const helperSchema =
		input.helperResult === true && input.resultContract ? internalHelperResultSchema(input.resultContract) : null;
	if (input.helperResult === true && (helperSchema === null || input.runtime.kind !== "http")) {
		throw new Error("helperResult requires a supported internal JSON contract and native HTTP worker");
	}
	return { mutationResult, helperSchema };
}

/** Install the fresh worker process's provider, settings and safety state, and synthesize the run's model. */
export function prepareNativeWorker(input: WorkerRunInput) {
	// pi-ai is process-local. The orchestrator registers PanCode API providers in
	// providers/extension.ts, but the worker subprocess starts a fresh process,
	// so it must register them here before any agent.prompt() touches a local
	// runtime (lmstudio, ollama).
	registerPancodeApiProviders();
	// The worker is a fresh process. Resolve its workspace's trusted settings
	// layers so project output limits and guardrails survive dispatch. Keep the
	// best-effort read: the parent already surfaced settings diagnostics, and
	// untrusted or changed project settings must still fall back to lower layers.
	const workerSettings = readLayeredSettings(input.cwd ?? process.cwd()).settings;
	setGlobalDefaultMaxOutputTokens(workerSettings.chat.maxOutputTokens);
	// Same mirroring for guardrail policy: the fresh process needs its settings
	// projection installed before any registry or tool construction reads it.
	configureGuardrails(guardrailValuesFromSettings(workerSettings));
	// The worker's own check readings look through the same declared wrappers as the parent's (FX-44).
	setValidationWrappers(workerSettings.safety.validationWrappers);
	const fauxModel = registerFauxFromEnv();
	// Workers are bounded runs against an admission-verified recipe surface.
	// They have no operator to widen a missing tool, so the active surface is
	// exactly the admitted set.
	const agentSkillPolicy =
		input.allowedTools.includes(ToolNames.Context) && input.noSkills !== true
			? agentSkillToolPolicy(
					input.agentSkills ?? [],
					input.resultContract?.kind === "architect-plan" && input.allowedTools.includes(ToolNames.Artifact)
						? [ToolNames.Artifact]
						: [],
				)
			: undefined;
	const activeWorkerTools = workerProviderSupportsTools(input) ? input.allowedTools : [];

	const kb = getKnowledgeBase();
	const kbHit = kb.lookup(input.wireModelId, input.runtime.id);
	const synthesized = input.runtime.synthesizeModel(input.target, input.wireModelId, kbHit);
	const model = applyModelCapabilityPatch(fauxModel ?? synthesized, input.modelCapabilities);

	// Per-run safety contract: one loop-detector state per worker subprocess.
	// The loop guard rides on the registry's middleware contract as a
	// before_tool registration (engine/loop-guard.ts), so admission and
	// repetition detection share one seam; there is no agent-loop hook anymore.
	const safety = createWorkerSafety({
		...(input.readOnly !== true &&
		input.resultContract?.kind === "architect-plan" &&
		input.allowedTools.includes(ToolNames.Artifact)
			? { requiredArtifactPath: input.resultContract.path }
			: {}),
		...(input.flowPolicy !== undefined ? { flowPolicy: input.flowPolicy } : {}),
		...(input.taskGit?.taskWorktree !== undefined ? { taskWorktreeRoot: input.taskGit.taskWorktree.path } : {}),
		cwd: process.cwd(),
		...(input.writeRoots !== undefined ? { writeRoots: input.writeRoots } : {}),
		// The host decided once whether the run's commands are bound to its roots: an OS sandbox, or its own
		// worktree whose merge-back takes only the roots (fleet M7). The worker does not probe it again.
		...(input.writeRoots !== undefined && input.writeRootsCommandsBounded === true ? { writeRootsOsConfined: true } : {}),
		// Its bash meets main bash's contained verdict for hidden content inside that sandbox (row 371).
		...(workerSandboxConfinesWrites() ? { sandboxConfinesWrites: true } : {}),
		readExemptRoots: workerSandboxReadableRoots(),
		...(input.protectedArtifactState !== undefined
			? { protectedArtifactState: { artifacts: [...input.protectedArtifactState.artifacts] } }
			: {}),
	});
	return { workerSettings, agentSkillPolicy, activeWorkerTools, model, safety };
}
