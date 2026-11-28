// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { deepStrictEqual, doesNotMatch, match, strictEqual } from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../../dist/cli/index.js", import.meta.url));

it("headless commands refuse interactive actions before boot while preserving skills, templates, and prose", () => {
	const root = mkdtempSync(join(tmpdir(), "pancode-headless-slash-"));
	const config = join(root, "config");
	mkdirSync(join(config, "prompts"), { recursive: true });
	writeFileSync(join(config, "prompts", "local-check.md"), "---\ndescription: Local check\n---\nInspect $ARGUMENTS\n");
	const env = {
		...process.env,
		PANCODE_HOME: root,
		PANCODE_CONFIG_DIR: config,
		PANCODE_DATA_DIR: join(root, "data"),
		PANCODE_STATE_DIR: join(root, "state"),
		PANCODE_CACHE_DIR: join(root, "cache"),
		NO_COLOR: "1",
	};
	const run = (task: string) =>
		spawnSync(
			process.execPath,
			[CLI, "run", "--connection", "headless-slash-missing-target", "--output-format", "stream-json", task],
			{
				cwd: root,
				env,
				encoding: "utf8",
				timeout: 15_000,
			},
		);
	try {
		for (const task of [
			"/context compact retain constraints",
			"/compact",
			"/compact retain constraints",
			"/context reset",
			"/context init",
			"/context refresh",
			"/context",
			"/model mini",
			"/new",
			"/help",
			"/skill",
			"/skill off",
		]) {
			const result = run(task);
			strictEqual(result.error, undefined, task);
			strictEqual(result.status, 2, `${task}: ${result.stderr}`);
			match(result.stderr, /interactive commands are not supported by pancode run/, task);
			// Schema v2 frames even a refusal before boot: a pending session frame and the envelope, never an agent turn.
			doesNotMatch(result.stdout, /"type":"agent_start"/, task);
			match(result.stdout, /"pending":true/, task);
			strictEqual(existsSync(join(root, "state", "sessions")), false, task);
		}
		// A missing explicit target stops these after command preflight but before
		// boot/inference. No provider fixture or model call is needed to prove
		// that supported prompt forms still reach the existing headless path.
		for (const task of [
			"/skill local-check inspect",
			"/local-check src",
			"/tmp/source.js needs inspection",
			"\\/tmp is full",
			"Inspect src",
		]) {
			const result = run(task);
			strictEqual(result.status, 2, `${task}: ${result.stderr}`);
			match(result.stderr, /target 'headless-slash-missing-target' not found/, task);
			doesNotMatch(result.stderr, /interactive commands are not supported|is not a command/, task);
		}
		match(run("/not-a-real-command").stderr, /is not a command/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

it("headless run prints a display-only template to stdout and exits without booting", () => {
	const root = mkdtempSync(join(tmpdir(), "pancode-headless-display-"));
	const config = join(root, "config");
	mkdirSync(join(config, "prompts", "pkg"), { recursive: true });
	writeFileSync(
		join(config, "prompts", "pkg", "help.md"),
		"---\ndescription: Reference\ndisplay-only: true\n---\nDisplay the following:\n\n```\n━━━ pkg ━━━\n /pkg:help   This help\n```\n",
	);
	const env = {
		...process.env,
		PANCODE_HOME: root,
		PANCODE_CONFIG_DIR: config,
		PANCODE_DATA_DIR: join(root, "data"),
		PANCODE_STATE_DIR: join(root, "state"),
		PANCODE_CACHE_DIR: join(root, "cache"),
		NO_COLOR: "1",
	};
	try {
		for (const task of ["/pkg:help", "/pkg:help with arguments"]) {
			const result = spawnSync(process.execPath, [CLI, "run", "--connection", "headless-slash-missing-target", task], {
				cwd: root,
				env,
				encoding: "utf8",
				timeout: 15_000,
			});
			strictEqual(result.error, undefined, task);
			strictEqual(result.status, 0, `${task}: ${result.stderr}`);
			strictEqual(result.stdout, "━━━ pkg ━━━\n /pkg:help   This help\n", task);
			doesNotMatch(result.stderr, /not found|is not a command/, task);
			strictEqual(existsSync(join(root, "state", "sessions")), false, `${task}: no session was created`);
			const json = spawnSync(process.execPath, [CLI, "run", "--output-format", "stream-json", task], {
				cwd: root,
				env,
				encoding: "utf8",
				timeout: 15_000,
			});
			strictEqual(json.error, undefined, task);
			strictEqual(json.status, 0, `${task}: ${json.stderr}`);
			// Display-only output is the run's answer (WTF-P F08): no event frame carries it, and the envelope's result.text does.
			const frames = json.stdout
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line) as { type?: string; exitCode?: number; result?: { text?: string } });
			deepStrictEqual(
				frames.map((frame) => frame.type),
				["session", "run_end"],
				`${task}: display-only output must preserve JSONL stdout`,
			);
			strictEqual(frames[1]?.exitCode, 0, task);
			strictEqual(frames[1]?.result?.text, "━━━ pkg ━━━\n /pkg:help   This help", task);
			strictEqual(json.stderr, "", task);
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
