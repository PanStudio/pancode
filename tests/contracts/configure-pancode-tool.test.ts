// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { readSettings, updateSettings } from "../../src/core/config.js";
import { HEADLESS_PERMISSION_DENIED_REASON } from "../../src/core/headless-permission.js";
import { ToolNames } from "../../src/core/tool-names.js";
import { pancodeStateDir } from "../../src/core/xdg.js";
import type { ActionClass } from "../../src/domains/safety/action-classifier.js";
import { stripTerminalSequences } from "../../src/engine/tui.js";
import { createWorkerSafety } from "../../src/engine/worker-tools.js";
import { createPermissionOverlayBody } from "../../src/interactive/permission-overlay.js";
import { mainApprovalRequestView } from "../../src/session-control/approval-request-facts.js";
import { configurePancodeApplyRefusal, createConfigurePancodeTool } from "../../src/tools/configure-pancode.js";
import type { RegistryVerdict } from "../../src/tools/registry/contract.js";
import { createRegistry } from "../../src/tools/registry.js";
import { writeTool } from "../../src/tools/write.js";
import { isolatePancodeEnv } from "../harness/scratch-env.js";

function yoloRegistry(cwd: string) {
	return createRegistry({ safety: createWorkerSafety({ cwd }), autonomy: () => "yolo" });
}

function defaultRegistry(cwd: string) {
	return createRegistry({ safety: createWorkerSafety({ cwd }), autonomy: () => "default" });
}

const attended = { interactive: true, getAutonomy: () => "default" as const };

function outputOf(verdict: RegistryVerdict): string {
	return verdict.kind === "ok" && verdict.result.kind === "ok" ? verdict.result.output : JSON.stringify(verdict);
}

async function settledWithin(verdict: Promise<RegistryVerdict>, ms: number): Promise<RegistryVerdict | "pending"> {
	let timer: NodeJS.Timeout | undefined;
	const pending = new Promise<"pending">((resolve) => {
		timer = setTimeout(() => resolve("pending"), ms);
	});
	try {
		return await Promise.race([verdict, pending]);
	} finally {
		clearTimeout(timer);
	}
}

function proposalOf(verdict: RegistryVerdict): string {
	const output = verdict.kind === "ok" && verdict.result.kind === "ok" ? verdict.result.output : "";
	const id = /proposalId="([^"]+)"/.exec(output)?.[1];
	if (!id) throw new Error(`preview omitted proposal id: ${JSON.stringify(verdict)}`);
	return id;
}

test("configure_pancode previews an exact change, applies it once and logs the save", async (t) => {
	const env = await isolatePancodeEnv("pancode-configure-preview-");
	t.after(() => env.restore());
	const tool = createConfigurePancodeTool(attended);
	strictEqual(tool.name, ToolNames.ConfigurePancode);
	const preview = await tool.run({ action: "preview", path: "chat.thinkingLevel", value: "high" }, { sessionId: "s-1" });
	match(preview.kind === "ok" ? preview.output : "", /chat\.thinkingLevel: low → high/);
	match(
		preview.kind === "ok" ? preview.output : "",
		/\n\nGuidance:\n[\s\S]*profile map first, then the binding map[\s\S]*effect\ntiming/,
	);
	strictEqual(readSettings().chat.thinkingLevel, "low");
	const proposalId = /proposalId="([^"]+)"/.exec(preview.kind === "ok" ? preview.output : "")?.[1];
	if (!proposalId) throw new Error("preview omitted proposal id");
	strictEqual(tool.confirmationFor?.({ action: "apply", proposalId })?.ruleId, "pancode-settings");
	const applied = await tool.run({ action: "apply", proposalId }, { sessionId: "s-1" });
	strictEqual(applied.kind, "ok");
	match(applied.kind === "ok" ? applied.output : "", /Exit and start a new PanCode session/);
	strictEqual(readSettings().chat.thinkingLevel, "high");
	strictEqual((await tool.run({ action: "apply", proposalId })).kind, "error");
	const log = readFileSync(join(pancodeStateDir(), "settings-changes.jsonl"), "utf8").trim().split("\n");
	strictEqual(log.length, 1);
	const line = JSON.parse(log[0] ?? "{}");
	strictEqual(line.source, "configure_pancode");
	strictEqual(line.sessionId, "s-1");
	strictEqual(line.path, "chat.thinkingLevel");
	deepStrictEqual(line.changes, ["chat.thinkingLevel: low → high"]);
});

test("configure_pancode rejects stale proposals and sensitive paths, and a canceled card saves nothing", async (t) => {
	const env = await isolatePancodeEnv("pancode-configure-refusal-");
	t.after(() => env.restore());
	const tool = createConfigurePancodeTool(attended);
	for (const path of [
		"targets",
		"safety.mode",
		"fleet.permissions.default",
		"integrations.github",
		"telemetry.consent",
	]) {
		strictEqual((await tool.run({ action: "preview", path, value: "[]" })).kind, "error", path);
	}
	const preview = await tool.run({ action: "preview", path: "chat.thinkingLevel", value: "high" });
	const proposalId = /proposalId="([^"]+)"/.exec(preview.kind === "ok" ? preview.output : "")?.[1];
	if (!proposalId) throw new Error("preview omitted proposal id");
	updateSettings((settings) => {
		settings.chat.thinkingLevel = "high";
		return settings;
	});
	strictEqual((await tool.run({ action: "apply", proposalId })).kind, "error");
	const registry = defaultRegistry(env.dir);
	registry.register(createConfigurePancodeTool(attended));
	let asked = 0;
	registry.onPermissionRequired(() => {
		asked += 1;
		registry.cancelParkedCalls("operator canceled");
	});
	const next = await registry.invoke({
		tool: ToolNames.ConfigurePancode,
		args: { action: "preview", path: "chat.thinkingLevel", value: "medium" },
	});
	const canceled = await registry.invoke({
		tool: ToolNames.ConfigurePancode,
		args: { action: "apply", proposalId: proposalOf(next) },
	});
	strictEqual(asked, 1);
	ok(canceled.kind !== "ok", JSON.stringify(canceled));
	strictEqual(readSettings().chat.thinkingLevel, "high");
});

test("configure_pancode refuses autonomy at both levels, including padded values and apply", async (t) => {
	const env = await isolatePancodeEnv("pancode-configure-autonomy-refusal-");
	t.after(() => env.restore());
	for (const level of ["default", "yolo"] as const) {
		const tool = createConfigurePancodeTool({ interactive: true, getAutonomy: () => level });
		for (const value of ["default", "yolo", " yolo "]) {
			const refusal = await tool.run({ action: "preview", path: "safety.autonomy", value });
			strictEqual(refusal.kind, "error");
			ok(
				refusal.kind === "error" && /autonomy.*operator.*\/settings.*pancode configure.*--autonomy/u.test(refusal.message),
			);
		}
		const apply = await tool.run({ action: "apply", path: "safety.autonomy", value: "yolo", proposalId: "unknown" });
		strictEqual(apply.kind, "error");
		ok(apply.kind === "error" && /autonomy.*operator/u.test(apply.message));
	}
	strictEqual(readSettings().safety.autonomy, "default");
});

test("configure_pancode reports effect timing for live fleet settings and restart settings", async (t) => {
	const env = await isolatePancodeEnv("pancode-configure-effect-");
	t.after(() => env.restore());
	const tool = createConfigurePancodeTool(attended);
	for (const [path, value, expected] of [
		["fleet.limits.toolCallsPerRun", "7", /next request or dispatch/],
		["fleet.concurrency", "3", /Exit and start a new PanCode session/],
	] as const) {
		const preview = await tool.run({ action: "preview", path, value });
		const proposalId = /proposalId="([^"]+)"/.exec(preview.kind === "ok" ? preview.output : "")?.[1];
		ok(proposalId, JSON.stringify(preview));
		const result = await tool.run({ action: "apply", proposalId });
		match(result.kind === "ok" ? result.output : "", expected);
	}
});

test("configure_pancode Apply cards show sanitized changed leaves without unchanged maps", async (t) => {
	const env = await isolatePancodeEnv("pancode-configure-card-");
	t.after(() => env.restore());
	updateSettings((settings) => {
		settings.connections = [{ id: "openai-codex", runtime: "openai-codex", defaultModel: "gpt-6-sol" }];
		settings.fleet.profiles = Object.fromEntries(
			["old", "keep", "fast-sol"].map((name) => [
				name,
				{ connection: settings.connections[0]?.id ?? "openai-codex", model: "gpt-6-sol", thinkingLevel: "low" },
			]),
		);
		settings.fleet.agentProfiles = { coder: "old", verifier: "keep" };
		return settings;
	});
	const tool = createConfigurePancodeTool(attended);
	const preview = await tool.run({
		action: "preview",
		path: "fleet.agentProfiles",
		value: JSON.stringify({ coder: "fast-sol", verifier: "keep" }),
	});
	const proposalId = /proposalId="([^"]+)"/.exec(preview.kind === "ok" ? preview.output : "")?.[1];
	ok(proposalId, JSON.stringify(preview));
	// Fleet routing is approved on the registry's confirmation rail, so the card is its detail.
	const card = tool.confirmationFor?.({ action: "apply", proposalId })?.detail ?? "";
	strictEqual((await tool.run({ action: "apply", proposalId })).kind, "ok");
	match(card, /fleet.agentProfiles.coder: old → fast-sol/);
	ok(!card.includes("verifier"));
	ok(!card.includes("{"));
	const escaped = await tool.run({
		action: "preview",
		path: "fleet.agentProfiles",
		value: JSON.stringify({ "coder\u001b[31m\nspoof": "fast-sol" }),
	});
	ok(escaped.kind === "ok", JSON.stringify(escaped));
	ok(!escaped.output.includes("\u001b"));
	ok(!escaped.output.includes("\nspoof"));
	const large = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`agent${i}${"x".repeat(160)}`, "fast-sol"]));
	const bounded = await tool.run({ action: "preview", path: "fleet.agentProfiles", value: JSON.stringify(large) });
	ok(bounded.kind === "ok", JSON.stringify(bounded));
	match(bounded.output, /more changed values/);
	ok((bounded.output.split("\n\nGuidance:\n")[0] ?? "").length < 3600);
});

test("configure_pancode fleet routing apply parks for the operator while its preview stays free", async (t) => {
	const env = await isolatePancodeEnv("pancode-configure-routing-yolo-");
	t.after(() => env.restore());
	updateSettings((settings) => {
		settings.connections = [{ id: "openai-codex", runtime: "openai-codex", defaultModel: "gpt-6-sol" }];
		settings.fleet.profiles = { fast: { connection: "openai-codex", model: "gpt-6-sol", thinkingLevel: "low" } };
		return settings;
	});
	const registry = defaultRegistry(env.dir);
	registry.register(createConfigurePancodeTool(attended));
	const asked: Array<{ actionClass: ActionClass; requestId: string; detail: string; card: string }> = [];
	registry.onPermissionRequired((call, decision, meta) => {
		// The operator's card carries the exact diff the apply saves, not only the proposal id.
		const view = mainApprovalRequestView(call, decision, meta, "default", undefined);
		asked.push({
			actionClass: decision.classification.actionClass,
			requestId: meta.requestId,
			detail: decision.kind === "ask" ? decision.rejection.detail : "",
			card: createPermissionOverlayBody(view).render(120).map(stripTerminalSequences).join("\n"),
		});
	});
	const routingPreview = await registry.invoke({
		tool: ToolNames.ConfigurePancode,
		args: { action: "preview", path: "fleet.agentProfiles", value: JSON.stringify({ coder: "fast" }) },
	});
	strictEqual(asked.length, 0, "previews stay free");
	const proposalId = proposalOf(routingPreview);
	const previewText =
		routingPreview.kind === "ok" && routingPreview.result.kind === "ok" ? routingPreview.result.output : "";
	match(previewText, /per-call connection and model/);
	const apply = registry.invoke({ tool: ToolNames.ConfigurePancode, args: { action: "apply", proposalId } });
	strictEqual(await settledWithin(apply, 50), "pending");
	strictEqual(asked.length, 1);
	match(asked[0]?.detail ?? "", /settings\.yaml/);
	match(asked[0]?.detail ?? "", /fleet\.agentProfiles\.coder: fast/);
	match(asked[0]?.card ?? "", /Settings change/);
	match(asked[0]?.card ?? "", /fleet\.agentProfiles\.coder: fast/);
	match(asked[0]?.card ?? "", /saves this change to your settings/);
	strictEqual(readSettings().fleet.agentProfiles?.coder, undefined);
	await registry.resumeParkedCalls({
		actionClass: asked[0]?.actionClass as ActionClass,
		requestId: asked[0]?.requestId as string,
		requestedBy: "contract-operator",
	});
	const settled = await apply;
	strictEqual(settled.kind, "ok", JSON.stringify(settled));
	strictEqual(readSettings().fleet.agentProfiles?.coder, "fast");
});

test("a headless edit of project routing settings is refused with the dispatch pin hint", async (t) => {
	const env = await isolatePancodeEnv("pancode-configure-routing-headless-");
	const previousCwd = process.cwd();
	const workspace = join(env.dir, "ws");
	mkdirSync(join(workspace, ".pancode"), { recursive: true });
	process.chdir(workspace);
	t.after(() => {
		process.chdir(previousCwd);
		env.restore();
	});
	const registry = yoloRegistry(workspace);
	registry.register(writeTool);
	registry.onPermissionRequired(() => registry.cancelParkedCalls(HEADLESS_PERMISSION_DENIED_REASON));
	const local = join(workspace, ".pancode", "settings.local.yaml");
	writeFileSync(local, "fleet: {}\n");
	const verdict = await registry.invoke({
		tool: ToolNames.Write,
		args: { path: ".pancode/settings.local.yaml", content: "fleet:\n  agentProfiles:\n    coder: fast\n" },
	});
	strictEqual(verdict.kind, "blocked");
	const text = verdict.kind === "blocked" && verdict.decision.kind !== "allow" ? verdict.decision.rejection.detail : "";
	match(text, /project-settings-confirm/);
	match(text, /dispatch's per-call connection and model/);
	strictEqual(readFileSync(local, "utf8"), "fleet: {}\n");
	ok(!existsSync(join(workspace, ".pancode", "settings.yaml")));
});

test("at yolo, headless and read-only configure_pancode only proposes: the diff and the operator's steps", async (t) => {
	const env = await isolatePancodeEnv("pancode-configure-propose-only-");
	t.after(() => env.restore());
	strictEqual(configurePancodeApplyRefusal({ autonomy: "default", interactive: true, readOnly: false }), null);
	match(configurePancodeApplyRefusal({ autonomy: "yolo", interactive: true, readOnly: false }) ?? "", /yolo/);
	match(configurePancodeApplyRefusal({ autonomy: "default", interactive: false, readOnly: false }) ?? "", /headless/);
	match(configurePancodeApplyRefusal({ autonomy: "default", interactive: true, readOnly: true }) ?? "", /read-only/);
	const proposeOnly = async (verdict: Promise<RegistryVerdict>) => {
		const text = outputOf(await verdict);
		match(text, /not applied/);
		match(text, /chat\.thinkingLevel: low → high/);
		match(text, /Operator steps: .*\/settings/);
		ok(!/proposalId=/.test(text), text);
	};
	const yolo = yoloRegistry(env.dir);
	yolo.register(createConfigurePancodeTool({ interactive: true, getAutonomy: () => "yolo" }));
	const headless = defaultRegistry(env.dir);
	headless.register(createConfigurePancodeTool({ interactive: false, getAutonomy: () => "default" }));
	const attendedRegistry = defaultRegistry(env.dir);
	attendedRegistry.register(createConfigurePancodeTool(attended));
	let asked = 0;
	for (const registry of [yolo, headless, attendedRegistry]) {
		registry.onPermissionRequired(() => {
			asked += 1;
			registry.cancelParkedCalls(HEADLESS_PERMISSION_DENIED_REASON);
		});
	}
	const preview = {
		tool: ToolNames.ConfigurePancode,
		args: { action: "preview", path: "chat.thinkingLevel", value: "high" },
	};
	const apply = { tool: ToolNames.ConfigurePancode, args: { action: "apply", proposalId: "any" } };
	await proposeOnly(yolo.invoke(preview));
	await proposeOnly(headless.invoke(preview));
	const readOnly = { turnConstraints: { readOnly: true as const } };
	await proposeOnly(attendedRegistry.invoke(preview, readOnly));
	for (const [registry, options] of [
		[yolo, undefined],
		[headless, undefined],
		[attendedRegistry, readOnly],
	] as const) {
		const verdict = await registry.invoke(apply, options);
		ok(verdict.kind !== "ok" || verdict.result.kind !== "ok", JSON.stringify(verdict));
	}
	strictEqual(asked, 0);
	strictEqual(readSettings().chat.thinkingLevel, "low");
	ok(!existsSync(join(pancodeStateDir(), "settings-changes.jsonl")));
});

test("configure_pancode sets a connection's routing fields, keeps the rest, and never takes a credential", async (t) => {
	const env = await isolatePancodeEnv("pancode-configure-target-");
	t.after(() => env.restore());
	updateSettings((settings) => {
		settings.connections = [
			{
				id: "gw",
				runtime: "openai-compat",
				url: "http://192.0.2.1:4000/v1",
				defaultModel: "old",
				pricing: "free",
				auth: { apiKeyEnvVar: "OLD_KEY" },
			},
		];
		return settings;
	});
	const tool = createConfigurePancodeTool(attended);
	const refused: Array<[string, string, RegExp]> = [
		["connections.gw", JSON.stringify({ auth: { apiKey: "sk-live-123" } }), /never stores credentials/],
		["connections.gw", JSON.stringify({ trustedUnmediated: true }), /cannot set connections\.gw\.trustedUnmediated/],
		["connections.gw", JSON.stringify({ auth: { apiKeyEnvVar: "sk-live-123" } }), /NAME of an environment variable/],
		["connections.gw", JSON.stringify({ url: "http://user:pw@host:4000" }), /must not carry credentials/],
		["connections.gw", JSON.stringify({ url: "http://host:4000/v1?api_key=x" }), /key or token/],
		["connections.new", JSON.stringify({ url: "http://host:4000" }), /needs a runtime/],
		["connections.new", JSON.stringify({ runtime: "no-such-runtime" }), /unknown runtime/],
		["connections.gw.url", JSON.stringify({ url: "http://host:4000" }), /names no connection/],
	];
	for (const [path, value, expected] of refused) {
		const result = await tool.run({ action: "preview", path, value });
		ok(result.kind === "error" && expected.test(result.message), `${path} ${value}: ${JSON.stringify(result)}`);
	}
	const preview = await tool.run({
		action: "preview",
		path: "connections.gw",
		value: JSON.stringify({ defaultModel: "mini/qwen", auth: { apiKeyEnvVar: "LITELLM_API_KEY" } }),
	});
	const text = preview.kind === "ok" ? preview.output : "";
	match(text, /defaultModel: old → mini\/qwen/);
	match(text, /apiKeyEnvVar: OLD_KEY → LITELLM_API_KEY/);
	const proposalId = /proposalId="([^"]+)"/.exec(text)?.[1];
	if (!proposalId) throw new Error(`preview omitted proposal id: ${text}`);
	strictEqual((await tool.run({ action: "apply", proposalId })).kind, "ok");
	const saved = readSettings().connections.find((target) => target.id === "gw");
	strictEqual(saved?.defaultModel, "mini/qwen");
	strictEqual(saved?.auth?.apiKeyEnvVar, "LITELLM_API_KEY");
	strictEqual(saved?.pricing, "free");
	strictEqual(saved?.url, "http://192.0.2.1:4000/v1");
	const headless = createConfigurePancodeTool({ interactive: false, getAutonomy: () => "default" });
	const added = await headless.run({
		action: "preview",
		path: "connections.lab",
		value: JSON.stringify({ runtime: "openai-compat", url: "http://192.0.2.9:8000/v1", defaultModel: "m" }),
	});
	match(
		added.kind === "ok" ? added.output : "",
		/pancode configure --id lab --runtime openai-compat --url http:\/\/192\.0\.2\.9:8000\/v1/,
	);
	strictEqual(readSettings().connections.length, 1);
});
