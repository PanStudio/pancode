// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { homedir } from "node:os";
import path from "node:path";
import { bashSearchPath } from "../../core/bash-exec.js";
import { resolvePathBoundary } from "../../core/path-boundary.js";
import {
	canonicalizeExistingPath,
	canonicalizePath,
	canonicalizeRawPath,
	createPathWalkMemo,
} from "../../core/path-canonical.js";
import { isSameOrDescendant } from "../../core/path-containment.js";
import { mainSandboxWritableRoots, type YoloScriptSandboxState } from "../../core/sandbox/main-session.js";
import { shellJoin } from "../../core/shell-quote.js";
import { ToolNames } from "../../core/tool-names.js";
import { pancodeConfigDir } from "../../core/xdg.js";
import { effectiveScratchRoots } from "../../lib/scratch-roots/scratch-roots.js";
import {
	conditionalSecretPaths,
	pancodeControlPaths,
	pancodeCredentialStorePaths,
} from "../../lib/secrets/secret-paths.js";
import { resolveProjectVerifierExecutionCwd } from "../../tools/verify/catalog.js";
import { resolveVerifyCall, verifyResolutionArgv } from "../../tools/verify/resolve.js";
import { prepareVerifyArguments } from "../../tools/verify/surface.js";
import {
	type ActionClass,
	bashDeleteReasons,
	type Classification,
	type ClassifierCall,
	classify,
	normalizeCallPaths,
	resolveScratchDeleteOperands,
} from "./action-classifier.js";
import { declaredWrapperReadings } from "./check-prefix.js";
import { extractCommandCdScopedTargets, shellCommandSteps } from "./command-path-walks.js";
import { pinnedPancodeCommand } from "./command-pins.js";
import {
	cleansIgnoredFiles,
	GIT_CONTROL_FILE_RULE_ID,
	gitControlFileReason,
	type OutwardPlaces,
	SCRATCH_DISPOSABLE_REASON_CODE,
	SNAPSHOT_RECOVERABLE_GIT_PATTERNS,
	SNAPSHOT_RECOVERABLE_REASON_CODE,
} from "./containment.js";
import { CONFIRMED_POSTURE } from "./contract.js";
import type { DamageControlMatch, DamageControlRule } from "./damage-control.js";
import {
	BUILD_OUTPUT_PATHS,
	DEFAULT_DAMAGE_CONTROL_PATH_POLICY,
	mergePathPolicyInputs,
	OPERATOR_PATH_POLICY,
} from "./default-path-policy.js";
import type { ApprovedFlowPolicy } from "./flow-policy-snapshot.js";
import {
	forgetApprovedFlowPolicy,
	recallApprovedFlowPolicy,
	rememberApprovedFlowPolicy,
} from "./flow-policy-snapshot.js";
import { decodedLocaleQuoting, scanShellLikeDeep } from "./heredoc-scan.js";
import type { GitHookDriftGuard } from "./hook-drift.js";
import type { FlowRestrictionSet, InformationFlowPolicy } from "./information-flow.js";
import { compileInformationFlowPolicy, flowRestrictionsForCall } from "./information-flow.js";
import {
	PANCODE_OWNED_VARIABLE,
	pancodeFloorBases,
	pancodeFloorReaches,
	pancodeFloorReading,
	pancodeFloorText,
} from "./pancode-tree-floor.js";
import { type CompiledPathPolicy, compilePathPolicy, evaluatePathPolicy, type PathPolicyInput } from "./path-policy.js";
import { evaluateBashPolicy, HIDDEN_CONTENT_RULE_ID } from "./policy-bash-net.js";
import {
	bashPathTokenCandidates,
	bashZeroAccessReason,
	evaluateBashZeroAccessRead,
	evaluateProjectPathPolicy,
	flowSourceCallFor,
	hidesShellContent,
	operatorAuthorityTargets,
	pancodeSkillsRootPaths,
	pathPolicyTargets,
} from "./policy-bash-paths.js";
import { bashCwdArg, commandArg, cwdArg, hasShellOperators, pathArg } from "./policy-call-args.js";
import type { ResortedDamageControl } from "./policy-damage-resort.js";
import {
	CONTAINED_REASON,
	containedShellCall,
	DEFAULT_RESORTED_REASON,
	DELETE_WITHOUT_SNAPSHOT_RULE_ID,
	deletesNeedingSnapshot,
	deletesOnlyScratch,
	effectiveClassification,
	isHardMatch,
	LONE_DELETE,
	LONE_GIT_DISCARD,
	matchingSourcedRules,
	matchSourcedRule,
	NAME_LISTERS,
	OPERATOR_ONLY_ASKS,
	PANCODE_CONFIG_VARIABLE,
	reachesOutward,
	runsProjectCommand,
	SCRATCH_DISPOSABLE_REASON,
	SNAPSHOT_RECOVERABLE_REASON,
	snapshotRecoverableRule,
	yoloRequiredSandbox,
} from "./policy-damage-resort.js";
import {
	damageControlScans,
	decodedAnsiCCommand,
	invokesTrustMutation,
	MAX_PATH_SEGMENTS,
	OVERSIZED_PATH_RULE_ID,
	oversizedPathToken,
	rulePackHash,
	shellCommandSegments,
} from "./policy-damage-scans.js";
import type { ScriptBudget, ScriptHit } from "./policy-floor-scripts.js";
import {
	commandMayChangeHome,
	commandWrittenPaths,
	holdsAtYolo,
	LOGIN_PATH_PENDING_REASON,
	LOGIN_PATH_PENDING_RULE_ID,
	LOGIN_PATH_PENDING_YOLO_HOLD,
	newScriptBudget,
	newWrittenPaths,
	RAW_TEXT_REASON,
	recordUnplaced,
	runsUnderShell,
	SCRIPT_UNPLACEABLE_RULE_ID,
	scanCommandScript,
	scanNamedScript,
	scriptPath,
	scriptUnplaceableReason,
	YOLO_ADMITTED_REASON_PREFIX,
	YOLO_SANDBOX_NOT_LEFT,
	YOLO_SANDBOX_REFUSED,
	YOLO_SANDBOX_REFUSED_OUTWARD,
	YOLO_SANDBOX_REQUIRED_RULE_ID,
} from "./policy-floor-scripts.js";
import type { PancodeOwnedTrees } from "./policy-pancode-trees.js";
import {
	accountHomeExpanded,
	assignedSpellings,
	namesPancodeTree,
	pancodeOwnedTrees,
	sameCommandWriteTargets,
	writesThroughPancodeVariable,
} from "./policy-pancode-trees.js";
import { RG_WALK_BUDGET } from "./policy-read-only-inspectors.js";
import {
	EXECUTION_TOOLS,
	evaluateWriteRoots,
	gitControlLanding,
	isWriteConfinementEscape,
	mayRewriteGitConfig,
	outsideExistingTypedMutationTarget,
	resolveGitControls,
	scratchRootWrite,
	WRITE_ROOT_TOOLS,
	writeRootViolation,
} from "./policy-write-landing.js";
import { type LoadedProjectSafetyPolicy, loadProjectSafetyPolicy } from "./project-policy.js";
import {
	fetchCouldCarryLocalData,
	isOutboundWebTool,
	isSecretBearingPath,
	SECRET_READ_THEN_FETCH_RULE_ID,
} from "./read-fetch-taint.js";
import { isReadScopeTool, readScopeEscape, readScopeExemptRoots } from "./read-scope.js";
import { formatRejection, type RejectionMessage } from "./rejection-feedback.js";
import { ROUTING_PIN_HINT } from "./routing-settings.js";
import { getCachedBaseRuleset } from "./rule-pack-loader.js";
import { SANDBOX_ESCAPE_REASON, SANDBOX_ESCAPE_RULE_ID } from "./sandbox-escape.js";
import { commandMoveBases, type ScriptLine } from "./script-shell.js";
import {
	invokesSettingsMutation,
	SETTINGS_AUTHORITY_REASON,
	SETTINGS_AUTHORITY_RULE_ID,
	type SettingsHomeScope,
} from "./settings-authority.js";
import { hasUnparsedShellScript, shellScriptSources } from "./shell-segments.js";
import type { MutationCandidate } from "./skill-authority.js";
import {
	activePancodeSkillRoots,
	foreignDevRootReason,
	mutationCandidates,
	skillMutationReason,
} from "./skill-authority.js";
import { invokesPancodeSkillMutation } from "./skill-mutation-commands.js";
import { gateProjectSafetyPolicy, workspaceTrustDirectory } from "./workspace-trust.js";
import {
	MAX_RAW_TEXT_BYTES,
	YOLO_FLOOR_AUTHORITY_REMEDY,
	YOLO_FLOOR_AUTHORITY_RULE_IDS,
	YOLO_FLOOR_PACK_RULE_IDS,
	YOLO_FLOOR_REASON_PREFIX,
	YOLO_FLOOR_RULE_IDS,
	YOLO_FLOOR_TEXT_RULES,
	type YoloFloorHit,
	yoloFloorCommandText,
	yoloFloorExecutableHit,
	yoloFloorRawCandidates,
	yoloFloorScriptRuns,
} from "./yolo-floor.js";
import { yoloFloorDeleteHit, yoloFloorWorkspaceGitHit } from "./yolo-floor-delete.js";

export type SafetyPolicySource =
	| "damage-control:base"
	| "mcp-trust"
	| "project-policy"
	| "project-policy-invalid"
	| "builtin-command-allowlist"
	| "builtin-classifier"
	| "none";

export interface SafetyPolicyDecision {
	/**
	 * Net verdict (sd-01 §2.2): `block` is final, and `ask` is a net rail
	 * demanding operator confirmation at the current level. Under the
	 * operator's yolo scope only the floor, operator-authored rules and the
	 * run's ceilings block and nothing asks (#407). Under the operator's
	 * default scope only the floor, path and authority rails and the run's
	 * ceilings block, and former damage-control blocks ask. An `allow` means
	 * the net passed; the autonomy mapping decides what happens next at the
	 * admission seam (tools/registry.ts, acp/tool-mediator.ts).
	 */
	kind: "allow" | "ask" | "block";
	classification: Classification;
	tool: string;
	actionClass: ActionClass;
	reasons: ReadonlyArray<string>;
	ruleId?: string;
	reasonCode: string;
	command?: string;
	cwd: string;
	posture?: string;
	policySource: SafetyPolicySource;
	policyHash?: string;
	projectPolicyPath?: string;
	match?: DamageControlMatch;
	rejection?: RejectionMessage;
	/**
	 * Why a yolo floor rule blocked a call when the call's action class played no part, as with the raw-text
	 * reading. The model's refusal line states it in place of the class (bt-12 #1).
	 */
	floorBasis?: string;
	/**
	 * Execute-class passes only: whether the command is in the no-prompt set
	 * (built-in allowlist, project policy command, typed execution tool). The
	 * autonomy mapping asks for unrecognized execution in default mode.
	 */
	execRecognition?: "recognized" | "unrecognized";
	/**
	 * Set when a built-in test runner is recognized, alone, behind a workspace
	 * PYTHONPATH, or as one step of a recognized chain. The runner executes
	 * repository code whoever wrote it, so an attended main session at default
	 * asks once per session before its first test runner, and a headless run
	 * keeps #377's allow (#377 follow-up).
	 */
	runsWorkspaceCode?: true;
	/**
	 * Set on an allowed read, ls, grep, or find whose path resolves outside the
	 * workspace and outside PanCode's own readable roots. The net passed; the
	 * autonomy mapping asks for it in default mode. The operator's default
	 * scope never sets it: its reads of non-secret paths run anywhere.
	 */
	readScope?: "outside-workspace";
	/**
	 * Set on a decision whose call runs in the main-session sandbox
	 * (`src/core/sandbox/main-session.ts`), which may write only the canonical
	 * workspace, these scratch roots, the package caches and the repository's
	 * git dirs: a contained bash or run_script call of the operator's session
	 * at default, or a script under the operator's yolo with
	 * `safety.sandbox: required` (#419). `readOnly` marks a call of a read-only
	 * main session, which runs in the read-only sandbox instead and writes
	 * nothing the operator owns.
	 */
	shellSandbox?: { workspace: string; scratchRoots: ReadonlyArray<string>; readOnly?: true };
	/**
	 * Set when the operator's default admits a destructive call because the
	 * workspace snapshot taken right before it can undo it: a worktree discard,
	 * a stash drop, or a delete inside the workspace or a scratch root. The
	 * registry snapshots before the body and refuses the call when that
	 * snapshot cannot be taken.
	 */
	recoverable?: true;
	/**
	 * Set on an allowed typed file mutation outside the operator's own scopes
	 * that lands on a git control path (a hooks directory, the core.hooksPath
	 * directory, a config or commondir file, a `.git` pointer) of this
	 * engine's repository or, by name, of any repository. Admission asks
	 * the main agent for it when a worker at autonomy default makes the call.
	 */
	gitControl?: string;
}

export interface SafetyPolicyMetadata {
	version: 1;
	rulePackHash: string;
	rulePackVersion: number;
	activeRuleIds: ReadonlyArray<string>;
	projectPolicyPath: string | null;
	projectPolicyHash: string | null;
	projectPolicyValid: boolean;
	projectPolicyErrors: ReadonlyArray<string>;
	disableDefaultPathPolicy?: boolean;
	workspaceTrustVerdict?: "trusted" | "untrusted" | "changed";
	cwd: string;
}

/**
 * The operator's yolo (#407, #419). With a scope the engine judges a call the
 * skip-permissions way: only the yolo floor, operator-authored rules and the
 * run's ceilings (write roots, a required sandbox the host lacks) block, and
 * nothing asks. Admission passes it for a call the operator's session
 * registry makes at yolo, which includes the turns that scheduled `main` jobs
 * and `main_turn` deliveries run in that session, and for a worker whose
 * permit inherited the operator's yolo. A worker grant and a scheduled
 * command job never get it; `posture` still says "yolo" for them and keeps
 * the rails.
 */
export interface OperatorYoloScope {
	level?: "yolo";
	/** `safety.scratchRoots` from the operator's own settings, unvalidated here. */
	scratchRoots: ReadonlyArray<string>;
	/**
	 * How a command runs on this host under the operator's yolo; absent reads
	 * as `unsandboxed`. `sandboxed` and `refused` come from `safety.sandbox:
	 * required` and cover every command the default contains plus every script.
	 */
	scriptSandbox?: YoloScriptSandboxState;
	/**
	 * The main session's git hook drift guard. Under a required sandbox an
	 * outward git or gh line leaves it only while no hook file or executable
	 * git config value changed since the operator's baseline: git would run
	 * them outside, with the credentials the line keeps.
	 */
	hookDrift?: Pick<GitHookDriftGuard, "check">;
}

/**
 * The operator's own session at autonomy default: containment first,
 * judgment second, asking last. Only the main session's registry passes it,
 * so workers, grants and scheduled command jobs keep today's rails. Under it
 * the yolo floor blocks first, then the path, authority and ceiling rails
 * still block; a contained bash, run_script or verify call needs no ask for what its
 * command text hides; a damage-control hit a workspace snapshot can undo
 * runs; every other former damage-control block asks, so the safety judge
 * decides it with the operator's intent; a typed write or edit inside a
 * scratch root runs like one inside the workspace; and reads outside the
 * workspace run.
 */
export interface OperatorDefaultScope {
	level: "default";
	/** `safety.scratchRoots` from the operator's own settings, unvalidated here. */
	scratchRoots: ReadonlyArray<string>;
	/** True when this session's bash, run_script and verify commands run in the main-session sandbox on this host. */
	sandbox: boolean;
	/** True when a workspace snapshot is taken before a destructive call runs (a git work tree, `safety.snapshots` on). */
	snapshots: boolean;
	/**
	 * A read-only main session at either level: a contained call runs in the
	 * read-only sandbox, which `sandbox` then says is available on this host.
	 */
	readOnly?: true;
}

/** The scope the operator's own session hands the engine at its autonomy level. */
export type OperatorScope = OperatorYoloScope | OperatorDefaultScope;

export interface SafetyPolicyEngine {
	evaluate(call: ClassifierCall, posture?: string, scope?: OperatorScope): SafetyPolicyDecision;
	/**
	 * False when a zero-access entry covers the path. The per-entry filter of a
	 * listing or a search asks this about every result, so it runs the path
	 * policy alone instead of a whole admission.
	 */
	readablePath(target: string): boolean;
	/**
	 * Block reason when a write would land outside this run's write roots, or
	 * null. The typed mutation seam asks again right before it publishes, so a
	 * link swapped in after admission is still caught (F3).
	 */
	writeTargetViolation(target: string): string | null;
	metadata(posture?: string): SafetyPolicyMetadata;
	/** Compiled, trust-gated information-flow rules of the project policy. */
	informationFlow(): InformationFlowPolicy;
	/**
	 * Restrictions the result of this call will carry, judged by the path or
	 * tool name before the call runs. Null for an unrestricted source.
	 */
	flowRestrictionsFor(call: ClassifierCall): FlowRestrictionSet | null;
}

export interface SafetyPolicyEngineOptions {
	cwd?: string;
	projectPolicy?: LoadedProjectSafetyPolicy;
	/**
	 * Absolute path boundaries a write-class tool call is confined to for this run.
	 * Exact files omit a trailing slash and subtrees retain one.
	 * When present and non-empty, a write/edit target outside every root is a
	 * final BLOCK (reason code "write-root"). Empty or absent disables the check.
	 * Enforced at the worker safety seam so both the native worker registry and
	 * the Claude SDK hook path inherit it.
	 */
	writeRoots?: ReadonlyArray<string>;
	/**
	 * True when the OS sandbox confines every command this run spawns to the
	 * same write roots (a dispatched worker under bubblewrap). Execute-class
	 * tools then stay admissible under write roots; dispatch still escapes.
	 */
	writeRootsOsConfined?: boolean;
	/**
	 * True when every command this worker spawns runs in an OS sandbox that confines its writes to the worker's own
	 * roots (`workerSandboxConfinesWrites()`). Bash's hidden-content ask (variables, scripts, interpreter source) then
	 * yields to that sandbox, as main bash's does at default (row 371), and so does an unrecognized command main bash's
	 * sandbox would hold (M-49); every other rail and the floor still apply.
	 */
	workerSandboxConfinesWrites?: boolean;
	/**
	 * Extra trees read-class tools may read outside the workspace, judged by
	 * real path like the built-in exempt roots. A sandboxed worker passes its
	 * sandbox's readable roots, which its own shell can already read.
	 */
	readExemptRoots?: ReadonlyArray<string>;
}

/** What {@link OperatorDefaultScope} resolves to for one evaluation. */
interface DefaultResort {
	/** Canonical: the built-in temp roots plus the operator's valid scratch roots. */
	scratchRoots: ReadonlyArray<string>;
	/** The call runs in the main-session sandbox. */
	contained: boolean;
	/** A workspace snapshot precedes a destructive call. */
	snapshots: boolean;
	/** The contained call runs in the read-only sandbox. */
	readOnly?: true;
	/** The call would run contained but asks to leave the sandbox with `unsandboxed: true`. */
	leavesSandbox?: true;
}

/** A former hard block the operator's default turns into an ask, kept until the other rails have spoken. */
export type DeferredAsk = Omit<
	SafetyPolicyDecision,
	"kind" | "classification" | "tool" | "actionClass" | "cwd" | "posture" | "command"
>;

/** A hard block from the authority and protected-path rails. */
interface AuthorityBlock {
	reasonCode: string;
	reasons: string[];
	policySource: SafetyPolicySource;
}

export interface SourcedRule {
	rule: DamageControlRule;
	source: SafetyPolicySource;
}

export function createSafetyPolicyEngine(options: SafetyPolicyEngineOptions = {}): SafetyPolicyEngine {
	const cwd = canonicalizeExistingPath(path.resolve(options.cwd ?? process.cwd()));
	// Write targets resolve relative to the cwd the tools use, un-canonicalized,
	// and both targets and roots are walked physically at each check (F3).
	const writeRootCwd = path.resolve(options.cwd ?? process.cwd());
	const writeRoots = (options.writeRoots ?? []).map((root) => resolvePathBoundary(writeRootCwd, root));
	const writeRootsOsConfined = options.writeRootsOsConfined === true;
	const workerSandboxContained = options.workerSandboxConfinesWrites === true;
	// The cwd repository's git control paths (the shell sandbox's read-only
	// set, the core.hooksPath directories included) are resolved when the
	// engine is built and again only after a call that may have rewritten a
	// git config, so a typed write pays no walk for them: the per-call fs
	// budget is pinned (admission-fs-ops). The name pattern covers a
	// repository created after that.
	let gitControls = resolveGitControls(cwd);
	let gitControlsStale = false;
	/** First secret-bearing path an admitted call read, or null; taints later outbound fetches. */
	let secretRead: string | null = null;
	const secretBearingReadOf = (rawCall: ClassifierCall): string | null => {
		if (rawCall.tool === ToolNames.Read || rawCall.tool === ToolNames.Grep) {
			const target = rawCall.args?.path;
			return typeof target === "string" && isSecretBearingPath(target) ? target : null;
		}
		if (rawCall.tool !== ToolNames.Bash) return null;
		const tokens = flowSourceCallFor(rawCall, cwd).readTokens ?? [];
		return tokens.find((token) => isSecretBearingPath(token)) ?? null;
	};
	const gitControlHit = (call: ClassifierCall, candidates: ReturnType<typeof mutationCandidates>): string | null => {
		if (!WRITE_ROOT_TOOLS.has(call.tool)) return null;
		if (gitControlsStale) {
			gitControls = resolveGitControls(cwd);
			gitControlsStale = false;
		}
		return gitControlLanding(candidates, gitControls);
	};
	const skillRoots = activePancodeSkillRoots(cwd);
	// PanCode's own trees are the operator's real directories, captured once when the session's engine is built; a HOME or
	// PANCODE_* value a command assigns never adds to them (M-1).
	const ownedTrees = pancodeOwnedTrees(cwd);
	/** Where a settings launch may relocate PanCode's trees: the workspace and its scratch roots, never these trees. */
	const settingsHomes = (scratchRoots: ReadonlyArray<string>): SettingsHomeScope => ({
		ownTrees: ownedTrees.roots,
		writableRoots: [cwd, ...scratchRoots],
	});
	const readExemptRoots = [
		...readScopeExemptRoots(cwd),
		...(options.readExemptRoots ?? []).map((root) => ({ path: root, operatorOwned: false })),
	];
	const baseRules = getCachedBaseRuleset();
	const projectPolicy = options.projectPolicy ?? gateProjectSafetyPolicy(cwd, loadProjectSafetyPolicy(cwd));
	const projectPolicyRoot =
		projectPolicy.path === null ? cwd : path.dirname(path.dirname(path.resolve(projectPolicy.path)));
	const compileEnginePathPolicy = (defaults: PathPolicyInput): CompiledPathPolicy => {
		const pathPolicyInput = projectPolicy.disableDefaultPathPolicy
			? projectPolicy.pathPolicy
			: mergePathPolicyInputs(defaults, projectPolicy.pathPolicy);
		// PanCode's own secret store, the desktop app's launch token, the config and build-tool files that hold a secret now and user
		// skills, by absolute path.
		// Config directory expansion has to happen here because
		// the list cannot call config helpers at module scope.
		const expandedDefaults = mergePathPolicyInputs(mergePathPolicyInputs(pathPolicyInput, OPERATOR_PATH_POLICY), {
			zeroAccessPaths: [...pancodeCredentialStorePaths(), ...pancodeControlPaths(), ...configSecrets],
			readOnlyPaths: [
				...pancodeSkillsRootPaths(),
				path.join(pancodeConfigDir(), "settings.yaml"),
				workspaceTrustDirectory(),
			],
		});
		return compilePathPolicy(expandedDefaults, projectPolicyRoot);
	};
	let configSecrets = conditionalSecretPaths();
	let pathPolicy = compileEnginePathPolicy(DEFAULT_DAMAGE_CONTROL_PATH_POLICY);
	// The operator's own session deletes build outputs and never hand-edits them
	// (#419), so its deletes are judged without the default build-output
	// entries, at default and at yolo alike. A project's own entries still
	// apply. Compiled on first use: most engines never judge such a delete.
	let operatorDeletePathPolicy: CompiledPathPolicy | null = null;
	const operatorDeletePolicy = (): CompiledPathPolicy => {
		operatorDeletePathPolicy ??= compileEnginePathPolicy({
			...DEFAULT_DAMAGE_CONTROL_PATH_POLICY,
			readOnlyPaths: (DEFAULT_DAMAGE_CONTROL_PATH_POLICY.readOnlyPaths ?? []).filter(
				(entry) => !BUILD_OUTPUT_PATHS.includes(entry),
			),
		});
		return operatorDeletePathPolicy;
	};
	const flowTrusted = projectPolicy.trustVerdict === "trusted" && projectPolicy.valid;
	// The approved flow section is remembered while trusted and consulted while
	// not, so an unapproved edit cannot unlabel files an approved rule named.
	// A snapshot that cannot be written or read is a refusal, not a fallback.
	let flowRefusal: string | null = null;
	let approvedFlow: ApprovedFlowPolicy | null = null;
	if (projectPolicy.path === null && projectPolicy.valid) {
		// Deleting the policy disables future source labeling; carried labels stay in the session ledger.
		flowRefusal = forgetApprovedFlowPolicy(cwd);
	} else if (flowTrusted && projectPolicy.hash !== null && projectPolicy.path !== null) {
		flowRefusal =
			projectPolicy.informationFlow.sources.length > 0
				? rememberApprovedFlowPolicy(cwd, projectPolicy.path, projectPolicy.hash, projectPolicy.informationFlow)
				: forgetApprovedFlowPolicy(cwd);
	} else {
		const recalled = recallApprovedFlowPolicy(cwd);
		if (recalled.kind === "approved") approvedFlow = recalled.approved;
		else if (recalled.kind === "unavailable") flowRefusal = recalled.reason;
	}
	const informationFlow = compileInformationFlowPolicy(
		projectPolicy.informationFlow,
		projectPolicyRoot,
		projectPolicy.hash,
		flowTrusted,
		approvedFlow,
		flowRefusal,
	);
	// Bash-read scanning tests argument tokens against zero-access entries only:
	// read-only paths stay readable from bash by design, secrets do not.
	const zeroAccessOf = (policy: CompiledPathPolicy): CompiledPathPolicy => ({
		root: policy.root,
		entries: policy.entries.filter((entry) => entry.kind === "zeroAccessPaths"),
		diagnostics: [],
	});
	let zeroAccessPolicy = zeroAccessOf(pathPolicy);
	/**
	 * settings.yaml, mcp.yaml and the build-tool settings turn secret when the operator adds a header target, a server
	 * token or a repository password mid-session, so a call that can read checks them again. A write or edit skips it: its fs calls are pinned (admission-fs-ops).
	 */
	const refreshConfigSecrets = (): void => {
		const next = conditionalSecretPaths();
		if (next === configSecrets) return;
		configSecrets = next;
		pathPolicy = compileEnginePathPolicy(DEFAULT_DAMAGE_CONTROL_PATH_POLICY);
		zeroAccessPolicy = zeroAccessOf(pathPolicy);
		operatorDeletePathPolicy = null;
	};

	// Base pack rules apply at every posture, so they are sourced once at
	// construction. Building the array inside evaluate() re-allocated it on
	// every admission for no behavioral gain.
	const sourcedRules: SourcedRule[] = baseRules.rules.map((rule) => ({ rule, source: "damage-control:base" }));
	/**
	 * The trust, settings, skill, dev-root, protected-path and zero-access rails,
	 * in the order a top-level call meets them.
	 */
	const authorityBlock = (
		call: ClassifierCall,
		callCwd: string,
		mutationCommand: string | null,
		scannedCommand: string | null,
		candidates: ReturnType<typeof mutationCandidates>,
		walkMemo: ReturnType<typeof createPathWalkMemo>,
		deletes: CompiledPathPolicy,
		homes: SettingsHomeScope | null,
	): AuthorityBlock | null => {
		if (mutationCommand !== null && invokesTrustMutation(mutationCommand)) {
			return {
				reasonCode: "trust-authority",
				reasons: ["workspace trust grants require the operator CLI"],
				policySource: "builtin-classifier",
			};
		}
		if (mutationCommand !== null && invokesSettingsMutation(mutationCommand, homes)) {
			return {
				reasonCode: SETTINGS_AUTHORITY_RULE_ID,
				reasons: [SETTINGS_AUTHORITY_REASON],
				policySource: "builtin-classifier",
			};
		}
		if (
			skillMutationReason(
				[path.join(pancodeConfigDir(), "settings.yaml"), workspaceTrustDirectory()],
				candidates,
				walkMemo,
			) !== null
		) {
			return {
				reasonCode: "path-policy:readOnlyPaths",
				reasons: ["PanCode settings and workspace trust records are operator-owned and cannot be mutated by tools"],
				policySource: "builtin-classifier",
			};
		}
		const skillReason =
			mutationCommand !== null && invokesPancodeSkillMutation(mutationCommand, true)
				? "resource installation and lifecycle changes require the operator CLI or an explicit operator install choice; draft outside installed resource roots"
				: skillMutationReason(skillRoots, candidates, walkMemo);
		if (skillReason !== null) {
			return { reasonCode: "skill-authority", reasons: [skillReason], policySource: "builtin-classifier" };
		}
		const devRootReason = foreignDevRootReason(candidates, walkMemo);
		if (devRootReason !== null) {
			return { reasonCode: "dev-root-owned", reasons: [devRootReason], policySource: "builtin-classifier" };
		}
		// The path policy runs regardless of project policy validity. When
		// `.pancode/safety.yaml` is invalid, the loader has already dropped every
		// project-authored path entry and forced `disableDefaultPathPolicy`
		// off, so the compiled policy here carries exactly the built-in
		// defaults. Evaluating it unconditionally keeps default credential
		// protection (`.env`, `~/.ssh/`, `credentials.yaml`, ...) active on a
		// broken config, which is the fail-closed intent; project-authored
		// additions and exemptions stay gated on validity inside the loader.
		const pathBlock = evaluateProjectPathPolicy(pathPolicy, deletes, call, callCwd, walkMemo);
		if (pathBlock !== null) {
			// Only an entry the project authored is the project's policy; the rest is PanCode's built-in protection.
			const authored = evaluateProjectPathPolicy(operatorPolicy(), operatorPolicy(), call, callCwd, walkMemo) !== null;
			return {
				reasonCode: pathBlock.reasonCode,
				reasons: [pathBlock.reason],
				policySource: authored ? "project-policy" : "damage-control:base",
			};
		}
		// A shell target after a literal cd is also judged from the directory
		// that cd leaves the shell in, so `cd .pancode && echo x > safety.yaml`
		// meets the same rail as `echo x > .pancode/safety.yaml`.
		if (call.tool === ToolNames.Bash && mutationCommand !== null) {
			for (const target of extractCommandCdScopedTargets(mutationCommand)) {
				const decision = evaluatePathPolicy(
					target.operation === "delete" ? deletes : pathPolicy,
					target.operation,
					target.path,
					callCwd,
					walkMemo,
				);
				if (decision.kind === "block") {
					return { reasonCode: decision.reasonCode, reasons: [decision.reason], policySource: "project-policy" };
				}
			}
		}
		// Bash reads of zero-access paths. pathPolicyTargets extracts only
		// write/delete targets from bash, so `cat .env` used to run and its
		// output persisted into the transcript and evidence previews. Any
		// path-like argument token matching a zero-access entry blocks the
		// command; the one carve-out is the exit-code-only presence check
		// (`grep -q`/`grep -sq` with a ^NAME= pattern), which is the safe
		// protocol the credentials skill teaches.
		if (scannedCommand !== null) {
			const secretRead = evaluateBashZeroAccessRead(zeroAccessPolicy, scannedCommand, callCwd);
			if (secretRead !== null) {
				// Only an entry the project authored is the project's policy; the rest is PanCode's built-in protection.
				const own = operatorPolicy();
				const ownZero = { ...own, entries: own.entries.filter((entry) => entry.kind === "zeroAccessPaths") };
				const authored = evaluateBashZeroAccessRead(ownZero, scannedCommand, callCwd) !== null;
				return {
					reasonCode: "secret_path_bash",
					reasons: [
						`${bashZeroAccessReason(secretRead)}. Check presence with exit codes only (grep -sq "^NAME=" <file>); have the user supply values through their own terminal (read -s), never through chat or command output.`,
					],
					policySource: authored ? "project-policy" : "damage-control:base",
				};
			}
		}
		return null;
	};
	// The yolo floor's text rules: the pack rules it keeps by id, then its own.
	const floorRules: SourcedRule[] = [
		...sourcedRules.filter((entry) => YOLO_FLOOR_PACK_RULE_IDS.has(entry.rule.id)),
		...YOLO_FLOOR_TEXT_RULES.map((rule) => ({ rule, source: "damage-control:base" as const })),
	];
	/**
	 * Operator-authored path rules (#407): the entries of a trusted
	 * `.pancode/safety.yaml`, kept apart from the built-in defaults they are
	 * merged with everywhere else. The loader drops an untrusted file's entries,
	 * so what is here is what the operator approved. While it carries any, the
	 * file itself is read-only too: an edit would drop its trust, and with it
	 * every rule it holds.
	 */
	let operatorPathPolicy: CompiledPathPolicy | null = null;
	const operatorPolicy = (): CompiledPathPolicy => {
		if (operatorPathPolicy !== null) return operatorPathPolicy;
		const own = projectPolicy.pathPolicy;
		const authored = [own.zeroAccessPaths, own.readOnlyPaths, own.noWritePaths, own.noDeletePaths].some(
			(entries) => (entries?.length ?? 0) > 0,
		);
		operatorPathPolicy = compilePathPolicy(
			authored && projectPolicy.path !== null ? mergePathPolicyInputs(own, { readOnlyPaths: [projectPolicy.path] }) : own,
			projectPolicyRoot,
		);
		return operatorPathPolicy;
	};
	/** A write or delete into one of PanCode's own trees, however the command spells or reaches it. */
	const pancodeOwnedMutation = (
		call: ClassifierCall,
		callCwd: string,
		command: string | null,
		trees: PancodeOwnedTrees,
		depth = 0,
	): boolean => {
		const scanned = pathPolicyTargets(call, callCwd)
			.filter((target) => target.operation !== "read")
			.map((target) => ({ ...target, path: accountHomeExpanded(target.path) }));
		// Row 314: what bash makes of the words, and the writers, deleters and aliases the general scan does not read.
		const reading = command === null ? null : pancodeFloorReading(command);
		if (reading !== null && command !== null) {
			// `xargs rm` removes names from input no scanner places: any such command naming a PanCode tree holds.
			if (reading.fromInput && pancodeFloorText(command).some((text) => namesPancodeTree(text, trees))) return true;
			if (
				depth < 2 &&
				reading.aliases.some((body) =>
					pancodeOwnedMutation({ tool: ToolNames.Bash, args: { command: body } }, callCwd, body, trees, depth + 1),
				)
			)
				return true;
		}
		const written =
			command === null || reading === null
				? scanned
				: [...scanned, ...sameCommandWriteTargets(command, callCwd, trees.roots), ...reading.targets];
		if (written.length === 0) return false;
		// Each target also as the command's own assignments spell it, so a path split over them is judged whole.
		const targets =
			command === null
				? written
				: [
						...written,
						...written.flatMap((target) =>
							assignedSpellings(command, target.path).map((spelling) => ({
								...target,
								path: accountHomeExpanded(spelling),
							})),
						),
					];
		const spelled = targets.some(
			(target) =>
				PANCODE_OWNED_VARIABLE.test(target.path) ||
				trees.spellings.some((spelling) => target.path === spelling || target.path.startsWith(`${spelling}/`)),
		);
		if (spelled || (command !== null && writesThroughPancodeVariable(command, targets, trees))) return true;
		const memo = createPathWalkMemo();
		if (skillMutationReason(trees.roots, mutationCandidates(targets, callCwd, command, memo), memo) !== null) return true;
		return (
			command !== null &&
			pancodeFloorReaches(targets, pancodeFloorBases(command, callCwd, trees.roots, memo), trees.roots, memo)
		);
	};
	/**
	 * The workspace `.git` floor over a command as written, then over its scratch projection (`$TMPDIR` spelled out),
	 * which only adds placeable paths: a hit in either reading holds (row 261).
	 */
	const workspaceGitHit = (command: string, callCwd: string): YoloFloorHit | null => {
		const written = yoloFloorWorkspaceGitHit(command, callCwd, cwd);
		if (written !== null) return written;
		const projected = resolveScratchDeleteOperands(command).command;
		return projected === command ? null : yoloFloorWorkspaceGitHit(projected, callCwd, cwd);
	};
	const floorMatch = (hit: YoloFloorHit, actionClass = "system_modify") => ({
		match: { ruleId: hit.ruleId, reason: hit.reason, actionClass, block: true } satisfies DamageControlMatch,
		source: "builtin-classifier" as const,
	});
	/**
	 * The floor a command meets: the text rules over every scan, then mkfs and
	 * wipefs, deletes by target, trust grants and PanCode's trees over the whole
	 * command. The parsers follow its cds, substitutions and `sh -c` scripts
	 * themselves, so a segment read alone would lose a cd and misplace a delete.
	 */
	const commandFloorHit = (
		texts: ReadonlyArray<string>,
		commands: ReadonlyArray<string>,
		callCwd: string,
		trees: PancodeOwnedTrees,
		rawText = false,
		gitOnly = false,
		ownedReadings?: ReadonlyArray<string>,
		homes: SettingsHomeScope | null = null,
	): { match: DamageControlMatch; source: SafetyPolicySource } | null => {
		if (gitOnly) {
			for (const candidate of commands) {
				const git = workspaceGitHit(candidate, callCwd);
				if (git !== null) return floorMatch(git);
			}
			return null;
		}
		const text = matchSourcedRule(texts, floorRules);
		if (text !== null) return text;
		const command = commands[0] ?? "";
		for (const candidate of commands) {
			const executable = yoloFloorExecutableHit(candidate);
			if (executable !== null) return floorMatch(executable);
			const deleted = yoloFloorDeleteHit(candidate, callCwd, cwd);
			if (deleted !== null) return floorMatch(deleted);
			// Relative deletes resolve from the call's directory and every cd landing, whatever separates them (row 261).
			const git = workspaceGitHit(candidate, callCwd);
			if (git !== null) return floorMatch(git);
		}
		if (invokesTrustMutation(command, rawText)) {
			return floorMatch({
				ruleId: YOLO_FLOOR_RULE_IDS.trustAuthority,
				reason: `matched ${YOLO_FLOOR_RULE_IDS.trustAuthority}: workspace trust grants require the operator CLI`,
			});
		}
		if (invokesSettingsMutation(command, homes)) {
			return floorMatch({
				ruleId: YOLO_FLOOR_RULE_IDS.settingsAuthority,
				reason: `matched ${YOLO_FLOOR_RULE_IDS.settingsAuthority}: ${SETTINGS_AUTHORITY_REASON}`,
			});
		}
		// A variable the command pins is judged by what it holds (CLI-H4, M-1).
		for (const owned of ownedReadings ?? pinnedPancodeCommand(command).readings) {
			if (pancodeOwnedMutation({ tool: ToolNames.Bash, args: { command: owned } }, callCwd, owned, trees)) {
				return floorMatch({
					ruleId: YOLO_FLOOR_RULE_IDS.pancodeOwned,
					reason: `matched ${YOLO_FLOOR_RULE_IDS.pancodeOwned}: writes into or deletes PanCode's own config, data, state or trust records, which only the operator changes`,
				});
			}
		}
		return null;
	};
	/** One script line against the floor, from every directory the scan places it in. */
	const floorLine =
		(trees: PancodeOwnedTrees, gitOnly = false) =>
		(raw: string, read: ScriptLine, callCwd: string) => {
			// A here-document body or a comment is data the script carries, not a command.
			if (read.data) return null;
			const texts = read.expanded === raw ? [raw] : [read.expanded, raw];
			for (const base of read.bases ?? [callCwd]) {
				const hit = commandFloorHit(texts, texts, base, trees, false, gitOnly);
				if (hit !== null) return hit;
			}
			return null;
		};
	/**
	 * Reads of PanCode's own credential store are floor at both autonomy levels:
	 * no task needs PanCode's provider tokens. Typed
	 * reads of the store or its lock, and a shell word naming either one or the
	 * config directory that holds them, are refused; a typed listing or search
	 * of that directory already drops the store from its results.
	 */
	const credentialReadHit = (call: ClassifierCall, callCwd: string, command: string | null): YoloFloorHit | null => {
		const stores = pancodeCredentialStorePaths();
		if (stores.length === 0) return null;
		const forms = (entry: string): string[] => {
			const lexical = path.resolve(entry);
			const real = canonicalizePath(lexical);
			return real === null || real === lexical ? [lexical] : [lexical, real];
		};
		const files = new Set(stores.flatMap((store) => [store, `${store}.lock`]).flatMap(forms));
		const dirs = new Set(stores.map((store) => path.dirname(store)).flatMap(forms));
		const hit = (spelled: string): YoloFloorHit => ({
			ruleId: YOLO_FLOOR_RULE_IDS.pancodeCredentials,
			reason: `matched ${YOLO_FLOOR_RULE_IDS.pancodeCredentials}: reads PanCode's own credential store (${spelled}), which no task needs`,
		});
		const memo = createPathWalkMemo();
		const lands = (raw: string, wholeDirectory: boolean): boolean => {
			const home = homedir();
			let target = raw.replace(/^(?:~(?=\/|$)|\$\{HOME\}|\$HOME(?!\w))/u, home);
			if (/[$`]/u.test(target)) {
				return (
					PANCODE_CONFIG_VARIABLE.test(target) &&
					(target.includes("credentials.yaml") || /^\$\{?PANCODE_CONFIG_DIR\}?\/?\*?$/u.test(target))
				);
			}
			const wildcard = target.search(/[*?[{]/u);
			if (wildcard >= 0) {
				const slash = target.lastIndexOf("/", wildcard);
				target = slash < 0 ? "." : slash === 0 ? "/" : target.slice(0, slash);
			}
			const lexical = path.resolve(callCwd, target);
			const real = canonicalizeRawPath(target, callCwd, memo);
			return [lexical, ...(real === null ? [] : [real])].some(
				(landing) => files.has(landing) || (wholeDirectory && dirs.has(landing)),
			);
		};
		for (const target of pathPolicyTargets(call, callCwd)) {
			if (target.operation === "read" && lands(target.path, false)) return hit(target.path);
		}
		if (command === null) return null;
		// Naming the directory reads the store unless every step only lists names.
		const listsOnly = shellCommandSteps(command).every((step) => NAME_LISTERS.has(step.executable));
		// Each distinct token once: a long heredoc repeats most of its words (x6-7b).
		const judged = new Set<string>();
		for (const token of bashPathTokenCandidates(command)) {
			if (judged.has(token)) continue;
			judged.add(token);
			if (lands(token, !listsOnly)) return hit(token);
		}
		return null;
	};
	/**
	 * The floor for one call (#407), at yolo and at the operator's default: the
	 * command's own text and targets, reads of PanCode's credential store, then
	 * each shell script the call runs by literal path, read line by line. A
	 * script the scan cannot read through runs. `gitOnly` reads the command and its scripts for the workspace `.git`
	 * rule alone, for a call judged without the operator's scope, and leaves what it cannot read to the caller.
	 */
	const floorBlock = (
		call: ClassifierCall,
		callCwd: string,
		originalCommand: string | null,
		gitOnly = false,
		homes: SettingsHomeScope | null = null,
	): Omit<
		SafetyPolicyDecision,
		"kind" | "classification" | "tool" | "actionClass" | "cwd" | "posture" | "command"
	> | null => {
		const command = originalCommand === null ? null : yoloFloorCommandText(originalCommand);
		const trees = ownedTrees;
		const pins = command === null || gitOnly ? null : pinnedPancodeCommand(command);
		const held = (
			hit: { match: DamageControlMatch; source: SafetyPolicySource },
			reasons: string[] = [],
			floorBasis?: string,
		) => ({
			ruleId: hit.match.ruleId,
			reasonCode: `${YOLO_FLOOR_REASON_PREFIX}${hit.match.ruleId}`,
			reasons: [
				...reasons,
				hit.match.reason,
				...(YOLO_FLOOR_AUTHORITY_RULE_IDS.has(hit.match.ruleId) ? [YOLO_FLOOR_AUTHORITY_REMEDY] : []),
				"the yolo floor holds at every autonomy level",
			],
			match: hit.match,
			policySource: hit.source,
			...(floorBasis !== undefined ? { floorBasis } : {}),
		});
		if (command !== null) {
			const decoded = [decodedAnsiCCommand(command), decodedLocaleQuoting(command)].filter(
				(text): text is string => text !== null,
			);
			const commands = [...new Set([command, ...decoded])];
			// Each decoded spelling gets its own pin reading: a pin read only from the text as written misses what `$'...'` spells.
			const owned =
				pins === null
					? undefined
					: [
							...new Set(commands.flatMap((text) => (text === command ? pins.readings : pinnedPancodeCommand(text).readings))),
						];
			const hit = commandFloorHit(
				[...new Set([...commands, ...shellCommandSegments(command)])],
				commands,
				callCwd,
				trees,
				false,
				gitOnly,
				owned,
				homes,
			);
			if (hit !== null) return held(hit);
		} else if (!gitOnly && pancodeOwnedMutation(call, callCwd, null, trees)) {
			return held(
				floorMatch({
					ruleId: YOLO_FLOOR_RULE_IDS.pancodeOwned,
					reason: `matched ${YOLO_FLOOR_RULE_IDS.pancodeOwned}: writes into PanCode's own config, data, state or trust records, which only the operator changes`,
				}),
			);
		}
		const floorCall = command === originalCommand ? call : { ...call, args: { ...call.args, command } };
		const credentials = gitOnly ? null : credentialReadHit(floorCall, callCwd, command);
		if (credentials !== null) return held(floorMatch(credentials, "read"));
		const raw = command === null || gitOnly ? null : yoloFloorRawCandidates(command);
		if (raw?.overflow === true) {
			return held(
				floorMatch({
					ruleId: YOLO_FLOOR_RULE_IDS.rawText,
					reason: `matched ${YOLO_FLOOR_RULE_IDS.rawText}: ${RAW_TEXT_REASON}, and this one is too large to read that way; split it, or write its text to a file with the write tool and pass the file`,
				}),
				[],
				`a line holding a command substitution is also read as raw text, and this one's reading passes the floor's ${MAX_RAW_TEXT_BYTES}-byte raw-text budget`,
			);
		}
		for (const candidate of raw?.candidates ?? []) {
			const read = credentialReadHit({ tool: ToolNames.Bash, args: { command: candidate } }, callCwd, candidate);
			const hit =
				commandFloorHit([candidate], [candidate], callCwd, trees, true, false, pins?.apply(candidate)) ??
				(read === null ? null : floorMatch(read, "read"));
			if (hit !== null) {
				// Moving an operator-only command into a file changes nothing: the script scan refuses it there too (CLI-P31).
				const remedy = YOLO_FLOOR_AUTHORITY_RULE_IDS.has(hit.match.ruleId)
					? YOLO_FLOOR_AUTHORITY_REMEDY
					: "write that text to a file with the write tool and pass the file";
				const reason = `matched ${YOLO_FLOOR_RULE_IDS.rawText}: ${RAW_TEXT_REASON}: "${candidate.slice(0, 200)}" is a floor command even if it is only quoted data (fail-closed); ${remedy}`;
				return held(
					{ match: { ...hit.match, ruleId: YOLO_FLOOR_RULE_IDS.rawText, reason }, source: hit.source },
					[hit.match.reason],
					`a line holding a command substitution is also read as raw text, and that reading holds the floor command ${hit.match.ruleId}`,
				);
			}
		}
		// A script's lines run in turn, so an earlier line could move a home a later launch names: scripts keep the floor.
		const line = floorLine(trees, gitOnly);
		const scriptHit = (scan: ScriptHit | null) =>
			scan === null ? null : held(scan, [`script ${scan.file} line ${scan.line}: ${scan.text.slice(0, 200)}`]);
		const budgets: ScriptBudget[] = [];
		const budgetFor = (): ScriptBudget => {
			const budget = newScriptBudget();
			budgets.push(budget);
			return budget;
		};
		if (call.tool === ToolNames.RunScript && runsUnderShell(call.args)) {
			const script = typeof call.args?.script === "string" ? call.args.script.trim() : "";
			const file = script === "" ? null : scriptPath(script, cwd);
			const hit = scriptHit(
				file === null ? null : scanNamedScript(file, line, callCwd, [callCwd], budgetFor(), { zero: file, source: file }),
			);
			if (hit !== null) return hit;
		}
		// A leading `~`, `$HOME` or `${HOME}` is the operator's home only while nothing before it may set HOME (row 215).
		const homeKnown = command === null || !commandMayChangeHome(command);
		const runs = call.tool === ToolNames.Bash && command !== null ? yoloFloorScriptRuns(command, "~") : [];
		if (call.tool === ToolNames.Bash && command !== null && hasUnparsedShellScript(command)) {
			const cwds = commandMoveBases(command, callCwd);
			const written = commandWrittenPaths(command, cwds ?? [callCwd], newWrittenPaths());
			const budget = budgetFor();
			const scripts = shellScriptSources(command, "~");
			// A script piped in, fed as a here-document or here-string, read through `-s` or a startup file, or nested past
			// the parse is never read; the scripts the command names beside it still are (row 215).
			if (scripts.unnamed) recordUnplaced(budget, "a script the command runs without naming it");
			// A file the command sources may set HOME before a shell runs a named script.
			const shellHome = homeKnown && !runs.some((run) => run.sourced);
			for (const script of scripts.sources) {
				const hit = scriptHit(scanCommandScript(script, line, callCwd, cwds, written, budget, false, shellHome));
				if (hit !== null) return hit;
			}
		}
		// `./x.sh` and `source x.sh` run a file as `bash x.sh` does, so the floor reads it the same way (CLI-P31). A file
		// the scan cannot place or read goes to the safety judge (row 215).
		if (command !== null && runs.length > 0) {
			const cwds = commandMoveBases(command, callCwd);
			const written = commandWrittenPaths(command, cwds ?? [callCwd], newWrittenPaths());
			const budget = budgetFor();
			let home = homeKnown;
			for (const run of runs) {
				const source = { path: run.path, program: !run.sourced, sourced: run.sourced, stdin: false };
				const hit = scriptHit(scanCommandScript(source, line, callCwd, cwds, written, budget, !run.sourced, home));
				if (hit !== null) return hit;
				// A sourced file may set HOME for every script after it.
				if (run.sourced) home = false;
			}
		}
		if (gitOnly) return null;
		// No copy the scan could read refuses, but a sourced name was looked up before the bash tool's PATH was known.
		if (budgets.some((budget) => budget.pathPending)) {
			return {
				ruleId: LOGIN_PATH_PENDING_RULE_ID,
				reasonCode: LOGIN_PATH_PENDING_RULE_ID,
				reasons: [LOGIN_PATH_PENDING_REASON],
				policySource: "builtin-classifier",
			};
		}
		// No script the scan read refuses, but one it runs could not be placed or read: the judge decides it (row 215).
		const unplaced = budgets.flatMap((budget) => budget.unplaced);
		// Row 314: a script the floor cannot read, in a command naming one of PanCode's trees, may write there: it holds.
		if (
			unplaced.length > 0 &&
			command !== null &&
			pancodeFloorText(command).some((text) => namesPancodeTree(text, trees))
		) {
			return held(
				floorMatch({
					ruleId: YOLO_FLOOR_RULE_IDS.pancodeOwned,
					reason: `matched ${YOLO_FLOOR_RULE_IDS.pancodeOwned}: runs a script the floor cannot read in a command naming PanCode's own config, data, state or trust records, which only the operator changes; write the script to a file with the write tool and run that file`,
				}),
				[scriptUnplaceableReason(unplaced)],
			);
		}
		if (unplaced.length > 0) {
			return {
				ruleId: SCRIPT_UNPLACEABLE_RULE_ID,
				reasonCode: SCRIPT_UNPLACEABLE_RULE_ID,
				reasons: [scriptUnplaceableReason(unplaced)],
				policySource: "builtin-classifier",
			};
		}
		return null;
	};
	/** An operator-authored path rule this call breaks, judged without the built-in defaults (#407). */
	const operatorRuleBlock = (
		call: ClassifierCall,
		callCwd: string,
		command: string | null,
	): Omit<
		SafetyPolicyDecision,
		"kind" | "classification" | "tool" | "actionClass" | "cwd" | "posture" | "command"
	> | null => {
		const policy = operatorPolicy();
		if (policy.entries.length === 0) return null;
		const provenance = {
			policySource: "project-policy" as const,
			...(projectPolicy.hash !== null ? { policyHash: projectPolicy.hash } : {}),
			...(projectPolicy.path !== null ? { projectPolicyPath: projectPolicy.path } : {}),
		};
		const held = "an operator-authored rule in .pancode/safety.yaml holds at yolo";
		const judged = command !== null && call.tool !== ToolNames.Bash ? { tool: ToolNames.Bash, args: { command } } : call;
		const pathBlock = evaluateProjectPathPolicy(policy, policy, judged, callCwd, createPathWalkMemo());
		if (pathBlock !== null) {
			return {
				ruleId: pathBlock.reasonCode,
				reasonCode: `operator-rule:${pathBlock.reasonCode}`,
				reasons: [pathBlock.reason, held],
				...provenance,
			};
		}
		if (command === null) return null;
		const zeroAccess: CompiledPathPolicy = {
			root: policy.root,
			entries: policy.entries.filter((entry) => entry.kind === "zeroAccessPaths"),
			diagnostics: [],
		};
		const secretRead = evaluateBashZeroAccessRead(zeroAccess, command, callCwd);
		if (secretRead === null) return null;
		return {
			ruleId: "secret_path_bash",
			reasonCode: "operator-rule:secret_path_bash",
			reasons: [bashZeroAccessReason(secretRead), held],
			...provenance,
		};
	};

	/**
	 * What the operator's default makes of the damage-control rules a call
	 * matched (Phase 2c). A hit the workspace snapshot taken right before the
	 * call can undo yields; every other former hard block is deferred as an ask
	 * for the safety judge; an authored ask rule no snapshot undoes keeps its
	 * ask rail.
	 */
	const resortDamageControl = (
		scans: ReadonlyArray<string>,
		raw: Classification,
		command: string | null,
		resort: DefaultResort,
	): ResortedDamageControl => {
		const hits = scans.length > 0 ? matchingSourcedRules(scans, sourcedRules) : [];
		const undoes = (entry: { match: DamageControlMatch; pattern: RegExp }): boolean =>
			resort.snapshots &&
			snapshotRecoverableRule(entry.match.ruleId, entry.pattern, scans, command, resort.scratchRoots, cwd);
		const yielded = hits.filter(undoes);
		const hard = hits.filter((entry) => isHardMatch(entry.match) && !undoes(entry));
		const soft = hits.filter((entry) => !isHardMatch(entry.match) && !undoes(entry));
		const patternDestructive = raw.actionClass === "git_destructive";
		const patternUndone =
			patternDestructive &&
			resort.snapshots &&
			raw.reasons.every((reason) => SNAPSHOT_RECOVERABLE_GIT_PATTERNS.has(reason)) &&
			!cleansIgnoredFiles(command ?? "");
		const first = hard[0];
		let ask: DeferredAsk | null = null;
		if (first !== undefined) {
			ask = {
				ruleId: first.match.ruleId,
				reasonCode: `damage-control:${first.match.ruleId}`,
				reasons: [...raw.reasons, ...hard.map((entry) => entry.match.reason), DEFAULT_RESORTED_REASON],
				match: first.match,
				policySource: first.source,
			};
		} else if (patternDestructive && !patternUndone && soft.length === 0) {
			ask = {
				reasonCode: "classification:git_destructive",
				reasons: [...raw.reasons, DEFAULT_RESORTED_REASON],
				policySource: "damage-control:base",
			};
		}
		const askRule = soft[0] === undefined ? null : { match: soft[0].match, source: soft[0].source };
		const ruling = first ?? askRule;
		// A hit the snapshot undoes does not lend the call its class, and a
		// recoverable discard runs as the command it is.
		const classification =
			ruling !== null
				? effectiveClassification(raw, ruling.match)
				: patternUndone
					? { actionClass: "execute" as const, reasons: [...raw.reasons, "snapshot-recoverable"] }
					: raw;
		const recoverable = yielded[0];
		return {
			classification,
			ask,
			askRule,
			recoverable: recoverable !== undefined ? { match: recoverable.match } : patternUndone ? { match: null } : null,
		};
	};

	/**
	 * Settles a decision of the operator's default (Phase 2c): a hard block
	 * stands; a deferred former block asks unless an operator-only ask already
	 * holds the call; a contained call carries the sandbox it runs in; a call
	 * whose discards or deletes only the snapshot taken before it undoes says
	 * so, and the registry refuses it when that snapshot cannot be taken.
	 */
	/**
	 * A command bash passed but did not recognize, run where this worker's OS sandbox confines its writes, takes the verdict
	 * main bash's sandbox gives it at default (row 371 for hidden content, M-49 for any other): it passed every other rail,
	 * so autonomy admits it as contained. A call main bash's sandbox would not hold (`unsandboxed: true`, outward) still
	 * meets the worker's permission routing, as does every call of a worker with no such sandbox.
	 */
	const workerContainedUnrecognized = (
		bash: ReturnType<typeof evaluateBashPolicy>,
		call: ClassifierCall,
		classification: Classification,
		command: string | null,
		posture: string | undefined,
	): ReturnType<typeof evaluateBashPolicy> => {
		if (!workerSandboxContained || command === null || posture === CONFIRMED_POSTURE) return bash;
		if (bash.kind !== "allow" || bash.execRecognition !== "unrecognized") return bash;
		if (call.tool !== ToolNames.Bash || !containedShellCall(call, classification, null)) return bash;
		return {
			...bash,
			ruleId: WORKER_SANDBOX_CONTAINED_RULE_ID,
			reasonCode: WORKER_SANDBOX_CONTAINED_RULE_ID,
			reasons: [
				hidesShellContent(command, posture)
					? "its variables, script or interpreter source hide which paths it touches, and this worker's OS sandbox confines its writes to the worker's own roots, as main bash's sandbox does at default"
					: "it is outside the no-prompt set, and this worker's OS sandbox confines its writes to the worker's own roots, as main bash's sandbox does at default",
				...bash.reasons,
			],
			execRecognition: "recognized",
		};
	};

	const settleDefault = (
		decision: SafetyPolicyDecision,
		base: Pick<SafetyPolicyDecision, "classification" | "tool" | "actionClass" | "cwd" | "posture" | "command">,
		deferred: DeferredAsk | null,
		resort: DefaultResort,
		recoverable: boolean,
	): SafetyPolicyDecision => {
		if (decision.kind === "block") return decision;
		let out = decision;
		const operatorOnly = out.kind === "ask" && out.ruleId !== undefined && OPERATOR_ONLY_ASKS.has(out.ruleId);
		// An operator's approval of this exact call already answered the deferred ask.
		if (deferred !== null && base.posture !== CONFIRMED_POSTURE && !operatorOnly) {
			out = gateDecision("ask", base, deferred);
		} else if (deferred !== null) {
			out = { ...out, reasons: [...out.reasons, ...deferred.reasons] };
		}
		if (resort.contained) {
			out = {
				...out,
				shellSandbox: {
					workspace: canonicalizePath(cwd) ?? cwd,
					scratchRoots: resort.scratchRoots,
					...(resort.readOnly === true ? { readOnly: true as const } : {}),
				},
			};
		}
		if (recoverable && resort.snapshots) out = { ...out, recoverable: true };
		return out;
	};

	/**
	 * The net for one call. `resort` is the operator's own default (Phase 2c):
	 * damage control a snapshot can undo yields, a former hard block waits as
	 * an ask until the hard rails after it have spoken, and a contained call
	 * meets no ask for what its command text hides.
	 */
	const evaluateCall = (
		rawCall: ClassifierCall,
		posture: string | undefined,
		resort?: DefaultResort,
		homes: SettingsHomeScope | null = resort === undefined ? null : settingsHomes(resort.scratchRoots),
	): SafetyPolicyDecision => {
		const call = normalizeCallPaths(rawCall);
		const rawClassification = scratchRootWrite(classify(call), call, resort?.scratchRoots);
		const command = commandArg(call.args);
		// Resolve verify exactly as the tool does: the check id alone is not the
		// command when the model also supplied argv. Scan and admit that full argv.
		const verifyArgs = call.tool === ToolNames.Verify ? prepareVerifyArguments(call.args ?? {}) : null;
		const verifyResolution = verifyArgs === null ? null : resolveVerifyCall(cwd, verifyArgs);
		const resolvedCheckCwd =
			verifyResolution?.kind === "catalog" || verifyResolution?.kind === "toolchain" || verifyResolution?.kind === "task"
				? resolveProjectVerifierExecutionCwd(verifyResolution.check.cwd, cwd)
				: null;
		const callCwd = typeof resolvedCheckCwd === "string" ? resolvedCheckCwd : cwdArg(call.args, cwd);
		const verifyArgv =
			verifyResolution === null || verifyArgs === null ? null : verifyResolutionArgv(verifyResolution, verifyArgs, cwd);
		const verifyCommand = verifyArgv === null ? null : shellJoin(verifyArgv);
		const scans = (verifyCommand !== null ? [verifyCommand] : damageControlScans(call, rawClassification)).filter(
			(scan) => scan !== "",
		);
		const hit = scans.length > 0 ? matchSourcedRule(scans, sourcedRules) : null;
		const sorted = resort === undefined ? null : resortDamageControl(scans, rawClassification, command, resort);
		const classification = sorted?.classification ?? effectiveClassification(rawClassification, hit?.match);

		// Verify carries no command argument; the resolved argv is what runs, and
		// a refusal or audit row names it.
		const base = baseDecision(call, classification, callCwd, posture, command ?? verifyCommand);

		// Worker write-root containment (Slice C). A write-class tool whose
		// target escapes every permitted root is a final block, ranked ahead of
		// the git/system-modify/path-policy rails so an out-of-root write reports
		// "write-root" even when the classifier escalated it to system_modify
		// (e.g. a write outside cwd). No-op unless the run carries writeRoots.
		const writeRootReason = evaluateWriteRoots(writeRoots, writeRootCwd, call);
		if (writeRootReason !== null) {
			return gateDecision("block", base, {
				ruleId: "write-root",
				reasonCode: "write-root",
				reasons: [writeRootReason],
				policySource: "builtin-classifier",
			});
		}

		// Write-confinement is only honest if the run cannot escape the roots by
		// running an arbitrary command or spawning an unconfined child. Under
		// active writeRoots, execute-class tools (bash, verify, which run project
		// scripts) and dispatch (which spawns a worker not bound to these roots)
		// are blocked outright: they can mutate the filesystem outside the roots.
		if (writeRoots.length > 0 && isWriteConfinementEscape(call, classification.actionClass, writeRootsOsConfined)) {
			return gateDecision("block", base, {
				ruleId: "write-root",
				reasonCode: "write-root",
				reasons: [
					`tool '${call.tool}' (${classification.actionClass}) can mutate the filesystem outside the permitted write roots and is blocked under write-root confinement`,
				],
				policySource: "builtin-classifier",
			});
		}
		if (resolvedCheckCwd instanceof Error) {
			return gateDecision("block", base, {
				ruleId: "verify-cwd-invalid",
				reasonCode: "verify-cwd-invalid",
				reasons: [resolvedCheckCwd.message],
				policySource: "builtin-classifier",
			});
		}

		// An explicit `ask: true` damage-control rule is an authored
		// confirm rail and takes precedence over classifier escalation for
		// the same command (sd-01 M3). Without this, the unconditional
		// git_destructive block made every authored git ask rule dead
		// config. Commands matched only by classifier patterns, and rules
		// with `block: true`, stay hard blocks. The ask rail itself runs
		// only after the fail-closed and path-policy blocks below: hard
		// blocks always win, and the ask rail decides among survivors.
		// The operator's default judged every rule in resortDamageControl.
		const askHit = sorted === null ? (hit?.match.ask === true && hit.match.block !== true ? hit : null) : sorted.askRule;
		let deferred: DeferredAsk | null = sorted?.ask ?? null;
		if (
			sorted === null &&
			askHit === null &&
			(classification.actionClass === "git_destructive" ||
				hit?.match.actionClass === "git_destructive" ||
				hit?.match.block === true)
		) {
			const blockInput: DeferredAsk = {
				reasonCode: hit ? `damage-control:${hit.match.ruleId}` : "classification:git_destructive",
				reasons: [...classification.reasons, ...(hit ? [hit.match.reason] : [])],
				policySource: hit?.source ?? "damage-control:base",
			};
			if (hit?.match.ruleId !== undefined) blockInput.ruleId = hit.match.ruleId;
			if (hit?.match !== undefined) blockInput.match = hit.match;
			return gateDecision("block", base, blockInput);
		}

		// A delete is judged by where it lands, at every autonomy level, after the
		// authored rules so a named catastrophic rule reports itself. The
		// flag rules this replaces let `rm -v -r /` through, blocked scratch
		// cleanup, and taught the model that dropping `-f` got around a block.
		// The operator's default places deletes inside the scratch roots like
		// ones inside the workspace, and asks for any other instead of refusing.
		const deleteReasons = command === null ? [] : bashDeleteReasons(command, bashCwdArg(call.args), resort?.scratchRoots);
		if (deleteReasons.length > 0) {
			const match: DamageControlMatch = {
				ruleId: DELETE_TARGET_RULE_ID,
				reason: `matched ${DELETE_TARGET_RULE_ID}: ${DELETE_TARGET_RULE_DESCRIPTION}`,
				actionClass: "system_modify",
				block: true,
			};
			const input: DeferredAsk = {
				ruleId: DELETE_TARGET_RULE_ID,
				reasonCode: `damage-control:${DELETE_TARGET_RULE_ID}`,
				reasons: [...deleteReasons, match.reason],
				match,
				policySource: "damage-control:base",
			};
			if (resort === undefined) return gateDecision("block", base, input);
			deferred =
				deferred === null
					? { ...input, reasons: [...input.reasons, DEFAULT_RESORTED_REASON] }
					: { ...deferred, reasons: [...deleteReasons, ...deferred.reasons] };
		}
		// A delete inside the workspace is undone only by the workspace snapshot
		// taken before it: without one the operator's default asks for it even
		// when contained, and with one the call is refused if that snapshot fails.
		const scratchProjection =
			resort === undefined || command === null ? null : resolveScratchDeleteOperands(command).command;
		const workspaceDeletes = scratchProjection === null ? [] : deletesNeedingSnapshot(scratchProjection, cwd);
		if (resort !== undefined && !resort.snapshots && workspaceDeletes.length > 0) {
			const reason = `deletes ${workspaceDeletes.slice(0, 3).join(", ")} with no workspace snapshot to undo it: the workspace is not a git work tree or safety.snapshots is off`;
			deferred =
				deferred === null
					? {
							ruleId: DELETE_WITHOUT_SNAPSHOT_RULE_ID,
							reasonCode: DELETE_WITHOUT_SNAPSHOT_RULE_ID,
							reasons: [reason],
							policySource: "builtin-classifier",
						}
					: { ...deferred, reasons: [...deferred.reasons, reason] };
		}
		// Leaving the sandbox is what containment exists to bound: a recognized
		// command asks for it too, so the judge reads the operator's request
		// first and an escape the operator named passes.
		if (resort?.leavesSandbox === true) {
			deferred =
				deferred === null
					? {
							ruleId: SANDBOX_ESCAPE_RULE_ID,
							reasonCode: SANDBOX_ESCAPE_RULE_ID,
							reasons: [SANDBOX_ESCAPE_REASON],
							policySource: "builtin-classifier",
						}
					: { ...deferred, reasons: [...deferred.reasons, SANDBOX_ESCAPE_REASON] };
		}
		// A delete that lands only inside scratch roots is disposable, and no workspace snapshot covers it.
		const scratchOnly =
			resort !== undefined &&
			scratchProjection !== null &&
			workspaceDeletes.length === 0 &&
			deletesOnlyScratch(scratchProjection, resort.scratchRoots);
		// Every decision below settles the operator's default when it applies.
		const settle = (decision: SafetyPolicyDecision): SafetyPolicyDecision =>
			resort === undefined
				? decision
				: settleDefault(
						decision,
						base,
						deferred,
						resort,
						((sorted?.recoverable ?? null) !== null && !scratchOnly) || workspaceDeletes.length > 0,
					);

		if (!projectPolicy.valid && EXECUTION_TOOLS.has(call.tool)) {
			const blockInput: DeferredAsk = {
				ruleId: "project-policy-invalid",
				reasonCode: "project-policy-invalid",
				reasons: [`project safety policy is invalid and execution fails closed: ${projectPolicy.errors.join("; ")}`],
				policySource: "project-policy-invalid",
			};
			if (projectPolicy.hash !== null) blockInput.policyHash = projectPolicy.hash;
			if (projectPolicy.path !== null) blockInput.projectPolicyPath = projectPolicy.path;
			return gateDecision("block", base, blockInput);
		}

		// Editing active instructions is an operator privilege at every autonomy
		// level, in both the coordinator and the shared worker safety contract.
		const mutationCommand = call.tool === ToolNames.Bash ? command : verifyCommand;
		const scannedCommand = mutationCommand;
		// Reuse the canonical authority boundary scan for parent deletions,
		// shell cwd changes and aliases that a literal path-policy lookup misses.
		// Every authority check judges the same targets, so they share one
		// resolution and one walk memo, both dropped when this call is decided.
		const walkMemo = createPathWalkMemo();
		const targets = pathPolicyTargets(
			verifyCommand === null ? call : { tool: ToolNames.Bash, args: { command: verifyCommand } },
			callCwd,
		);
		const candidates = mutationCandidates(
			resort === undefined || mutationCommand === null ? targets : operatorAuthorityTargets(targets, mutationCommand),
			callCwd,
			mutationCommand,
			walkMemo,
		);
		const authority = authorityBlock(
			call,
			callCwd,
			mutationCommand,
			scannedCommand,
			candidates,
			walkMemo,
			resort === undefined ? pathPolicy : operatorDeletePolicy(),
			homes,
		);
		if (authority !== null) {
			const blockInput: DeferredAsk = { ruleId: authority.reasonCode, ...authority };
			if (authority.policySource === "project-policy") {
				if (projectPolicy.hash !== null) blockInput.policyHash = projectPolicy.hash;
				if (projectPolicy.path !== null) blockInput.projectPolicyPath = projectPolicy.path;
			}
			return gateDecision("block", base, blockInput);
		}
		// The contained shell cannot write the repository's hooks, config or git
		// dir pointers, so under the operator's default a typed write asks for
		// them too and the safety judge weighs it against the operator's intent.
		const gitControl = resort === undefined ? null : gitControlHit(call, candidates);
		if (gitControl !== null) {
			const input = {
				ruleId: GIT_CONTROL_FILE_RULE_ID,
				reasonCode: GIT_CONTROL_FILE_RULE_ID,
				reasons: [gitControlFileReason(gitControl)],
				policySource: "builtin-classifier" as const,
			};
			return settle(posture === "confirmed" ? allowDecision(base, input) : gateDecision("ask", base, input));
		}
		const outsideReplacement = outsideExistingTypedMutationTarget(call, cwd, classification, posture);
		if (outsideReplacement !== null) {
			const input = {
				ruleId: "outside-file-replacement",
				reasonCode: "outside-file-replacement",
				reasons: [
					`Existing file '${outsideReplacement}' lies outside the workspace; replacing its contents requires operator approval`,
				],
				policySource: "builtin-classifier" as const,
			};
			return settle(posture === "confirmed" ? allowDecision(base, input) : gateDecision("ask", base, input));
		}
		// Project settings carry persistent fleet routing. A model edit is file
		// level, so it cannot be told apart from a routing change: every mutation
		// asks at every autonomy level, and a headless denial repeats reasons[0].
		if (mutatesProjectSettings(cwd, candidates)) {
			const input = {
				ruleId: "project-settings-confirm",
				reasonCode: "project-settings-confirm",
				reasons: [
					`Project settings under .pancode/ hold persistent fleet routing and are operator-owned; changing them requires operator approval. ${ROUTING_PIN_HINT}`,
				],
				policySource: "builtin-classifier" as const,
			};
			return settle(posture === "confirmed" ? allowDecision(base, input) : gateDecision("ask", base, input));
		}

		// A contained call runs in the main-session sandbox, which bounds what
		// hidden quoting could reach, so only an uncontained one asks for it.
		if (
			scannedCommand !== null &&
			posture !== "confirmed" &&
			resort?.contained !== true &&
			scanShellLikeDeep(scannedCommand).some((token) => token.hiddenContent)
		) {
			return settle(
				gateDecision("ask", base, {
					ruleId: "bash-hidden-quoting",
					reasonCode: "bash-hidden-quoting",
					reasons: ["ambiguous ANSI-C escapes or locale quoting require one-shot operator confirmation"],
					policySource: "builtin-command-allowlist",
					execRecognition: "unrecognized",
				}),
			);
		}

		// Managed PanHub changes can be authorized by the operator. Direct
		// mutations and all hard path/trust blocks above remain non-overridable.
		if (
			mutationCommand !== null &&
			invokesPancodeSkillMutation(mutationCommand) &&
			!(posture === "yolo" && askHit !== null)
		) {
			const input = {
				ruleId: "hub-confirm",
				reasonCode: "hub-confirm",
				reasons: [
					posture === "confirmed"
						? "PanHub change confirmed by operator"
						: posture === "yolo"
							? "PanHub change admitted by yolo"
							: "PanHub changes require one-shot operator confirmation in default",
				],
				policySource: "builtin-classifier" as const,
			};
			return settle(
				posture === "confirmed" || posture === "yolo" ? allowDecision(base, input) : gateDecision("ask", base, input),
			);
		}

		// The authored ask rail (sd-01 M3) decides only among calls that
		// survived every hard block above. A confirmed posture admits the
		// matched command; an unconfirmed one parks it for confirmation.
		if (askHit !== null && posture !== "confirmed") {
			return settle(
				gateDecision("ask", base, {
					ruleId: askHit.match.ruleId,
					reasonCode: `damage-control:${askHit.match.ruleId}`,
					reasons: [...classification.reasons, askHit.match.reason, "damage-control rule requires confirmation"],
					policySource: askHit.source,
					match: askHit.match,
				}),
			);
		}
		if (askHit !== null && posture === "confirmed") {
			return settle(
				allowDecision(base, {
					ruleId: askHit.match.ruleId,
					reasonCode: `damage-control:${askHit.match.ruleId}`,
					reasons: [...classification.reasons, askHit.match.reason, "damage-control rule confirmed by operator"],
					policySource: askHit.source,
					match: askHit.match,
				}),
			);
		}

		// A lone worktree discard, or a lone delete the judge placed inside the
		// workspace or a scratch root, runs under the operator's default as soon
		// as the snapshot that undoes it is taken; it runs nothing else.
		const undone = sorted?.recoverable ?? null;
		const lone = command !== null && !hasShellOperators(command) && !/[$`]/u.test(command);
		const loneDiscard = lone && undone !== null && LONE_GIT_DISCARD.test(command?.trim() ?? "");
		const loneDelete = lone && resort?.snapshots === true && deferred === null && LONE_DELETE.test(command?.trim() ?? "");
		if (loneDelete && !loneDiscard && scratchOnly) {
			return settle(
				allowDecision(base, {
					ruleId: undone?.match?.ruleId ?? SCRATCH_DISPOSABLE_REASON_CODE,
					reasonCode: SCRATCH_DISPOSABLE_REASON_CODE,
					reasons: [...classification.reasons, SCRATCH_DISPOSABLE_REASON],
					policySource: "damage-control:base",
					execRecognition: "recognized",
					...(undone?.match !== null && undone?.match !== undefined ? { match: undone.match } : {}),
				}),
			);
		}
		if (loneDiscard || loneDelete) {
			return settle(
				allowDecision(base, {
					ruleId: undone?.match?.ruleId ?? SNAPSHOT_RECOVERABLE_REASON_CODE,
					reasonCode: SNAPSHOT_RECOVERABLE_REASON_CODE,
					reasons: [...classification.reasons, SNAPSHOT_RECOVERABLE_REASON],
					policySource: "damage-control:base",
					execRecognition: "recognized",
					recoverable: true,
					...(undone?.match !== null && undone?.match !== undefined ? { match: undone.match } : {}),
				}),
			);
		}

		if (classification.actionClass === "system_modify") {
			const input: DeferredAsk = {
				ruleId: "system-modify-confirm",
				reasonCode: resort?.contained === true ? "contained:system-modify-confirm" : "system-modify-confirm",
				reasons: [
					...classification.reasons,
					posture === "confirmed"
						? "system-level change confirmed by operator"
						: posture === "yolo"
							? "system-level change admitted by yolo"
							: resort?.contained === true
								? CONTAINED_REASON
								: "at the default autonomy level every change outside the workspace needs your approval",
				],
				policySource: "builtin-classifier",
			};
			return settle(
				posture === "confirmed" || posture === "yolo" || resort?.contained === true
					? allowDecision(base, input)
					: gateDecision("ask", base, input),
			);
		}

		// A verify call that resolves to no argv lists the checks or names the
		// ids it accepts and runs nothing. Scanning it as `npm run <check>` made
		// an unknown id a permission ask, which a non-interactive worker turns
		// into a terminal denial instead of reading the id list it would get.
		if ((call.tool === ToolNames.Bash || verifyArgv !== null) && classification.actionClass === "execute") {
			const bash = evaluateBashPolicy(
				verifyArgv ?? command ?? "",
				callCwd,
				cwd,
				posture,
				projectPolicy,
				{
					exemptRoots: readExemptRoots,
					memo: walkMemo,
					readable: (target) => evaluatePathPolicy(zeroAccessPolicy, "read", target, callCwd, walkMemo).kind === "allow",
					walkBudget: { remaining: RG_WALK_BUDGET },
					notes: [],
				},
				resort?.contained === true,
				workerSandboxContained && call.projection !== "mcp-server",
			);
			// A typed verifier still runs through the same command safety scan.
			// Unrecognized checks are left to the autonomy mapping: default asks,
			// while yolo admits them headlessly.
			if (bash.kind === "block") return gateDecision("block", base, bash);
			const scanned =
				call.projection === "mcp-server"
					? mcpExecutePolicy(bash)
					: workerContainedUnrecognized(bash, call, classification, command, posture);
			if (scanned.kind === "ask") return settle(gateDecision("ask", base, scanned));
			return settle(allowDecision(base, scanned));
		}

		const allowInput: DeferredAsk = {
			reasonCode: "allowed",
			reasons: classification.reasons,
			policySource: hit?.source ?? "none",
		};
		if (hit?.match.ruleId !== undefined) allowInput.ruleId = hit.match.ruleId;
		if (hit?.match !== undefined) allowInput.match = hit.match;
		// Catalog argv already went through canonical command recognition above.
		// Package scripts and the frontend validator retain their fixed typed surface.
		if (classification.actionClass === "execute") allowInput.execRecognition = "recognized";
		// Search scope: the zero-access list above is the only path rail a
		// read-class tool meets, so a path through a link or a plain `..` used
		// to be read, listed, and searched at every level. The net still passes
		// it; the flag lets the autonomy mapping ask in default mode. The
		// operator's own default reads anywhere a secret is not.
		if (isReadScopeTool(call.tool) && posture !== "confirmed" && resort === undefined) {
			const escaped = readScopeEscape(pathArg(call.args) ?? ".", callCwd, cwd, readExemptRoots, walkMemo);
			if (escaped !== null) {
				allowInput.readScope = "outside-workspace";
				allowInput.reasons = [...allowInput.reasons, `read-path-outside-workspace: ${escaped}`];
			}
		}
		// Outside the operator's own scopes the net only marks a typed write to
		// a git control path; admission asks the main agent when a worker at
		// default made it. A yolo posture admits it unread.
		if (resort === undefined && posture !== "yolo") {
			const gitControl = gitControlHit(call, candidates);
			if (gitControl !== null) allowInput.gitControl = gitControl;
		}
		return settle(allowDecision(base, allowInput));
	};

	/** The command a call runs and the directory it runs from, as the floor and the net judge them. */
	const commandUnderJudgment = (call: ClassifierCall): { callCwd: string; judgedCommand: string | null } => {
		const command = commandArg(call.args);
		const verifyArgs = call.tool === ToolNames.Verify ? prepareVerifyArguments(call.args ?? {}) : null;
		const verifyResolution = verifyArgs === null ? null : resolveVerifyCall(cwd, verifyArgs);
		const verifyCommand =
			verifyResolution === null || verifyArgs === null
				? null
				: (() => {
						const argv = verifyResolutionArgv(verifyResolution, verifyArgs, cwd);
						return argv === null ? null : shellJoin(argv);
					})();
		const checkCwd =
			verifyResolution?.kind === "catalog" || verifyResolution?.kind === "toolchain" || verifyResolution?.kind === "task"
				? resolveProjectVerifierExecutionCwd(verifyResolution.check.cwd, cwd)
				: null;
		return {
			callCwd: typeof checkCwd === "string" ? checkCwd : cwdArg(call.args, cwd),
			judgedCommand: call.tool === ToolNames.Bash ? command : verifyCommand,
		};
	};

	/**
	 * Where an outward line of a call run from `callCwd` would run, and every tree the main-session sandbox
	 * lets a contained command write, as written and with links resolved.
	 */
	const outwardPlaces = (scope: OperatorYoloScope, callCwd: string): OutwardPlaces => {
		const workspace = canonicalizePath(cwd) ?? cwd;
		const roots = mainSandboxWritableRoots(workspace, effectiveScratchRoots(scope.scratchRoots, cwd));
		return {
			workspace,
			fileRoots: [...new Set(roots.flatMap((root) => [root, canonicalizePath(root) ?? root]))],
			cwd: canonicalizePath(callCwd) ?? callCwd,
			searchPath: bashSearchPath(),
		};
	};

	/**
	 * A call under the operator's yolo, judged the skip-permissions way (#407).
	 * What holds: the run's ceilings (write roots, an invalid approved policy,
	 * a required sandbox the host lacks), the yolo floor and operator-authored
	 * rules. Every other ask and block the net would raise is admitted, and the
	 * allow keeps the rail it passed over in its reasons for the audit.
	 */
	const evaluateTrueYolo = (
		rawCall: ClassifierCall,
		posture: string | undefined,
		scope: OperatorYoloScope,
	): SafetyPolicyDecision => {
		const call = normalizeCallPaths(rawCall);
		const { callCwd, judgedCommand } = commandUnderJudgment(call);
		const base = baseDecision(call, classify(call), callCwd, posture, judgedCommand);
		const homes = settingsHomes(effectiveScratchRoots(scope.scratchRoots, cwd));
		const scanned = floorBlock(call, callCwd, judgedCommand, false, homes);
		// Unconfined yolo has no judge, and a script the floor cannot place or read is never refused outright (row 215), so
		// it runs as it did before.
		const floor = scanned?.ruleId === SCRIPT_UNPLACEABLE_RULE_ID ? null : scanned;
		// Unconfined yolo has no judge and admits every ask, so a call whose sourced file is unknown yet is held instead.
		if (floor?.ruleId === LOGIN_PATH_PENDING_RULE_ID)
			return gateDecision("block", base, { ...floor, reasons: [...floor.reasons, LOGIN_PATH_PENDING_YOLO_HOLD] });
		if (floor !== null) return gateDecision("block", base, floor);
		const held: string[] = [];
		const required = yoloRequiredSandbox(rawCall, call, base.classification, judgedCommand, scope, () => ({
			...outwardPlaces(scope, callCwd),
			held,
		}));
		if (required === "refused" || required === "unsandboxed") {
			return gateDecision("block", base, {
				ruleId: YOLO_SANDBOX_REQUIRED_RULE_ID,
				reasonCode: YOLO_SANDBOX_REQUIRED_RULE_ID,
				reasons: [
					required === "unsandboxed"
						? YOLO_SANDBOX_NOT_LEFT
						: reachesOutward(call, base.classification, judgedCommand)
							? `${YOLO_SANDBOX_REFUSED_OUTWARD}${held.length > 0 ? `; this one stays inside because ${held.join("; ")}` : ""}`
							: YOLO_SANDBOX_REFUSED,
				],
				policySource: "builtin-classifier",
			});
		}
		const normal = evaluateCall(rawCall, posture, undefined, homes);
		if (normal.kind === "allow" || holdsAtYolo(normal)) return normal;
		const operator = operatorRuleBlock(call, callCwd, judgedCommand);
		if (operator !== null)
			return gateDecision(
				"block",
				{ ...base, classification: normal.classification, actionClass: normal.actionClass },
				operator,
			);
		const { rejection: _rejection, match: _match, ...rest } = normal;
		return {
			...rest,
			kind: "allow",
			reasonCode: `${YOLO_ADMITTED_REASON_PREFIX}${normal.reasonCode}`,
			reasons: [
				...normal.reasons,
				`yolo admits this call: ${normal.ruleId ?? normal.reasonCode} would ${normal.kind} at default and does not hold at yolo`,
			],
			// What the net could not read through is what System One's yolo gate records.
			...(normal.actionClass === "execute" ? { execRecognition: "unrecognized" as const } : {}),
		};
	};

	/**
	 * A call of the operator's own session at autonomy default (Phase 2c): the
	 * yolo floor first, then the net with damage control re-sorted and, for a
	 * contained call, the rails that exist only because PanCode cannot see what a
	 * command does left to the sandbox.
	 */
	const evaluateOperatorDefault = (
		rawCall: ClassifierCall,
		posture: string | undefined,
		scope: OperatorDefaultScope,
	): SafetyPolicyDecision => {
		const call = normalizeCallPaths(rawCall);
		const classification = classify(call);
		const { callCwd, judgedCommand } = commandUnderJudgment(call);
		const floor = floorBlock(
			call,
			callCwd,
			judgedCommand,
			false,
			settingsHomes(effectiveScratchRoots(scope.scratchRoots, cwd)),
		);
		const pending =
			floor?.ruleId === LOGIN_PATH_PENDING_RULE_ID || floor?.ruleId === SCRIPT_UNPLACEABLE_RULE_ID ? floor : null;
		if (floor !== null && pending === null)
			return gateDecision("block", baseDecision(call, classification, callCwd, posture, judgedCommand), floor);
		const leavesSandbox = scope.sandbox && call.args?.unsandboxed === true && runsProjectCommand(call, judgedCommand);
		const normal = evaluateCall(rawCall, posture, {
			scratchRoots: effectiveScratchRoots(scope.scratchRoots, cwd),
			contained: scope.sandbox && containedShellCall(call, classification, judgedCommand),
			snapshots: scope.snapshots,
			...(scope.readOnly === true ? { readOnly: true as const } : {}),
			...(leavesSandbox ? { leavesSandbox: true as const } : {}),
		});
		// The floor could not place the sourced file yet, or could not place or read a script the call runs: whatever the net
		// would block stays blocked, an ask the net raises keeps its rule (leaving the sandbox, an operator-only change, a
		// damage-control finding) with this reason added, and an allow asks, so the safety judge decides it rather than the
		// launching PATH or an unread script. An operator's approval of this exact call already answered it. A contained
		// call stays contained if it runs.
		if (pending === null || normal.kind === "block") return normal;
		if (normal.kind === "ask" || posture === CONFIRMED_POSTURE)
			return { ...normal, reasons: [...normal.reasons, ...pending.reasons] };
		const { rejection: _rejection, match: _match, ...rest } = normal;
		return gateDecision("ask", rest, {
			...pending,
			...(normal.shellSandbox !== undefined ? { shellSandbox: normal.shellSandbox } : {}),
		});
	};

	/**
	 * The workspace `.git` floor rule (row 261) holds at every level, so a call judged without the operator's scope (a
	 * worker, a grant, a bare evaluation) meets it too; a call that already blocks keeps its own reason.
	 */
	const unscopedWorkspaceGit = (
		rawCall: ClassifierCall,
		normal: SafetyPolicyDecision,
		posture: string | undefined,
	): SafetyPolicyDecision => {
		if (normal.kind === "block" || (rawCall.tool !== ToolNames.Bash && rawCall.tool !== ToolNames.RunScript))
			return normal;
		const call = normalizeCallPaths(rawCall);
		const { callCwd, judgedCommand } = commandUnderJudgment(call);
		// The scoped floor's own reading, the scripts the call runs included, narrowed to the `.git` rule.
		const floor = floorBlock(call, callCwd, judgedCommand, true);
		if (floor === null || floor.ruleId !== YOLO_FLOOR_RULE_IDS.workspaceGit) return normal;
		return gateDecision("block", baseDecision(call, normal.classification, callCwd, posture, judgedCommand), floor);
	};

	const evaluateScoped = (
		rawCall: ClassifierCall,
		posture: string | undefined,
		scope: OperatorScope | undefined,
	): SafetyPolicyDecision => {
		const decision = evaluateScopedReading(rawCall, posture, scope);
		const command = rawCall.tool === ToolNames.Bash ? commandArg(rawCall.args) : null;
		if (command === null || decision.kind === "block") return decision;
		// FX-46: a declared validation wrapper runs the rest of its line, so what it runs is judged as if written bare,
		// and the strictest reading stands; readings at the same verdict merge. An undeclared script stays opaque.
		const { callCwd } = commandUnderJudgment(normalizeCallPaths(rawCall));
		let result = decision;
		for (const inner of declaredWrapperReadings(command, callCwd)) {
			const through = evaluateScopedReading({ ...rawCall, args: { ...rawCall.args, command: inner } }, posture, scope);
			result = mergedWrapperReading(result, through, inner);
			if (result.kind === "block") break;
		}
		return result;
	};

	/**
	 * The call as judged so far (`current`, the command as written first) merged with a wrapper-stripped reading, never
	 * looser than either (row 261): the stricter verdict names the call (its rule, reason code and match). On a tie the
	 * reading already standing keeps its classification, and a stripped reading names the call only by a rule the standing
	 * one lacks, never by a code admission treats more kindly (`snapshot-recoverable`). Reasons are the union; a snapshot requirement and an unrecognized command from
	 * either reading stay, as does a test runner's consent. The sandbox is the standing reading's on a tie, since one
	 * added to an allow would let admission run it unasked, and on an escalation the stricter reading's, or the standing
	 * one's when it names none, the read-only box first.
	 */
	const mergedWrapperReading = (
		current: SafetyPolicyDecision,
		through: SafetyPolicyDecision,
		inner: string,
	): SafetyPolicyDecision => {
		const rank = (kind: SafetyPolicyDecision["kind"]) => (kind === "block" ? 2 : kind === "ask" ? 1 : 0);
		const escalates = rank(through.kind) > rank(current.kind);
		const own = escalates ? through : current;
		const other = escalates ? current : through;
		const note = `a declared validation wrapper runs the rest of its line, judged as ${inner.trim()}`;
		const reasons = [...new Set([...(escalates ? [note] : []), ...own.reasons, ...other.reasons])];
		const boxes = escalates ? [through.shellSandbox, current.shellSandbox] : [current.shellSandbox];
		const present = boxes.filter((box) => box !== undefined);
		const shellSandbox = present.find((box) => box.readOnly === true) ?? present[0];
		const rest: SafetyPolicyDecision = { ...own };
		delete rest.shellSandbox;
		delete rest.execRecognition;
		// On a tie the standing reading keeps its classification; the stripped one names the call only when it names a
		// rule the standing one does not (a damage-control or path match), or the standing code is one admission runs
		// unasked, and never with such a code itself.
		const kindly = (reading: SafetyPolicyDecision) =>
			reading.reasonCode === SNAPSHOT_RECOVERABLE_REASON_CODE || reading.reasonCode === SCRATCH_DISPOSABLE_REASON_CODE;
		const specific = (reading: SafetyPolicyDecision) =>
			reading.match !== undefined || reading.reasonCode.includes("damage-control:");
		const renames =
			!escalates &&
			through.kind === current.kind &&
			!kindly(through) &&
			(kindly(current) || (specific(through) && !specific(current)));
		if (renames) {
			delete rest.ruleId;
			delete rest.match;
			rest.reasonCode = through.reasonCode;
			if (through.ruleId !== undefined) rest.ruleId = through.ruleId;
			if (through.match !== undefined) rest.match = through.match;
		}
		const execRecognition =
			current.execRecognition === "unrecognized" || through.execRecognition === "unrecognized"
				? ("unrecognized" as const)
				: own.execRecognition;
		return {
			...rest,
			...(shellSandbox !== undefined ? { shellSandbox } : {}),
			...(execRecognition !== undefined ? { execRecognition } : {}),
			...(current.command !== undefined ? { command: current.command } : {}),
			...(current.recoverable === true || through.recoverable === true ? { recoverable: true as const } : {}),
			...(current.runsWorkspaceCode === true || through.runsWorkspaceCode === true
				? { runsWorkspaceCode: true as const }
				: {}),
			reasons,
		};
	};

	const evaluateScopedReading = (
		rawCall: ClassifierCall,
		posture: string | undefined,
		scope: OperatorScope | undefined,
	): SafetyPolicyDecision => {
		if (scope?.level === "default") return evaluateOperatorDefault(rawCall, posture, scope);
		const decision =
			scope === undefined
				? unscopedWorkspaceGit(rawCall, evaluateCall(rawCall, posture), posture)
				: evaluateTrueYolo(rawCall, posture, scope);
		// A command the operator's yolo admitted under `safety.sandbox: required`
		// runs in the main-session sandbox, whatever stage allowed it (#419, #407).
		if (decision.kind !== "allow" || scope?.scriptSandbox !== "sandboxed") return decision;
		const call = normalizeCallPaths(rawCall);
		const { callCwd, judgedCommand } = commandUnderJudgment(call);
		const places = () => outwardPlaces(scope, callCwd);
		if (yoloRequiredSandbox(rawCall, call, classify(call), judgedCommand, scope, places) !== "sandboxed") return decision;
		const shellSandbox = {
			workspace: canonicalizePath(cwd) ?? cwd,
			scratchRoots: effectiveScratchRoots(scope.scratchRoots, cwd),
		};
		return { ...decision, shellSandbox };
	};

	const taskGateUnderJudgment = (call: ClassifierCall): TaskGateUnderJudgment | null => {
		const args = prepareVerifyArguments(call.args ?? {});
		const resolution = resolveVerifyCall(cwd, args);
		if (resolution.kind !== "task") return null;
		const argv = verifyResolutionArgv(resolution, args, cwd);
		return argv === null
			? null
			: { command: shellJoin(argv), confined: resolution.confined, containable: resolution.containable };
	};

	/**
	 * A verifier's task gate is judged as the bash call of its argv, through
	 * every rail bash meets, so task text never buys an argv more authority than
	 * bash has. A gate never asks: whoever would answer sees only a check id.
	 */
	const evaluateTaskGate = (
		rawCall: ClassifierCall,
		gate: TaskGateUnderJudgment,
		posture: string | undefined,
		scope: OperatorScope | undefined,
	): SafetyPolicyDecision => {
		const callCwd = typeof rawCall.args?.cwd === "string" ? { cwd: rawCall.args.cwd } : {};
		const bashCall: ClassifierCall = { tool: ToolNames.Bash, args: { command: gate.command, ...callCwd } };
		const bash = evaluateScoped(bashCall, posture, scope);
		const named = { ...bash, tool: ToolNames.Verify, command: gate.command };
		if (bash.kind === "allow") {
			if (gate.confined) return taskGatePolicy(named, true);
			// Main bash at default runs an unrecognized command unasked when the
			// main-session sandbox contains it; the gate gets that verdict and,
			// through the decision's shellSandbox, runs in that same sandbox.
			if (bash.execRecognition === "unrecognized" && gate.containable && posture === undefined && scope === undefined) {
				const contained = evaluateOperatorDefault(bashCall, posture, {
					level: "default",
					scratchRoots: [],
					sandbox: true,
					snapshots: false,
				});
				if (contained.kind === "allow" && contained.shellSandbox !== undefined) {
					return { ...contained, tool: ToolNames.Verify, command: gate.command };
				}
			}
			return named;
		}
		if (bash.kind === "block") return named;
		// Interpreter source (`python3 -c ...`) hides its paths from the scan, the one ask main bash at default leaves
		// to its sandbox. A gate in a worker sandbox that confines writes to the worker's own roots takes that contained
		// verdict, so a checker can run the command its task names (M-42); every other ask still refuses the gate.
		if (gate.confined && bash.ruleId === HIDDEN_CONTENT_RULE_ID) {
			const contained = evaluateOperatorDefault(bashCall, posture, {
				level: "default",
				scratchRoots: [],
				sandbox: true,
				snapshots: false,
			});
			if (contained.kind === "allow") {
				const { shellSandbox: _ownSandbox, ...inWorkerSandbox } = contained;
				return taskGatePolicy({ ...inWorkerSandbox, tool: ToolNames.Verify, command: gate.command }, true);
			}
		}
		const { rejection: _rejection, ...rest } = named;
		return gateDecision("block", rest, {
			...rest,
			ruleId: TASK_GATE_REFUSED_RULE_ID,
			reasonCode: TASK_GATE_REFUSED_RULE_ID,
			reasons: [
				`task gate \`${gate.command}\` would ask as bash (${bash.ruleId ?? bash.reasonCode}); a task gate never asks, so it does not run: report it unverified with this reason`,
				...bash.reasons,
			],
		});
	};

	const engine: SafetyPolicyEngine = {
		evaluate(rawCall, posture, scope) {
			if (!WRITE_ROOT_TOOLS.has(rawCall.tool)) refreshConfigSecrets();
			const oversized = oversizedPathToken(rawCall.args);
			if (oversized !== null) {
				return gateDecision("block", baseDecision(rawCall, classify(rawCall), cwd, posture, commandArg(rawCall.args)), {
					ruleId: OVERSIZED_PATH_RULE_ID,
					reasonCode: OVERSIZED_PATH_RULE_ID,
					reasons: [
						`an argument holds a path of more than ${MAX_PATH_SEGMENTS} segments, longer than any path the system can open; it is refused unexamined`,
					],
					policySource: "builtin-classifier",
				});
			}
			const gate = rawCall.tool === ToolNames.Verify ? taskGateUnderJudgment(rawCall) : null;
			const decision =
				gate === null ? evaluateScoped(rawCall, posture, scope) : evaluateTaskGate(rawCall, gate, posture, scope);
			// A judge's allow runs the asked call without a second admission, so an
			// ask counts as well as an allow; the refresh waits for the next typed write.
			if (decision.kind !== "block" && mayRewriteGitConfig(rawCall, decision, cwd)) gitControlsStale = true;
			if (
				secretRead &&
				decision.kind === "allow" &&
				isOutboundWebTool(rawCall.tool) &&
				fetchCouldCarryLocalData(rawCall.args)
			) {
				return gateDecision("ask", decision, {
					ruleId: SECRET_READ_THEN_FETCH_RULE_ID,
					reasonCode: SECRET_READ_THEN_FETCH_RULE_ID,
					reasons: [
						`a secret-bearing file (${secretRead}) was read earlier in this session, and this fetch has headers, a body, a query, fragment, userinfo, or an opaque path segment or host label that could carry its contents outward`,
					],
					policySource: "builtin-classifier",
				});
			}
			// An ask counts: a judge's allow runs the read without a second admission.
			if (decision.kind !== "block" && secretRead === null) secretRead = secretBearingReadOf(rawCall);
			return decision;
		},
		writeTargetViolation(target) {
			if (writeRoots.length === 0) return null;
			const memo = createPathWalkMemo();
			return writeRootViolation(writeRoots, target, canonicalizeRawPath(target, writeRootCwd, memo), memo);
		},
		readablePath(target) {
			refreshConfigSecrets();
			return evaluatePathPolicy(zeroAccessPolicy, "read", target, cwd).kind === "allow";
		},
		informationFlow: () => informationFlow,
		flowRestrictionsFor(rawCall) {
			// Runs on every tool call. With no rules there is nothing to label, and the
			// cwd canonicalization below is a filesystem walk the call must not pay for.
			if (informationFlow.rules.length === 0) return null;
			return flowRestrictionsForCall(informationFlow, flowSourceCallFor(rawCall, cwd));
		},
		metadata() {
			return {
				version: 1,
				rulePackHash: rulePackHash(baseRules.rules),
				rulePackVersion: baseRules.version,
				activeRuleIds: sourcedRules.map((entry) => entry.rule.id),
				projectPolicyPath: projectPolicy.path,
				projectPolicyHash: projectPolicy.hash,
				projectPolicyValid: projectPolicy.valid,
				projectPolicyErrors: [...projectPolicy.errors, ...pathPolicy.diagnostics],
				disableDefaultPathPolicy: projectPolicy.disableDefaultPathPolicy,
				workspaceTrustVerdict: projectPolicy.trustVerdict ?? "trusted",
				cwd,
			};
		},
	};
	return engine;
}

interface TaskGateUnderJudgment {
	command: string;
	/** The worker's OS sandbox writes nothing. */
	confined: boolean;
	/** The worker could run the gate in the main-session sandbox. */
	containable: boolean;
}

/** Rule id of a verifier's task gate the scan passed, run in a sandbox that writes nothing. */
export const TASK_GATE_RULE_ID = "verify-task-gate";

/** Rule id of a task gate refused because bash would have asked for the same argv. */
export const TASK_GATE_REFUSED_RULE_ID = "verify-task-gate-asks";

/**
 * A gate the verifier's dispatched task names. The scan's rails still block or
 * ask; what it passed as unrecognized becomes recognized only when the worker
 * runs it under bubblewrap confined to its own write roots, as main bash at
 * default runs it contained. Anywhere else a gate gets exactly the admission bash would give the
 * same argv, so task text cannot carry an unrecognized command past an ask. A gate whose bash verdict a write-confined
 * worker sandbox already contained (row 371) is the same gate: it keeps the task-gate attribution, with the same
 * admission (M-48).
 */
function taskGatePolicy<T extends Pick<SafetyPolicyDecision, "kind" | "execRecognition" | "reasons" | "ruleId">>(
	bash: T,
	confined: boolean,
): T {
	const contained = bash.execRecognition === "unrecognized" || bash.ruleId === WORKER_SANDBOX_CONTAINED_RULE_ID;
	if (bash.kind !== "allow" || !contained || !confined) return bash;
	return {
		...bash,
		ruleId: TASK_GATE_RULE_ID,
		reasonCode: TASK_GATE_RULE_ID,
		reasons: [
			"a gate the dispatched verifier task names, run as plain argv inside the worker's OS sandbox",
			...bash.reasons,
		],
		execRecognition: "recognized",
	};
}

/** Rule id of an unrecognized bash command admitted inside a write-confined worker sandbox (row 371, M-49). */
const WORKER_SANDBOX_CONTAINED_RULE_ID = "worker-sandbox-contained";

/** Rule id of an execute-class MCP tool call, whose admission the autonomy level decides. */
export const MCP_EXECUTE_RULE_ID = "mcp-execute";

/**
 * An execute-class MCP tool call through its launch vector's shell scan. The
 * scan's rails still block or ask, but no recognition of the launch command,
 * by the allowlist or an approved project policy, says anything about the
 * tool call, so an allowed call is never recognized and carries the MCP trust
 * rule rather than a bash or project rule.
 */
function mcpExecutePolicy<T extends Pick<SafetyPolicyDecision, "kind">>(bash: T): T {
	if (bash.kind !== "allow") return bash;
	return {
		...bash,
		ruleId: MCP_EXECUTE_RULE_ID,
		reasonCode: MCP_EXECUTE_RULE_ID,
		reasons: [
			"an execute-class MCP tool call runs on its trusted server's own process, outside the main-session sandbox; the autonomy level decides admission",
		],
		policySource: "mcp-trust",
		execRecognition: "unrecognized",
	};
}

/**
 * The roots stay lexical: `cwd` is already canonical and the settings loader
 * refuses a symlinked `.pancode`, so resolving them would only add the two
 * realpath calls the admission fs budget forbids. A candidate's resolved path
 * still catches an alias that lands on either file.
 */
function mutatesProjectSettings(cwd: string, candidates: ReadonlyArray<MutationCandidate>): boolean {
	const roots = [path.join(cwd, ".pancode", "settings.yaml"), path.join(cwd, ".pancode", "settings.local.yaml")];
	return candidates.some((candidate) =>
		roots.some((root) =>
			[candidate.lexical, candidate.resolved].some(
				(location) =>
					isSameOrDescendant(location, root) || (candidate.operation === "delete" && isSameOrDescendant(root, location)),
			),
		),
	);
}

function baseDecision(
	call: ClassifierCall,
	classification: Classification,
	cwd: string,
	posture: string | undefined,
	command: string | null,
): Pick<SafetyPolicyDecision, "classification" | "tool" | "actionClass" | "cwd" | "posture" | "command"> {
	const out: Pick<SafetyPolicyDecision, "classification" | "tool" | "actionClass" | "cwd" | "posture" | "command"> = {
		classification,
		tool: call.tool,
		actionClass: classification.actionClass,
		cwd,
	};
	if (posture !== undefined) out.posture = posture;
	if (command !== null) out.command = command;
	return out;
}

function allowDecision(
	base: Pick<SafetyPolicyDecision, "classification" | "tool" | "actionClass" | "cwd" | "posture" | "command">,
	input: Omit<SafetyPolicyDecision, "kind" | "classification" | "tool" | "actionClass" | "cwd" | "posture" | "command">,
): SafetyPolicyDecision {
	return { ...base, ...input, kind: "allow" };
}

function gateDecision(
	kind: "ask" | "block",
	base: Pick<SafetyPolicyDecision, "classification" | "tool" | "actionClass" | "cwd" | "posture" | "command">,
	input: Omit<SafetyPolicyDecision, "kind" | "classification" | "tool" | "actionClass" | "cwd" | "posture" | "command">,
): SafetyPolicyDecision {
	const rejectionInput: Parameters<typeof formatRejection>[0] = {
		tool: base.tool,
		actionClass: base.classification.actionClass,
		reasons: input.reasons,
	};
	if (base.posture !== undefined) rejectionInput.posture = base.posture;
	if (input.ruleId !== undefined) rejectionInput.ruleId = input.ruleId;
	if (input.reasonCode.startsWith(YOLO_FLOOR_REASON_PREFIX)) rejectionInput.floor = true;
	const rejection = formatRejection(rejectionInput);
	return { ...base, ...input, kind, rejection };
}

const DELETE_TARGET_RULE_ID = "delete-outside-workspace";
const DELETE_TARGET_RULE_DESCRIPTION =
	"deletes a path outside the workspace, the workspace root or its .git, or a path named only at run time, through rm, rmdir, unlink or find however quoted or wrapped";
