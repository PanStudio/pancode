// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import {
	describeTaskMemoryActivity,
	eligibleMemoryRecords,
	formatTaskMemorySpend,
	type MemoryAgentIdentity,
	type MemoryPromptSelection,
	type MemoryProposalResult,
	type MemoryRecord,
	type MemoryRepositoryIdentity,
	type MemoryRuntimeIdentity,
	type RecallUseEntry,
	type TaskMemoryActivityEvent,
	type TaskMemoryEntry,
	type TaskMemoryOperatorStatus,
	type TaskMemoryTelemetryDecision,
} from "../domains/memory/index.js";
import type { Component, OverlayHandle, TUI } from "../engine/tui.js";
import { clockLocal, stampLocal } from "./format-time.js";
import {
	memoryBankEntries,
	memoryDeliveryWithheld,
	memoryLessonDetail,
	memoryReach,
	memoryReviewState,
	memoryTaskDetail,
	memoryViewSignature,
} from "./memory-view-model.js";
import { type GrowableBody, showPancodeOverlayFrame } from "./overlay-frame.js";
import { confirmOnceRail } from "./overlays/confirm-once.js";
import { ListOverlayView } from "./overlays/list-overlay.js";
import type { ListOverlayItem } from "./overlays/list-overlay-model.js";
import { chipRow, dotSep, fitUnits, GLYPH, pancodeTheme, rule, statusChip } from "./theme/index.js";
import { skinEpoch } from "./theme/tokens.js";

const DEFAULT_CONTENT_WIDTH = 96;
const REFRESH_MS = 1_000;

export const MEMORY_OVERLAY_WIDTH = DEFAULT_CONTENT_WIDTH + 4;

function firstLine(content: string): string {
	return content.replace(/\s+/gu, " ").trim();
}

function lessonItems(
	records: ReadonlyArray<MemoryRecord>,
	eligible: ReadonlySet<string>,
	group: string,
	selection: MemoryPromptSelection | null,
	memoryOn: boolean,
	recallUse: Readonly<Record<string, RecallUseEntry>>,
	deliveryRefusal: (record: MemoryRecord) => string | null,
): ListOverlayItem[] {
	const theme = pancodeTheme();
	return records.map((record) => {
		const reach = memoryReach(record, eligible.has(record.id));
		const refusal = reach === "prompt" ? deliveryRefusal(record) : null;
		const withheld = reach === "prompt" && memoryDeliveryWithheld(record, selection, refusal) !== null;
		return {
			id: `lesson:${record.id}`,
			label: firstLine(record.lesson),
			// Scope and reach are two chips joined by the shared separator, so a
			// narrow row drops the reach whole instead of cutting it.
			meta: theme.fg(
				"annotation",
				reach !== "none"
					? [
							record.scope === "repo" ? "this repo" : record.scope,
							!memoryOn ? "off" : withheld ? "withheld" : reach === "prompt" ? "prompt" : "recall only",
						]
							.map((part) => theme.fg("annotation", part))
							.join(dotSep(theme))
					: record.rejectedAt
						? "rejected"
						: record.regressions?.length
							? "contradicted"
							: !record.approved
								? "pending"
								: record.scope === "agent"
									? "workers"
									: "excluded",
			),
			group,
			detail: () =>
				memoryLessonDetail(record, eligible.has(record.id), selection, memoryOn, {
					recall: recallUse[record.id],
					refusal,
				}),
		};
	});
}

function bankItems(entries: ReadonlyArray<TaskMemoryEntry>): ListOverlayItem[] {
	const theme = pancodeTheme();
	return entries.map((entry) => ({
		id: `bank:${entry.id}`,
		label: firstLine(entry.content),
		meta: theme.fg("annotation", entry.kind === "status" ? `private ${GLYPH.sep} session only` : "session only"),
		group:
			entry.kind === "status"
				? "Private status"
				: entry.kind === "procedural"
					? "Attempts and outcomes"
					: "Task knowledge",
		detail: () => memoryTaskDetail(entry),
	}));
}

/**
 * The row clock, in the timezone the operator's own clock is in.
 *
 * `event.at` is an ISO-8601 UTC instant, so slicing `HH:MM:SS` out of it
 * printed a UTC clock with no marker saying so: a step captured at 06:18 CDT
 * rendered as 11:18 and read as five hours stale. The detail pane keeps the
 * ISO string, so converting here is what makes the two surfaces agree.
 */
function rowClock(at: string): string {
	return Number.isFinite(Date.parse(at)) ? clockLocal(at) : at;
}

function activityItems(events: ReadonlyArray<TaskMemoryActivityEvent>, group: string): ListOverlayItem[] {
	const theme = pancodeTheme();
	return events.map((event, index) => ({
		id: `step:${index}:${event.at}`,
		label: `${theme.fg("annotation", rowClock(event.at))} ${theme.fg(
			decisionToken(event.decision),
			describeTaskMemoryActivity(event),
		)}`,
		meta: theme.fg("annotation", `${event.tier} ${Math.round(event.latencyMs)}ms`),
		group,
		detail: () => [
			`# ${stampLocal(event.at)}`,
			`**Decision:** ${event.decision} (${event.reason})`,
			`**Triggers:** ${event.triggerReasons.join(", ")}`,
			`**Tier:** ${event.tier}`,
			`**Latency:** ${Math.round(event.latencyMs)}ms`,
			`**Bank writes:** ${event.bankWrites}`,
			`**Cited entries:** ${event.citedEntries}`,
			...(event.resumeAt === undefined ? [] : [`**Resumes:** ${stampLocal(event.resumeAt)}`]),
		],
	}));
}

function decisionToken(decision: TaskMemoryTelemetryDecision): "success" | "warning" | "annotation" {
	if (decision === "injected") return "success";
	return decision === "silent" ? "annotation" : "warning";
}

export type MemoryReviewAction = "approve" | "reject";

interface MemoryOverlayActions {
	activeRepository?: () => MemoryRepositoryIdentity | null;
	activeRuntime?: () => MemoryRuntimeIdentity | null;
	activeAgent?: () => MemoryAgentIdentity | null;
	/** Per-record recall and use, from the recall ledger the observer writes as each turn settles. */
	recallUse?: () => Readonly<Record<string, RecallUseEntry>>;
	/** Why this checkout's delivery check withholds a lesson from the prompt and reminders, or null when it passes. */
	deliveryRefusal?: (record: MemoryRecord) => string | null;
	onPromote?: (entry: TaskMemoryEntry, scope: "repo" | "global") => Promise<MemoryProposalResult>;
	onReview?: (record: MemoryRecord, action: MemoryReviewAction) => Promise<MemoryRecord>;
	getTerminalRows?: () => number;
}

interface OpenMemoryOverlayOptions extends MemoryOverlayActions {
	onClose?: () => void;
}

/** Master-detail memory view: status header, grouped list, scrollable detail pane. */
export class MemoryOverlayView implements Component, GrowableBody {
	private readonly list: ListOverlayView;
	private signature: string | null = null;
	private renderMemo: { width: number; status: string; listLines: string[]; lines: string[] } | null = null;
	private pendingGlobalEntryId: string | null = null;
	/** The record a first `x` asked about; a second `x` on it rejects, any other key keeps it. */
	private armedReject: string | null = null;
	private promotionMessage: { token: "activity" | "warning" | "success" | "error"; text: string } | null = null;
	private promotionInFlight = false;
	private rows: Record<string, ListOverlayItem[]> = { lessons: [], task: [], review: [], diagnostics: [] };
	private currentRepository: MemoryRepositoryIdentity | null = null;

	constructor(
		private readonly getStatus: () => TaskMemoryOperatorStatus,
		private readonly getRecords: () => ReadonlyArray<MemoryRecord>,
		onClose: () => void,
		onChange: () => void,
		private readonly handlers: MemoryOverlayActions = {},
	) {
		const actions: Record<string, (item: ListOverlayItem) => void> = {};
		if (handlers.onPromote) {
			actions.p = (item) => this.promote(item, "repo", onChange);
			actions.g = (item) => this.promote(item, "global", onChange);
		}
		if (handlers.onReview) {
			actions.a = (item) => this.review(item, "approve", onChange);
			actions.x = (item) => {
				const record = this.selectedRecord(item);
				if (record === null) return;
				if (this.armedReject !== record.id) {
					this.armedReject = record.id;
					onChange();
					return;
				}
				this.armedReject = null;
				this.review(item, "reject", onChange);
			};
		}
		this.list = new ListOverlayView(
			{
				title: "Memory",
				items: [],
				filterable: true,
				explicitSearch: true,
				layout: "split",
				tabs: [
					{ id: "lessons", label: "Lessons", items: () => this.rows.lessons ?? [] },
					{ id: "task", label: "This task", items: () => this.rows.task ?? [] },
					{ id: "review", label: "Review", items: () => this.rows.review ?? [] },
					{ id: "diagnostics", label: "Diagnostics", items: () => this.rows.diagnostics ?? [] },
				],
				emptyMessage: () => this.emptyMessage(),
				...(Object.keys(actions).length > 0 ? { hints: (item) => this.hintsFor(item), actions } : {}),
				onClose,
			},
			onChange,
		);
	}

	getHint(innerWidth?: number): string {
		this.sync();
		return this.list.getHint(innerWidth);
	}

	/** The dock's rows, less the status line, the optional promotion line and the rule this view draws above the list. */
	setBodyRows(rows: number): void {
		this.list.setBodyRows(Math.max(1, rows - 2 - (this.promotionMessage === null ? 0 : 1)));
	}

	setRailRoom(cells: number): void {
		this.list.setRailRoom(cells);
	}

	/** Keep 96x39 compact inside `dockBodyRows`; expand detail on tall terminals (96x79) via `dockGrowthRows`. */
	wantsGrowth(): boolean {
		return (this.handlers.getTerminalRows?.() ?? 24) >= 48;
	}

	render(width: number): string[] {
		const status = this.sync();
		const theme = pancodeTheme();
		// Without a repository identity only lessons kept for every project apply, and the header says so.
		const scope = this.currentRepository
			? "lessons for this project"
			: "no project folder here, so only lessons kept for every project apply";
		// The facts an operator checks before reading a lesson: where it applies,
		// whether the background step runs, what it holds and what it is doing.
		const working = status.stepInFlight ? "step running" : (status.guardian ?? null);
		const statusLine = chipRow(
			theme,
			[
				theme.fg("annotation", scope),
				statusChip(theme, status.enabled ? "ok" : "cancelled", `background ${status.enabled ? "on" : "off"}`),
				theme.fg("counter", `${status.size} ${status.size === 1 ? "entry" : "entries"}`),
				working === null || working === "off" || working === "idle"
					? null
					: theme.fg(working === "reviewing" || working === "step running" ? "activity" : "warning", working),
			],
			width,
		);
		const promotionLine =
			this.promotionMessage === null
				? null
				: fitUnits(pancodeTheme(), "", [pancodeTheme().fg(this.promotionMessage.token, this.promotionMessage.text)], width);
		const statusKey = [statusLine, promotionLine].filter((line) => line !== null).join("\n");
		const listLines = this.list.render(width);
		const memo = this.renderMemo;
		if (memo && memo.width === width && memo.status === statusKey && memo.listLines === listLines) return memo.lines;
		const lines = [
			statusLine,
			...(promotionLine === null ? [] : [promotionLine]),
			rule(pancodeTheme(), width),
			...listLines,
		];
		this.renderMemo = { width, status: statusKey, listLines, lines };
		return lines;
	}

	handleInput(data: string): void {
		// A key that lands between the refresh and the repaint must act on the rows
		// the operator is looking at, so the sync happens before the routing.
		this.sync();
		if (data !== "x") this.armedReject = null;
		this.list.handleInput(data);
	}

	invalidate(): void {
		this.renderMemo = null;
		this.list.invalidate();
	}

	private emptyMessage(): string {
		switch (this.list.activeTab()?.id) {
			case "task":
				return "Nothing recorded for the current task yet. PanCode keeps task notes here as it works; they stay in this session.";
			case "review":
				return "Nothing waits for review. Lessons PanCode proposes, and ones it set aside, appear here.";
			case "diagnostics":
				return "No memory diagnostics captured.";
			default:
				return this.getStatus().enabled
					? "No saved lessons apply here yet. PanCode proposes lessons from what worked or failed in earlier tasks, and they wait under Review until they are approved or kept. Opening this view changes nothing."
					: "Background memory is off, so PanCode saves no lessons. /settings, Context and memory, turns it on.";
		}
	}

	private sync(): TaskMemoryOperatorStatus {
		const status = this.getStatus();
		const records = this.getRecords();
		const activeRepository = this.handlers.activeRepository?.() ?? null;
		const activeRuntime = this.handlers.activeRuntime?.() ?? null;
		const activeAgent = this.handlers.activeAgent?.() ?? null;
		// The same gates memory_recall applies; the prompt narrows them to its own scopes.
		const eligibility = { activeRepository, activeRuntime, activeAgent };
		const recallUse = this.handlers.recallUse?.() ?? {};
		const refusal = this.handlers.deliveryRefusal ?? (() => null);
		const signature = `${skinEpoch()}|${memoryViewSignature(status, records, eligibility)}|${JSON.stringify(recallUse)}`;
		if (signature !== this.signature) {
			this.signature = signature;
			this.currentRepository = activeRepository;
			const eligible = eligibleMemoryRecords(records, eligibility).filter((record) => record.rejectedAt === undefined);
			const ids = new Set(eligible.map((record) => record.id));
			const review = records.filter((record) => !ids.has(record.id));
			this.rows = {
				lessons: lessonItems(
					eligible,
					ids,
					"Reusable lessons",
					status.promptSelection ?? null,
					status.enabled,
					recallUse,
					refusal,
				),
				task: bankItems(memoryBankEntries(status.bank)),
				review: lessonItems(
					review,
					ids,
					"Candidates and excluded lessons",
					status.promptSelection ?? null,
					status.enabled,
					recallUse,
					refusal,
				),
				diagnostics: this.diagnosticItems(status),
			};
			this.list.refreshTabs();
		}
		return status;
	}

	private diagnosticItems(status: TaskMemoryOperatorStatus): ListOverlayItem[] {
		const row = (id: string, label: string, detail: string[]): ListOverlayItem => ({
			id: `diagnostic:${id}`,
			label,
			group: "Background operation",
			detail: () => detail,
		});
		const observations = status.observations;
		const spend = status.spend;
		const retention = status.retention;
		return [
			row(
				"route",
				`Background memory ${status.enabled ? "on" : "off"} ${GLYPH.sep} ${status.stepInFlight ? "step running" : (status.guardian ?? "idle")}`,
				[
					"## Background memory",
					`Enabled: ${status.enabled ? "yes" : "no"}`,
					`Tier: ${status.tier}`,
					`Guardian: ${status.guardian ?? "not recorded"}`,
					`Last decision: ${status.lastDecision ?? "none"}`,
					...(status.route
						? [
								`Route: ${status.route.target ?? "unset"}/${status.route.model ?? "unset"}`,
								`Route source: ${status.route.source}`,
							]
						: []),
					...(status.lastSkip
						? [`Skipped: ${status.lastSkip.reason}`, `Resumes: ${status.lastSkip.resumeAt ?? "on a later wake"}`]
						: []),
					"",
					"This view inspects existing behavior. It does not activate memory or certify that a reminder affected a task.",
				],
			),
			...(retention
				? [
						row(
							"retention",
							`Saving lessons: ${retention.phase}${retention.reason ? ` ${GLYPH.sep} ${retention.reason}` : ""}`,
							[
								"## Lesson retention",
								`Phase: ${retention.phase}`,
								`Reason: ${retention.reason ?? "none"}`,
								`Extracted candidates: ${retention.extracted}`,
								`Retained entries: ${retention.retained.length}`,
								`Extraction attempts: ${retention.attempts}`,
								...retention.retained.map((record) => `- [${record.id}] ${record.text}`),
							],
						),
					]
				: []),
			...(observations
				? [
						row(
							"observations",
							`Notes for compaction: ${observations.enabled ? "on" : "off"}${observations.lastReason ? ` ${GLYPH.sep} ${observations.lastReason}` : ""}`,
							[
								"## Continuity preparation",
								"Prepared observations help the existing compactor. They are separate from reusable lessons.",
								`Unobserved units: ${observations.unobserved}`,
								`Ready batches: ${observations.ready}`,
								`Offered batches: ${observations.offered}`,
								`Consumed batches: ${observations.consumed}`,
								`Source tokens: ${observations.sourceTokens}`,
								`Note tokens: ${observations.noteTokens}`,
								`Reflection: ${observations.reflection}`,
								`Last reason: ${observations.lastReason ?? "none"}`,
								`Last committed checkpoint: ${observations.lastCommit ?? "none"}`,
							],
						),
					]
				: []),
			...(spend
				? [
						row(
							"spend",
							spend.llmSteps === 0 ? "Memory model use: none yet" : `Memory model use: ${formatTaskMemorySpend(spend)}`,
							[
								"## Retained telemetry",
								formatTaskMemorySpend(spend),
								"Reminder counts measure recorded delivery, not causal usefulness.",
							],
						),
					]
				: []),
			...activityItems(status.activity, "Recent memory steps"),
		];
	}

	/** Only the keys the selected row answers to, so a lesson row never advertises promotion. */
	private hintsFor(item: ListOverlayItem | undefined): ReadonlyArray<{ key: string; verb: string }> {
		if (item === undefined) return [];
		if (this.selectedBankEntry(item) !== null && this.handlers.onPromote) {
			return [
				{ key: "p", verb: "propose repo" },
				{ key: "g", verb: "propose global" },
			];
		}
		const record = this.handlers.onReview ? this.selectedRecord(item) : null;
		if (record === null) return [];
		if (this.armedReject === record.id) return confirmOnceRail("x", "reject", record.id);
		const state = memoryReviewState(record);
		return [
			...(state === "approved" ? [] : [{ key: "a", verb: "approve" }]),
			...(state === "rejected" ? [] : [{ key: "x", verb: "reject" }]),
		];
	}

	private review(item: ListOverlayItem, action: MemoryReviewAction, onChange: () => void): void {
		const onReview = this.handlers.onReview;
		if (onReview === undefined || this.promotionInFlight) return;
		this.pendingGlobalEntryId = null;
		const record = this.selectedRecord(item);
		const state = record === null ? null : memoryReviewState(record);
		if (record === null || state === (action === "approve" ? "approved" : "rejected")) {
			this.promotionMessage = {
				token: "warning",
				text:
					record === null
						? "select a durable memory record"
						: `${record.id} is already ${action === "approve" ? "approved" : "rejected"}`,
			};
			this.invalidate();
			onChange();
			return;
		}
		this.promotionInFlight = true;
		this.promotionMessage = {
			token: "activity",
			text: `${action === "approve" ? "approving" : "rejecting"} ${record.id}`,
		};
		this.invalidate();
		onChange();
		void onReview(record, action)
			.then((updated) => {
				this.promotionMessage = {
					token: "success",
					text: `${action === "approve" ? "approved" : "rejected"} ${updated.id}`,
				};
			})
			.catch((error: unknown) => {
				this.promotionMessage = {
					token: "error",
					text: `${action} failed: ${error instanceof Error ? error.message : String(error)}`,
				};
			})
			.finally(() => {
				this.promotionInFlight = false;
				this.invalidate();
				onChange();
			});
	}

	private selectedRecord(item: ListOverlayItem): MemoryRecord | null {
		if (!item.id.startsWith("lesson:")) return null;
		const recordId = item.id.slice("lesson:".length);
		return this.getRecords().find((record) => record.id === recordId) ?? null;
	}

	private promote(item: ListOverlayItem, scope: "repo" | "global", onChange: () => void): void {
		const onPromote = this.handlers.onPromote;
		if (onPromote === undefined || this.promotionInFlight) return;
		const entry = this.selectedBankEntry(item);
		if (entry === null) {
			this.pendingGlobalEntryId = null;
			this.promotionMessage = { token: "warning", text: "select a knowledge or procedural task-bank entry" };
			this.invalidate();
			onChange();
			return;
		}
		if (scope === "global" && this.pendingGlobalEntryId !== entry.id) {
			this.pendingGlobalEntryId = entry.id;
			this.promotionMessage = {
				token: "warning",
				text: `global scope broadens applicability for ${entry.id}; press g again to acknowledge`,
			};
			this.invalidate();
			onChange();
			return;
		}
		this.pendingGlobalEntryId = null;
		this.promotionInFlight = true;
		this.promotionMessage = { token: "activity", text: `proposing ${entry.id} with ${scope} scope` };
		this.invalidate();
		onChange();
		void onPromote(entry, scope)
			.then((result) => {
				const approval = this.handlers.onReview
					? "review it in the Review tab, then press a to approve"
					: `review, then run pancode memory approve ${result.record.id}`;
				this.promotionMessage = {
					token: "success",
					text: `${result.created ? "proposed" : "found existing"} ${result.record.id}; ${approval}`,
				};
			})
			.catch((error: unknown) => {
				this.promotionMessage = {
					token: "error",
					text: `promotion failed: ${error instanceof Error ? error.message : String(error)}`,
				};
			})
			.finally(() => {
				this.promotionInFlight = false;
				this.invalidate();
				onChange();
			});
	}

	private selectedBankEntry(item: ListOverlayItem): TaskMemoryEntry | null {
		if (!item.id.startsWith("bank:")) return null;
		const entryId = item.id.slice("bank:".length);
		const entry = memoryBankEntries(this.getStatus().bank).find((candidate) => candidate.id === entryId);
		if (entry === undefined || entry.kind === "status") return null;
		return entry;
	}
}

/** Mount durable lessons and the live task bank with promotion and review actions. */
export function openMemoryOverlay(
	tui: TUI,
	getStatus: () => TaskMemoryOperatorStatus,
	getRecords: () => ReadonlyArray<MemoryRecord>,
	options: OpenMemoryOverlayOptions = {},
): OverlayHandle {
	const view = new MemoryOverlayView(
		getStatus,
		getRecords,
		() => options.onClose?.(),
		() => tui.requestRender(),
		{
			...(options.activeRepository ? { activeRepository: options.activeRepository } : {}),
			...(options.activeRuntime ? { activeRuntime: options.activeRuntime } : {}),
			...(options.activeAgent ? { activeAgent: options.activeAgent } : {}),
			...(options.onPromote ? { onPromote: options.onPromote } : {}),
			...(options.onReview ? { onReview: options.onReview } : {}),
			...(options.recallUse ? { recallUse: options.recallUse } : {}),
			...(options.deliveryRefusal ? { deliveryRefusal: options.deliveryRefusal } : {}),
			getTerminalRows: () => tui.terminal?.rows ?? 24,
		},
	);
	const handle = showPancodeOverlayFrame(tui, view, {
		anchor: "center",
		width: MEMORY_OVERLAY_WIDTH,
		markerId: "memory",
		title: () => `Memory ${GLYPH.sep} inspection`,
		footerHint: (innerWidth) => view.getHint(innerWidth),
	});
	const timer = setInterval(() => tui.requestRender(), REFRESH_MS);
	timer.unref?.();
	return {
		...handle,
		hide(): void {
			clearInterval(timer);
			handle.hide();
		},
	};
}
