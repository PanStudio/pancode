#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * Release gate for the built dist/ and the npm package contents.
 *
 * Dist integrity: the two executable entries must exist and carry the
 * shebang, and no shared chunk may carry one (a shebang on a chunk means a
 * global banner leaked back into tsup.config.ts).
 *
 * Package audit via `npm pack --dry-run --json`: forbids files that must
 * never ship (caches, source maps, benchmarks), requires the runtime
 * resources the CLI resolves from the installed package root, and stops a
 * tarball that doubled in size. scripts/release/build.mjs runs it on the
 * tarball it packs, so nothing is tested or published unaudited.
 *
 * Version coherence: the version in package.json must be the version the top
 * of CHANGELOG.md describes, and a publishable version needs its dated
 * heading.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { packedLicenseProblems } from "./packed-license.mjs";
import { pnpmArgv } from "./pnpm.mjs";
import { bundledGuiAuditLockfiles, shippedAdvisoryFindings } from "./release-audit.mjs";
import { DEV_VERSION, releaseVersionErrors } from "./release-version-policy.mjs";
import { planSourcePack, readSourcePackMembers } from "./source-pack-plan.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const { values } = parseArgs({ options: { tarball: { type: "string" }, report: { type: "string" } } });
let packageRoot = root;
let packedReport;
if (values.tarball || values.report) {
	if (!values.tarball || !values.report) throw new Error("Supply both --tarball and --report.");
	packedReport = JSON.parse(readFileSync(values.report, "utf8"));
	const bytes = readFileSync(values.tarball);
	if (
		`sha512-${createHash("sha512").update(bytes).digest("base64")}` !== packedReport.integrity ||
		bytes.length !== packedReport.size
	)
		throw new Error("Pack report does not describe this tarball.");
	const entries = execFileSync("tar", ["-tzf", values.tarball], { encoding: "utf8" }).trim().split("\n");
	if (entries.some((path) => !path.startsWith("package/") || path.split("/").includes("..") || path.includes("\\")))
		throw new Error("Tarball contains an unsafe path.");
	if (
		JSON.stringify(entries.map((path) => path.slice(8)).sort()) !==
		JSON.stringify(packedReport.files.map((file) => file.path).sort())
	)
		throw new Error("Pack report file inventory differs from the tarball.");
	const scratch = mkdtempSync(join(tmpdir(), "pancode-release-inspect-"));
	process.on("exit", () => rmSync(scratch, { recursive: true, force: true }));
	execFileSync("tar", ["-xzf", values.tarball, "-C", scratch]);
	packageRoot = join(scratch, "package");
}
const SHEBANG = "#!/usr/bin/env node";
const packedBin = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")).bin ?? {};
// Every command in `bin` plus the worker entry PanCode spawns itself.
const ENTRIES = [
	...new Set([
		"dist/cli/index.js",
		"dist/worker/entry.js",
		...Object.values(typeof packedBin === "string" ? { pancode: packedBin } : packedBin).map((target) =>
			posix.normalize(target),
		),
	]),
];

const manifest = JSON.parse(readFileSync(join(root, "scripts", "release-manifest.json"), "utf8"));
const SHIPPED_SCRIPTS = new Set(manifest.requiredFiles.filter((file) => file.startsWith("scripts/")));
const SOURCE_PACK = "dist/assets/source.pack";
// About twice the 0.9.0 tarball: a tripwire for a packaging defect such as a doubled dist/, not a budget.
const MAX_TARBALL_BYTES = 40_000_000;

const FORBIDDEN = [
	{
		test: (f) => f.startsWith("patches/"),
		reason: "checkout-only dependency maintenance inputs",
	},
	{
		test: (f) => f.includes("__pycache__") || f.endsWith(".pyc"),
		reason: "python bytecode cache",
	},
	{
		test: (f) => f.endsWith(".map"),
		reason: "source map (excluded by release policy)",
	},
	{
		test: (f) => f.startsWith("benchmarks/"),
		reason: "benchmarks are not part of the package",
	},
	{
		test: (f) => f.startsWith("scripts/") && !SHIPPED_SCRIPTS.has(f),
		reason: "repo scripts operate on a source checkout only",
	},
	{ test: (f) => f.endsWith(".tsbuildinfo"), reason: "typescript build cache" },
	{ test: (f) => /(^|\/)\.env(\.|$)/.test(f), reason: "environment file" },
	{ test: (f) => f.includes("node_modules/"), reason: "vendored node_modules" },
];

// Exact files the CLI resolves from the installed package root at runtime, and
// the resource trees it loads by directory scan. Shared with the packaging
// contract test, which holds this list against the package.json `files`
// allowlist so the gate cannot outlive what the allowlist actually ships.
const REQUIRED_FILES = manifest.requiredFiles;
const REQUIRED_PREFIXES = manifest.requiredPrefixes;

const errors = [];

function firstLine(abs) {
	try {
		return readFileSync(abs, "utf8").slice(0, SHEBANG.length);
	} catch {
		return null;
	}
}

for (const rel of ENTRIES) {
	const head = firstLine(join(packageRoot, rel));
	if (head === null) errors.push(`missing ${rel}`);
	else if (head !== SHEBANG) errors.push(`bad shebang in ${rel}`);
}

checkVersionCoherence();

/**
 * The published version and the release notes for it must name the same number.
 *
 * `prepublishOnly` runs this gate, and until now nothing in it read
 * package.json's version at all: the tree could be published with every note
 * for the release still under `## Unreleased`, or with the version bumped and
 * the changelog never touched. Both are silent at publish time and permanent
 * afterwards, because a published version cannot be replaced.
 *
 * A development version may keep `## Unreleased`. A stable or pre-release
 * version is publishable and requires `## <version> - YYYY-MM-DD`.
 */
function checkVersionCoherence() {
	let version;
	try {
		version = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")).version;
	} catch (error) {
		errors.push(`unable to read package.json version: ${error instanceof Error ? error.message : String(error)}`);
		return;
	}
	let changelog;
	try {
		const sourceVersion = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
		if (packageRoot !== root && version !== sourceVersion)
			errors.push(`Packed version ${version} differs from source version ${sourceVersion}`);
	} catch (error) {
		errors.push(`unable to read the source package.json: ${error instanceof Error ? error.message : String(error)}`);
	}
	try {
		changelog = readFileSync(join(packageRoot, "CHANGELOG.md"), "utf8");
	} catch (error) {
		errors.push(`unable to read CHANGELOG.md: ${error instanceof Error ? error.message : String(error)}`);
		return;
	}

	errors.push(
		...releaseVersionErrors({
			version,
			changelog,
			releaseContext: typeof version === "string" && !DEV_VERSION.test(version),
		}),
	);
}

const entrySet = new Set(ENTRIES);
for (const dirent of readdirSync(join(packageRoot, "dist"), {
	recursive: true,
	withFileTypes: true,
})) {
	if (!dirent.isFile() || !dirent.name.endsWith(".js")) continue;
	const abs = join(dirent.parentPath, dirent.name);
	const rel = abs.slice(packageRoot.length + (packageRoot.endsWith("/") ? 0 : 1)).replaceAll("\\", "/");
	if (entrySet.has(rel)) continue;
	if (firstLine(abs) === SHEBANG) {
		errors.push(`unexpected shebang on non-entry chunk: ${rel}`);
	}
}

let report = packedReport;
try {
	if (!report) {
		const raw = execFileSync("npm", ["pack", "--dry-run", "--json"], {
			cwd: root,
			encoding: "utf8",
			maxBuffer: 64 * 1024 * 1024,
			stdio: ["ignore", "pipe", "ignore"],
		});
		report = JSON.parse(raw)[0];
	}
} catch (err) {
	process.stderr.write(
		`check-release: npm pack --dry-run failed: ${err instanceof Error ? err.message : String(err)}\n`,
	);
	process.exit(1);
}

const files = report.files.map((f) => f.path);
const fileSet = new Set(files);

for (const file of files) {
	for (const rule of FORBIDDEN) {
		if (rule.test(file)) {
			errors.push(`forbidden file in package: ${file} (${rule.reason})`);
		}
	}
}

for (const required of REQUIRED_FILES) {
	if (!fileSet.has(required)) errors.push(`missing required file: ${required}`);
}

for (const prefix of REQUIRED_PREFIXES) {
	if (!files.some((f) => f.startsWith(prefix))) {
		errors.push(`no files under required tree: ${prefix}`);
	}
}

// License files: LICENSE and NOTICE are the committed bytes, and packages/sdk/LICENSE stays out.
errors.push(...packedLicenseProblems(packageRoot, files, root));

checkSourcePack();
checkExtensionDeclarations();
checkBuildInventory();

/**
 * Development builds keep chunks a running process may still import; a
 * release must come from a clean build, so every packed dist/ script is one
 * dist/build.json lists, and the per-build records under dist/builds/ stay out.
 */
function checkBuildInventory() {
	let listed;
	try {
		listed = new Set(JSON.parse(readFileSync(join(packageRoot, "dist", "build.json"), "utf8")).files);
	} catch {
		errors.push("dist/build.json is missing or unreadable");
		return;
	}
	for (const file of files) {
		if (file.startsWith("dist/builds/")) errors.push(`build record in package: ${file}`);
		else if (file.startsWith("dist/") && file.endsWith(".js") && !listed.has(file.slice(5)))
			errors.push(`dist script not in dist/build.json (stale chunk; build with --clean): ${file}`);
	}
}

/**
 * The tarball must agree with the source-pack plan computed from this
 * checkout, which covers src/ and every packages/<name>/src/: every planned
 * file is in source.pack and absent as a loose file, and the pack carries
 * nothing else.
 */
function checkSourcePack() {
	let plan;
	let members;
	try {
		plan = planSourcePack(root);
		members = new Set(readSourcePackMembers(join(packageRoot, SOURCE_PACK)));
	} catch (error) {
		errors.push(`unable to check the source pack: ${error instanceof Error ? error.message : String(error)}`);
		return;
	}
	const doubled = [...members].filter((file) => fileSet.has(file));
	if (doubled.length > 0) errors.push(`packed source also shipped loose: ${doubled.slice(0, 10).join(", ")}`);
	const unpacked = plan.packed.filter((file) => !members.has(file));
	if (unpacked.length > 0) errors.push(`planned source missing from the pack: ${unpacked.slice(0, 10).join(", ")}`);
	const planned = new Set(plan.packed);
	const strays = [...members].filter((file) => !planned.has(file));
	if (strays.length > 0) errors.push(`source pack carries files outside the plan: ${strays.slice(0, 10).join(", ")}`);
}

/**
 * Installed extensions type-check against the `exports` `types` files alone,
 * so each must ship and may import only other shipped files by relative path.
 * A bare specifier would name a package an extension author does not have
 * (most of PanCode's own imports are bundled devDependencies), which is how the
 * loose src/ types failed before they were bundled. Node builtins (`node:*`)
 * are the exception: `@types/node` describes them, as it does for any Node code.
 */
function checkExtensionDeclarations() {
	const pkg = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
	const pending = Object.values(pkg.exports ?? {})
		.map((target) => (target && typeof target === "object" ? target.types : undefined))
		.filter((types) => typeof types === "string")
		.map((types) => posix.normalize(types));
	const seen = new Set();
	while (pending.length > 0) {
		const file = pending.pop();
		if (seen.has(file)) continue;
		seen.add(file);
		if (!fileSet.has(file)) {
			errors.push(`extension declaration not shipped: ${file}`);
			continue;
		}
		const text = readFileSync(join(packageRoot, file), "utf8");
		for (const match of text.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)["']([^"']+)["']/g)) {
			const specifier = match[1];
			if (specifier.startsWith("node:")) continue;
			if (!specifier.startsWith(".")) {
				errors.push(`extension declaration ${file} imports a package: ${specifier}`);
				continue;
			}
			pending.push(posix.join(posix.dirname(file), specifier).replace(/\.js$/, ".d.ts"));
		}
	}
}

const requiredRecipeKeys = new Set([
	"version",
	"name",
	"description",
	"tools",
	"skills",
	"audience",
	"category",
	"capabilityClass",
	"latencyClass",
	"projectContextTier",
	"budget",
	"resultContract",
	"tags",
]);
const optionalRecipeKeys = new Set(["product", "permissions", "traits", "handbook"]);
const allowedRecipeKeys = new Set([...requiredRecipeKeys, ...optionalRecipeKeys]);
// Builtin recipes ship from their one canonical location, src/domains/agents/
// builtins/, which is what src/domains/agents/extension.ts reads at runtime.
// Every recipe must be in the pack and carry the strict v1 frontmatter schema.
const recipeDir = join(packageRoot, "src", "domains", "agents", "builtins");
for (const name of readdirSync(recipeDir)
	.filter((entry) => entry.endsWith(".md"))
	.sort()) {
	const packagePath = `src/domains/agents/builtins/${name}`;
	if (!fileSet.has(packagePath)) {
		errors.push(`missing builtin recipe in package: ${packagePath}`);
		continue;
	}
	try {
		const raw = readFileSync(join(recipeDir, name), "utf8");
		const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
		const frontmatter = match ? parseYaml(match[1]) : null;
		if (!frontmatter || typeof frontmatter !== "object" || Array.isArray(frontmatter)) {
			errors.push(`invalid builtin recipe frontmatter: ${packagePath}`);
			continue;
		}
		const keys = Object.keys(frontmatter);
		if (
			frontmatter.version !== 1 ||
			keys.some((key) => !allowedRecipeKeys.has(key)) ||
			[...requiredRecipeKeys].some((key) => !keys.includes(key))
		) {
			errors.push(`builtin recipe is not the strict v1 schema: ${packagePath}`);
		}
	} catch (error) {
		errors.push(
			`unable to inspect builtin recipe ${packagePath}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

/** Audit the production CLI graph and the exact packages bundled into the GUI client.
 * pnpm audit visits every importer even with --filter; separate lockfiles keep
 * unshipped workspace dependencies outside the release boundary.
 */
function checkShippedAdvisories() {
	const auditRoot = mkdtempSync(join(tmpdir(), "pancode-release-audit-"));
	try {
		const lockfile = parseYaml(readFileSync(join(root, "pnpm-lock.yaml"), "utf8"));
		if (!lockfile?.importers?.["."]) throw new Error("pnpm lockfile has no root importer");
		const guiLockfiles = bundledGuiAuditLockfiles(
			lockfile,
			readFileSync(join(packageRoot, "dist/gui/client/THIRD_PARTY_LICENSES.md"), "utf8"),
		);
		writeFileSync(join(auditRoot, "package.json"), readFileSync(join(packageRoot, "package.json")));
		for (const auditLockfile of [{ ...lockfile, importers: { ".": lockfile.importers["."] } }, ...guiLockfiles]) {
			writeFileSync(join(auditRoot, "pnpm-lock.yaml"), stringifyYaml(auditLockfile));
			let raw;
			try {
				const [pnpm, auditArgs] = pnpmArgv([`--config.lockfile-dir=${auditRoot}`, "audit", "--prod", "--json"]);
				raw = execFileSync(pnpm, auditArgs, {
					cwd: root,
					encoding: "utf8",
					stdio: ["ignore", "pipe", "pipe"],
				});
			} catch (error) {
				// Advisories exit nonzero with a JSON report; command/registry failures
				// are rejected by the same parser instead of being counted as zero.
				raw = typeof error?.stdout === "string" ? error.stdout : "";
				if (!raw.trim()) throw error;
			}
			const findings = shippedAdvisoryFindings(JSON.parse(raw));
			for (const note of findings.notes) process.stdout.write(`check-release: note: ${note}\n`);
			errors.push(...findings.errors);
		}
	} catch (error) {
		errors.push(`unable to establish shipped advisory state: ${error instanceof Error ? error.message : String(error)}`);
	} finally {
		rmSync(auditRoot, { recursive: true, force: true });
	}
}

checkShippedAdvisories();

if (report.size > MAX_TARBALL_BYTES) errors.push(`tarball is ${report.size} bytes, over ${MAX_TARBALL_BYTES}`);

if (errors.length > 0) {
	for (const error of errors) process.stderr.write(`check-release: ${error}\n`);
	process.exit(1);
}

process.stdout.write(`check-release: ok (${report.files.length} files, tarball ${report.size} bytes)\n`);
process.exit(0);
