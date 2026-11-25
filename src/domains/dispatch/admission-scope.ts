// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * The scope stage of dispatch admission: the orchestrator and worker scopes, write boundaries, shared-store grants,
 * external-read shape, and the requested action classes a run is admitted with.
 */

import { relative, resolve as resolvePath } from "node:path";
import { asDirectoryPathBoundary } from "../../core/path-boundary.js";
import { canonicalizeExistingPath } from "../../core/path-canonical.js";
import { relativePathEscapes } from "../../core/path-containment.js";
import { storeGrantBoundaries, storeProjectIdFor, storeProjectRoot } from "../../core/store-paths.js";
import { prepareSharedStoreGrant, type SharedStoreGrant } from "../../core/store-shared-grant.js";
import { isBuiltinToolName, isMcpToolName, type ToolName, ToolNames } from "../../core/tool-names.js";
import { applyToolProfile, assertToolProfileEnforceable, type ToolProfileName } from "../../tools/profiles.js";
import type { AgentRecipe } from "../agents/recipe.js";
import { isHoareResultContract } from "../agents/result-contract-types.js";
import { type AgentSpec, assertAgentSpecPolicy, isReadOnlyExplorer, normalizeAgentSpec } from "../agents/spec.js";
import type { ActionClass } from "../safety/action-classifier.js";
import type { SafetyContract } from "../safety/contract.js";
import type { ScopeSpec } from "../safety/scope.js";
import type { WorkerMcpAttestation } from "../safety/worker-permit.js";
import { openStoreBackend } from "../store/index.js";
import { admit } from "./admission.js";
import type { DispatchRequest } from "./contract.js";
import { dispatchResultContract } from "./execution-role.js";
import { requestedWriteNone } from "./obligation.js";
import { type DispatchPathScope, resolveDispatchPathScope } from "./path-scope.js";
import type { DispatchRequestOrigin, RunNodeIdentity } from "./types.js";
import {
	resolveWorkerMcpAdmission,
	type WorkerMcpNetworkWithheld,
	withholdWritableMcpNetwork,
	workerMcpScopeRefusal,
} from "./worker-mcp.js";

function pickOrchestratorScope(safety: SafetyContract): ScopeSpec {
	return safety.scopes.workspace;
}

/**
 * Write boundaries as the orchestrator sees them. A task worktree run reaches
 * admission with `req.cwd` already inside the worktree, so declared roots
 * resolve under the worktree path, which never sits inside the orchestrator's
 * workspace root. The worker is confined to those worktree paths, but the
 * subset check compares authority over the checkout, so each boundary is
 * mapped back onto the checkout the worktree was cut from.
 */
export function admissionWriteBoundaries(
	req: Pick<DispatchRequest, "taskWorktree">,
	boundaries: ReadonlyArray<string>,
): ReadonlyArray<string> {
	const worktree = req.taskWorktree;
	if (worktree === undefined) return boundaries;
	return boundaries.map((boundary) => {
		const directory = boundary.endsWith("/");
		const rel = relative(worktree.path, directory ? boundary.slice(0, -1) : boundary);
		if (relativePathEscapes(rel)) return boundary;
		const mapped = resolvePath(worktree.root, rel);
		return directory ? asDirectoryPathBoundary(mapped) : mapped;
	});
}

/**
 * A tag grant (M-31) adds each granted tag's directory and records directory to
 * a run that declared write roots. A run without declared roots already has the
 * workspace scope, which states this project's store directory. A run on an SSH
 * node gets none of this host's paths: its worker adds its own tag directories
 * once it has verified the grant's shared names.
 */
export function withStoreGrantBoundaries(
	req: DispatchRequest,
	pathScope: DispatchPathScope,
	node: () => RunNodeIdentity | null,
): DispatchPathScope {
	const tags = req.storeTags ?? [];
	if (tags.length === 0 || pathScope.writeBoundaries.length === 0) return pathScope;
	if (node()?.kind === "ssh") return pathScope;
	const granted = storeGrantBoundaries(req.cwd ?? process.cwd(), tags);
	return { ...pathScope, writeBoundaries: [...new Set([...pathScope.writeBoundaries, ...granted])] };
}

/** A store grant a read-only run cannot use; checked at preview and at run. */
export function storeGrantScopeRefusal(req: DispatchRequest, readOnly: boolean): string | null {
	const tags = req.storeTags ?? [];
	if (tags.length === 0 || !readOnly) return null;
	return `dispatch: admission denied: agent '${req.agentId}' runs read-only, so a store grant (tags: ${JSON.stringify(tags)}) contradicts its scope; dispatch a writing recipe or drop tags`;
}

export function missingStoreTagRefusal(tag: string): string {
	return `dispatch: admission denied: store tag '${tag}' does not exist; create it with store create before granting it`;
}

/** Refuse a tag grant a run cannot use: a read-only run, or a tag that does not exist. */
export async function assertStoreGrantAdmissible(req: DispatchRequest, readOnly: boolean): Promise<void> {
	const tags = req.storeTags ?? [];
	if (tags.length === 0) return;
	const scope = storeGrantScopeRefusal(req, readOnly);
	if (scope !== null) throw new Error(scope);
	const backend = await openStoreBackend(req.cwd ?? process.cwd());
	for (const tag of tags) {
		if (!(await backend.tagExists(tag))) throw new Error(missingStoreTagRefusal(tag));
	}
}

/**
 * A worker on an SSH node opens its own home's store. It reaches this project's store only through a root both
 * hosts mount, keyed by the tracked `store.projectId` rather than this checkout's path; without one the grant is
 * refused here. With one, the roots are checked at run and by the node.
 */
export function remoteStoreGrantRefusal(req: DispatchRequest, node: RunNodeIdentity | null): string | null {
	if (node?.kind !== "ssh" || req.storeTags === undefined || req.storeTags.length === 0) return null;
	if (storeProjectIdFor(storeProjectRoot(req.cwd ?? process.cwd())) !== undefined) return null;
	return `dispatch: admission denied: node '${node.id}' is remote, and a worker there reaches this project's store only when the project's tracked .pancode/settings.yaml sets store.projectId, so it cannot be granted tags ${JSON.stringify(req.storeTags)}; set store.projectId, run this task on the local node or drop tags`;
}

/** The dispatcher's names for an SSH run's granted tags, after each root is checked; null for any other run. */
export async function sharedStoreGrantFor(
	req: DispatchRequest,
	node: RunNodeIdentity | null,
	readOnly: boolean,
): Promise<SharedStoreGrant | null> {
	const tags = req.storeTags ?? [];
	if (node?.kind !== "ssh" || tags.length === 0 || readOnly) return null;
	const cwd = req.cwd ?? process.cwd();
	const facts = await (await openStoreBackend(cwd)).facts();
	return prepareSharedStoreGrant(
		cwd,
		tags,
		(root) => facts.roots.find((entry) => entry.name === root.name)?.sharedFs ?? "unverified",
		node.id,
	);
}

export const EXTERNAL_READ_APPROVAL_REQUIRED =
	"external_read_approval_required: Outside Scout reads require approval bound to this run and canonical root.";

/**
 * An outside read root admits only a read-only explorer recipe run read-only with that canonical root as its cwd.
 * The approval itself is bound to a run id minted after the plan, so preview checks the shape and run checks the
 * binding as well.
 */
export function externalReadShapeAdmissible(req: DispatchRequest, spec: AgentSpec | null): boolean {
	return (
		req.externalReadRoot === undefined ||
		(isReadOnlyExplorer(spec) &&
			req.readOnly === true &&
			canonicalizeExistingPath(req.cwd ?? "") === req.externalReadRoot)
	);
}

function pickWorkerScope(
	safety: SafetyContract,
	requestedActions: ReadonlyArray<ActionClass>,
	pathScope: DispatchPathScope,
): ScopeSpec {
	if (requestedActions.every((action) => action === "read")) return safety.scopes.readonly;
	if (pathScope.writeBoundaries.length === 0) return safety.scopes.workspace;
	return { ...safety.scopes.workspace, allowedWriteRoots: pathScope.writeBoundaries };
}

/** Action class for an ACP tool kind, the only tool identity an external agent reports. */
export function acpToolActionClass(tool: string): ActionClass {
	if (tool === "edit" || tool === "delete" || tool === "move") return "write";
	if (tool === "execute") return "execute";
	if (tool === "read" || tool === "search" || tool === "think" || tool === "fetch") return "read";
	return "unknown";
}

function deriveRequestedActions(
	tools: ReadonlyArray<ToolName>,
	safety: SafetyContract,
	mcp: WorkerMcpAttestation | null = null,
): ReadonlyArray<ActionClass> {
	const actions = new Set<ActionClass>();
	for (const tool of tools) {
		// An MCP name carries no class of its own; admission attested it once.
		const attested = isMcpToolName(tool)
			? mcp?.tools.find((entry) => `mcp_${entry.serverId}__${entry.tool}` === tool)
			: undefined;
		actions.add(isMcpToolName(tool) ? (attested?.actionClass ?? "unknown") : safety.classify({ tool }).actionClass);
	}
	return [...actions].sort();
}

export interface DispatchAdmissionStage {
	allowedTools: ReadonlyArray<ToolName>;
	requestedActions: ReadonlyArray<ActionClass>;
	toolProfile?: ToolProfileName;
	/** Every MCP capability the recipe names, resolved once from the dispatch's project root. */
	mcp?: WorkerMcpAttestation;
	/** Granted servers whose code this run can write, started without network. */
	mcpNetworkWithheld?: ReadonlyArray<WorkerMcpNetworkWithheld>;
}

/**
 * Whether a worker's result may cite external sources: it holds a web tool,
 * or an MCP capability it was offered belongs to a server that kept the
 * operator's network grant. That grant reaches only the server's process,
 * which is how such a worker reaches anything outside the workspace.
 */
export function workerHasNetworkPosture(admission: DispatchAdmissionStage): boolean {
	const tools = admission.allowedTools;
	if (tools.includes(ToolNames.WebFetch) || tools.includes(ToolNames.WebRead)) return true;
	return (admission.mcp?.tools ?? []).some(
		(entry) => entry.network === true && tools.includes(`mcp_${entry.serverId}__${entry.tool}` as ToolName),
	);
}

export function resolveDispatchAdmissionStage(
	req: DispatchRequest,
	recipe: AgentRecipe,
	safety: SafetyContract,
	pathScope: DispatchPathScope,
): DispatchAdmissionStage {
	const recipeTools = recipe.tools;
	const candidateTools = recipeTools && recipeTools.length > 0 ? (Array.from(recipeTools) as ToolName[]) : [];
	const allowedTools = applyToolProfile(candidateTools, req.toolProfile);
	assertAgentSpecPolicy(normalizeAgentSpec(recipe));
	const unavailableTools = allowedTools.filter((tool) => isBuiltinToolName(tool) && !candidateTools.includes(tool));
	if (unavailableTools.length > 0) {
		throw new Error(
			`dispatch: admission denied: agent '${req.agentId}' cannot expose undeclared tools: ${unavailableTools.join(", ")}`,
		);
	}
	// A task worktree's checkout holds the declarations and trust records the
	// operator reviewed; reading them from the worktree would see none of them.
	// A compete candidate carries its checkout only as the protected-artifact
	// remap's source root, with cwd set to its own worktree.
	const mcpInput = {
		agentId: req.agentId,
		projectCwd: req.taskWorktree?.root ?? req.protectedArtifactRemap?.sourceRoot ?? req.cwd ?? process.cwd(),
		tools: allowedTools,
	};
	let mcp = resolveWorkerMcpAdmission(mcpInput);
	const requestedActions = deriveRequestedActions(allowedTools, safety, mcp);
	const orchScope = pickOrchestratorScope(safety);
	const workerScope = pickWorkerScope(safety, requestedActions, {
		...pathScope,
		writeBoundaries: admissionWriteBoundaries(req, pathScope.writeBoundaries),
	});
	// A server's readOnlyHint can make every requested action read and so pick
	// the read-only scope; under it, as for the main agent's read-only turn,
	// only the operator's class counts, so the hint-only tool attests unknown
	// and the scope refusal below names the remedy.
	if (mcp !== null && workerScope === safety.scopes.readonly) {
		mcp = resolveWorkerMcpAdmission({ ...mcpInput, readOnly: true });
	}
	const mcpRefusal = workerMcpScopeRefusal(
		req.agentId,
		mcp,
		workerScope.allowedActions,
		workerScope === safety.scopes.readonly ? "read-only" : "workspace",
	);
	if (mcpRefusal !== null) throw new Error(mcpRefusal);
	const verdict = admit(
		{
			requestedScope: workerScope,
			orchestratorScope: orchScope,
			requestedActions,
			agentId: req.agentId,
		},
		safety.isSubset,
	);
	if (!verdict.admitted) {
		throw new Error(`dispatch: admission denied: ${verdict.reason}`);
	}
	// A project server starts from the run's own tree, so a worker whose write
	// roots overlap its cwd, an entry file's directory or the project root
	// could route its traffic through code it wrote. Such a run keeps the
	// server but not its network grant.
	let mcpNetworkWithheld: WorkerMcpNetworkWithheld[] = [];
	if (mcp !== null) {
		// The write roots the run's sandbox binds (workerSandboxFor), so the grant follows what the worker can write.
		const readOnly = requestedWriteNone({
			readOnly: req.readOnly,
			capabilityClass: normalizeAgentSpec(recipe).capabilityClass,
			hoareContract: isHoareResultContract(dispatchResultContract(req, recipe)),
		});
		const treeRoot = req.taskWorktree?.path ?? req.cwd ?? process.cwd();
		const writeRoots = readOnly ? [] : pathScope.writeBoundaries.length > 0 ? pathScope.writeBoundaries : [treeRoot];
		const scoped = withholdWritableMcpNetwork(mcp, { writeRoots, launchRoot: treeRoot });
		mcp = scoped.attestation;
		mcpNetworkWithheld = scoped.withheld;
	}
	return {
		allowedTools,
		requestedActions,
		...(req.toolProfile !== undefined ? { toolProfile: req.toolProfile } : {}),
		...(mcp !== null ? { mcp } : {}),
		...(mcpNetworkWithheld.length > 0 ? { mcpNetworkWithheld } : {}),
	};
}

export function resolveDelegationAdmissionStage(req: DispatchRequest, safety: SafetyContract): DispatchAdmissionStage {
	assertToolProfileEnforceable(req.toolProfile, "ACP delegation");
	const allowedTools = applyToolProfile([], req.toolProfile);
	const requestedActions = deriveRequestedActions(allowedTools, safety);
	const orchScope = pickOrchestratorScope(safety);
	const workerScope = pickWorkerScope(safety, requestedActions, resolveDispatchPathScope(req));
	const verdict = admit(
		{
			requestedScope: workerScope,
			orchestratorScope: orchScope,
			requestedActions,
			agentId: req.agentId,
		},
		safety.isSubset,
	);
	if (!verdict.admitted) {
		throw new Error(`dispatch: delegation admission denied: ${verdict.reason}`);
	}
	return {
		allowedTools,
		requestedActions,
		...(req.toolProfile !== undefined ? { toolProfile: req.toolProfile } : {}),
	};
}

export function requestOriginFor(req: DispatchRequest): DispatchRequestOrigin {
	return req.requestOrigin ?? "agent";
}
