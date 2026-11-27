// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { tierPolicy, tierRevision } from "../core/presentation-tier.js";
import { type Component, visibleWidth } from "../engine/tui.js";
import type { ApprovalRequestView } from "../session-control/approval-request-view.js";
import { CARD_CALLOUT_MAX_WIDTH } from "./card.js";
import { planDetailText } from "./dispatch-plan-summary.js";
import { MUTATION_PREVIEW_VISIBLE_ROWS, type MutationInspector, type MutationPreview } from "./mutation-preview.js";
import { fitRow, pageStep, type RowBudgetedBody, windowRows } from "./overlay-frame.js";
import type { PermissionCardParts } from "./permission-card-rows.js";
import {
	ARTIFACT_TITLES,
	CARD_FACT_ROWS,
	cardTargetRows,
	identityRow,
	markContinued,
	permissionCardParts,
	pinEffect,
	planTextRows,
} from "./permission-card-rows.js";
import {
	MUTATION_PREVIEW_KEY,
	PERMISSION_STOP_KEY,
	PERMISSION_TERMS_KEY,
	permissionKeyLabel,
} from "./permission-hint.js";
import { inspectionWindowRows, permissionInspectionLines, permissionTermsRows } from "./permission-inspection.js";
import type { CardCountdown, PermissionCountdown, WorkerWindowCountdown } from "./permission-overlay-model.js";
import {
	compactCountdownClause,
	isWorkerWindow,
	permissionDecisionPresentation,
	railClock,
	railClocks,
} from "./permission-overlay-model.js";
import { renderToolArguments } from "./renderers/tool-arguments.js";
import { factRows, GLYPH, pancodeTheme, positionRow, rule, sectionRule } from "./theme/index.js";
import { skinEpoch } from "./theme/tokens.js";

export { type AskAxis, askAxis } from "../domains/safety/approval-axis.js";
export { describeCallTarget, sanitizeCallTargetText } from "../domains/safety/call-target.js";
export type { ApprovalRequestView } from "../session-control/approval-request-view.js";
export {
	MUTATION_PREVIEW_KEY,
	PERMISSION_TERMS_KEY,
	type PermissionInspectionHint,
	type PermissionTermsHint,
	permissionHintEntries,
} from "./permission-hint.js";

/** A boxed frame for the card: the card's own columns plus the frame's borders and padding. */
export const PERMISSION_OVERLAY_WIDTH = CARD_CALLOUT_MAX_WIDTH + 4;

/** The composer's gutter left of a docked card (`DOCK_GUTTER`), which the callout width counts. */
const DOCK_INDENT = 2;

/**
 * A late-arriving advisory line for the card, read once per frame.
 *
 * It is a getter rather than a field on the view because the dialog opens the
 * instant the call parks and the advisory is answered over the network after
 * that. Nothing waits for it: the card renders without the line, and the line
 * appears at the next frame if an answer ever arrives.
 */
export type PermissionAdvisoryReader = () => string;

export type PermissionCountdownReader = () => PermissionCountdown;
export type WorkerWindowReader = () => WorkerWindowCountdown | null;

/** Whether the composer holds a draft, read once per frame: Enter is inert while it does (#186). */
export type PermissionDraftReader = () => boolean;

/** Whether a main-agent turn is running, read once per frame: a worker card's stop ends one only if it is. */
export type PermissionMainTurnReader = () => boolean;

/** Whether the card opened too recently for Enter to answer it, read once per frame. */
export type PermissionSettlingReader = () => boolean;

export interface PermissionOverlayBodyHandle extends Component, RowBudgetedBody {
	/** Whether this card has a mutation the operator can read locally. */
	canInspect(): boolean;
	isInspecting(): boolean;
	toggleInspect(): void;
	scrollInspect(delta: number): void;
	/** The standing approval terms, folded behind the terms key (see `permissionTermsRows`). */
	isShowingTerms(): boolean;
	toggleTerms(): void;
	/**
	 * Whether the rows that name allow, deny and stop with their consequences
	 * are on screen, so the rail can carry only the keys they do not.
	 */
	isShowingChoices(): boolean;
	/**
	 * Whether those rows also name the terms and inspect keys, which a narrow
	 * card folds in beside the answers because its rail has no room for them.
	 */
	isShowingReadingKeys(): boolean;
	/** Whether the card view is up and its choice rows are scrolled out of view, so Enter and the session grant do nothing. */
	choicesOutOfView(): boolean;
	/** Whether the card, inspection closed, is taller than its rows and windows itself. */
	isCardScrollable(): boolean;
	/** Move that window; false when the card fits and the key is not the card's. */
	scrollCard(delta: number): boolean;
}

/**
 * The overlay body, plus the inspection state the key router drives. The
 * preview is built on the first toggle rather than per frame, so the file read
 * and the diff happen once when the operator asks for them. The rows are
 * memoized on everything that shapes them, so a card that waits on the
 * operator costs the frame one key comparison per render.
 */
class PermissionOverlayBody implements PermissionOverlayBodyHandle {
	private preview: MutationPreview | null = null;
	private scroll = 0;
	private lastLineCount = 0;
	private lastVisibleRows = MUTATION_PREVIEW_VISIBLE_ROWS;
	private terms = false;
	private argumentsOpen = false;
	private bodyRows = 0;
	private cardScroll = 0;
	private cardMaxScroll = 0;
	/** Rows the card's window last showed, which is how far a page key moves it. */
	private cardPageRows = 1;
	private termsScroll = 0;
	private termsMaxScroll = 0;
	private termsPageRows = 1;
	private choicesShown = false;
	private readingFolded = false;
	private memo: { key: string; lines: string[] } | null = null;

	constructor(
		private readonly view: ApprovalRequestView,
		private readonly inspect?: MutationInspector,
		private readonly invocation?: () => unknown,
		private readonly advisory?: PermissionAdvisoryReader,
		private readonly countdown?: PermissionCountdownReader,
		private readonly draft?: PermissionDraftReader,
		private readonly mainTurn?: PermissionMainTurnReader,
		private readonly workerWindow?: WorkerWindowReader,
		private readonly settling?: PermissionSettlingReader,
	) {}

	canInspect(): boolean {
		return this.inspect !== undefined || this.invocation !== undefined;
	}

	isInspecting(): boolean {
		return this.preview !== null || this.argumentsOpen;
	}

	toggleInspect(): void {
		if (this.inspect === undefined) {
			if (this.invocation !== undefined) this.argumentsOpen = !this.argumentsOpen;
			this.scroll = 0;
			return;
		}
		if (this.preview !== null) {
			this.preview = null;
			this.scroll = 0;
			return;
		}
		this.preview = this.inspect();
		this.scroll = 0;
	}

	scrollInspect(delta: number): void {
		if (!this.isInspecting()) return;
		const maxScroll = Math.max(0, this.lastLineCount - this.lastVisibleRows);
		this.scroll = Math.max(0, Math.min(this.scroll + pageStep(delta, this.lastVisibleRows), maxScroll));
	}

	isShowingTerms(): boolean {
		return this.terms;
	}

	toggleTerms(): void {
		this.terms = !this.terms;
		this.termsScroll = 0;
	}

	setBodyRows(rows: number): void {
		this.bodyRows = Math.max(0, Math.floor(rows));
	}

	isShowingChoices(): boolean {
		return this.choicesShown;
	}

	isShowingReadingKeys(): boolean {
		return this.choicesShown && this.readingFolded;
	}

	choicesOutOfView(): boolean {
		return !this.terms && !this.isInspecting() && !this.choicesShown;
	}

	isCardScrollable(): boolean {
		if (this.isInspecting()) return false;
		return this.terms ? this.termsMaxScroll > 0 : this.cardMaxScroll > 0;
	}

	scrollCard(delta: number): boolean {
		if (!this.isCardScrollable()) return false;
		if (this.terms) {
			this.termsScroll = Math.max(
				0,
				Math.min(this.termsScroll + pageStep(delta, this.termsPageRows), this.termsMaxScroll),
			);
			return true;
		}
		this.cardScroll = Math.max(0, Math.min(this.cardScroll + pageStep(delta, this.cardPageRows), this.cardMaxScroll));
		return true;
	}

	render(width: number): string[] {
		const advisory = this.readAdvisory();
		const countdownMs = this.readCountdown();
		const hasDraft = this.readDraft();
		const mainTurn = this.readMainTurn();
		const settling = this.readSettling();
		// The top rule reads the same deadline this frame draws, so the two never disagree.
		railClocks.set(this.view, railClock(countdownMs));
		// The countdown is keyed by the second it displays, so a card with a
		// window redraws once a second and a card without one never redraws
		// for it.
		const key = [
			width,
			this.bodyRows,
			this.terms,
			this.argumentsOpen,
			this.preview === null ? 0 : 1,
			this.scroll,
			this.cardScroll,
			this.termsScroll,
			advisory,
			typeof countdownMs === "number"
				? Math.ceil(countdownMs / 1000)
				: isWorkerWindow(countdownMs)
					? `${Math.ceil(countdownMs.remainingMs / 1000)}:${countdownMs.held}`
					: (countdownMs ?? ""),
			hasDraft,
			mainTurn,
			settling,
			permissionKeyLabel(PERMISSION_STOP_KEY),
			skinEpoch(),
			// A held card redraws at the new tier on the next frame (3.1).
			tierRevision(),
		].join("|");
		if (this.memo?.key === key) return this.memo.lines;
		this.choicesShown = false;
		const lines = this.renderFresh(width, advisory, countdownMs, hasDraft, mainTurn, settling);
		this.memo = { key, lines };
		return lines;
	}

	private renderFresh(
		width: number,
		advisory: string,
		countdownMs: CardCountdown,
		hasDraft: boolean,
		mainTurn: boolean | undefined,
		settling = false,
	): string[] {
		if (this.argumentsOpen && this.invocation) {
			const theme = pancodeTheme();
			const content = Math.max(8, Math.floor(width));
			const rows = renderToolArguments(
				this.invocation(),
				content,
				false,
				Number.POSITIVE_INFINITY,
				false,
				this.view.tool === "bash" ? "shell" : undefined,
			);
			this.lastLineCount = rows.length;
			// The sealed plan text is what an approval covers, field for field; it leads the details the card summarizes,
			// a dispatch plan's durations in configured units.
			const artifact = this.view.artifact;
			if (artifact !== undefined) {
				rows.unshift(
					sectionRule(theme, content, ARTIFACT_TITLES[artifact.kind]),
					...planTextRows(artifact.kind === "dispatch-plan" ? planDetailText(artifact.text) : artifact.text, content),
					sectionRule(theme, content, "Exact invocation"),
				);
				this.lastLineCount = rows.length;
			}
			const identity = identityRow(theme, this.view, permissionDecisionPresentation(this.view), content);
			const head = [
				...identity.rows,
				...(identity.ruleFact === null ? [] : factRows(theme, [identity.ruleFact], content, CARD_FACT_ROWS)),
				sectionRule(theme, content, artifact !== undefined ? "Details" : "Exact invocation", {
					meta: `Esc or ${permissionKeyLabel(MUTATION_PREVIEW_KEY)} hides`,
				}),
			];
			this.lastVisibleRows = inspectionWindowRows(this.bodyRows, head.length);
			const pane = windowRows(rows, this.scroll, this.lastVisibleRows);
			this.scroll = pane.start;
			return [
				...head,
				...pane.window,
				...(pane.position === null
					? []
					: [positionRow(theme, { ...pane.position, keys: [`${GLYPH.upDown} scroll`] }, content)]),
			];
		}
		// The card's sentences read as a callout: counted with the dock's 2-cell indent, no sentence row ends past column
		// 88 on a wide terminal. Its facts, the exact call and its rules take the dock's width, so a path on a wide
		// terminal is not cut where the sentences stop. The inspection above keeps every column.
		const card = Math.min(width, CARD_CALLOUT_MAX_WIDTH - DOCK_INDENT);
		if (this.preview === null && this.terms) return this.renderTerms(width, card, countdownMs);
		if (this.preview === null) {
			const parts = permissionCardParts(
				this.view,
				width,
				card,
				advisory,
				countdownMs,
				hasDraft,
				mainTurn,
				this.canInspect(),
				settling,
			);
			this.readingFolded = parts.readingFolded;
			return this.layoutCard(parts, width);
		}
		const rendered = permissionInspectionLines(this.view, this.preview, width, this.scroll, this.bodyRows);
		this.lastLineCount = rendered.wrappedLineCount;
		this.lastVisibleRows = rendered.visibleRows;
		return rendered.lines;
	}

	/**
	 * The card in the rows the frame has, decisions first (7.4). The identity, the effect, the scope, every choice with
	 * its consequence and the timer are pinned; everything else is one window between the scope and the choices, with a
	 * position row directly above the choices when it is cut. When that does not fit it shrinks in order and stops as
	 * soon as it fits: the window to one row, the effect to one row ending `… N more rows`, the choices to their compact
	 * form, the timer into the position row. Past that the card is in reading form: the identity and one effect row are
	 * pinned and everything else, choices included, is one window, and Enter does nothing until the choices are on
	 * screen. With no known budget the card renders whole.
	 */
	private layoutCard(parts: PermissionCardParts, width: number): string[] {
		const theme = pancodeTheme();
		const budget = this.bodyRows;
		const preview = Math.max(1, tierPolicy().decisionPreviewRows);
		const { identity, scope, window: rest, choices, compactChoices, timer, timerClause } = parts;
		const settled = (rows: string[]): string[] => {
			this.cardMaxScroll = 0;
			this.cardScroll = 0;
			this.choicesShown = true;
			return rows;
		};
		const position = (start: number, end: number, total: number, inline: boolean): string =>
			inline || timerClause === null
				? positionRow(theme, { start, end, total, keys: [`${GLYPH.upDown} scroll`] }, width)
				: this.timedPosition(timerClause, start, end, total, width);
		const effect = pinEffect(theme, parts.effect, preview, width);
		const head = [...identity, ...effect.pinned, ...scope];
		const body = [...effect.overflow, ...rest];
		const divider = body.length > 0 ? [rule(theme, width)] : [];
		if (budget <= 0 || head.length + body.length + divider.length + choices.length + timer.length <= budget) {
			return settled([...head, ...body, ...divider, ...choices, ...timer]);
		}
		if (head.length + body.length + choices.length + timer.length <= budget) {
			return settled([...head, ...body, ...choices, ...timer]);
		}
		const stages = [
			{ effect: preview, compact: false, inline: true },
			{ effect: 1, compact: false, inline: true },
			{ effect: 1, compact: true, inline: true },
			{ effect: 1, compact: true, inline: timerClause === null },
		];
		for (const stage of stages) {
			const pinned = pinEffect(theme, parts.effect, stage.effect, width);
			const top = [...identity, ...pinned.pinned, ...scope];
			const answer = stage.compact ? [...compactChoices, ...parts.readingRows] : choices;
			const sentence = stage.inline ? timer : [];
			const all = [...pinned.overflow, ...rest];
			const room = budget - top.length - answer.length - sentence.length;
			// A window that fits whole needs no position row.
			if (all.length <= room) return settled([...top, ...all, ...answer, ...sentence]);
			const height = room - 1;
			if (height < 1) continue;
			this.cardMaxScroll = all.length - height;
			this.cardPageRows = height;
			this.cardScroll = Math.min(this.cardScroll, this.cardMaxScroll);
			const end = this.cardScroll + height;
			this.choicesShown = true;
			return [
				...top,
				...all.slice(this.cardScroll, end),
				position(this.cardScroll + 1, end, all.length, stage.inline),
				...answer,
				...sentence,
			];
		}
		// Reading form: the call stays named, and the choices are read in the window before Enter can answer.
		const one = pinEffect(theme, parts.effect, 1, width);
		const top = [...identity, ...one.pinned].slice(0, Math.max(1, budget));
		// The reading keys come before the choices here, so the choices close the window and fit it whole sooner.
		const all = [
			...scope,
			...one.overflow,
			...rest,
			...parts.readingRows,
			...compactChoices,
			...(timerClause === null ? timer : []),
		];
		const positioned = budget >= top.length + 2;
		const height = Math.max(0, budget - top.length - (positioned ? 1 : 0));
		this.cardMaxScroll = height > 0 ? Math.max(0, all.length - height) : 0;
		this.cardPageRows = height;
		this.cardScroll = Math.min(this.cardScroll, this.cardMaxScroll);
		const end = Math.min(all.length, this.cardScroll + height);
		const choicesFrom = scope.length + one.overflow.length + rest.length + parts.readingRows.length;
		this.choicesShown = height > 0 && choicesFrom >= this.cardScroll && choicesFrom + compactChoices.length <= end;
		return [
			...top,
			...all.slice(this.cardScroll, end),
			...(positioned ? [position(this.cardScroll + 1, end, all.length, false)] : []),
		];
	}

	/**
	 * The terms as a layer of their own, the way the inspection is: the call's
	 * name stays on top, the terms take every row below it, and the rail carries
	 * the answer keys while they are open. Folded into the card they shared its
	 * window with the facts and the choices, and at 40x15 the window had no row
	 * left for a single sentence of them.
	 */
	private renderTerms(width: number, prose: number, countdown: CardCountdown): string[] {
		const theme = pancodeTheme();
		const content = Math.max(8, Math.floor(width));
		// As on the card: the call, its rule and the position row take the dock's width, the terms stop at the callout.
		const callout = Math.max(8, Math.min(content, Math.floor(prose)));
		const identity = identityRow(theme, this.view, permissionDecisionPresentation(this.view), content);
		// The call stays named beside the answer keys while the terms are read: two rows of it at most,
		// marked when cut, so the terms keep the rest of the rows.
		const target = cardTargetRows(theme, this.view, content);
		const targetRows = target.slice(0, 2);
		const lastTarget = targetRows.at(-1);
		if (lastTarget !== undefined && target.length > targetRows.length) {
			targetRows[targetRows.length - 1] = markContinued(lastTarget, content);
		}
		const head = [
			...identity.rows,
			...targetRows,
			sectionRule(theme, content, "Terms", { meta: `Esc or ${permissionKeyLabel(PERMISSION_TERMS_KEY)} hides` }),
		];
		const rows = permissionTermsRows(theme, this.view, callout);
		const clause = compactCountdownClause(this.view, countdown);
		this.choicesShown = false;
		this.cardMaxScroll = 0;
		const budget = this.bodyRows;
		const visible = budget <= 0 ? rows.length : Math.max(1, budget - head.length - 1);
		const pane = windowRows(rows, this.termsScroll, visible);
		this.termsPageRows = visible;
		this.termsScroll = pane.start;
		this.termsMaxScroll = pane.maxScroll;
		const end = pane.start + pane.window.length;
		const footer =
			pane.position === null
				? clause === null
					? []
					: [
							fitRow(
								theme.fg(clause.tone, `${clause.outcome}${clause.holds.length > 0 ? ` ${GLYPH.sep} ${clause.holds}` : ""}`),
								content,
							),
						]
				: clause === null
					? [positionRow(theme, { ...pane.position, keys: [`${GLYPH.upDown} scroll`] }, content)]
					: [this.timedPosition(clause, pane.start + 1, end, rows.length, content)];
		return [...head, ...pane.window, ...footer];
	}

	/**
	 * The position row on a short card with a live timer. It carries the time and
	 * what running out does, because the sentence that says so at length has moved
	 * into the window and the card denies itself whether or not anyone scrolls.
	 */
	private timedPosition(
		clause: NonNullable<ReturnType<typeof compactCountdownClause>>,
		start: number,
		end: number,
		total: number,
		width: number,
	): string {
		const theme = pancodeTheme();
		const holds = clause.holds.length > 0 ? ` ${GLYPH.sep} ${clause.holds}` : "";
		// `1–1/14` read as a fraction; the short forms keep the words `of` and `rows`, the way every position row says it.
		const range = start === end ? `${start}` : `${start}${GLYPH.range}${end}`;
		const sep = ` ${GLYPH.sep} `;
		const arrows = GLYPH.upDown;
		const candidates = [
			`${clause.outcome}${holds}${sep}${range} of ${total} rows${sep}${arrows} scroll`,
			`${clause.outcome}${sep}${range} of ${total} rows${sep}${arrows} scroll`,
			// A 40-column rail keeps only the answer keys, so the arrows stay on this row as long as any form fits.
			`${clause.outcome}${sep}${range} of ${total} rows${sep}${arrows}`,
			`${clause.outcome}${sep}${range} of ${total}${sep}${arrows}`,
			`${clause.outcome}${sep}${range} of ${total}`,
		];
		const text = candidates.find((candidate) => visibleWidth(candidate) <= width) ?? candidates.at(-1) ?? "";
		const timer = text.startsWith(`${clause.outcome}${holds}`) ? `${clause.outcome}${holds}` : clause.outcome;
		return fitRow(`${theme.fg(clause.tone, timer)}${theme.fg("annotation", text.slice(timer.length))}`, width);
	}

	/**
	 * A throwing or absent advisory reader is simply no advisory. This runs on
	 * every frame of a dialog the operator is answering, so it cannot be a place
	 * where anything fails loudly.
	 */
	private readAdvisory(): string {
		if (this.advisory === undefined) return "";
		try {
			return this.advisory();
		} catch {
			return "";
		}
	}

	private readCountdown(): CardCountdown {
		try {
			return this.workerWindow?.() ?? this.countdown?.() ?? null;
		} catch {
			return null;
		}
	}

	private readMainTurn(): boolean | undefined {
		if (this.mainTurn === undefined) return undefined;
		try {
			return this.mainTurn();
		} catch {
			return undefined;
		}
	}

	private readDraft(): boolean {
		if (this.draft === undefined) return false;
		try {
			return this.draft();
		} catch {
			return false;
		}
	}

	private readSettling(): boolean {
		if (this.settling === undefined) return false;
		try {
			return this.settling();
		} catch {
			return false;
		}
	}

	invalidate(): void {
		this.memo = null;
	}
}

/**
 * The overlay body for one parked call. The inspector, when present, is the
 * only path the mutation text takes: it is never placed on `view`, so nothing
 * that renders or forwards the view can carry the bytes with it.
 */
export function createPermissionOverlayBody(
	view: ApprovalRequestView,
	inspect?: MutationInspector,
	invocation?: () => unknown,
	advisory?: PermissionAdvisoryReader,
	countdown?: PermissionCountdownReader,
	draft?: PermissionDraftReader,
	mainTurn?: PermissionMainTurnReader,
	workerWindow?: WorkerWindowReader,
	settling?: PermissionSettlingReader,
): PermissionOverlayBodyHandle {
	return new PermissionOverlayBody(
		view,
		inspect,
		invocation,
		advisory,
		countdown,
		draft,
		mainTurn,
		workerWindow,
		settling,
	);
}
