// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { createTelemetryHub } from "../../src/core/telemetry/hub.js";
import { ToolNames } from "../../src/core/tool-names.js";
import { createWorkerSafety } from "../../src/engine/worker-tools.js";
import { planFacts, planRouteSources, readDispatchPlan } from "../../src/interactive/dispatch-plan-summary.js";
import { createOverlayPermissionLifecycle } from "../../src/interactive/overlay-permission-lifecycle.js";
import { describeDispatchPlan, RESOLVED_DISPATCH_PLAN_ARGUMENT } from "../../src/tools/dispatch-plan.js";
import type { PermissionRequiredMeta } from "../../src/tools/registry/contract.js";
import { createRegistry } from "../../src/tools/registry.js";
import type { ToolSpec } from "../../src/tools/tool-spec.js";

test("the plan-card task preview keeps line breaks and tabs, and still neutralizes other control characters", () => {
	const view = describeDispatchPlan({
		tasks: [{ agent: "scout", task: "Survey the soil\nthen report\twith\u001b[31m colour" }],
	});
	const line = view.text.split("\n").find((row) => row.includes("task_preview="));
	ok(line, "the plan has a task line");
	ok(line.includes("task_preview="), "the preview stays on its one plan line");
	const summary = readDispatchPlan(view.text);
	ok(summary, "the card reads the plan");
	strictEqual(summary.members[0]?.task, "Survey the soil\nthen report with?[31m colour");
	const fact = planFacts(summary).find((entry) => entry.value.includes("Survey"));
	deepStrictEqual(fact?.value.split("\n").length, 2, "the card value carries a real line break");
});

test("a resolved parallel plan's card rows name each task's agent, not its task slot", () => {
	const summary = readDispatchPlan(
		[
			"dispatch plan: topology=parallel tasks=2",
			'    1. role=task#1 agent=scout connection=openai-codex model=gpt-6-luna node=local task_preview="List the exports"',
			"      route: connection named in the call",
			'    2. role=task#2 agent=coder connection=openai-codex model=gpt-6-luna node=local task_preview="Add a test"',
			"      route: connection named in the call",
		].join("\n"),
	);
	ok(summary, "the card reads the plan");
	deepStrictEqual(
		summary.members.map((member) => member.label ?? member.agent),
		["scout", "coder"],
	);
	strictEqual(planRouteSources(summary).shared, "connection named in the call");
});

test("the card's inspect lists the arguments the model sent, not the plan the harness attached", async () => {
	const registry = createRegistry({ safety: createWorkerSafety({ cwd: process.cwd() }), autonomy: () => "default" });
	registry.register({
		name: ToolNames.Dispatch,
		description: "stub dispatch",
		parameters: {} as ToolSpec["parameters"],
		baseActionClass: "dispatch",
		run: async () => ({ kind: "ok", output: "dispatched" }),
	});
	const invocations: Array<() => unknown> = [];
	createOverlayPermissionLifecycle({
		toolRegistry: registry,
		bus: createTelemetryHub(),
		dispatch: {},
		getAutonomy: () => "default",
		getOverlayState: () => "closed",
		openPermissionOverlay: (_view, _inspect, invocation) => {
			if (invocation !== undefined) invocations.push(invocation);
			return true;
		},
		closeOverlay: () => {},
		appendNotice: () => {},
		applyApprovalState: () => {},
		requestRender: () => {},
		stopActiveTurn: () => {},
	});
	const parks: PermissionRequiredMeta[] = [];
	registry.onPermissionRequired((_call, _decision, meta) => parks.push(meta));
	const tasks = [
		{ agent: "scout", task: "List the exports" },
		{ agent: "coder", task: "Add a test" },
	];
	const pending = registry.invoke({
		tool: ToolNames.Dispatch,
		args: { mode: "parallel", tasks, [RESOLVED_DISPATCH_PLAN_ARGUMENT]: { version: 1 } },
	});
	while (parks.length === 0) await new Promise((resolve) => setTimeout(resolve, 5));
	deepStrictEqual(invocations[0]?.(), { mode: "parallel", tasks });
	registry.cancelParkedCall(parks[0]?.requestId ?? "", "denied", { denied: true });
	strictEqual((await pending).kind, "blocked");
});
