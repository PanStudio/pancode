// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { ToolNames } from "../../src/core/tool-names.js";
import { createMcpStdioClient } from "../../src/domains/gateway/mcp/index.js";
import type { AutonomyLevel } from "../../src/domains/safety/autonomy.js";
import { createWorkerSafety } from "../../src/engine/worker-tools.js";
import { registerCoreTools } from "../../src/tools/core-bootstrap.js";
import { createMcpCapabilitySource, type McpCapabilitySource } from "../../src/tools/gateway/index.js";
import { createRegistry } from "../../src/tools/registry.js";
import type { ToolRegistry } from "../../src/tools/registry-contract.js";
import { type IsolatedPancodeEnv, isolatePancodeEnv } from "../harness/scratch-env.js";

/**
 * Slurm reaches PanCode through a Slurm MCP server and the existing stdio
 * gateway. A fixture server speaks five Slurm tool names; no scheduler runs. Read capabilities poll without approval; allocation changes always ask.
 */

const FIXTURE = resolve("tests/fixtures/mcp-slurm-server.mjs");
const TOOLS = ["slurm_cancel", "slurm_cluster", "slurm_describe", "slurm_list", "slurm_submit"];

describe("Slurm through an MCP server", () => {
	let env: IsolatedPancodeEnv;
	let root: string;
	let project: string;
	let configDir: string;
	let journal: string;
	const open: McpCapabilitySource[] = [];

	beforeEach(async () => {
		env = await isolatePancodeEnv("slurm-mcp-");
		root = realpathSync(mkdtempSync(join(tmpdir(), "pancode-slurm-mcp-")));
		project = join(root, "project");
		configDir = join(root, "config");
		journal = join(root, "journal.txt");
		mkdirSync(project, { recursive: true });
		mkdirSync(configDir, { recursive: true });
	});

	afterEach(async () => {
		for (const source of open.splice(0)) await source.close();
		rmSync(root, { recursive: true, force: true });
		env.restore();
	});

	function declare(command: string, args: string[]): void {
		writeFileSync(
			join(configDir, "mcp.yaml"),
			[
				"version: 1",
				"servers:",
				"  - id: slurm",
				`    command: ${JSON.stringify(command)}`,
				`    args: ${JSON.stringify(args)}`,
				"",
			].join("\n"),
		);
	}

	function wire(level: AutonomyLevel, approve: boolean): { registry: ToolRegistry; parks: string[] } {
		const parks: string[] = [];
		const registry = createRegistry({ safety: createWorkerSafety({ cwd: project }), autonomy: () => level });
		const source = createMcpCapabilitySource({
			cwd: project,
			configDir,
			registry,
			requestTimeoutMs: 5_000,
			// A user-scope server: an attended session records its surface on first sight.
			attended: true,
			clientFactory: (spec, options) =>
				createMcpStdioClient(spec, { ...options, initializeTimeoutMs: 5_000, killGraceMs: 200 }),
		});
		open.push(source);
		registerCoreTools(registry, { mcpCapabilities: source });
		registry.onPermissionRequired((call, decision, meta) => {
			parks.push(call.tool);
			if (approve) {
				void registry.resumeParkedCalls({
					actionClass: decision.classification.actionClass,
					requestId: meta.requestId,
					requestedBy: "contract-operator",
				});
			} else registry.cancelParkedCall(meta.requestId, "denied by the test");
		});
		return { registry, parks };
	}

	function call(registry: ToolRegistry, tool: string, args: Record<string, unknown>) {
		return registry.invoke({ tool: ToolNames.Gateway, args: { op: "call", capability: `mcp_slurm__${tool}`, args } });
	}

	it("lists the five Slurm tools with their per-tool action classes", async () => {
		declare(process.execPath, [FIXTURE, journal]);
		const { registry } = wire("default", false);
		// Nothing has recorded this server's tools yet, and an ordinary find no
		// longer launches a server to fill that gap. The scoped refresh is the
		// call that does.
		const found = await registry.invoke({
			tool: ToolNames.Gateway,
			args: { op: "find", server: "slurm", refresh: true },
		});
		if (found.kind !== "ok" || found.result.kind !== "ok") throw new Error(JSON.stringify(found));
		const listing = JSON.parse(found.result.output) as { capabilities: Array<{ name: string; actionClass: string }> };
		const slurm = listing.capabilities.filter((entry) => entry.name.startsWith("mcp_slurm__"));
		deepStrictEqual(
			slurm.map((entry) => entry.name).sort(),
			TOOLS.map((tool) => `mcp_slurm__${tool}`),
		);
		deepStrictEqual(slurm.map((entry) => entry.actionClass).sort(), ["execute", "execute", "read", "read", "read"]);
	});

	it("asks before a submission and a cancellation at the default autonomy, and a denied one never reaches the server", async () => {
		declare(process.execPath, [FIXTURE, journal]);
		const { registry, parks } = wire("default", false);
		strictEqual((await call(registry, "slurm_submit", { script_path: "run.sh" })).kind, "blocked");
		strictEqual((await call(registry, "slurm_cancel", { job_id: "4821", confirm_job_id: "4821" })).kind, "blocked");
		deepStrictEqual(parks, ["mcp_slurm__slurm_submit", "mcp_slurm__slurm_cancel"]);
		strictEqual(existsSync(journal), false, "neither call reached the server");
	});

	it("confirms allocation changes in yolo while admitting reads", async () => {
		declare(process.execPath, [FIXTURE, journal]);
		const { registry, parks } = wire("yolo", true);
		const submitted = await call(registry, "slurm_submit", { script_path: "run.sh", partition: "debug" });
		if (submitted.kind !== "ok" || submitted.result.kind !== "ok") throw new Error(JSON.stringify(submitted));
		strictEqual(
			(JSON.parse(submitted.result.output.slice(submitted.result.output.indexOf("\n") + 1)) as { job_id: string }).job_id,
			"4821",
		);
		const described = await call(registry, "slurm_describe", { job_id: "4821" });
		if (described.kind !== "ok" || described.result.kind !== "ok") throw new Error(JSON.stringify(described));
		strictEqual((JSON.parse(described.result.output) as { terminal: boolean }).terminal, true);
		strictEqual((await call(registry, "slurm_cancel", { job_id: "4821", confirm_job_id: "4821" })).kind, "ok");
		deepStrictEqual(parks, ["mcp_slurm__slurm_submit", "mcp_slurm__slurm_cancel"]);
		strictEqual(readFileSync(journal, "utf8"), "submit run.sh\ncancel 4821\n");
	});
});
