// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { deepStrictEqual, ok, strictEqual, throws } from "node:assert/strict";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import { sumPricing } from "../../src/core/telemetry/pricing.js";
import type { DispatchContract, DispatchRequest } from "../../src/domains/dispatch/contract.js";
import { agentRoleFactsResolver } from "../../src/domains/dispatch/execution-role.js";
import { executeFleetRun } from "../../src/domains/dispatch/fleet-run.js";
import { createFleetRunLauncher } from "../../src/domains/dispatch/fleet-run-launcher.js";
import { compileFleetRunPreview } from "../../src/domains/dispatch/fleet-run-preview.js";
import type { FleetRunOutcome } from "../../src/domains/dispatch/fleet-run-types.js";
import { writeFleetRunSync } from "../../src/domains/dispatch/state.js";
import { readDurableFleetPlans } from "../../src/interactive/fleet-plan-history.js";
import { createFleetPlanRuns } from "../../src/interactive/fleet-plan-runs.js";
import {
	createOverlayGeneralOpeners,
	type OverlayGeneralOpenersDeps,
} from "../../src/interactive/overlay-general-openers.js";
import { parseSlashCommand } from "../../src/session-control/slash-commands.js";
import { dispatchStubContext } from "../harness/dispatch-stub-context.js";
import { isolatePancodeEnv } from "../harness/scratch-env.js";

const noop = () => {};

test("a running fleet refuses a second /fleet run until it settles", async () => {
	const scratch = await isolatePancodeEnv("pancode-fleet-overlay-");
	try {
		const root = realpathSync(scratch.dir);
		const agents = dispatchStubContext({ settings: DEFAULT_SETTINGS }).getContract("agents");
		ok(agents);
		const notices: Array<[string, string]> = [];
		let opened = 0;
		let expectedPlanHash = "";
		let accept: (() => void) | undefined;
		let finish: (() => void) | undefined;
		let settingsReadable = false;
		const runLimits: unknown[] = [];
		const transitions = { state: "closed", handle: null, showPermission: () => false, close: noop };
		const deps: Partial<OverlayGeneralOpenersDeps> = {
			dispatch: {} as DispatchContract,
			agents,
			transitions: transitions as unknown as OverlayGeneralOpenersDeps["transitions"],
			getSessionMeta: () => ({ cwd: root }) as ReturnType<OverlayGeneralOpenersDeps["getSessionMeta"]>,
			terminal: { columns: 100 } as OverlayGeneralOpenersDeps["terminal"],
			requestRender: noop,
			stderr: noop,
			getSettings: () => {
				if (!settingsReadable) throw new Error("fixture: settings unreadable");
				return DEFAULT_SETTINGS;
			},
			closeOverlay: () => {
				transitions.state = "closed";
			},
			notify: (_level, text, key) => notices.push([key ?? "", text]),
			loadFleetSources: () => ({
				commands: null,
				playbook: {
					version: 3,
					name: "survey",
					description: "Survey fixture",
					path: join(root, "survey.md"),
					body: "Survey.",
					maxWorkers: 1,
					budgetUsd: null,
					onFailure: "stop",
					steps: [{ kind: "agent", id: "survey", agent: "coder", scope: "readonly", dependencies: [] }],
				} as never,
			}),
			openFleetRunApprovalOverlay: (_tui, options) => {
				opened += 1;
				ok(options.subject.ok, JSON.stringify(options.subject));
				expectedPlanHash = options.subject.preview.plan.hash.slice(0, 12);
				accept = options.onAccept;
				return {} as ReturnType<NonNullable<OverlayGeneralOpenersDeps["openFleetRunApprovalOverlay"]>>;
			},
			// The session's --delegate-tools limit reaches every worker the run starts.
			standingTurnConstraints: () => ({ delegatedTools: ["read"] }),
			runFleet: (input) => {
				input.onStarted?.();
				runLimits.push(input.turnConstraints);
				return new Promise<FleetRunOutcome>((resolve) => {
					finish = () =>
						resolve({
							cleanRun: true,
							succeededStepCount: 1,
							requiredStepCount: 1,
							totalCost: sumPricing([]),
						} as unknown as FleetRunOutcome);
				});
			},
		};
		const openers = createOverlayGeneralOpeners(deps as OverlayGeneralOpenersDeps);
		// A run whose arguments throw before it starts must not leave the
		// single-run guard set, or every later /fleet run reads as in flight.
		openers.startFleetRun("survey", {});
		ok(accept);
		throws(accept, /settings unreadable/);
		settingsReadable = true;
		openers.startFleetRun("survey", {});
		strictEqual(opened, 2, "the failed start left no run in flight");
		accept();
		strictEqual(notices.at(-1)?.[0], "fleet-run:started");
		// The started notice names the plan by the steps its waves run; the plan hash stays with the approval card.
		ok(notices.at(-1)?.[1].includes("plan survey started · 1 step running"));
		ok(!notices.at(-1)?.[1].includes(expectedPlanHash));
		deepStrictEqual(runLimits, [{ delegatedTools: ["read"] }]);
		openers.startFleetRun("survey", {});
		strictEqual(opened, 2, "no second approval while the first fleet runs");
		strictEqual(notices.at(-1)?.[0], "fleet-run:in-flight");
		ok(notices.at(-1)?.[1].includes("is still running"));
		ok(finish);
		finish();
		await new Promise((settle) => setImmediate(settle));
		strictEqual(notices.at(-1)?.[0], "fleet-run:settled");
		openers.startFleetRun("survey", {});
		strictEqual(opened, 3);
		deepStrictEqual(
			notices.map(([key]) => key),
			["fleet-run:started", "fleet-run:in-flight", "fleet-run:settled"],
		);
	} finally {
		scratch.restore();
	}
});

for (const outside of ["bash", "ledger"]) {
	test(`fleet approval refuses ${outside} outside the standing delegation ceiling`, async () => {
		const scratch = await isolatePancodeEnv("pancode-fleet-preview-scope-");
		try {
			const agents = dispatchStubContext({ settings: DEFAULT_SETTINGS }).getContract("agents");
			ok(agents);
			let refused = false;
			const constraints = { delegatedTools: ["read", "grep"] };
			const deps: Partial<OverlayGeneralOpenersDeps> = {
				agents,
				dispatch: {
					preview: (request: DispatchRequest) => {
						if (
							request.turnConstraints?.delegatedTools !== undefined &&
							(outside === "bash" || request.ledger !== undefined)
						) {
							deepStrictEqual(request.turnConstraints, constraints);
							throw new Error(`dispatch: worker tool surface exceeds the parent task's explicit scope: ${outside}`);
						}
						return undefined;
					},
				} as unknown as DispatchContract,
				standingTurnConstraints: () => constraints,
				transitions: { state: "closed", handle: null } as unknown as OverlayGeneralOpenersDeps["transitions"],
				getSessionMeta: () => ({ cwd: scratch.dir }) as ReturnType<OverlayGeneralOpenersDeps["getSessionMeta"]>,
				terminal: { columns: 100 } as OverlayGeneralOpenersDeps["terminal"],
				requestRender: noop,
				loadFleetSources: () => ({
					commands: null,
					playbook: {
						version: 3,
						name: "build",
						description: "Build",
						path: join(scratch.dir, "build.md"),
						body: "Build.",
						maxWorkers: 2,
						budgetUsd: null,
						onFailure: "stop",
						steps: ["build", "check"].map((id) => ({
							kind: "agent",
							id,
							agent: "coder",
							scope: "readonly",
							dependencies: [],
						})),
					} as never,
				}),
				openFleetRunApprovalOverlay: (_tui, options) => {
					strictEqual(options.subject.ok, false);
					if (!options.subject.ok) {
						ok(options.subject.diagnostics.some((text) => text.includes(`explicit scope: ${outside}`)));
						refused = true;
					}
					return {} as ReturnType<NonNullable<OverlayGeneralOpenersDeps["openFleetRunApprovalOverlay"]>>;
				},
			};
			createOverlayGeneralOpeners(deps as OverlayGeneralOpenersDeps).startFleetRun("build", {});
			ok(refused);
		} finally {
			scratch.restore();
		}
	});
}

test("a settled fleet names its loops, and a loop checkpoint reads as progress rather than an error", async () => {
	const scratch = await isolatePancodeEnv("pancode-fleet-overlay-loops-");
	try {
		const root = realpathSync(scratch.dir);
		const agents = dispatchStubContext({ settings: DEFAULT_SETTINGS }).getContract("agents");
		ok(agents);
		const notices: Array<[string, string, string]> = [];
		const errors: string[] = [];
		const infos: string[] = [];
		const cards: string[] = [];
		let accept: (() => void) | undefined;
		const transitions = { state: "closed", handle: null, showPermission: () => false, close: noop };
		const deps: Partial<OverlayGeneralOpenersDeps> = {
			dispatch: {} as DispatchContract,
			agents,
			transitions: transitions as unknown as OverlayGeneralOpenersDeps["transitions"],
			getSessionMeta: () => ({ cwd: root }) as ReturnType<OverlayGeneralOpenersDeps["getSessionMeta"]>,
			terminal: { columns: 100 } as OverlayGeneralOpenersDeps["terminal"],
			requestRender: noop,
			stderr: (text) => errors.push(text),
			stdout: (text) => infos.push(text),
			appendBlock: (render) => cards.push(render(100).join("\n")),
			fleetPlans: createFleetPlanRuns(),
			getSettings: () => DEFAULT_SETTINGS,
			closeOverlay: () => {
				transitions.state = "closed";
			},
			notify: (level, text, key) => notices.push([level, key ?? "", text]),
			loadFleetSources: () => ({
				commands: null,
				playbook: {
					version: 3,
					name: "survey",
					description: "Survey fixture",
					path: join(root, "survey.md"),
					body: "Survey.",
					maxWorkers: 1,
					budgetUsd: null,
					onFailure: "stop",
					steps: [
						{ kind: "agent", id: "survey", agent: "coder", scope: "readonly", dependencies: [] },
						{ kind: "agent", id: "check", agent: "coder", scope: "readonly", dependencies: ["survey"] },
					],
				} as never,
			}),
			openFleetRunApprovalOverlay: (_tui, options) => {
				accept = options.onAccept;
				return {} as ReturnType<NonNullable<OverlayGeneralOpenersDeps["openFleetRunApprovalOverlay"]>>;
			},
			runFleet: async (input) => {
				input.onStarted?.();
				input.onNotice?.("loop suite cycle 1 checkpoint=refs/pancode/loop/abc", "gate");
				input.onNotice?.("write boundary w0: outside writes", "write-boundary");
				// The loop's first check failed before a repair resolved it; the plan's card counts both steps that ran.
				input.onStepSettled?.({ stepId: "survey", succeeded: true } as never);
				input.onStepSettled?.({ stepId: "check", succeeded: false } as never);
				return {
					cleanRun: true,
					succeededStepCount: 1,
					requiredStepCount: 1,
					resolvedLoopCount: 1,
					result: { loops: [{ loopId: "suite", resolved: true }] },
					totalCost: sumPricing([]),
				} as unknown as FleetRunOutcome;
			},
		};
		const openers = createOverlayGeneralOpeners(deps as OverlayGeneralOpenersDeps);
		openers.startFleetRun("survey", {});
		ok(accept);
		accept();
		await new Promise((settle) => setImmediate(settle));
		deepStrictEqual(infos, ["plan survey: loop suite cycle 1 checkpoint=refs/pancode/loop/abc\n"]);
		deepStrictEqual(errors, ["plan survey: write boundary w0: outside writes\n"]);
		const settled = notices.find(([, key]) => key === "fleet-run:settled");
		ok(settled);
		// The notice states the card's counts, not the required count the outcome keeps beside them.
		ok(settled[2].includes("plan survey: 2 of 2 planned steps ran, 1/1 loop resolved"), settled[2]);
		ok(cards.at(-1)?.includes("2 of 2 planned steps ran · 1/1 loop resolved"), cards.at(-1));
	} finally {
		scratch.restore();
	}
});

test("words after the playbook name are its task, refused when given twice or when the playbook has no {{task}}", async () => {
	deepStrictEqual(parseSlashCommand("/fleet run build-test Add clamp to calc.py --var lang=py"), {
		kind: "fleet-run",
		name: "build-test",
		vars: { lang: "py", task: "Add clamp to calc.py" },
		task: "Add clamp to calc.py",
	});
	deepStrictEqual(parseSlashCommand("/fleet run build-test --var lang=py"), {
		kind: "fleet-run",
		name: "build-test",
		vars: { lang: "py" },
	});
	deepStrictEqual(parseSlashCommand("/fleet run build-test Add clamp --var task=other"), {
		kind: "usage-error",
		command: "fleet",
		reason: "the task is given twice: pass it as the argument after the playbook or as --var task=..., not both",
		subcommand: "run",
	});
	const scratch = await isolatePancodeEnv("pancode-fleet-task-");
	try {
		const root = realpathSync(scratch.dir);
		const agents = dispatchStubContext({ settings: DEFAULT_SETTINGS }).getContract("agents");
		ok(agents);
		const subjects: unknown[] = [];
		let accept: (() => void) | undefined;
		let ran = 0;
		const transitions = { state: "closed", handle: null, showPermission: () => false, close: noop };
		const openers = createOverlayGeneralOpeners({
			dispatch: {} as DispatchContract,
			agents,
			transitions: transitions as unknown as OverlayGeneralOpenersDeps["transitions"],
			getSessionMeta: () => ({ cwd: root }) as ReturnType<OverlayGeneralOpenersDeps["getSessionMeta"]>,
			terminal: { columns: 100 } as OverlayGeneralOpenersDeps["terminal"],
			requestRender: noop,
			closeOverlay: () => {
				transitions.state = "closed";
			},
			notify: noop,
			loadFleetSources: () => ({
				commands: null,
				playbook: {
					version: 3,
					name: "survey",
					description: "Survey fixture",
					path: join(root, "survey.md"),
					body: "Survey {{area}}.",
					maxWorkers: 1,
					budgetUsd: null,
					onFailure: "stop",
					steps: [{ kind: "agent", id: "survey", agent: "coder", scope: "readonly", dependencies: [] }],
				} as never,
			}),
			openFleetRunApprovalOverlay: (_tui, options) => {
				subjects.push(options.subject);
				accept = options.onAccept;
				return {} as ReturnType<NonNullable<OverlayGeneralOpenersDeps["openFleetRunApprovalOverlay"]>>;
			},
			runFleet: () => {
				ran += 1;
				return new Promise<FleetRunOutcome>(noop);
			},
		} as Partial<OverlayGeneralOpenersDeps> as OverlayGeneralOpenersDeps);
		openers.startFleetRun("survey", { area: "src", task: "Add clamp" }, { task: "Add clamp" });
		deepStrictEqual(subjects, [
			{
				ok: false,
				name: "survey",
				diagnostics: ["playbook 'survey' takes no task: its prompt has no {{task}}; pass its variables (area) with --var"],
			},
		]);
		accept?.();
		strictEqual(ran, 0, "a refused task starts nothing");
	} finally {
		scratch.restore();
	}
});

test("an earlier fleet read from its record counts steps and loops as the live run did", async () => {
	const scratch = await isolatePancodeEnv("pancode-fleet-history-loops-");
	try {
		const root = realpathSync(scratch.dir);
		const result = (succeeded: boolean) => ({ succeeded, output: "" }) as never;
		writeFleetRunSync({
			version: 1,
			id: "fleet-0123456789ab",
			cwd: root,
			fleet: "build-test",
			planHash: "hash",
			planIdentityHash: "hash",
			stepIds: ["build", "suite.check.1", "suite.repair.1", "suite.check.2"],
			planSteps: [
				{ id: "build", kind: "agent", agentId: "coder" },
				{ id: "suite.check.1", kind: "code", argv: ["pytest"], loop: { loopId: "suite", role: "check", attempt: 1 } },
				{ id: "suite.repair.1", kind: "agent", agentId: "coder", loop: { loopId: "suite", role: "repair", attempt: 1 } },
				{ id: "suite.check.2", kind: "code", argv: ["pytest"], loop: { loopId: "suite", role: "check", attempt: 2 } },
			],
			vars: {},
			startedAt: "2026-11-14T10:00:00.000Z",
			endedAt: "2026-11-14T10:01:00.000Z",
			resumedFrom: null,
			steps: [
				{ stepId: "build", result: result(true) },
				{ stepId: "suite.check.1", result: result(true) },
			],
		});
		const [plan] = readDurableFleetPlans(root);
		ok(plan);
		strictEqual(plan.state, "passed");
		strictEqual(plan.requiredStepCount, 1);
		strictEqual(plan.succeededStepCount, 1);
		deepStrictEqual(plan.loops, { resolved: 1, total: 1 });
	} finally {
		scratch.restore();
	}
});

test("fleet-run overlay refuses drift between card and accept, throwing surfaces do not wedge launcher, and route drift refuses launch", async () => {
	const scratch = await isolatePancodeEnv("pancode-fleet-drift-");
	try {
		const root = realpathSync(scratch.dir);
		const agents = dispatchStubContext({ settings: DEFAULT_SETTINGS }).getContract("agents");
		ok(agents);
		const notices: Array<[string, string]> = [];
		let accept: (() => void) | undefined;
		let body = "Survey v1.";
		let ran = 0;
		const transitions = { state: "closed", handle: null, showPermission: () => false, close: noop };
		const deps: Partial<OverlayGeneralOpenersDeps> = {
			dispatch: {} as DispatchContract,
			agents,
			transitions: transitions as unknown as OverlayGeneralOpenersDeps["transitions"],
			getSessionMeta: () => ({ cwd: root }) as ReturnType<OverlayGeneralOpenersDeps["getSessionMeta"]>,
			terminal: { columns: 100 } as OverlayGeneralOpenersDeps["terminal"],
			requestRender: noop,
			stderr: noop,
			getSettings: () => DEFAULT_SETTINGS,
			closeOverlay: () => {
				transitions.state = "closed";
			},
			notify: (_level, text, key) => notices.push([key ?? "", text]),
			loadFleetSources: () => ({
				commands: null,
				playbook: {
					version: 3,
					name: "survey",
					description: "Survey fixture",
					path: join(root, "survey.md"),
					body,
					maxWorkers: 1,
					budgetUsd: null,
					onFailure: "stop",
					steps: [{ kind: "agent", id: "survey", agent: "coder", scope: "readonly", dependencies: [] }],
				} as never,
			}),
			openFleetRunApprovalOverlay: (_tui, options) => {
				ok(options.subject.ok);
				accept = options.onAccept;
				return {} as ReturnType<NonNullable<OverlayGeneralOpenersDeps["openFleetRunApprovalOverlay"]>>;
			},
			runFleet: async () => {
				ran += 1;
				return {
					cleanRun: true,
					succeededStepCount: 1,
					requiredStepCount: 1,
					totalCost: sumPricing([]),
				} as unknown as FleetRunOutcome;
			},
		};
		const openers = createOverlayGeneralOpeners(deps as OverlayGeneralOpenersDeps);
		openers.startFleetRun("survey", {});
		ok(accept);
		body = "Survey v2.";
		accept();
		strictEqual(ran, 0, "changed playbook between card open and accept must not run");
		strictEqual(notices.at(-1)?.[0], "fleet-run:changed");

		// A throwing surface must not wedge inFlight() or block later launches.
		const preview = compileFleetRunPreview({
			workspaceRoot: root,
			name: "survey",
			vars: {},
			getAgentSpec: (id) => agents.getSpec(id),
			roleFacts: agentRoleFactsResolver((id) => agents.getSpec(id)),
			load: () => ({
				commands: null,
				playbook: {
					version: 3,
					name: "survey",
					description: "Survey fixture",
					path: join(root, "survey.md"),
					body: "Survey v2.",
					maxWorkers: 1,
					budgetUsd: null,
					onFailure: "stop",
					steps: [{ kind: "agent", id: "survey", agent: "coder", scope: "readonly", dependencies: [] }],
				} as never,
			}),
		});
		ok(preview.ok);
		const launcher = createFleetRunLauncher({
			dispatch: {} as DispatchContract,
			agents: { getSpec: (id) => agents.getSpec(id) },
			workspaceRoot: () => root,
			run: async () =>
				({
					cleanRun: true,
					succeededStepCount: 1,
					requiredStepCount: 1,
					totalCost: sumPricing([]),
				}) as unknown as FleetRunOutcome,
		});
		launcher.watch(() => {
			throw new Error("boom surface");
		});
		const first = launcher.launch({ preview: preview.preview, origin: "model" });
		strictEqual(first.status, "launched");
		await first.settled;
		strictEqual(launcher.inFlight(), null);
		const second = launcher.launch({ preview: preview.preview, origin: "model" });
		strictEqual(second.status, "launched");
		await second.settled;

		// Route drift between approvedRoutes and live dispatch.preview must fail preflight before any worker starts.
		let dispatched = 0;
		const driftedDispatch = {
			preview: () => ({
				targetId: "conn-b",
				wireModelId: "model-b",
				node: { id: "local", kind: "local" },
				costUpperBoundUsd: 0.01,
				endpoint: { key: "conn-b:model-b", label: "conn-b", limit: 4 },
			}),
			dispatch: async () => {
				dispatched += 1;
				throw new Error("must not dispatch drifted route");
			},
			reservations: { prepare: () => ({ ownerId: "r1" }), release: () => {} },
		} as unknown as DispatchContract;
		let caught: unknown;
		try {
			await executeFleetRun({
				plan: preview.preview.plan,
				playbookName: "survey",
				commands: null,
				workspaceRoot: root,
				fleetRootId: "fleet-routedrift1",
				dispatch: driftedDispatch,
				agents: { getSpec: (id) => agents.getSpec(id) },
				attributionEnabled: false,
				approvedRoutes: new Map([["survey", { targetId: "conn-a", wireModelId: "model-a", nodeId: "local" }]]),
			});
		} catch (error) {
			caught = error;
		}
		ok(caught instanceof Error && /route drifted from the approved card/u.test(caught.message), String(caught));
		strictEqual(dispatched, 0, "drifted route must never dispatch a worker");
	} finally {
		scratch.restore();
	}
});
