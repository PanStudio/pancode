// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * Operator views a client renders: artifacts, aside answers, the session
 * board, the context ledger, extensions and the hub, and the command catalog.
 */

import { Type } from "typebox";
import { literalUnion } from "../core/telemetry/enums.js";
import { DRAFT_LABELS } from "../core/views/draft-words.js";
import { NOTICE_LEVELS, type NoticeLevel } from "../core/views/notice-words.js";
import type { ViewArtifactCategory, ViewArtifactFormat } from "../domains/session/view-artifacts.js";
import type { UserTask } from "../domains/user-tasks/store.js";
import { ACP_PROMPT_META_KEY, closed } from "./types.js";
import { wireSteeringCopy, wireSteeringName } from "./types-session.js";

export interface AcpArtifactRow {
	/** `<category>/<provider id>`; provider ids are unique only inside a category. */
	id: string;
	category: ViewArtifactCategory;
	title: string;
	subtitle?: string;
	/** ISO time the artifact was produced, absent when unknown. */
	at?: string;
	sizeBytes?: number;
	/** The format a read is expected to return; the read's own `format` is authoritative. */
	format: ViewArtifactFormat;
	/** Set when a read returns the protection record and a refusal instead of content. */
	protected?: true;
}

export interface AcpArtifactPage {
	id: string;
	category: ViewArtifactCategory;
	title: string;
	format: ViewArtifactFormat;
	lines: string[];
	offset: number;
	totalLines: number;
	nextOffset: number | null;
	/** Lines cut to fit one page; reassembly is exact only when this is absent. */
	clippedLines?: number;
	/** An `image` artifact's picture, on the first page when it fits one; absent otherwise. */
	image?: { mimeType: string; data: string };
	/** The overlay's `i` view, read with `details: true`. */
	details?: { format: ViewArtifactFormat; lineCount: number };
	refused?: { reason: string };
}

export interface AcpArtifactReadRequest {
	id: string;
	offset?: number;
	limit?: number;
	details?: boolean;
}

export type AcpAsideAnswer =
	| { status: "answered"; text: string }
	| { status: "aborted"; text: string }
	| { status: "refused"; reason: string }
	| { status: "failed"; reason: string };

export type AcpDraftOutcome =
	| {
			status: "drafted";
			aborted: boolean;
			candidates: ReadonlyArray<{ status: "drafted"; text: string } | { status: "failed"; reason: string }>;
	  }
	| { status: "refused"; reason: string };

export interface AcpSessionBoard {
	version: 1;
	operatorTasks: Array<{
		id: string;
		title: string;
		status: UserTask["status"];
		expectedOutputs: string[];
		verificationChecks: number;
	}>;
	plan: {
		title: string;
		tasks: Array<{ id: string; title: string; status: string; origin: "agent" | "user"; reason: string | null }>;
	} | null;
	decisions: Array<{
		ref: string;
		/** With {@link key}, what `_pancode/decisions/supersede` names. */
		interviewId: string;
		key: string;
		label: string | null;
		value: string;
		status: "active" | "superseded";
		source: "operator" | "agent" | "operator-message" | null;
		decidedAt: string;
		rationale: string | null;
		correction: string | null;
	}>;
	memory: {
		enabled: boolean;
		tier: "llm" | "rules";
		entries: number;
		stepInFlight: boolean;
		/** Knowledge and procedural entries a person may propose as durable memory; status stays private. */
		bank: Array<{ id: string; kind: "knowledge" | "procedural"; content: string }>;
	} | null;
	/** True when any list was cut at {@link ACP_BOARD_MAX_ITEMS}. */
	truncated: boolean;
}

export interface AcpContextLedger {
	version: 1;
	provider: string | null;
	model: string | null;
	/** Tokens; 0 when unknown. */
	contextWindow: number;
	contextWindowSource: string | null;
	contextWindowSlots: { slots: number; totalTokens: number } | null;
	usedTokens: number;
	reserveTokens: number;
	freeTokens: number;
	/** used/window; null when the window is unknown. */
	percent: number | null;
	/** True when the total is anchored to provider-measured usage, false when estimated. */
	measured: boolean;
	compactionThreshold: number | null;
	compactionAuto: boolean;
	projectPreload: string | null;
	projectHandbookFiles: string[] | null;
	toolCount: number;
	groups: Array<{ category: string; label: string; tokens: number; percent: number | null }>;
	lastCompaction: { stage: string; tokensBefore: number; tokensAfter: number; trigger: string } | null;
	promptCache: {
		shellReused: boolean;
		cacheReadTokens: number | null;
		cacheWriteTokens: number | null;
		/** Provider-reported input for the last run; the whole prompt when the provider omits its cache reads. */
		uncachedInputTokens: number | null;
		backendVerdict: "hot" | "partial" | "cold" | "small" | "unknown" | null;
		/** Cache disturbances PanCode expected before the last settled run, so a client can tell a planned cold start. */
		expectedColdReasons?: string[];
		/** The serving backend's own prefill timings for the run's last call; null when none were captured. */
		backend?: {
			promptTokens: number;
			cachedTokens: number | null;
			predictedTokens: number;
			promptMs: number;
			predictedMs: number;
			source: "llamacpp-timings" | "lmstudio-timings";
		} | null;
		/** Prompt tokens the serving backend evaluated for the run's last call, from its own timings; null unless they report cache reads. */
		uncachedPrefillTokens?: number | null;
	} | null;
}

export interface AcpInstalledExtension {
	id: string;
	name: string;
	version: string;
	description: string;
	scope: string;
	enabled: boolean;
	valid: boolean;
	compatible: boolean;
	loadable: boolean;
	overriddenBy?: string;
	runtimeV2?: unknown;
	diagnostics: ReadonlyArray<{ message: string }>;
}

export type AcpExtensionReloadOutcome =
	| {
			status: "committed";
			generation: number;
			changed: boolean;
			added: ReadonlyArray<unknown>;
			removed: ReadonlyArray<unknown>;
			modified: ReadonlyArray<unknown>;
			hooks: { registered: number; dropped: number; fileIssues: number; issues: number; overridden: number };
			lines: ReadonlyArray<string>;
	  }
	| { status: "rejected"; reason: string; generation: number; lines: ReadonlyArray<string> };

export interface AcpCommandFlagSpec {
	name: string;
	takesValue?: boolean;
	repeatable?: boolean;
	values?: string[];
	valueName?: string;
	completionSlot?: string;
}

export interface AcpCommandPositionalSpec {
	name: string;
	required: boolean;
	values?: string[];
	rest?: boolean;
	completionSlot?: string;
}

export interface AcpCommandArgsSpec {
	flags?: AcpCommandFlagSpec[];
	positionals?: AcpCommandPositionalSpec[];
	subcommands?: Record<string, AcpCommandArgsSpec>;
}

export interface AcpCommandDescriptor {
	name: string;
	summary: string;
	/** The registry's own usage line, already rendered from the grammar below. */
	usage: string;
	group: string;
	args: AcpCommandArgsSpec;
	subcommandSummaries?: Record<string, string>;
	/** The bare command is refused; only the projected subcommands are admitted. */
	requiresSubcommand?: true;
	streams?: "dispatch";
	injectsUserTurn?: true;
	promptTurn?: true;
	promptTurnSubcommands?: string[];
}

/** The marks a prompt template's row carries, as the terminal's palette shows them. */
interface AcpPromptMarks {
	/** Why the template cannot expand; the row refuses a pick. */
	unavailable?: string;
	/** A reference card shown to the operator; nothing is sent to the model. */
	displayOnly?: true;
}

/** A `/name` a line may type besides the built-in commands, in ACP's standard `AvailableCommand` shape. */
export interface AcpTypedCommand {
	name: string;
	description: string;
	/** The arguments after the name, as the prompt template's `argument-hint` says them. */
	input?: { hint: string };
	_meta?: { [ACP_PROMPT_META_KEY]: AcpPromptMarks };
}

export interface AcpCommandCatalog {
	version: 1;
	commands: AcpCommandDescriptor[];
	prompts?: AcpTypedCommand[];
	/** `/name` lines a loaded operator extension answers locally, with no model turn; a takeover shares its prompt's name. */
	extensionCommands?: AcpTypedCommand[];
}

/** `_meta["pancode/report"]` on a `/report` result: the draft it is about and its outbox state. */
export interface AcpCommandReportMeta {
	draftId: string;
	state: string;
}

export interface AcpCommandResult {
	level: NoticeLevel;
	lines: string[];
	/** Present only on a `/report` result, so a client can build its own dialog without parsing the lines. */
	_meta?: { "pancode/report": AcpCommandReportMeta };
}

const wireArtifactsText = Type.String({ maxLength: 8192 });

const wireArtifactsCount = Type.Integer({ minimum: 0 });

const wireArtifactsFormat = Type.Union([Type.Literal("text"), Type.Literal("markdown"), Type.Literal("json")]);

export const AcpArtifactListSchema = Type.Object(
	{
		artifacts: Type.Array(
			Type.Object(
				{
					id: wireArtifactsText,
					category: wireArtifactsText,
					title: wireArtifactsText,
					format: wireArtifactsFormat,
					subtitle: Type.Optional(wireArtifactsText),
					at: Type.Optional(wireArtifactsText),
					sizeBytes: Type.Optional(wireArtifactsCount),
					protected: Type.Optional(Type.Literal(true)),
				},
				closed,
			),
			{ maxItems: 6400 },
		),
		truncated: Type.Boolean(),
	},
	closed,
);

export const AcpArtifactPageSchema = Type.Object(
	{
		id: wireArtifactsText,
		category: wireArtifactsText,
		title: wireArtifactsText,
		format: wireArtifactsFormat,
		lines: Type.Array(Type.String(), { maxItems: 2000 }),
		offset: wireArtifactsCount,
		totalLines: wireArtifactsCount,
		nextOffset: Type.Union([wireArtifactsCount, Type.Null()]),
		clippedLines: Type.Optional(wireArtifactsCount),
		details: Type.Optional(Type.Object({ format: wireArtifactsFormat, lineCount: wireArtifactsCount }, closed)),
		refused: Type.Optional(Type.Object({ reason: wireArtifactsText }, closed)),
	},
	closed,
);

const wireAsideAnswer = Type.String({ maxLength: 66000 });

const wireAsideReason = Type.String({ maxLength: 1100 });

const wireAsideLabel = literalUnion(DRAFT_LABELS);

const wireAsideRefusedOrFailed = Type.Object(
	{ status: Type.Union([Type.Literal("refused"), Type.Literal("failed")]), reason: wireAsideReason },
	closed,
);

export const AcpAsideAnswerSchema = Type.Union([
	Type.Object(
		{
			status: Type.Union([Type.Literal("answered"), Type.Literal("aborted")]),
			text: wireAsideAnswer,
			truncated: Type.Boolean(),
		},
		closed,
	),
	wireAsideRefusedOrFailed,
]);

const wireAsideShare = Type.Number({ minimum: 0 });

export const AcpAsideDraftsSchema = Type.Union([
	Type.Object(
		{
			status: Type.Literal("drafted"),
			aborted: Type.Boolean(),
			candidates: Type.Array(
				Type.Union([
					Type.Object(
						{ label: wireAsideLabel, status: Type.Literal("drafted"), text: wireAsideAnswer, truncated: Type.Boolean() },
						closed,
					),
					Type.Object({ label: wireAsideLabel, status: Type.Literal("failed"), reason: wireAsideReason }, closed),
				]),
				{ maxItems: 4 },
			),
			judgment: Type.Optional(
				Type.Union([
					Type.Object(
						{
							status: Type.Literal("judged"),
							picked: Type.Union([wireAsideLabel, Type.Null()]),
							probabilities: Type.Record(Type.String({ maxLength: 1 }), wireAsideShare),
							sound: Type.Record(Type.String({ maxLength: 1 }), Type.Union([Type.Boolean(), Type.Null()])),
							source: wireAsideReason,
							elapsedMs: Type.Integer({ minimum: 0 }),
						},
						closed,
					),
					Type.Object({ status: Type.Literal("unjudged"), reason: wireAsideReason }, closed),
				]),
			),
		},
		closed,
	),
	Type.Object({ status: Type.Literal("refused"), reason: wireAsideReason }, closed),
]);

export const AcpAsideCancelledSchema = Type.Object({ cancelled: Type.Boolean() }, closed);

const wireBoardText = Type.String({ maxLength: 1100 });

const wireBoardNullableText = Type.Union([wireBoardText, Type.Null()]);

const wireBoardItems = 100;

export const AcpSessionBoardSchema = Type.Object(
	{
		version: Type.Literal(1),
		operatorTasks: Type.Array(
			Type.Object(
				{
					id: Type.String({ maxLength: 32 }),
					title: wireBoardText,
					status: Type.Union([
						Type.Literal("open"),
						Type.Literal("handed"),
						Type.Literal("picked"),
						Type.Literal("done"),
						Type.Literal("dropped"),
					]),
					expectedOutputs: Type.Array(wireBoardText, { maxItems: 8 }),
					verificationChecks: Type.Integer({ minimum: 0 }),
				},
				closed,
			),
			{ maxItems: wireBoardItems },
		),
		plan: Type.Union([
			Type.Object(
				{
					title: wireBoardText,
					tasks: Type.Array(
						Type.Object(
							{
								id: Type.String({ maxLength: 64 }),
								title: wireBoardText,
								status: Type.String({ maxLength: 32 }),
								origin: Type.Union([Type.Literal("agent"), Type.Literal("user")]),
								reason: wireBoardNullableText,
							},
							closed,
						),
						{ maxItems: wireBoardItems },
					),
				},
				closed,
			),
			Type.Null(),
		]),
		decisions: Type.Array(
			Type.Object(
				{
					ref: Type.String({ maxLength: 2300 }),
					/** With key, what a supersede names; absent from older agents. */
					interviewId: Type.Optional(Type.String({ maxLength: 256 })),
					key: wireBoardText,
					label: wireBoardNullableText,
					value: wireBoardText,
					status: Type.Union([Type.Literal("active"), Type.Literal("superseded")]),
					source: Type.Union([
						Type.Literal("operator"),
						Type.Literal("agent"),
						Type.Literal("operator-message"),
						Type.Null(),
					]),
					decidedAt: Type.String({ maxLength: 64 }),
					rationale: wireBoardNullableText,
					correction: wireBoardNullableText,
				},
				closed,
			),
			{ maxItems: wireBoardItems },
		),
		memory: Type.Union([
			Type.Object(
				{
					enabled: Type.Boolean(),
					tier: Type.Union([Type.Literal("llm"), Type.Literal("rules")]),
					entries: Type.Integer({ minimum: 0 }),
					stepInFlight: Type.Boolean(),
					/** Entries a person may propose as durable memory; absent from older agents. */
					bank: Type.Optional(
						Type.Array(
							Type.Object(
								{
									id: Type.String({ maxLength: 256 }),
									kind: Type.Union([Type.Literal("knowledge"), Type.Literal("procedural")]),
									content: wireBoardText,
								},
								closed,
							),
							{ maxItems: wireBoardItems },
						),
					),
				},
				closed,
			),
			Type.Null(),
		]),
		truncated: Type.Boolean(),
	},
	closed,
);

const wireContextLedgerText = Type.String({ maxLength: 300 });

const wireContextLedgerTokens = Type.Integer({ minimum: 0 });

const wireContextLedgerNullableCount = Type.Union([wireContextLedgerTokens, Type.Null()]);

export const AcpContextLedgerSchema = Type.Object(
	{
		version: Type.Literal(1),
		provider: Type.Union([wireContextLedgerText, Type.Null()]),
		model: Type.Union([wireContextLedgerText, Type.Null()]),
		contextWindow: wireContextLedgerTokens,
		contextWindowSource: Type.Union([wireContextLedgerText, Type.Null()]),
		contextWindowSlots: Type.Union([
			Type.Object({ slots: wireContextLedgerTokens, totalTokens: wireContextLedgerTokens }, closed),
			Type.Null(),
		]),
		usedTokens: wireContextLedgerTokens,
		reserveTokens: wireContextLedgerTokens,
		freeTokens: wireContextLedgerTokens,
		percent: Type.Union([Type.Number({ minimum: 0 }), Type.Null()]),
		measured: Type.Boolean(),
		compactionThreshold: Type.Union([Type.Number(), Type.Null()]),
		compactionAuto: Type.Boolean(),
		projectPreload: Type.Union([wireContextLedgerText, Type.Null()]),
		projectHandbookFiles: Type.Union([Type.Array(wireContextLedgerText, { maxItems: 16 }), Type.Null()]),
		toolCount: wireContextLedgerTokens,
		groups: Type.Array(
			Type.Object(
				{
					category: Type.String({ maxLength: 32 }),
					label: wireContextLedgerText,
					tokens: wireContextLedgerTokens,
					percent: Type.Union([Type.Number({ minimum: 0 }), Type.Null()]),
				},
				closed,
			),
			{ maxItems: 32 },
		),
		lastCompaction: Type.Union([
			Type.Object(
				{
					stage: wireContextLedgerText,
					tokensBefore: wireContextLedgerTokens,
					tokensAfter: wireContextLedgerTokens,
					trigger: wireContextLedgerText,
				},
				closed,
			),
			Type.Null(),
		]),
		promptCache: Type.Union([
			Type.Object(
				{
					shellReused: Type.Boolean(),
					cacheReadTokens: wireContextLedgerNullableCount,
					cacheWriteTokens: wireContextLedgerNullableCount,
					uncachedInputTokens: wireContextLedgerNullableCount,
					backendVerdict: Type.Union([
						Type.Literal("hot"),
						Type.Literal("partial"),
						Type.Literal("cold"),
						Type.Literal("small"),
						Type.Literal("unknown"),
						Type.Null(),
					]),
					expectedColdReasons: Type.Optional(Type.Array(wireContextLedgerText, { maxItems: 16 })),
					backend: Type.Optional(
						Type.Union([
							Type.Object(
								{
									promptTokens: wireContextLedgerTokens,
									cachedTokens: wireContextLedgerNullableCount,
									predictedTokens: wireContextLedgerTokens,
									promptMs: Type.Number({ minimum: 0 }),
									predictedMs: Type.Number({ minimum: 0 }),
									source: Type.Union([Type.Literal("llamacpp-timings"), Type.Literal("lmstudio-timings")]),
								},
								closed,
							),
							Type.Null(),
						]),
					),
					uncachedPrefillTokens: Type.Optional(wireContextLedgerNullableCount),
				},
				closed,
			),
			Type.Null(),
		]),
	},
	closed,
);

const wireSteeringFlagSpec = Type.Object(
	{
		name: wireSteeringName,
		takesValue: Type.Optional(Type.Boolean()),
		repeatable: Type.Optional(Type.Boolean()),
		values: Type.Optional(Type.Array(wireSteeringName, { maxItems: 64 })),
		valueName: Type.Optional(wireSteeringName),
		completionSlot: Type.Optional(wireSteeringName),
	},
	closed,
);

const wireSteeringPositionalSpec = Type.Object(
	{
		name: wireSteeringName,
		required: Type.Boolean(),
		values: Type.Optional(Type.Array(wireSteeringName, { maxItems: 64 })),
		rest: Type.Optional(Type.Boolean()),
		completionSlot: Type.Optional(wireSteeringName),
	},
	closed,
);

const wireSteeringLeafArgs = Type.Object(
	{
		flags: Type.Optional(Type.Array(wireSteeringFlagSpec, { maxItems: 32 })),
		positionals: Type.Optional(Type.Array(wireSteeringPositionalSpec, { maxItems: 8 })),
	},
	closed,
);

const wireSteeringCommandArgs = Type.Object(
	{
		flags: Type.Optional(Type.Array(wireSteeringFlagSpec, { maxItems: 32 })),
		positionals: Type.Optional(Type.Array(wireSteeringPositionalSpec, { maxItems: 8 })),
		subcommands: Type.Optional(Type.Record(Type.String(), wireSteeringLeafArgs)),
	},
	closed,
);

const wireSteeringCommandDescriptor = Type.Object(
	{
		name: wireSteeringName,
		summary: wireSteeringCopy,
		usage: wireSteeringCopy,
		group: wireSteeringName,
		args: wireSteeringCommandArgs,
		subcommandSummaries: Type.Optional(Type.Record(Type.String(), wireSteeringCopy)),
		/** The bare command is refused; only the projected subcommands are admitted. */
		requiresSubcommand: Type.Optional(Type.Literal(true)),
		/** The result is "started"; real output arrives as fleet events. */
		streams: Type.Optional(Type.Literal("dispatch")),
		/** The command puts a user turn into the session outside any prompt. */
		injectsUserTurn: Type.Optional(Type.Literal(true)),
		/** The command's calls and approvals belong to a conversation turn, so it is sent as one. */
		promptTurn: Type.Optional(Type.Literal(true)),
		/** Subcommands sent as a conversation turn, as promptTurn does for a whole command. */
		promptTurnSubcommands: Type.Optional(Type.Array(Type.String({ maxLength: 64 }), { maxItems: 16 })),
	},
	closed,
);

const wireTypedCommand = Type.Object(
	{
		name: Type.String({ minLength: 1, maxLength: 128 }),
		description: wireSteeringCopy,
		input: Type.Optional(Type.Object({ hint: wireSteeringCopy }, closed)),
		_meta: Type.Optional(
			Type.Object(
				{
					[ACP_PROMPT_META_KEY]: Type.Object(
						{ unavailable: Type.Optional(wireSteeringCopy), displayOnly: Type.Optional(Type.Literal(true)) },
						closed,
					),
				},
				closed,
			),
		),
	},
	closed,
);

export const AcpCommandCatalogSchema = Type.Object(
	{
		version: Type.Literal(1),
		commands: Type.Array(wireSteeringCommandDescriptor, { maxItems: 64 }),
		/** Loaded prompt templates a `/name` line expands to; absent from a build that does not say. */
		prompts: Type.Optional(Type.Array(wireTypedCommand, { maxItems: 256 })),
		/** `/name` lines a loaded operator extension answers locally, with no model turn; a takeover shares its prompt's name. */
		extensionCommands: Type.Optional(Type.Array(wireTypedCommand, { maxItems: 256 })),
	},
	closed,
);

export const AcpCommandResultSchema = Type.Object(
	{
		level: literalUnion(NOTICE_LEVELS),
		lines: Type.Array(Type.String({ maxLength: 1024 }), { maxItems: 201 }),
		_meta: Type.Optional(
			Type.Object(
				{
					"pancode/report": Type.Object(
						{ draftId: Type.String({ maxLength: 256 }), state: Type.String({ maxLength: 256 }) },
						closed,
					),
				},
				closed,
			),
		),
	},
	closed,
);

const wireExtensionsText = Type.String({ maxLength: 520 });

const wireExtensionsCount = Type.Integer({ minimum: 0 });

export const AcpSessionExtensionsSchema = Type.Object(
	{
		version: Type.Literal(1),
		extensions: Type.Array(
			Type.Object(
				{
					id: wireExtensionsText,
					name: wireExtensionsText,
					version: wireExtensionsText,
					description: wireExtensionsText,
					scope: wireExtensionsText,
					state: Type.Union([
						Type.Literal("eligible"),
						Type.Literal("disabled"),
						Type.Literal("invalid"),
						Type.Literal("incompatible"),
						Type.Literal("shadowed"),
					]),
					overriddenBy: Type.Optional(wireExtensionsText),
					runtime: Type.Boolean(),
					problems: wireExtensionsCount,
					diagnostics: Type.Array(wireExtensionsText, { maxItems: 3 }),
				},
				closed,
			),
			{ maxItems: 64 },
		),
		truncated: Type.Boolean(),
	},
	closed,
);

export const AcpExtensionReloadSchema = Type.Union([
	Type.Object(
		{
			status: Type.Literal("committed"),
			generation: wireExtensionsCount,
			changed: Type.Boolean(),
			added: wireExtensionsCount,
			removed: wireExtensionsCount,
			modified: wireExtensionsCount,
			hooks: Type.Object(
				{
					registered: wireExtensionsCount,
					dropped: wireExtensionsCount,
					issues: wireExtensionsCount,
					overridden: wireExtensionsCount,
				},
				closed,
			),
			lines: Type.Array(wireExtensionsText, { maxItems: 40 }),
		},
		closed,
	),
	Type.Object(
		{
			status: Type.Literal("rejected"),
			reason: wireExtensionsText,
			generation: wireExtensionsCount,
			lines: Type.Array(wireExtensionsText, { maxItems: 40 }),
		},
		closed,
	),
]);

export const AcpHubReloadSchema = Type.Union([
	Type.Object(
		{
			status: Type.Literal("refreshed"),
			generation: wireExtensionsCount,
			previousGeneration: wireExtensionsCount,
			changed: Type.Boolean(),
		},
		closed,
	),
	Type.Object({ status: Type.Literal("failed"), error: Type.String({ maxLength: 1100 }) }, closed),
]);

export const AcpCommandDescriptorSchema = wireSteeringCommandDescriptor;
