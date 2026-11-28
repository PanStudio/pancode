// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { deepStrictEqual, doesNotMatch, match, ok, strictEqual } from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmdirSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { homedir, networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DEFAULT_SETTINGS } from "../../src/core/defaults.js";
import { isSameOrDescendant } from "../../src/core/path-containment.js";
import { sandboxAvailability } from "../../src/core/sandbox/availability.js";
import { isGrantedEgressOrigin } from "../../src/core/sandbox/egress/policy.js";
import { AUTONOMY_HELP } from "../../src/core/settings-awareness.js";
import { ToolNames } from "../../src/core/tool-names.js";
import { pancodeConfigDir } from "../../src/core/xdg.js";
import { PLAYWRIGHT_CORE_VERSION, resolveBrowserComponent } from "../../src/domains/install/browser-component.js";
import { componentInstallDir } from "../../src/domains/install/components.js";
import { createMiddlewareBundle } from "../../src/domains/middleware/extension.js";
import type { ActionClass, ClassifierCall } from "../../src/domains/safety/action-classifier.js";
import { evaluateAdmission } from "../../src/domains/safety/admission.js";
import type { SafetyContract } from "../../src/domains/safety/contract.js";
import { denialLines } from "../../src/domains/safety/denial.js";
import { createEscapeScopeLedger, ESCAPE_SCOPE_CUSTOM_TYPE } from "../../src/domains/safety/escape-scope.js";
import { EMPTY_INFORMATION_FLOW_INPUT } from "../../src/domains/safety/information-flow.js";
import {
	createSafetyPolicyEngine,
	type OperatorDefaultScope,
	type OperatorYoloScope,
} from "../../src/domains/safety/policy-engine.js";
import {
	createSafetyJudge,
	operatorOnlyAsk,
	resolveSafetyJudgeConfig,
	type SafetyJudgeSubject,
} from "../../src/domains/safety/safety-judge.js";
import { UNSANDBOXED_REASON_REQUIRED_CODE } from "../../src/domains/safety/unsandboxed-reason.js";
import {
	createWorkspaceSnapshots,
	type WorkspaceSnapshotOutcome,
} from "../../src/domains/workspace-snapshots/store.js";
import { createLoopGuardRegistration } from "../../src/engine/loop-guard.js";
import { createWorkerSafety } from "../../src/engine/worker-tools.js";
import { effectiveScratchRoots } from "../../src/lib/scratch-roots/scratch-roots.js";
import { createAskUserTool } from "../../src/tools/ask-user.js";
import { bashTool } from "../../src/tools/bash.js";
import { createBrowserTool } from "../../src/tools/browser/index.js";
import {
	browserOutwardHosts,
	browserToolSurface,
	browserUngrantedEndpoint,
	grantBrowserEndpoint,
	grantBrowserHosts,
} from "../../src/tools/browser/surface.js";
import { editTool } from "../../src/tools/edit.js";
import { createRegistry } from "../../src/tools/registry.js";
import type { PermissionRequiredMeta, RegistryDeps } from "../../src/tools/registry-contract.js";
import { createRunScriptTool } from "../../src/tools/run-script.js";
import type { ToolSpec } from "../../src/tools/tool-spec.js";
import { verifyTool } from "../../src/tools/verify/index.js";
import { writeTool } from "../../src/tools/write.js";
import { loopSafety } from "../harness/loop-guard.js";
import { isolatePancodeEnv } from "../harness/scratch-env.js";

function workspace(prefix: string): string {
	return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

const bash = (command: string, extra: Record<string, unknown> = {}): ClassifierCall => ({
	tool: ToolNames.Bash,
	args: { command, ...extra },
});

/**
 * The main session's registry at autonomy default with the containment the
 * orchestrator wires, a judge seat that records what it was asked to review
 * and then gives no verdict, and a bash body that records how it was run.
 * With no permission listener an unjudged ask is denied, never run.
 */
function defaultSession(
	cwd: string,
	containment: { sandbox: boolean; snapshots: boolean },
	extra: Partial<RegistryDeps> = {},
) {
	const reviewed: SafetyJudgeSubject[] = [];
	const order: string[] = [];
	const registry = createRegistry({
		safety: createWorkerSafety({ cwd }),
		autonomy: () => "default",
		scratchRoots: () => [],
		containment: () => containment,
		safetyJudge: {
			review: (subject) => {
				reviewed.push(subject);
				return { kind: "skip" };
			},
			operatorApproved: () => {},
		},
		...extra,
	});
	const ran: Array<{ command: string; sandboxed: boolean }> = [];
	registry.register({
		...bashTool,
		run: async (args, options) => {
			order.push("body");
			ran.push({ command: String(args.command), sandboxed: options?.shellSandbox !== undefined });
			return { kind: "ok", output: "" };
		},
	});
	return { registry, ran, reviewed, order };
}

const reviewedCommands = (reviewed: SafetyJudgeSubject[]) => reviewed.map((subject) => String(subject.args?.command));

test("a contained unrecognized command and a named script run at default without an ask, in the sandbox", async () => {
	const cwd = workspace("pancode-contained-run-");
	writeFileSync(join(cwd, "x.sh"), "echo hi\n");
	const session = defaultSession(cwd, { sandbox: true, snapshots: false });
	for (const command of ["make bench", "bash x.sh"]) {
		strictEqual((await session.registry.invoke(bash(command))).kind, "ok", command);
	}
	deepStrictEqual(session.ran, [
		{ command: "make bench", sandboxed: true },
		{ command: "bash x.sh", sandboxed: true },
	]);
	deepStrictEqual(session.reviewed, []);
});

test("unsandboxed: true leaves containment for the operator alone; an outward call reaches the safety judge", async () => {
	const cwd = workspace("pancode-contained-leave-");
	const session = defaultSession(cwd, { sandbox: true, snapshots: false });
	const leave = bash("make bench", { unsandboxed: true, unsandboxed_reason: "it writes ~/.cache" });
	for (const call of [leave, bash("git push origin main"), bash("gh pr create")]) {
		strictEqual((await session.registry.invoke(call)).kind, "blocked", JSON.stringify(call.args));
	}
	deepStrictEqual(session.ran, []);
	deepStrictEqual(reviewedCommands(session.reviewed), ["git push origin main", "gh pr create"]);
	for (const subject of session.reviewed) strictEqual(operatorOnlyAsk(subject), null, String(subject.args?.command));
	// An escape that states no reason is refused before anyone reviews it: the card would have nothing to weigh.
	for (const unsandboxed_reason of [undefined, "  \n "]) {
		const unstated = await session.registry.invoke(
			bash("make bench", { unsandboxed: true, ...(unsandboxed_reason === undefined ? {} : { unsandboxed_reason }) }),
		);
		ok(unstated.kind === "blocked");
		strictEqual(unstated.decision.policy?.reasonCode, UNSANDBOXED_REASON_REQUIRED_CODE);
		match(unstated.reason, /unsandboxed: true needs unsandboxed_reason/u);
	}
	deepStrictEqual(reviewedCommands(session.reviewed), ["git push origin main", "gh pr create"]);
	deepStrictEqual(session.ran, []);
});

test("a verify check that runs a command is contained at default like bash; listing runs nothing and is not", async (t) => {
	const cwd = workspace("pancode-contained-verify-");
	writeFileSync(join(cwd, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));
	// verify resolves its checks in the process's working directory, as the main session runs it.
	const saved = process.cwd();
	process.chdir(cwd);
	t.after(() => process.chdir(saved));
	const session = defaultSession(cwd, { sandbox: true, snapshots: false });
	const checks: Array<{ check: unknown; sandboxed: boolean }> = [];
	session.registry.register({
		...verifyTool,
		run: async (args, options) => {
			checks.push({ check: args.check, sandboxed: options?.shellSandbox !== undefined });
			return { kind: "ok", output: "" };
		},
	});
	for (const args of [{ check: "test" }, {}]) {
		const verdict = await session.registry.invoke({ tool: ToolNames.Verify, args });
		strictEqual(verdict.kind, "ok", JSON.stringify(args));
	}
	deepStrictEqual(checks, [
		{ check: "test", sandboxed: true },
		{ check: undefined, sandboxed: false },
	]);
	deepStrictEqual(session.reviewed, []);
});

test("every browser op is contained at default like bash; a host beyond loopback asks before the page reaches it", async (t) => {
	const home = await isolatePancodeEnv("pancode-contained-browser-home-");
	t.after(() => home.restore());
	// A provisioned component, so only the host rule can ask.
	const pkg = join(componentInstallDir("browser", PLAYWRIGHT_CORE_VERSION), "node_modules", "playwright-core");
	mkdirSync(pkg, { recursive: true });
	writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "playwright-core", main: "index.js" }));
	writeFileSync(join(pkg, "index.js"), "");
	mkdirSync(join(pkg, "..", "..", "browsers", "chromium_headless_shell-1"), { recursive: true });
	const session = defaultSession(workspace("pancode-contained-browser-"), { sandbox: true, snapshots: false });
	const ran: Array<{ op: unknown; sandboxed: boolean }> = [];
	session.registry.register({
		...browserToolSurface,
		run: async (args, options) => {
			ran.push({ op: args.op, sandboxed: options?.shellSandbox !== undefined });
			return { kind: "ok", output: "" };
		},
	});
	for (const args of [
		{ op: "open", url: "http://127.0.0.1:5173/" },
		{ op: "run", script: "await page.click('#save')" },
		{ op: "look" },
		{ op: "serve", command: "npm run dev", ready: "http://127.0.0.1:5173/" },
		// Hermetic reaches loopback only: no host to ask for, and the body refuses this one plainly.
		{ op: "open", url: "https://example.com/", hermetic: true },
	]) {
		strictEqual((await session.registry.invoke({ tool: ToolNames.Browser, args })).kind, "ok", JSON.stringify(args));
	}
	const outward = await session.registry.invoke({
		tool: ToolNames.Browser,
		args: { op: "open", url: "https://example.com/" },
	});
	strictEqual(outward.kind, "blocked");
	deepStrictEqual(ran, [
		{ op: "open", sandboxed: true },
		{ op: "run", sandboxed: true },
		{ op: "look", sandboxed: true },
		{ op: "serve", sandboxed: true },
		{ op: "open", sandboxed: true },
	]);
});

test("a browser host granted beyond loopback lasts for its session: another session, or a switch back, asks again", async (t) => {
	const home = await isolatePancodeEnv("pancode-contained-browser-grant-");
	t.after(() => home.restore());
	const pkg = join(componentInstallDir("browser", PLAYWRIGHT_CORE_VERSION), "node_modules", "playwright-core");
	mkdirSync(pkg, { recursive: true });
	writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "playwright-core", main: "index.js" }));
	writeFileSync(join(pkg, "index.js"), "");
	mkdirSync(join(pkg, "..", "..", "browsers", "chromium_headless_shell-1"), { recursive: true });
	const { registry } = defaultSession(
		workspace("pancode-contained-browser-grant-"),
		{ sandbox: true, snapshots: false },
		{ operatorAttends: () => true },
	);
	// The body's own first step: grant the hosts admission just confirmed.
	registry.register({
		...browserToolSurface,
		run: async (args, options) => {
			grantBrowserHosts(options?.sessionId, browserOutwardHosts(args, options?.sessionId));
			return { kind: "ok", output: "" };
		},
	});
	const cards: Array<{ requestId: string; actionClass: ActionClass }> = [];
	registry.onPermissionRequired((_call, decision, meta) =>
		cards.push({ requestId: meta.requestId, actionClass: decision.classification.actionClass }),
	);
	const openIn = async (sessionId: string) => {
		const before = cards.length;
		const pending = registry.invoke(
			{ tool: ToolNames.Browser, args: { op: "open", url: "https://docs.example.org/guide" } },
			{ sessionId },
		);
		await new Promise((resolve) => setTimeout(resolve, 20));
		const card = cards.length > before ? cards.at(-1) : undefined;
		if (card) await registry.resumeParkedCalls({ ...card, requestedBy: "contract-operator" });
		return { sessionId, asked: card !== undefined, kind: (await pending).kind };
	};
	deepStrictEqual(
		[await openIn("A"), await openIn("A"), await openIn("B"), await openIn("A")],
		[
			{ sessionId: "A", asked: true, kind: "ok" },
			{ sessionId: "A", asked: false, kind: "ok" },
			{ sessionId: "B", asked: true, kind: "ok" },
			{ sessionId: "A", asked: true, kind: "ok" },
		],
	);
});

test("a browser attach asks once per CDP endpoint per session, whatever spelling names it", async (t) => {
	const home = await isolatePancodeEnv("pancode-contained-browser-attach-");
	t.after(() => home.restore());
	const pkg = join(componentInstallDir("browser", PLAYWRIGHT_CORE_VERSION), "node_modules", "playwright-core");
	mkdirSync(pkg, { recursive: true });
	writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "playwright-core", main: "index.js" }));
	writeFileSync(join(pkg, "index.js"), "");
	mkdirSync(join(pkg, "..", "..", "browsers", "chromium_headless_shell-1"), { recursive: true });
	const { registry } = defaultSession(
		workspace("pancode-contained-browser-attach-"),
		{ sandbox: true, snapshots: false },
		{ operatorAttends: () => true },
	);
	registry.register({
		...browserToolSurface,
		run: async (args, options) => {
			const grant = browserUngrantedEndpoint(args, options?.sessionId);
			if (grant !== undefined) grantBrowserEndpoint(options?.sessionId, grant);
			return { kind: "ok", output: "" };
		},
	});
	const cards: Array<{ requestId: string; actionClass: ActionClass; ruleId: string | undefined }> = [];
	registry.onPermissionRequired((_call, decision, meta) =>
		cards.push({
			requestId: meta.requestId,
			actionClass: decision.classification.actionClass,
			ruleId: decision.kind === "ask" ? decision.confirmationRuleId : undefined,
		}),
	);
	const attachIn = async (sessionId: string, endpoint: string) => {
		const before = cards.length;
		const pending = registry.invoke({ tool: ToolNames.Browser, args: { op: "attach", endpoint } }, { sessionId });
		await new Promise((resolve) => setTimeout(resolve, 20));
		const card = cards.length > before ? cards.at(-1) : undefined;
		if (card) await registry.resumeParkedCalls({ ...card, requestedBy: "contract-operator" });
		return { endpoint, asked: card?.ruleId ?? false, kind: (await pending).kind };
	};
	deepStrictEqual(
		[
			await attachIn("A", "9222"),
			await attachIn("A", "http://127.0.0.1:9222/json/version"),
			await attachIn("A", "127.0.0.1:9339"),
			await attachIn("B", "9222"),
		],
		[
			{ endpoint: "9222", asked: "browser-attach-endpoint", kind: "ok" },
			{ endpoint: "http://127.0.0.1:9222/json/version", asked: false, kind: "ok" },
			{ endpoint: "127.0.0.1:9339", asked: "browser-attach-endpoint", kind: "ok" },
			{ endpoint: "9222", asked: "browser-attach-endpoint", kind: "ok" },
		],
	);
});

test("a browser page reaches loopback and granted hosts only: every redirect hop is checked and only http(s) loads", async (t) => {
	const home = await isolatePancodeEnv("pancode-browser-reach-home-");
	t.after(() => home.restore());
	// A real Chromium: the operator's installed component, read-only, named by PANCODE_OPERATOR_COMPONENTS_DIR.
	if (resolveBrowserComponent() === null) {
		t.skip("no browser component: set PANCODE_OPERATOR_COMPONENTS_DIR to an installed components directory");
		return;
	}
	// A host that is not loopback but answers here, so an unchecked redirect hop would load it.
	const outward =
		Object.values(networkInterfaces())
			.flat()
			.find((a) => a?.family === "IPv4" && !a.internal)?.address ?? "ungranted.invalid";
	let port = 0;
	let secretHits = 0;
	const server = createServer((req, res) => {
		if (req.url === "/hop") {
			res.writeHead(302, { location: `http://${outward}:${port}/secret` }).end();
			return;
		}
		if (req.url === "/secret") secretHits++;
		res.writeHead(200, { "content-type": "text/html" });
		res.end(`<title>${req.url === "/secret" ? "SECRET PAGE" : "home"}</title><p>page</p>`);
	});
	await new Promise<void>((resolve) => server.listen(0, "0.0.0.0", resolve));
	t.after(() => server.close());
	port = (server.address() as AddressInfo).port;
	const dir = workspace("pancode-browser-reach-");
	const secretFile = join(dir, "secret.txt");
	writeFileSync(secretFile, "FILE-SECRET-CONTENT");
	const tool = createBrowserTool({ getWorkspaceRoot: () => dir });
	t.after(() => tool.closeSessions());
	const call = async (args: Record<string, unknown>) => {
		const result = await tool.run(args, { sessionId: "browser-reach" });
		return { kind: result.kind, text: result.kind === "ok" ? result.output : "message" in result ? result.message : "" };
	};

	const hop = await call({ op: "open", url: `http://127.0.0.1:${port}/hop` });
	strictEqual(hop.kind, "error", hop.text);
	match(hop.text, new RegExp(`blocked: ${outward.replace(/\./gu, "\\.")} not granted to this browser session`, "u"));
	ok(!hop.text.includes("SECRET PAGE"), hop.text);
	strictEqual(secretHits, 0);

	const fileUrl = pathToFileURL(secretFile).href;
	const opened = await call({ op: "open", url: fileUrl });
	strictEqual(opened.kind, "error", opened.text);
	match(opened.text, /only http and https URLs load/u);
	ok(!opened.text.includes("FILE-SECRET-CONTENT"), opened.text);
	const page = await call({ op: "open", url: `http://127.0.0.1:${port}/` });
	strictEqual(page.kind, "ok", page.text);
	const routed = await call({
		op: "run",
		script: `return await page.goto(${JSON.stringify(fileUrl)}).then(() => "loaded", () => "refused");`,
	});
	match(routed.text, /value: "refused"[\s\S]*blocked: file: URLs do not load/u);
	ok(!routed.text.includes("FILE-SECRET-CONTENT"), routed.text);

	if (outward === "ungranted.invalid") return;
	const granted = await call({ op: "open", url: `http://127.0.0.1:${port}/hop`, allow_hosts: [outward] });
	strictEqual(granted.kind, "ok", granted.text);
	match(granted.text, /title: SECRET PAGE/u);
	strictEqual(secretHits, 1);
});

// ob-yolo Q7: a recognized command with unsandboxed: true ran unconfined at default with no review.
// D9: an escape runs as the operator, so only their card approves it; no judge verdict does.
test("unsandboxed: true asks at default even for a recognized command, and only the operator's card runs it", async (t) => {
	const cwd = workspace("pancode-contained-escape-");
	writeFileSync(join(cwd, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));
	writeFileSync(join(cwd, "x.sh"), "echo hi\n");
	const saved = process.cwd();
	process.chdir(cwd);
	t.after(() => process.chdir(saved));
	const why = { unsandboxed: true, unsandboxed_reason: "the sandbox hid the npm cache" };
	const escapes: ClassifierCall[] = [
		bash("npm test", why),
		{ tool: ToolNames.Verify, args: { check: "test", ...why } },
		{ tool: ToolNames.RunScript, args: { interpreter: "bash", script: "x.sh", ...why } },
	];
	const session = () => {
		const ran: Array<{ tool: string; sandboxed: boolean }> = [];
		const reviewed: SafetyJudgeSubject[] = [];
		const recorder = (spec: ToolSpec): ToolSpec => ({
			...spec,
			run: async (_args, options) => {
				ran.push({ tool: spec.name, sandboxed: options?.shellSandbox !== undefined });
				return { kind: "ok" as const, output: "" };
			},
		});
		const judge = defaultSession(
			cwd,
			{ sandbox: true, snapshots: false },
			{
				safetyJudge: {
					review: (subject) => {
						reviewed.push(subject);
						return { kind: "allow", rule: "operator-named", reason: "the operator asked for it", build: "t", latencyMs: 0 };
					},
					operatorApproved: () => {},
				},
			},
		);
		for (const spec of [bashTool, verifyTool, createRunScriptTool({ getWorkspaceRoot: () => cwd })])
			judge.registry.register(recorder(spec));
		return { registry: judge.registry, ran, reviewed };
	};
	// A judge that would allow anything is never asked, and with nobody to answer the escape is refused.
	const unanswered = session();
	for (const call of escapes) {
		const verdict = await unanswered.registry.invoke(call);
		strictEqual(verdict.kind, "blocked", call.tool);
		strictEqual(verdict.decision.policy?.reasonCode, "sandbox-escape", call.tool);
		const { unsandboxed_reason: _, ...unstated } = call.args ?? {};
		const refused = await unanswered.registry.invoke({ tool: call.tool, args: unstated });
		strictEqual(
			refused.kind === "blocked" ? refused.decision.policy?.reasonCode : refused.kind,
			UNSANDBOXED_REASON_REQUIRED_CODE,
		);
	}
	deepStrictEqual([unanswered.ran, unanswered.reviewed], [[], []]);
	// The same calls without the flag run contained with no ask.
	for (const call of escapes) {
		const { unsandboxed: _, unsandboxed_reason: __, ...args } = call.args ?? {};
		strictEqual((await unanswered.registry.invoke({ tool: call.tool, args })).kind, "ok", call.tool);
	}
	deepStrictEqual(
		unanswered.ran.map((entry) => entry.sandboxed),
		[true, true, true],
	);
	// The operator's card approves each escape, which then runs outside the sandbox.
	const carded = session();
	const cards: Array<{ requestId: string }> = [];
	carded.registry.onPermissionRequired((_call, _decision, meta) => cards.push(meta));
	for (const call of escapes) {
		const pending = carded.registry.invoke(call);
		await new Promise((settle) => setTimeout(settle, 20));
		const card = cards.at(-1);
		ok(card !== undefined, call.tool);
		await carded.registry.resumeParkedCalls({
			actionClass: "execute",
			requestId: card.requestId,
			requestedBy: "operator",
		});
		strictEqual((await pending).kind, "ok", call.tool);
	}
	strictEqual(cards.length, 3);
	deepStrictEqual(carded.reviewed, []);
	deepStrictEqual(
		carded.ran.map((entry) => entry.sandboxed),
		[false, false, false],
	);
});

// bt-21: a shell write to an outside path the operator named was blocked, and no approval card ever appeared.
// D9: such an escape goes to the card unjudged; with nobody to answer it is refused.
test("an escape the operator's words name still goes to the approval card unjudged, never runs on its own", async (t) => {
	const cwd = workspace("pancode-escape-target-");
	const outside = workspace("pancode-escape-outside-");
	const saved = process.cwd();
	process.chdir(cwd);
	t.after(() => process.chdir(saved));
	const named = join(outside, "log.txt");
	const session = (attends: boolean) => {
		let consulted = 0;
		const judge = createSafetyJudge({
			config: () => ({ enabled: true, target: "local", model: "m", environment: [], allow: [], deny: [] }),
			complete: async () => {
				consulted += 1;
				return { text: JSON.stringify({ verdict: "allow", rule: "operator-named", reason: "Named." }) };
			},
			operatorMessages: () => [`Append the line \`median fixed\` to ${named} running it unsandboxed.`],
			session: () => "s",
			consequences: () => [],
		});
		const { registry, ran } = defaultSession(
			cwd,
			{ sandbox: true, snapshots: false },
			{ safetyJudge: judge, operatorAttends: () => attends },
		);
		const cards: Array<{ requestId: string; gateReason?: string }> = [];
		if (attends) registry.onPermissionRequired((_call, _decision, meta) => cards.push(meta));
		return { registry, ran, cards, consulted: () => consulted };
	};
	const append = bash(`printf '%s\\n' 'median fixed' >> ${named}`, {
		unsandboxed: true,
		unsandboxed_reason: "the target is outside the writable roots",
	});
	const attended = session(true);
	const pending = attended.registry.invoke(append);
	await new Promise((resolve) => setTimeout(resolve, 20));
	strictEqual(attended.cards.length, 1);
	strictEqual(attended.cards[0]?.gateReason, undefined);
	attended.registry.cancelParkedCall(attended.cards[0]?.requestId ?? "", "denied", { denied: true });
	strictEqual((await pending).kind, "blocked");
	const headless = session(false);
	strictEqual((await headless.registry.invoke(append)).kind, "blocked");
	deepStrictEqual([...attended.ran, ...headless.ran], []);
	strictEqual(attended.consulted() + headless.consulted(), 0);
});

test("with no sandbox backend the default rails still ask", async () => {
	const cwd = workspace("pancode-contained-none-");
	const session = defaultSession(cwd, { sandbox: false, snapshots: false });
	strictEqual((await session.registry.invoke(bash("make bench"))).kind, "blocked");
	deepStrictEqual(session.ran, []);
	deepStrictEqual(reviewedCommands(session.reviewed), ["make bench"]);
});

test("git reset --hard runs after its snapshot, is refused without one, and asks when snapshots are off", async () => {
	const cwd = workspace("pancode-contained-reset-");
	const taken = (order: string[]) => async (): Promise<WorkspaceSnapshotOutcome> => {
		order.push("snapshot");
		return { kind: "taken", record: {} as never, reused: false, durationMs: 0 };
	};
	const order: string[] = [];
	const snapshotted = defaultSession(cwd, { sandbox: true, snapshots: true }, { workspaceSnapshot: taken(order) });
	strictEqual((await snapshotted.registry.invoke(bash("git reset --hard"))).kind, "ok");
	deepStrictEqual([...order, ...snapshotted.order], ["snapshot", "body"]);
	deepStrictEqual(snapshotted.reviewed, []);

	const failed = defaultSession(
		cwd,
		{ sandbox: true, snapshots: true },
		{ workspaceSnapshot: async () => ({ kind: "unavailable", reason: "git timed out", durationMs: 0 }) },
	);
	const refused = await failed.registry.invoke(bash("git reset --hard"));
	strictEqual(refused.kind === "blocked" && refused.decision.policy?.reasonCode, "snapshot-required");
	deepStrictEqual(failed.ran, []);

	const off = defaultSession(cwd, { sandbox: true, snapshots: false });
	strictEqual((await off.registry.invoke(bash("git reset --hard"))).kind, "blocked");
	deepStrictEqual(off.ran, []);
	deepStrictEqual(reviewedCommands(off.reviewed), ["git reset --hard"]);
});

test("a recoverable stash drop is refused when its snapshot cannot pin the stash", async () => {
	const cwd = workspace("pancode-contained-pins-");
	const git = (...args: string[]) =>
		spawnSync("git", ["-c", "user.name=fixture", "-c", "user.email=fixture@invalid", ...args], { cwd, encoding: "utf8" });
	git("init", "-q");
	writeFileSync(join(cwd, "a.txt"), "one\n");
	git("add", ".");
	git("commit", "-qm", "init");
	writeFileSync(join(cwd, "a.txt"), "two\n");
	git("stash", "push", "-q");
	// A ref where the pin directory belongs fails every pin write; the files snapshot still lands.
	git("update-ref", "refs/pancode/snapshots/s-1/pins", "HEAD");
	const snapshots = createWorkspaceSnapshots({
		stateDir: workspace("pancode-contained-pins-state-"),
		sessionId: "s-1",
		cwd,
	});
	const session = defaultSession(
		cwd,
		{ sandbox: true, snapshots: true },
		{ workspaceSnapshot: (request) => snapshots.snapshot(request) },
	);
	const refused = await session.registry.invoke(bash("git stash drop"));
	strictEqual(refused.kind === "blocked" && refused.decision.policy?.reasonCode, "snapshot-required");
	match(refused.kind === "blocked" ? refused.reason : "", /could not pin the stash/);
	deepStrictEqual(session.ran, []);
	strictEqual(snapshots.list().length, 1);
});

// N3: a scratch-root delete was journaled snapshot-recoverable, though no workspace snapshot covers a scratch root.
test("a lone delete inside a scratch root runs as scratch-disposable and needs no workspace snapshot", async () => {
	const cwd = workspace("pancode-contained-scratch-rm-ws-");
	const scratch = workspace("pancode-contained-scratch-rm-");
	const session = defaultSession(
		cwd,
		{ sandbox: true, snapshots: true },
		{ workspaceSnapshot: async () => ({ kind: "unavailable", reason: "git timed out", durationMs: 0 }) },
	);
	const ran = await session.registry.invoke(bash(`rm -rf ${join(scratch, "build")}`));
	strictEqual(ran.kind, "ok", JSON.stringify(ran));
	const policy = ran.kind === "ok" ? ran.decision.policy : undefined;
	strictEqual(policy?.reasonCode, "scratch-disposable");
	strictEqual(policy?.recoverable, undefined);
	deepStrictEqual(session.reviewed, []);
});

// cw-5: a lane's rm under its own $TMPDIR was refused as destroy-data; the judge was never told the scratch roots.
test("the judge reads the session's workspace and scratch roots by path, and a delete escaping them by its real target", async (t) => {
	const cwd = workspace("pancode-judge-roots-ws-");
	const temp = workspace("pancode-judge-roots-tmp-");
	// Every temp tree is a scratch root, and the escape target must be in none of them, so it
	// lives in the checkout's gitignored tmp/ rather than under tmpdir() (FX-8).
	const parent = fileURLToPath(new URL("../../tmp/", import.meta.url));
	const madeParent = !existsSync(parent);
	mkdirSync(parent, { recursive: true });
	const outside = realpathSync(mkdtempSync(join(parent, "pancode-judge-roots-out-")));
	symlinkSync(outside, join(temp, "link"));
	const saved = { cwd: process.cwd(), tmp: process.env.TMPDIR };
	process.env.TMPDIR = temp;
	process.chdir(cwd);
	t.after(() => {
		process.chdir(saved.cwd);
		if (saved.tmp === undefined) delete process.env.TMPDIR;
		else process.env.TMPDIR = saved.tmp;
		rmSync(outside, { recursive: true, force: true });
		if (madeParent) rmdirSync(parent);
	});
	const holder = effectiveScratchRoots(DEFAULT_SETTINGS.safety.scratchRoots, cwd).find((root) =>
		isSameOrDescendant(outside, root),
	);
	if (holder !== undefined) {
		t.skip(`the checkout lies in scratch root ${holder}, so no escape target outside every scratch root exists`);
		return;
	}
	const prompts: Array<{ system: string; user: string }> = [];
	const judge = createSafetyJudge({
		config: () => ({ ...resolveSafetyJudgeConfig(DEFAULT_SETTINGS, cwd), target: "local" }),
		complete: async ({ system, user }) => {
			prompts.push({ system, user });
			return { text: JSON.stringify({ verdict: "allow", rule: "scratch", reason: "inside a scratch root" }) };
		},
		operatorMessages: () => ["remove your scratch files when done"],
		session: () => "s",
		consequences: () => [],
	});
	const { registry } = defaultSession(cwd, { sandbox: false, snapshots: false }, { safetyJudge: judge });
	for (const command of [`rm -rf ${temp}/sub`, `rm -rf "$TMPDIR/sub"`, `rm -rf ${temp}/link/`]) {
		strictEqual((await registry.invoke(bash(command))).kind, "ok", command);
	}
	strictEqual(prompts.length, 3);
	const system = prompts[0]?.system ?? "";
	ok(system.includes(`The workspace is ${cwd}.`), system);
	ok(system.includes(`- ${temp} (this process's temp directory, $TMPDIR)`), system);
	match(system, /strictly inside a scratch root is the scratch allow rule, never destroy-data/u);
	deepStrictEqual(new Set(prompts.map((prompt) => prompt.system)).size, 1);
	ok(prompts[2]?.user.includes(`delete-path-outside-workspace: ${outside}`), prompts[2]?.user);
});

test("a force push asks at default instead of being refused, and the floor still refuses", () => {
	const cwd = workspace("pancode-contained-resort-");
	const safety = createWorkerSafety({ cwd });
	const operatorDefault: OperatorDefaultScope = { level: "default", scratchRoots: [], sandbox: true, snapshots: true };
	const admit = (call: ClassifierCall) =>
		evaluateAdmission({ principal: "main", effects: [call], safety, autonomy: "default", operatorDefault });
	const push = admit(bash("git push --force origin main"));
	strictEqual(push.kind === "ask" && push.approvalAuthority, "operator");
	strictEqual(push.decision.policy?.reasonCode, "damage-control:git-push-force-main");
	// Without the operator's scope (a worker, a grant, a command job) it stays a hard block.
	strictEqual(
		evaluateAdmission({ principal: "main", effects: [bash("git push --force origin main")], safety }).kind,
		"deny",
	);
	const floor = admit(bash("rm -rf ~"));
	strictEqual(floor.kind === "deny" && floor.decision.policy?.reasonCode, "yolo-floor:rm-home-or-root");
});

test("reads of PanCode's credential store are floor at default and at yolo", async (t) => {
	const home = await isolatePancodeEnv("pancode-contained-credentials-");
	t.after(() => home.restore());
	const store = join(pancodeConfigDir(), "credentials.yaml");
	mkdirSync(pancodeConfigDir(), { recursive: true });
	writeFileSync(store, "openai: x\n");
	const engine = createSafetyPolicyEngine({ cwd: workspace("pancode-contained-credentials-ws-") });
	const operatorDefault: OperatorDefaultScope = { level: "default", scratchRoots: [], sandbox: true, snapshots: true };
	for (const call of [{ tool: ToolNames.Read, args: { path: store } }, bash(`cat ${store}`)]) {
		for (const decision of [
			engine.evaluate(call, undefined, operatorDefault),
			engine.evaluate(call, "yolo", { scratchRoots: [] }),
		]) {
			strictEqual(decision.kind, "block", JSON.stringify(call.args));
			strictEqual(decision.reasonCode, "yolo-floor:yolo-floor-pancode-credentials", JSON.stringify(call.args));
		}
	}
});

test("typed writes and edits inside a scratch root run at default with no ask, even with the sandbox off", async (t) => {
	const cwd = workspace("pancode-contained-scratch-write-ws-");
	// $TMPDIR is a built-in scratch root, and the typed tools resolve paths against the process cwd.
	const scratch = workspace("pancode-contained-scratch-write-");
	const saved = process.cwd();
	process.chdir(cwd);
	t.after(() => process.chdir(saved));
	const session = defaultSession(cwd, { sandbox: false, snapshots: false });
	session.registry.register(writeTool);
	session.registry.register(editTool);
	const target = join(scratch, "smoke", "analyze.py");
	const calls: ClassifierCall[] = [
		{ tool: ToolNames.Write, args: { path: target, content: "print(1)\n" } },
		// The file now exists, so these used to ask under outside-file-replacement.
		{ tool: ToolNames.Edit, args: { path: target, edits: [{ oldText: "print(1)", newText: "print(2)" }] } },
		{ tool: ToolNames.Write, args: { path: target, content: "print(3)\n" } },
	];
	for (const call of calls) {
		const verdict = await session.registry.invoke(call);
		strictEqual(verdict.kind, "ok", verdict.kind === "blocked" ? verdict.reason : call.tool);
	}
	strictEqual(readFileSync(target, "utf8"), "print(3)\n");
	deepStrictEqual(session.reviewed, []);
});

test("outside scratch roots, in a scratch repository's .git and on secret paths the write rails still hold", () => {
	const cwd = workspace("pancode-contained-scratch-rails-ws-");
	const scratch = workspace("pancode-contained-scratch-rails-");
	const safety = createWorkerSafety({ cwd });
	const operatorDefault: OperatorDefaultScope = { level: "default", scratchRoots: [], sandbox: true, snapshots: true };
	const write = (path: string): ClassifierCall => ({ tool: ToolNames.Write, args: { path, content: "x" } });
	const admit = (call: ClassifierCall) =>
		evaluateAdmission({ principal: "main", effects: [call], safety, autonomy: "default", operatorDefault });
	// /opt is never a scratch root, so this path is outside every one on any host.
	const outside = admit(write("/opt/pancode-contained-scratch-probe/x.txt"));
	strictEqual(outside.kind === "ask" && outside.decision.policy?.reasonCode, "system-modify-confirm");
	const hook = admit(write(join(scratch, "repo", ".git", "hooks", "pre-commit")));
	strictEqual(hook.kind === "ask" && hook.decision.policy?.reasonCode, "git-control-file");
	const secret = admit(write(join(scratch, "server.pem")));
	strictEqual(secret.kind === "deny" && secret.decision.policy?.reasonCode, "path-policy:zeroAccessPaths");
	// Without the operator's scope (a worker, a grant, a command job) a scratch write keeps its ask.
	const unscoped = evaluateAdmission({ principal: "main", effects: [write(join(scratch, "a.txt"))], safety });
	strictEqual(unscoped.kind, "ask");
});

test("at default the main session reads outside the workspace, and replacing an existing outside file asks", (t) => {
	const cwd = workspace("pancode-contained-outside-ws-");
	// A tracked repository file: it exists, and it lies outside the workspace and every scratch root.
	const outside = realpathSync(fileURLToPath(new URL("../../package.json", import.meta.url)));
	// A checkout under a temp tree (release qualification runs one there) lies in a scratch root, where a write runs.
	const holder = effectiveScratchRoots(DEFAULT_SETTINGS.safety.scratchRoots, cwd).find((root) =>
		isSameOrDescendant(outside, root),
	);
	if (holder !== undefined) {
		t.skip(`the checkout lies in scratch root ${holder}, so its package.json is no outside file`);
		return;
	}
	// The typed tools resolve paths against the process cwd, which a session sets to its workspace.
	const saved = process.cwd();
	process.chdir(cwd);
	t.after(() => process.chdir(saved));
	const safety = createWorkerSafety({ cwd });
	const operatorDefault: OperatorDefaultScope = { level: "default", scratchRoots: [], sandbox: false, snapshots: true };
	const admit = (call: ClassifierCall) =>
		evaluateAdmission({ principal: "main", effects: [call], safety, autonomy: "default", operatorDefault });
	const read = admit({ tool: ToolNames.Read, args: { path: outside } });
	strictEqual(read.kind, "allow");
	strictEqual(read.decision.policy?.readScope, undefined);
	const replace = admit({ tool: ToolNames.Write, args: { path: outside, content: "x" } });
	strictEqual(replace.kind === "ask" && replace.approvalAuthority, "operator");
	strictEqual(replace.decision.policy?.reasonCode, "outside-file-replacement");
	strictEqual(admit({ tool: ToolNames.Write, args: { path: join(cwd, "a.txt"), content: "x" } }).kind, "allow");
	// The posture the model is told states the same thing.
	match(AUTONOMY_HELP.default, /read anywhere outside secret paths/);
	ok(!/reads outside the workspace/.test(AUTONOMY_HELP.default));
});

test("a typed write to the workspace repository's hooks asks at default, and an ordinary workspace file runs", (t) => {
	const cwd = workspace("pancode-contained-git-control-");
	mkdirSync(join(cwd, ".git"));
	const saved = process.cwd();
	process.chdir(cwd);
	t.after(() => process.chdir(saved));
	const safety = createWorkerSafety({ cwd });
	const operatorDefault: OperatorDefaultScope = { level: "default", scratchRoots: [], sandbox: true, snapshots: true };
	const admit = (path: string) =>
		evaluateAdmission({
			principal: "main",
			effects: [{ tool: ToolNames.Write, args: { path, content: "x" } }],
			safety,
			autonomy: "default",
			operatorDefault,
		});
	const hook = admit(".git/hooks/pre-commit");
	strictEqual(hook.kind === "ask" && hook.decision.policy?.reasonCode, "git-control-file");
	strictEqual(admit("src/app.py").kind, "allow");
});

test("a worker's typed write to its repository's hooks asks the main agent at default, and an ordinary file runs", (t) => {
	const cwd = workspace("pancode-worker-git-control-");
	mkdirSync(join(cwd, ".git"));
	const saved = process.cwd();
	process.chdir(cwd);
	t.after(() => process.chdir(saved));
	const safety = createWorkerSafety({ cwd, writeRoots: [`${cwd}/`] });
	const admit = (path: string) =>
		evaluateAdmission({
			principal: "worker",
			effects: [{ tool: ToolNames.Write, args: { path, content: "x" } }],
			safety,
		});
	const hook = admit(".git/hooks/pre-commit");
	strictEqual(hook.kind === "ask" && hook.approvalAuthority, "main");
	strictEqual(hook.decision.policy?.ruleId, "git-control-file");
	strictEqual(admit("src/app.py").kind, "allow");
});

test("a typed write into a repository created after the engine was built asks at default, main and worker alike", (t) => {
	const cwd = workspace("pancode-git-control-late-");
	const saved = process.cwd();
	process.chdir(cwd);
	t.after(() => process.chdir(saved));
	const main = createWorkerSafety({ cwd });
	const worker = createWorkerSafety({ cwd, writeRoots: [`${cwd}/`] });
	spawnSync("git", ["init", "-q"], { cwd });
	spawnSync("git", ["init", "-q", "nested"], { cwd });
	const operatorDefault: OperatorDefaultScope = { level: "default", scratchRoots: [], sandbox: true, snapshots: true };
	const write = (path: string): ClassifierCall => ({ tool: ToolNames.Write, args: { path, content: "x" } });
	const admitMain = (path: string) =>
		evaluateAdmission({ principal: "main", effects: [write(path)], safety: main, autonomy: "default", operatorDefault });
	const admitWorker = (path: string) =>
		evaluateAdmission({ principal: "worker", effects: [write(path)], safety: worker });
	for (const path of [".git/hooks/pre-commit", "nested/.git/hooks/pre-commit"]) {
		const asked = admitMain(path);
		strictEqual(asked.kind === "ask" && asked.decision.policy?.reasonCode, "git-control-file", path);
		const workerAsked = admitWorker(path);
		strictEqual(workerAsked.kind === "ask" && workerAsked.approvalAuthority, "main", path);
		strictEqual(workerAsked.decision.policy?.ruleId, "git-control-file", path);
	}
	strictEqual(admitMain("src/app.py").kind, "allow");
	strictEqual(admitWorker("src/app.py").kind, "allow");
});

test("a typed write into the core.hooksPath directory asks at default, also once the session has set it", (t) => {
	const cwd = workspace("pancode-git-control-hooks-path-");
	const saved = process.cwd();
	process.chdir(cwd);
	t.after(() => process.chdir(saved));
	spawnSync("git", ["init", "-q"], { cwd });
	mkdirSync(join(cwd, ".githooks"));
	const before = createWorkerSafety({ cwd });
	spawnSync("git", ["config", "core.hooksPath", ".githooks"], { cwd });
	const main = createWorkerSafety({ cwd });
	const worker = createWorkerSafety({ cwd, writeRoots: [`${cwd}/`] });
	const operatorDefault: OperatorDefaultScope = { level: "default", scratchRoots: [], sandbox: true, snapshots: true };
	const write = (path: string): ClassifierCall => ({ tool: ToolNames.Write, args: { path, content: "x" } });
	const admitMain = (safety: typeof main, call: ClassifierCall) =>
		evaluateAdmission({ principal: "main", effects: [call], safety, autonomy: "default", operatorDefault });
	const asked = admitMain(main, write(".githooks/pre-commit"));
	strictEqual(asked.kind === "ask" && asked.decision.policy?.reasonCode, "git-control-file");
	const workerAsked = evaluateAdmission({
		principal: "worker",
		effects: [write(".githooks/pre-commit")],
		safety: worker,
	});
	strictEqual(workerAsked.kind === "ask" && workerAsked.approvalAuthority, "main");
	strictEqual(admitMain(main, write("src/app.py")).kind, "allow");
	// An engine built before the setting re-reads it after an admitted command that may have written it.
	strictEqual(admitMain(before, bash("git config core.hooksPath .githooks")).kind, "allow");
	const refreshed = admitMain(before, write(".githooks/pre-commit"));
	strictEqual(refreshed.kind === "ask" && refreshed.decision.policy?.reasonCode, "git-control-file");
});

test("typed writes and edits to protected startup paths require operator approval, bypass the judge, and deny in headless, contained yolo, and workers", async (t) => {
	const cwd = workspace("pancode-startup-paths-typed-");
	const saved = process.cwd();
	process.chdir(cwd);
	t.after(() => process.chdir(saved));
	mkdirSync(join(cwd, ".vscode"), { recursive: true });
	mkdirSync(join(cwd, ".claude"), { recursive: true });
	mkdirSync(join(cwd, ".husky"), { recursive: true });
	writeFileSync(join(cwd, ".vscode", "tasks.json"), "{}\n");
	writeFileSync(join(cwd, ".claude", "settings.json"), "{}\n");
	writeFileSync(join(cwd, ".envrc"), "export A=1\n");
	const main = createWorkerSafety({ cwd });
	const worker = createWorkerSafety({ cwd, writeRoots: [`${cwd}/`] });
	const operatorDefault: OperatorDefaultScope = { level: "default", scratchRoots: [], sandbox: true, snapshots: true };
	const writeCall = (path: string) => ({ tool: ToolNames.Write, args: { path, content: "x" } });
	const editCall = (path: string) => ({
		tool: ToolNames.Edit,
		args: { path, old_string: "{}\n", new_string: '{"x":1}\n' },
	});
	const askCases = [
		writeCall(".vscode/tasks.json"),
		editCall(".vscode/tasks.json"),
		writeCall(".husky/pre-commit"),
		writeCall(".idea/workspace.xml"),
		writeCall(".devcontainer/devcontainer.json"),
		writeCall(".envrc"),
		writeCall(".mcp.json"),
		writeCall(".gitmodules"),
		writeCall(join(homedir(), ".zprofile")),
	];
	for (const call of askCases) {
		const asked = evaluateAdmission({
			principal: "main",
			effects: [call],
			safety: main,
			autonomy: "default",
			operatorDefault,
		});
		strictEqual(asked.kind, "ask", `${call.tool} ${String(call.args.path)} should ask in main`);
		if (asked.kind !== "ask") continue;
		strictEqual(asked.approvalAuthority, "operator");
		strictEqual(asked.decision.policy?.ruleId, "startup-path-confirm");
		strictEqual(
			operatorOnlyAsk({
				tool: call.tool,
				args: call.args,
				decision: asked.decision,
				source: asked.source,
				approvalAuthority: asked.approvalAuthority,
			}),
			"rule startup-path-confirm",
		);
		const confirmed = evaluateAdmission({
			principal: "main",
			effects: [call],
			safety: main,
			autonomy: "default",
			operatorDefault,
			authorization: { issuer: "operator", actionClass: asked.decision.classification.actionClass },
		});
		strictEqual(
			confirmed.kind,
			"allow",
			`${call.tool} ${String(call.args.path)} should allow after operator confirmation`,
		);
		for (const workerOpts of [{}, { workerExecuteAutonomy: "yolo" as const }]) {
			const workerDenied = evaluateAdmission({
				principal: "worker",
				effects: [call],
				safety: worker,
				...workerOpts,
			});
			strictEqual(workerDenied.kind, "deny", `worker should deny ${call.tool} ${String(call.args.path)}`);
		}
	}
	// Startup paths already hard-blocked by path policy (foreign agent dirs, shell rc) remain denied in main and workers.
	for (const call of [
		writeCall(".claude/settings.json"),
		editCall(".claude/settings.json"),
		writeCall(join(homedir(), ".bashrc")),
	]) {
		strictEqual(
			evaluateAdmission({ principal: "main", effects: [call], safety: main, autonomy: "default", operatorDefault }).kind,
			"deny",
			`main should keep denying ${call.tool} ${String(call.args.path)}`,
		);
		strictEqual(
			evaluateAdmission({ principal: "worker", effects: [call], safety: worker, workerExecuteAutonomy: "yolo" }).kind,
			"deny",
			`worker should keep denying ${call.tool} ${String(call.args.path)}`,
		);
	}
	// Headless main session (no park listener) denies without consulting the judge; contained yolo also denies.
	let judgedCalls = 0;
	const judge = createSafetyJudge({
		config: () => ({ enabled: true, target: "local", model: "m", environment: [], allow: [], deny: [] }),
		complete: async () => {
			judgedCalls += 1;
			return { text: JSON.stringify({ verdict: "allow", rule: "operator-named", reason: "ok" }) };
		},
		operatorMessages: () => ["update .vscode/tasks.json"],
		session: () => "s",
		consequences: () => [],
	});
	for (const unattendedAsks of [false, true]) {
		const registry = createRegistry({
			safety: createWorkerSafety({ cwd }),
			autonomy: () => "default",
			unattendedAsks: () => unattendedAsks,
			scratchRoots: () => [],
			containment: () => ({ sandbox: true, snapshots: true }),
			safetyJudge: judge,
		});
		registry.register(writeTool);
		const verdict = await registry.invoke(writeCall(".vscode/tasks.json"));
		strictEqual(
			verdict.kind,
			"blocked",
			`${unattendedAsks ? "contained yolo" : "headless default"} should deny startup-path write`,
		);
	}
	strictEqual(judgedCalls, 0, "safety judge must never review startup-path asks");
});

test("the default scratch roots include $TMPDIR and /tmp", () => {
	const roots = effectiveScratchRoots([], workspace("pancode-contained-scratch-"));
	ok(roots.includes(realpathSync(tmpdir())), roots.join(", "));
	ok(roots.includes(realpathSync("/tmp")), roots.join(", "));
});

test("under bwrap a contained main-session command writes the workspace and /tmp but not $HOME", async (t) => {
	const availability = sandboxAvailability();
	if (!availability.available || availability.backend !== "bwrap") {
		t.skip(`bubblewrap sandbox unavailable: ${availability.reason ?? "unsupported platform"}`);
		return;
	}
	// The assertion about $HOME means something only where the host itself can write it.
	if (spawnSync("bash", ["-c", 'test -w "$HOME"']).status !== 0) {
		t.skip("$HOME is not writable on this host");
		return;
	}
	const cwd = workspace("pancode-contained-bwrap-");
	const saved = process.cwd();
	process.chdir(cwd);
	t.after(() => process.chdir(saved));
	const registry = createRegistry({
		safety: createWorkerSafety({ cwd }),
		autonomy: () => "default",
		scratchRoots: () => [],
		containment: () => ({ sandbox: true, snapshots: false }),
	});
	registry.register(bashTool);
	// `test -w` asks the kernel, so a read-only bind answers no without a file being written.
	const verdict = await registry.invoke(
		bash('echo a > a.txt; test -w /tmp && echo tmp-writable; test -w "$HOME" || echo home-read-only'),
	);
	strictEqual(verdict.kind, "ok", verdict.kind === "blocked" ? verdict.reason : "");
	const output = verdict.kind === "ok" && verdict.result.kind === "ok" ? verdict.result.output : "";
	match(output, /tmp-writable/u);
	match(output, /home-read-only/u);
	strictEqual(existsSync(join(cwd, "a.txt")), true);
});

test("under bwrap the core.hooksPath directory is read-only for a contained command", async (t) => {
	const availability = sandboxAvailability();
	if (!availability.available || availability.backend !== "bwrap") {
		t.skip(`bubblewrap sandbox unavailable: ${availability.reason ?? "unsupported platform"}`);
		return;
	}
	const cwd = workspace("pancode-contained-hooks-path-");
	const saved = process.cwd();
	process.chdir(cwd);
	t.after(() => process.chdir(saved));
	spawnSync("git", ["init", "-q"], { cwd });
	spawnSync("git", ["config", "core.hooksPath", ".husky"], { cwd });
	mkdirSync(join(cwd, ".husky"));
	const registry = createRegistry({
		safety: createWorkerSafety({ cwd }),
		autonomy: () => "default",
		scratchRoots: () => [],
		containment: () => ({ sandbox: true, snapshots: false }),
	});
	registry.register(bashTool);
	const verdict = await registry.invoke(bash("echo a > a.txt; echo x > .husky/pre-commit || echo hooks-path-read-only"));
	strictEqual(verdict.kind, "ok", verdict.kind === "blocked" ? verdict.reason : "");
	const output = verdict.kind === "ok" && verdict.result.kind === "ok" ? verdict.result.output : "";
	match(output, /hooks-path-read-only/u);
	strictEqual(existsSync(join(cwd, "a.txt")), true);
	strictEqual(existsSync(join(cwd, ".husky", "pre-commit")), false);
});

/** A read-only main session's registry, recording the sandbox each bash call was given. */
function readOnlySession(cwd: string, readOnlySandbox: boolean, level: "default" | "yolo") {
	const reviewed: SafetyJudgeSubject[] = [];
	const registry = createRegistry({
		safety: createWorkerSafety({ cwd }),
		autonomy: () => level,
		readOnly: true,
		scratchRoots: () => [],
		containment: () => ({ sandbox: true, snapshots: true, readOnlySandbox }),
		currentSessionId: () => "s1",
		safetyJudge: {
			review: (subject) => {
				reviewed.push(subject);
				return { kind: "skip" };
			},
			operatorApproved: () => {},
		},
	});
	const ran: Array<{ command: string; readOnly: boolean; writableRoots: ReadonlyArray<string> }> = [];
	registry.register({
		...bashTool,
		run: async (args, options) => {
			ran.push({
				command: String(args.command),
				readOnly: options?.shellSandbox?.readOnly === true,
				writableRoots: options?.shellSandbox?.writableRoots ?? [],
			});
			return { kind: "ok", output: "" };
		},
	});
	return { registry, ran, reviewed };
}

for (const level of ["default", "yolo"] as const) {
	test(`a read-only session runs a contained command at ${level} in the read-only sandbox, and asks nobody`, async () => {
		const cwd = workspace("pancode-read-only-shell-");
		const session = readOnlySession(cwd, true, level);
		strictEqual((await session.registry.invoke(bash("make bench"))).kind, "ok");
		strictEqual(session.ran.length, 1);
		strictEqual(session.ran[0]?.readOnly, true);
		strictEqual(session.ran[0]?.writableRoots.length, 1);
		match(session.ran[0]?.writableRoots[0] ?? "", /\/scratch\/read-only\/s1$/u);
		for (const call of [bash("make bench", { unsandboxed: true }), bash("git push origin main")]) {
			const verdict = await session.registry.invoke(call);
			strictEqual(verdict.kind, "blocked", JSON.stringify(call.args));
			if (verdict.kind === "blocked") match(verdict.reason, /read-only/u);
		}
		strictEqual(session.ran.length, 1);
		deepStrictEqual(session.reviewed, []);
	});
}

test("a read-only session refuses shell commands where the read-only sandbox does not run", async () => {
	const session = readOnlySession(workspace("pancode-read-only-shell-none-"), false, "default");
	strictEqual((await session.registry.invoke(bash("make bench"))).kind, "blocked");
	deepStrictEqual(session.ran, []);
	deepStrictEqual(session.reviewed, []);
});

test("uncontained main-session shell commands journal sandbox.uncontained with the accurate reason once per session (P6)", async () => {
	const { telemetryContexts, telemetryHub } = await import("../../src/core/telemetry/hub.js");
	const { openCallJournal, readCallJournal } = await import("../../src/domains/telemetry/call-journal.js");
	const cwd = workspace("pancode-uncontained-why-");
	const seen: Array<{ caller: string; why: string; mode: string; backend: string | null }> = [];
	const unsub = telemetryHub().subscribe("sandbox.uncontained", (payload) => {
		seen.push(payload);
	});
	try {
		// Read-only without readOnlySandbox blocks shell execution altogether (never emits uncontained).
		const roRegistry = createRegistry({
			safety: createWorkerSafety({ cwd }),
			autonomy: () => "yolo",
			readOnly: true,
			scratchRoots: () => [],
			containment: () => ({ sandbox: true, snapshots: true, readOnlySandbox: false }),
			sandboxState: () => ({ mode: "auto", backend: "seatbelt" }),
			currentSessionId: () => "s-ro-seatbelt",
		});
		roRegistry.register({ ...bashTool, run: async () => ({ kind: "ok", output: "" }) });
		const roVerdict = await telemetryContexts.run(
			{ sessionId: "s-ro-seatbelt", agent: { role: "main", id: "s-ro-seatbelt" } },
			() => roRegistry.invoke(bash("ls")),
		);
		strictEqual(roVerdict.kind, "blocked");
		deepStrictEqual(seen, []);

		// Normal session with sandbox off, no backend, and yolo opt-in each journal their own reason once per session.
		const cases = [
			{
				sid: "s-off",
				autonomy: "default" as const,
				sandbox: false,
				state: { mode: "off" as const, backend: "bwrap" as const },
				why: "sandbox-off",
			},
			{
				sid: "s-nobackend",
				autonomy: "default" as const,
				sandbox: false,
				state: { mode: "auto" as const, backend: null },
				why: "no-backend",
			},
			{
				sid: "s-yolo",
				autonomy: "yolo" as const,
				sandbox: true,
				state: { mode: "auto" as const, backend: "bwrap" as const },
				why: "unconfined-opt-in",
			},
		];
		for (const each of cases) {
			seen.length = 0;
			const journalDir = workspace(`pancode-uncontained-journal-${each.sid}-`);
			const ctx = { sessionId: each.sid, agent: { role: "main" as const, id: each.sid } };
			const journal = await openCallJournal({
				directory: journalDir,
				context: ctx,
				writer: { pancodeVersion: "0.0.0-test", piVersion: "0.0.0-test" },
			});
			try {
				const registry = createRegistry({
					safety: createWorkerSafety({ cwd }),
					autonomy: () => each.autonomy,
					scratchRoots: () => [],
					containment: () => ({ sandbox: each.sandbox, snapshots: true }),
					sandboxState: () => each.state,
					currentSessionId: () => each.sid,
				});
				registry.register({ ...bashTool, run: async () => ({ kind: "ok", output: "" }) });
				strictEqual((await telemetryContexts.run(ctx, () => registry.invoke(bash("echo one")))).kind, "ok");
				strictEqual((await telemetryContexts.run(ctx, () => registry.invoke(bash("echo two")))).kind, "ok");
				await journal.flush();
				const rows = (await readCallJournal(journalDir)).records
					.map(({ record }) => record)
					.filter((record) => record.k === "sandbox.uncontained");
				deepStrictEqual(
					rows.map((row) => row.data),
					[{ caller: "main", why: each.why, mode: each.state.mode, backend: each.state.backend }],
				);
				deepStrictEqual(seen, [{ caller: "main", why: each.why, mode: each.state.mode, backend: each.state.backend }]);
			} finally {
				await journal.close();
			}
		}
	} finally {
		unsub();
	}
});

test("a read-only worker's shell command passes only when its sandbox confines every write, and never asks", () => {
	const cwd = workspace("pancode-read-only-worker-shell-");
	const safety = createWorkerSafety({ cwd });
	const admit = (command: string, confined: boolean, extra: Record<string, unknown> = {}) =>
		evaluateAdmission({
			principal: "worker",
			effects: [bash(command, extra)],
			safety,
			constraints: { readOnly: true },
			...(confined ? { readOnlyShellConfined: true } : {}),
		});
	strictEqual(admit("ls -la", true).kind, "allow");
	strictEqual(admit("ls -la", false).kind, "deny");
	strictEqual(admit("ls -la", true, { unsandboxed: true }).kind, "deny");
	const unrecognized = admit("make bench", true);
	strictEqual(unrecognized.kind === "deny" && unrecognized.code, "read_only");
});

test("a read-only run admits a dispatch, whose workers inherit read-only, and refuses steering", () => {
	const cwd = workspace("pancode-read-only-dispatch-");
	const safety = createWorkerSafety({ cwd });
	for (const principal of ["main", "worker"] as const) {
		const admit = (tool: string, args: Record<string, unknown>) =>
			evaluateAdmission({ principal, effects: [{ tool, args }], safety, constraints: { readOnly: true } });
		strictEqual(admit(ToolNames.Dispatch, { agent: "scout", task: "map the repo" }).kind, "allow", principal);
		const steer = admit(ToolNames.Steer, { run_id: "r1", action: "guide", message: "write it" });
		strictEqual(steer.kind === "deny" && steer.code, "read_only", principal);
		// Cancelling a run changes no file; the steer tool still refuses a run this session did not dispatch (CLI-P38).
		const cancel = admit(ToolNames.Steer, { run_id: "r1", action: "cancel" });
		strictEqual(cancel.kind, "allow", `${principal}: ${JSON.stringify(cancel)}`);
	}
});

test("an execute-class MCP tool call is not contained by the sandbox and goes to the judge under its own rule", async () => {
	const cwd = workspace("pancode-mcp-execute-");
	const session = defaultSession(cwd, { sandbox: true, snapshots: false });
	const sent: unknown[] = [];
	const name = "mcp_stub__send_note" as ToolSpec["name"];
	session.registry.register({
		name,
		description: "Sends a note. Local MCP server stub (user), trusted with action class execute.",
		parameters: bashTool.parameters,
		baseActionClass: "execute",
		safetyCall: () => ({ tool: ToolNames.Bash, args: { command: "python3 stub_mcp.py" }, projection: "mcp-server" }),
		run: async (args) => {
			sent.push(args);
			return { kind: "ok", output: "sent" };
		},
	});
	const result = await session.registry.invoke({ tool: name, args: { text: "hi" } });
	strictEqual(result.kind, "blocked", JSON.stringify(result));
	deepStrictEqual(sent, [], "an unjudged ask never reaches the server");
	strictEqual(session.reviewed.length, 1);
	const decision = session.reviewed[0]?.decision;
	strictEqual(decision?.kind, "ask");
	deepStrictEqual(
		{ ruleId: decision?.policy?.ruleId, source: decision?.policy?.policySource, sandbox: decision?.policy?.shellSandbox },
		{ ruleId: "mcp-execute", source: "mcp-trust", sandbox: undefined },
	);
});

/** A trusted execute-class MCP tool whose server launches with `command`, registered on `session`. */
function registerMcpExecute(session: ReturnType<typeof defaultSession>, command: string) {
	const sent: unknown[] = [];
	const name = "mcp_stub__send_message" as ToolSpec["name"];
	session.registry.register({
		name,
		description: "Sends a message. Local MCP server stub (user), trusted with action class execute.",
		parameters: bashTool.parameters,
		baseActionClass: "execute",
		safetyCall: () => ({ tool: ToolNames.Bash, args: { command }, projection: "mcp-server" }),
		run: async (args) => {
			sent.push(args);
			return { kind: "ok", output: "sent" };
		},
	});
	return { name, sent };
}

test("an execute-class MCP tool call asks at default even when a project policy approves its launch command", async () => {
	const cwd = workspace("pancode-mcp-execute-project-");
	const command = "python3 stub_mcp.py";
	// In-memory project policy; the named safety.yaml is never written.
	const policy = createSafetyPolicyEngine({
		cwd,
		projectPolicy: {
			trustVerdict: "trusted",
			path: join(cwd, ".pancode", "safety.yaml"),
			hash: null,
			valid: true,
			errors: [],
			commands: [
				{
					id: "stub-server",
					command,
					actionClass: "execute",
					shellOperators: "deny",
					env: { mode: "none", allow: [] },
					requireConfirmation: false,
				},
			],
			pathPolicy: {},
			disableDefaultPathPolicy: false,
			informationFlow: EMPTY_INFORMATION_FLOW_INPUT,
		},
	});
	const launch = policy.evaluate({ tool: ToolNames.Bash, args: { command } });
	strictEqual(launch.policySource, "project-policy", "the launch command itself is the project's approved command");
	const safety: SafetyContract = {
		...createWorkerSafety({ cwd }),
		evaluate(call, posture, scope) {
			const decision = policy.evaluate(call, posture, scope);
			strictEqual(decision.kind, "allow", call.tool);
			return { kind: "allow", classification: decision.classification, policy: decision };
		},
	};
	const session = defaultSession(cwd, { sandbox: true, snapshots: false }, { safety });
	const { name, sent } = registerMcpExecute(session, command);
	const result = await session.registry.invoke({ tool: name, args: { text: "hi" } });
	strictEqual(result.kind, "blocked", JSON.stringify(result));
	deepStrictEqual(sent, [], "an unjudged ask never reaches the server");
	const decision = session.reviewed[0]?.decision;
	strictEqual(decision?.kind, "ask");
	deepStrictEqual(
		{
			ruleId: decision?.policy?.ruleId,
			source: decision?.policy?.policySource,
			recognition: decision?.policy?.execRecognition,
		},
		{ ruleId: "mcp-execute", source: "mcp-trust", recognition: "unrecognized" },
	);
});

test("an MCP tool call keeps a rail's own ask or block, and at yolo is never refused as an unsandboxed script", () => {
	const engine = createSafetyPolicyEngine({ cwd: workspace("pancode-mcp-execute-yolo-") });
	const mcp = (command: string): ClassifierCall => ({
		tool: ToolNames.Bash,
		args: { command },
		projection: "mcp-server",
	});
	const floor = engine.evaluate(mcp("rm -rf ~"));
	strictEqual(floor.kind, "block");
	strictEqual(floor.ruleId === "mcp-execute", false, "a rail's block keeps its own rule");
	for (const scriptSandbox of ["refused", "sandboxed"] as const) {
		const scope: OperatorYoloScope = { scratchRoots: [], scriptSandbox };
		const decision = engine.evaluate(mcp("python3 ./stub_mcp.py"), "yolo", scope);
		deepStrictEqual(
			{ kind: decision.kind, ruleId: decision.ruleId, sandbox: decision.shellSandbox },
			{ kind: "allow", ruleId: "mcp-execute", sandbox: undefined },
			scriptSandbox,
		);
	}
});

// M-7: an escape approved for the session covers reruns of its exact, unchanged script files only.
test("a sandbox escape approved for this session covers reruns of the same unchanged script; anything else asks", async (t) => {
	const cwd = workspace("pancode-escape-scope-");
	mkdirSync(join(cwd, "probes"));
	mkdirSync(join(cwd, "other"));
	for (const file of ["probes/a.sh", "probes/b.sh", "other/c.sh"]) writeFileSync(join(cwd, file), "echo hi\n");
	const saved = process.cwd();
	process.chdir(cwd);
	t.after(() => process.chdir(saved));
	const entries: unknown[] = [];
	const ledger = () =>
		createEscapeScopeLedger({
			session: () => "session-1",
			entries: () => entries,
			append: (grant) => entries.push({ kind: "custom", customType: ESCAPE_SCOPE_CUSTOM_TYPE, data: grant }),
			roots: () => [cwd],
		});
	const unsandboxed = (command: string) => bash(command, { unsandboxed: true, unsandboxed_reason: "it needs the host" });

	// The approval card: the parked escape carries its scope, and the session option grants it.
	const card = defaultSession(cwd, { sandbox: true, snapshots: false }, { escapeScopes: ledger() });
	const asked: PermissionRequiredMeta[] = [];
	card.registry.onPermissionRequired((_call, _decision, meta) => asked.push(meta));
	const first = card.registry.invoke(unsandboxed("bash probes/a.sh"));
	await new Promise((settle) => setImmediate(settle));
	const offered = asked[0];
	ok(offered?.escapeScope !== undefined);
	deepStrictEqual(
		offered.escapeScope.scripts.map((script) => script.path),
		[join(cwd, "probes", "a.sh")],
	);
	await card.registry.resumeParkedCalls({
		actionClass: "execute",
		requestId: offered.requestId,
		requestedBy: "tool:one_shot",
		sessionScope: true,
	});
	strictEqual((await first).kind, "ok");
	strictEqual(entries.length, 1);
	// The same unchanged file: no card. A sibling in the same directory, another env, or the file edited: a card.
	strictEqual((await card.registry.invoke(unsandboxed("bash probes/a.sh"))).kind, "ok");
	strictEqual(asked.length, 1);
	const asks = async (command: string): Promise<void> => {
		void card.registry.invoke(unsandboxed(command));
		await new Promise((settle) => setImmediate(settle));
		card.registry.cancelParkedCalls("test");
	};
	for (const command of ["bash probes/b.sh", "FOO=1 bash probes/a.sh"]) await asks(command);
	strictEqual(asked.length, 3);
	// The grant is on the session ledger, so a ledger read afresh (a resumed session) still holds it.
	const resumed = defaultSession(cwd, { sandbox: true, snapshots: false }, { escapeScopes: ledger() });
	strictEqual((await resumed.registry.invoke(unsandboxed("bash probes/a.sh"))).kind, "ok");
	writeFileSync(join(cwd, "probes/a.sh"), "echo edited\n");
	await asks("bash probes/a.sh");
	strictEqual(asked.length, 4);
	deepStrictEqual(
		card.ran.map((entry) => entry.command),
		["bash probes/a.sh", "bash probes/a.sh"],
	);

	// Contained yolo: the refusal names the option, ask_user adds it to a question about leaving the sandbox,
	// drops one the agent wrote itself, and only the operator's pick of it grants; typed text never does.
	entries.length = 0;
	const answers: Array<(labels: string[]) => { options?: string[]; value?: string }> = [
		() => ({ value: "yes, approve unsandboxed runs of other/c.sh for the session" }),
		(labels) => ({ options: [labels.at(-1) ?? ""] }),
	];
	const yolo = defaultSession(
		cwd,
		{ sandbox: true, snapshots: false },
		{ escapeScopes: ledger(), unattendedAsks: () => true },
	);
	const shown: string[][] = [];
	yolo.registry.register(
		createAskUserTool({
			askUser: async (questions) => {
				const labels = (questions[0]?.options ?? []).map((option) => option.label);
				shown.push(labels);
				const pick = answers.shift()?.(labels) ?? {};
				const answer = [...(pick.options ?? []), pick.value ?? ""].filter((part) => part.length > 0).join(" ");
				return { answers: [{ question: questions[0]?.question ?? "", answer, ...pick }] };
			},
		}),
	);
	const refused = await yolo.registry.invoke(unsandboxed("bash other/c.sh"));
	strictEqual(refused.kind, "blocked");
	ok(
		refused.kind === "blocked" &&
			refused.reason.includes(`Approve for this session: script ${join(cwd, "other", "c.sh")} (sha256:`),
	);
	const ask = (question: string) =>
		yolo.registry.invoke({
			tool: ToolNames.AskUser,
			args: {
				action: "ask",
				mode: "single_question",
				questions: [
					{
						question,
						options: [{ label: "Yes, run it once" }, { label: "Approve for this session: everything" }, { label: "No" }],
					},
				],
			},
		});
	await ask("Run other/c.sh outside the sandbox?");
	strictEqual(entries.length, 0);
	await ask("Run other/c.sh outside the sandbox, again?");
	strictEqual(entries.length, 1);
	for (const labels of shown) {
		strictEqual(labels.includes("Approve for this session: everything"), false);
		ok(labels.at(-1)?.startsWith(`Approve for this session: script ${join(cwd, "other", "c.sh")} (sha256:`));
	}
	strictEqual((await yolo.registry.invoke(unsandboxed("bash other/c.sh"))).kind, "ok");
});

// M-7 bounce: the refused escape says one true thing about retrying, and once the operator grants its scope the
// refusal is no failed attempt the loop guard counts, so two reruns in the same turn both run.
test("a contained-yolo escape refusal tells when to retry, and a granted rerun is not a repeat of a failed attempt", async (t) => {
	const cwd = workspace("pancode-escape-loop-");
	writeFileSync(join(cwd, "probe.sh"), "echo hi\\n");
	const saved = process.cwd();
	process.chdir(cwd);
	t.after(() => process.chdir(saved));
	const entries: unknown[] = [];
	const escapeScopes = createEscapeScopeLedger({
		session: () => "session-1",
		entries: () => entries,
		append: (grant) => entries.push({ kind: "custom", customType: ESCAPE_SCOPE_CUSTOM_TYPE, data: grant }),
		roots: () => [cwd],
	});
	const guard = createLoopGuardRegistration({ safety: loopSafety() });
	const yolo = defaultSession(
		cwd,
		{ sandbox: true, snapshots: false },
		{
			escapeScopes,
			unattendedAsks: () => true,
			middleware: createMiddlewareBundle({ registrations: [guard] }).contract,
		},
	);
	yolo.registry.register(
		createAskUserTool({
			askUser: async (questions) => {
				const label = questions[0]?.options?.at(-1)?.label ?? "";
				return { answers: [{ question: questions[0]?.question ?? "", answer: label, options: [label] }] };
			},
		}),
	);
	const turn = { sessionId: "session-1", turnId: "turn-1" };
	const call = bash("bash probe.sh", { unsandboxed: true, unsandboxed_reason: "it needs the host" });
	const refused = await yolo.registry.invoke(call, turn);
	ok(refused.kind === "blocked" && refused.denial !== undefined);
	const [account, remedy] = denialLines(refused.denial);
	strictEqual(account.includes("Not retryable"), false, account);
	match(account, /until the operator answers an ask_user question/u);
	match(remedy, /session option/u);
	match(refused.reason, /rerun the call after they choose it/u);
	await yolo.registry.invoke(
		{
			tool: ToolNames.AskUser,
			args: {
				action: "ask",
				mode: "single_question",
				questions: [{ question: "Run probe.sh outside the sandbox?", options: [{ label: "Yes, once" }] }],
			},
		},
		turn,
	);
	strictEqual(entries.length, 1);
	for (const rerun of [1, 2]) strictEqual((await yolo.registry.invoke(call, turn)).kind, "ok", `rerun ${rerun}`);
});

// Row 328: a contained-yolo escape gives one account of retrying. With a session option on offer it names the
// option; with none, the refusal says why no option exists. The judge is never asked either way (D9).
test("a contained-yolo escape is refused unjudged with one retry account: the scoped remedy, or why no option exists", async (t) => {
	const cwd = workspace("pancode-escape-judged-");
	writeFileSync(join(cwd, "probe.sh"), "echo hi\n");
	const outside = workspace("pancode-escape-outside-");
	writeFileSync(join(outside, "far.sh"), "echo far\n");
	const saved = process.cwd();
	process.chdir(cwd);
	t.after(() => process.chdir(saved));
	const escapeScopes = createEscapeScopeLedger({
		session: () => "session-1",
		entries: () => [],
		append: () => {},
		roots: () => [cwd],
	});
	const yolo = defaultSession(cwd, { sandbox: true, snapshots: false }, { escapeScopes, unattendedAsks: () => true });
	const turn = { sessionId: "session-1", turnId: "turn-1" };
	const why = { unsandboxed: true, unsandboxed_reason: "it needs the host" };
	const scoped = await yolo.registry.invoke(bash("bash probe.sh && bash probe.sh", why), turn);
	ok(scoped.kind === "blocked" && scoped.denial !== undefined);
	match(scoped.reason, /rerun the call after they choose it/u);
	doesNotMatch(scoped.reason, /safety judge/u);

	const unscoped = await yolo.registry.invoke(bash(`bash ${outside}/far.sh`, why), turn);
	ok(unscoped.kind === "blocked" && unscoped.denial !== undefined);
	strictEqual(
		/rerun the call after they choose it|Approve for this session/u.test(unscoped.reason),
		false,
		unscoped.reason,
	);
	ok(
		unscoped.reason.includes(
			`PanCode offers no session option for this call because its script ${join(outside, "far.sh")} lies outside the workspace and scratch roots`,
		),
		unscoped.reason,
	);
	match(unscoped.reason, /only when the operator approves it on an approval card/u);
	deepStrictEqual([yolo.ran, yolo.reviewed], [[], []]);
});

test("an attended contained shell asks once per origin outside its egress grants and remembers the answer for the session (P3)", async () => {
	const egress = (mode: "off" | "proxied" | "open") => () => ({
		main: { mode, allow: ["granted.test:443"], presets: [] },
		upstreamProxy: null,
	});
	let attends = true;
	const session = defaultSession(
		workspace("pancode-contained-egress-"),
		{ sandbox: true, snapshots: false },
		{ operatorAttends: () => attends, sandboxEgress: egress("proxied") },
	);
	const { registry } = session;
	// The body stands in for the proxy: an origin outside the grants is put to the launch's ask.
	registry.register({
		...bashTool,
		run: async (args, options) => {
			const plan = options?.shellSandbox?.egress;
			if (plan === undefined) return { kind: "ok", output: `network:${options?.shellSandbox?.network}` };
			const [host = "", port = "443"] = String(args.command).split(":");
			const origin = { host, port: Number(port) };
			if (isGrantedEgressOrigin(plan.grants, origin)) return { kind: "ok", output: "granted" };
			return { kind: "ok", output: (await plan.ask?.(origin)) === true ? "approved" : "refused" };
		},
	});
	const cards: Array<{ requestId: string; actionClass: ActionClass; ruleId: string | undefined }> = [];
	registry.onPermissionRequired((_call, decision, meta) =>
		cards.push({
			requestId: meta.requestId,
			actionClass: decision.classification.actionClass,
			ruleId: decision.kind === "ask" ? decision.confirmationRuleId : undefined,
		}),
	);
	const reach = async (origin: string, answer: "approve" | "deny", sessionId = "A") => {
		const before = cards.length;
		const pending = registry.invoke(bash(origin), { sessionId });
		await new Promise((resolve) => setTimeout(resolve, 30));
		const card = cards.length > before ? cards.at(-1) : undefined;
		if (card !== undefined) {
			if (answer === "approve") await registry.resumeParkedCalls({ ...card, requestedBy: "contract-operator" });
			else registry.cancelParkedCall(card.requestId, "contract denial");
		}
		const result = await pending;
		return {
			asked: card?.ruleId ?? false,
			output: result.kind === "ok" && result.result.kind === "ok" ? result.result.output : result.kind,
		};
	};
	deepStrictEqual(
		[
			await reach("granted.test:443", "deny"),
			await reach("docs.example.org:443", "approve"),
			await reach("docs.example.org:443", "deny"),
			await reach("db.example.org:5432", "deny"),
			await reach("db.example.org:5432", "approve"),
			await reach("docs.example.org:443", "deny", "B"),
		],
		[
			{ asked: false, output: "granted" },
			{ asked: "shell-egress", output: "approved" },
			{ asked: false, output: "granted" },
			{ asked: "shell-egress", output: "refused" },
			{ asked: false, output: "refused" },
			{ asked: "shell-egress", output: "refused" },
		],
	);
	// A command that gives up before the answer leaves the card up, and the answer holds for the next command.
	const before = cards.length;
	const gaveUp = await Promise.race([
		registry.invoke(bash("slow.example.org:443"), { sessionId: "A" }).then(() => "answered"),
		new Promise((resolve) => setTimeout(() => resolve("gave up"), 30)),
	]);
	const card = cards.at(-1);
	deepStrictEqual([gaveUp, cards.length - before, registry.parkedCount()], ["gave up", 1, 1]);
	if (card !== undefined) await registry.resumeParkedCalls({ ...card, requestedBy: "contract-operator" });
	deepStrictEqual(await reach("slow.example.org:443", "deny"), { asked: false, output: "granted" });
	// An operator who is away is never asked; the origin is refused and named in the result.
	attends = false;
	deepStrictEqual(await reach("away.example.org:443", "approve"), { asked: false, output: "refused" });

	for (const [mode, output] of [
		["off", "network:false"],
		["open", "network:true"],
	] as const) {
		const other = defaultSession(
			workspace(`pancode-contained-egress-${mode}-`),
			{ sandbox: true, snapshots: false },
			{ sandboxEgress: egress(mode) },
		);
		other.registry.register({
			...bashTool,
			run: async (_args, options) => ({
				kind: "ok",
				output: options?.shellSandbox?.egress === undefined ? `network:${options?.shellSandbox?.network}` : "proxied",
			}),
		});
		const result = await other.registry.invoke(bash("make"));
		deepStrictEqual(
			result.kind === "ok" && result.result.kind === "ok" ? result.result.output : result.kind,
			output,
			mode,
		);
	}
});
