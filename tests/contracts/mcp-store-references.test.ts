// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { deepStrictEqual, doesNotMatch, match, ok, strictEqual } from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { readBlobHistory, type StoreBackend } from "@pancode/store";
import { sha256Hex } from "../../src/core/hash.js";
import { provideStoreSettings, storeBlobPath, storeRootSpecs } from "../../src/core/store-paths.js";
import { type ToolName, ToolNames } from "../../src/core/tool-names.js";
import { pancodeCachePath } from "../../src/core/xdg.js";
import { resolveWorkerMcpAdmission } from "../../src/domains/dispatch/worker-mcp.js";
import {
	approveMcpSurface,
	createMcpStdioClient,
	type McpBuiltinSource,
	type McpClient,
	mcpBuiltinLaunchArgs,
	mcpSurface,
	resolveMcpServers,
	trustMcpServer,
} from "../../src/domains/gateway/mcp/index.js";
import { classify } from "../../src/domains/safety/action-classifier.js";
import { openStoreBackend } from "../../src/domains/store/index.js";
import { createWorkerSafety } from "../../src/engine/worker-tools.js";
import { registerCoreTools } from "../../src/tools/core-bootstrap.js";
import { createMcpCapabilitySource, type McpCapabilitySource } from "../../src/tools/gateway/index.js";
import type { McpStoreAccess } from "../../src/tools/gateway/mcp-store-references.js";
import { createRegistry } from "../../src/tools/registry.js";
import type { RegistryVerdict } from "../../src/tools/registry-contract.js";
import { createStoreTool } from "../../src/tools/store/store-tool.js";
import { builtinFixtureSource, emptyBuiltinSource } from "../fixtures/mcp-builtin-server.js";
import { type IsolatedPancodeEnv, isolatePancodeEnv } from "../harness/scratch-env.js";

/**
 * Store references `store:<tag>:<blob>` in an MCP server's declared path
 * arguments, and the builtin `store` server in a session. Every input here is
 * constructed: the CSV and text bytes, the tag and blob names, the session,
 * turn and dispatch ids, and both fixture servers (`mcp-file-server.mjs` and
 * the `store` server of `mcp-builtin-server.ts`).
 */

const FILE_SERVER = resolve("tests/fixtures/mcp-file-server.mjs");
const COPY = "mcp_files__copy_file";
const WRITE = "mcp_files__write_text";
const STORE_PUT = "mcp_store__store_put";
const CSV = "a,b\n1,2\n";
const IDS = { sessionId: "session-1", turnId: "turn-1" };

interface Session {
	registry: ReturnType<typeof createRegistry>;
	source: McpCapabilitySource;
	launches: Array<{ id: string; args: ReadonlyArray<string> }>;
}

function failedMessage(verdict: RegistryVerdict): string {
	ok(verdict.kind === "ok" && verdict.result.kind === "error", JSON.stringify(verdict));
	return verdict.result.message;
}

function okOutput(verdict: RegistryVerdict): string {
	ok(verdict.kind === "ok" && verdict.result.kind === "ok", JSON.stringify(verdict));
	return verdict.result.output;
}

/** The backend with its record append failing, as a full or read-only records area does. */
function failingRecords(backend: StoreBackend): StoreBackend {
	return new Proxy(backend, {
		get(target, key) {
			if (key === "putRecordIfAbsent") {
				return async () => {
					throw new Error("records area is read-only");
				};
			}
			const value = Reflect.get(target, key, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}

describe("store references in MCP path arguments", () => {
	let env: IsolatedPancodeEnv;
	let project: string;
	let configDir: string;
	let builtin: McpBuiltinSource;
	const open: McpCapabilitySource[] = [];

	beforeEach(async () => {
		env = await isolatePancodeEnv("pancode-mcp-store-refs-");
		project = join(env.dir, "project");
		configDir = join(env.dir, "config");
		mkdirSync(join(project, ".pancode"), { recursive: true });
		mkdirSync(configDir, { recursive: true });
		builtin = emptyBuiltinSource(env.dir);
		writeFileSync(
			join(project, ".pancode", "mcp.yaml"),
			[
				"version: 1",
				"servers:",
				"  - id: files",
				`    command: ${JSON.stringify(process.execPath)}`,
				`    args: [${JSON.stringify(FILE_SERVER)}]`,
				"    toolActionClasses: { copy_file: execute, write_text: execute }",
				"    toolPathArguments: { copy_file: { input: read, output: write }, write_text: { output: write } }",
				"",
			].join("\n"),
		);
		ok(trustMcpServer({ cwd: project, configDir, id: "files", actionClass: "execute" }).ok);
		writeFileSync(join(project, "a.csv"), CSV);
		const store = createStoreTool({ getCwd: () => project, writable: true });
		for (const args of [
			{ op: "create", tag: "inputs" },
			{ op: "put", tag: "inputs", path: "a.csv" },
			{ op: "create", tag: "results" },
			{ op: "create", tag: "other" },
		]) {
			const result = await store.run(args);
			strictEqual(result.kind, "ok", JSON.stringify(result));
		}
	});

	afterEach(async () => {
		await Promise.all(open.splice(0).map((source) => source.close()));
		provideStoreSettings(null);
		env.restore();
	});

	function session(
		store: McpStoreAccess | undefined,
		options: { openBackend?: (cwd: string) => Promise<StoreBackend>; builtin?: McpBuiltinSource } = {},
	): Session {
		const launches: Session["launches"] = [];
		const registry = createRegistry({ safety: createWorkerSafety({ cwd: project }), autonomy: () => "yolo" });
		const source = createMcpCapabilitySource({
			cwd: project,
			configDir,
			builtin: options.builtin ?? builtin,
			registry,
			requestTimeoutMs: 10_000,
			...(store !== undefined ? { store } : {}),
			...(options.openBackend !== undefined ? { openStoreBackend: options.openBackend } : {}),
			clientFactory: (spec, clientOptions) => {
				launches.push({ id: spec.id, args: spec.args ?? [] });
				const client: McpClient = createMcpStdioClient(spec, {
					...clientOptions,
					initializeTimeoutMs: 10_000,
					killGraceMs: 200,
				});
				const listTools = client.listTools.bind(client);
				client.listTools = async (signal) => {
					const listing = await listTools(signal);
					if (spec.id === "files") {
						approveMcpSurface({ cwd: project, configDir, id: spec.id, surface: mcpSurface(listing.tools) });
					}
					return listing;
				};
				return client;
			},
		});
		open.push(source);
		registerCoreTools(registry, { mcpCapabilities: source });
		registry.onPermissionRequired((_call, _decision, meta) => registry.cancelParkedCall(meta.requestId, "denied"));
		return { registry, source, launches };
	}

	async function invoke(wired: Session, tool: string, args: Record<string, unknown>): Promise<RegistryVerdict> {
		ok((await wired.source.ensure(tool)).spec !== null, `${tool} is listed`);
		return wired.registry.invoke({ tool: tool as ToolName, args }, IDS);
	}

	async function history(tag: string, blob: string) {
		return (await readBlobHistory(await openStoreBackend(project), tag, blob)).records;
	}

	function calls(): string[] {
		const log = join(project, "calls.log");
		return existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : [];
	}

	/** Every name in a tag's directory, hidden temporaries included. */
	function tagEntries(tag: string): string[] {
		const dir = join(storeBlobPath(project, tag, "probe"), "..");
		return existsSync(dir) ? readdirSync(dir) : [];
	}

	it("1. hands a read reference to the server as a read-only cache copy of the blob", async () => {
		const wired = session({ writable: true });
		const output = okOutput(await invoke(wired, COPY, { input: "store:inputs:a.csv", output: "copied.csv" }));
		const given = /^copied (\S+) to /u.exec(output)?.[1];
		ok(given, output);
		ok(given.startsWith(`${join(pancodeCachePath(), "store")}/`), given);
		strictEqual(statSync(given).mode & 0o777, 0o400);
		strictEqual(readFileSync(given, "utf8"), CSV);
		strictEqual(readFileSync(join(project, "copied.csv"), "utf8"), CSV);
		doesNotMatch(output, /store:inputs/u);
		deepStrictEqual(calls(), ["copy_file"]);
	});

	it("2. commits a write reference with one put record naming the server, the ids and the read it used", async () => {
		const wired = session({ writable: true });
		const verdict = await invoke(wired, COPY, { input: "store:inputs:a.csv", output: "store:results:copy.csv" });
		const output = okOutput(verdict);
		match(output, new RegExp(`stored results:copy\\.csv \\(8 bytes, sha256 ${sha256Hex(CSV)}\\)`, "u"));
		strictEqual(readFileSync(storeBlobPath(project, "results", "copy.csv"), "utf8"), CSV);
		const records = await history("results", "copy.csv");
		strictEqual(records.length, 1);
		const [put] = records;
		strictEqual(put?.kind, "put");
		deepStrictEqual(put?.producedBy, { actor: "mcp", client: "files", ...IDS });
		strictEqual(put?.identity?.sha256, sha256Hex(CSV));
		deepStrictEqual(put?.used, [{ tag: "inputs", blob: "a.csv", bytes: 8, sha256: sha256Hex(CSV) }]);
		deepStrictEqual(tagEntries("results"), ["copy.csv"]);
	});

	it("3. stores nothing when the server writes the file and then answers isError", async () => {
		const wired = session({ writable: true });
		failedMessage(await invoke(wired, WRITE, { output: "store:results:broken.txt", text: "x", fail: true }));
		deepStrictEqual(calls(), ["write_text"]);
		deepStrictEqual(await history("results", "broken.txt"), []);
		deepStrictEqual(tagEntries("results"), []);
	});

	it("4. stores nothing and names the argument when the server answers success without writing", async () => {
		const wired = session({ writable: true });
		const message = failedMessage(
			await invoke(wired, WRITE, { output: "store:results:none.txt", text: "x", skip: true }),
		);
		match(message, /write store reference 'output' \(store:results:none\.txt\).*without writing a regular file/u);
		deepStrictEqual(await history("results", "none.txt"), []);
		deepStrictEqual(tagEntries("results"), []);
	});

	it("5. refuses a write reference before the call in a session with no store access", async () => {
		const wired = session(undefined);
		const message = failedMessage(await invoke(wired, WRITE, { output: "store:results:x.txt", text: "x" }));
		match(message, /can read the store but not write to it/u);
		deepStrictEqual(calls(), []);
	});

	it("6. lets a worker write only its granted tags, recording its dispatch run", async () => {
		const wired = session({ writable: false, grant: { tags: ["results"], dispatchRunId: "run-7" } });
		okOutput(await invoke(wired, WRITE, { output: "store:results:w.txt", text: "worker\n" }));
		const [put] = await history("results", "w.txt");
		deepStrictEqual(put?.producedBy, { actor: "mcp", client: "files", ...IDS, dispatchRunId: "run-7" });
		const refused = failedMessage(await invoke(wired, WRITE, { output: "store:other:w.txt", text: "x" }));
		match(refused, /no grant for tag 'other'.*tags: \["other"\]/u);
		deepStrictEqual(calls(), ["write_text"]);
	});

	it("7. refuses a missing tag, a missing blob and a malformed reference before the call", async () => {
		const wired = session({ writable: true });
		match(
			failedMessage(await invoke(wired, WRITE, { output: "store:nosuch:x.txt", text: "x" })),
			/tag 'nosuch' does not exist; create it/u,
		);
		match(
			failedMessage(await invoke(wired, COPY, { input: "store:inputs:none.csv", output: "out.csv" })),
			/tag 'inputs' has no blob named 'none\.csv'/u,
		);
		for (const value of ["store:a", "store::b", "store:results/.records:b"]) {
			match(
				failedMessage(await invoke(wired, COPY, { input: value, output: "out.csv" })),
				/not (a|a valid) store reference/u,
				value,
			);
		}
		deepStrictEqual(calls(), []);
		// A relative path that merely contains the prefix is a file in the project.
		writeFileSync(join(project, "store:a:b"), CSV);
		okOutput(await invoke(wired, COPY, { input: "./store:a:b", output: "plain.csv" }));
		deepStrictEqual(calls(), ["copy_file"]);
		const spec = (await wired.source.ensure(COPY)).spec;
		const effects = spec?.hostEffectCalls?.({ input: "./store:a:b", output: "plain.csv" }) ?? [];
		deepStrictEqual(
			effects.map((effect) => effect.call.tool),
			[ToolNames.Read, ToolNames.Write],
		);
	});

	it("8. admits a write reference as the store put it stands for", async () => {
		const main = session({ writable: true });
		const spec = (await main.source.ensure(WRITE)).spec;
		const [put] = spec?.hostEffectCalls?.({ output: "store:results:fresh.txt", text: "x" }) ?? [];
		strictEqual(put?.call.tool, ToolNames.Store);
		deepStrictEqual([put?.call.args?.op, put?.call.args?.tag, put?.call.args?.blob], ["put", "results", "fresh.txt"]);
		strictEqual(put && classify(put.call).actionClass, "write");

		okOutput(await invoke(main, WRITE, { output: "store:results:fresh.txt", text: "x" }));
		const [over] = spec?.hostEffectCalls?.({ output: "store:results:fresh.txt", text: "y" }) ?? [];
		strictEqual(over && classify(over.call).actionClass, "destructive");

		const worker = session({ writable: false, grant: { tags: ["results"] } });
		const workerSpec = (await worker.source.ensure(WRITE)).spec;
		const [ungranted] = workerSpec?.hostEffectCalls?.({ output: "store:other:x.txt", text: "x" }) ?? [];
		ok(ungranted);
		deepStrictEqual(classify(ungranted.call), { actionClass: "read", reasons: ["store-ungranted"] });
	});

	it("11. reports bytes stored without a record when the record append fails", async () => {
		const wired = session(
			{ writable: true },
			{ openBackend: async (cwd) => failingRecords(await openStoreBackend(cwd)) },
		);
		const message = failedMessage(await invoke(wired, WRITE, { output: "store:results:u.txt", text: "x" }));
		match(message, /stored the bytes .* as results:u\.txt but could not record them \(.*read-only/u);
		match(message, /drift "unrecorded"/u);
		strictEqual(readFileSync(storeBlobPath(project, "results", "u.txt"), "utf8"), "x");
		deepStrictEqual(await history("results", "u.txt"), []);
	});

	describe("the builtin store server", () => {
		function storeBuiltin(): McpBuiltinSource {
			const dir = join(env.dir, `builtin-${Math.random().toString(16).slice(2)}`);
			mkdirSync(dir);
			return builtinFixtureSource(dir, ["store"]);
		}

		function argvOf(output: string): string[] {
			return (JSON.parse(output) as { argv: string[] }).argv;
		}

		it("9. starts with the session's roots, cache, project and write tags, outside the declaration digest", async () => {
			const shipped = storeBuiltin();
			const digest = () => resolveMcpServers({ cwd: project, builtin: shipped }).servers.find((s) => s.id === "store");
			const before = digest()?.digest;
			ok(before);
			const scratch = join(env.dir, "scratch-root");
			mkdirSync(scratch);
			const primary = storeRootSpecs()[0];
			ok(primary);
			provideStoreSettings(() => ({
				roots: [primary, { name: "scratch", path: scratch, durable: true, purge: null }],
				placement: { byTag: {}, byClass: {} },
			}));
			strictEqual(digest()?.digest, before, "another home's roots leave the declaration digest as it was");

			const main = session({ writable: true }, { builtin: shipped });
			const argv = argvOf(okOutput(await invoke(main, STORE_PUT, { tag: "results", blob: "b.csv" })));
			deepStrictEqual(argv, [
				"--root",
				primary.path,
				"--root",
				`scratch=${scratch}`,
				"--cache",
				pancodeCachePath(),
				"--project",
				project,
				"--write-tag",
				"inputs",
				"--write-tag",
				"other",
				"--write-tag",
				"results",
			]);
			const keyed = mcpBuiltinLaunchArgs("store", {
				store: { roots: [primary], cache: "c", project, projectId: "proof-shared", writeTags: [] },
			});
			deepStrictEqual(keyed.slice(-4), ["--project", project, "--project-id", "proof-shared"]);
			const named = mcpBuiltinLaunchArgs("store", {
				store: { roots: [{ ...primary, name: "shared" }], cache: "c", project, writeTags: [] },
			});
			deepStrictEqual(named.slice(0, 2), ["--root", `shared=${primary.path}`]);

			const tools = [ToolNames.Gateway, STORE_PUT as ToolName];
			const attestation = resolveWorkerMcpAdmission({ agentId: "coder", projectCwd: project, tools, builtin: shipped });
			ok(attestation);
			const registry = createRegistry({ safety: createWorkerSafety({ cwd: project }), autonomy: () => "yolo" });
			const source = createMcpCapabilitySource({
				cwd: attestation.projectRoot,
				registry,
				persistCatalog: false,
				admitted: attestation,
				builtin: shipped,
				store: { writable: false, grant: { tags: ["results"], dispatchRunId: "run-9" } },
			});
			open.push(source);
			registerCoreTools(registry, { mcpCapabilities: source });
			ok((await source.ensure(STORE_PUT)).spec !== null);
			const ran = await registry.invoke({ tool: STORE_PUT as ToolName, args: { tag: "results", blob: "w.csv" } });
			const workerArgv = argvOf(okOutput(ran));
			deepStrictEqual(workerArgv.slice(-2), ["--write-tag", "results"]);
			strictEqual(workerArgv.filter((arg) => arg === "--write-tag").length, 1);
		});

		it("10. restarts once for a tag created after launch and refuses a missing tag before the call", async () => {
			const main = session({ writable: true }, { builtin: storeBuiltin() });
			okOutput(await invoke(main, STORE_PUT, { tag: "results", blob: "b.csv" }));
			strictEqual(main.launches.length, 1);
			const created = await createStoreTool({ getCwd: () => project, writable: true }).run({ op: "create", tag: "late" });
			strictEqual(created.kind, "ok");
			const argv = argvOf(okOutput(await invoke(main, STORE_PUT, { tag: "late", blob: "b.csv" })));
			ok(argv.includes("late"), argv.join(" "));
			strictEqual(main.launches.length, 2);
			okOutput(await invoke(main, STORE_PUT, { tag: "late", blob: "c.csv" }));
			strictEqual(main.launches.length, 2, "a tag the server was started with needs no restart");

			match(
				failedMessage(await invoke(main, STORE_PUT, { tag: "nosuch", blob: "b.csv" })),
				/tag 'nosuch' does not exist; create it/u,
			);
			strictEqual(main.launches.length, 2, "a missing tag starts nothing again");
		});

		it("does not start without the session's store when a further root is missing", async () => {
			const primary = storeRootSpecs()[0];
			ok(primary);
			const missing = join(env.dir, "gone");
			provideStoreSettings(() => ({
				roots: [primary, { name: "gone", path: missing, durable: true, purge: null }],
				placement: { byTag: {}, byClass: {} },
			}));
			const main = session({ writable: true }, { builtin: storeBuiltin() });
			const ensured = await main.source.ensure(STORE_PUT);
			strictEqual(ensured.spec, null);
			match(String(ensured.reason), /builtin store server cannot start.*store root gone \(.*\) is missing/u);
			deepStrictEqual(main.launches, []);
		});
	});
});
