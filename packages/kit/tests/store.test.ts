// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, test } from "node:test";
import type { AnyTool } from "@pancode/sdk/tool";
import {
	appendRecord,
	createLocalStoreBackend,
	readBlobHistory,
	recordedPut,
	recordsTag,
	STORE_PUT_TAG_CLASS,
	type StoreBackend,
	storeProjectKey,
	storeProjectKeyForId,
	storeProjectRootOf,
	storeRootOption,
} from "@pancode/store";
import { ServerUsageError } from "../src/registry.js";
import { configure, probe, server, usage } from "../src/servers/store/index.js";
import { NO_ROOT_REASON, parseStoreOptions, storeConfig } from "../src/servers/store/options.js";
import { MAX_BLOBS, MAX_HISTORY, MAX_TAGS } from "../src/servers/store/tools.js";

/**
 * The store server, run in process against stores this test creates in a
 * temporary directory with `@pancode/store` itself. Every input is
 * constructed here: the option lists, the file contents put into the store,
 * and the tag and blob names. None was captured from a real program, and the
 * server runs no program, so there are no stubs on PATH.
 */

const base = mkdtempSync(join(tmpdir(), "kit-store-"));
after(() => configure([]));

const context = { signal: new AbortController().signal, log: () => {} };

function tool(name: string): AnyTool {
	const found = server.tools.find((entry) => entry.name === name);
	assert.ok(found, name);
	return found;
}

async function call(name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
	const result = await tool(name).run(args as never, context);
	assert.ok("json" in result, JSON.stringify(result));
	return result.json as Record<string, unknown>;
}

async function refusal(name: string, args: Record<string, unknown> = {}): Promise<string> {
	const result = await tool(name).run(args as never, context);
	assert.ok("error" in result, JSON.stringify(result));
	return result.error;
}

interface Fixture {
	dir: string;
	root: string;
	cache: string;
	project: string;
	backend: StoreBackend;
	/** The options naming this store, before any `--write-tag`. */
	options: string[];
}

let fixtures = 0;
function fixture(): Fixture {
	const dir = join(base, `f${fixtures++}`);
	const root = join(dir, "root");
	const cache = join(dir, "cache");
	const project = join(dir, "project");
	mkdirSync(root, { recursive: true });
	mkdirSync(project, { recursive: true });
	const projectRoot = storeProjectRootOf(project);
	const backend = createLocalStoreBackend({
		roots: [{ name: "default", path: root, durable: true, purge: null }],
		cacheDir: cache,
		projectKey: storeProjectKey(projectRoot),
		projectRoot,
	});
	return { dir, root, cache, project, backend, options: ["--root", root, "--cache", cache, "--project", project] };
}

function writeSource(dir: string, name: string, content: string): string {
	const file = join(dir, name);
	writeFileSync(file, content);
	return file;
}

const sha256 = (content: string | Buffer) => createHash("sha256").update(content).digest("hex");

/** Put `content` as tag:blob the way PanCode's main process does, so the server reads another actor's record. */
async function seed(f: Fixture, tag: string, blob: string, content: string, note?: string): Promise<void> {
	await f.backend.getOrCreateTag(tag, { class: STORE_PUT_TAG_CLASS });
	const source = writeSource(f.dir, `seed-${encodeURIComponent(blob)}`, content);
	const put = await recordedPut(f.backend, {
		tag,
		blob,
		source,
		actor: { actor: "main" },
		...(note !== undefined ? { record: { note } } : {}),
	});
	assert.equal(put.recorded, true);
}

test("configure takes the store server's options: roots, cache, project and repeated write tags", () => {
	const cwd = join(base, "cwd");
	const one = parseStoreOptions(["--root", "r"], cwd);
	assert.ok(one);
	assert.deepEqual(one.roots, [{ name: "default", path: resolve(cwd, "r"), durable: true, purge: null }]);
	assert.equal(one.projectRoot, storeProjectRootOf(cwd));
	assert.equal(one.projectKey, storeProjectKey(storeProjectRootOf(cwd)));
	assert.deepEqual(one.writeTags, []);

	const full = parseStoreOptions(
		[
			"--root",
			"/s/main",
			"--root",
			"scratch=/s/scratch",
			"--root",
			"cold=rel/cold",
			"--cache",
			"c",
			"--project",
			"/p/repo",
			"--write-tag",
			"results",
			"--write-tag",
			"runs/a",
			"--write-tag",
			"results",
		],
		cwd,
	);
	assert.ok(full);
	assert.deepEqual(
		full.roots.map((root) => [root.name, root.path]),
		[
			["default", "/s/main"],
			["scratch", "/s/scratch"],
			["cold", resolve(cwd, "rel/cold")],
		],
	);
	assert.equal(full.cacheDir, resolve(cwd, "c"));
	assert.equal(full.projectRoot, storeProjectRootOf("/p/repo"));
	assert.deepEqual(full.writeTags, ["results", "runs/a"]);
	assert.equal(full.projectId, undefined);

	const keyed = parseStoreOptions(["--root", "r", "--project", "/p/repo", "--project-id", "proof-shared"], cwd);
	assert.equal(keyed?.projectId, "proof-shared");
	assert.equal(keyed?.projectKey, storeProjectKeyForId("proof-shared"));

	assert.equal(parseStoreOptions([], cwd), null);
	assert.equal(parseStoreOptions(["--write-tag", "results"], cwd), null);

	configure(["--root", "/s/main"]);
	assert.equal(storeConfig()?.roots[0]?.path, "/s/main");
	configure([]);
	assert.equal(storeConfig(), null);
	assert.match(usage, /--write-tag/);
});

test("configure refuses a root without a name, an invalid root set, an invalid tag and an unknown option", () => {
	const refused: Array<[string[], RegExp]> = [
		[["--root", "/a", "--root", "/b"], /<name>=<dir>/],
		[["--root", "/a", "--root", "=/b"], /<name>=<dir>/],
		[["--root", "/a", "--root", "b="], /<name>=<dir>/],
		[["--root", "/a", "--root", "default=/b"], /appears twice/],
		[["--root", "/a", "--root", "bad name=/b"], /must be 1 to 64/],
		[["--root", "/a", "--write-tag", "../up"], /--write-tag \.\.\/up/],
		[["--root", "/a", "--write-tag", "results/.records"], /--write-tag/],
		[["--root", "/a", "--project-id", "Bad Id"], /--project-id Bad Id/],
		[["--root", "/a", "--bogus", "x"], /unknown option --bogus/],
		[["stray"], /unknown option stray/],
		[["--root"], /--root needs a value/],
		[["--root", "--write-tag", "x"], /--root needs a value, got --write-tag/],
	];
	for (const [argv, reason] of refused) {
		assert.throws(
			() => configure(argv),
			(error: unknown) => error instanceof ServerUsageError && reason.test(error.message),
			argv.join(" "),
		);
	}
	configure([]);
});

test("without --root the server is unavailable and every tool answers with the reason", async () => {
	configure([]);
	const probed = await probe();
	assert.equal(probed.available, false);
	assert.equal(probed.reason, NO_ROOT_REASON);
	assert.match(NO_ROOT_REASON, /no store root was named/);
	assert.match(NO_ROOT_REASON, /pancode store where/);
	const args: Record<string, Record<string, unknown>> = {
		store_tags: {},
		store_list: { tag: "t" },
		store_stat: { tag: "t", blob: "b" },
		store_get: { tag: "t", blob: "b" },
		store_history: { tag: "t" },
		store_put: { tag: "t", source: "missing" },
		store_note: { tag: "t", blob: "b", note: "n" },
	};
	assert.deepEqual(Object.keys(args).sort(), server.tools.map((entry) => entry.name).sort());
	for (const [name, input] of Object.entries(args)) {
		assert.equal(await refusal(name, input), `${name}: ${NO_ROOT_REASON}`);
	}
});

test("a primary root that does not exist is unavailable, and a read says so rather than listing nothing", async () => {
	const missing = join(base, "no-such-root");
	configure(["--root", missing, "--root", `other=${base}`]);
	const probed = await probe();
	assert.equal(probed.available, false);
	assert.match(probed.reason ?? "", /does not exist/);
	assert.deepEqual(probed.sources, [
		{ name: "root default", found: false, detail: missing },
		{ name: "root other", found: true, detail: base },
	]);
	assert.match(await refusal("store_tags"), /store_tags: the primary store root .* does not exist/);
	configure([]);
});

// Constructed: a store whose primary root is named "shared", the way a settings file may name it.
test("a primary root given as <name>=<dir> reaches tags placed on that root by name", async () => {
	const dir = join(base, "named-primary");
	const root = join(dir, "root");
	const project = join(dir, "project");
	mkdirSync(root, { recursive: true });
	mkdirSync(project, { recursive: true });
	const projectRoot = storeProjectRootOf(project);
	const shared = { name: "shared", path: root, durable: true, purge: null };
	const backend = createLocalStoreBackend({
		roots: [shared],
		cacheDir: join(dir, "cache"),
		projectKey: storeProjectKey(projectRoot),
		projectRoot,
	});
	await seed({ dir, root, cache: join(dir, "cache"), project, backend, options: [] }, "inputs", "a.csv", "1,2\n");
	const options = ["--cache", join(dir, "cache"), "--project", project];

	configure(["--root", root, ...options]);
	assert.match(
		await refusal("store_list", { tag: "inputs" }),
		/created on store root shared, which is no longer configured/,
	);

	configure(["--root", storeRootOption(shared, true), ...options]);
	assert.deepEqual(parseStoreOptions(["--root", `shared=${root}`], dir)?.roots, [shared]);
	const listed = await call("store_list", { tag: "inputs" });
	assert.deepEqual(
		(listed.blobs as Array<Record<string, unknown>>).map((row) => row.blob),
		["a.csv"],
	);
	configure([]);
});

test("the read tools report tags, blobs, a blob's records and a read-only copy", async () => {
	const f = fixture();
	await seed(f, "data", "a.txt", "alpha\n", "first input");
	await seed(f, "data", "b.txt", "bravo bravo\n");
	await seed(f, "data", "dir/c.txt", "charlie\n");
	await seed(f, "other", "x.bin", "x");
	await appendRecord(f.backend, {
		kind: "note",
		tag: "data",
		blob: "a.txt",
		producedBy: { actor: "main" },
		note: "checked",
	});
	configure(f.options);
	assert.deepEqual(await probe(), {
		available: true,
		sources: [{ name: "root default", found: true, detail: f.root }],
	});

	const tags = await call("store_tags");
	assert.deepEqual(tags.tags, [
		{ tag: "data", blobs: 3, bytes: 6 + 12 + 8, root: "default" },
		{ tag: "other", blobs: 1, bytes: 1, root: "default" },
	]);
	assert.equal(tags.truncated, false);
	assert.equal(tags.cap, MAX_TAGS);

	const listed = await call("store_list", { tag: "data" });
	const blobs = listed.blobs as Array<Record<string, unknown>>;
	assert.deepEqual(
		blobs.map((row) => [row.blob, row.bytes, row.recorded]),
		[
			["a.txt", 6, true],
			["b.txt", 12, true],
			["dir/c.txt", 8, true],
		],
	);
	assert.match(String(blobs[0]?.storedAt), /^\d{4}-\d\d-\d\dT.*Z$/);
	assert.equal(listed.truncated, false);
	const prefixed = await call("store_list", { tag: "data", prefix: "dir/" });
	assert.deepEqual(
		(prefixed.blobs as Array<Record<string, unknown>>).map((row) => row.blob),
		["dir/c.txt"],
	);
	assert.match(await refusal("store_list", { tag: "nope" }), /no tag named nope/);
	assert.match(await refusal("store_list", { tag: "../up" }), /^store_list: /);

	const stat = await call("store_stat", { tag: "data", blob: "a.txt" });
	assert.equal(stat.bytes, 6);
	assert.equal(stat.sha256, sha256("alpha\n"));
	assert.equal(stat.root, "default");
	assert.equal(stat.drift, "none");
	assert.deepEqual((stat.lastPut as Record<string, unknown>).actor, "main");
	assert.equal((stat.lastPut as Record<string, unknown>).note, "first input");
	assert.deepEqual(
		(stat.notes as Array<Record<string, unknown>>).map((note) => [note.actor, note.note]),
		[["main", "checked"]],
	);
	assert.deepEqual(stat.unavailable, {});
	assert.match(await refusal("store_stat", { tag: "data", blob: "missing" }), /not in the store/);
	assert.match(await refusal("store_stat", { tag: "data", blob: "a#b" }), /^store_stat: /);

	const got = await call("store_get", { tag: "data", blob: "b.txt" });
	assert.equal(got.bytes, 12);
	assert.equal(got.sha256, sha256("bravo bravo\n"));
	const copy = String(got.path);
	assert.equal(readFileSync(copy, "utf8"), "bravo bravo\n");
	assert.ok(copy.startsWith(f.cache), copy);
	assert.ok(!copy.startsWith(f.root), copy);
	assert.equal(statSync(copy).mode & 0o222, 0);
	assert.equal(JSON.stringify(got).includes("bravo"), false);

	const history = await call("store_history", { tag: "data", blob: "a.txt" });
	assert.deepEqual(
		(history.records as Array<Record<string, unknown>>).map((record) => [record.kind, record.actor, record.note]),
		[
			["note", "main", "checked"],
			["put", "main", "first input"],
		],
	);
	const whole = await call("store_history", { tag: "data" });
	const kinds = (whole.records as Array<Record<string, unknown>>).map((record) => `${record.kind}:${record.blob}`);
	assert.equal(kinds.length, 4);
	assert.equal(kinds[0], "note:a.txt");
	assert.deepEqual([...kinds].sort(), ["note:a.txt", "put:a.txt", "put:b.txt", "put:dir/c.txt"]);
	assert.equal(whole.truncated, false);
	assert.match(await refusal("store_history", { tag: "nope" }), /no tag named nope/);
	configure([]);
});

test("store_stat reports a changed blob's drift and holds back the recorded SHA-256", async () => {
	const f = fixture();
	await seed(f, "data", "a.txt", "alpha\n");
	await f.backend.putBlobFromFile("data", "a.txt", writeSource(f.dir, "changed", "changed bytes\n"));
	configure(f.options);
	const stat = await call("store_stat", { tag: "data", blob: "a.txt" });
	assert.equal(stat.sha256, null);
	assert.notEqual(stat.drift, "none");
	assert.match(String((stat.unavailable as Record<string, string>).sha256), /no longer match/);
	configure([]);
});

test("each read list is capped and says when it was cut", async () => {
	const f = fixture();
	for (let i = 0; i <= MAX_TAGS; i++) await f.backend.getOrCreateTag(`t${String(i).padStart(4, "0")}`);
	const source = writeSource(f.dir, "one", "1");
	await f.backend.getOrCreateTag("many");
	// Each blob has its own lock, so these puts and their records run side by side.
	await Promise.all(
		Array.from({ length: MAX_BLOBS + 1 }, (_, i) =>
			recordedPut(f.backend, { tag: "many", blob: `b${String(i).padStart(4, "0")}`, source, actor: { actor: "main" } }),
		),
	);
	await f.backend.putBlobFromFile("many", "unrecorded", source);
	await seed(f, "noted", "n.txt", "n");
	for (let i = 0; i < MAX_HISTORY; i++) {
		await appendRecord(f.backend, {
			kind: "note",
			tag: "noted",
			blob: "n.txt",
			producedBy: { actor: "main" },
			note: `n${i}`,
		});
	}
	configure(f.options);

	const tags = await call("store_tags");
	assert.equal((tags.tags as unknown[]).length, MAX_TAGS);
	assert.equal(tags.total, MAX_TAGS + 3);
	assert.equal(tags.truncated, true);

	const listed = await call("store_list", { tag: "many" });
	const blobs = listed.blobs as Array<Record<string, unknown>>;
	assert.equal(blobs.length, MAX_BLOBS);
	assert.equal(listed.truncated, true);
	assert.equal(blobs[0]?.recorded, true);
	const unrecorded = await call("store_list", { tag: "many", prefix: "unrec" });
	assert.deepEqual(
		(unrecorded.blobs as Array<Record<string, unknown>>).map((row) => [row.blob, row.recorded]),
		[["unrecorded", false]],
	);

	const one = await call("store_history", { tag: "noted", blob: "n.txt" });
	const oneRecords = one.records as Array<Record<string, unknown>>;
	assert.equal(oneRecords.length, MAX_HISTORY);
	assert.equal(one.truncated, true);
	assert.equal(oneRecords[0]?.note, `n${MAX_HISTORY - 1}`);
	const whole = await call("store_history", { tag: "many" });
	assert.equal((whole.records as unknown[]).length, MAX_HISTORY);
	assert.equal(whole.truncated, true);
	configure([]);
});

test("store_put writes the named tag and the tags under it, recorded with actor mcp", async () => {
	const f = fixture();
	configure([...f.options, "--write-tag", "results", "--write-tag", "logs"]);
	const source = writeSource(f.project, "out.csv", "a,b\n1,2\n");

	const put = await call("store_put", { tag: "results", source, note: "from a host" });
	assert.equal(put.stored, true);
	assert.equal(put.recorded, true);
	assert.equal(put.replaced, false);
	const nested = await call("store_put", { tag: "results/run1", source, blob: "copy.csv" });
	assert.equal(nested.recorded, true);

	for (const [tag, blob] of [
		["results", "out.csv"],
		["results/run1", "copy.csv"],
	] as const) {
		const { records } = await readBlobHistory(f.backend, tag, blob);
		assert.equal(records.length, 1);
		assert.equal(records[0]?.kind, "put");
		assert.deepEqual(records[0]?.producedBy, { actor: "mcp" });
		assert.equal(records[0]?.identity?.sha256, sha256("a,b\n1,2\n"));
		assert.deepEqual(records[0]?.source, { path: "out.csv" });
	}
	const stat = await call("store_stat", { tag: "results", blob: "out.csv" });
	assert.deepEqual(stat.lastPut, {
		actor: "mcp",
		at: (stat.lastPut as { at: string }).at,
		note: "from a host",
		bytes: 8,
	});
	configure([]);
});

test("store_put into another tag is refused before the source is opened, naming the tags allowed", async () => {
	const f = fixture();
	configure([...f.options, "--write-tag", "results"]);
	const missing = join(f.dir, "never-created.csv");
	for (const tag of ["other", "resultsx", "result"]) {
		const error = await refusal("store_put", { tag, source: missing });
		assert.match(error, new RegExp(`tag ${tag} is not writable`));
		assert.match(error, /results \(and results\/\.\.\.\)/);
		assert.doesNotMatch(error, /never-created|ENOENT|not found/i);
	}
	assert.equal(await f.backend.tagExists("other"), false);

	configure(f.options);
	const error = await refusal("store_put", { tag: "results", source: missing });
	assert.match(error, /started without --write-tag/);
	assert.doesNotMatch(error, /never-created|ENOENT/);
	assert.equal(existsSync(join(f.root, "projects")), false);
	configure([]);
});

test("store_put whose record cannot be written returns the stored-but-unrecorded result", async (t) => {
	const f = fixture();
	configure([...f.options, "--write-tag", "results"]);
	const first = writeSource(f.project, "first.txt", "first\n");
	assert.equal((await call("store_put", { tag: "results", source: first })).recorded, true);

	const recordsBlobs = join(
		f.root,
		"projects",
		storeProjectKey(storeProjectRootOf(f.project)),
		"tags",
		encodeURIComponent(recordsTag("results")),
		"blobs",
	);
	assert.ok(existsSync(recordsBlobs), recordsBlobs);
	chmodSync(recordsBlobs, 0o500);
	t.after(() => chmodSync(recordsBlobs, 0o700));

	const second = writeSource(f.project, "second.txt", "second\n");
	const put = await call("store_put", { tag: "results", source: second });
	assert.equal(put.stored, true);
	assert.equal(put.recorded, false);
	assert.equal(typeof put.reason, "string");
	assert.ok(String(put.reason).length > 0);
	assert.equal(await f.backend.statBlob("results", "second.txt").then((info) => info?.bytes), 7);
	configure([]);
});

test("store_note notes an existing blob with actor mcp, under the same write rule", async () => {
	const f = fixture();
	await seed(f, "results", "r.txt", "r");
	await seed(f, "inputs", "i.txt", "i");

	configure(f.options);
	assert.match(await refusal("store_note", { tag: "results", blob: "r.txt", note: "n" }), /without --write-tag/);

	configure([...f.options, "--write-tag", "results"]);
	const other = await refusal("store_note", { tag: "inputs", blob: "i.txt", note: "n" });
	assert.match(other, /tag inputs is not writable/);
	assert.match(other, /results \(and results\/\.\.\.\)/);
	assert.match(await refusal("store_note", { tag: "results", blob: "missing", note: "n" }), /not in the store/);

	const noted = await call("store_note", { tag: "results", blob: "r.txt", note: "looked fine" });
	assert.equal((noted.noted as Record<string, unknown>).kind, "note");
	const { records } = await readBlobHistory(f.backend, "results", "r.txt");
	assert.deepEqual(
		records.map((record) => [record.kind, record.producedBy.actor, record.note ?? null]),
		[
			["put", "main", null],
			["note", "mcp", "looked fine"],
		],
	);
	const { records: untouched } = await readBlobHistory(f.backend, "inputs", "i.txt");
	assert.equal(untouched.length, 1);
	configure([]);
});

test("shared store_put with --project-id records projectId in the shared log binding", async () => {
	const dir = join(base, "shared-project-id");
	const root = join(dir, "root");
	const cache = join(dir, "cache");
	const project = join(dir, "project");
	mkdirSync(root, { recursive: true });
	mkdirSync(project, { recursive: true });
	const source = writeSource(project, "out.txt", "ok\n");
	configure([
		"--root",
		root,
		"--shared",
		"--cache",
		cache,
		"--project",
		project,
		"--project-id",
		"sim",
		"--write-tag",
		"results",
	]);
	const put = await call("store_put", { tag: "results", source });
	assert.equal(put.stored, true);
	assert.equal(put.recorded, true);
	const { createSharedStoreBackend, storeProjectKeyForId } = await import("@pancode/store");
	const shared = createSharedStoreBackend({
		root,
		cacheDir: cache,
		projectKey: storeProjectKeyForId("sim"),
		projectId: "sim",
		projectRoot: storeProjectRootOf(project),
	});
	const bindings = await shared.log.projects();
	assert.equal(bindings.length, 1);
	assert.equal(bindings[0]?.projectId, "sim");
	configure([]);
});
