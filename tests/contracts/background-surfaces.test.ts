// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { doesNotMatch, match, ok, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import type { OutputStyle } from "../../src/core/defaults.js";
import { setPresentationTier } from "../../src/core/presentation-tier.js";
import type { TelemetryContract } from "../../src/domains/telemetry/index.js";
import { createWorkerProgressFold } from "../../src/domains/telemetry/worker-progress.js";
import type { Component, TUI } from "../../src/engine/tui.js";
import { stripTerminalSequences, visibleWidth } from "../../src/engine/tui.js";
import { createDispatchBoardView } from "../../src/interactive/dispatch-board.js";
import { renderFleetPlanCard } from "../../src/interactive/dispatch-plan-card.js";
import type { DispatchBoardRow } from "../../src/interactive/dispatch-row-model.js";
import { dockTop } from "../../src/interactive/dock.js";
import type { FleetPlanRunView } from "../../src/interactive/fleet-plan-runs.js";
import { createFleetBand } from "../../src/interactive/footer/fleet-band.js";
import { healthLines } from "../../src/interactive/health-overlay.js";
import { renderDoctorReport } from "../../src/interactive/renderers/doctor-report.js";
import { renderWorkerEntryLines } from "../../src/interactive/renderers/worker-entry.js";
import { transcriptDetail } from "../../src/interactive/transcript-detail.js";
import { openUsageOverlay } from "../../src/interactive/usage-overlay.js";
import { footerState } from "../harness/footer-fixture.js";
import { telemetryCall, telemetryViewOf } from "../harness/telemetry-view.js";

const plain = (lines: string[]) => lines.map(stripTerminalSequences).join("\n");
const fits = (lines: string[], width: number) => {
	for (const line of lines) ok(visibleWidth(line) <= width, `${width}: ${stripTerminalSequences(line)}`);
};

test("fleet band follows live tiers, folds at compact, prioritizes approval waits, and holds unacknowledged failures", () => {
	const fixture = footerState().dispatchRows[0];
	ok(fixture);
	let rows: DispatchBoardRow[] = [
		{
			...fixture,
			agentAudience: "base",
			taskSummary: "Inspect the parser",
		},
	];
	let settled: DispatchBoardRow[] = [];
	let boardOpen = false;
	const band = createFleetBand({
		getRows: () => rows,
		getSettledRows: () => settled,
		isFleetBoardOpen: () => boardOpen,
		getTerminalRows: () => 40,
	});
	const at = (tier: OutputStyle, width: number) => {
		setPresentationTier(tier);
		return band.render(width);
	};
	try {
		for (const width of [40, 80, 120, 200]) {
			const compact = at("compact", width);
			strictEqual(compact.length, 0);
			const standard = at("standard", width);
			const detailed = at("detailed", width);
			match(plain(standard), /^Fleet /);
			match(plain(detailed), /^Fleet /);
			for (const lines of [compact, standard, detailed]) fits(lines, width);
		}
		const first = rows[0];
		ok(first);
		const waiting: DispatchBoardRow = {
			...first,
			runId: "approval",
			agentId: "waiting-worker",
			progress: {
				...createWorkerProgressFold().snapshot(),
				awaitingApproval: true,
				phase: "tool",
				tailText: "",
				recentActions: [],
				currentAction: null,
			},
		};
		rows = [first, waiting];
		// The wait on the operator leads the counts and the run rows.
		match(plain(at("standard", 120)).split("\n")[1] ?? "", /waiting-.*‖ .*approval/);
		ok(waiting.progress);
		match(
			plain(
				renderWorkerEntryLines(
					{
						runId: "approval",
						assignmentId: "approval",
						origin: "user",
						agentId: "waiting-worker",
						runtime: { kind: "pancode" },
						text: "",
						droppedLines: 0,
						pending: true,
						tools: [],
						attempts: [],
						progress: waiting.progress,
					},
					120,
					{ detail: transcriptDetail("compact") },
				),
			),
			/waiting-worker.*approval/,
		);
		// Compact tier does not even read telemetry from worker rows.
		Object.defineProperty(waiting, "usage", {
			get() {
				throw new Error("compact read full telemetry");
			},
		});
		strictEqual(at("compact", 120).length, 0);
		// A failed run is no longer live, yet the band keeps it until the operator opens Fleet Runs.
		const failed: DispatchBoardRow = {
			...first,
			runId: "refused",
			agentId: "pusher",
			status: "failed",
			outcomeDetail: "git push --force refused",
		};
		const done: DispatchBoardRow = { ...first, runId: "clean", agentId: "finisher", status: "completed" };
		const stopped: DispatchBoardRow = { ...first, runId: "stopped", agentId: "stopper", status: "aborted" };
		rows = [first, { ...first, runId: "approval", agentId: "waiting-worker", progress: waiting.progress }];
		settled = [first, failed, done, stopped];
		for (const tier of ["standard", "detailed"] as const) {
			const lines = plain(at(tier, 120)).split("\n");
			match(lines[0] ?? "", /^Fleet ─+ ✗ 1 failed · ‖ 1 waiting · ● 1 running · Alt\+W detail ─$/);
			match(lines[1] ?? "", /waiting-/);
			// Live workers keep the listed rows ahead of a settled failure (fleet finding 14).
			match(lines[2] ?? "", /scout/);
			match(lines[3] ?? "", /pusher/);
			doesNotMatch(lines.join("\n"), /finisher|stopper/);
		}
		boardOpen = true;
		strictEqual(plain(at("standard", 120)), "");
		boardOpen = false;
		rows = [];
		settled = [first, failed, { ...failed, runId: "later", agentId: "later-pusher" }];
		match(plain(at("standard", 120)).split("\n")[1] ?? "", /later-p.*✗/);
	} finally {
		setPresentationTier("standard");
	}
});

test("a run waiting for the verification slot says so on its worker card and Fleet Runs row until its checks start", () => {
	const fixture = footerState().dispatchRows[0];
	ok(fixture);
	const fold = createWorkerProgressFold();
	fold.observe({ type: "agent_start" });
	fold.observe({ type: "agent_end" });
	ok(fold.observe({ type: "host_verification", message: "waiting for a verification slot" }));
	let row: DispatchBoardRow = { ...fixture, status: "running", agentId: "checker", progress: fold.snapshot() };
	const board = createDispatchBoardView(
		() => [row],
		() => undefined,
	);
	board.setBodyRows(30);
	const card = () =>
		plain(
			renderWorkerEntryLines(
				{
					runId: row.runId,
					assignmentId: row.runId,
					origin: "user",
					agentId: "checker",
					runtime: { kind: "pancode" },
					text: "",
					droppedLines: 0,
					pending: true,
					tools: [],
					attempts: [],
					...(row.progress ? { progress: row.progress } : {}),
				},
				120,
				{ detail: transcriptDetail("standard") },
			),
		);
	match(plain(board.render(120)), /waiting for a verification slot/);
	match(card(), /waiting for a verification slot/);
	ok(fold.observe({ type: "host_verification", message: "running host checks" }));
	row = { ...row, progress: fold.snapshot() };
	board.invalidate();
	for (const surface of [plain(board.render(120)), card()]) {
		doesNotMatch(surface, /waiting for a verification slot/);
		match(surface, /running host checks/);
	}
	fold.settle("done", true);
	doesNotMatch(JSON.stringify(fold.snapshot()), /verification|host checks/);
});

test("fleet board tier changes invalidate cached rows and explicit detail overrides compact mode", () => {
	const fixture = footerState().dispatchRows[0];
	ok(fixture);
	const row = { ...fixture, agentAudience: "base" as const, taskSummary: "Investigate the parser" };
	const board = createDispatchBoardView(
		() => [row],
		() => undefined,
	);
	board.setBodyRows(30);
	setPresentationTier("compact");
	try {
		const compact = plain(board.render(120));
		doesNotMatch(compact, /target\s|tokens\s/);
		// The route and token facts of the selected run are detailed's (boardFacts).
		setPresentationTier("detailed");
		match(plain(board.render(120)), /target\s/);
		setPresentationTier("compact");
		strictEqual(plain(board.render(120)), compact);
		board.toggleDetail();
		match(plain(board.render(120)), /target\s/);
		strictEqual(board.detailExpanded(), true);
	} finally {
		setPresentationTier("standard");
	}
});

test("settled plans fold routine steps but keep the failed step and a route to detail", () => {
	const plan: FleetPlanRunView = {
		rootId: "plan-1",
		name: "release",
		startedAtMs: 0,
		finishedAtMs: 1000,
		state: "failed",
		requiredStepCount: 20,
		succeededStepCount: 19,
		costText: null,
		steps: Array.from({ length: 20 }, (_, i) => ({
			stepId: `step-${i}`,
			kind: "code",
			label: `check ${i}`,
			state: i === 18 ? "failed" : "passed",
		})),
	};
	const compact = renderFleetPlanCard(plan, 80, "compact");
	const standard = renderFleetPlanCard(plan, 80, "standard");
	match(plain(compact), /20 more steps.*\/fleet/);
	match(plain(standard), /step-18/);
	ok(standard.length < 10);
	fits(standard, 80);
	const fixture = footerState().dispatchRows[0];
	ok(fixture);
	const board = createDispatchBoardView(
		() => [{ ...fixture, plan }],
		() => undefined,
	);
	board.setBodyRows(12);
	board.toggleDetail();
	const first = plain(board.render(80));
	for (let index = 0; index < 15; index++) {
		board.scrollDetail(1);
		fits(board.render(80), 80);
	}
	const end = plain(board.render(80));
	match(end, /step-19/);
	board.scrollDetail(-1);
	ok(plain(board.render(80)) !== end, "one page back works after repeated paging beyond the end");
	for (let index = 0; index < 15; index++) {
		board.scrollDetail(-1);
		board.render(80);
	}
	strictEqual(plain(board.render(80)), first);
});

test("doctor folds routine diagnostics by tier without dropping errors or remediation", () => {
	const findings = [
		{ ok: true, name: "healthy", detail: "routine installation path" },
		{ ok: false, name: "broken", detail: "Repair this component before continuing." },
		{ ok: true, level: "warn" as const, name: "optional", detail: "Install the missing tool." },
	];
	for (const width of [8, 24, 80, 120, 200]) {
		for (const style of ["compact", "standard", "detailed"] as const) {
			const lines = renderDoctorReport(findings, width, style);
			fits(lines, width);
			const text = plain(lines)
				.replace(/^ {2}[│|] /gmu, "")
				.replace(/\s/g, "");
			ok(text.includes("Repairthiscomponentbeforecontinuing."));
			ok(text.includes("Installthemissingtool."));
			strictEqual(text.includes("routineinstallationpath"), style === "detailed");
			strictEqual(text.includes("healthy"), style !== "compact");
			strictEqual(text.match(/routinechecks?folded/g)?.length ?? 0, style === "detailed" ? 0 : 1);
			strictEqual(text.match(/healthy/g)?.length ?? 0, style === "compact" ? 0 : 1);
		}
	}
	const healthy = findings.slice(0, 1);
	match(plain(renderDoctorReport(healthy, 80, "standard")), /OK\s+healthy/);
	match(plain(renderDoctorReport(healthy, 80, "compact")), /1 routine check folded/);
});

test("usage suppresses the empty graph outside Detailed and adapts without reopening", () => {
	let style: OutputStyle = "compact";
	const tui = {
		terminal: { rows: 40, setTitle() {} },
		requestRender() {},
		showOverlay: () => ({ hide() {} }),
	} as unknown as TUI;
	const telemetry = { subscribe: () => () => {} } as unknown as TelemetryContract;
	// /usage reads the tier from the policy table, so each step sets it there.
	setPresentationTier(style);
	const handle = openUsageOverlay(tui, telemetry);
	try {
		const frame = dockTop(tui)?.frame as unknown as Component;
		for (const width of [24, 80, 120, 200]) {
			style = "compact";
			setPresentationTier(style);
			doesNotMatch(plain(frame.render(width)), /182 days|Less.*More/);
			style = "standard";
			setPresentationTier(style);
			doesNotMatch(plain(frame.render(width)), /182 days|Less.*More/);
			style = "detailed";
			setPresentationTier(style);
			const detailed = frame.render(width);
			fits(detailed, width);
			if (width >= 80) match(plain(detailed), /182 days/);
		}
	} finally {
		handle.hide();
		setPresentationTier("standard");
	}
});

test("minimal health folds routine connections but retains failures and recovery information", () => {
	const transport = telemetryViewOf("health", telemetryCall("health")).session().transport;
	ok(transport);
	transport.pinReason = null;
	transport.recovery = null;
	for (const quantity of [transport.websocketFailures, transport.sseFallbacks]) {
		quantity.fact = { kind: "measured", value: 0, source: "provider" };
		quantity.display = "0";
	}
	const data = { health: null, sessionId: "health", transport, quota: null, breakers: [], systemOne: null };
	doesNotMatch(plain(healthLines(data, 80, "compact")), /Connection to the model/);
	transport.pinReason = "auth_rejection";
	for (const width of [24, 80, 120, 200]) {
		for (const style of ["compact", "standard", "detailed"] as const) {
			const rows = healthLines(data, width, style);
			fits(rows, width);
			ok(plain(rows).replace(/\s/g, "").includes("WebSocketsign-inwasrejected"));
		}
	}
	transport.pinReason = null;
	transport.websocketFailures.fact = { kind: "measured", value: 2, source: "provider" };
	transport.websocketFailures.display = "2";
	match(plain(healthLines(data, 80, "compact")), /WebSocket failures\s+2/);
});
