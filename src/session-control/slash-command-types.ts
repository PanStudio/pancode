// SPDX-License-Identifier: LicenseRef-PanCode-1.0 AND MIT
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
// Split from slash-commands.ts, which adapts pi-coding-agent's BUILTIN_SLASH_COMMANDS registry.
import type { ExtensionOutputV2 } from "@pancode/sdk/extension";
import type { BundleRequest } from "../cli/report-bundle.js";
import type { SettingsAreaId } from "../core/settings-areas.js";
import type { TelemetryHub } from "../core/telemetry/hub.js";
import type { TurnConstraints } from "../core/turn-constraints.js";
import type { AgentSpec } from "../domains/agents/spec.js";
import type { AttachOperations } from "../domains/attach/host.js";
import type { ContextInitOptions } from "../domains/context/init-options.js";
import type { DispatchContract } from "../domains/dispatch/contract.js";
import type { AgentRoleFactsResolver } from "../domains/dispatch/execution-role.js";
import type { JobThinkingLevel } from "../domains/dispatch/validation.js";
import type { InstalledExtension } from "../domains/extensions/index.js";
import type { OperatorExtensions } from "../domains/extensions/operator-extensions.js";
import type { InteropAgentId, InteropProposal, InteropReport } from "../domains/interop/index.js";
import type { DoctorFinding } from "../domains/lifecycle/doctor.js";
import type { OperatorMemoryScope } from "../domains/memory/operator-statement.js";
import type { PanePeerId, PanesOperations, PanesPresetId } from "../domains/mux/operations.js";
import type { ProvidersContract, ResolvedModelRef } from "../domains/providers/index.js";
import type { ReportTextDuplicate, ReportTextHost } from "../domains/report/text-flow.js";
import type {
	HubCategory,
	HubOperation,
	PromptTemplate,
	PromptTemplateExpansion,
	ResourceList,
} from "../domains/resources/index.js";
import type { AutonomyLevel } from "../domains/safety/autonomy.js";
import type { DecisionLedgerEntry } from "../domains/session/entries.js";
import type { ShareImportPlan } from "../domains/share/index.js";
import type { UserTaskAcceptance } from "../domains/user-tasks/acceptance.js";
import type { UserTask } from "../domains/user-tasks/store.js";
import type { ExtensionReloadOutcome } from "../entry/extension-reload.js";
import type { JobOperations } from "../tools/job-types.js";
import type { ToolProfileName } from "../tools/profiles.js";
import type { CouncilCommandOptions, CouncilRosters } from "./council.js";
import type { LoopCommand } from "./loop-command.js";
import type { NoticeLevel } from "./notice-source.js";
import type { OperatorMemoryCommands } from "./operator-memory.js";
import type { OracleDigestSources } from "./oracle.js";
import type { PollCommandOptions } from "./poll.js";
import type { ReloadTarget } from "./reload-report.js";
import type { CommandArgsSpec, ParsedArgs } from "./slash-spec.js";
import type { WorkerEntryState } from "./worker-stream.js";

/**
 * Put a finished worker run's answer into the main agent's context. Bare
 * `/fleet share` takes the newest one.
 */
type ShareCommandVariant = { kind: "share"; runId?: string };
type ArchiveCommandVariant =
	| { kind: "archive-export"; path: string }
	| { kind: "archive-import"; path: string; dryRun: boolean; force: boolean };

type ReportCommandVariant =
	| { kind: "report"; report: SlashReportKind; summary?: string; bundle?: BundleRequest }
	| { kind: "report-status" }
	| { kind: "report-send"; draftId: string; duplicate?: ReportTextDuplicate }
	| { kind: "report-forget"; id: string }
	| { kind: "report-security" };

/** The kinds of report `/report` composes; security goes to a private advisory instead. */
export type SlashReportKind = "bug" | "feature" | "question";

/**
 * What `/report` asks the host to open: a new draft of a kind, with the summary as its title, or a saved draft to
 * review and send. `security` opens the private advisory page instead of a public report.
 */
export type SlashReportRequest =
	| { kind: SlashReportKind; summary?: string }
	| { kind: "draft"; draftId: string }
	| { kind: "security" };

/** What `/hub <verb> <ref>` asks the browser to review once it is open. */
export type HubBrowseIntent = HubOperation;

/**
 * How a command opens PanHub.
 *
 * A reference is a selection, never a write. `/hub install <ref>` opens the
 * browser on that row with its review armed, so the operator reads the plan
 * that command produced before any of it lands.
 */
export interface HubBrowseRequest {
	tab?: HubCategory;
	focus?: string;
	intent?: HubBrowseIntent;
	importSource?: string;
	scope?: "user" | "project";
}

type SlashCommandVariant =
	| { kind: "mcp"; argv: string[] }
	| { kind: "doctor"; deep: boolean }
	| { kind: "upgrade" }
	| { kind: "quit" }
	| { kind: "reload"; target: ReloadTarget }
	| { kind: "restart"; continuation?: string }
	| { kind: "trust" }
	| { kind: "help"; query?: string }
	| { kind: "init"; options: InitCommandOptions }
	| { kind: "context-clear"; options: ContextClearCommandOptions }
	| { kind: "context-refresh" }
	/** `ref` is the turnId an `[evicted ...]` marker names. */
	| { kind: "context-recall"; ref: string }
	| { kind: "context-recover"; handoffId: string; action: "reduce" | "deliver" }
	| {
			kind: "resources";
			family?: "extensions";
			tab?: HubCategory;
			action?: "dev" | "mute" | "unmute" | "leave" | "card";
			/** The folder or extension id a dev, mute or unmute action names; the card number `card` names. */
			target?: string;
			/** A package ref or resource key the browser selects on open. */
			focus?: string;
			/** An operation to review on that row. Nothing is written before the review. */
			intent?: HubBrowseIntent;
			/** A path or URL `/hub import` asks the import surface to review. */
			importSource?: string;
			/** Explicit `--user`/`--project`; absent leaves the browser's own selection. */
			scope?: "user" | "project";
	  }
	| { kind: "skill-invocation"; text: string }
	/** `/skill off`: drop the tool surface an activated skill armed for the session. */
	| { kind: "skill-surface-clear" }
	| ShareCommandVariant
	| ArchiveCommandVariant
	| ReportCommandVariant
	/** `source` is the line the operator typed, echoed above the run's transcript block. */
	| { kind: "run"; agentId: string; task: string; options: RunCommandOptions; source: string }
	/** `/run <external-id>`: hand a task to an external ACP agent. */
	| {
			kind: "delegate";
			agentId: string;
			task: string;
			source: string;
			share?: boolean;
			readOnly?: boolean;
	  }
	| { kind: "btw"; question: string }
	| { kind: "draft"; request: string; count: number }
	/** `/oracle <question>`: one read-only advisory run briefed on the record, never on the transcript. */
	| { kind: "oracle"; question: string }
	/** `/council <task>`: one read-only council of roster members, dispatched through the dispatch tool. */
	| { kind: "council"; task: string; options: CouncilCommandOptions; source: string }
	/** `/poll <n> <question>`: n independent participants vote; a one-round vote council with explicit members. */
	| { kind: "poll"; options: PollCommandOptions; source: string }
	| { kind: "handoff"; goal: string }
	/** `/fleet run <playbook>`: compile the plan, show it for approval, dispatch on accept. */
	| { kind: "fleet-run"; name: string; vars: Record<string, string>; resume?: string }
	| { kind: "fleet" }
	/** `/loop`: a bounded recurring job, or one of its control verbs. The words are parsed by loop-command.ts. */
	| { kind: "loop"; command: LoopCommand }
	| { kind: "agents"; connect?: boolean }
	| { kind: "usage"; tab?: UsageTab }
	| { kind: "context-view" }
	| { kind: "tasks" }
	| { kind: "decisions" }
	| { kind: "research" }
	| { kind: "tasks-add"; text: string; expectedOutputs?: string[]; verification?: string[] }
	| { kind: "tasks-hand"; id: string }
	| { kind: "tasks-done"; id: string }
	| { kind: "tasks-drop"; id: string }
	| { kind: "memory" }
	| { kind: "memory-seed" }
	/** `/remember <text>`, `/remember undo|scope|forget ...`: operator-stated memory and its chip actions. */
	| {
			kind: "remember";
			action: "remember" | "undo" | "scope" | "forget";
			text?: string;
			scope?: OperatorMemoryScope;
			captureId?: string;
	  }
	| { kind: "view"; filter?: string }
	| { kind: "view-verify"; runId: string }
	/** `/attach`: open, narrow, widen or close this session's attach socket. */
	| { kind: "attach"; action: "observe" | "approve" | "pair" | "off" | "status" }
	/** `/panes`: mode, health, pane inventory, effective settings. */
	| { kind: "panes" }
	| { kind: "panes-show"; target: string }
	/** A preset the model may also ask for, or operator-only argv. Never both. */
	| { kind: "panes-open"; preset?: PanesPresetId; argv?: ReadonlyArray<string>; once?: boolean }
	| { kind: "peer-pane"; peer: PanePeerId; brief?: string; cwd?: string }
	/** Toggle zoom on a PanCode-owned pane; the bare form targets the watch pane. */
	| { kind: "panes-zoom"; target: string }
	| { kind: "panes-close"; target: string }
	/** Bare `/panes peer`: the peers this machine can open. */
	| { kind: "panes-peers" }
	/** `/files`: toggle the files pane; `hide` parks it with Yazi running; `close` ends it; `pick` borrows it for one selection. */
	| { kind: "files"; action: "toggle" | "open" | "hide" | "close" | "pick" }
	| { kind: "thinking-set"; level: string }
	| { kind: "thinking-picker" }
	| { kind: "model" }
	| { kind: "model-set"; pattern: string }
	| { kind: "settings"; area?: SettingsAreaId }
	/** `target` is an id, unique id prefix, or exact name; absent opens the picker. */
	| { kind: "resume"; target?: string }
	| { kind: "rename"; name?: string }
	| { kind: "new" }
	| { kind: "tree" }
	/** `/rewind`: restore workspace files from a snapshot; `/tree` rewinds the conversation. */
	| { kind: "rewind" }
	| { kind: "fork"; name?: string }
	| { kind: "compact"; instructions: string | undefined }
	| { kind: "export"; path: string | undefined }
	| { kind: "unknown"; text: string }
	/** `text` is the whole line, so a token that turns out to name a prompt template keeps its arguments. */
	| { kind: "unknown-command"; token: string; text: string }
	/**
	 * The one usage answer. `bare` marks a command typed with no arguments at all,
	 * which is a question (info); anything else is a mistake (error). Dispatch
	 * rejects both, so the composer keeps the line.
	 */
	| { kind: "usage-error"; command: string; reason?: string; subcommand?: string; bare?: true }
	| { kind: "empty" };

/** The `/usage [tab]` values, in the overlay's tab order. */
export const USAGE_TAB_NAMES = ["activity", "accounts", "session", "models", "workers", "health"] as const;
export type UsageTab = (typeof USAGE_TAB_NAMES)[number];

export type SlashCommand = SlashCommandVariant | { kind: "eggs"; action: "status" | "off"; id?: string };

export type SlashCommandKind = SlashCommand["kind"];

export type SlashCommandDispatchResult = "accepted" | "rejected";

export interface RunIo {
	stdout: (s: string) => void;
	stderr: (s: string) => void;
}

export type SetThinkingLevelResult =
	| { status: "applied"; level: string; display: string; note?: string }
	| { status: "unsupported"; level: string; supported: ReadonlyArray<string> }
	| { status: "unavailable" };

/**
 * What one admitted dispatch-tool call reports back to `/council`. The council
 * itself is watched on the board and in the transcript, so success is silent;
 * only a refusal, a failure or a seat skipped because its target was down is worth a notice.
 */
export type CouncilDispatchOutcome =
	| { status: "ok"; tally?: Record<string, number>; skipped?: CouncilSkippedSeats }
	| { status: "blocked"; reason: string }
	| {
			status: "error";
			message: string;
			tally?: Record<string, number>;
			/** Set when some final-round members that ran answered and others failed. */
			partial?: { answered: number; total: number; failed: string[] };
			/** Set when admission skipped a seat whose target was down; it is not counted in `partial`. */
			skipped?: CouncilSkippedSeats;
	  };

/** Seats a council skipped because their target was down, and how many of the seats that ran answered. */
export interface CouncilSkippedSeats {
	answered: number;
	ran: number;
	labels: string[];
}

export type TaskMemorySeedCommandResult =
	| { status: "seeded"; seeded: number; skipped: number; source: string; flowRuleIds?: ReadonlyArray<string> }
	| { status: "disabled" }
	| { status: "not-found" }
	| { status: "refused"; reason: string };

export type InitCommandOptions = ContextInitOptions;

export interface ContextClearCommandOptions {
	all?: boolean;
	confirmed?: boolean;
	confirmedAll?: boolean;
}

export interface RunCommandOptions {
	readOnly?: boolean;
	workerProfile?: string;
	workerRuntime?: string;
	target?: string;
	/** Place this run in a PanCode-created task worktree and retain it for review. */
	worktree?: boolean;
	model?: string;
	thinkingLevel?: JobThinkingLevel;
	toolProfile?: ToolProfileName;
	requiredCapabilities?: string[];
	/** Hand the receipt's answer to the main agent when the run finishes. Off by default. */
	share?: boolean;
}

/** Whether an operator-started run began, waits in the queue for a slot, or never started. */
export type DispatchAdmission = "started" | "queued" | "refused";

export interface HandleRunDeps {
	dispatch: DispatchContract;
	/**
	 * Told once, at admission, whether the run started, was queued or never started, so a surface that answers
	 * before the run ends (ACP) says "started" only for a run that did.
	 */
	onAdmission?: (admission: DispatchAdmission) => void;
	/** Resolve a named target before the external workspace warning is shown. */
	runtimeForTarget?: (targetId: string) => string | null;
	/** Live session board, snapshotted before operator run admission. */
	getDecisionBoard?: () => ReadonlyArray<DecisionLedgerEntry>;
	/** Strict recipe facts the run's execution role is derived from. */
	getAgentRoleFacts?: AgentRoleFactsResolver;
	io: RunIo;
	notice: (level: NoticeLevel, text: string) => void;
	/**
	 * Optional bus for forwarding per-event worker output. When supplied,
	 * every non-heartbeat event is re-emitted on `"run.progressed"`
	 * so UI surfaces (dispatch-board overlay) can update their row as the
	 * stream arrives instead of waiting for the terminal receipt.
	 */
	bus?: TelemetryHub;
	/**
	 * Operator-turn sink for `--share`. Absent means the flag has nowhere to put
	 * the answer, which is reported rather than silently dropped: an operator who
	 * asked for the model to see a result must not be told it did.
	 */
	submitOperatorNote?: (text: string) => void;
	/**
	 * The session's standing tool limits. The run carries them, so a session
	 * started with `--delegate-tools read` never hands a worker write or bash.
	 */
	turnConstraints?: TurnConstraints;
}

/** What the transcript shows for a display-only prompt template. */
export interface PromptReferenceCard {
	/** Command name as typed, without the slash: `demo-pack:help`. */
	command: string;
	/** Where the template came from, in operator words: `plugin demo-pack`. */
	source: string;
	/** The body to show, already reduced to its reference block. */
	text: string;
	/** What the card is, beside its source; `reference` when absent. An extension's answer is a `result`. */
	kind?: string;
}

/**
 * Runtime dependencies every slash-command handler may need. Every field is
 * injected at startInteractive construction time; handlers never reach into
 * the TUI, chat loop, or overlay module graph directly.
 */
/** How `/fleet run` starts: a fresh run, or one that resumes a prior root's successful prefix. */
export interface FleetRunStartOptions {
	resume?: string;
}

export interface SessionCommandContext {
	eggsCommand?: (action: "status" | "off", id?: string) => string;
	keyboardActions?: {
		/** The key, and its Ctrl+G letter, for the action behind a menu letter. */
		menuLabel(letter: string): string;
	};
	operatorExtensions?: OperatorExtensions;
	/** The terminal's dev scope: `/extensions dev [folder]`, `mute <id>`, `unmute <id>`. */
	extensionDev?: (action: "dev" | "mute" | "unmute", argument: string | undefined) => void;
	/** Open a transcript extension card whole in the panel: the one numbered, or the latest cut one. */
	showExtensionCard?: (card: number | undefined) => "opened" | "missing" | "busy";
	/** `extensionId` comes from the command row: an alias such as a prompt takeover carries no `ext:<id>:` prefix. */
	showExtensionOutput?: (invocation: string, output: ExtensionOutputV2, extensionId: string) => void;
	io: RunIo;
	notice: (level: NoticeLevel, text: string) => void;
	dispatch: DispatchContract;
	getDecisionBoard?: HandleRunDeps["getDecisionBoard"];
	bus: TelemetryHub;
	/** Strict recipe facts used to keep interactive /run role-equivalent with the CLI. */
	getAgentRoleFacts?: AgentRoleFactsResolver;
	/**
	 * Echo the typed command line into the transcript, dimmed, before the block
	 * it starts. `/run` and `/delegate` use it so a worker's attributed block has
	 * the request above it. Transcript-only; the line never enters model context.
	 */
	echoOperatorCommand?: (text: string) => void;
	/**
	 * Render a display-only prompt template as an operator card in the
	 * transcript. Transcript-only, like the echo: the host that has no chat
	 * panel leaves it unset and the card falls back to `io.stdout`.
	 */
	showReference?: (card: PromptReferenceCard) => void;
	/**
	 * Put operator-authored text into the session the way typed text enters it:
	 * a user turn, persisted in the ledger, visible in the transcript. Used only
	 * by `--share` and `/share`, and never with expansion, because a worker's
	 * answer is literal text and must not be re-read as file or skill syntax.
	 */
	submitOperatorNote?: (text: string) => void;
	/** Worker blocks this session folded, oldest first. `/share` picks from these. */
	listWorkerRuns?: () => ReadonlyArray<WorkerEntryState>;
	/** The session gateway's state of each MCP server it reached: connected, failed or needs-auth. */
	mcpStatuses?: () => ReadonlyMap<string, { status: string; reason?: string; remedy?: string }>;
	/** Fire-and-forget shutdown. Handler must not await. */
	shutdown?: () => void;
	reloadClasses?: (target: ReloadTarget) => void;
	restart?: (continuation?: string) => void;
	/** Open the project trust card for this workspace's untrusted configuration. */
	openProjectTrust?: () => void;
	runInit: (options: InitCommandOptions) => void;
	/** Write the current session transcript (all tool segments expanded, ANSI-stripped) to a Markdown file. */
	exportTranscript: (path?: string) => void;
	runContextClear: (options: ContextClearCommandOptions) => void;
	/**
	 * Re-index the codewiki and refresh `.pancode` state without touching PANCODE.md.
	 * Optional until the host wires onContextRefresh.
	 */
	runContextRefresh?: () => void;
	/**
	 * Read an evicted tool-result body back into the transcript by ref, and
	 * record the `contextRecall` entry. Transcript-only: an operator recall
	 * answers the person, so the body never becomes model context. Optional
	 * until the host wires a session.
	 */
	runContextRecall?: (ref: string) => void;
	openSkillsHub?: (request?: HubBrowseRequest) => void;
	/**
	 * `/skill off`: drop the tool surface an activated skill armed for the
	 * session. Returns the names that were armed. Absent on a host with no
	 * chat loop, where nothing can be armed in the first place.
	 */
	clearSkillSurface?: () => ReadonlyArray<string>;
	/**
	 * The host's transcript states every change to the skill surface itself
	 * (the TUI's `§` rows), so `/skill off` adds no reply of its own when it
	 * cleared something. A host without that row prints the reply.
	 */
	statesSkillSurface?: boolean;
	listPrompts?: () => ResourceList<PromptTemplate>;
	/**
	 * Prompt templates from the committed plugin snapshot, without re-verifying
	 * plugin trees. For views that only name templates, such as /help and the
	 * /extensions detail. Absent means {@link listPrompts}. Nothing that runs a
	 * template or an extension command may read from it.
	 */
	listPromptsForDisplay?: () => ResourceList<PromptTemplate>;
	/**
	 * Resolve a `/name` against the loaded prompt templates. Absent when the host
	 * wired no resources, in which case a command-shaped token that names no
	 * builtin is simply not a command.
	 */
	expandPromptTemplate?: (text: string) => PromptTemplateExpansion;
	/**
	 * Whether `<id>:<prompt>` names a trusted MCP server's prompt. The line then
	 * goes to chat submission, whose expansion asks the server for the prompt.
	 */
	mcpPromptClaims?: (token: string) => boolean;
	listExtensions?: () => ReadonlyArray<InstalledExtension>;
	/**
	 * `/extensions reload`: build, validate, and commit the next
	 * extension generation together with its user hooks, or report why it was
	 * refused. Absent on a host without the reload coordinator, in which case
	 * the command says so instead of pretending.
	 */
	reloadExtensions?: () => ExtensionReloadOutcome;
	reloadPlugins?: () => { generation: number };
	/** Detection report, pending proposals, and the two consent actions `/interop` drives. */
	interop?: {
		report: () => InteropReport | null;
		proposals: () => ReadonlyArray<InteropProposal>;
		configured: () => ReadonlyArray<{ id: string; command: string; args: ReadonlyArray<string> }>;
		accept: (kind: InteropAgentId) => void;
		decline: (kind: InteropAgentId) => void;
	};
	listAgents?: () => ReadonlyArray<AgentSpec>;
	/** Whether `id` names a configured external (ACP) agent, so `/run <id>` hands it the task. */
	isExternalAgent?: (id: string) => boolean;
	exportShareArchive?: (outPath: string) => { fileCount: number; path: string };
	importShareArchive?: (path: string, options: { dryRun?: boolean; force?: boolean }) => ShareImportPlan;
	/** `/usage [tab]`; the Health tab shows journal losses, event-loop lag, transport, quota and breakers. */
	openUsage?: (tab?: UsageTab) => void;
	/**
	 * `/doctor [deep]`: the CLI doctor's findings, rendered as one notice.
	 * `deep` adds the live tool probe on the session's targets and the
	 * validation-contract dry run at the session's autonomy. Absent on a host
	 * with no providers, in which case the command says so.
	 */
	showDoctor?: (findings: ReadonlyArray<DoctorFinding>) => void;
	runDoctor?: (options: {
		deep: boolean;
	}) => Promise<{ level: NoticeLevel; text: string; findings?: ReadonlyArray<DoctorFinding> }>;
	/**
	 * `/upgrade`: review the available release, ask for explicit approval, and
	 * run the package lifecycle outside model context. Absent on non-interactive
	 * hosts, which refuse the command rather than treating it as chat text.
	 */
	startUpgrade?: () => void;
	/**
	 * `/btw <question>`: one model round beside the session, answered in an
	 * overlay. Nothing about it enters the transcript, the ledger, or the task
	 * board, so the workers a fleet run briefs never see the question or its
	 * answer.
	 */
	openSideQuestion?: (question: string) => void;
	/** `/draft [N] <request>`: N candidates side by side, judged by a decision model. */
	openDraft?: (request: string, count: number) => void;
	/**
	 * The record `/oracle` briefs its advisor on: settled decisions, the task
	 * board, and the last compaction summary. Absent on a host with no session,
	 * in which case `/oracle` says so instead of briefing on nothing.
	 */
	oracleBriefing?: () => Omit<OracleDigestSources, "question">;
	/**
	 * Configured `fleet.rosters`, which is what `/council` seats a council
	 * from. Absent on a host with no settings, in which case the command says so
	 * rather than dispatching a roster name it could not check.
	 */
	getWorkerRosters?: () => CouncilRosters;
	/**
	 * Run one dispatch-tool call with prepared council arguments through the
	 * ordinary tool-admission path. The council command owns no dispatch path of
	 * its own, so admission, the approval overlay, receipts, and the board treat
	 * an operator council exactly as they treat a model-asked one.
	 */
	runCouncilDispatch?: (
		args: Readonly<Record<string, unknown>>,
		turnConstraints?: TurnConstraints,
	) => Promise<CouncilDispatchOutcome>;
	/**
	 * True while a turn is streaming. `/oracle` is refused then, never queued:
	 * the digest describes the record as it stands and an in-flight turn is
	 * about to change it.
	 */
	isTurnInFlight?: () => boolean;
	/**
	 * The session's standing tool limits, which an ACP client ceiling narrows.
	 * A dispatch /run, /delegate, /oracle or /council starts outside a turn
	 * carries them, or it would run wider than the session it was started from (Z1).
	 */
	standingTurnConstraints?: () => TurnConstraints | undefined;
	/**
	 * `/handoff <goal>`: extract this session's working state for a stated goal,
	 * review the document, and seed a successor session with it. A session
	 * operation only. It writes no memory promotion candidate and never calls
	 * the task-memory bank.
	 */
	startHandoff?: (goal: string) => void;
	/**
	 * `/report`: open the report review over the session, never sending until the operator presses the send key on
	 * its send step. Absent on a surface without that review; the command then names `pancode report`.
	 */
	openReport?: (request: SlashReportRequest) => void;
	/** `/report status`: the reports and drafts on this machine. */
	showReportStatus?: () => void;
	/** `/report forget <id>`: delete a local draft; a report that already left this machine is refused. */
	forgetReport?: (id: string) => void;
	/**
	 * `/report` with no review to press send in (ACP): a kind previews the draft as text and saves it, and only
	 * `/report send <id>` sends. Used when {@link openReport} is absent.
	 */
	reportHost?: ReportTextHost;
	/**
	 * `/fleet run <playbook>`: compile the playbook's plan, show every wave, agent,
	 * target, boundary, budget, and code-step argv for approval, and dispatch
	 * only what the operator accepted. Absent on a host with no fleet wiring.
	 */
	startFleetRun?: (name: string, vars: Readonly<Record<string, string>>, options?: FleetRunStartOptions) => void;
	/** Open the read-only `/context` overlay: categorized context-window ledger. */
	openContextView?: () => void;
	/** Open the read-only `/tasks` overlay: the session task board with receipts. */
	openTasks?: () => void;
	/** Open the settled, branch-local interview decision board. */
	openDecisions?: () => void;
	/** Open the read-only `/research` overlay: this project's research campaigns and their timelines. */
	openResearch?: () => void;
	/** Project-scoped operator task inbox backing `/tasks` mutations. */
	userTasks?: {
		add(title: string, acceptance?: UserTaskAcceptance): UserTask;
		hand(id: string): UserTask;
		done(id: string): UserTask;
		drop(id: string): UserTask;
	};
	/** `/remember`: capture, move or undo what the operator told PanCode to remember. Absent with no chat loop. */
	operatorMemory?: OperatorMemoryCommands;
	/** Open `/memory` for approved lessons, the live task bank, and reviewed promotion. */
	openMemory?: () => void;
	/** Opt-in import from the newest structured handoff; absent when the host has no task bank. */
	seedTaskMemory?: () => TaskMemorySeedCommandResult;
	/** Open `/view`, the full observability artifact viewer. */
	openView?: (filter?: string) => void;
	/**
	 * The pane layer's operator surface. It remains present when mux resolves to
	 * `none` because the Yazi preset can borrow the terminal for one selection;
	 * absent only when the host did not compose pane operations at all.
	 */
	panes?: PanesOperations;
	/** The attach socket behind `/attach`. Absent outside the interactive terminal. */
	attach?: AttachOperations;
	/** The shared job control behind `/loop`. Absent where no session-owned job host exists. */
	jobs?: JobOperations;
	/** Serialize a local async command so the next admitted slash command observes its committed state. */
	runLocalOperation?: (operation: () => Promise<void>) => void;
	/**
	 * A command whose work outlives its handler (`/oracle`, `/council`) hands
	 * that work here. A host that answers when the work ends, as ACP does, waits
	 * for it; the terminal leaves this absent and the work runs on beside the
	 * prompt, as it always has.
	 */
	holdReplyFor?: (operation: Promise<void>) => void;
	/**
	 * A surface that answers before a dispatch command's run ends (ACP) waits on its admission, so a run that never
	 * started reads as the refusal its notice states, never as started.
	 */
	awaitDispatchStart?: (admission: Promise<DispatchAdmission>) => void;
	/**
	 * Apply a thinking level named on the command line. Returns why it was
	 * refused so the caller can say so, because the level the operator typed may
	 * not be one the active target supports.
	 */
	setThinkingLevel?: (level: string) => SetThinkingLevelResult;
	thinkingLevelChoices?: () => ReadonlyArray<{ value: string; label: string }>;
	openThinkingPicker?: () => void;
	/** Open the model picker when no model pattern was supplied. */
	openModel?: () => void;
	/** Live providers contract used by `/model <pattern>` to resolve directly. */
	providers: ProvidersContract;
	getChatTarget?: () => string | null | undefined;
	/** The live chat model, including a session-scoped `/model` switch. */
	getChatModel?: () => string | null | undefined;
	/** `fleet.agentProfiles`: recipes the operator bound to a worker profile. */
	getFleetAgentProfiles?: () => Readonly<Record<string, string>>;
	/** The session's effective autonomy level. */
	getAutonomy?: () => AutonomyLevel;
	/**
	 * Apply a resolved model reference for this session. "reported" means the
	 * host applied it and already said what landed, so no second notice is due.
	 */
	applyModelRef?: (ref: ResolvedModelRef) => "applied" | "reported";
	openSettings?: (area?: SettingsAreaId) => void;
	openFleetRuns?: () => void;
	/** Resume `target` (an id, unique id prefix or exact name) directly, or open the picker. */
	openResume?: (target?: string) => void;
	renameSession?: (name?: string) => void;
	startNewSession?: () => void;
	openTree?: () => void;
	/** Open `/rewind`, the workspace snapshot list. Absent on a host with no overlay layer. */
	openRewind?: () => void;
	/** Open the `/fork` picker; `name` names the new session when a turn is picked. */
	openMessagePicker?: (name?: string) => void;
	openHelp?: (query?: string) => void;
	openExtensions?: () => void;
	openInterop?: () => void;
	setEditorText?: (text: string) => void;
	/**
	 * Run compaction for the current session. Handler resolves the target
	 * model, reads session entries, calls session/compaction/compact, and
	 * appends a compactionSummary entry. No-op when no session is open, so the
	 * handler prints an actionable stderr line instead.
	 */
	runHandoffRecovery?: (handoffId: string, action: "reduce" | "deliver") => void;
	runCompact: (instructions: string | undefined) => void;
	/**
	 * Escape hatch for the `view verify` entry: verify a run's sealed run scope
	 * and emit an actionable verification block. Kept on the context so the registry does
	 * not import the overlay module.
	 */
	verifyRun?: (runId: string) => ({ ok: true } | { ok: false; reason: string }) & {
		sealedDigest?: string | null;
		trustSummary?: string | null;
		verificationSummary?: string | null;
		compromised?: boolean;
		checks?: ReadonlyArray<{ name: string; ok: boolean; evidence: string }>;
	};
	/**
	 * Handles the "unknown" case: append the text to the chat panel as a user
	 * turn, submit to the chat loop, and schedule a re-render. Handlers for
	 * {kind:"unknown"} defer to this so the chat-panel reference stays scoped
	 * to startInteractive.
	 */
	submitChat: (text: string) => void;
	/** Re-render request; wraps tui.requestRender so handlers do not import TUI. */
	render?: () => void;
}

export type SlashCommandContext = SessionCommandContext;

/** What a command is about, in the order /help lists the groups. */
export const SLASH_COMMAND_GROUPS = ["Session", "Model and context", "Work", "PanCode"] as const;
export type SlashCommandGroup = (typeof SLASH_COMMAND_GROUPS)[number];

export interface CommandAcpAdmission {
	subcommands?: ReadonlyArray<string>;
	streams?: "dispatch";
	injectsUserTurn?: true;
	/** First arguments that do not submit a turn, so an active prompt does not refuse them. */
	injectsUserTurnExcept?: ReadonlyArray<string>;
	promptTurn?: true;
	promptTurnSubcommands?: ReadonlyArray<string>;
	/**
	 * First arguments that only read, with `""` for the bare form. Under an ACP
	 * client or operator ceiling only these and turn-injecting commands run (Z1).
	 */
	reads?: ReadonlyArray<string>;
	/**
	 * First arguments that only stop, pause or reshape the session's own context
	 * and write no project or operator file. A ceiling admits them as it admits
	 * {@link reads}: a client held to read-only must still be able to stop a loop.
	 */
	sessionOnly?: ReadonlyArray<string>;
	/**
	 * The whole command, or these first arguments, write project or session
	 * state or start a worker outside any tool call. A read-only ceiling denies
	 * every write and delegation, so it refuses them even when they submit a turn.
	 */
	readOnlyRefuses?: true | ReadonlyArray<string>;
}

export type CommandRank = 1 | 2 | 3;

export interface CommandAlias {
	name: string;
	args?: string;
}

export interface BuiltinSlashCommand {
	acp: false | CommandAcpAdmission;
	name: string;
	description: string;
	group: SlashCommandGroup;
	/** Palette order: 1 everyday, 2 regular, 3 rare. Required so a new command cannot be left unranked. */
	rank: CommandRank;
	/** Names other agents taught people, each resolving to this command with optional leading args. */
	aliases?: ReadonlyArray<CommandAlias>;
	/** Excluded from /help, autocomplete, and the docs command table. */
	hidden?: boolean;
	args?: CommandArgsSpec;
	/** Stable copy shown beside first-token subcommand completions. */
	subcommandDescriptions?: Readonly<Record<string, string>>;
	/** The set of SlashCommand kinds this entry is responsible for dispatching. */
	kinds: ReadonlyArray<SlashCommandKind>;
	/** Return the parsed SlashCommand for `trimmed` or null if this entry does not match. */
	match?(trimmed: string): SlashCommand | null;
	fromArgs?(parsed: ParsedArgs, trimmed: string): SlashCommand;
	/** Execute `command` against `ctx`. Called only for kinds declared in `kinds`. */
	handle(command: SlashCommand, ctx: SlashCommandContext): undefined | "rejected";
}
