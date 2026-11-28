// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { equal, match, ok, rejects } from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, it } from "node:test";
import { updateSettings } from "../../src/core/config.js";
import {
	describeFleetToolInstall,
	executeFleetToolInstall,
	prepareFleetToolInstall,
} from "../../src/domains/dispatch/fleet-tool-install.js";
import { installPinnedProgram } from "../../src/lib/programs/install.js";
import { findPinnedProgram } from "../../src/lib/programs/registry.js";
import { isolatePancodeEnv } from "../harness/scratch-env.js";

let env: Awaited<ReturnType<typeof isolatePancodeEnv>>;
beforeEach(async () => {
	env = await isolatePancodeEnv("pancode-asciinema-");
});
afterEach(() => env.restore());

it("pins asciinema, GPL notice and corresponding upstream release source", async () => {
	const entry = findPinnedProgram("asciinema");
	ok(entry);
	equal(entry.version, "3.2.1");
	equal(entry.license, "GPL-3.0-or-later");
	ok(entry.documents.some((doc) => doc.name.endsWith("source.tar.gz")));
	match(entry.notice ?? "", /separate program/);
	const root = join(env.dir, "tools");
	const bad = await installPinnedProgram(entry, {
		root,
		platform: "linux-x64",
		fetch: async () => Buffer.from("corrupt"),
	});
	equal(bad.ok, false);
	match(bad.message, /checksum mismatch/);
	equal(existsSync(join(root, entry.id, entry.version)), false);
});

it("writes the separate-program notice during an atomic checksum-verified installation", async () => {
	const bytes = Buffer.from("fixture program");
	const digest = createHash("sha256").update(bytes).digest("hex");
	const entry = findPinnedProgram("asciinema");
	ok(entry);
	const result = await installPinnedProgram(
		{
			...entry,
			documents: [],
			downloads: {
				"linux-x64": {
					url: "https://fixture.invalid/asciinema",
					sha256: digest,
					archive: "raw",
					binaryMembers: { asciinema: "" },
					documentMembers: [],
				},
			},
		},
		{ root: join(env.dir, "tools"), platform: "linux-x64", fetch: async () => bytes },
	);
	equal(result.ok, true);
	equal(readFileSync(join(result.dir, "NOTICE"), "utf8"), `${entry.notice}\n`);
	ok(result.documents.includes(join(result.dir, "NOTICE")));
});

it("installs a runtime member under a directory whose name starts with ..", async () => {
	const tree = join(env.dir, "asset");
	mkdirSync(join(tree, "..data"), { recursive: true });
	writeFileSync(join(tree, "tool"), "fixture program");
	writeFileSync(join(tree, "..data", "lib.so"), "runtime");
	const archive = join(env.dir, "asset.tar.gz");
	execFileSync("tar", ["-czf", archive, "-C", tree, "tool", "..data/lib.so"]);
	const bytes = readFileSync(archive);
	const entry = findPinnedProgram("asciinema");
	ok(entry);
	const result = await installPinnedProgram(
		{
			...entry,
			documents: [],
			downloads: {
				"linux-x64": {
					url: "https://fixture.invalid/asciinema.tar.gz",
					sha256: createHash("sha256").update(bytes).digest("hex"),
					archive: "tar.gz",
					binaryMembers: { asciinema: "tool" },
					documentMembers: [],
					runtimeMembers: ["..data/lib.so"],
				},
			},
		},
		{ root: join(env.dir, "tools"), platform: "linux-x64", fetch: async () => bytes },
	);
	equal(result.ok, true, result.message);
	equal(readFileSync(join(result.dir, "..data", "lib.so"), "utf8"), "runtime");
});

it("previews explicit user-level SSH provisioning and rejects changed connections before remote execution", async () => {
	updateSettings((settings) => {
		settings.fleet.nodes.push({
			id: "seven",
			host: "fixture.invalid",
			maxWorkers: 1,
			pancodeEntry: '"$HOME/.local/share/pancode/workers/pin/node_modules/.bin/pancode" worker',
		});
	});
	const plan = prepareFleetToolInstall("seven", "asciinema");
	match(plan.command, /programs install asciinema --json/);
	match(plan.command, /TMPDIR=/);
	equal(plan.command.includes("sudo"), false);
	match(describeFleetToolInstall(plan), /GPL-3.0-or-later/);
	updateSettings((settings) => {
		const node = settings.fleet.nodes.find((node) => node.id === "seven");
		if (node) node.host = "changed.invalid";
	});
	await rejects(executeFleetToolInstall(plan), /configuration changed/);
});
