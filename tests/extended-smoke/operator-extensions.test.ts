// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { equal, match, ok } from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { makeScratchHome } from "../harness/scratch-env.js";

const cli = path.resolve("dist/cli/index.js");
test("built CLI operator invocation isolates stdout, disposes code and keeps ordinary headless parsing code-free", () => {
	const home = makeScratchHome("pancode-operator-cli-");
	try {
		const cwd = path.join(home.dir, "workspace");
		const source = path.join(home.dir, "source");
		mkdirSync(cwd);
		mkdirSync(source);
		const run = (args: string[]) =>
			spawnSync(process.execPath, [cli, ...args], {
				cwd,
				env: { ...process.env, ...home.env },
				encoding: "utf8",
				timeout: 10000,
			});
		writeFileSync(
			path.join(source, "pancode-extension.json"),
			JSON.stringify({
				id: "pancode-fixture",
				name: "Synthetic fixture",
				version: "1.0.0",
				description: "Synthetic command",
				runtime: {
					api: 1,
					entrypoint: "extension.mjs",
					commands: [{ name: "inspect", description: "Synthetic inspect" }],
					events: ["session_open"],
					ui: ["panel"],
				},
			}),
		);
		writeFileSync(
			path.join(source, "extension.mjs"),
			'import {writeFileSync} from "node:fs";console.log("untrusted startup stdout");export default api=>{api.on("session_open",()=>writeFileSync("pancode-session-event.txt","unexpected"));api.onDispose(()=>writeFileSync("pancode-disposed.txt","disposed"));api.handle("inspect",(args,ctx)=>({text:JSON.stringify({args,session:ctx.snapshot.sessionId,mode:ctx.snapshot.mode}),panel:{title:"SYNTHETIC",sections:[]}}));};',
		);
		equal(run(["extensions", "discover", source, "--json"]).status, 0);
		equal(run(["extensions", "install", source, "--project", "--json"]).status, 0);
		// The installed extension claims the token, so the runtime refuses it without loading the extension's code.
		const ordinary = run(["run", "/ext:pancode-fixture:inspect"]);
		equal(ordinary.status, 1, ordinary.stderr);
		match(ordinary.stderr, /\/ext:pancode-fixture:inspect is not an available extension command/);
		equal(`${ordinary.stdout}${ordinary.stderr}`.includes("untrusted startup stdout"), false);
		equal(existsSync(path.join(cwd, "pancode-disposed.txt")), false);
		const unclaimed = run(["run", "/ext:nope:inspect"]);
		equal(unclaimed.status, 2, unclaimed.stderr);
		match(unclaimed.stderr, /\/ext:nope:inspect is not a command/);
		const invoked = run(["extensions", "run", "pancode-fixture", "inspect", "--json", "--", "literal --argument"]);
		equal(invoked.status, 0, invoked.stderr);
		const output = JSON.parse(invoked.stdout);
		equal(JSON.parse(output.output.text).args, "literal --argument");
		equal(JSON.parse(output.output.text).session, null);
		equal(JSON.parse(output.output.text).mode, "headless");
		ok(output.output.panel);
		equal(existsSync(path.join(cwd, "pancode-session-event.txt")), false);
		ok(existsSync(path.join(cwd, "pancode-disposed.txt")));
		const text = run(["extensions", "run", "pancode-fixture", "inspect"]);
		equal(text.status, 0, text.stderr);
		equal(JSON.parse(text.stdout).mode, "headless");
		const unknown = run(["extensions", "run", "pancode-fixture", "missing"]);
		equal(unknown.status, 1);
		equal(unknown.stdout, "");
	} finally {
		home.cleanup();
	}
});
