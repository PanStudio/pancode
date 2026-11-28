// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * A playbook run's approval card as plain data: the one projection of a compiled preview that every approval surface
 * reads. The TUI's fleet approval overlay, the dispatch permission card a model-started playbook parks on, ACP's
 * permission `_meta` and the model's `playbook.preview` answer all render it, so an operator approves the same steps,
 * routes, boundaries, budget and seal whoever asked. The compiled plan, the playbook and the commands stay host-side.
 */

import { renderUsdLimit, renderUsdSpend } from "../../core/telemetry/render.js";
import { type ExecutionPlanStep, executionPlanIsolationText, executionPlanStepScope } from "./execution-plan.js";
import type { FleetRunPreview, FleetRunPreviewStep } from "./fleet-run-preview.js";

/** A step's agent task on the card: one line, cut here so an artifact never carries a whole prompt body. */
const CARD_TASK_CHARS = 240;

export interface FleetRunCardRoute {
	targetId: string;
	model: string;
	nodeId: string;
	endpoint?: { label: string; limit: number };
}

export interface FleetRunCardStep {
	stepId: string;
	kind: "agent" | "code";
	scope: FleetRunPreviewStep["scope"];
	/** The scope in words, resolved against the run's isolation (a worktree run's writer writes the task worktree). */
	scopeText: ReturnType<typeof executionPlanStepScope>;
	agentId?: string;
	/** Absent on an agent step means the route did not resolve; code and replayed steps call no model. */
	route?: FleetRunCardRoute;
	commandId?: string;
	argv?: ReadonlyArray<string>;
	/** Declared write boundary: null is no claim, empty is the claim "changes nothing". */
	writes: ReadonlyArray<string> | null;
	loop?: { loopId: string; role: "check" | "repair"; attempt: number };
	/** The connection or profile the playbook pinned for this step. */
	target?: string;
	profile?: string;
	gate?: { path: string; commandId?: string };
	plan?: { roster: ReadonlyArray<string>; maxTasks: number; proposals: boolean };
	replayed?: true;
	/** An agent step's compiled task as one line, cut at {@link CARD_TASK_CHARS}; empty for code and replayed steps. */
	task: string;
}

export interface FleetRunCard {
	name: string;
	/** The approval identity: recipes, routes, commands, budget and replay. */
	planHash: string;
	/** The compiled DAG's own hash. */
	executionPlanHash: string;
	stepCount: number;
	isolation: "worktree" | "workspace";
	/** Where the run writes, in the words every tier pins. */
	isolationText: string;
	waves: ReadonlyArray<{ index: number; steps: ReadonlyArray<FleetRunCardStep> }>;
	budget: {
		ceilingUsd: number;
		currentUsd: number;
		playbookUsd: number | null;
		ceilingDisplay: string;
		currentDisplay: string;
		playbookDisplay: string | null;
		/** The budget line without its `budget:` label. */
		text: string;
	};
	resume?: {
		fromRunId: string;
		/** The prior run's workspace, or null when its record does not say. */
		fromCwd: string | null;
		replayed: ReadonlyArray<string>;
		/** The task worktree a resumed worktree run continues in, or null. */
		worktree: string | null;
	};
}

const SEP = " · ";

/** Control characters print as `?`, so no card field can move a terminal cursor or forge a line. */
function cardField(value: string): string {
	let result = "";
	for (const character of value) {
		const code = character.codePointAt(0) ?? 0;
		result += code < 32 || (code >= 127 && code <= 159) ? "?" : character;
	}
	return result;
}

function oneLine(text: string, max: number): string {
	const flat = cardField(text.replace(/\s+/gu, " ").trim());
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function cardStep(
	step: FleetRunPreviewStep,
	preview: FleetRunPreview,
	planSteps: ReadonlyMap<string, ExecutionPlanStep>,
): FleetRunCardStep {
	const planned = planSteps.get(step.stepId);
	const task = step.replayed !== true && planned?.kind === "agent" ? oneLine(planned.task, CARD_TASK_CHARS) : "";
	return {
		stepId: cardField(step.stepId),
		kind: step.kind === "code" ? "code" : "agent",
		scope: step.scope,
		scopeText: executionPlanStepScope(preview.plan, step.scope),
		...(step.agentId !== undefined ? { agentId: cardField(step.agentId) } : {}),
		...(step.route !== undefined
			? {
					route: {
						targetId: cardField(step.route.targetId),
						model: cardField(step.route.wireModelId),
						nodeId: cardField(step.route.nodeId),
						...(step.route.endpoint !== undefined
							? { endpoint: { label: cardField(step.route.endpoint.label), limit: step.route.endpoint.limit } }
							: {}),
					},
				}
			: {}),
		...(step.commandId !== undefined ? { commandId: cardField(step.commandId) } : {}),
		...(step.argv !== undefined ? { argv: step.argv.map(cardField) } : {}),
		writes: step.writes === undefined ? null : step.writes.map(cardField),
		...(step.loop !== undefined ? { loop: { ...step.loop, loopId: cardField(step.loop.loopId) } } : {}),
		...(step.target !== undefined ? { target: cardField(step.target) } : {}),
		...(step.profile !== undefined ? { profile: cardField(step.profile) } : {}),
		...(step.gate !== undefined
			? {
					gate: {
						path: cardField(step.gate.path),
						...("commandId" in step.gate ? { commandId: cardField(step.gate.commandId) } : {}),
					},
				}
			: {}),
		...(step.plan !== undefined
			? { plan: { roster: step.plan.roster.map(cardField), maxTasks: step.plan.maxTasks, proposals: step.plan.proposals } }
			: {}),
		...(step.replayed === true ? { replayed: true as const } : {}),
		task,
	};
}

/** The budget in one line: the session ceiling it is admitted under, the spend so far, the playbook's own ceiling. */
export function fleetRunBudgetText(preview: Pick<FleetRunPreview, "budget">): string {
	const { budget } = preview;
	const playbook =
		budget.playbookUsd === null
			? "playbook declares no ceiling"
			: `playbook ceiling ${renderUsdLimit(budget.playbookUsd)}`;
	const ceiling =
		budget.ceilingUsd === 0 ? "no session ceiling" : `${renderUsdLimit(budget.ceilingUsd)} session ceiling`;
	return `admitted under ${ceiling}, ${renderUsdSpend(budget.currentUsd, budget.pricing)} spent, ${playbook}`;
}

/** The worktree a resumed run continues in: the prior record's, else the prior run's own id. */
function resumedWorktree(preview: FleetRunPreview): string | null {
	if (preview.resume === undefined || preview.plan.isolation !== "worktree") return null;
	return preview.resume.record.worktree ?? preview.resume.record.id;
}

function isolationText(preview: FleetRunPreview): string {
	if (preview.plan.isolation !== "worktree") return "every step runs in this checkout";
	if (resumedWorktree(preview) !== null)
		return "every step runs in the task worktree the resumed run kept; this checkout does not change until it lands";
	return executionPlanIsolationText();
}

export function fleetRunCard(preview: FleetRunPreview): FleetRunCard {
	const planSteps = new Map((preview.plan.steps ?? []).map((step) => [step.id, step]));
	const worktree = resumedWorktree(preview);
	return {
		name: cardField(preview.name),
		planHash: preview.planHash,
		executionPlanHash: preview.plan.hash,
		stepCount: preview.plan.steps.length,
		isolation: preview.plan.isolation === "worktree" ? "worktree" : "workspace",
		isolationText: isolationText(preview),
		waves: preview.waves.map((wave) => ({
			index: wave.index,
			steps: wave.steps.map((step) => cardStep(step, preview, planSteps)),
		})),
		budget: {
			ceilingUsd: preview.budget.ceilingUsd,
			currentUsd: preview.budget.currentUsd,
			playbookUsd: preview.budget.playbookUsd,
			ceilingDisplay: renderUsdLimit(preview.budget.ceilingUsd),
			currentDisplay: renderUsdSpend(preview.budget.currentUsd, preview.budget.pricing),
			playbookDisplay: preview.budget.playbookUsd === null ? null : renderUsdLimit(preview.budget.playbookUsd),
			text: fleetRunBudgetText(preview),
		},
		...(preview.resume !== undefined
			? {
					resume: {
						fromRunId: cardField(preview.resume.fromRunId),
						fromCwd: preview.resume.record.cwd === undefined ? null : cardField(preview.resume.record.cwd),
						replayed: [...preview.resume.replayed.keys()].map(cardField),
						worktree: worktree === null ? null : cardField(worktree),
					},
				}
			: {}),
	};
}

/** A step's id with its loop position: `repair 1` when the loop is named after its role. */
export function fleetRunCardStepLabel(step: Pick<FleetRunCardStep, "stepId" | "loop">): string {
	if (step.loop === undefined) return step.stepId;
	return step.loop.loopId === step.loop.role
		? `${step.stepId} (${step.loop.role} ${step.loop.attempt})`
		: `${step.stepId} (${step.loop.loopId} ${step.loop.role} ${step.loop.attempt})`;
}

/** Who runs a step, as one word: the agent, the command, or the prior result a resume replays. */
export function fleetRunCardStepRunner(
	step: Pick<FleetRunCardStep, "replayed" | "kind" | "commandId" | "agentId">,
): string {
	if (step.replayed === true) return "replay";
	if (step.kind === "code") return step.commandId ?? "?";
	return step.agentId ?? "?";
}

/** The declared boundary as one phrase: an empty allowlist is a claim, not an absence. */
export function fleetRunWriteBoundary(writes: ReadonlyArray<string> | null): string {
	if (writes === null) return "writes unenforced";
	if (writes.length === 0) return "writes nothing";
	return `writes ${writes.join(", ")}`;
}

/** An argv as a shell would show it: bare words bare, anything else quoted exactly. */
export function fleetRunArgvText(argv: ReadonlyArray<string>): string {
	return argv.map((arg) => (/^[\w./:=@%+-]+$/u.test(arg) ? arg : JSON.stringify(arg))).join(" ");
}

function stepRouteText(step: FleetRunCardStep): string {
	if (step.replayed === true || step.kind === "code") return "";
	return step.route === undefined ? "route unresolved" : `${step.route.targetId}${SEP}${step.route.model}`;
}

function stepDetail(step: FleetRunCardStep): string[] {
	if (step.replayed === true) return ["    prior sealed result, not dispatched"];
	const scope = `    scope: ${step.scopeText}${SEP}${fleetRunWriteBoundary(step.writes)}`;
	if (step.kind === "code") {
		const where = step.argv === undefined ? `command ${step.commandId ?? "?"}` : fleetRunArgvText(step.argv);
		return [`    runs: ${where}${step.gate !== undefined ? `${SEP}gate path ${step.gate.path}` : ""}`, scope];
	}
	const facts = [
		...(step.route !== undefined ? [`node ${step.route.nodeId}`] : []),
		...(step.route?.endpoint !== undefined
			? [`endpoint ${step.route.endpoint.label} (${step.route.endpoint.limit})`]
			: []),
		...(step.target !== undefined ? [`connection ${step.target}`] : []),
		...(step.profile !== undefined ? [`profile ${step.profile}`] : []),
		...(step.gate !== undefined
			? [`gate path ${step.gate.path}${step.gate.commandId !== undefined ? `${SEP}run ${step.gate.commandId}` : ""}`]
			: []),
		...(step.plan !== undefined
			? [
					`roster ${step.plan.roster.join(", ")}${SEP}maxTasks ${step.plan.maxTasks}${step.plan.proposals ? `${SEP}proposals` : ""}`,
				]
			: []),
	];
	return [...(facts.length > 0 ? [`    ${facts.join(SEP)}`] : []), scope];
}

/**
 * The card as plain text: the dispatch permission card's artifact and the model's `playbook.preview` answer. One row
 * per step names its wave, runner and route, the rows under it where it runs and what it may write, and the last
 * line the seal approval binds.
 */
export function fleetRunCardText(card: FleetRunCard): string {
	const steps = card.waves.reduce((total, wave) => total + wave.steps.length, 0);
	const lines = [
		`playbook ${card.name}: ${steps} ${steps === 1 ? "step" : "steps"} in ${card.waves.length} ${card.waves.length === 1 ? "wave" : "waves"}`,
		`isolation: ${card.isolationText}`,
		`budget: ${card.budget.text}`,
	];
	if (card.resume !== undefined) {
		const from = `${card.resume.fromRunId} from ${card.resume.fromCwd ?? "(unknown workspace)"}`;
		const replayed = card.resume.replayed;
		lines.push(
			replayed.length === 0
				? `resumes: ${from}: no successful prefix to replay; every step runs`
				: `resumes: ${from}: replays ${replayed.length} step${replayed.length === 1 ? "" : "s"} (${replayed.join(", ")}), runs the rest`,
		);
		if (card.resume.worktree !== null) {
			lines.push(`worktree: continues in task worktree ${card.resume.worktree}, kept from run ${card.resume.fromRunId}`);
		}
	}
	for (const wave of card.waves) {
		for (const step of wave.steps) {
			const route = stepRouteText(step);
			const head = [`w${wave.index + 1}`, fleetRunCardStepLabel(step), fleetRunCardStepRunner(step), route]
				.filter((cell) => cell.length > 0)
				.join("  ");
			lines.push(step.task.length > 0 ? `${head}: ${step.task}` : head);
			lines.push(...stepDetail(step));
		}
	}
	lines.push(
		`sealed: plan ${card.executionPlanHash.slice(0, 12)}, approval ${card.planHash.slice(0, 12)}: recipes, routes, commands, budget and replay cannot change after approval`,
	);
	return lines.join("\n");
}
