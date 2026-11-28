// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * A batch whose tasks carry `id` or `depends_on` is a dependency plan: one approval-gated fleet plan whose steps
 * start once every step they depend on has succeeded, each with its predecessors' handoffs. The Scout continuation
 * seals the same artifact shape from a Scout split.
 */

import { isRecord } from "../core/type-guards.js";
import { AGENT_AUTOMATION_AUTHORITIES, type AgentAutomationAuthority } from "../domains/agents/spec.js";
import type { DispatchPlanTaskResolution, DispatchRequest } from "../domains/dispatch/contract.js";
import { compileExecutionPlan, type ExecutionPlan } from "../domains/dispatch/execution-plan.js";
import { confineGrantOnlyWriters, writerSetConflict } from "../domains/dispatch/writer-set.js";
import { type DispatchRejectedTask, timeoutMsArg } from "./dispatch-arguments.js";
import { normalizeDispatchAdmission } from "./dispatch-normalize.js";
import type { ResolvedDispatchPlanArtifact } from "./dispatch-plan.js";
import type { DispatchExecutionSnapshot, DispatchToolDeps } from "./dispatch-types.js";

type ResolvedPlanTask = ResolvedDispatchPlanArtifact["tasks"][number];
type DispatchSnapshotFields = Pick<
	DispatchExecutionSnapshot & { kind: "dispatch" },
	"requests" | "positions" | "rejectedTasks" | "notices" | "mode" | "review" | "compete" | "council"
>;

const STEP_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
/** Plan default when the dispatch domain does not report its worker limit; the Scout continuation uses the same. */
const DEFAULT_MAX_WORKERS = 4;

export interface DependencyTaskRef {
	id: string;
	dependsOn: ReadonlyArray<string>;
}

/** What a sealed dependency plan carries from admission to the runner. */
export interface PreparedDependencyPlan {
	artifact: ResolvedDispatchPlanArtifact;
	requests: DispatchRequest[];
	resolutions: DispatchPlanTaskResolution[];
	executionPlan: ExecutionPlan;
}

/** The admission controller's sealing stores and stages, lent to the dependency plan paths. */
export interface DependencyPlanAdmission {
	deps: DispatchToolDeps;
	state: {
		readonly taskResolutions: WeakMap<object, DispatchPlanTaskResolution>;
		readonly trustedExecutionPlans: WeakMap<Record<string, unknown>, ExecutionPlan>;
	};
	resolveTask(request: DispatchRequest, role: NonNullable<ResolvedPlanTask["role"]>, position: number): ResolvedPlanTask;
	costCeilingUsd(): number;
	markReservedPlan(args: Record<string, unknown>, artifact: ResolvedDispatchPlanArtifact): Record<string, unknown>;
	trustExecution(args: Record<string, unknown>, snapshot: DispatchExecutionSnapshot): Record<string, unknown>;
	dispatchExecutionSnapshot(args: Record<string, unknown>, fields: DispatchSnapshotFields): DispatchExecutionSnapshot;
	fail(args: Record<string, unknown>, error: unknown): Record<string, unknown>;
}

export function deepFreeze<T>(value: T): T {
	if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
	for (const child of Object.values(value)) deepFreeze(child);
	return Object.freeze(value);
}

/**
 * The batch's step ids and edges, or null when no task names `id` or `depends_on` (the batch then runs by its mode).
 * Every refusal names the task and the fix, because the caller is a model that will retry.
 */
export function dependencyTaskRefs(
	args: Record<string, unknown>,
): { ok: true; refs: DependencyTaskRef[] | null } | { ok: false; message: string } {
	const tasks = args.tasks;
	if (!Array.isArray(tasks) || !tasks.some((item) => isRecord(item) && ("id" in item || "depends_on" in item))) {
		return { ok: true, refs: null };
	}
	const refs: DependencyTaskRef[] = [];
	for (const [index, item] of tasks.entries()) {
		const id = isRecord(item) ? item.id : undefined;
		if (typeof id !== "string" || !STEP_ID.test(id)) {
			return {
				ok: false,
				message: `dispatch: a dependency plan names every task; task ${index + 1} needs an id of letters, digits, '.', '_' or '-' (at most 64, starting with a letter or digit)`,
			};
		}
		if (refs.some((ref) => ref.id === id)) return { ok: false, message: `dispatch: two tasks share the id '${id}'` };
		const dependsOn = isRecord(item) ? (item.depends_on ?? []) : [];
		if (!Array.isArray(dependsOn) || dependsOn.some((dependency) => typeof dependency !== "string")) {
			return { ok: false, message: `dispatch: task '${id}' depends_on must be an array of task ids` };
		}
		refs.push({ id, dependsOn: [...new Set(dependsOn as string[])] });
	}
	for (const ref of refs) {
		const unknown = ref.dependsOn.find((dependency) => !refs.some((candidate) => candidate.id === dependency));
		if (unknown !== undefined) {
			return {
				ok: false,
				message: `dispatch: task '${ref.id}' depends on '${unknown}', which no task in this batch is named`,
			};
		}
	}
	const cycle = dependencyCycle(refs);
	if (cycle !== null) {
		return { ok: false, message: `dispatch: depends_on forms a cycle (${cycle.join(" -> ")}); a plan must be acyclic` };
	}
	return { ok: true, refs };
}

function dependencyCycle(refs: ReadonlyArray<DependencyTaskRef>): string[] | null {
	const edges = new Map(refs.map((ref) => [ref.id, ref.dependsOn]));
	const state = new Map<string, "open" | "done">();
	const path: string[] = [];
	const visit = (id: string): string[] | null => {
		if (state.get(id) === "done") return null;
		if (state.get(id) === "open") return [...path.slice(path.indexOf(id)), id];
		state.set(id, "open");
		path.push(id);
		for (const dependency of edges.get(id) ?? []) {
			const found = visit(dependency);
			if (found !== null) return found;
		}
		path.pop();
		state.set(id, "done");
		return null;
	};
	for (const ref of refs) {
		const found = visit(ref.id);
		if (found !== null) return found;
	}
	return null;
}

function dependencyPlanShapeRefusal(
	args: Record<string, unknown>,
	requests: ReadonlyArray<DispatchRequest>,
	rejectedTasks: ReadonlyArray<DispatchRejectedTask>,
): string | null {
	if (args.mode !== undefined && args.mode !== "parallel") {
		return `dispatch: id and depends_on order the tasks themselves; drop mode=${String(args.mode)}, or drop id and depends_on to run the batch as ${String(args.mode)}`;
	}
	if (args.review !== undefined && args.review !== false) {
		return "dispatch: a dependency plan does not take review; add a reviewer task that depends_on the task to check";
	}
	if (args.detach === true)
		return "dispatch: a dependency plan runs attached, its steps start from this turn; drop detach";
	if (rejectedTasks.length > 0) {
		return `dispatch: a dependency plan runs every task or none; ${rejectedTasks
			.map((task) => `task ${task.position}: ${task.message}`)
			.join("; ")}`;
	}
	if (requests.some((request) => request.worktree === true)) {
		return "dispatch: dependency plan steps share one checkout so each sees its predecessors' changes; drop worktree";
	}
	if (requests.some((request) => request.externalReadRoot !== undefined)) {
		return "dispatch: a dependency plan reads inside the workspace only; dispatch the outside-root Scout on its own first";
	}
	return null;
}

function automationAuthority(capabilityClass: string): AgentAutomationAuthority | null {
	return (AGENT_AUTOMATION_AUTHORITIES as ReadonlyArray<string>).includes(capabilityClass)
		? (capabilityClass as AgentAutomationAuthority)
		: null;
}

/**
 * Admit a dependency plan: resolve every task's route like any batch member, compile the graph into a fleet
 * execution plan whose steps hold an authority grant only under yolo, and seal both for the runner. The plan always
 * parks for the operator at default autonomy, because its source is never null.
 */
export function admitDependencyPlan(
	admission: DependencyPlanAdmission,
	args: Record<string, unknown>,
	parsed: { requests: DispatchRequest[]; positions: number[]; rejectedTasks: DispatchRejectedTask[] },
	refs: ReadonlyArray<DependencyTaskRef>,
): Record<string, unknown> {
	try {
		const refusal = dependencyPlanShapeRefusal(args, parsed.requests, parsed.rejectedTasks);
		if (refusal !== null) return admission.fail(args, refusal);
		const specs = admission.deps.getAgentSpecs();
		const notices = normalizeDispatchAdmission({
			args,
			requests: parsed.requests,
			positions: parsed.positions,
			mode: "parallel",
			specs,
		});
		const yolo = admission.deps.getAutonomy?.() === "yolo";
		const resolved = parsed.requests.map((request, index) => {
			const ref = refs[(parsed.positions[index] ?? index + 1) - 1];
			if (ref === undefined) throw new Error("dispatch: dependency plan task ids are incomplete");
			const task = admission.resolveTask(request, "task", index + 1);
			const resolution = admission.state.taskResolutions.get(task);
			const spec = specs.find((candidate) => candidate.id === task.agent);
			if (resolution === undefined) throw new Error(`dispatch: task '${ref.id}' has no resolved route`);
			const authority = spec === undefined ? null : automationAuthority(spec.capabilityClass);
			if (spec === undefined || authority === null) {
				throw new Error(
					`dispatch: task '${ref.id}' runs '${task.agent}'; a dependency plan step runs a read-only, verification, artifact-write or workspace-edit recipe`,
				);
			}
			return { ref, request, task, resolution, authority, contract: spec.resultContract.kind };
		});
		const executionPlan = compileExecutionPlan({
			topology: "fleet",
			rootTask: `dependency plan: ${refs.map((ref) => ref.id).join(", ")}`,
			maxWorkers: Math.max(1, Math.min(admission.deps.dispatch.maxWorkers?.() ?? DEFAULT_MAX_WORKERS, refs.length)),
			...(args.writers === 1 ? { writers: 1 as const } : {}),
			onFailure: "stop",
			steps: resolved.map(({ ref, request, authority, contract, task }) => ({
				id: ref.id,
				agentId: task.agent,
				executionRole: request.executionRole,
				scope: authority === "read-only" || authority === "verification" ? "readonly" : "workspace",
				expectedResultContract: contract,
				requestedAuthority: authority,
				approvedAuthority: yolo ? authority : null,
				dependencies: [...ref.dependsOn],
				task: request.task,
			})),
		});
		if (args.writers !== 1) {
			for (const [index, wave] of executionPlan.waves.entries()) {
				const members = resolved.filter(({ ref }) => wave.includes(ref.id)).map(({ request }) => request);
				const conflict = writerSetConflict(members, specs);
				if (conflict !== null && !confineGrantOnlyWriters(members, specs)) {
					return admission.fail(args, `dispatch: dependency plan wave ${index + 1} (${wave.join(", ")}): ${conflict}`);
				}
			}
		}
		const basis = yolo ? "yolo-policy" : "operator-plan-approval";
		const prepared: PreparedDependencyPlan = {
			artifact: {
				version: 3,
				topology: "fleet",
				source: { kind: "dependency-plan", executionPlanHash: executionPlan.hash },
				maxWorkers: executionPlan.maxWorkers,
				onFailure: executionPlan.onFailure,
				tasks: resolved.map(({ ref, task, authority, contract }, index) => ({
					...task,
					stepId: ref.id,
					dependencies: [...ref.dependsOn],
					expectedResultContract: contract,
					authorityGrant: { requested: authority, basis },
					wave: executionPlan.waves.findIndex((wave) => wave.includes(ref.id)),
					role: "task" as const,
					position: index + 1,
				})),
				costCeilingUsd: admission.costCeilingUsd(),
				deadlineMs: timeoutMsArg(args) ?? null,
			},
			requests: parsed.requests,
			resolutions: resolved.map(({ resolution }) => resolution),
			executionPlan,
		};
		return sealDependencyPlan(admission, args, prepared, {
			positions: parsed.positions,
			...(notices.length > 0 ? { notices } : {}),
		});
	} catch (error) {
		return admission.fail(args, error);
	}
}

/** Reserve, seal and trust one compiled dependency plan; the runner executes exactly this plan or nothing. */
export function sealDependencyPlan(
	admission: DependencyPlanAdmission,
	args: Record<string, unknown>,
	prepared: PreparedDependencyPlan,
	fields: Pick<DispatchSnapshotFields, "positions" | "notices"> = {},
): Record<string, unknown> {
	for (const [index, task] of prepared.artifact.tasks.entries()) {
		const resolution = prepared.resolutions[index];
		if (resolution === undefined) throw new Error("dispatch: dependency plan route resolution is incomplete");
		admission.state.taskResolutions.set(task, resolution);
	}
	const marked = admission.markReservedPlan(args, prepared.artifact);
	admission.trustExecution(
		marked,
		admission.dispatchExecutionSnapshot(marked, {
			requests: prepared.requests,
			...fields,
			mode: "parallel",
			review: undefined,
			compete: undefined,
			council: undefined,
		}),
	);
	admission.state.trustedExecutionPlans.set(marked, deepFreeze(structuredClone(prepared.executionPlan)));
	return marked;
}
