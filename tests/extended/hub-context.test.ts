// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { ok, strictEqual } from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { configureGuardrails } from "../../src/core/guardrails.js";
import { installPlugin, listInstalledPlugins, pluginContentDigest } from "../../src/domains/plugins/index.js";
import { readHubInventory } from "../../src/domains/resources/hub-inventory.js";
import { createContextTool } from "../../src/tools/context/index.js";
import { createPancodeHubTool } from "../../src/tools/gateway/pancode-context-tools.js";
import type { ToolInvokeOptions } from "../../src/tools/registry-contract.js";
import { trustProjectPackages } from "../harness/project-trust.js";

/**
 * pancode_hub, the gateway capability that took over context(scope="library"),
 * is a bounded, body-free READ over the shared inventory. These contracts hold
 * it to that: real sample-kit identities, honest ownership and origin, stable
 * pages, budget reserved before any discovery, no mutation, no source fetch,
 * no internal agents, and no PanHub at all for a native worker. The last
 * contract pins the context tool's own refusal of the moved scope.
 */

const kitSource = fileURLToPath(new URL("../fixtures/plugins/sample-kit/", import.meta.url));
const kitDigest = pluginContentDigest(kitSource);
const hpcSource = fileURLToPath(new URL("../../hub/packs/plugins/hpc/", import.meta.url));
const roots: string[] = [];

function scratch(): string {
	const directory = mkdtempSync(path.join(tmpdir(), "pancode-hub-context-"));
	roots.push(directory);
	return directory;
}

function withPlugin(source: string, id: string, expectedDigest?: string): string {
	const project = scratch();
	const result = installPlugin(source, {
		cwd: project,
		scope: "project",
		...(expectedDigest ? { expectedDigest } : {}),
		expectedId: id,
	});
	trustProjectPackages(project, "plugins");
	ok(listInstalledPlugins(project).find((entry) => entry.id === id)?.loadable, JSON.stringify(result.diagnostics));
	return project;
}

function withSampleKit(): string {
	return withPlugin(kitSource, "sample-kit", kitDigest);
}

interface HubRow {
	row: "resource" | "hint" | "package";
	kind: string;
	name: string;
	key?: string;
	owner?: string;
	ref?: string;
	scope?: string;
	origin: { kind: string } & Record<string, unknown>;
	invocation?: string;
	installed?: Array<{ scope: string; state: string }>;
	ownerInstalled?: Array<{ scope: string; state: string }>;
	member?: string;
	provides?: string[] | string;
	availability?: string;
}

interface HubPayload {
	scope: string;
	total: number;
	shown: number;
	offset: number;
	nextOffset?: number;
	rows: HubRow[];
	note: string;
	diagnostics?: string[];
}

function hubTool(cwd: string, deps: Record<string, unknown> = {}) {
	return createPancodeHubTool({ getCwd: () => cwd, ...deps });
}

async function read(
	cwd: string,
	args: Record<string, unknown> = {},
	options: ToolInvokeOptions = {},
): Promise<HubPayload> {
	const result = await hubTool(cwd).run({ ...args }, options);
	strictEqual(result.kind, "ok", result.kind === "error" ? result.message : "expected an ok read");
	if (result.kind !== "ok") throw new Error("unreachable");
	const payload = JSON.parse(result.output) as HubPayload;
	ok(Array.isArray(payload.rows), `expected a row page, got ${result.output.slice(0, 400)}`);
	return payload;
}

/** Walk every page the way a caller following nextOffset would. */
async function collect(cwd: string, args: Record<string, unknown> = {}): Promise<HubRow[]> {
	const rows: HubRow[] = [];
	let offset = 0;
	for (;;) {
		const page = await read(cwd, { ...args, limit: 50, offset });
		rows.push(...page.rows);
		if (page.nextOffset === undefined) break;
		offset = page.nextOffset;
		ok(rows.length <= page.total, "pages returned more rows than the reported total");
	}
	return rows;
}

function ownedBy(rows: ReadonlyArray<HubRow>, owner: string, kind: string): HubRow[] {
	return rows.filter((row) => row.row === "resource" && row.owner === owner && row.kind === kind);
}

function listTree(root: string): string[] {
	try {
		return readdirSync(root, { recursive: true, encoding: "utf8" }).sort();
	} catch {
		return [];
	}
}

describe("pancode_hub (the former context library scope)", () => {
	afterEach(() => {
		configureGuardrails(undefined);
		for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	});

	it("projects every sample-kit recipe with its actual runtime name, owner and invocation", async () => {
		const project = withSampleKit();
		const rows = await collect(project);

		const skills = ownedBy(rows, "plugin:sample-kit", "skill");
		const agents = ownedBy(rows, "plugin:sample-kit", "agent");
		const prompts = ownedBy(rows, "plugin:sample-kit", "prompt");
		const fleets = ownedBy(rows, "plugin:sample-kit", "playbook");
		strictEqual(skills.length, 1, skills.map((row) => row.name).join(", "));
		strictEqual(agents.length, 3, agents.map((row) => row.name).join(", "));
		strictEqual(prompts.length, 1, prompts.map((row) => row.name).join(", "));
		strictEqual(fleets.length, 1, fleets.map((row) => row.name).join(", "));

		// Runtime names: the skill's frontmatter name and the agent's recipe file id.
		ok(
			skills.some((row) => row.name === "sample-kit-method"),
			"skill rows must carry the loader's frontmatter name",
		);
		ok(
			agents.some((row) => row.name === "sample-kit-reviewer"),
			"agent rows must carry the recipe file id",
		);
		ok(
			prompts.every((row) => row.name.startsWith("sample-kit:")),
			"prompt rows must carry the colon path name",
		);
		strictEqual(fleets[0]?.name, "sample-kit-build-review");
		for (const row of [...skills, ...agents, ...prompts, ...fleets]) {
			ok(row.invocation, `${row.kind}:${row.name} is listed as usable and must say how it is invoked`);
			strictEqual(row.scope, "package");
		}
		ok(
			skills.every((row) => row.invocation?.startsWith("/skill ")),
			"a skill's invocation is the operator's /skill route",
		);
	});

	it("carries origin evidence separately from scope and format", async () => {
		const project = withSampleKit();
		const rows = await collect(project, { kind: "skill" });
		const kit = ownedBy(rows, "plugin:sample-kit", "skill")[0];
		ok(kit, "sample-kit must contribute skill rows");
		ok(kit.origin, "every row must carry origin evidence");
		ok(
			["bundled", "local", "remote", "imported", "core", "unknown"].includes(kit.origin.kind),
			`unexpected origin class ${kit.origin.kind}`,
		);
		// Origin, scope and owner are three separate facts and none of them may
		// be inferred from another.
		strictEqual(kit.scope, "package");
		strictEqual(kit.owner, "plugin:sample-kit");
	});

	it("finds the owning bundle by a recipe kind before it is installed, without fetching it", async () => {
		const project = scratch();
		const fetched: string[] = [];
		const realFetch = globalThis.fetch;
		globalThis.fetch = ((input: unknown) => {
			fetched.push(String(input));
			throw new Error("a PanHub read must never fetch a pack source");
		}) as typeof globalThis.fetch;
		try {
			const rows = await collect(project, { kind: "skill" });
			const hpc = rows.find((row) => row.row === "package" && row.ref === "plugin:hpc");
			ok(hpc, "a skill-kind query must surface the package that provides skills");
			strictEqual(hpc.installed?.length, 0, "the package is not installed in this workspace");
			ok(Array.isArray(hpc.provides), "a curated package must publish bounded provides hints");
			ok(
				(hpc.provides as string[]).some((hint) => hint.startsWith("skill:")),
				"the hint list must name the skills that matched the query",
			);

			const hints = rows.filter((row) => row.row === "hint" && row.owner === "plugin:hpc");
			ok(hints.length > 0, "the member-level catalog hints must be listed as their own rows");
			for (const hint of hints) {
				strictEqual(hint.kind, "skill");
				strictEqual(hint.member, "not-installed", "an uninstalled owner makes its members uninstalled");
				strictEqual(hint.ownerInstalled?.length, 0);
				strictEqual(hint.invocation, undefined, "a catalog hint has nothing to invoke");
			}
		} finally {
			globalThis.fetch = realFetch;
		}
		strictEqual(fetched.length, 0, `PanHub read fetched ${fetched.join(", ")}`);
	});

	it("drops a hint once its real resource is on the page and never claims an unknown member is uninstalled", async () => {
		const project = withPlugin(hpcSource, "hpc");
		const rows = await collect(project, { kind: "skill" });
		const actual = ownedBy(rows, "plugin:hpc", "skill").map((row) => row.name);
		ok(actual.length > 0, "the installed copy must contribute real skill rows");
		const hints = rows.filter((row) => row.row === "hint" && row.owner === "plugin:hpc");
		for (const hint of hints) {
			ok(!actual.includes(hint.name), `hint ${hint.name} duplicates a loaded resource`);
			// The owner is installed here, so a member this read did not see is
			// unknown, never "not-installed".
			strictEqual(hint.member, "unknown");
			ok(
				hint.ownerInstalled?.some((copy) => copy.scope === "project"),
				"an installed owner must report its real copy state on the hint",
			);
		}
	});

	it("separates installable package rows from usable recipe rows", async () => {
		const project = withSampleKit();
		const packages = await collect(project, { kind: "plugin" });
		ok(packages.length > 0, "the bundled catalog must produce package rows");
		ok(
			packages.every((row) => row.row === "package"),
			"kind=plugin is the package view and must not mix in recipes",
		);
		const kit = packages.find((row) => row.ref === "plugin:sample-kit");
		ok(kit, "sample-kit must appear as an install target");
		const installedCopy = kit.installed?.find((copy) => copy.scope === "project");
		ok(installedCopy, "the installed project copy must be reported on the package row");
		// The declared HubCopyState vocabulary. `loadable` is a package-root
		// gate, not proof that any particular member was admitted, which is why a
		// hint row still reports its member state separately.
		ok(
			["loadable", "disabled", "shadowed", "invalid", "incompatible", "damaged"].includes(installedCopy.state),
			`copy state "${installedCopy.state}" is outside HubCopyState`,
		);
		strictEqual(installedCopy.state, "loadable");

		const recipes = await collect(project, { kind: "playbook" });
		ok(
			recipes.some((row) => row.row === "resource" && row.kind === "playbook"),
			"a recipe-kind query must return the actual fleet resources",
		);
	});

	it("selects one record by ref and reports an honest empty match", async () => {
		const project = withSampleKit();
		const exact = await read(project, { ref: "plugin:sample-kit", kind: "plugin" });
		strictEqual(exact.rows.length, 1);
		strictEqual(exact.rows[0]?.ref, "plugin:sample-kit");

		const missing = await read(project, { ref: "plugin:no-such-package" });
		strictEqual(missing.total, 0);
		strictEqual(missing.rows.length, 0);
		ok(missing.note.includes("Nothing matched"), missing.note);
	});

	it("selects an exact resource key without dragging in its owner's other members", async () => {
		const project = withSampleKit();
		const inventory = readHubInventory({
			cwd: project,
			audience: "model",
			kinds: ["agent"],
			include: { packages: false, copies: false, resources: true },
		});
		const target = inventory.resources.find((resource) => resource.owner?.ref === "plugin:sample-kit");
		ok(target, "sample-kit must contribute an agent resource to key against");
		const payload = await read(project, { ref: target.key });
		const resources = payload.rows.filter((row) => row.row === "resource");
		strictEqual(resources.length, 1, JSON.stringify(payload.rows.map((row) => `${row.row}:${row.name}`)));
		strictEqual(resources[0]?.name, target.name);
		strictEqual(
			payload.rows.filter((row) => row.row === "hint").length,
			0,
			"an exact resource key must not expand its owner's catalog hints",
		);
	});

	it("reports an ambiguous bare name as several keyed records", async () => {
		const project = withSampleKit();
		// A project agent under the sample-kit skill's runtime name is exactly the case a
		// bare ref cannot resolve on its own.
		const agents = path.join(project, ".pancode", "agents");
		mkdirSync(agents, { recursive: true });
		writeFileSync(
			path.join(agents, "sample-kit-method.md"),
			readFileSync(path.join(kitSource, "dev.pancode/agents/sample-kit-reviewer.md"), "utf8"),
		);
		const payload = await read(project, { ref: "sample-kit-method" });
		const resources = payload.rows.filter((row) => row.row === "resource");
		ok(resources.length > 1, JSON.stringify(resources.map((row) => `${row.kind}:${row.name}`)));
		strictEqual(new Set(resources.map((row) => row.kind)).size, resources.length, "each match is a distinct kind");
		ok(payload.note.includes("matched several records"), payload.note);
	});

	it("keeps a page inside a nearly spent reservation instead of returning a stub", async () => {
		const project = withSampleKit();
		configureGuardrails({ observationTurnBudgetBytes: 1500 });
		const result = await hubTool(project).run({ limit: 50 }, { sessionId: "hub-context", turnId: "tiny" });
		strictEqual(result.kind, "ok");
		if (result.kind !== "ok") throw new Error("unreachable");
		const payload = JSON.parse(result.output) as HubPayload;
		ok(Array.isArray(payload.rows), `expected a row page, got ${result.output.slice(0, 300)}`);
		ok(payload.rows.length <= 2, `a 1.5KB turn pool must not carry a full page, got ${payload.rows.length}`);
		if (payload.rows.length === 0) {
			strictEqual(payload.nextOffset, undefined, "an empty page must not offer the offset it was given");
			ok(payload.note.includes("observation budget"), payload.note);
		} else {
			ok(payload.nextOffset === undefined || payload.nextOffset > payload.offset, "the offset must advance");
		}
	});

	it("pages a stable total order without repeating or skipping a row", async () => {
		const project = withSampleKit();
		const whole = await read(project, { limit: 50, offset: 0 });
		const first = await read(project, { limit: 3, offset: 0 });
		const second = await read(project, { limit: 3, offset: 3 });
		strictEqual(first.rows.length, 3);
		strictEqual(first.nextOffset, 3);
		strictEqual(second.offset, 3);
		const paged = [...first.rows, ...second.rows].map((row) => `${row.kind}:${row.name}`);
		const direct = whole.rows.slice(0, 6).map((row) => `${row.kind}:${row.name}`);
		strictEqual(paged.join("|"), direct.join("|"));
		strictEqual(new Set(paged).size, paged.length, "a page boundary repeated a row");
		strictEqual(first.total, second.total, "the total must not move between pages");
	});

	it("clamps the page size and never returns an unbounded listing", async () => {
		const project = withSampleKit();
		const huge = await read(project, { limit: 5000 });
		ok(huge.rows.length <= 50, `expected the page cap to hold, got ${huge.rows.length}`);
		const negative = await read(project, { limit: -4, offset: -9 });
		strictEqual(negative.offset, 0);
		ok(negative.rows.length >= 1);
	});

	it("spends the observation budget before it walks the inventory", async () => {
		const project = withSampleKit();
		configureGuardrails({ observationTurnBudgetBytes: 1024 });
		const options: ToolInvokeOptions = { sessionId: "hub-context", turnId: "turn-1" };
		const first = await hubTool(project).run({ limit: 5 }, options);
		strictEqual(first.kind, "ok");

		// The second call must short-circuit on the exhausted pool. A cwd getter
		// that throws proves the handler was never reached: if discovery ran, the
		// result would be the inventory error instead of the budget notice.
		const guarded = createPancodeHubTool({
			getCwd: () => {
				throw new Error("inventory reached despite an exhausted observation pool");
			},
		});
		const second = await guarded.run({}, options);
		strictEqual(second.kind, "ok");
		if (second.kind !== "ok") throw new Error("unreachable");
		ok(!second.output.includes("inventory reached"), second.output);
		ok(/budget/i.test(second.output), second.output);
	});

	it("returns no instruction bodies and writes nothing", async () => {
		const project = withSampleKit();
		const before = listTree(path.join(project, ".pancode"));
		const rows = await collect(project);
		const rendered = JSON.stringify(rows);
		// A phrase from the sample-kit skill body. Descriptions are metadata; bodies
		// are not, and this projection must never carry one.
		ok(!rendered.includes("A written argument is not a machine-checked proof"), "a PanHub row leaked a skill body");
		ok(!rendered.includes("${component:"), "a PanHub row leaked an unresolved pack reference");
		const after = listTree(path.join(project, ".pancode"));
		strictEqual(after.join("|"), before.join("|"), "a read-only scope changed installed state");
	});

	it("hides internal and shadow agents from the model projection", async () => {
		const project = withSampleKit();
		const rows = await collect(project, { kind: "agent" });
		const names = new Set(rows.filter((row) => row.row === "resource").map((row) => row.name));
		for (const internal of ["scout", "provenance", "researcher", "world-knowledge"]) {
			ok(!names.has(internal), `internal agent ${internal} must stay out of the model's PanHub view`);
		}
		const inventory = readHubInventory({ cwd: project, audience: "operator", all: true, kinds: ["agent"] });
		ok(
			inventory.resources.some((resource) => resource.audience === "shadow" || resource.audience === "internal"),
			"the operator inventory must still carry the internal recipes this projection hides",
		);
	});

	it("refuses the read in a native worker registry", async () => {
		const project = withSampleKit();
		const worker = createPancodeHubTool({ getCwd: () => project, skillMarketplace: false });
		const result = await worker.run({}, {});
		strictEqual(result.kind, "error");
		if (result.kind !== "error") throw new Error("unreachable");
		ok(result.message.includes("unavailable"), result.message);
		ok(!result.message.includes("plugin:sample-kit"), "the refusal must not leak PanHub it refuses");
	});

	it("omits skill rows when the run has skill discovery switched off", async () => {
		const project = withSampleKit();
		const rows = await collect(project);
		ok(ownedBy(rows, "plugin:sample-kit", "skill").length > 0, "the ordinary run lists skills");
		const quiet = createPancodeHubTool({
			getCwd: () => project,
			getSkillLoaderOptions: () => ({ disableDiscovery: true, trustProjectCompatRoots: false }),
		});
		const result = await quiet.run({ limit: 50 }, {});
		strictEqual(result.kind, "ok");
		if (result.kind !== "ok") throw new Error("unreachable");
		const payload = JSON.parse(result.output) as HubPayload;
		ok(
			payload.rows.every((row) => !(row.row === "resource" && row.kind === "skill")),
			"a --no-skills run must not advertise skills it cannot load",
		);
		ok(payload.note.includes("Skill discovery is off"), payload.note);
	});

	it("agrees with the shared inventory the CLI reads", async () => {
		const project = withSampleKit();
		const rows = await collect(project, { kind: "prompt" });
		const inventory = readHubInventory({
			cwd: project,
			audience: "model",
			kinds: ["prompt"],
			include: { packages: false, copies: false, resources: true },
		});
		const projected = rows
			.filter((row) => row.row === "resource")
			.map((row) => `${row.kind}:${row.name}:${row.owner}:${row.invocation ?? ""}`)
			.sort();
		const direct = inventory.resources
			.map(
				(resource) =>
					`${resource.kind}:${resource.name}:${resource.owner ? resource.owner.ref : resource.source.class}:${resource.invocation ?? ""}`,
			)
			.sort();
		strictEqual(projected.join("|"), direct.join("|"));
	});

	it("leaves the remaining context scopes intact", async () => {
		const project = withSampleKit();
		const context = createContextTool({ getCwd: () => project });
		const unknown = await context.run({ scope: "packages" }, {});
		strictEqual(unknown.kind, "error");
		if (unknown.kind !== "error") throw new Error("unreachable");
		ok(unknown.message.includes("workspace, settings, skills, recall, budget, or semantic"), unknown.message);

		const skills = await context.run({ scope: "skills" }, {});
		strictEqual(skills.kind, "ok");
		if (skills.kind !== "ok") throw new Error("unreachable");
		ok(skills.output.includes("Available skills."), skills.output.slice(0, 200));
	});
});
