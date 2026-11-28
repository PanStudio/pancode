// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * First-party packs a PanCode install gives once: `upgrade --post-install`
 * installs a bundled `default: true` row into the user scope, records it so a
 * removal sticks, writes nothing when the staged envelope is not the reviewed
 * one, and moves an installed copy only when its envelope reaches no further.
 *
 * The package root is a temporary directory whose `hub/index.yaml` and pack tree
 * each test writes; the pack pins no programs, so nothing touches the network.
 */
import { deepEqual, equal, match, ok, strictEqual } from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { stringify } from "yaml";
import { buildRegistryRow, type RegistryRow } from "../../scripts/pin-hub-remote.js";
import { pancodeConfigPath } from "../../src/core/xdg.js";
import { parseHubIndexRows } from "../../src/domains/plugins/catalog.js";
import { applyHubAction, type HubOperation, planHubAction } from "../../src/domains/resources/hub-actions.js";
import type { DefaultPackOutput } from "../../src/domains/resources/hub-defaults.js";
import { listInstalledHubPacks } from "../../src/domains/resources/hub-packs.js";
import { validateHubPack } from "../../src/domains/resources/hub-validation.js";
import { type IsolatedPancodeEnv, isolatePancodeEnv } from "../harness/scratch-env.js";

const REF = "extension:demo";
const savedRoot = process.env.PANCODE_PACKAGE_ROOT;
let pkg: string;
let scratch: IsolatedPancodeEnv;
let defaults: typeof import("../../src/domains/resources/hub-defaults.js");

/** Writes the demo pack at `version` and a bundled index whose one row marks it default. */
function publish(version: string, options: { net?: boolean; row?: Partial<RegistryRow> } = {}): void {
	const pack = path.join(pkg, "hub", "packs", "extensions", "demo");
	rmSync(pack, { recursive: true, force: true });
	mkdirSync(pack, { recursive: true });
	writeFileSync(
		path.join(pack, "pancode-extension.json"),
		JSON.stringify({
			id: "demo",
			name: "Demo",
			version,
			description: `demo extension ${version}`,
			license: "MIT",
			runtime: {
				api: 2,
				entrypoint: "extension.mjs",
				commands: [{ name: "status", description: "Show status." }],
				events: [],
				ui: [],
				permissions: { fs: { read: [], write: [] }, exec: false, net: options.net ?? false },
			},
		}),
	);
	writeFileSync(
		path.join(pack, "extension.mjs"),
		'export default (api) => { api.handle("status", () => ({ text: "ok" })); };\n',
	);
	const result = validateHubPack(pack);
	ok(result.valid, JSON.stringify(result.validation.diagnostics));
	const row = buildRegistryRow(pack, result, { sourceUrl: "packs/extensions/demo" }, "extensions");
	writeFileSync(
		path.join(pkg, "hub", "index.yaml"),
		stringify({ entries: [{ ...row, default: true, ...options.row }] }),
	);
}

function recorder(): { out: DefaultPackOutput; lines: string[] } {
	const lines: string[] = [];
	return {
		lines,
		out: {
			completedStep: (text) => lines.push(`done: ${text}`),
			note: (text) => lines.push(text),
			fields: (rows) => {
				for (const [key, value] of rows) lines.push(`${key}: ${value}`);
			},
			warn: (text) => lines.push(`warn: ${text}`),
			commandAdvice: (lead, command) => lines.push(`${lead} ${command}`),
		},
	};
}

async function postInstall(): Promise<string> {
	const { out, lines } = recorder();
	await defaults.applyDefaultPacks(out, scratch.dir);
	return lines.join("\n");
}

function given(): string[] | null {
	const file = path.join(pancodeConfigPath(), "extensions", "defaults.json");
	return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as { given: string[] }).given : null;
}

function copy(): { version: string; enabled: boolean } | undefined {
	const found = listInstalledHubPacks(scratch.dir, { scope: "user", all: true }).find((item) => item.id === "demo");
	return found && { version: found.version, enabled: found.enabled };
}

function lifecycle(operation: HubOperation): void {
	const apply = applyHubAction(planHubAction({ operation, ref: REF, scope: "user", cwd: scratch.dir }));
	equal(apply.outcomes[0]?.status, "committed", JSON.stringify(apply.outcomes));
}

describe("default first-party packs", () => {
	before(async () => {
		pkg = realpathSync(mkdtempSync(path.join(tmpdir(), "pancode-default-packs-")));
		writeFileSync(path.join(pkg, "package.json"), '{"name":"default-packs-fixture","version":"0.0.0"}\n');
		mkdirSync(path.join(pkg, "hub"), { recursive: true });
		// The package root is cached on first resolve, so it is pinned before the hub modules run.
		process.env.PANCODE_PACKAGE_ROOT = pkg;
		const packageRoot = await import("../../src/core/package-root.js");
		strictEqual(packageRoot.resolvePackageRoot(), pkg, "another import resolved the package root first");
		defaults = await import("../../src/domains/resources/hub-defaults.js");
	});

	after(() => {
		if (savedRoot === undefined) delete process.env.PANCODE_PACKAGE_ROOT;
		else process.env.PANCODE_PACKAGE_ROOT = savedRoot;
		rmSync(pkg, { recursive: true, force: true });
	});

	beforeEach(async () => {
		scratch = await isolatePancodeEnv("pancode-default-packs-home-");
	});

	afterEach(() => scratch.restore());

	it("installs a default pack once into the user scope and keeps a removal", async () => {
		publish("1.0.0");
		deepEqual(defaults.pendingDefaultPacks(scratch.dir), [REF]);
		const first = await postInstall();
		match(first, /extension:demo is allowed to:/);
		match(first, /done: Installed extension:demo 1\.0\.0/);
		match(first, /pancode hub remove extension:demo/);
		deepEqual(copy(), { version: "1.0.0", enabled: true });
		deepEqual(given(), [REF]);

		equal(await postInstall(), "");
		lifecycle("remove");
		deepEqual(defaults.pendingDefaultPacks(scratch.dir), []);
		equal(await postInstall(), "");
		equal(copy(), undefined);
	});

	it("installs and records nothing when the staged envelope is not the reviewed one", async () => {
		publish("1.0.0", { row: { envelopeDigest: "f".repeat(64) } });
		const output = await postInstall();
		match(output, /warn: Did not set up the default pack extension:demo/);
		match(output, /pancode hub install extension:demo/);
		equal(copy(), undefined);
		equal(given(), null);
	});

	it("moves an installed default only when its envelope reaches no further", async () => {
		publish("1.0.0");
		await postInstall();

		publish("1.0.1");
		match(await postInstall(), /done: Updated extension:demo to 1\.0\.1/);
		deepEqual(copy(), { version: "1.0.1", enabled: true });

		publish("1.0.2", { net: true });
		const grown = await postInstall();
		match(grown, /Left extension:demo as installed; 1\.0\.2 reaches further/);
		match(grown, /pancode hub update extension:demo/);
		deepEqual(copy(), { version: "1.0.1", enabled: true });

		lifecycle("disable");
		publish("1.0.3");
		equal(await postInstall(), "");
		deepEqual(copy(), { version: "1.0.1", enabled: false });
	});

	it("keeps default to first-party bundled rows", () => {
		const base = {
			kind: "extension",
			name: "demo",
			description: "demo",
			version: "1.0.0",
			sha256: "a".repeat(64),
			publisher: "pancode",
			tier: "core",
			license: "MIT",
			sourceUrl: "packs/extensions/demo",
		};
		const community = {
			...base,
			sourceUrl: undefined,
			publisher: "octo",
			tier: "listed",
			source: { repo: "https://github.com/octo/demo", commit: "1".repeat(40), subdir: "" },
		};
		const read = (row: object, mode: "bundled" | "operator") => {
			const diagnostics: string[] = [];
			const rows = parseHubIndexRows({ entries: [row] }, "index.yaml", diagnostics, { mode });
			return { rows, diagnostics: diagnostics.join("\n") };
		};
		equal(read({ ...base, default: true }, "bundled").rows[0]?.default, true);
		const yes = read({ ...base, default: "yes" }, "bundled");
		equal(yes.rows.length, 0);
		match(yes.diagnostics, /default is true or absent/);
		const foreign = read({ ...community, default: true }, "bundled");
		equal(foreign.rows.length, 0);
		match(foreign.diagnostics, /only a first-party row is installed by default/);
		equal(read({ ...base, default: true }, "operator").rows[0]?.default, undefined);
	});
});
