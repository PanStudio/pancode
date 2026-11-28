// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { workerData } from "node:worker_threads";
import { restrictNetwork } from "../network-policy.js";
import { closeNodes, readNodeEndpoints, readNodes } from "../pancode/adapters/nodes.js";
import { programsAdapter } from "../pancode/adapters/programs.js";
import { runtimeInfo } from "../pancode/adapters/runtime.js";
import { listSessionHistory, readStoredTranscript, sessionWorkspaces } from "../pancode/adapters/sessions.js";
import { TraceAdapter } from "../pancode/adapters/traces.js";
import { AppProblem } from "../services/problem.js";
import type { WorkerSettings } from "./protocol.js";
import { serveWorker } from "./serve.js";

const settings = workerData as WorkerSettings;
declare const __PANCODE_GUI_BUNDLED__: boolean;
restrictNetwork();
const fixture =
	(typeof __PANCODE_GUI_BUNDLED__ === "undefined" || !__PANCODE_GUI_BUNDLED__) && settings.fixture
		? await import("../../tests/fixtures/programs.js")
		: undefined;
const adapter = programsAdapter(fixture?.fixtureOptions(settings));
const traces = new TraceAdapter();
serveWorker(async (call) => {
	if (call.method === "nodes.list") return readNodes(call.params.cwd);
	if (call.method === "nodes.endpoints") return readNodeEndpoints(call.params.cwd);
	if (call.method === "runtime.info" && process.env.NODE_ENV === "test") return runtimeInfo(import.meta.url);
	if (call.method === "system.read" || call.method === "interop.read") {
		const { inspectSystem, inspectInterop } = await import("../pancode/adapters/system.js");
		return call.method === "system.read"
			? inspectSystem()
			: inspectInterop(call.params.cwd, call.params.probe, settings.fixture);
	}
	if (call.method === "hub.read") {
		const { readHub } = await import("../pancode/adapters/hub.js");
		return readHub(call.params);
	}
	if (call.method === "evidence.read") {
		const { readEvidence } = await import("../pancode/adapters/evidence.js");
		return readEvidence(call.params);
	}
	if (call.method === "fleet.read") {
		const { readFleet } = await import("../pancode/adapters/fleet.js");
		return readFleet(call.params);
	}
	if (call.method === "settings.read") {
		const { inspectSettings } = await import("../pancode/adapters/settings.js");
		return inspectSettings(call.params.cwd ?? null);
	}
	if (call.method === "setup.status") {
		const { readSetupStatus } = await import("../pancode/adapters/setup-status.js");
		return readSetupStatus(call.params.cwd);
	}
	if (call.method === "settings.controls") {
		const { readSettingsControls } = await import("../pancode/adapters/settings-controls.js");
		return readSettingsControls(call.params.cwd ?? null);
	}
	if (call.method === "config.graph") {
		if (settings.fixture && settings.fixtureGraphDelayMs)
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, settings.fixtureGraphDelayMs);
		const { inspectConfigGraph } = await import("../pancode/adapters/config-graph.js");
		return inspectConfigGraph(call.params.cwd);
	}
	if (call.method === "sessions.workspaces") return sessionWorkspaces();
	if (call.method === "sessions.list") return listSessionHistory(call.params.cwd);
	if (call.method === "sessions.transcript") return readStoredTranscript(call.params.cwd, call.params.id);
	if (call.method === "workspace.files") {
		const { completeWorkspaceFiles } = await import("../pancode/adapters/workspace-files.js");
		return completeWorkspaceFiles(call.params.cwd, call.params.input);
	}
	if (call.method === "traces.read") return traces.read(call.params);
	if (call.method === "telemetry.read") {
		const { readTelemetry } = await import("../pancode/adapters/telemetry.js");
		return readTelemetry(call.params);
	}
	if (call.method !== "programs.list")
		throw new AppProblem("unsupported", "Method is not available in the reads worker.");
	if (settings.fixture && settings.readDelayMs)
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, settings.readDelayMs);
	if (settings.fixture && settings.crashRead) process.exit(7);
	return adapter.list();
}, closeNodes);
