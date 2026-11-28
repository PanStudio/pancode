// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

/** The fleet plan card: plan progress, step rows, and the plan body. */
import type { OutputStyle } from "../core/defaults.js";
import { tierPolicy } from "../core/presentation-tier.js";
import { truncateToWidth, visibleWidth } from "../engine/tui.js";
import { sanitizeCallTargetText } from "../lib/call-target/call-target.js";
import { cardRail, cardRows } from "./card.js";
import {
	CARD_KV_KEY_WIDTH,
	cardKvKey,
	cardUnitsLine,
	cardWrappedValueLines,
	type DispatchBoardRow,
	dispatchStatusPresentation,
	SEP,
} from "./dispatch-row-model.js";
import type { FleetPlanRunView } from "./fleet-plan-runs.js";
import type { PancodeTheme, PancodeToken } from "./theme/index.js";
import { dotSep, functionText, GLYPH, pancodeTheme } from "./theme/index.js";

/** `2/2 steps`, then the first step that failed. Unsettled steps are not counted as anything yet. */
/** Why a plan ended without its steps settling, without the runner's own prefix. */
function planFailureWords(plan: FleetPlanRunView): string | null {
	return plan.failure === undefined ? null : sanitizeCallTargetText(plan.failure.replace(/^dispatch:\s*/u, ""));
}

/** Steps whose worker finished with a caveat its own card marks as a warning, such as a refused call. */
export function planWarnedStepCount(plan: FleetPlanRunView): number {
	return plan.steps.filter((step) => step.state === "passed" && (step.worker?.caveat ?? null) !== null).length;
}

export function planProgressText(plan: FleetPlanRunView, statusShown = false, withFailure = true): string {
	const done = plan.steps.filter((step) => step.state === "passed" || step.state === "replayed").length;
	const failed = plan.steps.find((step) => step.state === "failed" && !planStepStopped(plan, step.stepId));
	const live = plan.state === "running" || plan.state === "cancelling";
	const loops =
		live || plan.loops === undefined
			? ""
			: `${SEP}${plan.loops.resolved}/${plan.loops.total} ${plan.loops.total === 1 ? "loop" : "loops"} resolved`;
	// A settled plan with loops counts the steps that ran of those it planned, as `fleet list` does: its required count
	// leaves the loop steps out, so `1/1 steps` would hide a failed check and the repair after it (fleet finding 18).
	const ran = plan.steps.filter(
		(step) => step.state === "passed" || step.state === "failed" || step.state === "replayed",
	);
	const count =
		!live && plan.loops !== undefined
			? `${ran.length}/${plan.steps.length} steps ran${loops}`
			: `${live ? done : plan.succeededStepCount}/${plan.requiredStepCount} steps${loops}`;
	if (plan.state === "cancelling") {
		const stopping = plan.stoppedStepIds ?? [];
		return `${count}${SEP}${stopping.length > 0 ? `stopping ${stopping.join(", ")}` : "stopping before the next step"}`;
	}
	// Where a status cell already reads cancelled, repeating it on the count only doubles the word.
	if (plan.state === "cancelled") return statusShown ? count : `${count}${SEP}canceled`;
	if (plan.failure !== undefined) return withFailure ? `${count}${SEP}${planFailureWords(plan)}` : count;
	if (failed !== undefined) return `${count}${SEP}${failed.stepId} failed`;
	const warned = planWarnedStepCount(plan);
	return warned === 0 ? count : `${count}${SEP}${warned} with warnings`;
}

const PLAN_STEP_MARKS: Record<
	FleetPlanRunView["steps"][number]["state"],
	{ glyph: string; token: PancodeToken; word: string }
> = {
	pending: { glyph: GLYPH.queued, token: "annotation", word: "not run" },
	running: { glyph: GLYPH.running, token: "activity", word: "running" },
	passed: { glyph: GLYPH.ok, token: "success", word: "passed" },
	failed: { glyph: GLYPH.error, token: "error", word: "failed" },
	replayed: { glyph: GLYPH.ok, token: "annotation", word: "kept from the earlier run" },
};

/** A step the operator's stop cut short: whatever exit it reported, the stop is why it ended. */
function planStepStopped(plan: FleetPlanRunView, stepId: string): boolean {
	return (plan.state === "cancelling" || plan.state === "cancelled") && (plan.stoppedStepIds ?? []).includes(stepId);
}

/** One row per step: state first, because the step's name and command are what a narrow row can lose. */
function planStepLines(theme: PancodeTheme, plan: FleetPlanRunView, width: number): string[] {
	const nameWidth = Math.max(...plan.steps.map((step) => visibleWidth(step.stepId)));
	return plan.steps.map((step) => {
		const stopped = planStepStopped(plan, step.stepId) && step.state !== "passed";
		// The worker's own caveat rides the step, so a step that passed reads the refused call its run's row shows.
		const caveat = stopped ? null : (step.worker?.caveat ?? null);
		// A command step passed its exit check. A worker step only finished: nothing checked its work, and a caveat
		// on it is a warning, as its own card marks it.
		const mark = stopped
			? plan.state === "cancelling" && step.state === "running"
				? { glyph: GLYPH.cancelled, token: "warning" as const, word: "stopping" }
				: { glyph: GLYPH.cancelled, token: "annotation" as const, word: "stopped" }
			: step.state === "passed" && step.worker !== undefined
				? caveat !== null
					? { glyph: GLYPH.warn, token: "warning" as const, word: "finished" }
					: { ...PLAN_STEP_MARKS.passed, word: "done" }
				: PLAN_STEP_MARKS[step.state];
		// A step still pending at the end was never reached; while the plan runs it is only waiting.
		const word =
			stopped || step.state !== "pending"
				? mark.word
				: plan.state === "running" || plan.state === "cancelling"
					? "waiting"
					: plan.state === "unsettled"
						? "no result"
						: mark.word;
		// A step whose worker has ended is finishing while the plan records it, not still running.
		const finishing = !stopped && step.state === "running" && step.worker?.settled === true;
		// A stopped step's exit code is the signal the stop sent, not a result; its duration still says how far it got.
		const detail = stopped ? step.detail?.replace(/^exit -?\d+ · /u, "") : step.detail;
		const facts = [
			finishing ? "finishing" : word,
			...(caveat !== null ? [caveat] : []),
			...(detail !== undefined && detail !== caveat ? [detail] : []),
			step.label,
		];
		const lead = `${theme.fg(mark.token, mark.glyph)} ${theme.fg("body", step.stepId.padEnd(nameWidth))}  `;
		return truncateToWidth(
			`${lead}${theme.fg(mark.token, facts[0] ?? "")}${theme.fg("annotation", facts.length > 1 ? `${SEP}${facts.slice(1).join(SEP)}` : "")}`,
			width,
			GLYPH.ellipsis,
			false,
		);
	});
}

export function planCardBody(
	theme: PancodeTheme,
	row: DispatchBoardRow,
	plan: FleetPlanRunView,
	contentWidth: number,
): string[] {
	// Warned worker steps make the plan's status a warning here too, as on its row and its card.
	const presentation =
		plan.state === "passed" && planWarnedStepCount(plan) > 0
			? { glyph: GLYPH.warn, label: "done", token: "warning" as const, glyphToken: undefined }
			: dispatchStatusPresentation(row.status);
	const units = [
		`${theme.fg(presentation.glyphToken ?? presentation.token, presentation.glyph)} ${theme.fg(presentation.token, presentation.label)}`,
		theme.fg("body", planProgressText(plan, true, false)),
		...(plan.finishedAtMs === null
			? []
			: [
					plan.costText === null
						? theme.fg("body", "no model calls")
						: `${theme.fg("annotation", "cost")} ${theme.fg("body", plan.costText)}`,
				]),
	];
	const gutter = " ".repeat(CARD_KV_KEY_WIDTH + 1);
	const steps = planStepLines(theme, plan, Math.max(1, contentWidth - gutter.length));
	// The reason gets its own wrapped row: as one more status unit it was wider than the row and dropped whole.
	const why = planFailureWords(plan);
	return [
		cardUnitsLine(theme, "status", units, contentWidth),
		...(why === null ? [] : cardWrappedValueLines(theme, "why", theme.fg("error", why), contentWidth)),
		...steps.map((line, index) => `${index === 0 ? cardKvKey(theme, "steps") : gutter}${line}`),
		// The plan's step-by-step record lives in its event log, which a shell command prints; the row says so, so the
		// id reads as that command's argument rather than as a name.
		...cardWrappedValueLines(
			theme,
			"log",
			theme.fg("annotation", `pancode fleet events ${plan.rootId} prints its event log`),
			contentWidth,
		),
	];
}

/** The transcript's settled record of a plan, in the worker card's gutter grammar. */
export function renderFleetPlanCard(plan: FleetPlanRunView, width: number, style: OutputStyle = "standard"): string[] {
	const theme = pancodeTheme();
	const passed = plan.state === "passed";
	const cancelled = plan.state === "cancelled";
	const rail = cardRail();
	// A plan whose steps all ran but one carries a warning reads as its warned steps do, never as a clean pass.
	const warned = passed && planWarnedStepCount(plan) > 0;
	const tone = warned ? "warning" : passed ? "success" : cancelled ? "toolMetadata" : "error";
	const glyph = warned ? GLYPH.warn : passed ? GLYPH.ok : cancelled ? GLYPH.cancelled : GLYPH.error;
	const head = `${functionText(theme, "dispatch", GLYPH.workerHuman)} ${theme.fg("workerIdentity", `plan ${plan.name}`)}${dotSep(theme)}${theme.fg(tone, `${glyph} ${planProgressText(plan, false, false)}`)}`;
	const room = Math.max(1, width - 4);
	const why = planFailureWords(plan);
	const steps = planStepLines(theme, plan, room);
	const policy = tierPolicy(style);
	const limit = !policy.evidence ? 0 : policy.provenance ? 12 : 4;
	const focus = Math.max(
		0,
		plan.steps.findIndex((step) => step.state === "failed" || step.worker?.caveat != null),
	);
	const start = Math.max(0, Math.min(focus, steps.length - limit));
	const shown = steps.slice(start, start + limit);
	const hidden = steps.length - shown.length;
	return [
		truncateToWidth(head, width, GLYPH.ellipsis, false),
		...(why === null ? [] : cardRows(`${GLYPH.error} ${why}`, width, true, "error")),
		...shown.map((line) => `${rail}${line}`),
		`${rail}${theme.fg("annotation", truncateToWidth(`${hidden > 0 ? `${hidden} more steps${SEP}` : ""}/fleet for detail${!policy.evidence ? "" : `${SEP}${plan.costText === null ? "no model calls" : `cost ${plan.costText}`}`}`, room, GLYPH.ellipsis, false))}`,
	];
}
