// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
// Default constants for PanCode settings.

/**
 * Default settings shipped with PanCode. Written to the resolved config
 * directory's settings.yaml on first install if the file does not already
 * exist. Users edit the file directly or through TUI overlays.
 */

import type { StoreTagClass } from "@pancode/store/backend";
import { DEFAULT_WORKING_SET_SETTINGS } from "../domains/context/working-set/defaults.js";
import type { TargetDescriptor } from "../domains/providers/types/target-descriptor.js";
import type { AutonomyLevel, YoloConfinement } from "../domains/safety/autonomy.js";
import type { ProfileId } from "../domains/system-one/profiles.js";
import type { TurnControlSettings } from "../domains/turn-control/index.js";
import type { FundingDefinitions } from "./funding-config.js";
import { GUARDRAIL_DEFAULTS } from "./guardrails.js";
import type { ModelTier } from "./model-tier.js";
import type { SandboxMode, UnixSocketMode } from "./sandbox/types.js";
import type { TelemetrySettings } from "./telemetry/capture.js";

export type { TargetDescriptor } from "../domains/providers/types/target-descriptor.js";
export type { AutonomyLevel } from "../domains/safety/autonomy.js";

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export const THINKING_LEVELS: ReadonlyArray<ThinkingLevel> = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
];

interface WorkerTarget {
	target: string | null;
	model: string | null;
	thinkingLevel: ThinkingLevel;
	/** Optional fleet node pin: workers routed through this profile run on that node. */
	node?: string;
}

type WorkerProfiles = Record<string, WorkerTarget>;
export const COUNCIL_MEMBER_LABEL_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/u;
export const THEME_NAMED_COLORS = [
	"accent",
	"accentDeep",
	"action",
	"success",
	"warning",
	"error",
	"info",
	"reason",
	"dim",
	"muted",
	"title",
	"frame",
	"frameStrong",
] as const;
type ThemeNamedColor = (typeof THEME_NAMED_COLORS)[number];
interface WorkerRosterMember {
	label: string;
	target: string;
	model?: string;
	thinkingLevel?: ThinkingLevel;
	color?: ThemeNamedColor | string;
	/** Agent recipe id this member runs as; a council run checks it against the installed agents. */
	agent?: string;
}
export type WorkerRosters = Record<string, { members: WorkerRosterMember[] }>;
/** Map of native agent id -> fleet.profiles key. Empty means no agent is pinned to a profile. */
type FleetAgentProfiles = Record<string, string>;

/**
 * What answers a System One question. `systemone` is any `POST /v1/systemone`
 * server (TypeSafe Jev, Laya, OpenJev, Kev). `llm` asks an ordinary chat target
 * every question of an ask in one schema-bound request.
 */
type SystemOneEngineKind = "systemone" | "llm";
/** One route name, an ordered list, `off` or null. A later settings layer's list replaces the earlier one. */
export type SystemOneUse = string | string[] | null;

export interface SystemOneEngineSettings {
	kind: SystemOneEngineKind;
	/** A `targets[].id`. */
	target: string;
	/** Wire model id; absent means the target's default model. */
	model?: string;
	/**
	 * The capability profile of the served model (`contract.ts`), which picks its
	 * renderer, the questions it may be asked and how its numbers are read.
	 * Absent means `generic`, the wire with no profile-specific behaviour.
	 */
	profile?: ProfileId;
}

interface SystemOneSettings {
	/**
	 * The opt-in: an ordered list of routes, each `jev`, `memory`, `main`, a declared engine or a target.
	 * Unset and `off` send nothing, and a route nobody named is never used. Applies on the next start.
	 */
	use: SystemOneUse;
	engines: Record<string, SystemOneEngineSettings>;
}

/**
 * Non-stall posture for dispatched native workers. A worker tool call that
 * requires interactive permission resolves within bounded time: "deny" turns
 * it into a structured tool denial and the run continues; "fail" finalizes
 * the run immediately with outcome failed/permission_required; "escalate"
 * parks the call and hands it to the interactive operator, applying the
 * escalation fallback on timeout so the run still cannot hang. Escalate is
 * only meaningful with an interactive operator attached; headless sessions
 * have no subscriber, so the timeout fallback governs. In permit terms
 * escalate is asks main with operator approval authority: the main agent's
 * card, always decided by a person. "main" is the explicit opt-in for the
 * main agent to grant ordinary worker asks on native local workers through the
 * grant broker (src/domains/dispatch/grant-broker.ts): the main agent grants
 * them at yolo and forwards them to the operator at any other autonomy level.
 * "judge", the default, hands ordinary worker asks on native local workers to
 * the main session's safety judge while the main session runs at autonomy
 * default (src/domains/dispatch/grant-authority.ts): an allow grants the call,
 * a block or no verdict denies it. It behaves as "deny" at yolo, when
 * safety.judge is off, and where no judge can answer.
 * Operator-authority asks always go to the operator, and an ask no one can
 * answer is denied.
 */
export type WorkerPermissionMode = "deny" | "fail" | "escalate" | "main" | "judge";

/** Bounds for the escalate posture; the timeout fallback keeps runs non-stall. */
export interface WorkerEscalationSettings {
	timeoutMs: number;
	fallback: "deny" | "fail";
}

interface FleetPermissionsSettings {
	mode: WorkerPermissionMode;
	escalation: WorkerEscalationSettings;
}

interface FleetRetrySettings {
	maxRetries: number;
	routeCooldownMs: number;
	/** Consecutive target failures that open a route's breaker; 1 trips on the first. */
	breakerThreshold: number;
}

interface FleetLimitsSettings {
	toolCallsPerRun: number;
	/** Wall clock of one dispatched run, queue time included; a recipe or a call's timeout_ms may only lower it. */
	runTimeoutMs: number;
	internalRunTimeoutMs: number;
}

interface FleetHistorySettings {
	maxRuns: number;
	journal: boolean;
}

interface FleetRouteSettings {
	default: WorkerTarget;
	profiles: WorkerProfiles;
	rosters: WorkerRosters;
	agentProfiles: FleetAgentProfiles;
}

/**
 * Compaction controls the session domain reads at runtime. The structural
 * type lives here so core/defaults.ts stays free of a backward domain
 * dependency; the engine-level defaults live alongside the rest of the
 * compaction engine in src/domains/session/compaction/defaults.ts.
 *
 * Fields:
 *   - auto: master switch for the chat-loop's pre-request trigger. Manual
 *     /context compact still runs when auto=false.
 *   - threshold: context pressure (estimated_tokens / context_window, 0..1)
 *     at which compaction acts: stale observations are masked first, and a
 *     full LLM summary runs if pressure stays above the threshold.
 *   - model: optional pattern (e.g. "provider/summary-model-id") used to
 *     resolve a dedicated summarization model. Falls back to the Chat target
 *     when absent.
 *   - systemPrompt: optional path to a prompt-override file; resolved to
 *     text at call time, not at settings load.
 */
export interface DurableCompactionSettings {
	/** Opt-in opaque Codex checkpoints; portable summaries remain the default (#423). */
	provider?: "off" | "native";
	auto: boolean;
	threshold: number;
	/** C1 / #422: economic input ceiling, independent of the serving window. */
	maxTokens?: number;
	model?: string;
	systemPrompt?: string;
}

/**
 * Working-set layer settings (`context.workingSet`). The layer decides which
 * tool-result bodies and thinking blocks leave the model's working set when
 * pressure crosses `compaction.threshold`; it records evictions as ledger
 * entries and never rewrites history. Defaults and prose live in
 * src/domains/context/working-set/defaults.ts.
 *
 *   - enabled: master switch. Off skips eviction and goes straight to summary
 *     compaction.
 *   - policy: candidate selection rule set.
 *   - target: used/window ratio an applied event batches down to.
 *   - protectLastTurns: recent user turns whose observations are never evicted.
 *   - protectLastSteps: recent assistant steps (an assistant message and the
 *     tool results it produced) that are never evicted, inside the turn window.
 *     A long agentic turn is many steps; without this floor one turn with fifty
 *     tool calls would protect every one of them and eviction would never fire.
 *   - minEvictableTokens: protect smaller results from low-yield eviction.
 *     The engine separately rejects replacements that save no tokens.
 *   - rearmFraction: hysteresis. After an eviction event, no further automatic
 *     eviction or summary runs until the projection has grown by this fraction
 *     of the context window; every event cold-starts the prefix cache, and a
 *     checkpoint runs before every model request. Zero disables the band.
 *     Overflow recovery ignores it.
 *   - profile: the protection profile, what a kind of work never gives up on
 *     top of the absolute predicates (`default`, `data-analysis`,
 *     `web-design`; src/domains/context/working-set/policies/profiles.ts).
 *     Main agent only: workers run their own in-memory guard.
 */
export type WorkingSetPolicyId = "age-horizon" | "structural-v1" | "structural-v2";
export const WORKING_SET_PROFILE_IDS = ["default", "data-analysis", "web-design"] as const;
export type WorkingSetProfileId = (typeof WORKING_SET_PROFILE_IDS)[number];

export interface WorkingSetSettings {
	enabled: boolean;
	policy: WorkingSetPolicyId;
	profile: WorkingSetProfileId;
	target: number;
	protectLastTurns: number;
	protectLastSteps: number;
	minEvictableTokens: number;
	rearmFraction: number;
}

/**
 * Prompt pre-warm (`chat.prewarm`). On a local server prefill is the cost,
 * and the prefix the next turn will send is fully known before the operator
 * types anything: at session start, after a resume rebuilds the message array,
 * and after a compaction settles. PanCode sends that prefix to the backend right
 * then so the slot's prefix cache already holds it when the real turn arrives.
 *
 * The boolean is the master switch. The feature is off on every tier but
 *     `local-native` and the `openai-codex` runtime (a `generate: false` warm)
 *     whatever this says, and off for workers and headless runs, because it buys
 *     latency for an operator watching the session.
 */
export interface PanesSettings {
	/** Which terminal run states raise a pane-host toast. */
	notifications: "failures" | "all" | "off";
	/**
	 * What composes itself at interactive boot in guest mode. `off` opens
	 * nothing (docks still open on demand); `workers` opens the workers dock;
	 * `cockpit` opens workers and files both.
	 */
	layout: "off" | "workers" | "cockpit";
	/** Workers dock: the live run viewer split right of the PanCode pane. */
	workers: {
		/** Share of the width the dock takes, clamped to at most half. */
		ratio: number;
	};
	/** File-pane round-trip settings read live for each explicit open. */
	files: {
		enabled: boolean;
		mode: "companion" | "chooser";
		profile: "managed" | "user";
		followCwd: boolean;
		/** Share of the height the files dock takes, clamped to at most half. */
		ratio: number;
	};
}

/**
 * Transient provider retry controls for the interactive chat loop. These are
 * intentionally small and mirror the session retry helper defaults. Dispatched
 * worker runs are governed by `fleet.retry.maxRetries` instead; the two never meet.
 */
export interface RetrySettings {
	enabled: boolean;
	maxRetries: number;
	baseDelayMs: number;
	maxDelayMs: number;
	/** Silence on an in-flight stream past this many ms is treated as a wedged backend: abort and retry. */
	streamStallMs: number;
	/**
	 * Silence allowed before a call's first token. A local server that slept
	 * reloads the model and prefills cold before it can emit anything, so this
	 * window is longer than the mid-stream one. 0 never aborts a call that has
	 * not started streaming.
	 */
	firstTokenStallMs: number;
}

const OUTPUT_STYLES = ["compact", "standard", "detailed"] as const;
export type OutputStyle = (typeof OUTPUT_STYLES)[number];

export function outputStyleLabel(style: OutputStyle): string {
	return style;
}

export function interfaceGuidanceEnabled(settings: Pick<InterfaceSettings, "demo" | "outputDetail">): boolean {
	return settings.demo && settings.outputDetail !== "compact";
}

export function normalizeOutputStyle(value: unknown): OutputStyle | undefined {
	return OUTPUT_STYLES.find((style) => style === value);
}

export function nextOutputStyle(style: OutputStyle): OutputStyle {
	return OUTPUT_STYLES[(OUTPUT_STYLES.indexOf(style) + 1) % OUTPUT_STYLES.length] ?? "standard";
}
export type TuiMode = "regular" | "fullscreen";
type FullscreenScrollbar = "hidden" | "auto" | "always";
export type SmoothStreaming = "off" | "auto" | "on";
/** Whether a clean exit prints the session summary; `outputDetail` sizes it. */
const EXIT_SUMMARY_STYLES = ["on", "off"] as const;
export type ExitSummaryStyle = (typeof EXIT_SUMMARY_STYLES)[number];

export function normalizeExitSummaryStyle(value: unknown): ExitSummaryStyle | undefined {
	return EXIT_SUMMARY_STYLES.find((style) => style === value);
}

interface InterfaceSettings {
	exitSummary: ExitSummaryStyle;
	/** Optional welcome and learning guidance; outputDetail sets their density. */
	demo: boolean;
	terminalProgress: boolean;
	/** Compact, standard, or detailed presentation across terminal surfaces; never changes model reasoning. */
	outputDetail: OutputStyle;
	/** Regular scrollback-preserving renderer or alternate-screen sticky layout. */
	mode: TuiMode;
	/** Fullscreen transcript scrollbar visibility. */
	fullscreenScrollbar: FullscreenScrollbar;
	/** Presentation-only pacing for streamed assistant text and thinking. */
	smoothStreaming: SmoothStreaming;
	/**
	 * Content-free desktop notifications on turn end, detached batch settlement,
	 * and a parked approval. Interactive TTY runs only; headless, ACP, and
	 * non-TTY runs never emit one.
	 */
	desktopNotifications: boolean;
	/**
	 * Background install of a newer release for a native-installer install
	 * (#436). Off keeps the update notice and leaves the install to the operator.
	 */
	autoUpdate: boolean;
	/**
	 * Turns the graphical app runs at once across its tasks, 1 to 16; more wait their turn in order.
	 * Open tasks are not limited.
	 */
	guiTurnCapacity: number;
	panes: PanesSettings;
	keybindings: Record<string, string | string[]>;
}

/**
 * The opt-in turn-end watchdog. Off by default: it spends a worker run per
 * mutating turn, and an operator who has not asked for that must not pay for
 * it. `target` routes the run somewhere cheap, typically a local model, and
 * falls back to the session's active target when unset. `cadenceToolCalls`
 * additionally fires the watchdog every N tool calls inside a turn, which is
 * how mid-turn scope drift becomes visible before the turn ends.
 */
interface ReviewSettings {
	enabled: boolean;
	/** Target id the watchdog run is dispatched to; the session's active target when unset. */
	target?: string;
	/** Mid-turn cadence in tool calls; no mid-turn firing when unset. */
	cadenceToolCalls?: number;
}

interface ModelSelectorSettings {
	/** Exact target/model refs used by the scoped model cycle actions. */
	cycleSet: string[];
	/** Exact target/model refs shown in the focused model picker. */
	favorites: string[];
	/** Maximum number of recently selected target/model refs to retain. */
	recentLimit: number;
}

interface ProjectResourcesSettings {
	/** Admit explicitly imported foreign skills/prompts at either scope; loose compatibility roots stay inactive. */
	trustProjectImports: boolean;
}

interface GitIntegrationSettings {
	/** Evidence-aware role trailers on commits created through PanCode. */
	commitAttribution: boolean;
	/**
	 * Who authors autonomous commits (dispatched workers and their landing,
	 * headless `run`, scheduled job turns). `auto` makes PanCode the author with
	 * the human committer credited as co-author; `human` keeps the human the
	 * author everywhere. Interactive sessions always keep the human author.
	 */
	commitAuthor: GitCommitAuthorSetting;
}

export type GitCommitAuthorSetting = "auto" | "human";

/** The music pane: cliamp in a herdr dock. Off until the operator turns it on. */
export interface MusicIntegrationSettings {
	enabled: boolean;
	/** Station that `/music on` starts: a stream URL or a station name. */
	station: string;
	/** Registers the `music` tool at startup so the model can drive the pane. */
	agentControl: boolean;
}

/** The focus station `/music on` plays when settings name none. */
const DEFAULT_MUSIC_STATION = "http://radio.cliamp.stream/lofi/stream";
/** The release the hub-index workflow publishes signing.json, index.envelope.json and index.yaml to. */
const DEFAULT_HUB_INDEX_URL = "https://github.com/PanStudio/pancode/releases/download/hub-index/";

export type DelegationToolGovernance = "pancode-policy" | "agent-managed" | "deny-all";

/**
 * Application-level ACP request bounds. Unlike the separate stall watchdog,
 * connect and permission requests remain finite. A turn has no elapsed deadline
 * unless the operator supplies a positive timeout; event-inactivity cleanup is separate.
 */
export const DEFAULT_DELEGATION_CONNECT_TIMEOUT_MS = 30_000;
export const DEFAULT_DELEGATION_TURN_TIMEOUT_MS = 0;
export const DEFAULT_DELEGATION_PERMISSION_TIMEOUT_MS = 120_000;

export interface DelegationAgentConfig {
	/** Stable id used by /run and dispatch receipts. */
	id: string;
	/** ACP stdio command. Official ACP v1 stdio messages are newline-delimited JSON-RPC. */
	command: string;
	args: string[];
	cwd?: string;
	env?: Record<string, string>;
	connectTimeoutMs?: number;
	/** Explicit elapsed turn deadline; 0 (default) leaves work to completion/stall/cancel. */
	turnTimeoutMs?: number;
	/**
	 * Event-inactivity stall window: when no session/update arrives for this
	 * long, the reconciler cancels the turn and finalizes the run as stalled.
	 * Defaults to 300000; <= 0 disables the check.
	 */
	stallTimeoutMs?: number;
	toolGovernance?: DelegationToolGovernance;
	/**
	 * Operator opt-in for toolGovernance agent-managed, where the peer decides
	 * its own tool calls: without it such a delegation is refused, and with it
	 * the receipt records the opt-in (operator decision Q6).
	 */
	trustedUnmediated?: boolean;
	/**
	 * Project context sent to this external agent as a dynamic message.
	 * Defaults to "none": repo conventions/invariants never leave the machine
	 * unless the operator opts this agent into the bounded projection.
	 */
	projectContext?: "none" | "bounded";
}

interface DelegationDefaults {
	connectTimeoutMs: number;
	turnTimeoutMs: number;
	permissionTimeoutMs: number;
	toolGovernance: DelegationToolGovernance;
}

interface ExternalAgentsSettings {
	entries: DelegationAgentConfig[];
	defaults: DelegationDefaults;
}

/**
 * Residency posture a remote worker launches with. "observe" (the default)
 * forbids the worker from evicting or swapping any model resident on its
 * node; "manage" is an explicit per-node opt-in to the normal reconciler.
 */
type FleetNodeResidency = "observe" | "manage";

/**
 * One SSH-reachable worker node. The implicit `local` node always exists and
 * is never declared here. Nodes become dispatch-eligible only after the
 * doctor fleet preflight verifies reachability, a version-matched pancode, and
 * path parity for the project root (shared-filesystem assumption).
 */
export interface FleetNodeSettings {
	/** Stable node id used in placement, receipts, and operator surfaces. */
	id: string;
	/** SSH destination host (name or address). */
	host: string;
	user?: string;
	port?: number;
	identityFile?: string;
	/** Remote worker-entry invocation; defaults to `pancode worker` on the remote PATH. */
	pancodeEntry?: string;
	/** Explicit version invocation for a custom worker entry; must print the exact PanCode version. */
	pancodeVersionCommand?: string;
	/** Advisory routing labels (e.g. gpu, high-memory). */
	labels?: string[];
	/** Per-node concurrent worker cap. */
	maxWorkers: number;
	residency?: FleetNodeResidency;
}

/** One PanStore root: tags live under `<path>/projects/<projectKey>`. */
interface StoreRootSetting {
	name: string;
	/** Absolute. */
	path: string;
	/** False for scratch space a site may purge; only tags of class `cache` go there. */
	durable: boolean;
	/** The site's purge policy in its own words, reported and never enforced. */
	purge: string | null;
}

/** The kinds of store `store.backend` selects. */
export const STORE_BACKEND_KINDS = ["local", "shared", "s3"] as const;
export type StoreBackendSetting = (typeof STORE_BACKEND_KINDS)[number];

/** The folder a `shared` store lives in: one directory every host sharing the store mounts at the same path. */
export interface StoreSharedSetting {
	/** Absolute. */
	root: string;
}

/** The bucket an `s3` store lives in. Its secret key is in the credential store (`pancode store login`), never here. */
export interface StoreS3Setting {
	/** `http(s)://host[:port]` of an S3-compatible service. */
	endpoint: string;
	region: string;
	bucket: string;
	/** Prepended to every key: empty, or ending in `/`. */
	prefix: string;
	accessKeyId: string;
	/** Address the bucket in the path (`endpoint/bucket/key`) rather than the host name. */
	pathStyle: boolean;
}

/**
 * Where PanStore keeps tags. `backend` local keeps them under `roots`; empty `roots` keeps the one store under the
 * data directory. The first root is the primary and holds records and locks. `placement` names the root a new tag
 * goes to; a tag never moves after. `backend` shared keeps them in the one folder `shared` names, which several
 * hosts mount, and `backend` s3 in the bucket `s3` names; neither has roots or placement. User settings only.
 */
interface StoreSettings {
	/** The project's store identity, set only in its tracked `.pancode/settings.yaml`; unset keys the store by path. */
	projectId?: string;
	backend: StoreBackendSetting;
	shared: StoreSharedSetting | null;
	s3: StoreS3Setting | null;
	roots: StoreRootSetting[];
	placement: { byTag: Record<string, string>; byClass: Partial<Record<StoreTagClass, string>> };
}

interface FleetWorktreesSettings {
	/**
	 * Where a `worktree: true` task's working tree is created, for local
	 * placement: `disk` (under the project root), `tmpfs`, `auto` (tmpfs when
	 * one exists and has room), or an absolute path.
	 */
	root: string;
}

export interface FleetSettings extends FleetRouteSettings {
	/** Standing worker node preference; null leaves unpinned work local and permits a session question. */
	defaultNode: string | null;
	/** Experimental worker prewarm. After a turn reading predicts a dispatch, the `workerPrepare` site is asked which recipe it would name first, and only a measured build's answer starts a worker; off by default. */
	nodes: FleetNodeSettings[];
	adaptiveRouting: AdaptiveRoutingSettings;
	permissions: FleetPermissionsSettings;
	concurrency: "auto" | number;
	/** On by default: a parallel batch's native workers that share a prompt prefix start after the first one streams; handles return at once. */
	staggerSharedPrefix: boolean;
	/** Runtime ids of delegated harnesses that read their own repository instruction files unchanged, with the compiled rules beside them. */
	keepPeerInstructionFiles: string[];
	worktrees: FleetWorktreesSettings;
	retry: FleetRetrySettings;
	limits: FleetLimitsSettings;
	history: FleetHistorySettings;
}

/** Roles whose authority is narrow enough for active joint routing. */
export const ACTIVE_ROUTING_ROLES = ["explorer", "seat", "checker", "reviewer", "judge"] as const;
export type ActiveRoutingRole = (typeof ACTIVE_ROUTING_ROLES)[number];

/** Manual is exact rather than adaptive, so it is never an activated posture. */
export const ACTIVE_ROUTING_POSTURES = ["quality", "balanced", "latency", "economy"] as const;
export type ActiveRoutingPosture = (typeof ACTIVE_ROUTING_POSTURES)[number];

export const ACTIVE_AGENT_AUTOMATION_ROLES = ["builder", "explorer", "seat", "checker", "reviewer", "judge"] as const;
type ActiveAgentAutomationRole = (typeof ACTIVE_AGENT_AUTOMATION_ROLES)[number];

export interface ActiveAgentRole {
	agentId: string;
	executionRole: ActiveAgentAutomationRole;
}

interface AdaptiveRoutingSettings {
	roles: ActiveRoutingRole[];
	postures: ActiveRoutingPosture[];
	/** Exact pairs only; independent agent and role lists would authorize their cross-product. */
	agentRoles: ActiveAgentRole[];
}

/** Compatibility type name for the dispatch planner; its fields are the canonical v2 fields. */
export type RoutingActivationSettings = AdaptiveRoutingSettings;

/**
 * Experimental. Triage reads the queued steering messages with a side model
 * once the queue settles and relabels them: an unrelated task moves to the end
 * of the turn, a confident stop may interrupt the run. `target` null uses the
 * session's active target.
 */
export interface SteeringTriageSettings {
	enabled: boolean;
	target: string | null;
	model: string | null;
	/** Thinking level of the triage side call; `off` sends no reasoning request. */
	thinkingLevel: ThinkingLevel;
	/** Queue length that starts a triage round. */
	minQueued: number;
	timeoutMs: number;
	/** Whether a confident `stop` reading may cancel the run to deliver its message now. */
	autoInterrupt: boolean;
}

interface SteeringSettings {
	triage: SteeringTriageSettings;
}

interface ChatSettings extends WorkerTarget {
	modelPicker: ModelSelectorSettings;
	maxOutputTokens: number;
	prewarm: boolean;
	/**
	 * Hosted prompt-cache keepalive (#423). While a turn waits on its own tools, above all an attached dispatch,
	 * PanCode refreshes the turn's cached prefix shortly before a hosted provider would drop it, when the refresh is
	 * expected to save more than it costs. Anthropic, OpenAI Responses and Codex routes, each refresh output-capped.
	 */
	cacheKeepalive: boolean;
	/** Loops and jobs created without a count or duration run until the operator stops them (#450). */
	loopsUntilStopped: boolean;
	retry: RetrySettings;
	steering: SteeringSettings;
}

/** One switch per memory side surface; each field lands with the slice that implements it. */
export interface MemorySurfaceSettings {
	/**
	 * Observation preparation for a predicted fold. Off by default as a policy choice: its cost is measured and its
	 * benefit is not.
	 */
	observe: "off" | "on";
	/**
	 * Which channels deliver kept lessons. `section` is the `# Memory` section alone; `decision`, the default, adds
	 * reminders at decision points (a failed call, a verification gap, a touched file, the turn's task); `broadcast`
	 * adds the first-change broadcast to `decision`, off by default as a policy choice; `off` delivers nothing from the
	 * store, and `memory_recall` still reaches every layer.
	 */
	delivery: MemoryDeliveryMode;
	/**
	 * Who writes cross-session notes. `agent`, the default, attaches `memory_note` to sessions that start with it, so
	 * the main agent writes notes whose command or read the host binds as evidence; `rules` pairs a failed command
	 * with the next success of the same program and subcommand that changed only its options and files that pair as
	 * a note; `side` adds the side-model lesson pass and completion retention, armed only by such a pair and run at
	 * most once per turn; `off` writes nothing. Rules capture runs under every mode but `off`. `agent` is a policy
	 * choice, not a measured win: if the author comparison shows it no better than `rules`, `rules` becomes the default.
	 */
	lessons: MemoryLessonsMode;
	/**
	 * In-session correction after repeated failures. `rules` (the default) keeps the repeated-failure annotation and
	 * turn-end reminder and makes no model call; `model` adds the model step on `tool_error_streak` and `loop_signal`.
	 * Rules by default as a policy choice: 111 lane model calls produced no reminder.
	 */
	correct: "rules" | "model";
	/**
	 * Task-bank maintenance between folds. `rules` (the default) writes procedural entries from failures and knowledge
	 * from operator statements; `model` adds the `interval` model step every `cadenceToolCalls` tools. Rules by default
	 * as a policy choice: 818 lane model calls, a product read by restoration 11 times.
	 */
	bank: "rules" | "model";
	/**
	 * Mining earlier sessions of the repository for new lessons while the session is idle. Off by default as a policy
	 * choice: archive filings were 36 grounded against 184 ungrounded, from sessions reviewing each other.
	 * `pancode memory consolidate` is the explicit, model-free pass over the store either way.
	 */
	history: "off" | "on";
}

export type MemoryDeliveryMode = "off" | "section" | "decision" | "broadcast";

export type MemoryLessonsMode = "off" | "rules" | "agent" | "side";

interface MemorySettings {
	enabled: boolean;
	/**
	 * The side-share governor: after three automatic memory calls a session refuses more while its memory output is over
	 * this share of its main output (and of its premium units, where the route reports them). 0 turns it off. A design
	 * assumption, not a measured optimum.
	 */
	sideShare: number;
	surfaces: MemorySurfaceSettings;
	target: string | null;
	model: string | null;
	/** Thinking level of the memory side call; `off` sends no reasoning request. */
	thinkingLevel: ThinkingLevel;
	cadenceToolCalls: number;
	trajectorySteps: number;
	maxOutputTokens: number;
	timeoutMs: number;
}

/** The optional local semantic index and its explicit ingestion roots. */
interface SemanticSettings {
	enabled: boolean;
	target: string | null;
	model: string | null;
	assetIdentity: string | null;
	projectorIdentity: string | null;
	canaryFingerprint: string | null;
	modalities: Array<"text" | "image" | "audio" | "mixed">;
	background: boolean;
	inboxes: Array<{ id: string; root: string; scope: "project" | "global"; project: string | null }>;
}

export interface ContextSettings {
	toolResultMaxBytes: number;
	workingSet: WorkingSetSettings;
	compaction: DurableCompactionSettings;
	memory: MemorySettings;
	semantic: SemanticSettings;
}

export interface SafetySettings {
	autonomy: AutonomyLevel;
	limits: {
		sessionCostUsd: number;
		chatToolCallsPerTurn: number;
		readBytesPerCall: number;
		observationBytesPerTurn: number;
		/**
		 * How far a prompt template's `budget.toolCalls` may raise its turn above
		 * `chatToolCallsPerTurn`. Null means a template can only lower the limit.
		 */
		templateToolCallsPerTurnMax: number | null;
		/** The same ceiling for a template's `budget.observationBytes` over `observationBytesPerTurn`. */
		templateObservationBytesPerTurnMax: number | null;
		workerResponseSeconds: number;
		/** Tool calls one yolo stretch runs before it pauses for the operator; 0 is off. */
		autonomousToolCalls: number;
		/** Minutes of active turn time one yolo stretch runs before it pauses; 0 is off. */
		autonomousMinutes: number;
		/** Tokens one yolo stretch spends before it pauses; 0 is off. */
		autonomousTokens: number;
		/**
		 * Seconds a main-session foreground bash call may go with no output and no CPU in its process tree before it
		 * ends as an idle timeout (FX-32); 0 is off.
		 */
		bashIdleSeconds: number;
	};
	review: ReviewSettings;
	/**
	 * OS sandbox for shell commands. A dispatched worker's own commands (bash,
	 * run_script, verification) run in the worker sandbox, and at autonomy
	 * default the main session's bash and run_script run contained in the
	 * main-session sandbox. auto sandboxes when a backend is available and
	 * records when it is not; required refuses worker commands without one;
	 * off never sandboxes, so main-session commands keep the approval rails.
	 * Under required a script the operator's yolo runs (#419) runs in the
	 * main-session sandbox when a backend exists and is refused when none
	 * does; auto and off leave yolo unsandboxed (#407).
	 */
	sandbox: SandboxMode;
	/** Let sandboxed worker commands reach the network even without web_fetch. */
	sandboxNetwork: boolean;
	/**
	 * Absolute trees the main session's sandbox may write and its deletes may
	 * clean as it does in the workspace, beside the built-in temp roots ($TMPDIR,
	 * /tmp, /var/tmp, and /var/folders on macOS) (#419). Read only from the
	 * operator's own settings file.
	 */
	scratchRoots: string[];
	/**
	 * Environment variables a sandboxed command keeps although their names or
	 * values look like credentials. Every other credential variable is removed
	 * before the sandbox starts, since a contained command reaches the network
	 * without a judgment. Read only from the operator's own settings file.
	 */
	sandboxPassEnv: string[];
	/**
	 * Target ids whose runtime's own login file the main session's contained commands may read, read-only, so a
	 * live check of a candidate build can sign in (copilot-sdk: `$COPILOT_HOME/config.json`). Workers keep every
	 * mask. Read only from the operator's own settings file.
	 */
	liveCheckTargets: string[];
	/**
	 * Unix-domain sockets inside the OS sandbox. block refuses new ones, since a
	 * socket a contained command can see (a terminal multiplexer, X11, a
	 * daemon's control socket) runs commands outside the sandbox; allow leaves
	 * them reachable. Read only from the operator's own settings file.
	 */
	sandboxUnixSockets: UnixSocketMode;
	/**
	 * Cap in GiB on the main-session sandbox's tool cache (`<cache dir>/sandbox-cache`). Once a day at startup, and
	 * on `doctor --fix`, its least recently used top-level tool directories are removed until it fits, unless a
	 * running process may still use it; 0 is no cap. Read only from the operator's own settings file.
	 */
	sandboxCacheMaxGiB: number;
	/**
	 * Workspace snapshots before the main agent mutates a Git work tree: auto
	 * snapshots before each turn's first mutating call and before every
	 * destructive one, and `/rewind` restores files from them; off takes none.
	 */
	snapshots: WorkspaceSnapshotMode;
	/**
	 * Repository wrapper scripts read as transparent when PanCode decides whether a
	 * shell command ran a check: an entry with a slash matches that script path,
	 * a bare name matches the script's basename. The wrapper and its leading
	 * options are skipped, so `scripts/test-slot.sh pnpm run test:file x`
	 * counts as the check it runs; the whole command's exit still decides the
	 * result, and the call still counts as a change, since the wrapper may write.
	 * The word must resolve to a file. A file writer, a shell, an interpreter, or
	 * a word that runs no check of its words (echo, printf, true, xargs, command,
	 * cat) is never a wrapper.
	 */
	validationWrappers: string[];
	/**
	 * Seconds an attended permission card or ask_user round waits for the
	 * operator before PanCode resolves it and the turn continues: a parked call is
	 * denied, an unanswered question takes its recommended option unless that
	 * option leaves the workspace. 0 waits forever. Read only from the
	 * operator's own settings file.
	 */
	unattendedAfterSeconds: number;
	/**
	 * The operator accepted what yolo does, once, through the acceptance card
	 * of its first interactive activation (#407). Read only from the operator's
	 * own settings file; headless `--autonomy yolo` and an ACP client's mode
	 * choice count as acceptance and write nothing.
	 */
	yoloAccepted: boolean;
	/**
	 * What yolo means: `contained` (the default) admits as default does, with
	 * the sandbox, snapshots and the safety judge, and refuses back to the agent
	 * what would wait for a person; `unconfined` is the skip-permissions yolo
	 * where only the yolo floor and operator-authored rules block. Read only
	 * from the operator's own settings file.
	 */
	yoloConfinement: YoloConfinement;
	/**
	 * The operator accepted unconfined yolo, through its own acceptance card or
	 * by writing it here. `yoloConfinement: unconfined` takes effect only with
	 * it, on every surface including headless runs; accepting contained yolo
	 * does not accept it. Read only from the operator's own settings file.
	 */
	yoloUnconfinedAccepted: boolean;
	/**
	 * The safety judge at autonomy `default`: a model that reviews a call the
	 * policy would park for approval against the operator's own messages, and
	 * either runs it or refuses it back to the agent. Read only from the
	 * operator's own settings file.
	 */
	judge: SafetyJudgeSettings;
}

interface SafetyJudgeSettings {
	enabled: boolean;
	/** Target the judge asks; null asks the session's main chat route. */
	target: string | null;
	/** Model on that target; null asks the chat model, or the judge target's default model. */
	model: string | null;
	/** Facts about the operator's environment the judge reads, in their own words. */
	environment: string[];
	/** Extra allow rules appended to the judge's default rules. */
	allow: string[];
	/** Extra block rules appended to the judge's default rules. */
	deny: string[];
}

type WorkspaceSnapshotMode = "auto" | "off";
export const WORKSPACE_SNAPSHOT_MODES: ReadonlyArray<WorkspaceSnapshotMode> = ["auto", "off"];

/**
 * Operator facts about a model, keyed by wire model id. `tier` overrides
 * `defaultModelTier` for that model on every target (WTF-P 0.8.3 C1).
 */
type ModelSettings = Record<string, { tier?: ModelTier }>;

interface IntegrationsSettings {
	projectResources: ProjectResourcesSettings;
	externalAgents: ExternalAgentsSettings;
	runtimePlugins: string[];
	hub: {
		catalog: string | null;
		remote: string | null;
		confirmedRemote: string | null;
		sync: boolean;
		/** Base URL of the signed PanHub index release; "" turns remote index refresh off. */
		index: string;
	};
	git: GitIntegrationSettings;
	music: MusicIntegrationSettings;
}

export const DEFAULT_SETTINGS = {
	version: 2 as const,
	turnControl: {
		workflows: ["detached-collection"],
	} as TurnControlSettings,
	targets: [] as TargetDescriptor[],
	funding: {} as FundingDefinitions,
	chat: {
		target: null as string | null,
		model: null as string | null,
		thinkingLevel: "low" as ThinkingLevel,
		modelPicker: {
			cycleSet: [] as string[],
			favorites: [] as string[],
			recentLimit: 12,
		} as ModelSelectorSettings,
		maxOutputTokens: 0,
		prewarm: false,
		cacheKeepalive: true,
		loopsUntilStopped: false,
		retry: {
			enabled: true,
			maxRetries: 3,
			baseDelayMs: 2000,
			maxDelayMs: 60000,
			streamStallMs: 180000,
			firstTokenStallMs: 600000,
		} as RetrySettings,
		steering: {
			triage: {
				enabled: false,
				target: null as string | null,
				model: null as string | null,
				thinkingLevel: "off" as ThinkingLevel,
				minQueued: 2,
				timeoutMs: 8000,
				autoInterrupt: true,
			},
		} as SteeringSettings,
	} as ChatSettings,
	fleet: {
		defaultNode: null as string | null,
		default: {
			target: null as string | null,
			model: null as string | null,
			thinkingLevel: "off" as ThinkingLevel,
		} as WorkerTarget,
		profiles: {} as WorkerProfiles,
		rosters: {} as WorkerRosters,
		agentProfiles: {} as FleetAgentProfiles,
		/**
		 * Experimental. With the `workerPrepare` site bound, a measured pick of the
		 * worker the main agent is about to dispatch starts that worker's process
		 * ahead of the call and holds it until a matching dispatch adopts it or the
		 * turn settles. Off, no recipe question is asked and nothing is held.
		 */
		nodes: [] as FleetNodeSettings[],
		adaptiveRouting: {
			roles: [] as ActiveRoutingRole[],
			postures: [] as ActiveRoutingPosture[],
			agentRoles: [] as ActiveAgentRole[],
		} as AdaptiveRoutingSettings,
		permissions: {
			mode: "judge" as WorkerPermissionMode,
			escalation: { timeoutMs: 120000, fallback: "deny" } as WorkerEscalationSettings,
		},
		concurrency: "auto" as "auto" | number,
		staggerSharedPrefix: true,
		keepPeerInstructionFiles: [] as string[],
		worktrees: { root: "disk" },
		retry: { maxRetries: 2, routeCooldownMs: 15000, breakerThreshold: 1 },
		limits: {
			toolCallsPerRun: 300,
			runTimeoutMs: 1800000,
			internalRunTimeoutMs: 2700000,
		},
		history: { maxRuns: GUARDRAIL_DEFAULTS.maxDispatchRuns, journal: true },
	} as FleetSettings,
	context: {
		toolResultMaxBytes: 65536,
		workingSet: DEFAULT_WORKING_SET_SETTINGS,
		compaction: {
			auto: true,
			threshold: 0.8,
			maxTokens: 400_000,
			provider: "off",
		} as DurableCompactionSettings,
		memory: {
			enabled: true,
			sideShare: 0.15,
			surfaces: {
				observe: "off",
				delivery: "decision",
				lessons: "agent",
				correct: "rules",
				bank: "rules",
				history: "off",
			},
			target: null as string | null,
			model: null as string | null,
			thinkingLevel: "off" as ThinkingLevel,
			cadenceToolCalls: 10,
			trajectorySteps: 8,
			maxOutputTokens: 2000,
			timeoutMs: 60_000,
		} as MemorySettings,
		semantic: {
			enabled: false,
			target: null,
			model: null,
			assetIdentity: null,
			projectorIdentity: null,
			canaryFingerprint: null,
			modalities: ["text"],
			background: false,
			inboxes: [],
		} as SemanticSettings,
	} as ContextSettings,
	systemOne: {
		use: null,
		engines: {},
	} as SystemOneSettings,
	safety: {
		autonomy: "default" as AutonomyLevel,
		limits: {
			sessionCostUsd: 5,
			chatToolCallsPerTurn: GUARDRAIL_DEFAULTS.turnToolCallBudget,
			readBytesPerCall: GUARDRAIL_DEFAULTS.readMaxBytes,
			observationBytesPerTurn: GUARDRAIL_DEFAULTS.observationTurnBudgetBytes,
			templateToolCallsPerTurnMax: null as number | null,
			templateObservationBytesPerTurnMax: null as number | null,
			workerResponseSeconds: 600,
			autonomousToolCalls: 600,
			autonomousMinutes: 120,
			autonomousTokens: 5_000_000,
			bashIdleSeconds: 0,
		},
		review: { enabled: false } as ReviewSettings,
		sandbox: "auto" as SandboxMode,
		sandboxNetwork: false,
		scratchRoots: [] as string[],
		sandboxPassEnv: [] as string[],
		liveCheckTargets: [] as string[],
		sandboxUnixSockets: "block" as UnixSocketMode,
		sandboxCacheMaxGiB: 4,
		snapshots: "auto" as WorkspaceSnapshotMode,
		validationWrappers: [] as string[],
		unattendedAfterSeconds: 300,
		yoloAccepted: false,
		yoloConfinement: "contained" as YoloConfinement,
		yoloUnconfinedAccepted: false,
		judge: {
			enabled: true,
			target: null,
			model: null,
			environment: [] as string[],
			allow: [] as string[],
			deny: [] as string[],
		} as SafetyJudgeSettings,
	} as SafetySettings,
	interface: {
		exitSummary: "on",
		demo: true,
		terminalProgress: false,
		outputDetail: "standard",
		mode: "regular",
		fullscreenScrollbar: "auto",
		smoothStreaming: "auto",
		desktopNotifications: false,
		autoUpdate: true,
		guiTurnCapacity: 4,
		panes: {
			notifications: "failures",
			layout: "off",
			workers: { ratio: 0.34 },
			files: {
				enabled: false,
				mode: "companion",
				profile: "managed",
				followCwd: true,
				ratio: 0.3,
			},
		} as PanesSettings,
		keybindings: {} as Record<string, string | string[]>,
	} as InterfaceSettings,
	integrations: {
		projectResources: { trustProjectImports: false },
		externalAgents: {
			entries: [] as DelegationAgentConfig[],
			defaults: {
				connectTimeoutMs: DEFAULT_DELEGATION_CONNECT_TIMEOUT_MS,
				turnTimeoutMs: DEFAULT_DELEGATION_TURN_TIMEOUT_MS,
				permissionTimeoutMs: DEFAULT_DELEGATION_PERMISSION_TIMEOUT_MS,
				toolGovernance: "pancode-policy" as DelegationToolGovernance,
			},
		} as ExternalAgentsSettings,
		runtimePlugins: [] as string[],
		hub: {
			catalog: null as string | null,
			remote: null as string | null,
			confirmedRemote: null as string | null,
			sync: false,
			index: DEFAULT_HUB_INDEX_URL,
		},
		git: { commitAttribution: true, commitAuthor: "auto" as GitCommitAuthorSetting },
		music: { enabled: false, station: DEFAULT_MUSIC_STATION, agentControl: false },
	} as IntegrationsSettings,
	telemetry: {
		mode: "standard",
		research: { content: false, deltas: true, providerHeaders: true, busTrace: false },
	} as TelemetrySettings,
	report: {
		offers: "ask" as "ask" | "off",
	},
	prompts: {
		profile: "v1" as "v1" | "v2",
	},
	models: {} as ModelSettings,
	store: { backend: "local", shared: null, s3: null, roots: [], placement: { byTag: {}, byClass: {} } } as StoreSettings,
};

/**
 * The settings.yaml a new home starts with, and the draft an editor opens when there is none. It holds no defaults:
 * a key the file leaves out keeps its built-in value, so the file and `pancode config inspect` show only what the
 * operator set. Writers add keys as deltas onto it.
 */
export const SETTINGS_SCAFFOLD_YAML = `# PanCode settings: only the keys you set. A key left out keeps its built-in default.
# \`pancode config inspect\` shows what each layer sets; \`pancode config set <path> <value>\` changes one key.
version: 2
`;

/**
 * settings.yaml may carry provider auth headers, so it is owner-only.
 */
export const SETTINGS_FILE_MODE = 0o600;
