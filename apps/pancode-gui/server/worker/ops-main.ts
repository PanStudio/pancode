// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { workerData } from "node:worker_threads";
import { restrictNetwork } from "../network-policy.js";
import { hubActionsAdapter } from "../pancode/adapters/hub-actions.js";
import { closeMachines, mutateMachine } from "../pancode/adapters/machines.js";
import { runtimeInfo } from "../pancode/adapters/runtime.js";
import { recoverSession } from "../pancode/adapters/sessions.js";
import { toolchainAdapter, toolDownloader } from "../pancode/adapters/toolchain.js";
import { AppProblem } from "../services/problem.js";
import type { WorkerSettings } from "./protocol.js";
import { serveWorker } from "./serve.js";

const settings = workerData as WorkerSettings;
declare const __PANCODE_GUI_BUNDLED__: boolean;
const download = restrictNetwork();
const fixture =
	(typeof __PANCODE_GUI_BUNDLED__ === "undefined" || !__PANCODE_GUI_BUNDLED__) && settings.fixture
		? await import("../../tests/fixtures/toolchain.js")
		: undefined;
const adapter = toolchainAdapter(fixture?.fixtureOptions(settings) ?? { fetcher: toolDownloader(download) });
const hub = hubActionsAdapter();
serveWorker(async (call, progress) => {
	if (call.method === "machines.mutate") return mutateMachine(call.params.cwd, call.params.mutation);
	if (call.method === "runtime.info" && process.env.NODE_ENV === "test") return runtimeInfo(import.meta.url);
	if (call.method === "sessions.recover")
		return recoverSession(call.params.cwd, call.params.sessionId, call.params.pid, call.params.birth);
	if (call.method === "tools.install") return adapter.install(call.params.id, call.params.force, progress);
	if (call.method === "tools.remove") return adapter.remove(call.params.id);
	if (call.method === "hub.plan") return hub.plan(call.params.cwd, call.params.request);
	if (call.method === "hub.apply") return hub.apply(call.params.cwd, call.params.planId);
	if (call.method === "hub.release") return hub.release(call.params.cwd, call.params.planId);
	if (call.method === "interop.decide") {
		const { decideInterop } = await import("../pancode/adapters/system.js");
		return decideInterop(call.params.cwd, call.params.kind, call.params.decision, settings.fixture);
	}
	if (call.method === "settings.write") {
		const { writeSettingControl } = await import("../pancode/adapters/settings-controls.js");
		return writeSettingControl(call.params.cwd ?? null, call.params.write);
	}
	if (call.method.startsWith("reports.")) {
		const { reportDialog } = await import("../pancode/adapters/report.js");
		if (call.method === "reports.plan") return reportDialog.plan(call.params.cwd, call.params.input);
		if (call.method === "reports.update")
			return reportDialog.update(call.params.cwd, call.params.draftId, call.params.edits);
		if (call.method === "reports.send")
			return reportDialog.send(call.params.cwd, call.params.draftId, call.params.choices);
		if (call.method === "reports.status") return reportDialog.status(call.params.cwd);
		if (call.method === "reports.bundle")
			return reportDialog.bundle(call.params.cwd, call.params.draftId, call.params.request);
		if (call.method === "reports.offer") return reportDialog.offer(call.params.cwd, call.params.sessionId);
	}
	throw new AppProblem("unsupported", "Method is not available in the ops worker.");
}, closeMachines);
