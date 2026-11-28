// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * The permission card's rows: the identity and target rows, the answers and reading keys, the timer and plan rows,
 * and the card parts the body lays out at a width.
 */

import { formatCountdown } from "../core/format-time.js";
import { tierPolicy } from "../core/presentation-tier.js";
import {
	actionClassWords,
	dispatchPlanHeadline,
	reversibilityWords,
	SHELL_EGRESS_EFFECT_TEXT,
	SHELL_EGRESS_RULE_ID,
	safetyNetRailText,
	UNREAD_COMMAND_EFFECT,
	unansweredWords,
} from "../core/views/approval-words.js";
import type { DecisionPresentation } from "../domains/safety/decision-presentation.js";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "../engine/tui.js";
import type { ApprovalRequestView } from "../session-control/approval-request-view.js";
import { CARD_GUTTER } from "./card.js";
import {
	type PlanSummary,
	planLimits,
	planRoute,
	planRouteSources,
	planScope,
	readDispatchPlan,
} from "./dispatch-plan-summary.js";
import { mutationFactsLine, targetWithoutPayloadSize } from "./mutation-preview.js";
import { MUTATION_PREVIEW_KEY, PERMISSION_TERMS_KEY, permissionKeyLabel } from "./permission-hint.js";
import type { CardCountdown } from "./permission-overlay-model.js";
import {
	compactCountdownClause,
	FUNCTION_GLYPH,
	HELD_WINDOW_WARNING_MS,
	isFileMutationTool,
	isWorkerWindow,
	permissionChoices,
	permissionDecisionPresentation,
	permissionRiskTone,
	taskRowValue,
	workerGrantAuthority,
} from "./permission-overlay-model.js";
import type { Choice, Fact, PancodeTheme, Tone } from "./theme/index.js";
import {
	chip,
	chipRow,
	chipRows,
	choiceConsequence,
	choiceLead,
	choiceRows,
	commandBlock,
	factRows,
	functionText,
	GLYPH,
	holdSpaces,
	keyCap,
	padAnsi,
	pancodeTheme,
	releaseSpaces,
	sectionRule,
	toneRole,
	toolFunction,
} from "./theme/index.js";
import { keyName } from "./theme/labels.js";

/** The tool as the transcript draws it: its function glyph and its function color. */
function toolChip(theme: PancodeTheme, tool: string): string {
	const kind = toolFunction(tool);
	return functionText(theme, kind, `${FUNCTION_GLYPH[kind]} ${tool}`);
}

/** The axis that asked, in the words the parked row and the notice use. */
function axisText(view: ApprovalRequestView): string {
	return view.axis.kind === "net" ? safetyNetRailText(view.axis.ruleId) : `${view.axis.level} autonomy`;
}

/**
 * The first row: the tool, the action class in its risk tone, and the rule
 * that fired. Everything an operator needs to place the ask before reading
 * the command. When the three do not fit the row, the rule moves to its own
 * fact row below rather than being clipped, and the tool and class wrap, so
 * nothing that explains the ask is ever cut.
 */
export function identityRow(
	theme: PancodeTheme,
	view: ApprovalRequestView,
	presentation: DecisionPresentation,
	width: number,
): { rows: string[]; ruleFact: Fact | null } {
	const risk = permissionRiskTone(view.actionClass, view.exposure);
	const axisTone: Tone = presentation.semanticToken === "warning" ? "warning" : "muted";
	const kind = toolFunction(view.tool);
	// What the call does, in words (`runs a command`), not its class name (`execute action`).
	const classWords =
		view.axis.kind === "net" && view.axis.ruleId === SHELL_EGRESS_RULE_ID
			? SHELL_EGRESS_EFFECT_TEXT
			: actionClassWords(view.actionClass);
	// `write · write action` said the word twice. When the tool and its class
	// share the word, the tool chip alone carries it, in the risk tone, behind
	// the function glyph the transcript uses for that tool.
	const shared = view.actionClass === view.tool;
	const tool = shared
		? `${functionText(theme, kind, FUNCTION_GLYPH[kind])} ${theme.style(toneRole(risk), view.tool, { bold: true })}`
		: toolChip(theme, view.tool);
	const action = shared ? null : theme.style(toneRole(risk), classWords, { bold: true });
	const axis = chip(theme, axisText(view), axisTone);
	const full = chipRow(theme, [tool, action, axis], Number.POSITIVE_INFINITY);
	if (visibleWidth(full) <= width) return { rows: [full], ruleFact: null };
	// Tool and class wrap rather than clip when even they do not fit: in the
	// open inspection view nothing else names the class.
	return {
		rows: chipRows(theme, [tool, action], width),
		ruleFact: { label: "asked under", value: axisText(view), tone: axisTone },
	};
}

/**
 * The target in a gutter: the command or path in the strongest reading
 * color, folded at spaces and then at separators, never clipped, because the
 * last token of a path is the one that says what is touched.
 */
export function targetBlock(theme: PancodeTheme, target: string, risk: Tone, width: number): string[] {
	return commandBlock(theme, target, width, { tone: risk });
}

/**
 * The choices on as few rows as they take: `[Enter] allow: runs this one
 * call · [Esc] deny: skips it · [alt+x] stop: ends the turn`, wrapped between
 * choices where it can be, never between a key and its verb, and a choice too
 * long for its row hangs its consequence under the verb. Every consequence stays.
 */
function compactChoiceRows(
	theme: PancodeTheme,
	choices: ReadonlyArray<Choice>,
	width: number,
	reading: ReadonlyArray<ReadingKey> = [],
): string[] {
	const parts = [
		...choices.map((choice): string | string[] => {
			const lead = choiceLead(theme, choice);
			const head = holdSpaces(`${lead.cap} ${lead.verb}`);
			const one = `${head}${choiceConsequence(theme, choice, `: ${choice.consequence}`)}`;
			if (visibleWidth(one) <= width) return one;
			// Too long for its row: the consequence starts beside the verb and hangs under it, so the key and verb never
			// stand on a row alone. Under 44 cells (W1) it hangs by 2, a row the reading form cannot spare otherwise.
			const capWidth = visibleWidth(lead.cap) + 1;
			const indent = width < 44 || capWidth > Math.floor(width / 3) ? 2 : capWidth;
			const words = choice.consequence.split(" ");
			const firstRoom = width - visibleWidth(head) - 2;
			let first = "";
			while (words.length > 0 && visibleWidth(`${first} ${words[0]}`.trim()) <= firstRoom) {
				first = `${first} ${words.shift()}`.trim();
			}
			// No whole word fits beside the verb (a path): fold the word after a separator, or after its first cells.
			const opening = words[0];
			if (first.length === 0 && opening !== undefined && firstRoom > 0) {
				const fold = Math.max(...["/", "-", "_", ".", ","].map((sep) => opening.lastIndexOf(sep, firstRoom - 1)));
				const at = fold >= 0 ? fold + 1 : firstRoom;
				first = opening.slice(0, at);
				words[0] = opening.slice(at);
				if (words[0].length === 0) words.shift();
			}
			const rest = words.length === 0 ? [] : wrapTextWithAnsi(words.join(" "), Math.max(1, width - indent));
			return [
				`${head}${choiceConsequence(theme, choice, first.length > 0 ? `: ${first}` : ":")}`,
				...rest.map((row) => `${" ".repeat(indent)}${choiceConsequence(theme, choice, row)}`),
			];
		}),
		...readingParts(theme, reading),
	];
	return joinChoiceUnits(theme, parts, width);
}

/** A key that reads the call rather than answering it. */
interface ReadingKey {
	key: string;
	verb: string;
}

/**
 * The terms key, and the inspect key when the call has something local to
 * read. A rail 40 columns wide holds two short entries, and the answer keys
 * and the scroll arrows outrank these, so a narrow card names them in its own
 * choice rows instead of leaving them on no surface at all.
 */
function readingKeys(inspectable: boolean): ReadingKey[] {
	return [
		{ key: permissionKeyLabel(PERMISSION_TERMS_KEY), verb: "terms" },
		...(inspectable ? [{ key: permissionKeyLabel(MUTATION_PREVIEW_KEY), verb: "inspect" }] : []),
	];
}

function readingParts(theme: PancodeTheme, reading: ReadonlyArray<ReadingKey>): string[] {
	return reading.map((entry) => holdSpaces(`${keyCap(theme, entry.key)} ${theme.fg("muted", entry.verb)}`));
}

/**
 * What the call acts on, in its gutter: the command or path, or for a plan
 * what the plan does. Every view of the card shows it, so no answer key is
 * ever on screen without the thing it answers.
 */
export function cardTargetRows(theme: PancodeTheme, view: ApprovalRequestView, width: number): string[] {
	const risk = permissionRiskTone(view.actionClass, view.exposure);
	// A plan card names the call by what the plan does; its raw arguments (`roster=<string 7 bytes>`) are in the inspector.
	const plan = view.artifact?.kind === "dispatch-plan" ? readDispatchPlan(view.artifact.text) : null;
	const targetText = plan !== null ? dispatchPlanHeadline(plan) : targetWithoutPayloadSize(view.target, view.mutation);
	if (targetText === undefined || targetText.length === 0) return [];
	return plan !== null
		? commandBlock(theme, targetText, width, { tone: risk, prose: true })
		: targetBlock(theme, targetText, risk, width);
}

/**
 * Key entries joined with a divider and broken between entries, never inside
 * a key's name and never on a dangling divider: at 40 columns the wrapped
 * paragraph ended rows on `deny ·` and `terms ·`.
 */
function joinChoiceUnits(
	theme: PancodeTheme,
	units: ReadonlyArray<string | ReadonlyArray<string>>,
	width: number,
): string[] {
	const divider = theme.fg("divider", ` ${GLYPH.sep} `);
	const rows: string[] = [];
	let current = "";
	for (const unit of units) {
		// A choice already laid out on its own rows starts a row and closes on its last.
		if (typeof unit !== "string") {
			if (current.length > 0) rows.push(current);
			rows.push(...unit.slice(0, -1));
			current = unit.at(-1) ?? "";
			continue;
		}
		const joined = current.length === 0 ? unit : `${current}${divider}${unit}`;
		if (visibleWidth(joined) <= width) {
			current = joined;
			continue;
		}
		if (current.length > 0) rows.push(current);
		if (visibleWidth(unit) <= width) {
			current = unit;
			continue;
		}
		const wrapped = wrapTextWithAnsi(unit, width);
		rows.push(...wrapped.slice(0, -1));
		current = wrapped.at(-1) ?? "";
	}
	if (current.length > 0) rows.push(current);
	return rows.map(releaseSpaces);
}

/** A sentence led by a status glyph, its later rows indented under the text rather than under the glyph. */
function hangingWrap(text: string, width: number): string[] {
	const rows = wrapTextWithAnsi(text, width);
	if (rows.length <= 1 || width < 12) return rows;
	return wrapTextWithAnsi(text, width - CARD_GUTTER.length).map((row, index) =>
		index === 0 ? row : `${CARD_GUTTER}${row}`,
	);
}

/** A target row whose next row is out of view, marked so it cannot be read as the end of the command. */
export function markContinued(row: string, width: number): string {
	return visibleWidth(row) + 1 + visibleWidth(GLYPH.ellipsis) <= width
		? `${row} ${GLYPH.ellipsis}`
		: truncateToWidth(row, width, GLYPH.ellipsis, false);
}

/** The sealed plan text as rows, each field line wrapped on its own. */
export function planTextRows(text: string, width: number): string[] {
	return text.split(/\r?\n/u).flatMap((line) => wrapArtifactLine(line, width));
}

function wrapArtifactLine(value: string, max: number): string[] {
	if (value.length <= max) return [value];
	const lines: string[] = [];
	let remaining = value;
	while (remaining.length > max) {
		const candidate = remaining.slice(0, max + 1);
		const whitespace = candidate.lastIndexOf(" ");
		const cut = whitespace >= Math.floor(max / 2) ? whitespace : max;
		lines.push(remaining.slice(0, cut));
		remaining = `    ${remaining.slice(cut).trimStart()}`;
	}
	lines.push(remaining);
	return lines;
}

/**
 * A label keeps its value's row at every width: a window edge between a label
 * and the value under it left a lone `rule` on the 40-column card.
 */
export const CARD_FACT_ROWS = { stack: "never" } as const;

/** The section title over each approval artifact's text. */
export const ARTIFACT_TITLES: Readonly<Record<NonNullable<ApprovalRequestView["artifact"]>["kind"], string>> = {
	"dispatch-plan": "Resolved dispatch plan",
	"settings-change": "Settings change",
	"mcp-skill": "MCP skill",
};

/** The parts of the card view, each a block the layout pins or windows (7.4). */
export interface PermissionCardParts {
	/** Actor, tool, class of action, autonomy. */
	identity: string[];
	/** The exact bytes under decision on the `▌` bar, then what the call is classified to do. */
	effect: string[];
	/** What a dispatch grants: its scope row and its limits row. */
	scope: string[];
	/** Everything else, in reading order: the window between the scope and the choices. */
	window: string[];
	/** Every choice with its consequence, one row each, the consequence wrapping under itself. */
	choices: string[];
	/** The same choices joined on as few rows as they take, every consequence kept. */
	compactChoices: string[];
	/** The terms and inspect keys, when the rail has no room for them; they follow the compact choices. */
	readingRows: string[];
	/** The timer sentence: remaining time, what expiry does, and who can hold it. */
	timer: string[];
	/** The timer as one clause for the position row. */
	timerClause: ReturnType<typeof compactCountdownClause>;
	/** Whether the choice rows also carry the terms and inspect keys. */
	readingFolded: boolean;
}

/**
 * The timer row, from the one deadline record the top rule also reads. It says only what is true: a held main call
 * has no limit, a held worker window still ends, and a window inside the worker is one no key reaches.
 */
function timerRows(
	theme: PancodeTheme,
	view: ApprovalRequestView,
	countdown: CardCountdown,
	hasDraft: boolean,
	width: number,
): string[] {
	if (countdown === null) return [];
	const answer = hasDraft ? "Backspace clears your draft, then Enter allows" : "Enter allows";
	// The card is the outermost layer, so its Esc is the one that denies.
	const escWords = "Esc denies";
	const workerOutcome = view.workerFallback === "fail" ? "worker-fail" : "worker-deny";
	if (countdown === "held") {
		return hangingWrap(theme.fg("annotation", `${GLYPH.phaseBlocked} No time limit now. ${answer}, ${escWords}.`), width);
	}
	if (isWorkerWindow(countdown)) {
		const unanswered = unansweredWords(formatCountdown(countdown.remainingMs), workerOutcome);
		const sentence = countdown.held
			? `${GLYPH.phaseBlocked} Extended for you. ${unanswered} ${answer}, ${escWords}.`
			: `${GLYPH.warn} ${unanswered} Any key holds the card.`;
		const tone = !countdown.held || countdown.remainingMs <= HELD_WINDOW_WARNING_MS ? "warning" : "annotation";
		return hangingWrap(theme.fg(tone, sentence), width);
	}
	if (view.origin.kind === "worker") {
		// The window runs inside the worker's process, so no key here can hold it.
		return hangingWrap(
			theme.fg(
				"warning",
				`${GLYPH.warn} ${unansweredWords(formatCountdown(countdown), workerOutcome)} No key pauses this.`,
			),
			width,
		);
	}
	return hangingWrap(
		theme.fg(
			"warning",
			`${GLYPH.warn} ${unansweredWords(formatCountdown(countdown), "deny-continue")} Any key holds the card.`,
		),
		width,
	);
}

/** One row per task: index, agent, the route when routes differ, and the task, cut with `…` to the row. */
function planTaskRows(theme: PancodeTheme, plan: PlanSummary, routesDiffer: boolean, width: number): string[] {
	const names = plan.members.map((member) => member.label ?? member.agent);
	const routes = plan.members.map(planRoute);
	const indexWidth = String(plan.members.length).length;
	const nameWidth = names.reduce((max, name) => Math.max(max, visibleWidth(name)), 0);
	const routeWidth = routesDiffer ? routes.reduce((max, route) => Math.max(max, visibleWidth(route)), 0) : 0;
	return plan.members.map((member, index) => {
		const task = (member.task ?? plan.sharedTask ?? "").replace(/\s+/gu, " ").trim();
		const lead = `${theme.fg("annotation", String(index + 1).padStart(indexWidth))} ${padAnsi(names[index] ?? "", nameWidth)}`;
		const route = routesDiffer ? `  ${theme.fg("annotation", padAnsi(routes[index] ?? "", routeWidth))}` : "";
		const row = `${lead}${route}${task.length > 0 ? `  ${task}` : ""}`;
		return visibleWidth(row) <= width ? row : truncateToWidth(row, width, GLYPH.ellipsis, false);
	});
}

/** The effect's first `rows` rows; the rest open the window, and the last pinned row says how many follow. */
export function pinEffect(
	theme: PancodeTheme,
	effect: ReadonlyArray<string>,
	rows: number,
	width: number,
): { pinned: string[]; overflow: string[] } {
	if (effect.length <= rows) return { pinned: [...effect], overflow: [] };
	const keep = Math.max(1, rows);
	const marker = (count: number): string =>
		theme.fg("annotation", `${GLYPH.ellipsis} ${count} more ${count === 1 ? "row" : "rows"}`);
	const last = effect[keep - 1] ?? "";
	const whole = marker(effect.length - keep);
	if (visibleWidth(last) + 1 + visibleWidth(whole) <= width) {
		return { pinned: [...effect.slice(0, keep - 1), `${last} ${whole}`], overflow: effect.slice(keep) };
	}
	// The cut row opens the window whole, so every byte stays reachable.
	const cutMarker = marker(effect.length - keep + 1);
	const cut = truncateToWidth(last, Math.max(1, width - visibleWidth(cutMarker) - 1), "", false);
	return { pinned: [...effect.slice(0, keep - 1), `${cut} ${cutMarker}`], overflow: effect.slice(keep - 1) };
}

/**
 * The card view's blocks for the width the frame gives it. The card leads with what changes per call: the tool and its
 * class in the risk tone, the exact bytes under decision, and for a dispatch the scope it grants. Then each key with its
 * consequence, so what allow, deny and stop do is read without opening anything. The standing terms of the decision
 * are the same on every card, so they fold behind the terms key.
 */
export function permissionCardParts(
	view: ApprovalRequestView,
	width: number,
	prose: number,
	advisory: string,
	countdown: CardCountdown,
	hasDraft: boolean,
	mainTurn: boolean | undefined,
	inspectable: boolean,
	settling: boolean,
): PermissionCardParts {
	const theme = pancodeTheme();
	const content = Math.max(8, Math.floor(width));
	// Facts and the exact call take the dock's width, so a path is not cut short of it; sentences stop at the callout.
	const callout = Math.max(8, Math.min(content, Math.floor(prose)));
	const presentation = permissionDecisionPresentation(view);
	const policy = tierPolicy();
	const identity = identityRow(theme, view, presentation, content);
	const plan = view.artifact?.kind === "dispatch-plan" ? readDispatchPlan(view.artifact.text) : null;
	const effectFacts: Fact[] = [];
	if (view.consequence !== undefined && view.consequence.length > 0) {
		effectFacts.push({ label: "effect", value: view.consequence.join("\n") });
	} else if ((view.tool === "bash" || view.tool === "run_script") && view.artifact === undefined) {
		// Silence here would read as "no notable effect" on exactly the commands PanCode cannot read.
		effectFacts.push({
			label: "effect",
			value: UNREAD_COMMAND_EFFECT,
			tone: "warning",
		});
	}
	// What the approval grants, from every task: never from the first alone. Write roots resolve against the session's
	// working directory, the workspace the TUI runs in.
	const scope = plan === null ? null : planScope(plan, process.cwd());
	const limits = plan === null ? null : planLimits(plan);
	const routeSources = plan === null ? null : planRouteSources(plan);
	const scopeFacts: Fact[] = [];
	if (scope !== null)
		scopeFacts.push({ label: "scope", value: scope.text, ...(scope.outside ? { tone: "error" as const } : {}) });
	if (routeSources?.perTask.some((value) => value !== null)) {
		scopeFacts.push({ label: "route", value: routeSources.shared ?? "differs per task; each is listed below the plan" });
	}
	if (limits?.perTask.some((value) => value !== null)) {
		scopeFacts.push({ label: "limits", value: limits.shared ?? "differ per task; each is listed below the plan" });
	}
	// Why before the rule's name: on a short card the reason (it writes outside this workspace) is what decides it.
	const lead: Fact[] = [];
	if (view.netReason !== undefined && view.netReason.length > 0) lead.push({ label: "why", value: view.netReason });
	if (identity.ruleFact !== null) lead.push(identity.ruleFact);
	const tail: Fact[] = [];
	if (presentation.reversibility === "limited" || presentation.reversibility === "unknown") {
		tail.push({ label: "undo", value: reversibilityWords(presentation.reversibility) });
	}
	// Size and digest stay on the card whether or not the operator opens the mutation, so the decision always
	// carries the identity of the bytes it applies to. Wrapped, never ellipsized.
	if (view.mutation !== undefined) {
		tail.push({
			label: "mutation",
			value: `${mutationFactsLine(view.mutation)} ${GLYPH.sep} ${permissionKeyLabel(MUTATION_PREVIEW_KEY)} reads it before you decide`,
		});
	} else if (view.origin.kind === "worker" && isFileMutationTool(view.tool)) {
		tail.push({
			label: "mutation",
			value:
				"no local preview: this call's arguments stay inside the worker, so you are approving the target above without inspecting the change.",
			tone: "warning",
		});
	}
	// The asking prompt is standard's evidence (3.2): every tier that describes every row shows it.
	if (view.task !== undefined && policy.listDescriptions === "all") {
		tail.push({ label: "asked", value: taskRowValue(view.task), fit: "clip" });
	}
	// The rail title names the model asking; the row earns its place only for a worker, whose id and run the operator
	// cannot read anywhere else.
	if (view.origin.kind === "worker") {
		tail.push({ label: "asked by", value: `worker ${view.origin.agentId} (run ${view.origin.runId})`, tone: "muted" });
		if (view.tool === "bash" && / … \+\d+ more characters$/u.test(view.target ?? "")) {
			tail.push({
				label: "cut",
				value: "this card shows the start of the call; the rest stays inside the worker and cannot be read here.",
				tone: "warning",
			});
		}
	}
	const authority = workerGrantAuthority(view);
	if (authority !== null) tail.push({ label: "authority", value: authority });
	if (plan !== null && limits !== null) {
		if (limits.shared === null) {
			for (const [index, value] of limits.perTask.entries()) {
				if (value !== null) tail.push({ label: `limits ${index + 1}`, value });
			}
		}
		if (routeSources !== null && routeSources.shared === null) {
			for (const [index, value] of routeSources.perTask.entries()) {
				if (value !== null) tail.push({ label: `route ${index + 1}`, value });
			}
		}
		if (plan.cost !== null) tail.push({ label: "cost", value: plan.cost });
		if (plan.deadline !== null) tail.push({ label: "deadline", value: plan.deadline });
		// Route forecasts are provenance: the tier that shows every argument row shows every fact row.
		if (policy.toolArgRow) {
			for (const [index, member] of plan.members.entries()) {
				for (const value of member.forecasts) tail.push({ label: `forecast ${index + 1}`, value });
			}
		}
	}
	// Dimmed and last among the facts: the only line on this card no part of the harness acted on.
	if (advisory.length > 0) tail.push({ label: "advisory", value: advisory, tone: "muted" });
	// One label column across the call's facts; the scope block keeps its own, as the grant it states is read alone.
	const column = (facts: ReadonlyArray<Fact>): number =>
		facts.reduce((max, fact) => Math.max(max, visibleWidth(fact.label)), 0);
	const widest = column([...effectFacts, ...lead, ...tail]);
	const rows = (facts: ReadonlyArray<Fact>, labelWidth = widest): string[] =>
		facts.length === 0
			? []
			: factRows(
					theme,
					facts.map((fact) => ({ ...fact, label: fact.label.padEnd(labelWidth) })),
					content,
					CARD_FACT_ROWS,
				);
	const planSection =
		plan === null
			? []
			: [
					sectionRule(theme, content, "Plan", { meta: `[${permissionKeyLabel(MUTATION_PREVIEW_KEY)}] every field` }),
					...planTaskRows(theme, plan, scope?.routesDiffer === true, content),
				];
	const artifactRows =
		view.artifact !== undefined && view.artifact.kind !== "dispatch-plan"
			? [sectionRule(theme, content, ARTIFACT_TITLES[view.artifact.kind]), ...planTextRows(view.artifact.text, content)]
			: view.artifact !== undefined && plan === null
				? [sectionRule(theme, content, "Resolved dispatch plan"), ...planTextRows(view.artifact.text, content)]
				: [];
	// Enter is ignored for a moment after the card opens, so a key typed for the prompt cannot allow it unread; its
	// row says so by going quiet meanwhile.
	const choices = permissionChoices(view, presentation, hasDraft, mainTurn).map((choice) =>
		settling && choice.key === "Enter" ? { ...choice, dimmed: true } : choice,
	);
	// The rail gives up its reading keys before its answer keys; when they overflow it, the choice rows carry them.
	const allReading = readingKeys(inspectable);
	const railText = [
		...allReading.map((entry) => `[${keyName(entry.key)}] ${entry.verb}`),
		`[${GLYPH.upDown}] scroll`,
	].join(` ${GLYPH.sep} `);
	const readingFolded = visibleWidth(railText) > callout - 3;
	const reading = readingFolded ? allReading : [];
	return {
		identity: identity.rows,
		effect: [...cardTargetRows(theme, view, content), ...rows(effectFacts)],
		scope: rows(scopeFacts, column(scopeFacts)),
		window: [...rows(lead), ...planSection, ...rows(tail), ...artifactRows],
		choices: [
			...choiceRows(theme, choices, callout),
			...(reading.length === 0 ? [] : joinChoiceUnits(theme, readingParts(theme, reading), callout)),
		],
		compactChoices: compactChoiceRows(theme, choices, callout),
		readingRows: reading.length === 0 ? [] : joinChoiceUnits(theme, readingParts(theme, reading), callout),
		timer: timerRows(theme, view, countdown, hasDraft, callout),
		timerClause: compactCountdownClause(view, countdown),
		readingFolded,
	};
}
