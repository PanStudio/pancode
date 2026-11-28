// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { deepEqual, equal, ok } from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { scratchPancodeEnvVars } from "../harness/scratch-env.js";

// Parsed SKILL.md frontmatter is cached under the cache root by path, mtime and
// size. A hit must never outlive an edit, a deletion or a PanCode version change.
const home = mkdtempSync(join(tmpdir(), "pancode-skill-fm-cache-"));
Object.assign(process.env, scratchPancodeEnvVars(home), { HOME: home });
const { resetXdgCache, pancodeCacheDir, pancodeCachePath, pancodeConfigDir } = await import("../../src/core/xdg.js");
resetXdgCache();
const { readPancodeVersion } = await import("../../src/core/package-root.js");
const { loadSkills } = await import("../../src/domains/resources/skills/loader.js");
const { withFrontmatterCacheReadOnly } = await import("../../src/domains/agents/frontmatter-cache.js");
after(() => rmSync(home, { recursive: true, force: true }));

const skillFile = join(pancodeConfigDir(), "skills", "probe", "SKILL.md");
const cacheFile = (): string => join(pancodeCacheDir(), "skill-frontmatter.json");
const skillText = (description: string): string => `---\nname: probe\ndescription: ${description}\n---\nBody.\n`;
const description = (): string | undefined =>
	loadSkills({ cwd: home }).items.find((skill) => skill.name === "probe")?.description;

/** Rewrite the file at the same size and restore its mtime, so only the text differs. */
function rewriteInPlace(text: string): void {
	const before = statSync(skillFile);
	writeFileSync(skillFile, text);
	utimesSync(skillFile, before.atime, before.mtime);
	equal(statSync(skillFile).size, before.size);
}

function cacheWith(pancodeVersion: string, json: Record<string, unknown>): void {
	const stat = statSync(skillFile);
	const text = "name: probe\ndescription: Original one.";
	const entries = { [skillFile]: { mtimeMs: stat.mtimeMs, size: stat.size, text, json: JSON.stringify(json) } };
	writeFileSync(cacheFile(), JSON.stringify({ format: 1, pancodeVersion, entries }));
}

describe("skill frontmatter cache", () => {
	it("answers from the cache only while path, mtime, size, text and PanCode version all match", () => {
		mkdirSync(join(pancodeConfigDir(), "skills", "probe"), { recursive: true });
		writeFileSync(skillFile, skillText("Original one."));
		equal(description(), "Original one.");
		ok(existsSync(cacheFile()), "a parse is persisted");

		// A planted entry proves a later process reads the cache instead of parsing.
		cacheWith(readPancodeVersion(), { name: "probe", description: "From cache." });
		equal(description(), "From cache.");
		cacheWith("0.0.0-other", { name: "probe", description: "From cache." });
		equal(description(), "Original one.", "another PanCode version's cache is discarded");

		rewriteInPlace(skillText("Replaced one."));
		equal(description(), "Replaced one.", "an edit at the same size and mtime reparses");

		rmSync(skillFile);
		equal(description(), undefined);
		const persisted = JSON.parse(readFileSync(cacheFile(), "utf8")) as { entries: Record<string, unknown> };
		deepEqual(Object.keys(persisted.entries), [], "a deleted skill's entry is dropped");
	});

	it("reads a damaged cache file or entry as a miss and parses the source", () => {
		mkdirSync(join(pancodeConfigDir(), "skills", "probe"), { recursive: true });
		writeFileSync(skillFile, skillText("Original one."));
		for (const body of [
			"null",
			"[]",
			`{"format":1,"pancodeVersion":${JSON.stringify(readPancodeVersion())},"entries":null}`,
		]) {
			writeFileSync(cacheFile(), body);
			equal(description(), "Original one.", `cache body ${body}`);
		}

		const stat = statSync(skillFile);
		const text = "name: probe\ndescription: Original one.";
		const entries = { [skillFile]: { mtimeMs: stat.mtimeMs, size: stat.size, text, json: "{not json" } };
		writeFileSync(cacheFile(), JSON.stringify({ format: 1, pancodeVersion: readPancodeVersion(), entries }));
		equal(description(), "Original one.", "an entry whose JSON does not parse falls back to the source");
		const persisted = JSON.parse(readFileSync(cacheFile(), "utf8")) as { entries: Record<string, { json: string }> };
		deepEqual(JSON.parse(persisted.entries[skillFile]?.json ?? "null"), { name: "probe", description: "Original one." });
		equal(description(), "Original one.", "the replaced entry answers the next load");
	});

	it("parses a frontmatter with a recursive alias every time instead of caching it", () => {
		mkdirSync(join(pancodeConfigDir(), "skills", "probe"), { recursive: true });
		rmSync(cacheFile(), { force: true });
		writeFileSync(skillFile, "---\nname: probe\ndescription: Cyclic one.\nself: &s\n  again: *s\n---\nBody.\n");
		equal(description(), "Cyclic one.");
		equal(description(), "Cyclic one.");
		const persisted = existsSync(cacheFile())
			? (JSON.parse(readFileSync(cacheFile(), "utf8")) as { entries: Record<string, unknown> }).entries
			: {};
		equal(persisted[skillFile], undefined, "a cyclic parse is never cached");
	});

	it("creates no cache root while a read-only caller such as doctor loads skills", async () => {
		mkdirSync(join(pancodeConfigDir(), "skills", "probe"), { recursive: true });
		writeFileSync(skillFile, skillText("Original one."));
		rmSync(pancodeCachePath(), { recursive: true, force: true });
		resetXdgCache();
		equal(await withFrontmatterCacheReadOnly(async () => description()), "Original one.");
		equal(existsSync(pancodeCachePath()), false, "read-only doctor must not create the cache root or its marker");
	});

	it("serves agent recipe frontmatter from the same cache, so a boot does not reparse every builtin", async () => {
		const { discoverAgentRecipes } = await import("../../src/domains/agents/registry.js");
		const { resolvePackageRoot } = await import("../../src/core/package-root.js");
		const recipe = join(resolvePackageRoot(), "src", "domains", "agents", "builtins", "scout.md");
		const scout = () => discoverAgentRecipes(loadSkills, home).find((candidate) => candidate.id === "scout");
		const parsed = scout();
		ok(parsed);
		const persisted = JSON.parse(readFileSync(cacheFile(), "utf8")) as {
			entries: Record<string, { mtimeMs: number; size: number; text: string; json: string }>;
		};
		const entry = persisted.entries[recipe];
		ok(entry, "discovery persists each recipe's parse");
		const frontmatter = JSON.parse(entry.json) as Record<string, unknown>;
		persisted.entries[recipe] = { ...entry, json: JSON.stringify({ ...frontmatter, description: "From cache." }) };
		writeFileSync(cacheFile(), JSON.stringify(persisted));
		equal(scout()?.description, "From cache.", "a later discovery answers from the cache");
	});
});
