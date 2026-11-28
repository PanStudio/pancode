// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { match, ok, strictEqual } from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { runPancodeRun } from "../../src/cli/run.js";
import { readSettings } from "../../src/core/config.js";
import { telemetrySessionDirectory } from "../../src/core/telemetry/paths.js";
import { resolvePancodeDirs } from "../../src/core/xdg.js";
import {
	runDoctor,
	runDoctorHarnessChecks,
	runDoctorModelChecks,
	withDoctorCommand,
} from "../../src/domains/install/doctor.js";
import { isolatePancodeEnv } from "../harness/scratch-env.js";

test("doctor proposes the provider catalog model and changes it only after confirmation", async (t) => {
	const home = await isolatePancodeEnv("pancode-doctor-model-repair-");
	t.after(() => home.restore());
	mkdirSync(join(home.dir, "config"), { recursive: true });
	const file = join(home.dir, "config", "settings.yaml");
	const original =
		"version: 2\ntargets:\n  - { id: anthropic, runtime: anthropic }\ncontext:\n  memory:\n    target: anthropic\n    model: claude-haiku-4.5 # keep the note\n";
	writeFileSync(file, original);
	const before = await runDoctorModelChecks({ fix: true, confirm: async () => false });
	match(
		before.find((row) => row.name === "model anthropic")?.detail ?? "",
		/Proposed memory.model: 'claude-haiku-4.5' -> 'claude-haiku-4-5'/,
	);
	strictEqual(readFileSync(file, "utf8"), original);
	let asked = 0;
	const after = await runDoctorModelChecks({
		fix: true,
		confirm: async () => {
			asked++;
			return true;
		},
	});
	strictEqual(asked, 1);
	strictEqual(readSettings().context.memory.model, "claude-haiku-4-5");
	match(readFileSync(file, "utf8"), /# keep the note/);
	strictEqual(after.find((row) => row.name === "model anthropic")?.level, undefined);
});

// `run --read-only` enters read-only mode for the rest of this process, so it runs last.
test("run --agent with an API key refuses a target on an unregistered runtime", async (t) => {
	const home = await isolatePancodeEnv("pancode-unregistered-runtime-run-");
	const original = process.cwd();
	const cwd = join(home.dir, "workspace");
	mkdirSync(join(home.dir, "config"), { recursive: true });
	mkdirSync(cwd);
	writeFileSync(
		join(home.dir, "config", "settings.yaml"),
		"version: 2\ntargets:\n  - { id: box, runtime: no-such-runtime, defaultModel: llama3 }\n",
	);
	let stderr = "";
	t.mock.method(process.stderr, "write", (chunk: string | Uint8Array) => {
		stderr += String(chunk);
		return true;
	});
	process.chdir(cwd);
	try {
		const run = (target: string) =>
			runPancodeRun(["--agent", "coder", "--read-only", "--connection", target, "audit"], {
				apiKey: "fixture-key",
				noContextFiles: true,
			});
		strictEqual(await run("box"), 1);
		match(stderr, /cannot use connection 'box': runtime 'no-such-runtime' is not registered/u);
		stderr = "";
		strictEqual(await run("nosuch"), 2);
		match(stderr, /connection 'nosuch' not found/u);
	} finally {
		process.chdir(original);
		home.restore();
	}
});

test("a session with no prompt-cache verdict is information, not a warning that sends the operator to configure", async (t) => {
	const home = await isolatePancodeEnv("pancode-doctor-cache-");
	t.after(() => home.restore());
	const directory = telemetrySessionDirectory(resolvePancodeDirs().state, "s-quiet");
	mkdirSync(directory, { recursive: true });
	writeFileSync(join(directory, "journal.jsonl"), "");
	const row = runDoctor().find((finding) => finding.name === "cache telemetry");
	ok(row, "the cache telemetry row is reported");
	strictEqual(row.level, "info");
	ok(!withDoctorCommand(row).detail.includes("configure"), withDoctorCommand(row).detail);
});

test("an untrusted project settings file sends the operator to trust review, not to agents validate", async (t) => {
	const home = await isolatePancodeEnv("pancode-doctor-untrusted-");
	t.after(() => home.restore());
	const workspace = join(home.dir, "repo");
	mkdirSync(join(workspace, ".git"), { recursive: true });
	mkdirSync(join(workspace, ".pancode"), { recursive: true });
	writeFileSync(join(workspace, ".pancode", "settings.local.yaml"), "chat:\n  model: m\n");
	const row = runDoctorHarnessChecks(workspace).find((finding) => finding.name.startsWith("harness .pancode"));
	ok(row, "the untrusted file is reported");
	const detail = withDoctorCommand(row).detail;
	match(detail, /Review with pancode config trust settings\.?$/u);
	ok(!detail.includes("next:"), detail);
});
