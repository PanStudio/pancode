// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * The hub trust: the exact-commit fetch, row parsing, the verified remote index,
 * publisher identity, revocation, tiers, the licence key, and the Git sync
 * remote checks.
 *
 * Inputs are constructed: Ed25519 keys are generated per run, index YAML,
 * plugin and extension trees and a local bare git repository are written by
 * the tests, the remote repositories are placeholder `example` URLs, and the
 * remote assets are served from memory through the injected fetch. The bundled
 * index and the `sample-kit` fixture are read from the repository as committed.
 */
import { deepStrictEqual, doesNotMatch, equal, fail, match, ok, rejects, throws } from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync, type KeyObject } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { stringify } from "yaml";
import { runHubCommand } from "../../src/cli/hub.js";
import { readSettings } from "../../src/core/config.js";
import { revokedHubDigests } from "../../src/core/hub-revocations.js";
import { bindPackActivitySink, flushPackActivities, type PackActivity } from "../../src/core/pack-activity.js";
import { pancodeStateDir } from "../../src/core/xdg.js";
import { validateExtensionPackage } from "../../src/domains/extensions/authoring/validate.js";
import { parseExtensionManifest } from "../../src/domains/extensions/discovery.js";
import { OperatorExtensions } from "../../src/domains/extensions/operator-extensions.js";
import { installExtension, listInstalledExtensions } from "../../src/domains/extensions/state.js";
import { loadMcpServerConfig } from "../../src/domains/mcp/index.js";
import { bundledHubIndexPath, fetchPluginCommit, parseHubIndexRows } from "../../src/domains/plugins/catalog.js";
import type { HubTier } from "../../src/domains/plugins/hub-types.js";
import {
	clearPluginSnapshots,
	installPlugin,
	listInstalledPlugins,
	PLUGIN_SCHEMA,
	pluginContentDigest,
	readPluginInstallRecord,
} from "../../src/domains/plugins/index.js";
import {
	commitHubInstallPlan,
	confirmHubRemote,
	discoverHub,
	hubInstallPath,
	planHubInstall,
	syncHub,
} from "../../src/domains/resources/hub.js";
import {
	HUB_INDEX_PAYLOAD_TYPE,
	HUB_KEYS_PAYLOAD_TYPE,
	hubKeyId,
	hubPublicKeyBase64,
	signHubEnvelope,
} from "../../src/domains/resources/hub-signature.js";
import {
	autoRefreshRemoteIndex,
	HUB_CERTIFICATE_ASSET,
	HUB_ENVELOPE_ASSET,
	HUB_INDEX_ASSET,
	type HubAssetFetch,
	hubIndexDir,
	hubTrustStatePath,
	readHubTrustState,
	refreshRemoteIndex,
	remoteIndexRows,
} from "../../src/domains/resources/hub-trust.js";
import { isolatePancodeEnv } from "../harness/scratch-env.js";

const SAMPLE_KIT = path.resolve(import.meta.dirname, "../fixtures/plugins/sample-kit");
const URL_BASE = "https://example.invalid/hub-index/";
const NOW = new Date("2019-06-01T00:00:00.000Z");
const root = generateKeyPairSync("ed25519");
const signer = generateKeyPairSync("ed25519");
const rootKeys = [hubPublicKeyBase64(root.publicKey)];
const signerPub = hubPublicKeyBase64(signer.publicKey);
const signerId = hubKeyId(signerPub) as string;

function scratchDir(prefix: string): string {
	return mkdtempSync(path.join(tmpdir(), prefix));
}

function remoteRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		kind: "plugin",
		name: "remote-kit",
		description: "Synthetic community row",
		version: "1.0.0",
		source: { repo: "https://github.com/example/remote-kit", commit: "b".repeat(40), subdir: "" },
		sha256: "c".repeat(64),
		publisher: "example",
		license: "MIT",
		tier: "listed",
		...overrides,
	};
}

function indexYaml(revoked: string[] = [], rows = [remoteRow()]): string {
	return stringify({
		entries: rows,
		revoked: revoked.map((sha256) => ({ sha256, reason: "synthetic revocation", date: "2019-05-01" })),
	});
}

interface Publication {
	certificateSequence?: number;
	keys?: Array<{ keyId: string; publicKey: string; notBefore: string; notAfter: string }>;
	revokedKeys?: string[];
	sequence?: number;
	index?: string;
	/** Bytes served as index.yaml when they differ from the signed ones. */
	served?: string;
	expires?: string;
	signers?: KeyObject[];
}

function signerKey(notBefore = "2019-01-01T00:00:00.000Z", notAfter = "2020-01-01T00:00:00.000Z") {
	return { keyId: signerId, publicKey: signerPub, notBefore, notAfter };
}

function publication(options: Publication = {}): Map<string, Uint8Array> {
	const index = options.index ?? indexYaml();
	const certificate = signHubEnvelope(
		HUB_KEYS_PAYLOAD_TYPE,
		{
			sequence: options.certificateSequence ?? 3,
			keys: options.keys ?? [signerKey()],
			revoked: options.revokedKeys ?? [],
		},
		[root.privateKey],
	);
	const statement = signHubEnvelope(
		HUB_INDEX_PAYLOAD_TYPE,
		{
			sequence: options.sequence ?? 10,
			generatedAt: "2019-05-31T00:00:00.000Z",
			expires: options.expires ?? "2019-07-01T00:00:00.000Z",
			commit: "a".repeat(40),
			indexPath: "hub/index.yaml",
			indexSha256: createHash("sha256").update(index).digest("hex"),
		},
		options.signers ?? [signer.privateKey],
	);
	return new Map([
		[HUB_CERTIFICATE_ASSET, Buffer.from(JSON.stringify(certificate))],
		[HUB_ENVELOPE_ASSET, Buffer.from(JSON.stringify(statement))],
		[HUB_INDEX_ASSET, Buffer.from(options.served ?? index)],
	]);
}

function serve(assets: Map<string, Uint8Array>, calls: string[] = []): HubAssetFetch {
	return async (url) => {
		calls.push(url.href);
		const name = path.posix.basename(url.pathname);
		const bytes = assets.get(name);
		if (!bytes) throw new Error(`no asset ${name}`);
		return bytes;
	};
}

function refresh(stateDir: string | undefined, options: Publication = {}, now = NOW) {
	return refreshRemoteIndex({
		url: URL_BASE,
		rootKeys,
		now: () => now,
		fetch: serve(publication(options)),
		...(stateDir ? { stateDir } : {}),
	});
}

/** The stored index, sequences and revocations, byte for byte. */
function keptBytes(stateDir: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const file of [
		hubTrustStatePath(stateDir),
		...[HUB_CERTIFICATE_ASSET, HUB_ENVELOPE_ASSET, HUB_INDEX_ASSET].map((name) => path.join(hubIndexDir(stateDir), name)),
	])
		out[file] = existsSync(file) ? readFileSync(file, "base64") : "(absent)";
	return out;
}

function pluginSource(dir: string, name: string, mcp = false): string {
	const source = path.join(dir, "source", name);
	mkdirSync(path.join(source, "skills", "notes"), { recursive: true });
	writeFileSync(
		path.join(source, "skills", "notes", "SKILL.md"),
		"---\nname: notes\ndescription: Notes\n---\nTake notes.\n",
	);
	writeFileSync(
		path.join(source, "plugin.json"),
		JSON.stringify({ $schema: PLUGIN_SCHEMA, name, version: "1.0.0", description: "Fixture", license: "MIT" }),
	);
	if (mcp)
		writeFileSync(
			path.join(source, "mcp.json"),
			JSON.stringify({ mcpServers: { notes: { type: "stdio", command: "node", args: ["server.mjs"] } } }),
		);
	return source;
}

/** Run the hub CLI capturing its text; byte chunks are the test runner's own events and pass through while it awaits. */
async function captureHub(args: string[], options: { catalog?: string } = {}): Promise<{ code: number; out: string }> {
	const out: string[] = [];
	const write = process.stdout.write.bind(process.stdout);
	const writeErr = process.stderr.write.bind(process.stderr);
	const capture = (passThrough: typeof write) =>
		((chunk: string | Uint8Array, ...rest: unknown[]) =>
			typeof chunk === "string"
				? out.push(chunk) > 0
				: (passThrough as (...a: unknown[]) => boolean)(chunk, ...rest)) as typeof process.stdout.write;
	process.stdout.write = capture(write);
	process.stderr.write = capture(writeErr);
	try {
		const code = await runHubCommand(args, options);
		return { code, out: out.join("") };
	} finally {
		process.stdout.write = write;
		process.stderr.write = writeErr;
	}
}

function attempt(run: () => { diagnostics: Array<{ type: string; message: string }> }): string {
	try {
		return run()
			.diagnostics.filter((item) => item.type === "error")
			.map((item) => item.message)
			.join("; ");
	} catch (err) {
		return err instanceof Error ? err.message : String(err);
	}
}

test("the fetcher takes one exact commit from a real file:// repository and refuses anything else", async (t) => {
	const dir = scratchDir("pancode-hub-fetch-");
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const git = (cwd: string, ...args: string[]) => {
		const result = spawnSync(
			"git",
			["-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", ...args],
			{ cwd, encoding: "utf8" },
		);
		equal(result.status, 0, result.stderr);
		return result.stdout.trim();
	};
	const work = path.join(dir, "work");
	mkdirSync(work);
	git(work, "init", "-q");
	const commitVersion = (version: string) => {
		const target = path.join(work, "plugins", "fixture");
		rmSync(target, { recursive: true, force: true });
		cpSync(pluginSource(path.join(dir, version), "fixture"), target, { recursive: true });
		const manifest = path.join(target, "plugin.json");
		writeFileSync(manifest, JSON.stringify({ ...JSON.parse(readFileSync(manifest, "utf8")), version }));
		git(work, "add", "-A");
		git(work, "commit", "-q", "-m", version);
		return { commit: git(work, "rev-parse", "HEAD"), digest: pluginContentDigest(target) };
	};
	const pinned = commitVersion("1.0.0");
	commitVersion("1.0.1");
	const bare = path.join(dir, "remote.git");
	git(dir, "clone", "-q", "--bare", work, bare);
	git(bare, "config", "uploadpack.allowAnySHA1InWant", "true");
	const repo = `file://${bare}`;

	const fetched = fetchPluginCommit({ repo, commit: pinned.commit, subdir: "plugins/fixture" }, pinned.digest);
	try {
		equal(fetched.commit, pinned.commit);
		equal(
			JSON.parse(readFileSync(path.join(fetched.root, "plugin.json"), "utf8")).version,
			"1.0.0",
			"not the branch tip",
		);
		equal(pluginContentDigest(fetched.root), pinned.digest);
	} finally {
		fetched.cleanup();
	}
	throws(
		() => fetchPluginCommit({ repo, commit: pinned.commit, subdir: "plugins/fixture" }, "0".repeat(64)),
		/plugin_pin_mismatch: plugins\/fixture at /,
	);
	throws(() => fetchPluginCommit({ repo, commit: "d".repeat(40), subdir: "plugins/fixture" }), /d{40}/);
	throws(() => fetchPluginCommit({ repo, commit: pinned.commit.slice(0, 12), subdir: "" }), /40 lowercase hex/);
	throws(() => fetchPluginCommit({ repo, commit: pinned.commit.toUpperCase(), subdir: "" }), /40 lowercase hex/);

	// A stand-in git whose checkout reports another HEAD.
	const tools = path.join(dir, "bin");
	mkdirSync(tools);
	writeFileSync(
		path.join(tools, "git"),
		`#!${process.execPath}\nif(process.argv.includes('rev-parse'))process.stdout.write('${"e".repeat(40)}\\n');\n`,
		{ mode: 0o755 },
	);
	const previousPath = process.env.PATH;
	process.env.PATH = `${tools}${path.delimiter}${previousPath ?? ""}`;
	try {
		throws(
			() => fetchPluginCommit({ repo: "https://github.com/example/repo.git", commit: "f".repeat(40), subdir: "" }),
			new RegExp(`fetched ${"e".repeat(40)} where ${"f".repeat(40)} was requested`),
		);
	} finally {
		if (previousPath === undefined) delete process.env.PATH;
		else process.env.PATH = previousPath;
	}
});

test("row parsing drops unsafe, unlicensed, misattributed and duplicate rows", () => {
	const firstParty = {
		kind: "extension",
		name: "local-status",
		description: "First-party row",
		sourceUrl: "packs/extensions/local-status",
		version: "0.1.1",
		sha256: "d".repeat(64),
		publisher: "pancode",
		license: "LicenseRef-PanCode-1.0",
		tier: "core",
	};
	const diagnostics: string[] = [];
	const bundled = parseHubIndexRows(
		{ entries: [firstParty, { ...firstParty, name: "absolute", sourceUrl: "/srv/packs/absolute" }] },
		"/pkg/hub/index.yaml",
		diagnostics,
		{ mode: "bundled" },
	);
	deepStrictEqual(
		bundled.map((row) => row.name),
		["local-status"],
	);
	match(diagnostics.join("\n"), /row dropped \(extension:absolute\): sourceUrl must be relative to the index/);

	const remote: string[] = [];
	const { license: _license, ...unlicensed } = remoteRow({ name: "unlicensed" });
	const rows = parseHubIndexRows(
		{
			entries: [
				remoteRow(),
				unlicensed,
				remoteRow({ name: "core-claim", tier: "core" }),
				remoteRow({ name: "gpl-verified", tier: "verified", license: "GPL-3.0-only" }),
				remoteRow({ description: "second row, same kind and name" }),
			],
		},
		"index.yaml",
		remote,
		{ mode: "remote" },
	);
	deepStrictEqual(
		rows.map((row) => [row.name, row.publisher, row.tier, row.license]),
		[["remote-kit", "example", "listed", "MIT"]],
	);
	const text = remote.join("\n");
	match(text, /\(plugin:unlicensed\): .*a community row has a license/);
	match(text, /\(plugin:core-claim\): .*a core row comes from packs\//);
	match(text, /\(plugin:gpl-verified\): .*license is on the allowlist, not GPL-3\.0-only/);
	match(text, /\(plugin:remote-kit\): a second row with the same kind and name/);
});

test("a verified index is kept, and every refusal leaves the kept index byte for byte", async () => {
	const stateDir = scratchDir("pancode-hub-trust-state-");
	const accepted = await refresh(stateDir);
	ok(accepted.ok, JSON.stringify(accepted));
	equal(accepted.changed, true);
	equal(accepted.state.indexSequence, 10);
	equal(accepted.state.certificateSequence, 3);
	equal(accepted.state.keyId, signerId);
	deepStrictEqual(readHubTrustState(stateDir), accepted.state);
	const kept = keptBytes(stateDir);

	const revokingCertificate = { certificateSequence: 4, revokedKeys: [signerId], sequence: 11 };
	const cases: Array<[string, Publication]> = [
		["index-hash-mismatch", { sequence: 11, served: indexYaml(["e".repeat(64)]) }],
		["expired", { sequence: 11, expires: "2019-05-31T12:00:00.000Z" }],
		["index-rollback", { sequence: 9 }],
		["sequence-reused", { sequence: 10, index: indexYaml(["e".repeat(64)]) }],
		["revoked-key", revokingCertificate],
		[
			"key-not-valid-now",
			{ certificateSequence: 4, sequence: 11, keys: [signerKey("2019-01-01T00:00:00.000Z", "2019-02-01T00:00:00.000Z")] },
		],
		["certificate-rollback", { certificateSequence: 2, sequence: 11 }],
	];
	for (const [reason, options] of cases) {
		const result = await refresh(stateDir, options);
		ok(!result.ok, `${reason} was accepted`);
		equal(result.reason, reason, result.message);
		equal(result.kept?.indexSequence, 10);
		deepStrictEqual(keptBytes(stateDir), kept, `${reason} changed the kept index`);
	}

	const same = await refresh(stateDir);
	ok(same.ok);
	equal(same.changed, false);
});

test("with the compiled empty root, refresh refuses without a fetch and discovery offers bundled rows only", async (t) => {
	const env = await isolatePancodeEnv("pancode-hub-no-root-");
	t.after(() => env.restore());
	const calls: string[] = [];
	// `hub list`, `install` and `update` never try, so none prints a refusal banner (R2-F9).
	equal(await autoRefreshRemoteIndex({ url: URL_BASE, fetch: serve(publication(), calls) }), undefined);
	const result = await refreshRemoteIndex({ url: URL_BASE, fetch: serve(publication(), calls) });
	ok(!result.ok);
	equal(result.reason, "no-root-key");
	deepStrictEqual(calls, []);
	equal(readHubTrustState(), undefined);
	const discovered = discoverHub({ cwd: env.dir });
	ok(discovered.entries.length > 0);
	const bundled = path.resolve(bundledHubIndexPath());
	deepStrictEqual(
		discovered.entries.filter((entry) => entry.index !== bundled).map((entry) => entry.name),
		[],
	);
	// The CLI accepts both verbs: refresh refuses (exit 1, not a usage error) and status reports.
	const refresh = await captureHub(["refresh", "--json"]);
	const status = await captureHub(["status", "--json"]);
	equal(refresh.code, 1, refresh.out);
	equal(status.code, 0, status.out);
	match(refresh.out, /no-root-key/u);
	match(status.out, /"rootKey": false/u);
});

test("a dry run of an install missing its requirements says it would be refused, in the CLI's words", async (t) => {
	const env = await isolatePancodeEnv("pancode-hub-dry-requires-");
	t.after(() => env.restore());
	const preview = await captureHub(["install", "plugin:literature", "--dry-run"]);
	match(
		preview.out,
		/^would refuse install plugin:literature \(user\): .*; rerun with --with-requirements to install skill:arxiv-literature too$/mu,
		preview.out,
	);
	doesNotMatch(preview.out, /planned|plan with requirements/u, preview.out);
});

test("after expiry remote rows are withdrawn while installed packs load and stored revocations apply", async (t) => {
	const env = await isolatePancodeEnv("pancode-hub-expiry-");
	t.after(() => {
		clearPluginSnapshots();
		env.restore();
	});
	const cwd = path.join(env.dir, "workspace");
	mkdirSync(cwd);
	const revokedSource = pluginSource(env.dir, "revoked-kit");
	const revokedDigest = pluginContentDigest(revokedSource);
	ok(installPlugin(SAMPLE_KIT, { cwd, scope: "user" }).plugin?.loadable);
	ok(installPlugin(revokedSource, { cwd, scope: "user" }).plugin?.loadable);

	const accepted = await refresh(undefined, { index: indexYaml([revokedDigest]) });
	ok(accepted.ok, JSON.stringify(accepted));
	const packsRoot = path.dirname(bundledHubIndexPath());
	const current = remoteIndexRows([], { url: URL_BASE, now: () => NOW, packsRoot });
	equal(current.status, "current");
	deepStrictEqual(
		current.rows.map((row) => row.name),
		["remote-kit"],
	);

	const diagnostics: string[] = [];
	const later = remoteIndexRows(diagnostics, {
		url: URL_BASE,
		now: () => new Date("2019-07-02T00:00:00.000Z"),
		packsRoot,
	});
	equal(later.status, "expired");
	deepStrictEqual(later.rows, []);
	match(diagnostics.join("\n"), /remote index expired at 2019-07-01T00:00:00.000Z/);
	equal(
		discoverHub({ cwd }).entries.some((entry) => entry.name === "remote-kit"),
		false,
		"the wall clock is past the 2019 expiry",
	);

	ok(revokedHubDigests().has(revokedDigest));
	clearPluginSnapshots();
	const installed = listInstalledPlugins(cwd, { scope: "user" });
	equal(installed.find((entry) => entry.id === "sample-kit")?.loadable, true);
	const revoked = installed.find((entry) => entry.id === "revoked-kit");
	equal(revoked?.loadable, false);
	match(
		JSON.stringify(revoked?.diagnostics),
		new RegExp(`pack_revoked: revoked-kit ${revokedDigest} revoked 2019-05-01: synthetic revocation`),
	);
});

test("an id held by another publisher is refused in either scope, with or without force", async (t) => {
	const env = await isolatePancodeEnv("pancode-hub-publisher-");
	t.after(() => {
		clearPluginSnapshots();
		env.restore();
	});
	const cwd = path.join(env.dir, "workspace");
	mkdirSync(cwd);
	ok(installPlugin(SAMPLE_KIT, { cwd, scope: "user", publisher: "alice" }).plugin);
	const refusal =
		/hub_publisher_collision: sample-kit is installed from alice \(user\); remove it before installing sample-kit from bob/;
	for (const [scope, force] of [
		["user", true],
		["user", false],
		["project", false],
		["project", true],
	] as const)
		match(
			attempt(() => installPlugin(SAMPLE_KIT, { cwd, scope, force, publisher: "bob" })),
			refusal,
			`${scope} ${force}`,
		);
	equal(readPluginInstallRecord("sample-kit", { cwd, scope: "user" })?.publisher, "alice");
	// A remote row from another publisher is refused before any fetch: its repository does not exist.
	const missingRepo = path.join(env.dir, "no-such-repo");
	throws(
		() =>
			planHubInstall(
				{
					kind: "plugin",
					name: "sample-kit",
					description: "Fixture",
					sourceUrl: `file://${missingRepo}`,
					source: { repo: `file://${missingRepo}`, commit: "1".repeat(40), subdir: "." },
					origin: "catalog",
					sha256: "0".repeat(64),
					publisher: "bob",
				},
				{ cwd, scope: "project", force: true },
			),
		refusal,
	);
	// The listing names the copy's own publisher when the row's differs.
	const catalog = path.join(env.dir, "catalog.yaml");
	writeFileSync(
		catalog,
		stringify({
			entries: [
				{
					kind: "plugin",
					name: "sample-kit",
					version: "1.0.0",
					description: "Fixture",
					sourceUrl: SAMPLE_KIT,
					sha256: pluginContentDigest(SAMPLE_KIT),
					publisher: "bob",
				},
			],
		}),
	);
	const listed = await captureHub(["list", "--user"], { catalog });
	equal(listed.code, 0, listed.out);
	match(listed.out, /^\w+:sample-kit +\S+ +user:[a-z-]+ \(installed from alice\)(?: .* bob$|\n {2}bob, from )/mu);
});

test("a revoked plugin digest is not loadable and its MCP declaration disappears", async (t) => {
	const env = await isolatePancodeEnv("pancode-hub-revoked-mcp-");
	t.after(() => {
		clearPluginSnapshots();
		env.restore();
	});
	const cwd = path.join(env.dir, "workspace");
	mkdirSync(path.join(cwd, ".pancode"), { recursive: true });
	const source = pluginSource(env.dir, "notes-kit", true);
	const digest = pluginContentDigest(source);
	ok(installPlugin(source, { cwd, scope: "user" }).plugin?.loadable);
	const servers = () => loadMcpServerConfig({ cwd }).servers.map((server) => server.id);
	deepStrictEqual(servers(), ["notes"]);

	mkdirSync(pancodeStateDir(), { recursive: true });
	writeFileSync(
		path.join(pancodeStateDir(), "hub-trust.json"),
		JSON.stringify({ revoked: [{ sha256: digest, reason: "synthetic revocation", date: "2019-05-01" }] }),
	);
	clearPluginSnapshots();
	const listed = listInstalledPlugins(cwd, { scope: "user" }).find((entry) => entry.id === "notes-kit");
	equal(listed?.loadable, false);
	match(JSON.stringify(listed?.diagnostics), /pack_revoked: notes-kit [a-f0-9]{64} revoked 2019-05-01/);
	deepStrictEqual(servers(), []);
});

test("a revoked running extension is retired with installation-revoked on the next maintenance tick", async (t) => {
	const env = await isolatePancodeEnv("pancode-hub-revoked-runtime-");
	const cwd = path.join(env.dir, "workspace");
	const source = path.join(env.dir, "source");
	mkdirSync(cwd);
	mkdirSync(source);
	writeFileSync(
		path.join(source, "pancode-extension.json"),
		JSON.stringify({
			id: "lab_status.v1",
			name: "Lab status",
			version: "1.0.0",
			description: "Synthetic revoked fixture",
			runtime: {
				api: 2,
				entrypoint: "extension.mjs",
				commands: [{ name: "inspect", description: "Inspect synthetic measurements", timeoutMs: 1000 }],
				events: [],
				ui: ["status"],
			},
		}),
	);
	writeFileSync(
		path.join(source, "extension.mjs"),
		'export default api => { let n=0; api.handle("inspect", () => ({ text: JSON.stringify({ n: ++n }) })); };',
	);
	const digest = installExtension(source, { cwd, scope: "user" }).extension?.provenance?.contentDigest;
	ok(digest);
	const runtime = new OperatorExtensions({
		context: () => ({ workspace: cwd, sessionId: null, mode: "interactive" }),
		isIdle: () => true,
		stateDir: () => path.join(env.dir, "state"),
	});
	const activity: PackActivity[] = [];
	const unbind = bindPackActivitySink((row) => {
		activity.push(row);
		return true;
	});
	t.after(async () => {
		await runtime.dispose();
		unbind();
		env.restore();
	});
	equal((await runtime.reload("startup")).status, "committed");
	equal(JSON.parse((await runtime.invoke("ext:lab_status.v1:inspect", "")).text).n, 1);
	ok(runtime.maintenanceDelayMs !== null && runtime.maintenanceDelayMs >= 30000, "a ready process schedules the tick");
	mkdirSync(pancodeStateDir(), { recursive: true });
	writeFileSync(
		path.join(pancodeStateDir(), "hub-trust.json"),
		JSON.stringify({ revoked: [{ sha256: digest, reason: "synthetic revocation", date: "2019-05-01" }] }),
	);
	runtime.maintenance();
	flushPackActivities();
	ok(
		activity.some(
			(row) => row.kind === "runtime_retire" && row.owner.id === "lab_status.v1" && row.outcome === "installation-revoked",
		),
		JSON.stringify(activity.map((row) => [row.kind, row.outcome])),
	);
	await rejects(runtime.invoke("ext:lab_status.v1:inspect", ""), /not an available extension command/);
	const listed = listInstalledExtensions(cwd).find((entry) => entry.id === "lab_status.v1");
	equal(listed?.valid, false);
	match(
		JSON.stringify(listed?.diagnostics),
		/pack_revoked: lab_status\.v1 [a-f0-9]{64} revoked 2019-05-01: synthetic revocation/,
	);
});

test("core and verified rows install trusted and a listed row installs foreign", async (t) => {
	const env = await isolatePancodeEnv("pancode-hub-tier-");
	t.after(() => {
		clearPluginSnapshots();
		env.restore();
	});
	const cwd = path.join(env.dir, "workspace");
	mkdirSync(cwd);
	const sha256 = pluginContentDigest(SAMPLE_KIT);
	const trustFor = (tier: HubTier) => {
		const entry = {
			kind: "plugin" as const,
			name: "sample-kit",
			description: "Fixture",
			sourceUrl: SAMPLE_KIT,
			origin: "catalog" as const,
			sha256,
			publisher: "example",
			tier,
		};
		const result = commitHubInstallPlan({
			entry,
			path: hubInstallPath(entry, { cwd, scope: "user" }),
			sha256,
			sourceRoot: SAMPLE_KIT,
			cwd,
			scope: "user",
			force: true,
		});
		ok(result.plugin, JSON.stringify(result.diagnostics));
		return readPluginInstallRecord("sample-kit", { cwd, scope: "user" })?.trust;
	};
	equal(trustFor("listed"), "foreign");
	equal(trustFor("verified"), "trusted");
	equal(trustFor("listed"), "foreign");
	equal(trustFor("core"), "trusted");
});

test("an extension manifest carries its licence and validation warns when it has none", async () => {
	const manifest = { id: "lab_status.v1", name: "Lab status", version: "1.0.0", description: "Synthetic fixture" };
	const parsed = parseExtensionManifest({ ...manifest, license: "MIT" }, "/fixture/pancode-extension.json");
	equal(parsed.manifest?.license, "MIT");
	equal(parseExtensionManifest({ ...manifest, license: "" }, "/fixture/pancode-extension.json").manifest, undefined);

	const dir = scratchDir("pancode-hub-license-");
	writeFileSync(path.join(dir, "pancode-extension.json"), JSON.stringify(manifest));
	const missing = await validateExtensionPackage(dir);
	ok(
		missing.diagnostics.some((item) => item.type === "warning" && item.message.startsWith("extension_license_missing:")),
	);
	writeFileSync(path.join(dir, "pancode-extension.json"), JSON.stringify({ ...manifest, license: "MIT" }));
	const declared = await validateExtensionPackage(dir);
	equal(
		declared.diagnostics.some((item) => item.message.startsWith("extension_license_missing:")),
		false,
	);
});

test("hub remote confirm validates the URL before saving it, and sync refusals explain themselves", async (t) => {
	const env = await isolatePancodeEnv("pancode-hub-remote-");
	t.after(() => env.restore());
	await rejects(
		syncHub("sync", async () => fail("no git runs while sync is off")),
		(err: Error) => {
			match(err.message, /^hub_sync_disabled: .*integrations\.hub\.sync true.*pancode hub remote confirm <url>$/u);
			return true;
		},
	);
	for (const bad of [
		"http://example.com/not-https",
		"not-a-url-at-all",
		"https://user:secret@example.com/r.git",
		"ext::sh -c x",
		"-u",
	])
		throws(() => confirmHubRemote(bad), /^Error: hub_remote_invalid: /u, bad);
	equal(readSettings().integrations.hub.remote, null);
	equal(readSettings().integrations.hub.confirmedRemote, null);
	equal(confirmHubRemote("http://127.0.0.1:9/hub.git"), "http://127.0.0.1:9/hub.git");
	throws(
		() => confirmHubRemote("git@github.com:example/hub.git"),
		/^Error: hub_remote_mismatch: integrations\.hub\.remote is http:\/\/127\.0\.0\.1:9\/hub\.git, not git@github\.com:example\/hub\.git; /u,
	);
	deepStrictEqual(
		{ remote: readSettings().integrations.hub.remote, confirmed: readSettings().integrations.hub.confirmedRemote },
		{ remote: "http://127.0.0.1:9/hub.git", confirmed: "http://127.0.0.1:9/hub.git" },
	);
});
