// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { tierPolicy, tierRevision } from "../core/presentation-tier.js";
import {
	Editor,
	getKeybindings,
	stripTerminalSequences,
	type TUI,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "../engine/tui.js";
import { type DockEntry, decisionRows, dockAdaptiveRows, dockBodyRows, dockGrowthRows, dockTop } from "./dock.js";
import { guardPastedEditorOperator, remapPastedBangOffsets, startsWithPastedOperator } from "./editor-bash.js";
import type { SuggestionEngine } from "./editor-completion.js";
import {
	cursorAwaitsSlashArgument,
	cursorEndsDirectoryPath,
	KILL_ACTIONS,
	SUGGESTION_MAX_LIST_ROWS,
	SUGGESTION_MIN_LIST_ROWS,
	SUGGESTION_PANEL_ROWS,
} from "./editor-completion.js";
import { type EditorRailState, renderEditorRail } from "./editor-rails.js";
import { steerDraftToken } from "./editor-steer.js";
import { centeredWindow, fitHintEntries } from "./overlay-frame.js";
import type { ComposerMode, EditorChrome, RuleUnit } from "./pancode-editor-model.js";
import {
	APPROVAL_DRAFT_ROWS,
	composerMode,
	confirmRailHint,
	EMPTY_PROMPT,
	emptyPromptFor,
	FAKE_CURSOR_START,
	OVERLAY_RULE_BARE,
	OVERLAY_RULE_CHROME,
	renderEmptyPrompt,
	SHELL_RAIL_FORMS,
	SHELL_RAIL_LEARNED_FORMS,
} from "./pancode-editor-model.js";
import type { SlashCompletionItem } from "./slash-autocomplete.js";
import type { PancodeTheme } from "./theme/index.js";
import { editorTheme, GLYPH, padAnsi, pancodeTheme, projectsYolo, rule, withThemeContext } from "./theme/index.js";
import { skinEpoch } from "./theme/tokens.js";
import { createComposerSurfacePainter } from "./theme/yolo-surface.js";

export class PancodeEditor extends Editor {
	private pastedBangOffsets = new Set<number>();
	private bracketedPasteActive = false;
	private revision = 0;
	private railAnimationTime = 0;
	private renderedSkinEpoch = skinEpoch();
	private readonly surfacePainters = new Map<string, (line: string) => string>();
	private renderedBottomRail = "";
	private renderedTopHidden = 0;
	private renderedBottomHidden = 0;
	private topBorderCache: { key: string; line: string } | null = null;
	private bottomBorderCache: { key: string; line: string } | null = null;
	private surfaceCache: {
		key: string;
		lines: string[];
		topHidden: number;
		bottomHidden: number;
		bottomRail: string;
	} | null = null;
	private autocompleteDockOpen = false;
	private autocompleteRowMap: number[] | null = null;
	private autocompleteSourceStart = 0;
	/** The line a suggestion list was built for, stamped when the list first shows. */
	private suggestionStamp: { list: unknown; text: string; line: number; col: number } | null = null;
	/**
	 * Whether the open list has a selected row. A list that opened by itself for
	 * an argument nobody must give starts unarmed, so Enter cannot insert
	 * `/context compact` or `/doctor deep` that the operator never chose (E-08). A list of
	 * commands found only by their descriptions starts unarmed too, so an unknown `/tools`
	 * is sent as typed and named as unknown instead of becoming `/skill`.
	 */
	private suggestionArmed = true;
	/** The next list to show was asked for by an auto-open site, not by a key the operator aimed at the list. */
	private autoOpenPending = false;
	/** The list `suggestionArmed` was decided for; a new list from a later key is armed. */
	private armingList: unknown = null;
	private pastedOperatorTokens = new Set<string>();
	/**
	 * The text is untouched since it came back from the queue. The next key is the
	 * one that can run it together with a command: `/settings` then `/usage` once
	 * reached the model as `/settings/usage`.
	 */
	private restoredDraft = false;
	/** A restored draft set aside for the command being typed; it returns when the composer empties. */
	private parkedDraft: string | null = null;
	/**
	 * The run the board addressed this draft to. The address stays out of the
	 * text because a run id is nothing the operator typed or can read; the rail
	 * names the worker and the address goes back on the line at submit.
	 */
	private boardSteer: { runId: string; agentId: string } | null = null;
	/** The address on the line just submitted, so a refused steer comes back with its address still hidden. */
	private sentSteer: { runId: string; agentId: string } | null = null;

	get draftRevision(): number {
		return this.revision;
	}

	/** Restored queues and external buffers are literal editor content. */
	setLiteralText(text: string): void {
		this.setText(text);
		this.pastedBangOffsets = new Set([...text.matchAll(/!/gu)].map((match) => match.index));
	}

	setRestoredText(text: string): void {
		this.setLiteralText(text);
		this.restoredDraft = text.length > 0;
	}

	/** Everything typed and not sent, including a draft set aside for a command. */
	unsentDraft(): string {
		return [this.parkedDraft ?? "", this.getExpandedText()].filter((part) => part.trim().length > 0).join("\n\n");
	}

	private cursorAtEnd(): boolean {
		const lines = this.getLines();
		const cursor = this.getCursor();
		return cursor.line === lines.length - 1 && cursor.col === (lines[cursor.line] ?? "").length;
	}

	/** Remember which run the board addressed this draft to. */
	markSteerTarget(run: { runId: string; agentId: string }): void {
		this.boardSteer = run;
	}

	/** Who this draft goes to if it steers a worker, and whether that worker is still running. */
	steerTarget(text = this.getText()): { agentId: string; live: boolean; queued: boolean } | null {
		if (this.boardSteer !== null) {
			// A slash command or shell line runs as itself, so it never reads as addressed.
			if (this.chrome.getDraftOperator?.(text)) return null;
			const recipient = this.chrome.getSteerRecipient?.(this.boardSteer.runId) ?? null;
			return { agentId: this.boardSteer.agentId, live: recipient !== null, queued: recipient?.queued === true };
		}
		const token = steerDraftToken(text);
		if (token === null) return null;
		const recipient = this.chrome.getSteerRecipient?.(token) ?? null;
		return recipient !== null ? { agentId: recipient.agentId, live: true, queued: recipient.queued } : null;
	}

	/** The line a submit hands on: a board-addressed draft gets its address back, and anything else passes untouched. */
	addressSubmission(text: string): string {
		const run = this.boardSteer;
		if (run === null || this.steerTarget(text) === null) return text;
		this.boardSteer = null;
		this.sentSteer = run;
		return `@${run.runId} ${text}`;
	}

	/** The worker a just-submitted line was addressed to from the board, when `target` is that address. */
	sentSteerAgent(target: string): string | null {
		return this.sentSteer?.runId === target ? this.sentSteer.agentId : null;
	}

	/**
	 * Take the worker address off the draft and keep whatever was typed, so
	 * backing out of a steer costs no text. Returns the worker it was addressed
	 * to, or null when the draft was not steering anyone.
	 */
	dropSteerTarget(): string | null {
		const text = this.getText();
		const target = this.steerTarget(text);
		if (target === null) return null;
		if (this.boardSteer !== null) {
			this.boardSteer = null;
			this.revision += 1;
			return target.agentId;
		}
		this.setText(text.trimStart().replace(/^@\S+\s*/u, ""));
		return target.agentId;
	}

	/** Rail words for a draft that is not what the composer would normally hold, or empty. */
	private draftNote(width: number): string {
		if (this.parkedDraft !== null) return width >= 80 ? `DRAFT KEPT ${GLYPH.sep} back after this command` : "DRAFT KEPT";
		// Enter queues during a run, and the STEER beside this note already says so.
		if (this.restoredDraft) {
			if (width < 80) return "RESTORED";
			return this.chrome.isStreaming?.() === true
				? `RESTORED ${GLYPH.sep} / keeps it aside`
				: `RESTORED ${GLYPH.sep} Enter sends ${GLYPH.sep} / keeps it aside`;
		}
		return "";
	}

	override applyEdit(operation: Parameters<Editor["applyEdit"]>[0]): void {
		const before = this.getText();
		this.suggestionsAreStale();
		super.applyEdit(operation);
		if (operation !== "undo" && operation !== "deleteCharBackward" && operation !== "deleteCharForward") {
			this.followSuggestionsAfterKill(before);
		}
		this.revision += 1;
		this.pastedBangOffsets = remapPastedBangOffsets(before, this.getText(), this.pastedBangOffsets, operation === "undo");
	}

	/** The dock registry key; the base class keeps its own reference under a wider type. */
	private readonly dockHost: TUI;

	constructor(
		tui: TUI,
		private readonly chrome: EditorChrome,
	) {
		super(tui, editorTheme(pancodeTheme()), { autocompleteMaxVisible: PancodeEditor.suggestionListRows(tui) });
		this.dockHost = tui;
	}

	/** Rows the suggestion list may show: the dock's growth ceiling less the input, rule and detail panel, at most eight. */
	private static suggestionListRows(tui: TUI): number {
		return Math.min(SUGGESTION_MAX_LIST_ROWS, Math.max(3, dockGrowthRows(tui) - 3 - SUGGESTION_PANEL_ROWS));
	}

	/** The row the list has selected. The engine keeps its list private and the dock already reads its rendered rows. */
	private selectedSuggestion(): SlashCompletionItem | null {
		if (!this.syncSuggestionArming()) return null;
		const list = (this as unknown as { autocompleteList?: { getSelectedItem(): unknown } }).autocompleteList;
		const item = list?.getSelectedItem() as SlashCompletionItem | null | undefined;
		return item?.path ? item : null;
	}

	private suggestionEngine(): SuggestionEngine {
		return this as unknown as SuggestionEngine;
	}

	/**
	 * Whether the open list was built for a line that has since changed. The
	 * list is replaced only when the provider answers, which is after the input
	 * that changed the line. Enter or Tab in that window would apply a row
	 * against the old token range: `/context refresh` typed in one burst became
	 * `/context compact refresh`. Every entry point calls this before it edits,
	 * so a list that appeared since the last call was built for the current line.
	 */
	private suggestionsAreStale(): boolean {
		const engine = this.suggestionEngine();
		const list = engine.autocompleteList;
		if (list === undefined || engine.autocompleteState === null) {
			this.suggestionStamp = null;
			return false;
		}
		const { line, col } = this.getCursor();
		const text = this.getText();
		const stamp = this.suggestionStamp;
		if (stamp === null || stamp.list !== list) {
			this.suggestionStamp = { list, text, line, col };
			return false;
		}
		return stamp.text !== text || stamp.line !== line || stamp.col !== col;
	}

	/**
	 * A kill leaves the open list describing text that is gone: Ctrl+U on
	 * `/context ` emptied the line under a palette that stayed up. Ask the
	 * provider again so the list closes or narrows with the line.
	 */
	private followSuggestionsAfterKill(textBefore: string): void {
		if (this.getText() === textBefore) return;
		const engine = this.suggestionEngine();
		if (engine.autocompleteState !== null) engine.updateAutocomplete?.();
	}

	/** Decide arming once per list, and report whether the open list has a selected row. */
	private syncSuggestionArming(): boolean {
		const engine = this.suggestionEngine();
		const list = engine.autocompleteList;
		if (list === undefined || engine.autocompleteState === null) return true;
		if (list !== this.armingList) {
			this.armingList = list;
			const items = (list as { items?: ReadonlyArray<SlashCompletionItem> }).items ?? [];
			const unchosen =
				items.length > 0 &&
				(items.every((item) => item.describedOnly === true || item.lettersOnly === true) ||
					(this.autoOpenPending && items.every((item) => item.required === false)));
			this.suggestionArmed = !unchosen;
			this.autoOpenPending = false;
		}
		return this.suggestionArmed;
	}

	/** Ask the provider for the next argument without the forced Tab path, which auto-applies a lone row. */
	private reopenSuggestions(autoOpen = false): void {
		this.autoOpenPending = autoOpen;
		const request = (this as unknown as { tryTriggerAutocomplete?: () => void }).tryTriggerAutocomplete;
		request?.call(this);
	}

	/** Breadcrumb, effect and next action for the selected suggestion, drawn under the list. */
	private suggestionPanel(item: SlashCompletionItem, width: number, theme: PancodeTheme): string[] {
		const gutter = `${theme.fg("border", GLYPH.rail)} `;
		const room = Math.max(1, width - 4 - visibleWidth(gutter));
		const parts = item.path?.split(` ${GLYPH.crumb} `) ?? [];
		const crumb = parts
			.map((part, index) => {
				const last = index === parts.length - 1;
				return theme.style(last ? "selectedOption" : "commandHint", part, { bold: last });
			})
			.join(theme.fg("border", ` ${GLYPH.crumb} `));
		const unavailable = item.disabledReason ? theme.fg("emptyState", "  unavailable") : "";
		const rows = [`${gutter}${truncateToWidth(`${crumb}${unavailable}`, room, GLYPH.ellipsis, false)}`];
		// A sentence that outgrows the rows under the breadcrumb ends in an ellipsis rather than a silent cut.
		const bodyRows = SUGGESTION_PANEL_ROWS - 1;
		const wrapClamped = (text: string, paint: (line: string) => string): string[] => {
			const wrapped = wrapTextWithAnsi(text, room);
			const shown = wrapped.slice(0, bodyRows);
			if (wrapped.length > bodyRows)
				shown[bodyRows - 1] = truncateToWidth(
					`${shown[bodyRows - 1] ?? ""} ${wrapped[bodyRows] ?? ""}`,
					room,
					GLYPH.ellipsis,
					false,
				);
			return shown.map((line) => `${gutter}${paint(line)}`);
		};
		const effect = item.effectDescription ?? item.description ?? "";
		const effectRows = effect ? wrapClamped(effect, (line) => theme.base("menuOption", line)) : [];
		const nextRows = item.nextAction ? wrapClamped(item.nextAction, (line) => theme.fg("keyboardHint", line)) : [];
		// A refused row's reason is why Enter did nothing, so a short panel keeps it over the description.
		rows.push(...(item.disabledReason ? [...nextRows, ...effectRows] : [...effectRows, ...nextRows]));
		const shown = rows.slice(0, SUGGESTION_PANEL_ROWS);
		// The usage example belongs to the full detail pane, so it joins the detail rows only at detailed, and only
		// when it says more than the breadcrumb.
		if (item.usage && tierPolicy().pickerDetail === "pane" && item.usage !== parts.join(" ")) {
			const usage = `${theme.fg("annotation", "usage ")}${theme.fg("commandHint", item.usage)}`;
			shown.push(`${gutter}${truncateToWidth(usage, room, GLYPH.ellipsis, false)}`);
		}
		return shown;
	}

	/** Two-column gutter on each side of a docked body, the autocomplete's own indent. */
	private static readonly DOCK_GUTTER = 2;

	private railState(mode: ComposerMode): EditorRailState {
		const attention = mode === "CONFIRM";
		return {
			phase: attention ? "attention" : mode !== "MESSAGE" ? "working" : "idle",
			yolo: this.chrome.getAutonomy?.() === "yolo",
			animate: attention && (this.chrome.getMotionEnabled?.() ?? false),
			now: this.railAnimationTime,
			...(attention ? { tone: "attentionRail" as const } : {}),
		};
	}

	private queuedSummary(width: number, theme: PancodeTheme, compactOnly = false): string {
		const count = this.chrome.getQueuedFollowUpCount?.() ?? 0;
		if (count <= 0) return "";
		const base = `${theme.fg("attention", GLYPH.user)} ${theme.fg("draftState", `${count} queued`)}`;
		if (compactOnly || !tierPolicy().hintRow || width < 60) return base;
		const key = this.chrome.getQueueReviewKeyLabel?.() ?? null;
		if (!key) return base;
		return `${base}${theme.fg("separator", ` ${GLYPH.sep} `)}${theme.fg("keyboardHint", `${key} review`)}`;
	}

	protected override renderTopBorder(width: number, hiddenLineCount: number): string {
		this.renderedTopHidden = hiddenLineCount;
		const text = this.getText();
		const mode = composerMode(this.chrome, text);
		const yolo = this.chrome.getAutonomy?.() === "yolo";
		const animating = mode === "CONFIRM" && (this.chrome.getMotionEnabled?.() ?? false);
		const steer = mode === "CONFIRM" ? null : this.steerTarget(text);
		const draftOp =
			mode === "FOLLOW-UP" && text.length > 0 && steer === null ? (this.chrome.getDraftOperator?.(text) ?? "") : "";
		const noteKey =
			this.parkedDraft !== null ? "P" : this.restoredDraft ? (this.chrome.isStreaming?.() === true ? "RS" : "RI") : "";
		const queuedCount = this.chrome.getQueuedFollowUpCount?.() ?? 0;
		const queueKey = queuedCount > 0 ? (this.chrome.getQueueReviewKeyLabel?.() ?? "") : "";
		const steerKey = steer ? `${steer.agentId}\x01${steer.live ? 1 : 0}\x01${steer.queued ? 1 : 0}` : "";
		const cacheKey = animating
			? null
			: `${width}|${hiddenLineCount}|${skinEpoch()}|${tierRevision()}|${mode}|${yolo ? 1 : 0}|${text.length > 0 ? 1 : 0}|${draftOp}|${steerKey}|${noteKey}|${queuedCount}|${queueKey}`;
		if (cacheKey !== null && this.topBorderCache?.key === cacheKey) return this.topBorderCache.line;
		const theme = pancodeTheme();
		const rail = this.railState(mode);
		const separator = theme.fg("separator", ` ${GLYPH.sep} `);
		const position = hiddenLineCount > 0 ? theme.fg("positionCount", `${GLYPH.up}${hiddenLineCount}`) : "";
		let left = "";
		if (mode === "CONFIRM") {
			left = `${theme.fg("attentionRail", GLYPH.phaseBlocked)} ${theme.style("decisionCue", "needs approval", { bold: true })}`;
		} else {
			const draftLabel = steer
				? theme.style(
						steer.live && !steer.queued ? "draftState" : "warning",
						!steer.live
							? `${steer.agentId} ended`
							: steer.queued
								? `${steer.agentId} is queued`
								: `STEER ${GLYPH.next} ${steer.agentId}`,
						{ bold: true },
					)
				: mode === "STEER"
					? theme.style("draftState", "STEER", { bold: true })
					: mode === "FOLLOW-UP" && draftOp === "command"
						? theme.style("draftState", "COMMAND", { bold: true })
						: mode === "FOLLOW-UP" && text.length > 0
							? theme.style("draftState", "FOLLOW-UP", { bold: true })
							: (mode === "PREPARING" || mode === "COMPACTING") && text.length > 0
								? theme.style("draftState", "HOLD", { bold: true })
								: "";
			const note = this.draftNote(width);
			left = [draftLabel, note ? theme.style("draftState", note, { bold: true }) : ""].filter(Boolean).join(separator);
		}
		let queued = this.queuedSummary(width, theme, false);
		let right = [position, queued].filter(Boolean).join(separator);
		const bothChrome = left && right ? OVERLAY_RULE_CHROME : OVERLAY_RULE_BARE;
		if (left && right && visibleWidth(left) + visibleWidth(right) + bothChrome > width) {
			queued = this.queuedSummary(width, theme, true);
			right = [position, queued].filter(Boolean).join(separator);
		}
		if (left) {
			const room = Math.max(1, width - (right ? visibleWidth(right) + OVERLAY_RULE_CHROME : OVERLAY_RULE_BARE));
			if (visibleWidth(left) > room) left = truncateToWidth(left, room, GLYPH.ellipsis, false);
		}
		if (right && !left) {
			const room = Math.max(1, width - OVERLAY_RULE_BARE);
			if (visibleWidth(right) > room) right = truncateToWidth(right, room, GLYPH.ellipsis, false);
		}
		const line = renderEditorRail(
			theme,
			width,
			{
				...(left ? { left, leftRaw: true, leftLead: 1 } : {}),
				...(right ? { right, rightRaw: true } : {}),
			},
			rail,
		);
		if (cacheKey !== null) this.topBorderCache = { key: cacheKey, line };
		return line;
	}

	/**
	 * Bottom composer rail: input-owned facts only (shell draft disclosure, overflowing line count,
	 * scroll indicator, and modal permission/steer/autocomplete keys).
	 */
	private bottomRail(
		width: number,
		theme: PancodeTheme,
		rail: EditorRailState,
		right = "",
		keysOnlyRoom?: number,
		lead?: { shell: readonly string[]; lines: string | null },
	): string {
		const separator = theme.fg("separator", ` ${GLYPH.sep} `);
		const fittedRight = right
			? truncateToWidth(right, Math.max(0, keysOnlyRoom ?? width - OVERLAY_RULE_BARE), GLYPH.ellipsis, false)
			: "";
		if (lead !== undefined && keysOnlyRoom === undefined && (lead.shell.length > 0 || lead.lines !== null)) {
			const leftOf = (shell: string | undefined): string =>
				[shell === undefined ? "" : this.paintShellUnit(theme, shell), lead.lines ?? ""].filter(Boolean).join(separator);
			const forms = lead.shell.length > 0 ? lead.shell : [undefined];
			const room = Math.max(
				1,
				width - (fittedRight ? visibleWidth(fittedRight) + OVERLAY_RULE_CHROME : OVERLAY_RULE_BARE),
			);
			let chosenLeft = "";
			for (const form of forms) {
				const candidate = leftOf(form);
				chosenLeft = candidate;
				if (visibleWidth(candidate) <= room) break;
			}
			if (visibleWidth(chosenLeft) > room) chosenLeft = truncateToWidth(chosenLeft, room, GLYPH.ellipsis, false);
			return renderEditorRail(
				theme,
				width,
				{
					...(chosenLeft ? { left: chosenLeft, leftRaw: true, leftLead: 1 } : {}),
					...(fittedRight ? { right: fittedRight, rightRaw: true } : {}),
				},
				rail,
			);
		}
		return renderEditorRail(theme, width, fittedRight ? { right: fittedRight, rightRaw: true } : {}, rail);
	}

	/** `$ shared shell · Enter runs · PanCode sees the output`: the kind of shell first, then the key, then who sees it. */
	private paintShellUnit(theme: PancodeTheme, form: string): string {
		const [kind = "", key, disclosure] = form.split(` ${GLYPH.sep} `);
		return [
			theme.style("draftState", kind, { bold: true }),
			key === undefined ? "" : theme.fg("keyboardHint", key),
			disclosure === undefined ? "" : theme.fg("annotation", disclosure),
		]
			.filter(Boolean)
			.join(theme.fg("separator", ` ${GLYPH.sep} `));
	}

	/**
	 * The draft's own units for the bottom rail: which shell a `!` line runs in, and how tall a draft is that overflows.
	 * Both read `submitted`, the text Enter hands on (pastes expanded, a pasted `!` kept literal), so a one-line
	 * `!echo 1[paste #1 +31 lines]` reads as the 31-line prompt Enter sends, not as a shell line (FX-11b).
	 */
	private draftRailLead(
		submitted: string,
		hidden: number,
		theme: PancodeTheme,
	): { shell: readonly string[]; lines: string | null } {
		const forms = this.chrome.isShellDraftLearned?.() === true ? SHELL_RAIL_LEARNED_FORMS : SHELL_RAIL_FORMS;
		const shell =
			this.chrome.getDraftOperator?.(submitted) === "shell"
				? forms[submitted.trimStart().startsWith("!!") ? "private" : "shared"]
				: [];
		const count = submitted.split("\n").length;
		const taller = hidden > 0 || count > this.getLines().length;
		return { shell, lines: taller ? theme.fg("positionCount", `${count} lines`) : null };
	}

	/** An approval's title and keys take the rail to a three-column stretch: at 60 columns the shared room cut the queue count. */
	private approvalLabelRoom(width: number): number {
		return Math.max(1, width - 6);
	}

	protected override renderBottomBorder(width: number, hiddenLineCount: number): string {
		this.renderedBottomHidden = hiddenLineCount;
		const text = this.getText();
		const mode = composerMode(this.chrome, text);
		const yolo = this.chrome.getAutonomy?.() === "yolo";
		const animating = mode === "CONFIRM" && (this.chrome.getMotionEnabled?.() ?? false);
		const showingAutocomplete = this.isShowingAutocomplete();
		const steer = mode === "CONFIRM" ? null : this.steerTarget(text);
		const hiddenTotal = this.renderedTopHidden + hiddenLineCount;
		// Plain single-line non-shell drafts without paste markers never have a shell or line-count lead.
		const needsLead =
			mode !== "CONFIRM" &&
			(hiddenTotal > 0 ||
				text.includes("[paste #") ||
				text.trimStart().startsWith("!") ||
				this.pastedBangOffsets.size > 0 ||
				this.pastedOperatorTokens.size > 0);
		let leadShellKind: "" | "shared" | "private" = "";
		let leadShellLearned = false;
		let leadLineCount = 0;
		let submittedForLead: string | null = null;
		if (needsLead) {
			submittedForLead = this.getTextForSubmit();
			if (this.chrome.getDraftOperator?.(submittedForLead) === "shell") {
				leadShellKind = submittedForLead.trimStart().startsWith("!!") ? "private" : "shared";
				leadShellLearned = this.chrome.isShellDraftLearned?.() === true;
			}
			const count = submittedForLead.split("\n").length;
			if (hiddenTotal > 0 || count > this.getLines().length) leadLineCount = count;
		}
		const inspection = mode === "CONFIRM" ? (this.chrome.getPermissionInspection?.() ?? "none") : "none";
		const terms = mode === "CONFIRM" ? (this.chrome.getPermissionTerms?.() ?? "closed") : "closed";
		const steerKey = steer ? `${steer.agentId}\x01${steer.live ? 1 : 0}\x01${steer.queued ? 1 : 0}` : "";
		const cacheKey =
			animating || showingAutocomplete
				? null
				: `${width}|${hiddenLineCount}|${skinEpoch()}|${tierRevision()}|${mode}|${yolo ? 1 : 0}|${mode === "CONFIRM" ? `${text.length > 0 ? 1 : 0}|${inspection}|${terms}` : ""}|${steerKey}|${leadShellKind}|${leadShellLearned ? 1 : 0}|${leadLineCount}`;
		if (cacheKey !== null && this.bottomBorderCache?.key === cacheKey) {
			this.renderedBottomRail = this.bottomBorderCache.line;
			return this.renderedBottomRail;
		}
		const theme = pancodeTheme();
		const rail = this.railState(mode);
		const scroll = hiddenLineCount > 0 ? `${GLYPH.down}${hiddenLineCount}` : "";
		const room = this.approvalLabelRoom(width);
		const hint =
			mode === "CONFIRM"
				? confirmRailHint(
						theme,
						Math.max(1, room - (scroll ? visibleWidth(scroll) + 3 : 0)) + 3,
						text.length > 0,
						inspection,
						terms,
					)
				: steer
					? fitHintEntries(
							[
								// Sending is what a typed steer is for, so a narrow rail keeps it before it keeps the way out.
								...(steer.live && !steer.queued
									? [{ key: "Enter", verb: `send to ${steer.agentId}`, short: "send", critical: true }]
									: []),
								// A bare `cancel` beside a worker's name reads as stopping the worker, so the short form says back.
								{ key: "Esc", verb: "cancel steer, keep text", short: "back" },
							],
							Math.max(1, room - (scroll ? visibleWidth(scroll) + 3 : 0)),
						)
					: showingAutocomplete
						? // An open list owns Tab and Esc; a bare rail left the way out of it unnamed.
							fitHintEntries(
								!this.syncSuggestionArming()
									? [
											{ key: "Tab", verb: "complete", critical: true },
											{ key: "Enter", verb: "run as typed", short: "run" },
											{ key: "Esc", verb: "close list, keep text", short: "close list" },
										]
									: // After a bare `/` Enter only completes the first row, so the rail must not promise a run.
										this.selectedSuggestion()?.kind === "command" &&
											this.selectedSuggestion()?.runsBare === true &&
											/^\/\S/u.test(text.trimStart())
										? [
												{ key: "Enter", verb: "run", critical: true },
												{ key: "Tab", verb: "complete" },
												{ key: "Esc", verb: "close list" },
											]
										: [
												{ key: "Tab", verb: "complete", critical: true },
												{ key: "Esc", verb: "close list, keep text", short: "close list" },
											],
								Math.max(1, room - (scroll ? visibleWidth(scroll) + 3 : 0)),
							)
						: "";
		const right = [scroll ? theme.fg("positionCount", scroll) : "", theme.base("keyboardHint", hint)]
			.filter(Boolean)
			.join(theme.fg("separator", ` ${GLYPH.sep} `));
		const lead =
			mode === "CONFIRM"
				? undefined
				: submittedForLead !== null
					? this.draftRailLead(submittedForLead, hiddenTotal, theme)
					: { shell: [] as readonly string[], lines: null };
		this.renderedBottomRail = this.bottomRail(
			width,
			theme,
			rail,
			right,
			(steer || showingAutocomplete) && mode !== "CONFIRM" ? room : undefined,
			lead,
		);
		if (cacheKey !== null) this.bottomBorderCache = { key: cacheKey, line: this.renderedBottomRail };
		return this.renderedBottomRail;
	}

	/**
	 * The top rule of a focused surface: its own title at the left (`━ Models ━`) and, when the surface itself waits on
	 * the operator (approval card or interview question), its own pending state at the right. Status Row 1 directly
	 * beneath already owns the live busy phase, elapsed clock, worker count, and model identity, so the overlay rule
	 * never repeats beside-card run state or model names.
	 */
	private overlayRule(
		width: number,
		theme: PancodeTheme,
		rail: EditorRailState,
		title: { plain: (room: number) => string; paint: (text: string) => string },
		pending: RuleUnit | null,
	): string {
		const separator = theme.fg("separator", ` ${GLYPH.sep} `);
		const head = pending === null ? [] : [pending];
		const cells = (units: readonly RuleUnit[]): number =>
			units.reduce((sum, unit, index) => sum + visibleWidth(unit.text) + (index === 0 ? 0 : 3), 0);
		const chrome = (units: readonly RuleUnit[]): number => (units.length > 0 ? OVERLAY_RULE_CHROME : OVERLAY_RULE_BARE);
		const whole = title.plain(Math.max(1, width - OVERLAY_RULE_BARE));
		let fitted: { title: string; units: readonly RuleUnit[] } | null = null;
		for (const units of [head, []]) {
			if (visibleWidth(whole) + cells(units) + chrome(units) <= width) {
				fitted = { title: whole, units };
				break;
			}
		}
		// Past that the title shortens to keep the pending state, and is cut only when nothing else is left on the rule.
		if (fitted === null) {
			for (const units of [head, []]) {
				const room = width - cells(units) - chrome(units);
				const shorter = room > 0 ? title.plain(room) : "";
				if (room > 0 && visibleWidth(shorter) <= room) {
					fitted = { title: shorter, units };
					break;
				}
			}
		}
		const room = Math.max(1, width - OVERLAY_RULE_BARE);
		const shown = fitted ?? { title: truncateToWidth(title.plain(room), room, GLYPH.ellipsis, false), units: [] };
		const right = shown.units.map((unit) => unit.paint(unit.text)).join(separator);
		return renderEditorRail(
			theme,
			width,
			{ left: title.paint(shown.title), leftRaw: true, leftLead: 1, right, rightRaw: true },
			rail,
		);
	}

	/** A docked command or menu: its title and keys on the composer's rails, its body between them. */
	private renderDock(
		entry: DockEntry,
		width: number,
		theme: PancodeTheme,
		rail: EditorRailState,
	): { lines: string[]; bodyEnd: number } {
		const gutter = PancodeEditor.DOCK_GUTTER;
		const contentWidth = Math.max(1, width - gutter * 2);
		const adaptive = entry.adaptive === true;
		const grows = adaptive || entry.frame.dockWantsGrowth?.() === true;
		// An adaptive surface waiting on the operator's answer (the interview) may fill the screen, so its question reads whole.
		const fill = adaptive && entry.frame.dockAwaitingInput?.() === true;
		const bodyRows = grows ? dockGrowthRows(this.dockHost, fill) : dockBodyRows(this.dockHost);
		// The body learns the rail's room first, so a list can draw in its own
		// rows every key the rail below will have to drop. The rail is the keys'
		// alone: thinking and context describe the composer, which is not open (F07).
		const room = this.approvalLabelRoom(width);
		entry.frame.setRailRoom?.(room);
		let body = entry.frame.renderDockBody(contentWidth, Math.max(1, bodyRows));
		// The frame pads to its budget, and blank rows above the keys say nothing. A short surface keeps the rows its content
		// has used so far, so a filter that narrows a list or a tab with less to show does not make the rails jump. That
		// height belongs to the layout it was measured in: a resize or a tier change starts it again, or the rows a wider
		// or fuller layout needed stay on screen as blank rows above the keys (FX-10).
		let used = body.length;
		while (used > 1 && stripTerminalSequences(body[used - 1] ?? "").trim() === "") used -= 1;
		const layout = `${contentWidth}|${bodyRows}|${tierRevision()}`;
		if (entry.rowsUsedLayout !== layout) {
			entry.rowsUsedLayout = layout;
			entry.rowsUsed = 0;
		}
		entry.rowsUsed = Math.max(entry.rowsUsed ?? 0, used);
		// A body that stops asking to grow returns to the shared height, so the slice is also capped at what it was given.
		body = body.slice(0, adaptive ? dockAdaptiveRows(this.dockHost, used, fill) : Math.min(entry.rowsUsed, bodyRows));
		const pad = " ".repeat(gutter);
		// A title that can shorten itself is told the room it may take.
		const tone = entry.frame.dockTone() ?? "sectionHeading";
		// A question holds the keyboard like a card does, so the rule says it waits for the operator.
		const pending: RuleUnit | null = entry.frame.dockAwaitingInput?.()
			? {
					text: `${GLYPH.phaseBlocked} waiting for you`,
					paint: () =>
						`${theme.fg("attentionRail", GLYPH.phaseBlocked)} ${theme.style("decisionCue", "waiting for you", { bold: true })}`,
				}
			: null;
		const hint = entry.frame.dockHint(room + 4);
		const lines = [
			this.overlayRule(
				width,
				theme,
				rail,
				{
					plain: (titleRoom) => entry.frame.dockTitle({ room: titleRoom, actor: "" }),
					paint: (text) => theme.style(tone, text, { bold: true }),
				},
				pending,
			),
			...body.map((row) => padAnsi(`${pad}${row}${pad}`, width)),
			// The dock's keys get the hint role like every other rail; unpainted, they took the terminal's own
			// foreground, which a light scheme such as Solarized sets below 4.5:1.
			this.bottomRail(width, theme, rail, hint?.trim().length ? theme.base("keyboardHint", hint) : "", room),
		];
		// The run's state rides on the top rule, so nothing joins the dock under its key rail.
		return { lines, bodyEnd: lines.length - 1 };
	}

	/**
	 * A permission card inside the editor's own rails, decisions first (7.4). The top rule is titled `Approval` and its
	 * right end says what waits and its clock (`‖ needs approval · 3:32 · <actor>`); the bottom rail carries the card's
	 * keys once. The card gets every row the rails, the footer and a sliver of transcript leave, with no shared ceiling.
	 * The operator's draft stays editable under it, at most 2 rows and its divider, because Enter is inert while it
	 * exists (#186).
	 */
	private renderApproval(
		entry: DockEntry,
		width: number,
		theme: PancodeTheme,
		draft: { rows: string[]; hiddenAbove: number; hiddenBelow: number },
	): { card: string[]; composer: string[] } {
		const gutter = PancodeEditor.DOCK_GUTTER;
		const contentWidth = Math.max(1, width - gutter * 2);
		const pad = " ".repeat(gutter);
		const rail: EditorRailState = { ...this.railState("CONFIRM"), tone: "attentionRail" };
		const room = this.approvalLabelRoom(width);
		const cue = GLYPH.phaseBlocked;
		const tone = entry.frame.dockTone() ?? "decisionCue";
		const actor = this.chrome.getApprovalActor?.() ?? "";
		// The draft's rows and its divider come out of the card's budget, so the whole surface keeps its height.
		const draftRows = draft.rows.length > 0 ? draft.rows.length + 1 : 0;
		const down = draft.hiddenBelow > 0 ? theme.fg("positionCount", `${GLYPH.down}${draft.hiddenBelow}`) : "";
		entry.frame.setRailRoom?.(room - (down ? visibleWidth(down) + 3 : 0));
		// The body renders before the rule reads its title, so the rule states the clock this frame draws.
		const rendered = entry.frame.renderDockBody(contentWidth, Math.max(1, decisionRows(this.dockHost) - draftRows));
		// The frame pads every body to its budget; a card owes no blank rows above its keys.
		let bodyEnd = rendered.length;
		while (bodyEnd > 1 && stripTerminalSequences(rendered[bodyEnd - 1] ?? "").trim() === "") bodyEnd -= 1;
		const title = "Approval";
		const label = {
			plain: (titleRoom: number) =>
				visibleWidth(title) <= titleRoom ? title : truncateToWidth(title, titleRoom, GLYPH.ellipsis, false),
			paint: (text: string) => theme.style(tone, text, { bold: true }),
		};
		// The decision keeps its unit on the rule: it shortens to the clock alone before the title gives way.
		const decisionRoom = Math.max(1, width - OVERLAY_RULE_CHROME - visibleWidth(title) - visibleWidth(cue) - 1);
		const decision = entry.frame.dockTitle({ room: decisionRoom, actor });
		const pending: RuleUnit = {
			text: `${cue} ${decision}`,
			paint: (text) =>
				`${theme.fg("attentionRail", cue)} ${theme.style(tone, text.slice(cue.length + 1), { bold: true })}`,
		};
		const hint = entry.frame.dockHint(room - (down ? visibleWidth(down) + 3 : 0) + 4);
		const keys = [down, hint?.trim().length ? theme.fg("decisionKey", hint) : ""]
			.filter(Boolean)
			.join(theme.fg("separator", ` ${GLYPH.sep} `));
		// Draft rows hidden above the two shown are the divider's own position.
		const up = draft.hiddenAbove > 0 ? `${GLYPH.up}${draft.hiddenAbove}` : "";
		return {
			card: [
				this.overlayRule(width, theme, rail, label, pending),
				...rendered.slice(0, bodyEnd).map((row) => padAnsi(`${pad}${row}${pad}`, width)),
				...(draft.rows.length > 0
					? [
							padAnsi(
								`${pad}${rule(theme, contentWidth, { left: "Your draft", leftToken: "annotation", ...(up ? { right: up } : {}) })}`,
								width,
							),
						]
					: []),
			],
			composer: [...draft.rows, this.bottomRail(width, theme, rail, keys, room)],
		};
	}

	private renderAutocompleteDock(lines: string[], width: number, theme: PancodeTheme): string[] {
		// The border hook identifies the engine's exact row; labels and glyphs are never guessed.
		const border = lines.indexOf(this.renderedBottomRail, 1);
		if (border < 1) return lines;
		// The list opens compact and grows with its rows toward the growth ceiling.
		const ceiling = dockGrowthRows(this.dockHost);
		const input = lines.slice(1, border);
		const cursor = Math.max(
			0,
			input.findIndex((line) => line.includes(FAKE_CURSOR_START)),
		);
		const [inputStart, inputEnd] = centeredWindow(input.length, cursor, Math.max(1, ceiling - 2));
		const rows = [this.renderTopBorder(width, this.renderedTopHidden + inputStart)];
		const rowMap = [0];
		for (let index = inputStart; index < inputEnd; index++) {
			rows.push(input[index] ?? "");
			rowMap.push(index + 1);
		}
		rows.push(rule(theme, width));
		rowMap.push(-1);
		this.autocompleteSourceStart = border + 1;
		const suggestions = lines.slice(this.autocompleteSourceStart);
		const last = suggestions.at(-1);
		const hasCount = last !== undefined && /^\s*\(\d+\/\d+\)\s*$/u.test(stripTerminalSequences(last));
		const engineItems = hasCount ? suggestions.slice(0, -1) : suggestions;
		const selectedItem = this.selectedSuggestion();
		const panel = selectedItem ? this.suggestionPanel(selectedItem, width, theme) : [];
		const wanted = rows.length + engineItems.length + (hasCount ? 1 : 0) + panel.length;
		const bodyRows = dockAdaptiveRows(this.dockHost, wanted - 1);
		const room = Math.max(1, bodyRows + 1 - rows.length);
		// A short dock keeps a few list rows and gives the panel what is left.
		const panelRows = Math.min(
			panel.length,
			Math.max(0, room - Math.min(engineItems.length + (hasCount ? 1 : 0), SUGGESTION_MIN_LIST_ROWS)),
		);
		const listRoom = room - panelRows;
		// Slash rows are composed here from the engine's own list, so the tier applies on the next frame, the group word
		// sits at the row end where room allows, and a cut description ends in an ellipsis instead of a silent cut.
		const policy = tierPolicy();
		const list = this.suggestionEngine().autocompleteList as
			| {
					filteredItems?: ReadonlyArray<Partial<SlashCompletionItem>>;
					selectedIndex?: number;
					getVisibleRange?(): { startIndex: number; endIndex: number };
					getPrimaryColumnWidth?(): number;
			  }
			| undefined;
		// An unarmed list has no focused row: the engine drew its window with no selection, so the range is read the same way.
		const armed = this.syncSuggestionArming();
		const keptIndex = list?.selectedIndex;
		if (!armed && list !== undefined) list.selectedIndex = -1;
		let range: { startIndex: number; endIndex: number } | undefined;
		try {
			range = list?.getVisibleRange?.();
		} finally {
			if (!armed && list !== undefined && keptIndex !== undefined) list.selectedIndex = keptIndex;
		}
		const focused = armed ? keptIndex : undefined;
		const visible = range ? (list?.filteredItems ?? []).slice(range.startIndex, range.endIndex) : [];
		const composed =
			range !== undefined &&
			visible.length > 0 &&
			visible.length === engineItems.length &&
			visible.every((item) => item.kind !== undefined && typeof item.value === "string");
		const rowRoom = Math.max(1, width - 4);
		const column = list?.getPrimaryColumnWidth?.() ?? 32;
		const minDescription = 10;
		// The group words share one right-hand slot, shown on every row or none: descriptions keep this many cells first.
		const groupFloor = 40;
		const groupSlot =
			policy.listDescriptions === "all" ? Math.max(0, ...visible.map((item) => visibleWidth(item.group ?? ""))) : 0;
		const groupsFit = groupSlot > 0 && rowRoom - 2 - Math.min(column, rowRoom - 4) - groupSlot - 2 >= groupFloor;
		const fit = (text: string, cells: number): string => {
			if (visibleWidth(text) <= cells) return text;
			const cut = truncateToWidth(text, Math.max(0, cells - visibleWidth(GLYPH.ellipsis)), "", false).trimEnd();
			return `${cut}${GLYPH.ellipsis}`;
		};
		// The focused row states its description inline at compact only when the detail rows cannot carry it.
		const focusedInline = panelRows < SUGGESTION_PANEL_ROWS;
		const slashRow = (item: Partial<SlashCompletionItem>, selected: boolean): string => {
			const lead = selected ? `${GLYPH.cursor} ` : "  ";
			const cells = Math.max(1, rowRoom - visibleWidth(lead));
			// A refused row keeps its reason at every tier, and a row without detail rows keeps its own description.
			const described =
				policy.listDescriptions === "all" ||
				item.disabledReason !== undefined ||
				item.path === undefined ||
				(selected && focusedInline);
			const description = described ? (item.description ?? "").replace(/[\r\n]+/gu, " ").trim() : "";
			const group = groupsFit ? (item.group ?? "") : "";
			const cell = Math.max(1, Math.min(column, cells - 2));
			const name = item.label || item.value || "";
			let label = fit(name, cells);
			let gap = "";
			let shown = "";
			let showGroup = false;
			const groupCells = group ? visibleWidth(group) + 2 : 0;
			if (description && cells - cell >= minDescription) {
				label = fit(name, Math.max(1, cell - 2));
				gap = " ".repeat(Math.max(1, cell - visibleWidth(label)));
				let descriptionRoom = cells - visibleWidth(label) - gap.length;
				showGroup = group !== "" && descriptionRoom - groupCells >= minDescription;
				if (showGroup) descriptionRoom -= groupCells;
				shown = fit(description, descriptionRoom);
			} else if (description && item.disabledReason !== undefined) {
				// Too narrow for the description column: a refused row keeps its reason right after its name.
				const reasonCells = Math.min(visibleWidth(description), Math.max(minDescription, cells - visibleWidth(name) - 2));
				label = fit(name, Math.max(1, cells - 2 - reasonCells));
				gap = "  ";
				shown = fit(description, Math.max(1, cells - visibleWidth(label) - 2));
			}
			const head = shown ? `${label}${gap}${shown}` : label;
			const tail = showGroup
				? `${" ".repeat(Math.max(2, cells - visibleWidth(head) - visibleWidth(group)))}${theme.fg("annotation", group)}`
				: "";
			if (selected) return `${theme.style("selectedOption", `${lead}${head}`, { bold: true })}${tail}`;
			return `${lead}${label}${shown ? theme.fg("menuDescription", `${gap}${shown}`) : ""}${tail}`;
		};
		const items = composed
			? visible.map((item, index) => slashRow(item, range !== undefined && range.startIndex + index === focused))
			: engineItems;
		const selected = Math.max(
			0,
			items.findIndex((line) => stripTerminalSequences(line).trimStart().startsWith(`${GLYPH.cursor} `)),
		);
		const [start, end] = centeredWindow(
			items.length,
			selected,
			Math.max(1, listRoom - (hasCount && listRoom > 1 ? 1 : 0)),
		);
		const appendSuggestion = (line: string, sourceRow: number): void => {
			const room = Math.max(1, width - 4);
			// The engine pads each list row to the full width, so only real content past the room earns an ellipsis.
			const overflows = visibleWidth(stripTerminalSequences(line).trimEnd()) > room;
			rows.push(
				padAnsi(
					`  ${truncateToWidth(theme.base("menuOption", line), room, overflows ? GLYPH.ellipsis : "", false)}`,
					width,
				),
			);
			rowMap.push(sourceRow);
		};
		for (let index = start; index < end; index++)
			appendSuggestion(items[index] ?? "", this.autocompleteSourceStart + index);
		if (items.length === 0) appendSuggestion(theme.fg("emptyState", "No suggestions to display"), -1);
		// The count row exists only when the list overflows, which is when the page keys move it.
		if (hasCount && listRoom > 1 && last !== undefined)
			appendSuggestion(`${last.trimEnd()}${theme.fg("keyboardHint", ` ${GLYPH.sep} PgUp/PgDn page`)}`, lines.length - 1);
		for (const line of panel.slice(0, panelRows)) {
			rows.push(padAnsi(`  ${line}`, width));
			rowMap.push(-1);
		}
		while (rows.length < bodyRows + 1) {
			rows.push(" ".repeat(width));
			rowMap.push(-1);
		}
		rows.push(this.renderBottomBorder(width, this.renderedBottomHidden + input.length - inputEnd));
		rowMap.push(-1);
		this.autocompleteRowMap = rowMap;
		return rows;
	}

	override handleMouse(event: Parameters<Editor["handleMouse"]>[0]): ReturnType<Editor["handleMouse"]> {
		this.surfaceCache = null;
		this.suggestionsAreStale();
		const rowMap = this.autocompleteRowMap;
		if (rowMap === null) return super.handleMouse(event);
		const sourceRow = rowMap[event.y] ?? -1;
		if (sourceRow < 0) return event.type === "click" ? { handled: true } : undefined;
		const before = this.getText();
		const result = super.handleMouse({
			...event,
			y: sourceRow,
			x: sourceRow >= this.autocompleteSourceStart ? event.x - 2 : event.x,
		});
		if (this.getText() !== before) this.autocompleteDockOpen = super.isShowingAutocomplete();
		return result;
	}

	override isShowingAutocomplete(): boolean {
		return this.autocompleteDockOpen || super.isShowingAutocomplete();
	}

	/** The composer surface includes its rails in yolo, including docked menus and blank padding. */
	private paintComposerBody(
		lines: string[],
		width: number,
		bodyEnd = lines.length - 1,
		baseRole: "inputText" | "menuOption" = "inputText",
		bodyStart = 1,
	): string[] {
		const theme = pancodeTheme();
		const key = `${theme.context.mode}:${baseRole}:${width}`;
		let paint = this.surfacePainters.get(key);
		if (paint === undefined) {
			if (this.surfacePainters.size >= 4) this.surfacePainters.clear();
			paint = createComposerSurfacePainter(theme, width, baseRole);
			this.surfacePainters.set(key, paint);
		}
		const paintRails = projectsYolo(theme.context);
		return lines.map((line, index) => (paintRails || (index >= bodyStart && index < bodyEnd) ? paint(line) : line));
	}

	override invalidate(): void {
		this.topBorderCache = null;
		this.bottomBorderCache = null;
		this.surfaceCache = null;
		super.invalidate();
	}

	override render(width: number): string[] {
		if (this.renderedSkinEpoch !== skinEpoch()) {
			this.renderedSkinEpoch = skinEpoch();
			this.surfacePainters.clear();
			this.invalidate();
		}
		// The border and wrap need a few columns; narrower would overflow the stack.
		if (width < 3) return [" ".repeat(Math.max(0, width))];
		return withThemeContext(
			{ surface: "composer", mode: this.chrome.getAutonomy?.() === "yolo" ? "yolo" : "normal" },
			() => this.renderSurface(width),
		);
	}

	/** A docked menu or card holds the composer's rows. */
	isDocked(): boolean {
		return dockTop(this.dockHost) !== null;
	}

	private renderSurface(width: number): string[] {
		this.autocompleteRowMap = null;
		this.autocompleteSourceStart = Number.POSITIVE_INFINITY;
		const safeWidth = Math.max(0, width);
		const text = this.getText();
		const mode = composerMode(this.chrome, text);
		const docked = dockTop(this.dockHost);
		const animating = mode === "CONFIRM" && (this.chrome.getMotionEnabled?.() ?? false);
		let surfaceKey: string | null = null;
		if (docked === null && !this.isShowingAutocomplete() && !animating) {
			const cursor = this.getCursor();
			const yolo = this.chrome.getAutonomy?.() === "yolo";
			const queuedCount = this.chrome.getQueuedFollowUpCount?.() ?? 0;
			const queueKey = queuedCount > 0 ? (this.chrome.getQueueReviewKeyLabel?.() ?? "") : "";
			const steer = mode === "CONFIRM" ? null : this.steerTarget(text);
			const steerKey = steer ? `${steer.agentId}\x01${steer.live ? 1 : 0}\x01${steer.queued ? 1 : 0}` : "";
			const noteKey =
				this.parkedDraft !== null ? "P" : this.restoredDraft ? (this.chrome.isStreaming?.() === true ? "RS" : "RI") : "";
			const compactDoor =
				text.length === 0 && mode === "MESSAGE" && steer === null && this.chrome.showCompactKeysDoor?.() === true;
			const confirmKey =
				mode === "CONFIRM"
					? `${this.chrome.getPermissionInspection?.() ?? "none"}|${this.chrome.getPermissionTerms?.() ?? "closed"}`
					: "";
			const trimmedStart = text.length > 0 ? text.trimStart() : "";
			const draftOpKey =
				trimmedStart.length > 0 && (mode === "FOLLOW-UP" || trimmedStart.startsWith("!"))
					? (this.chrome.getDraftOperator?.(text) ?? "")
					: "";
			const shellLearned = trimmedStart.startsWith("!") && this.chrome.isShellDraftLearned?.() === true ? 1 : 0;
			const terminalRows = this.dockHost.terminal?.rows ?? 0;
			surfaceKey = `${safeWidth}|${terminalRows}|${skinEpoch()}|${tierRevision()}|${this.revision}|${this.focused ? 1 : 0}|${cursor.line}:${cursor.col}|${mode}|${yolo ? 1 : 0}|${queuedCount}|${queueKey}|${steerKey}|${noteKey}|${compactDoor ? 1 : 0}|${confirmKey}|${draftOpKey}|${shellLearned}|${text}`;
			const cached = this.surfaceCache;
			if (cached !== null && cached.key === surfaceKey) {
				this.renderedTopHidden = cached.topHidden;
				this.renderedBottomHidden = cached.bottomHidden;
				this.renderedBottomRail = cached.bottomRail;
				return cached.lines;
			}
		}
		this.setAutocompleteMaxVisible(PancodeEditor.suggestionListRows(this.dockHost));
		const theme = pancodeTheme();
		this.railAnimationTime = this.chrome.getAnimationTime?.() ?? performance.now();
		if (docked !== null && !docked.keepComposer) {
			this.autocompleteDockOpen = false;
			const rail: EditorRailState = {
				phase: docked.frame.dockAwaitingInput?.() === true ? "attention" : "idle",
				yolo: this.chrome.getAutonomy?.() === "yolo",
				animate: false,
				now: this.railAnimationTime,
				...(docked.approval ? { tone: "attentionRail" as const } : {}),
			};
			const { lines, bodyEnd } = this.renderDock(docked, safeWidth, theme, rail);
			this.autocompleteRowMap = lines.map(() => -1);
			return this.paintComposerBody(lines, safeWidth, bodyEnd, "menuOption");
		}
		const list = this.syncSuggestionArming()
			? undefined
			: (this.suggestionEngine().autocompleteList as { selectedIndex?: number } | undefined);
		const keptIndex = list?.selectedIndex;
		// An unarmed list draws no cursor mark; the engine marks the row at its selected index.
		if (list !== undefined) list.selectedIndex = -1;
		let lines: string[];
		try {
			lines = super.render(width);
		} finally {
			if (list !== undefined && keptIndex !== undefined) list.selectedIndex = keptIndex;
		}
		if (lines.length === 0) return lines;

		if (text.length === 0 && lines[1]) {
			const addressed = mode === "CONFIRM" ? null : this.steerTarget(text);
			const prompt = addressed
				? !addressed.live
					? `${addressed.agentId} ended. Esc returns this composer to PanCode.`
					: addressed.queued
						? `${addressed.agentId} is queued and can take a message once it starts.`
						: `Message for ${addressed.agentId}${GLYPH.ellipsis}`
				: emptyPromptFor(mode);
			const compactDoor = mode === "MESSAGE" && prompt === EMPTY_PROMPT && this.chrome.showCompactKeysDoor?.() === true;
			if (compactDoor) this.chrome.onCompactKeysDoorShown?.();
			lines[1] = renderEmptyPrompt(lines[1], safeWidth, theme, prompt, compactDoor);
		}

		if (docked !== null) {
			const border = lines.indexOf(this.renderedBottomRail, 1);
			if (border < 1) return lines;
			const input = lines.slice(1, border);
			const cursor = Math.max(
				0,
				input.findIndex((line) => line.includes(FAKE_CURSOR_START)),
			);
			// The draft under a decision card shows at most 2 rows (7.4); the rest is counted on its divider and rail.
			const [start, end] = centeredWindow(input.length, cursor, APPROVAL_DRAFT_ROWS);
			// An empty composer has nothing to show under the card; its draft returns with the normal rails.
			const { card, composer } = this.renderApproval(docked, safeWidth, theme, {
				rows: text.length > 0 ? input.slice(start, end) : [],
				hiddenAbove: text.length > 0 ? this.renderedTopHidden + start : 0,
				hiddenBelow: text.length > 0 ? this.renderedBottomHidden + input.length - end : 0,
			});
			this.autocompleteSourceStart = Number.POSITIVE_INFINITY;
			this.autocompleteRowMap = [
				...card.map(() => -1),
				...composer.slice(0, -1).map((_, index) => start + index + 1),
				border,
			];
			return [
				...this.paintComposerBody(card, safeWidth, card.length, "menuOption"),
				...this.paintComposerBody(composer, safeWidth, composer.length - 1, "inputText", 0),
			];
		}
		if (super.isShowingAutocomplete()) this.autocompleteDockOpen = true;
		if (text.length === 0) this.autocompleteDockOpen = false;
		const rendered = this.autocompleteDockOpen ? this.renderAutocompleteDock(lines, safeWidth, theme) : lines;
		const painted = this.paintComposerBody(rendered, safeWidth);
		if (surfaceKey !== null && !this.autocompleteDockOpen) {
			this.surfaceCache = {
				key: surfaceKey,
				lines: painted,
				topHidden: this.renderedTopHidden,
				bottomHidden: this.renderedBottomHidden,
				bottomRail: this.renderedBottomRail,
			};
		}
		return painted;
	}

	/**
	 * Preserve paste provenance for every immediate-send binding, including the
	 * alternate paths that invoke the submit controller without an Editor Enter.
	 */
	getTextForSubmit(): string {
		const text = this.getExpandedText();
		return this.startsWithLiteralOperator() ? guardPastedEditorOperator(text) : text;
	}

	private startsWithLiteralOperator(): boolean {
		const visible = this.getText();
		return (
			startsWithPastedOperator(visible, this.pastedBangOffsets) ||
			[...this.pastedOperatorTokens].some((token) => visible.trimStart().startsWith(token))
		);
	}

	/** Paste is always literal; a later deliberate key submits it. */
	override handleInput(data: string): void {
		this.revision += 1;
		if (this.restoredDraft && !this.bracketedPasteActive && (data === "/" || data === "!") && this.cursorAtEnd()) {
			this.parkedDraft = this.getExpandedText();
			this.restoredDraft = false;
			this.pastedBangOffsets.clear();
			this.pastedOperatorTokens.clear();
			super.setText("");
		}
		const parkedBeforeInput = this.parkedDraft;
		const openedPaste = data.includes("\x1b[200~");
		const closedPaste = data.includes("\x1b[201~");
		const pasteMutation = this.bracketedPasteActive || openedPaste;
		const textBeforeInput = this.getText();
		const keybindings = getKeybindings();
		const armed = this.syncSuggestionArming();
		this.autoOpenPending = false;
		if (!armed && super.isShowingAutocomplete()) {
			const moves = (["tui.select.up", "tui.select.down", "tui.select.pageUp", "tui.select.pageDown"] as const).some(
				(action) => keybindings.matches(data, action),
			);
			// Down moves into the list: it selects the first row rather than skipping it.
			if (moves) {
				this.suggestionArmed = true;
				return;
			}
			if (keybindings.matches(data, "tui.input.tab")) this.suggestionArmed = true;
			else if (keybindings.matches(data, "tui.select.confirm")) {
				// Nothing is selected, so Enter submits the line as typed.
				this.suggestionEngine().cancelAutocomplete?.();
				this.autocompleteDockOpen = false;
			}
		}
		const acceptsSuggestion =
			keybindings.matches(data, "tui.input.tab") || keybindings.matches(data, "tui.select.confirm");
		if (acceptsSuggestion && this.suggestionsAreStale()) {
			// Enter then submits the line as typed and Tab asks again, instead of applying a row to text it was not built for.
			this.suggestionEngine().cancelAutocomplete?.();
			this.autocompleteDockOpen = false;
			if (keybindings.matches(data, "tui.input.tab") && this.getText().trimStart().startsWith("/")) {
				this.reopenSuggestions();
				return;
			}
		} else if (acceptsSuggestion && this.isShowingAutocomplete() && this.selectedSuggestion()?.disabledReason) {
			// A row that refuses keeps the list and the reason under it. Closing would strand a partial `/co` on the composer.
			return;
		} else this.suggestionsAreStale();
		const killsText = KILL_ACTIONS.some((action) => keybindings.matches(data, action));
		const closesSuggestions =
			keybindings.matches(data, "tui.select.cancel") ||
			keybindings.matches(data, "tui.input.tab") ||
			keybindings.matches(data, "tui.select.confirm");
		if (closesSuggestions) this.autocompleteDockOpen = false;
		// Pi expands and trims the buffer immediately before onSubmit. Envelope a
		// pasted bang draft for that synchronous handoff so the Bash parser can
		// distinguish it from a typed operator; the submit controller unwraps it
		// before sending the literal prompt onward.
		if (this.startsWithLiteralOperator() && keybindings.matches(data, "tui.input.submit")) {
			const pastedText = this.getTextForSubmit();
			this.pastedBangOffsets.clear();
			this.bracketedPasteActive = false;
			super.setText(pastedText);
			super.handleInput(data);
			return;
		}
		const completingDirectory =
			this.isShowingAutocomplete() &&
			(keybindings.matches(data, "tui.input.tab") || keybindings.matches(data, "tui.select.confirm"));
		const textBeforeCompletion = completingDirectory ? this.getText() : "";
		// Enter on a slash suggestion only completes it. Pi's Enter also submits when the completed
		// token begins with "/", which would run `/export /tmp/x` from a path row before the operator
		// confirmed it, so the row is accepted through the Tab route and the line waits for Enter.
		const slashRow =
			completingDirectory && keybindings.matches(data, "tui.select.confirm") && this.getText().trimStart().startsWith("/")
				? this.selectedSuggestion()
				: null;
		const completesSlashRow = slashRow !== null;
		// A command row that runs bare is the one row Enter runs: `/con` Enter opens the context view.
		// A bare `/` typed no command, so its first row is not a choice: Enter only completes it.
		const typedCommand = /^\/(\S*)/u.exec(textBeforeCompletion.trimStart())?.[1] ?? "";
		const runsCommandRow = slashRow?.kind === "command" && slashRow.runsBare === true && typedCommand.length > 0;
		super.handleInput(completesSlashRow ? "\t" : data);
		// A row that left the line as typed (`/model claude-sonnet-5.5` typed in full) has nothing for
		// the operator to confirm, so the same Enter submits instead of being swallowed by the list.
		const submitsUnchanged =
			completesSlashRow && (runsCommandRow || (this.getText() === textBeforeCompletion && !this.isShowingAutocomplete()));
		if (submitsUnchanged) super.handleInput(data);
		if (killsText) this.followSuggestionsAfterKill(textBeforeInput);
		if (completingDirectory && !submitsUnchanged && this.getText() !== textBeforeCompletion) {
			if (cursorEndsDirectoryPath(this)) {
				// Directory rows are submenus on the same provider. Re-open immediately
				// after acceptance so ↑/↓ continues in the child tree without requiring
				// a second Tab. Pi's provider request remains the only completion path.
				super.handleInput("\t");
			} else if (cursorAwaitsSlashArgument(this)) {
				this.reopenSuggestions(true);
			}
		} else if (data === " " && !pasteMutation && !super.isShowingAutocomplete() && cursorAwaitsSlashArgument(this)) {
			// A space after a command or subcommand asks what comes next.
			this.reopenSuggestions(true);
		}
		const textAfterInput = this.getText();
		// A parked draft that came back during this key is still untouched.
		if (textAfterInput !== textBeforeInput && this.parkedDraft === parkedBeforeInput) this.restoredDraft = false;
		this.pastedBangOffsets = remapPastedBangOffsets(
			textBeforeInput,
			textAfterInput,
			this.pastedBangOffsets,
			pasteMutation,
		);
		if (openedPaste) this.bracketedPasteActive = true;
		if (closedPaste) this.bracketedPasteActive = false;
		if (this.parkedDraft !== null && this.getText().length === 0) this.setText("");
		if (pasteMutation && textAfterInput !== this.getExpandedText()) {
			// A large paste is represented by an opaque visible token. Remember the
			// inserted token through edits and undo, without depending on its format.
			let start = 0;
			while (
				start < textBeforeInput.length &&
				start < textAfterInput.length &&
				textBeforeInput[start] === textAfterInput[start]
			)
				start++;
			let oldEnd = textBeforeInput.length,
				end = textAfterInput.length;
			while (oldEnd > start && end > start && textBeforeInput[oldEnd - 1] === textAfterInput[end - 1]) {
				oldEnd--;
				end--;
			}
			const token = textAfterInput.slice(start, end).trimStart();
			if (token && !token.startsWith("!")) this.pastedOperatorTokens.add(token);
		}
	}

	override setText(text: string): void {
		this.revision += 1;
		this.autoOpenPending = false;
		this.autocompleteDockOpen = false;
		this.pastedOperatorTokens.clear();
		this.pastedBangOffsets.clear();
		this.bracketedPasteActive = false;
		this.restoredDraft = false;
		this.boardSteer = null;
		const sent = this.sentSteer;
		this.sentSteer = null;
		// A refused steer comes back with the address it was sent with, and it hides again.
		if (sent !== null && text.trimStart().startsWith(`@${sent.runId}`)) {
			this.boardSteer = sent;
			super.setText(
				text
					.trimStart()
					.slice(sent.runId.length + 1)
					.trimStart(),
			);
			return;
		}
		if (text.length === 0 && this.parkedDraft !== null) {
			const parked = this.parkedDraft;
			this.parkedDraft = null;
			this.setRestoredText(parked);
			return;
		}
		super.setText(text);
	}
}
