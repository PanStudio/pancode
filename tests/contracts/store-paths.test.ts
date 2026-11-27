// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { notStrictEqual, ok, strictEqual } from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { storeProjectKey, storeProjectKeyForId } from "@pancode/store";
import { storePut } from "../../src/cli/store.js";
import "../../src/core/config.js";
import { validateSettings } from "../../src/core/settings-validate.js";
import {
	decodeTagSegment,
	encodeTagSegment,
	isRecordsTag,
	provideStoreSettings,
	recordsTag,
	storeBlobPath,
	storeProjectDir,
	storeProjectKeyFor,
	storeProjectRoot,
	storeReadRoots,
	storeRoot,
	storeRootSpecs,
	storeTagDir,
	storeWriteSet,
	storeWriteTarget,
	validateBlobName,
	validateTagName,
} from "../../src/core/store-paths.js";
import { captureProjectSurface, recordProjectSurfaceTrust } from "../../src/core/workspace-trust.js";
import { isolatePancodeEnv } from "../harness/scratch-env.js";

test("store names follow the tag and blob rules and every refusal names its rule", () => {
	for (const ok of ["sim/run7", "out/summary.parquet"]) {
		strictEqual(validateTagName(ok), null, ok);
		strictEqual(validateBlobName(ok), null, ok);
	}
	const tagCases: Array<[string, RegExp]> = [
		["/abs", /start with "\/"/u],
		["a//b", /empty segment/u],
		["a/../b", /"\.\." segment/u],
		[".records/x", /must not start with "\."/u],
		["x#1", /may contain only/u],
		["t".repeat(201), /at most 200 bytes/u],
	];
	for (const [tag, rule] of tagCases) strictEqual(rule.test(validateTagName(tag) ?? ""), true, tag);
	const blobCases: Array<[string, RegExp]> = [
		["/abs", /start with "\/"/u],
		["a//b", /empty segment/u],
		["a/../b", /"\.\." segment/u],
		["x#1", /other than '#'/u],
		["b".repeat(481), /at most 480 bytes/u],
	];
	for (const [blob, rule] of blobCases) strictEqual(rule.test(validateBlobName(blob) ?? ""), true, blob);
	strictEqual(isRecordsTag(recordsTag("sim")), true);
	notStrictEqual(validateTagName(recordsTag("sim")), null);
	strictEqual(validateTagName(recordsTag("sim"), { allowRecords: true }), null);
	notStrictEqual(validateTagName(recordsTag("../x"), { allowRecords: true }), null);
	strictEqual(encodeTagSegment("sim/run7").includes("/"), false);
	strictEqual(decodeTagSegment(encodeTagSegment("sim/run7")), "sim/run7");
});

test("a linked worktree and its main checkout share one store project key", () => {
	const scratch = mkdtempSync(join(tmpdir(), "pancode-store-paths-"));
	const main = join(scratch, "repo");
	const linkedGitDir = join(main, ".git", "worktrees", "lane");
	mkdirSync(linkedGitDir, { recursive: true });
	writeFileSync(join(linkedGitDir, "commondir"), "../..\n");
	const worktree = join(scratch, "lane");
	mkdirSync(join(worktree, "src"), { recursive: true });
	writeFileSync(join(worktree, ".git"), `gitdir: ${linkedGitDir}\n`);

	strictEqual(storeProjectKeyFor(storeProjectRoot(join(worktree, "src"))), storeProjectKeyFor(storeProjectRoot(main)));
	strictEqual(storeProjectDir(worktree), storeProjectDir(main));
});

test("storeWriteSet names the records, project.json and locks a write touches besides its target", () => {
	const cwd = mkdtempSync(join(tmpdir(), "pancode-store-set-"));
	const tag = "sim/run7";
	const project = storeProjectDir(cwd);
	const set = storeWriteSet(cwd, { op: "put", tag, blob: "a.h5", path: "x.h5" });
	strictEqual(set[0], storeBlobPath(cwd, tag, "a.h5"));
	for (const expected of [storeTagDir(cwd, recordsTag(tag)), join(project, "project.json"), join(project, "locks")])
		strictEqual(set.includes(expected), true, expected);
	strictEqual(storeWriteSet(cwd, { op: "get", tag, blob: "a.h5" }).length, 0);
});

test("storeWriteTarget predicts each write op's path and is null for reads and malformed calls", () => {
	const cwd = mkdtempSync(join(tmpdir(), "pancode-store-target-"));
	const tag = "sim/run7";
	strictEqual(storeWriteTarget(cwd, { op: "create", tag }), storeTagDir(cwd, tag));
	strictEqual(
		storeWriteTarget(cwd, { op: "put", tag, blob: "out/a.h5", path: "data/x.h5" }),
		storeBlobPath(cwd, tag, "out/a.h5"),
	);
	strictEqual(storeWriteTarget(cwd, { op: "put", tag, path: "data/x.h5" }), storeBlobPath(cwd, tag, "x.h5"));
	strictEqual(storeWriteTarget(cwd, { op: "put", tag, blob: "", path: "data/x.h5" }), storeBlobPath(cwd, tag, "x.h5"));
	strictEqual(storeWriteTarget(cwd, { op: "note", tag }), storeTagDir(cwd, recordsTag(tag)));
	strictEqual(storeWriteTarget(cwd, { op: "remove", tag, blob: "x.h5" }), storeBlobPath(cwd, tag, "x.h5"));
	for (const op of ["tags", "list", "stat", "get", "frobnicate"])
		strictEqual(storeWriteTarget(cwd, { op, tag, blob: "x.h5" }), null, op);
	strictEqual(storeWriteTarget(cwd, { op: "create", tag: "/abs" }), null);
	strictEqual(storeWriteTarget(cwd, { op: "remove", tag }), null);
	const [readRoot] = storeReadRoots(cwd);
	strictEqual(storeTagDir(cwd, tag).startsWith(`${readRoot}/`), true);
	strictEqual(readRoot?.startsWith(`${storeRoot()}/`), true);
});

test("the path predicted for a put that creates its tag on a placed root is the path the put writes", async () => {
	const env = await isolatePancodeEnv("pancode-store-predict-");
	const previous = process.cwd();
	const cwd = join(env.dir, "workspace");
	const scratch = join(env.dir, "scratch-root");
	mkdirSync(cwd, { recursive: true });
	mkdirSync(scratch, { recursive: true });
	writeFileSync(join(cwd, "x.h5"), "bytes\n");
	const primary = { name: "default", path: storeRoot(), durable: true, purge: null };
	provideStoreSettings(() => ({
		roots: [primary, { name: "scratch", path: scratch, durable: true, purge: null }],
		placement: { byTag: {}, byClass: { input: "scratch" } },
	}));
	try {
		process.chdir(cwd);
		strictEqual(storeRootSpecs().length, 2);
		const predicted = storeWriteTarget(cwd, { op: "put", tag: "fresh", path: "x.h5" });
		ok(predicted?.startsWith(`${scratch}/`), String(predicted));
		strictEqual(existsSync(predicted ?? ""), false);
		const result = await storePut(cwd, "fresh", "x.h5");
		strictEqual(result.createdTag, true);
		ok(existsSync(predicted ?? ""));
		strictEqual(existsSync(join(storeProjectDir(cwd), "tags", "fresh")), false);
		strictEqual(storeBlobPath(cwd, "fresh", "x.h5"), predicted);
	} finally {
		process.chdir(previous);
		provideStoreSettings(null);
		env.restore();
	}
});

test("a tracked store.projectId gives checkouts at different paths one key, and without it the key is the path key", async () => {
	const env = await isolatePancodeEnv("pancode-store-project-id-");
	try {
		// Constructed: two checkouts of one repository at different paths, as two hosts would hold it.
		const checkout = (relative: string, settings: string | null): string => {
			const root = join(env.dir, relative);
			mkdirSync(join(root, ".git"), { recursive: true });
			if (settings !== null) {
				mkdirSync(join(root, ".pancode"), { recursive: true });
				writeFileSync(join(root, ".pancode", "settings.yaml"), settings);
				const snapshot = captureProjectSurface(root, "settings");
				if (!snapshot.contentHash) throw new Error("missing project settings hash");
				recordProjectSurfaceTrust(root, "settings", snapshot.contentHash);
			}
			return root;
		};
		const first = checkout("host-a/repo", "store:\n  projectId: shared-proof\n");
		const second = checkout("host-b/elsewhere/repo", "store:\n  projectId: shared-proof\n");
		const plain = checkout("host-a/plain", null);
		strictEqual(storeProjectKeyFor(first), storeProjectKeyForId("shared-proof"));
		strictEqual(storeProjectKeyFor(second), storeProjectKeyFor(first));
		strictEqual(storeProjectDir(second), storeProjectDir(first));
		strictEqual(storeProjectKeyFor(plain), storeProjectKey(plain));
		notStrictEqual(storeProjectKeyFor(plain), storeProjectKeyFor(first));
	} finally {
		env.restore();
	}
});

test("validateSettings rejects credentials/fragments in store.s3.endpoint and path characters in store.s3.bucket", () => {
	const check = (s3: Record<string, unknown>) => validateSettings({ store: { backend: "s3", s3 } }).issues;
	ok(
		check({ endpoint: "http://user:pass@127.0.0.1:9000", bucket: "ok", accessKeyId: "k" }).some(
			(issue) => issue.path === "store.s3.endpoint",
		),
	);
	ok(
		check({ endpoint: "https://s3.example.com#frag", bucket: "ok", accessKeyId: "k" }).some(
			(issue) => issue.path === "store.s3.endpoint",
		),
	);
	for (const bad of ["bad/bucket", "..", "has space", "a?b"]) {
		ok(
			check({ endpoint: "https://s3.example.com", bucket: bad, accessKeyId: "k" }).some(
				(issue) => issue.path === "store.s3.bucket",
			),
			bad,
		);
	}
});
