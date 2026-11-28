// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * Admission checks that a run's runtime can honor what its request and permit ask for: main-agent grants,
 * permission mode, write roots, deny lists, tool and schema support, protected artifacts, flow handoffs and
 * planned node identity, plus the limitations each runtime declares.
 */

import {
	responseSchemaConflictsWithTools,
	runtimeSpeaksResponseSchemaDialect,
	UnsupportedResponseSchemaError,
} from "../../core/response-schema.js";
import { WORKER_RUNTIME_MEDIATES_PANCODE_DISPATCH } from "../../engine/worker-runtime-capabilities.js";
import { agentHasTrait, type normalizeAgentSpec, resolveAgentToolCompatibility } from "../agents/spec.js";
import { type CapabilityFlags, type RuntimeDescriptor, runtimeEnforcement } from "../providers/index.js";
import { type FlowRestrictionSet, flowHandoffRefusal } from "../safety/information-flow.js";
import type { ProtectedArtifactState } from "../safety/protected-artifacts.js";
import { mainGrantsUnavailable, type WorkerPermit } from "../safety/worker-permit.js";
import type { DispatchRequest } from "./contract.js";
import { envelopeToolNames, type WorkerEnvelope, waivedRequirements } from "./envelope.js";
import type { ResolvedTarget } from "./target-resolution.js";
import type { RunKind, RunNodeIdentity } from "./types.js";
import type { WorkerPermissionMode } from "./worker-dynamic-prompt.js";

export function runtimeLimitations(runtimeKind: RunKind, runtimeId: string): string[] {
	if (runtimeKind === "sdk" && runtimeId === "claude-sdk") {
		return ["Claude Agent SDK executes Claude Code tools; PanCode mediates canUseTool decisions and records denials"];
	}
	if (runtimeKind === "subprocess" && runtimeId === "claude-code") {
		return [
			"Claude CLI subprocess executes Claude Code tools; PanCode constrains permission mode and forbids dangerous bypass unless explicitly gated",
		];
	}
	if (runtimeKind === "subprocess" && runtimeId === "codex-cli") {
		return [
			"Codex CLI executes its own tools; PanCode selects a Codex sandbox mode but cannot mediate individual tool calls or observe a complete tool trace",
			"Codex CLI login and model configuration belong to the installed codex command; PanCode only observes its JSONL run stream",
		];
	}
	if (runtimeKind === "subprocess" && runtimeId === "opencode-cli") {
		return [
			"OpenCode CLI owns its tools and permissions; PanCode observes JSON run events but cannot enforce read-only or per-tool write boundaries on this headless path",
		];
	}
	if (runtimeKind === "subprocess" && runtimeId === "pi-cli") {
		return [
			"Pi CLI owns its tools; PanCode can select a built-in read-only allowlist, but cannot mediate individual calls or confine edits to declared write roots",
		];
	}
	if (runtimeKind === "subprocess" && runtimeId === "antigravity-code") {
		return [
			"Antigravity CLI owns its internal tools, network activity, prompts, and approvals; PanCode observes only structured stream output and does not provide per-tool mediation or complete tool telemetry",
			"Antigravity resumes a conversation only when the caller supplies its id explicitly",
			"Antigravity runs are one-shot and never retried automatically",
		];
	}
	// HTTP/native runtimes run through pi-agent-core, which PanCode observes and
	// controls directly, so there are no runtime-imposed dispatch limitations.
	return [];
}

/**
 * Live main-agent grants exist only for a single local native run whose
 * caller can yield (Phase D). Every other route to a main-authority permit is
 * an admission error naming why, never a silent downgrade.
 */
export function assertMainGrantRoutable(
	req: DispatchRequest,
	runtime: RuntimeDescriptor,
	permit: WorkerPermit,
	node?: RunNodeIdentity | null,
): void {
	if (!mainGrantsUnavailable(permit.allowance)) return;
	const route = req.mainGrantRoute;
	const why =
		runtime.kind !== "http"
			? `runtime '${runtime.id}' has no live grant path; claude-sdk, ACP and subprocess workers cannot park an ask for the main agent yet`
			: node !== undefined && node !== null && node.kind !== "local"
				? `node '${node.id}' is remote, and remote workers cannot receive a bound grant yet`
				: route?.kind === "refused"
					? `this dispatch cannot yield to the main agent: ${route.reason}`
					: req.ownerSessionId === undefined || req.ownerSessionId === null
						? "the run has no owning session to decide its asks"
						: null;
	if (why === null) return;
	throw new Error(
		`dispatch: fleet.permissions.mode=main routes worker asks to the main agent, but ${why}; use fleet.permissions.mode escalate or deny for this work`,
	);
}

export function assertRuntimeCanHonorWorkerPermissionMode(
	runtime: RuntimeDescriptor,
	onPermission: WorkerPermissionMode,
): void {
	if (onPermission === "deny") return;
	// The runtime's enforcement descriptor decides (F10): fail needs per-call
	// mediation, escalate also needs a call that can park and resume.
	const enforcement = runtimeEnforcement(runtime);
	if (!enforcement.perCallMediation) {
		throw new Error(
			`dispatch: runtime '${runtime.id}' cannot enforce fleet.permissions.mode='${onPermission}' because subprocess workers do not expose per-tool permission mediation; set fleet.permissions.mode='deny' or choose a mediated runtime`,
		);
	}
	if (onPermission === "escalate" && !enforcement.grantPauseResume) {
		throw new Error(
			`dispatch: runtime '${runtime.id}' cannot enforce fleet.permissions.mode='escalate' because its SDK permission callback cannot park for an operator decision; choose 'deny' or 'fail', or use a native mediated runtime`,
		);
	}
}

/**
 * Fail closed when writeRoots are requested on a runtime that cannot enforce
 * them. Subprocess runtimes (claude-code, antigravity) run their own tool loop
 * without PanCode per-tool mediation, so a write-root confinement they cannot
 * honor is refused at admission rather than silently ignored. Mirrors
 * assertToolProfileEnforceable. Native (http) and claude-sdk runtimes mediate
 * every tool call through the shared worker safety seam and enforce it.
 */
export function assertWriteRootsEnforceable(
	runtime: RuntimeDescriptor,
	writeRoots: ReadonlyArray<string> | undefined,
): void {
	if (!writeRoots || writeRoots.length === 0) return;
	if (runtimeEnforcement(runtime).scopeEnforcement) return;
	throw new Error(
		`dispatch: runtime '${runtime.id}' cannot enforce writeRoots: subprocess workers run their own tool surface without PanCode per-tool mediation. Dispatch to a native or claude-sdk worker.`,
	);
}

/** An external CLI runs its own tool surface, so a per-tool deny list cannot reach it. */
export function assertDenyToolsEnforceable(
	runtime: RuntimeDescriptor,
	denyTools: ReadonlyArray<string> | undefined,
): void {
	if (runtime.kind === "subprocess" && denyTools !== undefined && denyTools.length > 0) {
		throw new Error("dispatch: denyTools cannot be enforced on an external CLI connection; use a native worker");
	}
}

export function assertPostRuntimeToolCompatibility(
	agentId: string,
	spec: ReturnType<typeof normalizeAgentSpec>,
	envelope: WorkerEnvelope,
	target: ResolvedTarget,
): void {
	// A recipe declaring `peer-tool-loop` (the shipped coder) may use a named
	// subprocess peer. Its native PanCode tool requirements cannot be matched to the
	// peer's opaque tool loop. Every other recipe stays on the normal compatibility
	// gate, since its declared required tools are hard promises we cannot silently
	// waive. The receipt records the external tool boundary as unavailable
	// telemetry and approximated authority; write roots and protected artifacts
	// keep their separate gates.
	if (target.runtime.kind === "subprocess" && agentHasTrait(spec, "peer-tool-loop")) return;
	const compatibility = resolveAgentToolCompatibility(spec, envelopeToolNames(envelope), {
		mediatesDispatch: WORKER_RUNTIME_MEDIATES_PANCODE_DISPATCH,
		waived: waivedRequirements(envelope),
	});
	if (compatibility.compatible) return;
	// Name the layer that removed the tool: blaming the runtime sends the caller
	// to another model when its own write roots caused the refusal.
	const unconfined = envelope.withheld.filter(
		(entry) => entry.reason === "write-roots-unconfined" && compatibility.missingRequired.includes(entry.capability),
	);
	const cause =
		unconfined.length > 0
			? `; declared write roots ${envelope.write.roots.join(", ")} have no OS sandbox or worktree binding commands to them here, so ${unconfined.map((entry) => entry.capability).join(", ")} ${unconfined.length === 1 ? "is" : "are"} withheld. Enable safety.sandbox (auto or required) with a usable bubblewrap backend where the worker runs, run in a git checkout, or omit write roots`
			: "";
	throw new Error(
		`dispatch: admission denied: agent '${agentId}' is incompatible with runtime '${target.runtime.id}' after tool narrowing; missing required tools: ${compatibility.missingRequired.join(", ")}${cause}`,
	);
}

export function assertProtectedArtifactsEnforceable(
	runtimeLabel: string,
	enforceable: boolean,
	state: ProtectedArtifactState,
): void {
	if (state.artifacts.length === 0 || enforceable) return;
	throw new Error(
		`dispatch: runtime '${runtimeLabel}' cannot enforce ${state.artifacts.length} protected artifact hard block(s); choose a native or claude-sdk worker`,
	);
}

/** An unmediated handoff of restricted context is refused; nothing on that path judges its sends. */
export function assertFlowHandoffMediated(path: string, restrictions: FlowRestrictionSet | null): void {
	const refusal = flowHandoffRefusal(path, restrictions);
	if (refusal !== null) throw new Error(refusal);
}

export function assertPlannedNodeIdentity(req: DispatchRequest, actual: RunNodeIdentity): void {
	const planned = req.plannedNode;
	if (planned === undefined) return;
	if (planned.id === actual.id && planned.kind === actual.kind && (planned.host ?? null) === (actual.host ?? null))
		return;
	throw new Error(
		`dispatch: approved node identity drifted: planned ${planned.id}/${planned.kind}/${planned.host ?? "-"}, resolved ${actual.id}/${actual.kind}/${actual.host ?? "-"}`,
	);
}

/** Fail closed until another runtime has an explicitly tested JSON-schema wire contract. */
export function assertResponseSchemaEnforceable(
	runtime: RuntimeDescriptor,
	capabilities: CapabilityFlags | null,
	responseSchema: Record<string, unknown> | undefined,
	toolCount: number,
): void {
	if (responseSchema === undefined) return;
	if (runtimeSpeaksResponseSchemaDialect(runtime)) {
		if (responseSchemaConflictsWithTools(runtime, toolCount)) {
			throw new UnsupportedResponseSchemaError(
				"dispatch: this runtime compiles a response schema into a sampler grammar and cannot build it beside a tool grammar; a run carrying both is refused before it is spent",
			);
		}
		if (capabilities?.structuredOutputs === "json-schema") return;
		throw new UnsupportedResponseSchemaError(
			"dispatch: responseSchema requires resolved structuredOutputs='json-schema'; the selected llama.cpp connection/model reports no enforceable schema support",
		);
	}
	throw new UnsupportedResponseSchemaError(
		`dispatch: responseSchema requires the native llamacpp runtime; runtime '${runtime.id}' cannot enforce it`,
	);
}

export function acpRuntimeLimitations(): string[] {
	return [
		"external ACP agent executes its own unknown tool surface; PanCode mediates permission requests and records decisions",
	];
}
