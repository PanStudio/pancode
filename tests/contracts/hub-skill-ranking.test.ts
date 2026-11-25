// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
	capabilityWorthNaming,
	createCapabilityGate,
	skillWorthOffering,
} from "../../src/domains/middleware/capability-gate.js";
import { loadSkills } from "../../src/domains/resources/skills/loader.js";

const packs = join(import.meta.dirname, "..", "..", "hub", "packs");

function skillDirs(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		if (!entry.isDirectory() || entry.name.startsWith("_") || entry.name.startsWith(".")) return [];
		const child = join(dir, entry.name);
		return readdirSync(child).includes("SKILL.md") ? [child] : skillDirs(child);
	});
}

/** The reminder's ranking over every skill PanHub ships, as the session ranks its ready skills. */
function rankHubSkills(task: string, installed?: string) {
	const hub = loadSkills({ disableDiscovery: true, explicitSkillPaths: skillDirs(packs) }).items;
	ok(hub.length > 30, `loaded ${hub.length} hub skills`);
	const skills = installed === undefined ? hub : hub.filter((skill) => skill.name === installed);
	return createCapabilityGate().rank({
		kind: "skills",
		task,
		candidates: skills.map((skill) => ({
			id: skill.name,
			description: skill.description,
			triggers: Array.isArray(skill.metadata.triggers)
				? skill.metadata.triggers.filter((value): value is string => typeof value === "string")
				: [],
		})),
	});
}

describe("PanHub skill ranking", () => {
	it("offers science-data first for a question about simulation output", () => {
		const task = "What variables are in the simulation output?";
		const [top] = rankHubSkills(task);
		strictEqual(top?.id, "science-data", JSON.stringify(top));
		ok(capabilityWorthNaming(top, task), `coverage ${top.coverage}`);
	});

	it("offers tdd for a test-first request, not for an edit that only mentions tests (R2-F11)", () => {
		const offered = (task: string, installed?: string) =>
			rankHubSkills(task, installed)
				.filter((match) => skillWorthOffering(match, task))
				.map((match) => match.id);
		const edit =
			"Add a --headers boolean flag to parseArgs/runCli or bin/rate-bucket.js so that when --headers is passed, each JSON result object includes a headers property from formatHeaders(result) in src/headers.js. Add unit and subprocess tests in tests/bin.test.js and verify with npm test.";
		// Installed alone, tdd tops the lexical rank on the shared word "test" at full coverage, which is what offered it.
		strictEqual(rankHubSkills(edit, "tdd")[0]?.coverage, 1);
		strictEqual(offered(edit, "tdd").length, 0);
		strictEqual(offered("Build this test-first: add a TokenBucketLimiter class", "tdd")[0], "tdd");
		for (const task of [
			"Build this test-first: add a TokenBucketLimiter class",
			"Write the test first for parseArgs, then implement --verbose",
			"Use tdd to add a --json flag",
		])
			strictEqual(offered(task)[0], "tdd", task);
	});

	it("offers no hub skill for an ordinary edit or review, and each domain skill on its own request", () => {
		const offered = (task: string) =>
			rankHubSkills(task)
				.filter((match) => skillWorthOffering(match, task))
				.map((match) => match.id);
		// Before the hpc, life-science and literature skills declared triggers, these offered hpc-darshan,
		// hpc-parallel-io with hpc-modules, and pubchem-compounds on one shared word each.
		for (const task of [
			"Fix the failing test in src/parser.ts and run npm test",
			"Refactor the module loader to read config from a file",
			"Review this pull request for bugs",
		])
			deepStrictEqual(offered(task), [], task);
		for (const [task, skill] of [
			["Analyze this Darshan log and tell me the I/O bottleneck", "hpc-darshan"],
			["Tune the Lustre stripe count for my parallel writes", "hpc-parallel-io"],
			["What is the molecular weight of caffeine?", "pubchem-compounds"],
			["Check the citations in my paper draft are real", "citation-check"],
		] as const)
			strictEqual(offered(task)[0], skill, task);
	});
});
