// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import {
	type ExecutionPlan,
	type ExecutionPlanStep,
	executionPlanIsolationText,
	executionPlanStepScope,
} from "../domains/dispatch/execution-plan.js";
import type { FleetRunPreviewInput, FleetRunPreviewRoute } from "../domains/dispatch/fleet-run-preview.js";
import { writeCliFailure } from "./lib/json-out.js";
import { inspectPlaybook } from "./playbook-preflight.js";
import { parsePlaybookVars, playbookVarsOrUndefined } from "./playbook-vars.js";

/**
 * The playbook-level kind of a compiled step. The execution plan knows only
 * `agent` and `code`; a version 5 `gate` or `plan` step compiles to an agent
 * step carrying `gate` or `plan` facts, and the graph names it as the author
 * wrote it.
 */
function playbookKind(step: ExecutionPlanStep): "agent" | "code" | "gate" | "plan" {
	if (step.kind === "code") return "code";
	if (step.gate !== undefined) return "gate";
	if (step.plan !== undefined) return "plan";
	return "agent";
}

/** Where an agent step's model call goes, as `fleet run` resolves it now; an error says why it could not. */
export type PlaybookGraphRouteResolver = (
	step: Parameters<NonNullable<FleetRunPreviewInput["resolveRoute"]>>[0],
) => FleetRunPreviewRoute | null;

type GraphRoute = { targetId: string; model: string; nodeId: string } | { unresolved: string };

function graphRoute(step: ExecutionPlanStep, resolveRoute: PlaybookGraphRouteResolver | undefined): GraphRoute | null {
	if (resolveRoute === undefined || step.kind !== "agent") return null;
	try {
		const route = resolveRoute({
			stepId: step.id,
			agentId: step.agentId,
			task: step.task,
			scope: step.scope,
			...(step.target !== undefined ? { target: step.target } : {}),
			...(step.profile !== undefined ? { profile: step.profile } : {}),
		});
		if (route === null) return { unresolved: "no dispatch route preview in this process" };
		return { targetId: route.targetId, model: route.wireModelId, nodeId: route.nodeId };
	} catch (error) {
		return { unresolved: error instanceof Error ? error.message : String(error) };
	}
}

function routeText(route: unknown): string {
	if (route === undefined) return "";
	const shown = route as GraphRoute;
	return "unresolved" in shown
		? ` route=unresolved reason=${JSON.stringify(shown.unresolved)}`
		: ` route=${shown.targetId} model=${shown.model}`;
}

function projectedStep(
	step: ExecutionPlanStep,
	plan: Pick<ExecutionPlan, "isolation">,
	resolveRoute?: PlaybookGraphRouteResolver,
): Record<string, unknown> {
	const route = graphRoute(step, resolveRoute);
	return {
		id: step.id,
		kind: playbookKind(step),
		...(step.kind === "agent" ? { agent: step.agentId } : { command: step.commandId }),
		...(step.kind === "agent" && step.gate !== undefined
			? { gate: { path: step.gate.path, command: step.gate.commandId } }
			: {}),
		...(step.kind === "agent" && step.plan !== undefined
			? { plan: { roster: [...step.plan.roster], maxTasks: step.plan.maxTasks, proposals: step.plan.proposals } }
			: {}),
		...(step.kind === "agent" && step.target !== undefined ? { target: step.target } : {}),
		...(step.kind === "agent" && step.profile !== undefined ? { profile: step.profile } : {}),
		...(route !== null ? { route } : {}),
		scope: executionPlanStepScope(plan, step.scope),
		writes: [...(step.writes ?? [])],
		dependencies: [...step.dependencies],
	};
}

/**
 * `pancode playbook graph` with each agent step's resolved route: the domains `fleet run` boots, loaded for route
 * preview only, so a step a `fleet.agentProfiles` entry places reads the target and model it will call.
 */
export async function runPlaybookGraphWithRoutes(args: ReadonlyArray<string>): Promise<number> {
	const [
		{ loadDomains },
		{ ensurePancodeState },
		{ ConfigDomainModule },
		{ ExtensionsDomainModule },
		{ PluginsDomainModule },
		{ InteropDomainModule },
		{ ResourcesDomainModule },
		{ ContextDomainModule },
		{ ProvidersDomainModule },
		{ SafetyDomainModule },
		{ createPromptsDomainModule },
		{ createAgentsDomainModule },
		{ loadSkills },
		{ createCliWorkerHooks },
		{ createTelemetryDomainModule },
		{ SchedulingDomainModule },
		{ createDispatchDomainModule },
		{ SessionDomainModule },
		{ fleetRouteResolver },
		{ agentRoleFactsResolver },
	] = await Promise.all([
		import("../core/domain-loader.js"),
		import("../domains/install/index.js"),
		import("../domains/config/module.js"),
		import("../domains/extensions/module.js"),
		import("../domains/plugins/module.js"),
		import("../domains/interop/module.js"),
		import("../domains/resources/module.js"),
		import("../domains/context/module.js"),
		import("../domains/providers/module.js"),
		import("../domains/safety/module.js"),
		import("../domains/prompts/module.js"),
		import("../domains/agents/module.js"),
		import("../domains/resources/skills/loader.js"),
		import("./worker-extension-hooks.js"),
		import("../domains/telemetry/module.js"),
		import("../domains/scheduling/module.js"),
		import("../domains/dispatch/module.js"),
		import("../domains/session/module.js"),
		import("../domains/dispatch/fleet-run-preview.js"),
		import("../domains/dispatch/execution-role.js"),
	]);
	ensurePancodeState();
	// Never started: the graph dispatches no worker, so no extension host runs and no hook is asked.
	const workerHooks = createCliWorkerHooks("playbook graph");
	const loaded = await loadDomains([
		ConfigDomainModule,
		ExtensionsDomainModule,
		PluginsDomainModule,
		InteropDomainModule,
		ResourcesDomainModule,
		ContextDomainModule,
		ProvidersDomainModule,
		SafetyDomainModule,
		createPromptsDomainModule({ noContextFiles: true }),
		createAgentsDomainModule({ loadSkills }),
		workerHooks.middlewareModule,
		createTelemetryDomainModule(),
		SchedulingDomainModule,
		createDispatchDomainModule({ workerSteering: false, workerHooks: workerHooks.workerHooks }),
		SessionDomainModule,
	]);
	try {
		const dispatch = loaded.getContract("dispatch");
		const agents = loaded.getContract("agents");
		const resolveRoute: PlaybookGraphRouteResolver =
			dispatch && agents
				? fleetRouteResolver(
						dispatch.preview,
						agentRoleFactsResolver((id) => agents.getSpec(id)),
					)
				: () => null;
		return runPlaybookGraph(args, resolveRoute);
	} finally {
		await loaded.stop();
		await workerHooks.dispose();
	}
}

export function runPlaybookGraph(args: ReadonlyArray<string>, resolveRoute?: PlaybookGraphRouteResolver): number {
	const { vars, rest, error } = parsePlaybookVars(args);
	const json = rest.includes("--json");
	const name = rest.find((arg) => !arg.startsWith("-"));
	const unknown = rest.find((arg, index) => (arg.startsWith("-") && arg !== "--json") || index > 1);
	if (name === undefined || unknown !== undefined || error !== undefined) {
		const flag = unknown?.startsWith("-") === true;
		writeCliFailure({
			path: ["playbook", "graph"],
			slug: flag ? "unknown_flag" : "usage",
			message:
				error ??
				(flag
					? `unknown flag: ${unknown}`
					: unknown !== undefined
						? `unexpected argument: ${unknown}`
						: "name a playbook: pancode playbook graph <name> [--var key=value ...] [--json]"),
			json,
		});
		return 2;
	}
	try {
		const { plan } = inspectPlaybook(name, playbookVarsOrUndefined(vars));
		const byId = new Map(plan.steps.map((step) => [step.id, step]));
		const waves = plan.waves.map((ids, index) => ({
			wave: index + 1,
			steps: ids.flatMap((id) => {
				const step = byId.get(id);
				return step === undefined ? [] : [projectedStep(step, plan, resolveRoute)];
			}),
		}));
		const loops = plan.loops.map((loop) => ({
			id: loop.id,
			check: loop.checkStepIds.map((id) => projectedStep(byId.get(id) as ExecutionPlanStep, plan, resolveRoute)),
			repair: loop.repairStepIds.map((id) => projectedStep(byId.get(id) as ExecutionPlanStep, plan, resolveRoute)),
		}));
		const isolation = plan.isolation === "worktree" ? { isolation: "worktree" as const } : {};
		if (json) {
			process.stdout.write(
				`${JSON.stringify({ playbook: name, planHash: plan.hash, ...isolation, waves, loops }, null, 2)}\n`,
			);
			return 0;
		}
		if (plan.isolation === "worktree") process.stdout.write(`isolation worktree: ${executionPlanIsolationText()}\n`);
		for (const wave of waves) {
			process.stdout.write(`wave ${wave.wave}\n`);
			for (const step of wave.steps) {
				const subject = step.kind === "code" ? `command=${step.command}` : `agent=${step.agent}`;
				const gate = step.gate as { path: string; command: string } | undefined;
				const plan = step.plan as { roster: string[]; maxTasks: number; proposals: boolean } | undefined;
				const detail =
					gate !== undefined
						? ` gate=${gate.path} run=${gate.command}`
						: plan !== undefined
							? ` roster=${JSON.stringify(plan.roster)} maxTasks=${plan.maxTasks}${plan.proposals ? " proposals" : ""}`
							: "";
				const route =
					step.target !== undefined
						? ` connection=${step.target}`
						: step.profile !== undefined
							? ` profile=${step.profile}`
							: "";
				process.stdout.write(
					`  ${step.id} kind=${step.kind} ${subject}${route}${routeText(step.route)} scope=${step.scope} writes=${JSON.stringify(step.writes)}${detail}\n`,
				);
			}
		}
		for (const loop of loops) {
			process.stdout.write(`loop ${loop.id}\n`);
			for (const step of loop.check)
				process.stdout.write(
					`  check ${step.id} kind=${step.kind}${routeText(step.route)} scope=${step.scope} writes=${JSON.stringify(step.writes)}\n`,
				);
			for (const step of loop.repair)
				process.stdout.write(
					`  repair ${step.id} kind=${step.kind}${routeText(step.route)} scope=${step.scope} writes=${JSON.stringify(step.writes)}\n`,
				);
		}
		return 0;
	} catch (error) {
		writeCliFailure({
			path: ["playbook", "graph"],
			slug: "not_found",
			message: error instanceof Error ? error.message : String(error),
			json,
		});
		// The code `playbook validate` and `fleet run <name>` refuse the same playbook with (SPEC 6.5).
		return 2;
	}
}
