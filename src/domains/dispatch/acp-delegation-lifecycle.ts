// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * ACP delegation admission and prompt staging: the refusals a peer target owes before it starts, and the
 * lifecycle stage (admission, path scope, bounded persona, opted-in project context, prompt hashes) the
 * delegated run seals. Lifted from createDispatchBundle; the bundle passes its agents, safety, project
 * context and ledger assignment reader.
 */

import { sha256Hex } from "../../core/hash.js";
import type { WorkerPromptMessage } from "../../worker/spec-contract.js";
import type { AgentsContract } from "../agents/contract.js";
import type { AgentProjectContextTier } from "../agents/spec.js";
import type { ConfigContract } from "../config/contract.js";
import type { ContextContract } from "../context/contract.js";
import type { AutonomyLevel } from "../safety/autonomy.js";
import type { SafetyContract } from "../safety/contract.js";
import { type DispatchAdmissionStage, requestOriginFor, resolveDelegationAdmissionStage } from "./admission-scope.js";
import type { LedgerAssignment } from "./agent-ledger.js";
import type { DispatchRequest } from "./contract.js";
import type { EffectiveSettings } from "./envelope-stage.js";
import { dispatchResultContract } from "./execution-role.js";
import { type DispatchPathScope, resolveDispatchPathScope } from "./path-scope.js";
import { acpRuntimeLimitations } from "./runtime-enforceability.js";
import type {
	DispatchRequestOrigin,
	RunBriefingProvenance,
	RunPersonaOverride,
	RunPipelineProvenance,
	RunProjectContextProvenance,
} from "./types.js";
import {
	assertWorkerContextRequest,
	briefingProvenanceFor,
	buildDynamicPromptMessages,
	hasCallerPersonaOverride,
	personaOverrideFor,
	pipelineProvenanceFor,
	projectContextProvenanceFor,
	promptCompositionHash,
	promptHash,
	readWorkspaceRootFacts,
	workerPersonaBody,
	workerProjectPrompt,
} from "./worker-dynamic-prompt.js";

interface AcpDelegationLifecycleStage {
	admission: DispatchAdmissionStage;
	pathScope: DispatchPathScope;
	agentConfig: ReturnType<ConfigContract["get"]>["integrations"]["externalAgents"]["entries"][number];
	cwd: string;
	systemPrompt: string;
	dynamicPromptMessages: ReadonlyArray<WorkerPromptMessage>;
	compiledPromptHash: string | null;
	staticCompositionHash: string | null;
	sessionShellHash: string | null;
	dynamicHash: string | null;
	promptSignature: string | null;
	/** External ACP tool inventory is not observable; null is an explicit unknown, never a synthetic empty surface. */
	toolSignature: null;
	runtimeLimitations: string[];
	requestOrigin: DispatchRequestOrigin;
	pipeline: RunPipelineProvenance | null;
	briefing: RunBriefingProvenance | null;
	personaOverride: RunPersonaOverride | null;
	/** Decision refs sealed on the request by the dispatch tool; null when the parent board was empty. */
	decisionRefs: ReadonlyArray<string> | null;
	projectContext: RunProjectContextProvenance;
	/** ACP delegation bypasses the worker prompt compiler entirely, so this is always []. */
	rulesApplied: string[];
	/** ACP delegation bypasses the worker prompt compiler entirely, so this is always false. */
	operatorProfileApplied: boolean;
	autonomy: AutonomyLevel;
}

export interface AcpDelegationLifecycleScope {
	maybeAgents: AgentsContract | undefined;
	safety: SafetyContract;
	projectContext: ContextContract | undefined;
	ledgerAssignmentsFor: (req: DispatchRequest, scope: DispatchPathScope) => ReadonlyArray<LedgerAssignment>;
}

export function resolveAcpDelegationLifecycle(
	{ ledgerAssignmentsFor, maybeAgents, projectContext, safety }: AcpDelegationLifecycleScope,
	req: DispatchRequest,
	settings: EffectiveSettings,
): AcpDelegationLifecycleStage {
	const agentId = req.delegationAgentId;
	if (!agentId) throw new Error("dispatch: missing delegationAgentId");
	if (hasCallerPersonaOverride(req)) {
		throw new Error(`dispatch: persona overrides are not allowed for ACP delegation agent '${agentId}'`);
	}
	// Fleet profiles and worker runtimes route native workers; a peer runs its own route, so either would be dropped.
	const nativeRouting = [
		...(req.workerProfile !== undefined ? [`agent profile '${req.workerProfile}'`] : []),
		...(req.workerRuntime !== undefined ? [`agent runtime '${req.workerRuntime}'`] : []),
	];
	if (nativeRouting.length > 0) {
		throw new Error(
			`dispatch: delegation admission refused: ACP delegation agent '${agentId}' runs its own route and cannot honour ${nativeRouting.join(" or ")}; drop the flag or dispatch a native agent`,
		);
	}
	if (req.agentId && maybeAgents) {
		const spec = maybeAgents.getSpec(req.agentId);
		if (spec && (spec.audience === "shadow" || spec.audience === "internal")) {
			throw new Error(`dispatch: shadow or internal agent '${req.agentId}' cannot run on external ACP agent '${agentId}'`);
		}
		// A summary allowance on a recipe with no summary field fails here,
		// before the external agent is started.
		dispatchResultContract(req, spec);
	}
	assertWorkerContextRequest(req, false);
	if (req.storeTags !== undefined && req.storeTags.length > 0) {
		throw new Error(
			"dispatch: store tags cannot be granted to an ACP delegation target; the external agent has no PanCode store tool. Dispatch to a native worker.",
		);
	}
	if (!settings) throw new Error("dispatch: effective settings required for ACP delegation");
	const configured = settings.integrations.externalAgents.entries.find((entry) => entry.id === agentId);
	if (!configured) throw new Error(`dispatch: ACP delegation agent '${agentId}' not configured`);
	const toolGovernance = configured.toolGovernance ?? "pancode-policy";
	// A peer asks only about the calls it chooses to, under every governance,
	// so no ACP peer can keep a read-only run from changing user files.
	if (req.readOnly === true) {
		throw new Error(
			`dispatch: ACP delegation agent '${agentId}' cannot run read-only work: a peer's permission requests cover only the calls it chooses to ask about, so PanCode cannot keep it from changing user files; choose a native, claude-sdk or codex-cli target`,
		);
	}
	// Operator decision Q6: agent-managed governance approves every call the
	// peer asks about, so PanCode mediates nothing and the run needs the
	// operator's explicit trust.
	if (toolGovernance === "agent-managed" && configured.trustedUnmediated !== true) {
		throw new Error(
			`dispatch: ACP delegation agent '${agentId}' uses toolGovernance='agent-managed', so PanCode cannot mediate its tool calls and it is refused write-capable work; choose pancode-policy or deny-all governance, or set trustedUnmediated: true on integrations.externalAgents.entries '${agentId}' to accept the agent's own authority`,
		);
	}
	const admission = resolveDelegationAdmissionStage(req, safety);
	const autonomy = "default";
	const cwd = req.cwd ?? process.cwd();
	const pathScope = resolveDispatchPathScope(req);
	const personaBody = workerPersonaBody(req, null, false);
	// ACP owns an unknown external tool inventory, so it receives the raw
	// bounded persona rather than a native PanCode schema-harness claim.
	const systemPrompt = personaBody;
	// ACP delegation defaults to no project context: repo conventions and
	// invariants never leave the machine unless this agent's config opts in
	// with projectContext: "bounded". No recipe means no capability class,
	// so no derived verification supplement is added. Authored test guidance
	// stays intact within the opted-in source budget. The safety posture
	// line still rides along for every worker run.
	const tier: AgentProjectContextTier = configured.projectContext ?? "none";
	const projectPrompt =
		projectContext && tier === "bounded" ? workerProjectPrompt(projectContext, cwd, req.protectedArtifactRemap) : null;
	const dynamicPromptMessages = buildDynamicPromptMessages(req, {
		ledgerAssignments: ledgerAssignmentsFor(req, pathScope),
		agentId,
		workingContextPaths: pathScope.workingContextPaths,
		cwd,
		projectContextTier: tier,
		autonomy,
		projectPrompt,
		projectReadTools: null,
		projectExternalReadTools: true,
		workspace: readWorkspaceRootFacts(cwd, req.taskWorktree?.root),
	});
	const projectContextProvenance = projectContextProvenanceFor(tier, dynamicPromptMessages);
	const dynamicText = dynamicPromptMessages.map((message) => message.body).join("\n\n");
	const compiledPromptHash = promptCompositionHash([
		systemPrompt,
		dynamicText,
		...(req.contextSeed ? [req.contextSeed.provenance.contentHash] : []),
	]);
	const staticCompositionHash = promptHash(systemPrompt);
	const sessionShellHash = staticCompositionHash;
	const dynamicHash = dynamicPromptMessages.length > 0 ? sha256Hex(dynamicText) : sha256Hex("");
	const personaOverride = personaOverrideFor(req, staticCompositionHash);
	return {
		admission,
		pathScope,
		agentConfig: configured,
		cwd,
		systemPrompt,
		dynamicPromptMessages,
		compiledPromptHash,
		staticCompositionHash,
		sessionShellHash,
		dynamicHash,
		promptSignature: compiledPromptHash,
		toolSignature: null,
		requestOrigin: requestOriginFor(req),
		runtimeLimitations: acpRuntimeLimitations(),
		pipeline: pipelineProvenanceFor(req),
		briefing: briefingProvenanceFor(req),
		personaOverride,
		decisionRefs: req.decisionRefs ?? null,
		projectContext: projectContextProvenance,
		rulesApplied: [],
		operatorProfileApplied: false,
		autonomy,
	};
}
