#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
// `pnpm run doctor:dev` (or `node scripts/doctor-dev.mjs` before pnpm exists): checks
// that this machine can build and test the checkout and names each missing tool with
// the step that provides it. Uses only Node built-ins, so it runs before
// `pnpm install`. Exit 1 when something required is missing.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

/** The Node majors the `ci (22)` and `ci (24)` jobs test. */
const QUALIFIED_MAJORS = ["22", "24"];

const root = resolve(import.meta.dirname, "..");
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const shell = process.platform === "win32";

function run(command, args = ["--version"]) {
	const probe = spawnSync(command, args, { cwd: root, encoding: "utf8", shell });
	if (probe.error !== undefined || probe.status !== 0) return null;
	return probe.stdout.trim();
}

const parse = (version) => version.replace(/^v/u, "").split(".").map(Number);
function atLeast(version, minimum) {
	const [a, b] = [parse(version), parse(minimum)];
	for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
	return true;
}

const rows = [];
const required = (ok, name, detail) => rows.push({ level: ok ? "ok" : "missing", name, detail });
const optional = (ok, name, detail) => rows.push({ level: ok ? "ok" : "optional", name, detail });

const minimumNode = manifest.engines.node.replace(/^>=/u, "");
const nodeMajor = process.versions.node.split(".")[0];
required(
	atLeast(process.version, minimumNode),
	"node",
	atLeast(process.version, minimumNode)
		? `${process.version}${QUALIFIED_MAJORS.includes(nodeMajor) ? "" : `; CI tests Node ${QUALIFIED_MAJORS.join(" and ")}`}`
		: `${process.version} is older than ${minimumNode}; install Node ${minimumNode} or later (\`nvm install\` reads .nvmrc)`,
);

const pinnedPnpm = manifest.packageManager.replace(/^pnpm@/u, "");
const pnpm = run("pnpm");
const corepack = run("corepack");
if (pnpm !== null)
	required(true, "pnpm", pnpm === pinnedPnpm ? pnpm : `${pnpm} on PATH; package.json pins ${pinnedPnpm}`);
else
	required(
		corepack !== null,
		"pnpm",
		corepack !== null
			? `not on PATH; scripts fall back to \`corepack pnpm\` (${pinnedPnpm}); \`corepack enable pnpm\` adds the command`
			: `neither pnpm nor corepack is on PATH; install pnpm ${pinnedPnpm} or a Node that ships corepack`,
	);

const git = run("git");
required(git !== null, "git", git ?? "not on PATH; install git");
const rg = run("rg");
required(
	rg !== null,
	"rg",
	rg?.split("\n")[0] ?? "not on PATH; install ripgrep (search tools and their tests need it)",
);
const fd = run("fd") ?? run("fdfind");
required(
	fd !== null,
	"fd",
	fd ?? "neither fd nor fdfind is on PATH; install fd (package fd-find on Debian and Ubuntu)",
);
const python = run("python3");
optional(
	python !== null,
	"python3",
	python ?? "not on PATH; only the website build in `pnpm run ci` and `pnpm run eval:prompts` need it",
);

required(
	existsSync(join(root, "node_modules", ".modules.yaml")),
	"dependencies",
	existsSync(join(root, "node_modules", ".modules.yaml"))
		? "installed"
		: "not installed; run `pnpm install --frozen-lockfile`",
);
const hooks = run("git", ["rev-parse", "--git-path", "hooks/pre-commit"]);
const hooked =
	hooks !== null &&
	existsSync(resolve(root, hooks)) &&
	readFileSync(resolve(root, hooks), "utf8").includes("# pancode git-guard");
optional(hooked, "git hooks", hooked ? "installed" : "not installed; run `pnpm run hooks:install`");
const built = existsSync(join(root, "dist", "cli", "index.js"));
optional(built, "build", built ? "dist/ present" : "dist/ missing; run `pnpm run build` before `pnpm run test`");

const width = Math.max(...rows.map((row) => row.name.length));
for (const row of rows) console.log(`${row.level.padEnd(8)} ${row.name.padEnd(width)}  ${row.detail}`);
const missing = rows.filter((row) => row.level === "missing").length;
console.log(missing === 0 ? "doctor:dev: ready" : `doctor:dev: ${missing} required item(s) missing`);
process.exit(missing === 0 ? 0 : 1);
