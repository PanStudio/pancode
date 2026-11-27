// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { deepStrictEqual, match, ok, rejects, strictEqual, throws } from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { describe, it } from "node:test";
import { settingsPath, validateSettingsFile } from "../../src/core/config.js";
import {
	provideStoreSettings,
	recordsTag,
	STORE_REPLACES_ARG,
	storeBlobPath,
	storeGrantBoundaries,
	storeProjectDir,
	storeRoot,
	storeTagDir,
} from "../../src/core/store-paths.js";
import {
	prepareSharedStoreGrant,
	type SharedStoreGrant,
	verifySharedStoreGrant,
} from "../../src/core/store-shared-grant.js";
import { ToolNames } from "../../src/core/tool-names.js";
import { captureProjectSurface, recordProjectSurfaceTrust } from "../../src/core/workspace-trust.js";
import type { DispatchRequest } from "../../src/domains/dispatch/contract.js";
import { isDispatchIntent, normalizeDispatchIntent } from "../../src/domains/dispatch/intent.js";
import { resolveDispatchPathScope } from "../../src/domains/dispatch/path-scope.js";
import type { RunNodeIdentity } from "../../src/domains/dispatch/types.js";
import {
	confineGrantOnlyWriters,
	overlappingWriteRootsWarning,
	writeRootsOverlap,
} from "../../src/domains/dispatch/writer-set.js";
import { classify } from "../../src/domains/safety/action-classifier.js";
import { createSafetyPolicyEngine } from "../../src/domains/safety/policy-engine.js";
import { isSubset, WORKSPACE_SCOPE } from "../../src/domains/safety/scope.js";
import { openStoreBackend } from "../../src/domains/store/index.js";
import { createWorkerSafety } from "../../src/engine/worker-tools.js";
import { dispatchRequestsFromArgs } from "../../src/tools/dispatch-arguments.js";
import { createRegistry } from "../../src/tools/registry.js";
import { createStoreTool, storeAdmissionFacts } from "../../src/tools/store/store-tool.js";
import { parseWorkerSpec } from "../../src/worker/spec-contract.js";
import { makeDispatchBundle } from "../harness/dispatch.js";
import { dispatchStubContext } from "../harness/dispatch-stub-context.js";
import { isolatePancodeEnv } from "../harness/scratch-env.js";

async function withWorkspace(fn: (root: string) => Promise<void>): Promise<void> {
	const env = await isolatePancodeEnv("pancode-store-grants-");
	try {
		const root = join(env.dir, "workspace");
		mkdirSync(join(root, "out"), { recursive: true });
		writeFileSync(join(root, "out", "summary.csv"), "a,b\n1,2\n");
		await fn(root);
	} finally {
		env.restore();
	}
}

/** A second store root, `bulk`, configured in user settings, that takes every new `output` tag. */
function configureBulkRoot(root: string): string {
	const bulk = join(root, "..", "bulk");
	mkdirSync(bulk, { recursive: true });
	mkdirSync(dirname(settingsPath()), { recursive: true });
	writeFileSync(
		settingsPath(),
		[
			"version: 2",
			"store:",
			"  roots:",
			`    - { name: home, path: ${JSON.stringify(storeRoot())}, durable: true, purge: null }`,
			`    - { name: bulk, path: ${JSON.stringify(bulk)}, durable: true, purge: null }`,
			"  placement:",
			"    byClass: { output: bulk }",
			"",
		].join("\n"),
	);
	deepStrictEqual(validateSettingsFile().issues, []);
	return bulk;
}

/** A checkout whose trusted, tracked settings give it `store.projectId: <id>`, holding the tag `results`. */
async function sharedProject(root: string, id: string): Promise<string> {
	const project = join(root, "..", `shared-${id}`);
	mkdirSync(join(project, ".git"), { recursive: true });
	mkdirSync(join(project, ".pancode"), { recursive: true });
	writeFileSync(join(project, ".pancode", "settings.yaml"), `store:\n  projectId: ${id}\n`);
	const snapshot = captureProjectSurface(project, "settings");
	if (!snapshot.contentHash) throw new Error("missing project settings hash");
	recordProjectSurfaceTrust(project, "settings", snapshot.contentHash);
	await (await openStoreBackend(project)).getOrCreateTag("results");
	return project;
}

const SSH_NODE: RunNodeIdentity = { id: "gpu", kind: "ssh", host: "gpu.example" };
const SSH_NODE_SANDBOX = { available: true, backend: "bwrap" as const, reason: null, network: null };

describe("store tag grants", () => {
	it("a worker scope holding granted tag directories stays a subset of the workspace scope", () =>
		withWorkspace(async (root) => {
			const previous = process.cwd();
			process.chdir(root);
			try {
				const worker = {
					...WORKSPACE_SCOPE,
					allowedWriteRoots: [`${join(root, "out")}/`, ...storeGrantBoundaries(root, ["results"])],
				};
				strictEqual(isSubset(worker, WORKSPACE_SCOPE), true);
				strictEqual(storeGrantBoundaries(root, ["results"])[0]?.startsWith(storeProjectDir(root)), true);
				// Without configured roots the scope is the workspace and this project's one store directory.
				deepStrictEqual(WORKSPACE_SCOPE.allowedWriteRoots, [`${root}/`, `${storeProjectDir(root)}/`]);
			} finally {
				process.chdir(previous);
			}
		}));

	it("admits a run with declared write roots granted a tag placed on another store root", () =>
		withWorkspace(async (root) => {
			const bulk = configureBulkRoot(root);
			const previous = process.cwd();
			process.chdir(root);
			try {
				await createStoreTool({ getCwd: () => root, writable: true }).run({ op: "create", tag: "results" });
				const granted = storeGrantBoundaries(root, ["results"]);
				ok(granted[0]?.startsWith(`${bulk}/`), granted[0]);
				const worker = { ...WORKSPACE_SCOPE, allowedWriteRoots: [`${join(root, "out")}/`, ...granted] };
				strictEqual(isSubset(worker, WORKSPACE_SCOPE), true);
				// The other root contributes this project's directory and nothing else.
				const elsewhere = { ...WORKSPACE_SCOPE, allowedWriteRoots: [`${join(bulk, "projects")}/`] };
				strictEqual(isSubset(elsewhere, WORKSPACE_SCOPE), false);
			} finally {
				process.chdir(previous);
			}
		}));

	it("puts into a granted tag as the worker and refuses an ungranted tag", () =>
		withWorkspace(async (root) => {
			await createStoreTool({ getCwd: () => root, writable: true }).run({ op: "create", tag: "results" });
			await createStoreTool({ getCwd: () => root, writable: true }).run({ op: "create", tag: "other" });
			const tool = createStoreTool({
				getCwd: () => root,
				writable: false,
				grant: { tags: ["results"], dispatchRunId: "run-1" },
			});
			strictEqual((await tool.run({ op: "put", tag: "results", path: "out/summary.csv" })).kind, "ok");
			const refused = await tool.run({ op: "put", tag: "other", path: "out/summary.csv" });
			strictEqual(refused.kind, "error");
			match(String((refused as { message?: unknown }).message), /no grant for tag 'other'/);
			const created = await tool.run({ op: "create", tag: "fresh" });
			strictEqual(created.kind, "error");
			match(String((created as { message?: unknown }).message), /can read the store but not write/);
		}));

	it("reads tags a model sent as a JSON array string", () => {
		const options = { auto: { approvedAuthorities: ["read-only" as const], authorityBasis: "yolo-policy" as const } };
		const parsed = dispatchRequestsFromArgs(
			{
				tasks: [
					{ agent: "coder", task: "t", tags: '["fleet"]' },
					{ agent: "coder", task: "u", tags: "fleet" },
					// The schema validator coerces the JSON string into a one-element array before parsing.
					{ agent: "coder", task: "v", tags: ['["fleet", "notes"]'] },
				],
			},
			options,
		);
		ok(parsed.ok, JSON.stringify(parsed));
		deepStrictEqual(
			parsed.requests.map((request) => request.storeTags),
			[["fleet"], ["fleet"], ["fleet", "notes"]],
		);
	});

	it("admits a put over an existing blob as destructive once admission has stat it", () =>
		withWorkspace(async (root) => {
			const local = await openStoreBackend(root);
			const openBackend = async () => local;
			const main = createStoreTool({ getCwd: () => root, writable: true, openBackend });
			await main.run({ op: "create", tag: "results" });
			const put = { op: "put", tag: "results", path: "out/summary.csv" };
			const fresh = await storeAdmissionFacts(put, root, openBackend);
			strictEqual(classify({ tool: ToolNames.Store, args: fresh }).actionClass, "write");
			strictEqual((await main.run(fresh)).kind, "ok");
			const replacing = await storeAdmissionFacts({ ...put, [STORE_REPLACES_ARG]: false }, root, openBackend);
			strictEqual(replacing[STORE_REPLACES_ARG], (await local.statBlob("results", "summary.csv"))?.bytes);
			deepStrictEqual(classify({ tool: ToolNames.Store, args: replacing }), {
				actionClass: "destructive",
				reasons: ["store-replace: results:summary.csv"],
			});
			strictEqual((await main.run(replacing)).kind, "ok");
		}));

	it("a single dispatch granting a tag on another root with no declared write roots writes that tag, and the grant narrows nothing: the run keeps the workspace scope, the workspace and this project's directory on each store root", () =>
		withWorkspace(async (root) => {
			const bulk = configureBulkRoot(root);
			const previous = process.cwd();
			process.chdir(root);
			try {
				await createStoreTool({ getCwd: () => root, writable: true }).run({ op: "create", tag: "results" });
				ok(storeTagDir(root, "results").startsWith(`${bulk}/`), storeTagDir(root, "results"));
				const request = {
					agentId: "coder",
					task: "put results",
					cwd: root,
					storeTags: ["results"],
				} as unknown as DispatchRequest;
				// No declared roots: the run keeps the workspace scope and the grant narrows nothing.
				deepStrictEqual(resolveDispatchPathScope(request).writeBoundaries, []);
				deepStrictEqual(WORKSPACE_SCOPE.allowedWriteRoots, [
					`${root}/`,
					`${storeProjectDir(root)}/`,
					`${join(bulk, "projects", basename(storeProjectDir(root)))}/`,
				]);
				const boundaries = storeGrantBoundaries(root, ["results"]);
				deepStrictEqual(boundaries, [`${storeTagDir(root, "results")}/`, `${storeTagDir(root, recordsTag("results"))}/`]);
				const registry = createRegistry({
					safety: createWorkerSafety({ cwd: root, writeRoots: resolveDispatchPathScope(request).writeBoundaries }),
					autonomy: () => "default",
					principal: "worker",
				});
				registry.register(
					createStoreTool({ getCwd: () => root, writable: false, grant: { tags: ["results"], dispatchRunId: "run-1" } }),
				);
				const put = await registry.invoke({
					tool: ToolNames.Store,
					args: { op: "put", tag: "results", path: "out/summary.csv" },
				});
				ok(put.kind === "ok" && put.result.kind === "ok", JSON.stringify(put));
				ok(existsSync(storeBlobPath(root, "results", "summary.csv")));
				ok(storeBlobPath(root, "results", "summary.csv").startsWith(`${bulk}/`));
				const engine = createSafetyPolicyEngine({ cwd: root, writeRoots: [] });
				for (const path of [join(root, "out", "new.txt"), join(storeProjectDir(root), "scratch.txt")]) {
					const verdict = engine.evaluate({ tool: ToolNames.Write, args: { path, content: "x" } });
					strictEqual(verdict.reasonCode === "write-root", false, `${path}: ${JSON.stringify(verdict.reasons)}`);
				}
			} finally {
				process.chdir(previous);
			}
		}));

	it("parallel writers granted the same tag do not overlap", () =>
		withWorkspace(async (root) => {
			const store = storeGrantBoundaries(root, ["results"]);
			strictEqual(writeRootsOverlap([`${join(root, "a")}/`, ...store], [`${join(root, "b")}/`, ...store]), false);
			strictEqual(writeRootsOverlap([`${join(root, "a")}/`], [`${join(root, "a", "x")}/`]), true);
		}));

	it("parallel writers holding only a grant are confined to their store directories", () =>
		withWorkspace(async (root) => {
			const specs = [{ id: "coder", capabilityClass: "workspace-edit" }] as never;
			const normalized = normalizeDispatchIntent({ read_roots: ["src/"] }, new Map());
			ok(normalized.ok);
			const base = { agentId: "coder", task: "put results", cwd: root, storeTags: ["results"] };
			const requests = [{ ...base }, { ...base, intent: normalized.intent }] as unknown as DispatchRequest[];
			strictEqual(confineGrantOnlyWriters(requests, specs), true);
			const store = storeGrantBoundaries(root, ["results"]);
			deepStrictEqual(requests[0]?.writeRoots, store);
			deepStrictEqual(requests[1]?.intent?.writeRoots, [...store].sort());
			strictEqual(isDispatchIntent(requests[1]?.intent), true);
			const mixed = [{ ...base }, { agentId: "coder", task: "edit", cwd: root }] as unknown as DispatchRequest[];
			strictEqual(confineGrantOnlyWriters(mixed, specs), false);
			strictEqual(mixed[0]?.writeRoots, undefined);
		}));

	it("warns about parallel tasks whose write roots overlap and stays silent for disjoint ones", () =>
		withWorkspace(async (root) => {
			mkdirSync(join(root, "src", "a"), { recursive: true });
			mkdirSync(join(root, "docs"), { recursive: true });
			const task = (agentId: string, writeRoots: string[]) => ({ agentId, task: "edit", cwd: root, writeRoots });
			const warning = overlappingWriteRootsWarning([
				task("one", ["src"]),
				task("two", ["src/a"]),
				task("three", ["docs"]),
			]);
			ok(warning !== null);
			match(warning, /task 1 \(one\) and task 2 \(two\)/u);
			ok(warning.includes(join("workspace", "src")) && warning.includes(join("src", "a")));
			ok(!warning.includes("three"));
			const same = overlappingWriteRootsWarning([task("one", ["docs"]), task("two", ["docs"])]);
			match(same ?? "", /task 1 \(one\) and task 2 \(two\)/u);
			strictEqual(overlappingWriteRootsWarning([task("one", ["src/a"]), task("two", ["docs"])]), null);
		}));
});

/** What the receiving node checks, run with the node's own roots in place. */
async function verifyOnNode(shared: string, grant: SharedStoreGrant, mounted: string): Promise<void> {
	const dirs = await verifySharedStoreGrant(shared, grant);
	ok(dirs.length === 2 && dirs.every((dir) => dir.startsWith(`${mounted}/`)), JSON.stringify(dirs));
	await rejects(verifySharedStoreGrant(shared, { ...grant, projectKey: "0000000000000000" }), /project id/u);
	const unknown = randomUUID();
	const foreign: SharedStoreGrant = {
		...grant,
		roots: [{ id: unknown, name: "default" }],
		tags: grant.tags.map((tag) => ({ ...tag, rootId: unknown })),
	};
	await rejects(
		verifySharedStoreGrant(shared, foreign),
		new RegExp(`root default id ${unknown} not found on this node`, "u"),
	);
	const elsewhere: SharedStoreGrant = {
		...grant,
		tags: grant.tags.map((tag) =>
			tag.tag === "results" ? { ...tag, path: tag.path.replace(/results$/u, "other") } : tag,
		),
	};
	await rejects(verifySharedStoreGrant(shared, elsewhere), /tag results resolves elsewhere/u);
}

// Constructed: scratch checkouts with tracked settings, an SSH node identity and the node's root under a second path.
describe("store grants to SSH nodes", () => {
	it("preview refuses tags for an SSH node without store.projectId, naming it, and admits them with one", () =>
		withWorkspace(async (root) => {
			await (await openStoreBackend(root)).getOrCreateTag("results");
			const shared = await sharedProject(root, "preview-proof");
			const bundle = makeDispatchBundle(dispatchStubContext(), {
				previewNode: () => ({ node: SSH_NODE, sandbox: SSH_NODE_SANDBOX }),
			});
			await bundle.extension.start();
			try {
				const preview = bundle.contract.preview;
				ok(preview);
				const writer = { agentId: "coder", task: "t", executionRole: "builder" as const, storeTags: ["results"] };
				throws(() => preview({ ...writer, cwd: root }), /node 'gpu' is remote.*store\.projectId/u);
				const admitted = preview({ ...writer, cwd: shared });
				ok(
					admitted.checkedAtRun?.some((line) => /checked at run and by the node/u.test(line)),
					JSON.stringify(admitted.checkedAtRun),
				);
			} finally {
				await bundle.extension.stop?.();
			}
		}));

	it("run refuses a root on a local file system type and otherwise names the project, roots and tag paths", () =>
		withWorkspace(async (root) => {
			const shared = await sharedProject(root, "run-proof");
			const bundle = makeDispatchBundle(dispatchStubContext(), {
				previewNode: () => ({ node: SSH_NODE, sandbox: SSH_NODE_SANDBOX }),
				resolveNode: () => ({ node: SSH_NODE, sandbox: SSH_NODE_SANDBOX }),
				spawnWorker: () => {
					throw new Error("fixture launch reached");
				},
			});
			await bundle.extension.start();
			try {
				await rejects(
					bundle.contract.dispatch({
						agentId: "coder",
						task: "Write results.",
						executionRole: "builder",
						requestOrigin: "internal",
						cwd: shared,
						storeTags: ["results"],
					}),
					/store root 'default' \(.*\) is on a file system local to this host/u,
				);
			} finally {
				await bundle.extension.stop?.();
			}
			const grant = await prepareSharedStoreGrant(shared, ["results"], () => "unverified", "gpu");
			strictEqual(grant.projectId, "run-proof");
			strictEqual(grant.roots.length, 1);
			strictEqual(grant.roots[0]?.name, "default");
			const key = basename(dirname(dirname(storeTagDir(shared, "results"))));
			deepStrictEqual(
				grant.tags.map((tag) => [tag.tag, tag.rootId, tag.path]),
				[
					["results", grant.roots[0]?.id, `projects/${key}/tags/results`],
					[
						recordsTag("results"),
						grant.roots[0]?.id,
						join("projects", key, "tags", basename(storeTagDir(shared, recordsTag("results")))),
					],
				],
			);
			strictEqual(grant.projectKey, key);
		}));

	it("the node refuses a wrong project key, an unknown root id and a tag that resolves elsewhere, and admits its root at another path", () =>
		withWorkspace(async (root) => {
			const shared = await sharedProject(root, "node-proof");
			const grant = await prepareSharedStoreGrant(shared, ["results"], () => "unverified", "gpu");
			// The node mounts the same root at another path and names it differently; its settings are its own.
			const mounted = join(root, "..", "node-mount");
			symlinkSync(storeRoot(), mounted);
			provideStoreSettings(() => ({
				roots: [{ name: "shared", path: mounted, durable: true, purge: null }],
				placement: { byTag: {}, byClass: {} },
			}));
			try {
				await verifyOnNode(shared, grant, mounted);
			} finally {
				provideStoreSettings(() => {
					const { roots, placement } = validateSettingsFile().settings.store;
					return { roots, placement };
				});
			}
		}));

	it("the worker spec contract rejects a malformed shared grant and parses a spec without one as before", () =>
		withWorkspace(async (root) => {
			const shared = await sharedProject(root, "spec-proof");
			let observed: Record<string, unknown> | undefined;
			const bundle = makeDispatchBundle(dispatchStubContext(), {
				spawnWorker: (spec) => {
					observed = JSON.parse(JSON.stringify(spec)) as Record<string, unknown>;
					throw new Error("fixture launch reached");
				},
			});
			await bundle.extension.start();
			try {
				await rejects(
					bundle.contract.dispatch({
						agentId: "coder",
						task: "Write results.",
						executionRole: "builder",
						requestOrigin: "internal",
						cwd: shared,
						storeTags: ["results"],
					}),
					/fixture launch/u,
				);
			} finally {
				await bundle.extension.stop?.();
			}
			if (observed === undefined) throw new Error("no spec reached the launch");
			const spec = observed;
			const storeGrant = spec.storeGrant as Record<string, unknown>;
			deepStrictEqual(parseWorkerSpec(spec).storeGrant?.tags, ["results"]);
			strictEqual(parseWorkerSpec(spec).storeGrant?.shared, undefined);
			const grant = await prepareSharedStoreGrant(shared, ["results"], () => "unverified", "gpu");
			const withShared = (value: unknown) => ({ ...spec, storeGrant: { ...storeGrant, shared: value } });
			strictEqual(parseWorkerSpec(withShared(grant)).storeGrant?.shared?.projectId, "spec-proof");
			const first = grant.tags[0] as SharedStoreGrant["tags"][number];
			for (const malformed of [
				{ ...grant, projectKey: "not-a-key" },
				{ ...grant, roots: [] },
				{ ...grant, tags: [{ ...first, rootId: randomUUID() }] },
				{ ...grant, tags: [{ ...first, path: "/abs/tags/results" }] },
				{ ...grant, tags: [{ ...first, path: "../escape" }] },
			])
				throws(() => parseWorkerSpec(withShared(malformed)), /WorkerSpec\.storeGrant\.shared/u);
		}));
});
