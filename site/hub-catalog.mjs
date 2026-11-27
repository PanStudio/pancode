#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
// Derives site/content/hub-catalog.json from the bundled hub/index.yaml, through the same row validator PanCode
// applies to that file. --check re-derives it and fails on any byte difference. Any refusal prints one line.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire, register } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const site = dirname(fileURLToPath(import.meta.url));
const root = resolve(site, "..");
export const defaultIndex = join(root, "hub", "index.yaml");
export const defaultCatalog = join(site, "content", "hub-catalog.json");

class Refusal extends Error {}

// Unresolved bare specifiers retry from the main worktree, so a detached checkout borrows its node_modules.
const fallbackHook = `let parentURL;
export function initialize(data) { parentURL = data.parentURL; }
export async function resolve(specifier, context, next) {
	try {
		return await next(specifier, context);
	} catch (error) {
		if (error?.code !== "ERR_MODULE_NOT_FOUND" || /^(?:[./]|[a-z][a-z0-9+.-]*:)/i.test(specifier)) throw error;
		return next(specifier, { ...context, parentURL });
	}
}`;

function dependencies() {
	const local = createRequire(join(root, "package.json"));
	try {
		local.resolve("tsx/esm/api");
		return local;
	} catch {}
	// The release builds and checks the site in a detached `git worktree` that has no node_modules of its own;
	// the main worktree it was added from has them.
	let main;
	try {
		const common = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
			cwd: root,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
		main = dirname(common);
	} catch {}
	if (main && main !== root && existsSync(join(main, "package.json"))) {
		const borrowed = createRequire(join(main, "package.json"));
		try {
			borrowed.resolve("tsx/esm/api");
			register(`data:text/javascript,${encodeURIComponent(fallbackHook)}`, {
				data: { parentURL: pathToFileURL(join(main, "package.json")).href },
			});
			return borrowed;
		} catch {}
	}
	throw new Refusal("dependencies are not installed: run corepack pnpm install --frozen-lockfile");
}

async function validator() {
	const require = dependencies();
	const { tsImport } = await import(pathToFileURL(require.resolve("tsx/esm/api")).href);
	const { parse } = await import(pathToFileURL(require.resolve("yaml")).href);
	const options = { parentURL: import.meta.url, tsconfig: join(root, "tsconfig.json") };
	const catalog = await tsImport(join(root, "src", "domains", "plugins", "catalog.ts"), options);
	const revocations = await tsImport(join(root, "src", "core", "hub-revocations.ts"), options);
	return { parse, parseHubIndexRows: catalog.parseHubIndexRows, parseHubRevocations: revocations.parseHubRevocations };
}

function rowSource(item) {
	if (item.source && typeof item.source === "object") {
		const { repo, commit, subdir } = item.source;
		return { repository: repo, commit, ...(subdir ? { path: subdir } : {}) };
	}
	return { path: `hub/${item.sourceUrl}` };
}

/** The catalog JSON text for one index file; throws a Refusal naming the first problem. */
export async function deriveCatalog(indexFile = defaultIndex) {
	const { parse, parseHubIndexRows, parseHubRevocations } = await validator();
	const bytes = readFileSync(indexFile);
	let parsed;
	try {
		parsed = parse(bytes.toString("utf8"));
	} catch (error) {
		throw new Refusal(`hub/index.yaml is not valid YAML: ${error.message.split("\n")[0]}`);
	}
	const entries = Array.isArray(parsed?.entries) ? parsed.entries : undefined;
	if (!entries) throw new Refusal("hub/index.yaml has no entries list");
	const diagnostics = [];
	let rows;
	try {
		rows = parseHubIndexRows(parsed, indexFile, diagnostics, { mode: "bundled", packsRoot: dirname(indexFile) });
	} catch (error) {
		throw new Refusal(error.message);
	}
	if (diagnostics.length > 0) throw new Refusal(diagnostics[0]);
	if (rows.length !== entries.length) throw new Refusal("the row validator dropped a row without naming it");
	const revoked = new Set(parseHubRevocations(parsed.revoked).map((item) => item.sha256));
	const kept = entries
		.filter((item) => !revoked.has(item.sha256))
		.map((item) => ({
			kind: item.kind,
			name: item.name,
			publisher: item.publisher,
			version: item.version,
			description: String(item.description).replace(/\s+/g, " ").trim(),
			category: item.category ?? null,
			tier: item.tier,
			licence: item.license ?? null,
			source: rowSource(item),
			sha256: item.sha256,
			install: `pancode hub install ${item.kind}:${item.name}`,
		}))
		.sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
	const catalog = {
		source: {
			path: "hub/index.yaml",
			sha256: createHash("sha256").update(bytes).digest("hex"),
			rows: entries.length,
			revoked: entries.length - kept.length,
		},
		rows: kept,
	};
	return `${JSON.stringify(catalog, null, "\t")}\n`;
}

async function main() {
	const { values } = parseArgs({
		options: {
			check: { type: "boolean", default: false },
			index: { type: "string" },
			catalog: { type: "string" },
		},
	});
	const indexFile = resolve(values.index ?? defaultIndex);
	const catalogFile = resolve(values.catalog ?? defaultCatalog);
	const text = await deriveCatalog(indexFile);
	if (values.check) {
		const committed = existsSync(catalogFile) ? readFileSync(catalogFile, "utf8") : "";
		if (committed !== text)
			throw new Refusal("site/content/hub-catalog.json differs from hub/index.yaml: run node site/hub-catalog.mjs");
		process.stdout.write(`hub-catalog: ${JSON.parse(text).rows.length} rows match hub/index.yaml\n`);
		return;
	}
	writeFileSync(catalogFile, text);
	process.stdout.write(`hub-catalog: wrote ${JSON.parse(text).rows.length} rows\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main().catch((error) => {
		process.stderr.write(`hub-catalog: refused: ${error instanceof Refusal ? error.message : error.stack}\n`);
		process.exit(1);
	});
}
