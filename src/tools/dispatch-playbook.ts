// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * `dispatch(playbook={name, vars?, preview?, detach?})`: the main agent starts
 * a playbook the way the operator does with `/fleet run`. The call compiles
 * the same preview every surface approves, parks once on its card, and runs
 * through the session's fleet launcher, so the run gets the same durable root
 * and fleet_end result as one the operator started.
 */

import { resolve } from "node:path";
import { canonicalizeExistingPath } from "../core/path-canonical.js";
import type { TurnConstraints } from "../core/turn-constraints.js";
import { isRecord } from "../core/type-guards.js";
import { playbookTaskRefusal } from "../domains/agents/playbook-task.js";
import { type FleetRunCard, fleetRunCard, fleetRunCardText } from "../domains/dispatch/fleet-run-card.js";
import type { FleetRunLauncher, FleetRunObserver, FleetRunSettlement } from "../domains/dispatch/fleet-run-launcher.js";
import {
	compileFleetRunPreview,
	type FleetRunPreview,
	type FleetRunPreviewInput,
} from "../domains/dispatch/fleet-run-preview.js";
import { requestedWriteNone } from "../domains/dispatch/obligation.js";
import { canonicalWriteRoots } from "../domains/dispatch/writer-set.js";
import type { ToolCallDispatchLanding, ToolCallDispatchTask } from "../domains/middleware/types.js";
import { fleetEndAnswer } from "./monitor-fleet.js";

export interface PlaybookRef {
	readonly name: string;
	readonly vars: Readonly<Record<string, string>>;
	/** Validate and show the card; nothing is parked or started. */
	readonly preview: boolean;
	/** Return once the first step dispatches instead of awaiting the fleet end. */
	readonly detach: boolean;
}

const PLAYBOOK_FIELDS: ReadonlySet<string> = new Set(["name", "vars", "preview", "detach"]);
const SHAPE = 'playbook={"name":"<playbook>","vars":{"task":"<text>"}}';

/** The `playbook` argument, decoded strictly: it stands alone and every key it carries is one dispatch reads. */
export function playbookRefFromArgs(
	args: Readonly<Record<string, unknown>>,
): { ok: true; ref: PlaybookRef | null } | { ok: false; message: string } {
	if (!Object.hasOwn(args, "playbook")) return { ok: true, ref: null };
	const others = Object.keys(args).filter((key) => key !== "playbook");
	if (others.length > 0) {
		return {
			ok: false,
			message: `dispatch: playbook stands alone; it cannot combine with ${others.join(", ")}. A playbook names its own steps, agents and routes`,
		};
	}
	const value = args.playbook;
	if (!isRecord(value)) return { ok: false, message: `dispatch: playbook must be an object: ${SHAPE}` };
	const unknown = Object.keys(value).filter((key) => !PLAYBOOK_FIELDS.has(key));
	if (unknown.length > 0) {
		return {
			ok: false,
			message: `dispatch: playbook takes name, vars, preview and detach; unknown: ${unknown.join(", ")}`,
		};
	}
	if (typeof value.name !== "string" || value.name.trim().length === 0) {
		return { ok: false, message: `dispatch: playbook.name must name a playbook: ${SHAPE}` };
	}
	const vars: Record<string, string> = {};
	if (value.vars !== undefined) {
		if (!isRecord(value.vars)) {
			return { ok: false, message: "dispatch: playbook.vars must map each variable name to a string" };
		}
		for (const [key, entry] of Object.entries(value.vars)) {
			if (key.trim().length === 0 || typeof entry !== "string") {
				return { ok: false, message: "dispatch: playbook.vars must map each variable name to a string" };
			}
			vars[key] = entry;
		}
	}
	for (const flag of ["preview", "detach"] as const) {
		if (value[flag] !== undefined && value[flag] !== true) {
			return { ok: false, message: `dispatch: playbook.${flag} is true when given; omit it otherwise` };
		}
	}
	if (value.preview === true && value.detach === true) {
		return { ok: false, message: "dispatch: playbook.preview starts nothing, so it cannot combine with detach" };
	}
	return {
		ok: true,
		ref: { name: value.name.trim(), vars, preview: value.preview === true, detach: value.detach === true },
	};
}

/** Everything compiling a playbook needs from the session; the name and variables come from the call. */
export type PlaybookPreviewInput = Omit<FleetRunPreviewInput, "name" | "vars" | "resume">;

export type CompiledPlaybook =
	| { readonly ok: true; readonly preview: FleetRunPreview; readonly card: FleetRunCard; readonly text: string }
	| { readonly ok: false; readonly message: string };

/** The preview `/fleet run` would show for this call, or every reason it cannot run. */
export function compilePlaybookRun(ref: PlaybookRef, input: PlaybookPreviewInput): CompiledPlaybook {
	const result = compileFleetRunPreview({ ...input, name: ref.name, vars: ref.vars });
	if (!result.ok) {
		// The compiler words a missing variable for the command line; dispatch takes variables in playbook.vars.
		const missingVars = result.diagnostics.some((line) => line.includes("unresolved template variables"));
		return {
			ok: false,
			message: [
				`dispatch: playbook '${ref.name}' cannot run:`,
				...result.diagnostics.map((line) => `- ${line}`),
				...(missingVars ? [`pass every variable in playbook.vars, as in ${SHAPE}`] : []),
			].join("\n"),
		};
	}
	const refusal = playbookTaskRefusal(result.preview.playbook, ref.vars.task, "playbook.vars");
	if (refusal !== null) return { ok: false, message: `dispatch: ${refusal}` };
	const card = fleetRunCard(result.preview);
	return { ok: true, preview: result.preview, card, text: fleetRunCardText(card) };
}

/**
 * A detached run returns while the turn goes on, so a step writing the checkout would race the main agent the way
 * a detached checkout writer does. A worktree-isolated playbook writes its own task worktree and may detach.
 */
export function playbookDetachRefusal(preview: FleetRunPreview): string | null {
	if (preview.plan.isolation === "worktree") return null;
	const writer = preview.plan.steps.find((step) => step.scope === "workspace");
	if (writer === undefined) return null;
	return `dispatch: playbook '${preview.name}' cannot detach: step '${writer.id}' writes this checkout while the turn goes on. Run it attached (omit detach), or give the playbook isolation: worktree`;
}

/**
 * The workers an approved playbook starts, for the awaited hook phase: each agent step it dispatches (a replayed
 * step runs nothing), read-only by its scope or its recipe's class, writing its declared boundary under the run's
 * workspace, in the task worktree when the playbook isolates one.
 */
export function playbookHookLanding(
	preview: FleetRunPreview,
	workspaceRoot: string,
	capabilityClassOf: (agentId: string) => string | null,
): ToolCallDispatchLanding {
	const cwd = canonicalizeExistingPath(resolve(workspaceRoot));
	const worktree = preview.plan.isolation === "worktree";
	const tasks = preview.waves.flatMap((wave) =>
		wave.steps.flatMap((step): ToolCallDispatchTask[] => {
			if (step.kind !== "agent" || step.agentId === undefined || step.replayed === true) return [];
			const readOnly = requestedWriteNone({
				readOnly: step.scope === "readonly",
				capabilityClass: capabilityClassOf(step.agentId),
				hoareContract: false,
			});
			const writeRoots = readOnly ? [] : [...(step.writes ?? [])];
			return [
				{
					role: "task",
					agent: step.agentId,
					cwd,
					writeRoots,
					writeBoundaries: canonicalWriteRoots({ cwd, writeRoots }),
					worktree,
					readOnly,
				},
			];
		}),
	);
	return { kind: "tasks", mode: "playbook", tasks };
}

/** What a preview call answers: the card the operator would approve, and the call that starts it. */
export function playbookPreviewText(ref: PlaybookRef, text: string): string {
	const call = JSON.stringify({ name: ref.name, ...(Object.keys(ref.vars).length > 0 ? { vars: ref.vars } : {}) });
	return [
		`playbook ${ref.name}: preview only; nothing was started.`,
		text,
		"",
		`start it with dispatch(playbook=${call}); the operator approves this card first`,
	].join("\n");
}

export type PlaybookRunResult =
	| { readonly ok: true; readonly text: string; readonly rootId: string; readonly settlement: FleetRunSettlement | null }
	| { readonly ok: false; readonly message: string };

/**
 * Run an approved playbook on the session launcher. Attached, the call awaits the sealed fleet_end and answers
 * with it; detached, it answers once the first step dispatches and names the root `monitor` collects. A headless
 * run is always attached: the in-process orchestrator ends with the process.
 */
export async function runApprovedPlaybook(input: {
	launcher: FleetRunLauncher;
	preview: FleetRunPreview;
	detach: boolean;
	headless: boolean;
	turnConstraints?: TurnConstraints;
	/** The dispatch call that asked for the run; its steps read as model-asked. */
	toolCallId?: string;
	signal?: AbortSignal;
	observer?: FleetRunObserver;
}): Promise<PlaybookRunResult> {
	const { preview } = input;
	const detached = input.detach && !input.headless;
	const launch = input.launcher.launch({
		preview,
		origin: "model",
		...(detached ? { detached } : {}),
		...(input.turnConstraints !== undefined ? { turnConstraints: input.turnConstraints } : {}),
		...(input.toolCallId !== undefined ? { parentToolCallId: input.toolCallId } : {}),
		...(input.observer !== undefined ? { observer: input.observer } : {}),
	});
	if (launch.status === "refused") {
		return { ok: false, message: `dispatch: playbook ${preview.name} did not start: ${launch.reason}` };
	}
	const { rootId } = launch;
	if (detached) {
		const admission = await launch.admitted;
		if (admission.status !== "started") {
			return {
				ok: false,
				message: `dispatch: playbook ${preview.name} root=${rootId} did not start: ${admission.reason}`,
			};
		}
		return {
			ok: true,
			rootId,
			settlement: null,
			text: `playbook ${preview.name} started root=${rootId}; collect it with monitor(mode="wait" or "collect", run_id="${rootId}")`,
		};
	}
	const stopOnAbort = () => launch.stop("operator");
	if (input.signal?.aborted) stopOnAbort();
	input.signal?.addEventListener("abort", stopOnAbort, { once: true });
	try {
		const settlement = await launch.settled;
		const note =
			input.detach && input.headless ? ["headless: ran attached; a detached root would end with this process", ""] : [];
		return { ok: true, rootId, settlement, text: [...note, fleetEndAnswer(settlement.document)].join("\n") };
	} finally {
		input.signal?.removeEventListener("abort", stopOnAbort);
	}
}
