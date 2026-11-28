// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

import { sha256Hex } from "../../core/hash.js";
import { workerBudgetFromEnvelope } from "../../core/run-budget-envelope.js";
import type { SandboxAvailability } from "../../core/sandbox/types.js";
import { workerEgressMode, workerMcpNoNetworkNotice } from "../../core/sandbox/worker-policy.js";
import { type ToolName, ToolNames } from "../../core/tool-names.js";
import { endpointIdentityHash, toolSignatureOf } from "../../lib/worker-wire/protocol.js";
import { toolPromptHintsForNames } from "../../tools/builtin-tool-catalog.js";
import type { CheckoutRootLookup } from "../../tools/task-worktree.js";
import { agentHasTrait } from "../agents/spec.js";
import { workerHandbookAudience } from "../context/handbook-units.js";
import {
	sisterRepositoryNotice,
	sisterRepositoryPendingNotice,
	sisterRepositoryRoot,
	sisterRepositoryRules,
} from "../context/sister-repository.js";
import { ensureClaudeAgentSdk } from "../install/claude-sdk-install.js";
import { resolveClaudeLaunchCredential } from "../providers/auth/index.js";
import { targetRequiresAuth } from "../providers/index.js";
import { type WorkerMcpAttestation, workerPermissionModeForPermit } from "../safety/worker-permit.js";
import {
	assertStoreGrantAdmissible,
	type DispatchAdmissionStage,
	requestOriginFor,
	resolveDispatchAdmissionStage,
	withStoreGrantBoundaries,
} from "./admission-scope.js";
import type { DispatchRuntime } from "./bundle-runtime.js";
import { operatorContainedYolo } from "./bundle-support.js";
import type { DispatchLifecycleStage, PeerPromptComposition } from "./bundle-types.js";
import type { DispatchRequest } from "./contract.js";
import { reportDispatchDiagnostic } from "./dispatch-diagnostic.js";
import { type WorkerEnvelope, withStaticHead } from "./envelope.js";
import {
	type EffectiveSettings,
	envelopeStaticHeadInput,
	judgeRoutedPermit,
	resolveDispatchEnvelopeStage,
} from "./envelope-stage.js";
import { dispatchResultContract } from "./execution-role.js";
import { sealedAnswerBudgetBytes } from "./handback.js";
import {
	type DispatchPathScope,
	declaredScopeReplacementDiagnostic,
	inferredScopeParentTokenNotice,
	resolveDispatchPathScope,
} from "./path-scope.js";
import { type PeerInstructions, peerInstructionsStaleMessage, resolvePeerInstructions } from "./peer-instructions.js";
import type { FleetPlacementPreview } from "./placement.js";
import {
	assertDenyToolsEnforceable,
	assertMainGrantRoutable,
	assertPostRuntimeToolCompatibility,
	assertRuntimeCanHonorWorkerPermissionMode,
	runtimeLimitations,
} from "./runtime-enforceability.js";
import {
	enforceCapabilityGate,
	type ResolvedTarget,
	readWorkerTargets,
	resolveDispatchTarget,
	targetToolCapability,
} from "./target-resolution.js";
import { assertTurnConstraintCompatibility } from "./tool-constraints.js";
import type { RunKind } from "./types.js";
import {
	assertWorkerContextRequest,
	briefingProvenanceFor,
	buildDynamicPromptMessages,
	canonicalContextAttached,
	harnessLabel,
	keepsPeerInstructionFiles,
	pancodeOnlyNames,
	personaOverrideFor,
	pipelineProvenanceFor,
	projectContextProvenanceFor,
	promptCompositionHash,
	promptHash,
	readWorkspaceRootFacts,
	sisterProjectPrompt,
	WORKER_HANDBOOK_MAX_CHARS,
	type WorkerDynamicContext,
	workerPersonaBody,
	workerProjectPrompt,
} from "./worker-dynamic-prompt.js";
import { type WorkerMcpNetworkWithheld, workerMcpRuntimeRefusal } from "./worker-mcp.js";
import { prepareWorkerModelListing, prepareWorkerModelMetadata } from "./worker-model-metadata.js";
import { resolveEffectiveWorkerBudget, workerSandboxFor, workerSandboxPromptLine } from "./worker-spec.js";

export function createLifecycleResolver(rt: DispatchRuntime) {
	const { context, options } = rt;
	const {
		agents,
		firstNotice,
		getEffectiveSettings,
		now,
		projectContext,
		prompts,
		providers,
		safety,
		withLiveAutonomy,
	} = rt.core;

	const publishedPathScopeRoots = new Set<string>();

	function publishDispatchPathScope(req: DispatchRequest, pathScope: DispatchPathScope): void {
		const rootRunId = req.lineage?.rootRunId ?? req.runIdHint;
		// Scope provenance remains in receipts; retries must not repeat a generated path inventory.
		if ((req.lineage?.attempt ?? 0) > 0 || (rootRunId !== undefined && publishedPathScopeRoots.has(rootRunId))) return;
		if (rootRunId !== undefined) publishedPathScopeRoots.add(rootRunId);
		const internalOrigin = req.requestOrigin === "internal" || req.requestOrigin === "harness";
		// Context generators embed source paths as evidence under an explicit
		// repository-wide read scope. That expected inventory is retained in the
		// receipt, but warning on it obscures their actual stage progress.
		const replacementDiagnostic = declaredScopeReplacementDiagnostic(pathScope);
		const contextGenerator = agentHasTrait(agents.getSpec(req.agentId), "context-generator");
		if (replacementDiagnostic !== null && internalOrigin && !contextGenerator) {
			reportDispatchDiagnostic("typed scope replacement", new Error(replacementDiagnostic));
		}
		// A reinterpreted "../" token is the one inferred-mode scope fact that earns
		// a notice, so it cannot warn on an ordinary intent-less dispatch. It travels on the bus
		// and in the dispatch plan artifact. Operator stderr stays free of it
		// because the scope it describes adds no authority the operator can act
		// on, and every normal dispatch with a "../" token in its prose hit it.
		const parentTokenNotice = inferredScopeParentTokenNotice(pathScope);
		if (parentTokenNotice !== null) {
			context.bus.emit("run.scope_notice_raised", {
				...parentTokenNotice,
				agentId: req.agentId,
			});
		}
	}

	/**
	 * The default sandbox (auto, worker egress not open) starts admitted MCP servers
	 * with no network and a masked home, so a server that needs either fails
	 * only at its first call. The operator hears it at admission instead.
	 */
	function announceMcpSandboxNoNetwork(
		req: DispatchRequest,
		pathScope: DispatchPathScope,
		envelope: WorkerEnvelope,
		effectiveTools: ReadonlyArray<ToolName>,
		target: ResolvedTarget,
		settings: EffectiveSettings,
		mcp: WorkerMcpAttestation | undefined,
		withheld: ReadonlyArray<WorkerMcpNetworkWithheld>,
		placedSandbox: SandboxAvailability,
	): void {
		const servers = (mcp?.tools ?? []).filter((entry) =>
			effectiveTools.includes(`mcp_${entry.serverId}__${entry.tool}` as ToolName),
		);
		const offeredWithheld = withheld.filter((entry) => servers.some((server) => server.serverId === entry.serverId));
		if (servers.length === 0) return;
		const sandbox = workerSandboxFor({
			runtimeKind: target.runtime.kind,
			req,
			pathScope,
			envelope,
			settings,
		}).spec;
		if (sandbox === undefined) return;
		const message = workerMcpNoNetworkNotice(
			{
				mode: sandbox.mode,
				network: sandbox.network,
				egress: workerEgressMode(sandbox, placedSandbox),
				available: placedSandbox.available,
			},
			servers,
			offeredWithheld,
		);
		if (message === null) return;
		context.bus.emit("run.scope_notice_raised", { code: "mcp_sandbox_no_network", level: "warning", message });
	}

	async function resolveLifecycle(
		req: DispatchRequest,
		settings: EffectiveSettings,
		placement: FleetPlacementPreview,
		metadataDeadlineAt: number,
		signal?: AbortSignal,
		checkoutRoot?: CheckoutRootLookup,
	): Promise<DispatchLifecycleStage> {
		const recipe = agents.get(req.agentId);
		if (!recipe) {
			throw new Error(`dispatch: unknown agent recipe: ${req.agentId}`);
		}
		const { spec, capabilityMismatch } = rt.preview.assertRecipeAdmissible(req, recipe, settings);
		const pathScope = withStoreGrantBoundaries(req, resolveDispatchPathScope(req), () => placement.node);
		publishDispatchPathScope(req, pathScope);
		const admission = resolveDispatchAdmissionStage(req, recipe, safety, pathScope);
		const targets = readWorkerTargets(settings);
		const resolveTarget = () =>
			resolveDispatchTarget(
				req,
				recipe,
				targets.workerDefault,
				targets.workerProfiles,
				targets.agentBindings,
				targets.targetOrder,
				providers,
			);
		// The route the listing serves is the one resolution would pick now, else the named target.
		const listingTargetId = (): string | null => {
			try {
				return resolveTarget().target.id;
			} catch {
				return req.target ?? null;
			}
		};
		await prepareWorkerModelListing(providers, listingTargetId, metadataDeadlineAt, signal, now);
		let target = resolveTarget();
		// Before the SDK install ask: a runtime that cannot carry the recipe's MCP
		// capabilities is refused whether or not its SDK is present.
		const mcpRuntimeRefusal = workerMcpRuntimeRefusal(req.agentId, admission.allowedTools, target.runtime);
		if (mcpRuntimeRefusal !== null) throw new Error(mcpRuntimeRefusal);
		if (target.runtime.id === "claude-sdk") {
			const operator = options?.operatorAsk;
			await ensureClaudeAgentSdk({
				...(signal ? { signal } : {}),
				// Contained yolo never waits on the install question; the dispatch is refused as it is with no operator.
				...(operator?.available() === true && !operatorContainedYolo(withLiveAutonomy(getEffectiveSettings()))
					? {
							confirm: async (question: string) => {
								const result = await operator.ask(
									[
										{
											question,
											header: "Claude SDK",
											options: [{ label: "Install now" }, { label: "Not now" }],
											defaultOption: 1,
										},
									],
									signal ? { signal } : undefined,
								);
								const answer = result.answers[0];
								return (
									!result.cancelled && (answer?.answer === "Install now" || answer?.options?.includes("Install now") === true)
								);
							},
						}
					: {}),
			});
		}
		assertWorkerContextRequest(req, target.runtime.kind === "http");
		const identity = (resolved: ResolvedTarget): string =>
			JSON.stringify([
				resolved.target.id,
				resolved.runtime.id,
				resolved.wireModelId,
				endpointIdentityHash(resolved.target.url),
			]);
		const selectedIdentity = identity(target);
		await prepareWorkerModelMetadata(providers, target.target.id, metadataDeadlineAt, signal, now);
		target = resolveTarget();
		if (identity(target) !== selectedIdentity) {
			throw new Error("dispatch: worker route changed during model metadata preparation; request a fresh admission");
		}
		enforceCapabilityGate(target.target.id, target.modelCapabilities, req.requiredCapabilities);
		const cwd = req.cwd ?? process.cwd();
		assertDenyToolsEnforceable(target.runtime, req.denyTools);
		const stage = resolveDispatchEnvelopeStage({
			req,
			recipe,
			spec,
			admission,
			target,
			settings,
			liveSettings: withLiveAutonomy(settings),
			pathScope,
			judgeSeated: options?.workerAskJudge !== undefined,
			placement,
			...(checkoutRoot === undefined ? {} : { checkoutRoot }),
		});
		const { envelope, permit, readOnly, judgeWithheld } = stage;
		if (envelope.write.mode === "worktree" && req.taskWorktree === undefined)
			throw new Error("dispatch: the admitted write roots need a task worktree; dispatch again with worktree: true");
		const effectiveTools = stage.tools;
		await assertStoreGrantAdmissible(req, readOnly);
		// A capability the write roots cost this run reaches the parent's dispatch result and the worker's prompt (CLI-H2).
		if (envelope.withheld.some((entry) => entry.reason === "write-roots-unconfined")) {
			context.bus.emit("run.scope_notice_raised", {
				code: "write_roots_checks_withheld",
				level: "warning",
				message:
					"[dispatch scope] Narrow write roots have neither an OS sandbox nor a task worktree binding commands to them, so bash and verify are withheld and the worker cannot run checks. Enable safety.sandbox (auto or required) with a usable bubblewrap backend where the worker runs, or dispatch from a git checkout so the run gets its own worktree.",
			});
		}
		assertPostRuntimeToolCompatibility(req.agentId, spec, envelope, target);
		assertTurnConstraintCompatibility(req, effectiveTools, target.runtime.kind === "http", agents.listSpecs());
		announceMcpSandboxNoNetwork(
			req,
			pathScope,
			envelope,
			effectiveTools,
			target,
			settings,
			admission.mcp,
			admission.mcpNetworkWithheld ?? [],
			stage.placedSandbox,
		);
		if (!judgeRoutedPermit(permit, settings)) assertMainGrantRoutable(req, target.runtime, permit);
		if (judgeWithheld !== null && req.requestOrigin !== "internal" && firstNotice("judge-withheld")) {
			context.bus.emit("run.scope_notice_raised", {
				code: "worker_judge_withheld",
				level: "warning",
				message: `[dispatch scope] fleet.permissions.mode is judge, but ${judgeWithheld}, so workers dispatched here run with the deny permit and each ask they raise is denied. The safety judge answers worker asks in an interactive session at autonomy default with safety.judge.enabled on.`,
			});
		}
		const workerPermissionMode = workerPermissionModeForPermit(permit.allowance);
		assertRuntimeCanHonorWorkerPermissionMode(target.runtime, workerPermissionMode);
		const effectiveAdmission: DispatchAdmissionStage = {
			...admission,
			allowedTools: effectiveTools,
		};
		const hasCanonicalContext = canonicalContextAttached(target.runtime, effectiveTools);
		const personaBody = workerPersonaBody(req, recipe, hasCanonicalContext);
		const hasBoundSkills =
			hasCanonicalContext && recipe.skills !== undefined && recipe.skills.length > 0 && req.noSkills !== true;
		// A cwd owned by another repository than the session's (an outside
		// checkout, a submodule or a nested clone; not a linked worktree of the
		// session's own) takes that repository's rules, filtered by its handbook
		// trust, from the cached compile only. Every session runs from its root,
		// so the comparison is with process.cwd(): a task worktree's root is the
		// repository owning the cwd, which for a nested clone is the sister itself.
		const sister = sisterRepositoryRoot(cwd, process.cwd()) === null ? null : sisterRepositoryRules(cwd);
		const sisterNotice =
			sister === null
				? null
				: sister.rules === null
					? { code: "sister_handbook_pending" as const, message: sisterRepositoryPendingNotice(sister) }
					: { code: "sister_handbook_untrusted" as const, message: sisterRepositoryNotice(sister.rules) };
		if (sisterNotice?.message) {
			context.bus.emit("run.scope_notice_raised", {
				code: sisterNotice.code,
				level: "warning",
				message: sisterNotice.message,
			});
		}
		const compiledWorkerPrompt = await prompts.compileWorkerPrompt({
			// The handbook trust pins only the handbook files, so another repository's
			// `.pancode/rules` and project profile never enter, trusted or not.
			...(sister !== null ? { projectCustomization: "operator-only" as const } : {}),
			...(req.turnConstraints ? { turnConstraints: req.turnConstraints } : {}),
			...(readOnly ? { readOnly: true } : {}),
			providerSupportsTools: target.runtime.kind === "subprocess" ? null : targetToolCapability(target),
			toolNames: effectiveTools,
			toolPromptHints: toolPromptHintsForNames(effectiveTools, hasBoundSkills ? "bound-worker" : "worker"),
			hasCanonicalContext,
			hasBoundSkills,
			onPermission: workerPermissionMode,
			permit,
			...(req.taskWorktree !== undefined ? { taskWorktree: true } : {}),
			...(options?.workerSteering === false ? { liveSteering: false } : {}),
			persona: {
				id: `persona.${recipe.id}`,
				relPath: recipe.filepath,
				body: personaBody,
				contentHash: sha256Hex(personaBody),
				dynamic: false,
			},
			cwd,
			workingContextPaths: pathScope.workingContextPaths,
		});
		const systemPrompt = compiledWorkerPrompt.systemPrompt;
		const budgetEnvelope = resolveEffectiveWorkerBudget({
			req,
			recipeId: recipe.id,
			declared: spec.budget,
			allowedTools: effectiveTools,
			settings,
			runtime: target.runtime,
			readOnly,
		});
		// Fetch captured project context only for tiers that receive it, so
		// read-only scouts never pay the PANCODE.md read. The tier is spec policy
		// (capability-class default, recipe frontmatter override).
		const tier = sister !== null ? "bounded" : spec.projectContextTier;
		const projectPrompt =
			sister !== null
				? sisterProjectPrompt(sister.rules)
				: projectContext && tier === "bounded"
					? workerProjectPrompt(projectContext, cwd, req.protectedArtifactRemap)
					: null;
		// A delegated harness also reads its own instruction files; it gets one rule set compiled from both.
		// When that fails the run goes as it did before: the usual project message beside the harness's own files.
		const peer =
			tier === "bounded" && target.runtime.kind === "subprocess"
				? await resolvePeerInstructions({
						declared: target.runtime.repositoryInstructions,
						cwd,
						handbookSources: projectPrompt?.handbookSources ?? [],
						audience: workerHandbookAudience(spec.handbook, spec.capabilityClass),
						workingPaths: pathScope.workingContextPaths,
						maxChars: WORKER_HANDBOOK_MAX_CHARS,
						pancodeNames: pancodeOnlyNames(agents.listSpecs().map((entry) => entry.id)),
						...(req.taskWorktree !== undefined ? { taskWorktree: req.taskWorktree.path } : {}),
						// A run with no write boundary, declared (write root ".") or not, may edit the whole workspace.
						declaredPaths: [
							...(pathScope.writeBoundaries.length === 0 ? ["."] : []),
							...pathScope.workingContextPaths,
							...pathScope.writeBoundaries,
							...pathScope.inferredOnlyPaths,
						],
						keepFiles: keepsPeerInstructionFiles(settings, target.runtime),
					}).catch((error: unknown) => {
						reportDispatchDiagnostic(`compile peer instructions for ${target.runtime.id}`, error);
						return null;
					})
				: null;
		const runRole = envelope.role;
		const answerBudgetBytes = sealedAnswerBudgetBytes(req.answerBudgetBytes);
		const dynamicContext: WorkerDynamicContext = {
			ledgerAssignments: rt.runs.ledgerAssignmentsFor(req, pathScope),
			answerBudgetBytes,
			...(req.runWallMs !== undefined ? { wallClockMs: req.runWallMs } : {}),
			capabilityClass: spec.capabilityClass,
			agentId: recipe.id,
			...(spec.handbook !== undefined ? { handbook: spec.handbook } : {}),
			workingContextPaths: pathScope.workingContextPaths,
			cwd,
			projectContextTier: tier,
			autonomy: "default",
			...workerSandboxPromptLine(
				{
					resultContract: dispatchResultContract(req, recipe) ?? null,
					runtimeKind: target.runtime.kind,
					req,
					pathScope,
					envelope,
					settings,
				},
				stage.placedSandbox,
			),
			onPermission: workerPermissionMode,
			permit,
			...(req.taskWorktree !== undefined ? { taskWorktree: true } : {}),
			projectPrompt,
			projectReadTools:
				target.runtime.kind === "subprocess"
					? null
					: effectiveTools.includes(ToolNames.Read)
						? targetToolCapability(target)
						: false,
			projectExternalReadTools: target.runtime.kind === "subprocess",
			withheld: envelope.withheld,
			ledgerToolAvailable:
				target.runtime.kind === "http" && targetToolCapability(target) && effectiveTools.includes(ToolNames.Ledger),
			workspace: readWorkspaceRootFacts(cwd, req.taskWorktree?.root),
		};
		const composePrompt = (delivered: PeerInstructions | null): PeerPromptComposition => {
			// An overlay reaches the harness through its own file, so the message does not carry the rules twice.
			const peerHandbook = delivered?.overlay !== undefined ? "" : delivered?.text;
			const messages = buildDynamicPromptMessages(req, {
				...dynamicContext,
				...(peerHandbook !== undefined ? { peerHandbook } : {}),
			});
			const text = messages.map((message) => message.body).join("\n\n");
			const hash = promptCompositionHash([
				systemPrompt,
				text,
				...(req.contextSeed ? [req.contextSeed.provenance.contentHash] : []),
			]);
			return {
				dynamicPromptMessages: messages,
				projectContext: projectContextProvenanceFor(tier, messages, delivered),
				compiledPromptHash: hash,
				promptSignature: hash,
				dynamicHash: messages.length > 0 ? sha256Hex(text) : sha256Hex(""),
			};
		};
		const composed = composePrompt(peer);
		const peerStaleMessage =
			peer?.staleFiles !== undefined ? peerInstructionsStaleMessage(harnessLabel(target.runtime), peer.staleFiles) : null;
		const peerStale =
			peer !== null && peerStaleMessage !== null
				? { files: (peer.staleFiles ?? []).map((entry) => entry.file), stale: peer.stale, message: peerStaleMessage }
				: null;
		const { dynamicPromptMessages, compiledPromptHash, dynamicHash } = composed;
		const projectContextProvenance = composed.projectContext;
		const staticCompositionHash = promptHash(systemPrompt);
		const sessionShellHash = staticCompositionHash;
		const personaOverride = personaOverrideFor(req, staticCompositionHash);
		const currentToolSignature = toolSignatureOf(effectiveTools);
		const auth = targetRequiresAuth(target.target, target.runtime)
			? await providers.auth.resolveForTarget(target.target, target.runtime)
			: null;
		const claudeCredential =
			target.runtime.auth === "claude-cli"
				? await resolveClaudeLaunchCredential(target.target.auth, process.env, signal ? { signal } : {})
				: null;
		// pi-ai's openai-completions provider refuses to stream without an apiKey
		// even when the target is a local server that ignores Authorization headers.
		// Match chat-loop's LOCAL_API_KEY_FALLBACK so dispatch-spawned workers can
		// reach openai-compat local endpoints (LM Studio, llama.cpp) without
		// requiring the user to invent a credential.
		const apiKey =
			claudeCredential?.apiKey ??
			auth?.apiKey ??
			(auth === null && target.runtime.kind === "http" ? "pancode-local-target" : undefined);
		const authProfile =
			(claudeCredential && !claudeCredential.profile.startsWith("env:") ? claudeCredential.profile : undefined) ??
			(auth?.credentialType === "oauth" && auth.source === "stored-oauth" ? auth.providerId : undefined);
		const runtimeKind: RunKind = target.runtime.kind;
		const limitations = runtimeLimitations(runtimeKind, target.runtime.id);
		return {
			recipe,
			pathScope,
			admission: effectiveAdmission,
			target,
			cwd,
			systemPrompt,
			dynamicPromptMessages,
			compiledPromptHash,
			staticCompositionHash,
			sessionShellHash,
			dynamicHash,
			promptSignature: compiledPromptHash,
			toolSignature: currentToolSignature,
			apiKey,
			...(authProfile ? { authProfile } : {}),
			...(claudeCredential?.expiresAt !== undefined ? { credentialExpiresAt: claudeCredential.expiresAt } : {}),
			runtimeKind,
			runRole,
			answerBudgetBytes,
			agentAudience: spec.audience,
			capabilityClass: spec.capabilityClass,
			requestOrigin: requestOriginFor(req),
			runtimeLimitations: limitations,
			pipeline: pipelineProvenanceFor(req),
			briefing: briefingProvenanceFor(req),
			personaOverride,
			decisionRefs: req.decisionRefs ?? null,
			projectContext: projectContextProvenance,
			// Sealed over the compiled prompt, so the worker can prove the head it sends is the one admitted (DESIGN 4.4).
			envelope: withStaticHead(envelope, envelopeStaticHeadInput(target, systemPrompt, envelope)),
			placedSandbox: stage.placedSandbox,
			...(peerStale !== null ? { peerStale } : {}),
			...(peer?.overlay !== undefined
				? {
						peerOverlay: peer.overlay,
						peerCoexist: composePrompt({
							delivery: "coexist",
							files: peer.files,
							stale: peer.stale,
							notCarried: peer.notCarried,
							...(peer.text !== undefined ? { text: peer.text } : {}),
						}),
					}
				: {}),
			rulesApplied: compiledWorkerPrompt.rulesApplied ?? [],
			operatorProfileApplied: compiledWorkerPrompt.operatorProfileApplied ?? false,
			capabilityMismatch,
			readOnly,
			permit,
			budget: workerBudgetFromEnvelope(budgetEnvelope),
			budgetEnvelope,
			...(settings ? { settings } : {}),
		};
	}

	return {
		publishDispatchPathScope,
		publishedPathScopeRoots,
		resolveLifecycle,
	};
}
