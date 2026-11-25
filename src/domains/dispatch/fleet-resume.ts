// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import type { Playbook } from "../agents/playbook.js";
import { assignmentProcessOwnerAlive, getStoredAssignment } from "./assignment-store.js";
import { type ExecutionPlan, executionPlanIdentityHash } from "./execution-plan.js";
import type { ExecutionStepResult } from "./execution-scheduler.js";
import type { FleetRunRecord } from "./state.js";

export interface FleetResumeStepDiff {
	index: number;
	prior: unknown;
	current: unknown;
	priorId: string;
	currentId: string;
	/** The step fields whose values differ, sorted; empty when the step was added or removed. */
	fields: string[];
}

/**
 * One line per changed step naming what changed (`task`, `writes`, `commandId`, ...), so a refused resume never reads
 * `a -> a`. A hash that differs with every step equal changed a plan-level setting the record does not keep per step.
 */
export function describeFleetResumeDiff(diff: ReadonlyArray<FleetResumeStepDiff>): string[] {
	if (diff.length === 0)
		return [
			"every step matches; a plan-level setting changed (the task, maxWorkers, writers, isolation, onFailure or loops)",
		];
	return diff.map((entry) => {
		const step = `step ${entry.index + 1}`;
		if (entry.prior === "(missing)") return `${step}: ${entry.currentId} added`;
		if (entry.current === "(missing)") return `${step}: ${entry.priorId} removed`;
		const id = entry.priorId === entry.currentId ? entry.currentId : `${entry.priorId} -> ${entry.currentId}`;
		return `${step} ${id}: ${entry.fields.join(", ")} changed`;
	});
}

function changedStepFields(prior: unknown, current: unknown): string[] {
	if (typeof prior !== "object" || prior === null || typeof current !== "object" || current === null) return [];
	const before = prior as Record<string, unknown>;
	const after = current as Record<string, unknown>;
	return [...new Set([...Object.keys(before), ...Object.keys(after)])]
		.filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]))
		.sort();
}

export type FleetResumeRefusal =
	| { ok: false; reason: "fleet-name"; priorFleet: string; currentFleet: string }
	| { ok: false; reason: "workspace"; priorCwd: string; currentCwd: string }
	| { ok: false; reason: "running"; pid: number }
	| { ok: false; reason: "vars" }
	| {
			ok: false;
			reason: "plan-hash";
			priorHash: string;
			currentHash: string;
			diff: ReadonlyArray<FleetResumeStepDiff>;
	  };

export type FleetResumePlan = { ok: true; replayed: ReadonlyMap<string, ExecutionStepResult> } | FleetResumeRefusal;

function sortedVars(vars: Readonly<Record<string, string>>): string {
	return JSON.stringify(Object.entries(vars).sort());
}

function withoutEndpoint(step: unknown): unknown {
	if (typeof step !== "object" || step === null || !("endpoint" in step)) return step;
	const { endpoint: _endpoint, ...rest } = step;
	return rest;
}

function stepIdentity(step: unknown): string {
	if (typeof step === "string") return step;
	if (typeof step === "object" && step !== null && "id" in step && typeof step.id === "string") return step.id;
	return "(missing)";
}

function canonicalPath(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		// A workspace that no longer exists cannot match a live one by realpath;
		// the resolved spelling still compares it honestly.
		return resolve(path);
	}
}

/** Validate a prior record and retain its longest ordered successful prefix. */
export function planFleetResume(
	record: FleetRunRecord,
	plan: ExecutionPlan,
	playbook: Pick<Playbook, "name">,
	vars: Readonly<Record<string, string>>,
	workspaceRoot: string,
): FleetResumePlan {
	if (record.fleet !== playbook.name) {
		return { ok: false, reason: "fleet-name", priorFleet: record.fleet, currentFleet: playbook.name };
	}
	// The plan hash holds no absolute path, so without this a same-named fleet
	// in another project would replay that project's successful prefix here.
	if (canonicalPath(record.cwd) !== canonicalPath(workspaceRoot)) {
		return { ok: false, reason: "workspace", priorCwd: record.cwd, currentCwd: workspaceRoot };
	}
	// A root still executing would race its own resume over one workspace. A
	// null endedAt alone is not that proof: a crashed root never stamps it, and
	// resuming after a crash is the point. Only a live process lease is.
	const assignment = getStoredAssignment(record.id);
	if (
		assignment?.status === "running" &&
		assignment.processOwner !== undefined &&
		assignmentProcessOwnerAlive(assignment)
	) {
		return { ok: false, reason: "running", pid: assignment.processOwner.pid };
	}
	if (sortedVars(record.vars) !== sortedVars(vars)) return { ok: false, reason: "vars" };
	// Endpoint limits and the foreground count are bound into `hash` at route
	// preflight, so a busier endpoint must not read as a changed plan.
	const priorHash = record.planIdentityHash;
	const currentHash = executionPlanIdentityHash(plan);
	if (priorHash !== currentHash) {
		const priorSteps = record.planSteps;
		const width = Math.max(priorSteps.length, plan.steps.length);
		const diff: FleetResumeStepDiff[] = [];
		for (let index = 0; index < width; index += 1) {
			const prior = priorSteps[index] ?? "(missing)";
			const current = plan.steps[index] ?? "(missing)";
			if (JSON.stringify(withoutEndpoint(prior)) === JSON.stringify(withoutEndpoint(current))) continue;
			diff.push({
				index,
				prior,
				current,
				priorId: stepIdentity(prior),
				currentId: stepIdentity(current),
				fields: changedStepFields(withoutEndpoint(prior), withoutEndpoint(current)),
			});
		}
		return { ok: false, reason: "plan-hash", priorHash, currentHash, diff };
	}
	const priorByStep = new Map(record.steps.map((entry) => [entry.stepId, entry.result]));
	const replayed = new Map<string, ExecutionStepResult>();
	for (const step of plan.steps) {
		if (step.kind === "agent" && step.plan !== undefined) break;
		const result = priorByStep.get(step.id);
		if (result === undefined || !result.succeeded || !result.integrityValid) break;
		replayed.set(step.id, result);
	}
	return { ok: true, replayed };
}
