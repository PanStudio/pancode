// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * Community rows for `hub/index.yaml`: the row file schema, the fetch by exact
 * commit that regenerates a row, and the pin run that keeps a committed row
 * when a fetch fails. The fetch is injected, so no test needs the network.
 *
 * Inputs are constructed: placeholder pack trees, placeholder repository URLs
 * and commits; no captured upstream data.
 */
import { deepStrictEqual, equal, match, ok } from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
	type CommunityFetchDeps,
	type CommunityRowFile,
	mergeCommunityRows,
	type RegistryRow,
	readCommunityRowFiles,
	refreshCommunityRow,
	rowFileProblems,
} from "../../scripts/pin-hub-remote.js";
import { validateHubPackage } from "../../src/domains/resources/hub-validation.js";

let root: string;

beforeEach(() => {
	root = mkdtempSync(path.join(tmpdir(), "pancode-pin-hub-remote-"));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

const COMMIT = "0123456789abcdef0123456789abcdef01234567";

/** A minimal valid plugin package directory, the same shape local packs use. */
function pack(name = "demo", version = "1.0.0", license = "MIT"): string {
	const location = path.join(root, "fetched", name);
	mkdirSync(location, { recursive: true });
	writeFileSync(
		path.join(location, "plugin.json"),
		JSON.stringify({
			$schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
			name,
			version,
			description: "demo plugin fixture",
			license,
		}),
	);
	return location;
}

function rowFor(location: string, overrides: Partial<RegistryRow> = {}): RegistryRow {
	return {
		kind: "plugin",
		publisher: "octo",
		name: "demo",
		version: "1.0.0",
		description: "demo plugin fixture",
		source: { repo: "https://github.com/octo/demo", commit: COMMIT, subdir: "plugin" },
		sha256: validateHubPackage(location).contentDigest as string,
		license: "MIT",
		tier: "listed",
		...overrides,
	};
}

function deps(location: string, calls: string[] = []): CommunityFetchDeps {
	return {
		fetchPluginCommit: (source, expected) => {
			calls.push(`${source.commit}:${expected ?? ""}`);
			return { root: location, cleanup: () => calls.push("cleanup"), commit: source.commit };
		},
		validateHubPackage,
	};
}

describe("community row files", () => {
	it("accepts a row whose publisher and name match its path", () => {
		const location = pack();
		deepStrictEqual(rowFileProblems("hub/community/octo/demo.yaml", "octo", "demo", { rows: [rowFor(location)] }), []);
	});

	it("refuses a path mismatch, a derived field, a first-party location and an unpaired second row", () => {
		const location = pack();
		const row = rowFor(location);
		const problems = (parsed: unknown) =>
			rowFileProblems("hub/community/octo/demo.yaml", "octo", "demo", parsed).join("\n");
		match(problems({ rows: [{ ...row, publisher: "other" }] }), /publisher must be octo/);
		match(problems({ rows: [{ ...row, provides: [] }] }), /states field\(s\) hub:pin derives: provides/);
		match(
			problems({ rows: [{ ...row, source: undefined, sourceUrl: "packs/plugins/demo" }] }),
			/first-party row has publisher pancode/,
		);
		match(problems({ rows: [row, { ...row, kind: "skill" }] }), /a plugin and the extension that names it/);
		match(problems({ rows: [{ ...row, license: undefined }] }), /a community row has a license/);
		match(problems({ rows: [{ ...row, tier: "verified", license: "GPL-3.0-only" }] }), /allowlist, not GPL-3.0-only/);
	});

	it("reads row files from hub/community and reports a misplaced file", () => {
		const location = pack();
		mkdirSync(path.join(root, "hub", "community", "octo"), { recursive: true });
		writeFileSync(path.join(root, "hub", "community", "octo", "demo.yaml"), JSON.stringify({ rows: [rowFor(location)] }));
		writeFileSync(path.join(root, "hub", "community", "octo", "notes.txt"), "x");
		const read = readCommunityRowFiles(root);
		deepStrictEqual(
			read.files.map((file) => file.file),
			["hub/community/octo/demo.yaml"],
		);
		deepStrictEqual(read.problems, ["hub/community/octo/notes.txt: a row file is <name>.yaml"]);
	});
});

describe("fetch by commit", () => {
	it("regenerates the row from the fetched tree and asks the fetcher for the row's digest", () => {
		const location = pack();
		const row = rowFor(location);
		const calls: string[] = [];
		const result = refreshCommunityRow(row, deps(location, calls));
		ok(result.ok);
		deepStrictEqual(calls, [`${COMMIT}:${row.sha256}`, "cleanup"]);
		equal(result.row.publisher, "octo");
		equal(result.row.tier, "listed");
		equal(result.row.license, "MIT");
		deepStrictEqual(result.row.source, row.source);
		equal(result.row.sourceUrl, undefined);
	});

	it("fails when a stated field does not hold at the commit", () => {
		const location = pack();
		const result = refreshCommunityRow(rowFor(location, { version: "1.0.1" }), deps(location));
		ok(!result.ok);
		match(result.error, /version is "1\.0\.0" at the commit, the row states "1\.0\.1"/);
	});

	it("fails when the pack declares a different licence than the row", () => {
		const location = pack("demo", "1.0.0", "Apache-2.0");
		const result = refreshCommunityRow(rowFor(location), deps(location));
		ok(!result.ok);
		match(result.error, /declares license Apache-2.0, the row states MIT/);
	});
});

describe("pin run", () => {
	const file = (row: RegistryRow): CommunityRowFile => ({
		file: "hub/community/octo/demo.yaml",
		publisher: "octo",
		name: "demo",
		rows: [row],
	});

	it("keeps the committed index row byte for byte when a changed row file cannot be fetched", () => {
		const location = pack();
		const committed = { ...rowFor(location), provides: [{ kind: "skill", name: "kept" }] };
		const changed = rowFor(location, {
			source: { repo: "https://github.com/octo/demo", commit: "f".repeat(40), subdir: "plugin" },
		});
		const merged = mergeCommunityRows([file(changed)], {
			committedRows: new Map([["plugin:demo", committed]]),
			identities: new Set(),
			check: false,
			deps: {
				fetchPluginCommit: () => {
					throw new Error("network unreachable");
				},
				validateHubPackage,
			},
		});
		equal(merged.fetched, 0);
		equal(merged.failures.length, 1);
		match(merged.failures[0] ?? "", /octo\/demo\.yaml plugin:demo at f{40}: network unreachable/);
		ok(merged.entries[0] === committed);
	});

	it("leaves a new row out of the index when its fetch fails", () => {
		const location = pack();
		const merged = mergeCommunityRows([file(rowFor(location))], {
			committedRows: new Map(),
			identities: new Set(),
			check: false,
			deps: {
				fetchPluginCommit: () => {
					throw new Error("plugin_pin_mismatch");
				},
				validateHubPackage,
			},
		});
		deepStrictEqual(merged.entries, []);
		equal(merged.failures.length, 1);
	});

	it("check mode never fetches and fails a row file the index does not hold", () => {
		const location = pack();
		const row = rowFor(location);
		const fetchless = {
			fetchPluginCommit: () => {
				throw new Error("check mode fetched");
			},
			validateHubPackage,
		};
		const held = mergeCommunityRows([file(row)], {
			committedRows: new Map([["plugin:demo", { ...row, provides: [] }]]),
			identities: new Set(),
			check: true,
			deps: fetchless,
		});
		deepStrictEqual(held.errors, []);
		const stale = mergeCommunityRows([file(rowFor(location, { version: "1.0.1" }))], {
			committedRows: new Map([["plugin:demo", row]]),
			identities: new Set(),
			check: true,
			deps: fetchless,
		});
		deepStrictEqual(stale.errors, [
			"hub/community/octo/demo.yaml: hub/index.yaml does not hold the plugin:demo row this file states",
		]);
	});

	it("refuses a community row that takes a first-party identity", () => {
		const location = pack();
		const merged = mergeCommunityRows([file(rowFor(location))], {
			committedRows: new Map(),
			identities: new Set(["plugin:demo"]),
			check: true,
		});
		deepStrictEqual(merged.errors, ["hub/community/octo/demo.yaml: duplicate PanHub pack identity: plugin:demo"]);
	});
});
