// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * The spack server's five tools. Four read the Spack instance the server's
 * environment names: the installed specs, a package's recipe, where a spec or
 * package lives, and the environments. `spack_spec` asks Spack to concretize,
 * which can bootstrap its solver and write Spack's own directories, so it is
 * `execute`. None installs, uninstalls, loads, fetches or edits configuration;
 * a read tool whose command would clone a package repository refuses instead.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { defineTool } from "@pancode/sdk/tool";
import {
	compilersOf,
	INSTALLED_ROOT_STATUSES,
	isNoMatchError,
	parseAmbiguousSpecError,
	parseEnvList,
	parseEnvRoots,
	parseEnvStatus,
	parseFindJson,
	parseHashLines,
	parseHashPrefixLines,
	parseLocation,
	parseSpackInfo,
	parseSpecJson,
	type SpackNode,
	shortHash,
	spackErrorMessage,
} from "./parse.js";
import {
	checkName,
	ENVIRONMENT_PATTERN,
	LARGE_OUTPUT_BYTES,
	locateSpack,
	OUTPUT_BYTES,
	PACKAGE_PATTERN,
	packageReposMissing,
	readSpackVersion,
	runSpack,
	SPACK_TIMEOUTS,
	SPEC_PATTERN,
	specNeedsRepos,
	specTokens,
} from "./program.js";

export const MAX_SPECS = 200;
export const MAX_NODES = 300;
export const MAX_INFO_ENTRIES = 200;
export const MAX_INFO_SECTIONS = 20;
export const MAX_ENVIRONMENTS = 200;
export const MAX_ROOTS = 200;
const MAX_NOTICES = 50;
const NOTICE_LENGTH = 500;
/** How often spack_spec reports the time it has run. */
const SPEC_PROGRESS_MS = 5_000;

const NO_FETCH =
	"It never fetches: when Spack's package repository has not been cloned yet, it returns available false with the `spack repo update` command to run once.";

const SPEC_DESCRIPTION =
	"A Spack spec such as `hdf5@1.14 +mpi ^openmpi` or `/abc1234`: at most 256 characters, entries separated by spaces, none beginning with - (write a disabled variant as ~name).";

interface Spack {
	program: string;
	version: string | null;
	unavailable: Record<string, string>;
}

/** The spack program and its version, or the tool error naming what is missing. */
async function spack(tool: string): Promise<Spack | { error: string }> {
	const found = locateSpack();
	if (found.path === null) return { error: `${tool}: ${found.reason}` };
	const { version, reason } = await readSpackVersion(found.path);
	return { program: found.path, version, unavailable: version === null ? { spackVersion: reason } : {} };
}

const read = (signal: AbortSignal, maxOutputBytes = OUTPUT_BYTES) => ({
	timeoutMs: SPACK_TIMEOUTS.readMs,
	maxOutputBytes,
	signal,
});

function capped<T>(list: T[], cap: number): { items: T[]; total: number; truncated: boolean } {
	return { items: list.slice(0, cap), total: list.length, truncated: list.length > cap };
}

function architectureText(node: SpackNode): string | null {
	const arch = node.architecture;
	if (arch === null) return null;
	const parts = [arch.platform, arch.os, arch.target];
	return parts.every((part) => part !== null) ? parts.join("-") : null;
}

const spackFind = defineTool({
	name: "spack_find",
	title: "Installed Spack packages",
	description: `Returns the specs installed in this Spack instance (at most ${MAX_SPECS}), optionally only those matching a spec or those in a named Spack environment (without one, the whole store, whichever environment is active), each with name, version, 7-character hash, architecture, compilers, install prefix, whether it was installed explicitly and whether it is external. Prefer it over running spack find: the fields come from Spack's JSON, the result says when the list was cut, and nothing is installed or fetched. ${NO_FETCH}`,
	input: {
		type: "object",
		properties: {
			spec: { type: "string", maxLength: 256, pattern: SPEC_PATTERN, description: SPEC_DESCRIPTION },
			environment: {
				type: "string",
				maxLength: 128,
				pattern: ENVIRONMENT_PATTERN,
				description: "A named Spack environment; only the specs installed in it are listed.",
			},
		},
	},
	actionClass: "read",
	idempotent: true,
	async run(args: { spec?: string; environment?: string }, context) {
		let specArgs: string[] = [];
		if (args.spec !== undefined) {
			const tokens = specTokens(args.spec);
			if ("refused" in tokens) return { error: `spack_find: ${tokens.refused}` };
			specArgs = tokens.tokens;
		}
		const refusedEnvironment = args.environment === undefined ? null : checkName("environment", args.environment);
		if (refusedEnvironment !== null) return { error: `spack_find: ${refusedEnvironment}` };
		const found = await spack("spack_find");
		if ("error" in found) return found;
		const { program, version, unavailable } = found;
		if (specNeedsRepos(specArgs)) {
			const missing = await packageReposMissing(program, version, context.signal);
			if (missing !== null) return { json: { available: false, reason: missing, spackVersion: version } };
		}
		const scope = args.environment === undefined ? ["-E"] : ["-e", args.environment];
		const [records, matched, explicit] = await Promise.all([
			runSpack(program, [...scope, "find", "--json", "--deps", ...specArgs], read(context.signal, LARGE_OUTPUT_BYTES)),
			runSpack(program, [...scope, "find", "--format", "{hash} {prefix}", ...specArgs], read(context.signal)),
			runSpack(program, [...scope, "find", "--explicit", "--format", "{hash}", ...specArgs], read(context.signal)),
		]);
		const base = {
			spackVersion: version,
			environment: args.environment ?? null,
			spec: args.spec ?? null,
		};
		if (!matched.ok && matched.exited && isNoMatchError(matched.stderr)) {
			const message = spackErrorMessage(matched.stderr);
			return {
				json: { ...base, specs: [], total: 0, cap: MAX_SPECS, truncated: false, message, unavailable },
			};
		}
		if (!matched.ok) return { error: `spack_find: ${matched.reason}` };
		if (!records.ok) return { error: `spack_find: ${records.reason}` };
		const parsed = parseFindJson(records.stdout);
		if (parsed === null) return { error: "spack_find: spack find --json printed no JSON list" };
		const byHash = new Map(parsed.nodes.map((node) => [node.hash, node]));
		const listed = parseHashPrefixLines(matched.stdout);
		let explicitHashes: Set<string> | null = null;
		if (explicit.ok) explicitHashes = parseHashLines(explicit.stdout).hashes;
		else if (explicit.exited && isNoMatchError(explicit.stderr)) explicitHashes = new Set();
		else unavailable.explicit = explicit.reason;
		let unmatched = 0;
		const specs = listed.entries.flatMap(({ hash, prefix }) => {
			const node = byHash.get(hash);
			if (node === undefined) {
				unmatched++;
				return [];
			}
			return [
				{
					name: node.name,
					version: node.version,
					hash: shortHash(hash),
					namespace: node.namespace,
					architecture: architectureText(node),
					compilers: compilersOf(node, byHash),
					prefix,
					external: node.external,
					explicit: explicitHashes === null ? null : explicitHashes.has(hash),
				},
			];
		});
		const list = capped(specs, MAX_SPECS);
		return {
			json: {
				...base,
				specs: list.items,
				total: list.total,
				cap: MAX_SPECS,
				truncated: list.truncated,
				unreadLines: listed.malformed + unmatched,
				unreadRecords: parsed.malformedRecords,
				unavailable,
			},
		};
	},
});

const spackInfo = defineTool({
	name: "spack_info",
	title: "Spack package info",
	description: `Returns one Spack package's recipe facts: description, homepage, preferred version, known versions (at most ${MAX_INFO_ENTRIES}, deprecated ones marked), variants with their defaults, values and conditions (at most ${MAX_INFO_ENTRIES}), dependencies with their types and conditions (at most ${MAX_INFO_ENTRIES}), and licenses; a section the server could not read is returned as text of at most 4096 characters and counted. Prefer it over running spack info: the sections come as fields, and nothing is installed or fetched. ${NO_FETCH}`,
	input: {
		type: "object",
		properties: {
			package: {
				type: "string",
				maxLength: 128,
				pattern: PACKAGE_PATTERN,
				description: "A package name such as `hdf5`.",
			},
		},
		required: ["package"],
	},
	actionClass: "read",
	idempotent: true,
	async run(args: { package: string }, context) {
		const refused = checkName("package", args.package);
		if (refused !== null) return { error: `spack_info: ${refused}` };
		const found = await spack("spack_info");
		if ("error" in found) return found;
		const { program, version, unavailable } = found;
		const missing = await packageReposMissing(program, version, context.signal);
		if (missing !== null) return { json: { available: false, reason: missing, spackVersion: version } };
		const output = await runSpack(program, ["-E", "info", args.package], read(context.signal));
		if (!output.ok) return { error: `spack_info: ${output.reason}` };
		const info = parseSpackInfo(output.stdout);
		if (info === null) return { error: "spack_info: spack info printed nothing the server could read" };
		const absent = (field: string, section: string) => {
			unavailable[field] = info.otherSections.some((entry) => entry.title === section)
				? `spack info printed a ${section} section the server could not read; it is under unreadSections`
				: `spack info printed no ${section} section`;
		};
		if (info.description === null) absent("description", "Description");
		if (info.homepage === null) absent("homepage", "Homepage");
		if (info.preferredVersion === null) absent("preferredVersion", "Preferred version");
		if (info.versions === null) absent("versions", "Safe versions");
		if (info.variants === null) absent("variants", "Variants");
		if (info.dependencies === null) absent("dependencies", "Dependencies");
		if (info.licenses === null) absent("licenses", "Licenses");
		const list = <T>(entries: T[] | null) => (entries === null ? null : capped(entries, MAX_INFO_ENTRIES));
		const versions = list(info.versions);
		const variants = list(info.variants);
		const dependencies = list(info.dependencies);
		const sections = capped(info.otherSections, MAX_INFO_SECTIONS);
		return {
			json: {
				available: true,
				spackVersion: version,
				package: info.name ?? args.package,
				packageClass: info.packageClass,
				description: info.description,
				homepage: info.homepage,
				preferredVersion: info.preferredVersion,
				versions: versions?.items ?? null,
				versionsTotal: versions?.total ?? null,
				variants: variants?.items ?? null,
				variantsTotal: variants?.total ?? null,
				dependencies: dependencies?.items ?? null,
				dependenciesTotal: dependencies?.total ?? null,
				licenses: info.licenses,
				cap: MAX_INFO_ENTRIES,
				truncated: Boolean(versions?.truncated || variants?.truncated || dependencies?.truncated),
				unreadSections: sections.items,
				unreadSectionsTotal: sections.total,
				unavailable,
			},
		};
	},
});

const spackLocate = defineTool({
	name: "spack_locate",
	title: "Locate a Spack install",
	description: `Returns the install prefix of one installed spec, or the directory holding one package's recipe (package.py); a spec that matches several installs is an error listing each one's hash and spec. Prefer it over running spack location: the path comes checked, and an ambiguous spec names its matches. ${NO_FETCH}`,
	input: {
		type: "object",
		properties: {
			spec: {
				type: "string",
				maxLength: 256,
				pattern: SPEC_PATTERN,
				description: `The installed spec whose prefix to return. ${SPEC_DESCRIPTION} Give spec or package, not both.`,
			},
			package: {
				type: "string",
				maxLength: 128,
				pattern: PACKAGE_PATTERN,
				description: "The package whose recipe directory to return. Give spec or package, not both.",
			},
		},
	},
	actionClass: "read",
	idempotent: true,
	async run(args: { spec?: string; package?: string }, context) {
		if ((args.spec === undefined) === (args.package === undefined))
			return { error: "spack_locate: give exactly one of spec or package" };
		let argv: string[];
		if (args.package !== undefined) {
			const refused = checkName("package", args.package);
			if (refused !== null) return { error: `spack_locate: ${refused}` };
			argv = ["--package-dir", args.package];
		} else {
			const tokens = specTokens(args.spec);
			if ("refused" in tokens) return { error: `spack_locate: ${tokens.refused}` };
			argv = ["--install-dir", ...tokens.tokens];
		}
		const found = await spack("spack_locate");
		if ("error" in found) return found;
		const { program, version, unavailable } = found;
		if (args.package !== undefined || specNeedsRepos(argv.slice(1))) {
			const missing = await packageReposMissing(program, version, context.signal);
			if (missing !== null) return { json: { available: false, reason: missing, spackVersion: version } };
		}
		const output = await runSpack(program, ["-E", "location", ...argv], read(context.signal));
		if (!output.ok) {
			const ambiguous = parseAmbiguousSpecError(output.stderr);
			if (ambiguous !== null) {
				const matches = ambiguous.matches.map((match) => `${match.hash} ${match.spec}`).join("; ");
				return {
					error: `spack_locate: ${ambiguous.spec} matches ${ambiguous.matches.length} installed specs: ${matches}. Name one by its hash, as /<hash>`,
				};
			}
			return { error: `spack_locate: ${output.reason}` };
		}
		const location = parseLocation(output.stdout);
		if (location === null) return { error: "spack_locate: spack location printed no absolute path" };
		if (args.package !== undefined) {
			if (!existsSync(path.join(location, "package.py")))
				return { error: `spack_locate: no package named ${args.package} in Spack's package repositories` };
			return {
				json: { available: true, spackVersion: version, package: args.package, packageDirectory: location, unavailable },
			};
		}
		return { json: { available: true, spackVersion: version, spec: args.spec, prefix: location, unavailable } };
	},
});

const spackSpec = defineTool({
	name: "spack_spec",
	title: "Concretize a Spack spec",
	description: `Returns how Spack concretizes a spec without installing it: every node (at most ${MAX_NODES}) with name, version, 7-character hash, architecture, variants, dependencies with their types and virtuals, whether it is external, and whether it is already installed. Prefer it over running spack spec: the graph comes from Spack's JSON and says what would have to be built. The first concretization on a machine can clone Spack's package repository and bootstrap its solver, which downloads into and writes Spack's user directories and can take minutes, so it has a 300 second timeout and any notices Spack printed are returned.`,
	input: {
		type: "object",
		properties: {
			spec: { type: "string", maxLength: 256, pattern: SPEC_PATTERN, description: SPEC_DESCRIPTION },
		},
		required: ["spec"],
	},
	actionClass: "execute",
	idempotent: false,
	async run(args: { spec: string }, context) {
		const tokens = specTokens(args.spec);
		if ("refused" in tokens) return { error: `spack_spec: ${tokens.refused}` };
		const found = await spack("spack_spec");
		if ("error" in found) return found;
		const { program, version, unavailable } = found;
		const started = performance.now();
		// Spack reports nothing while it concretizes, so the progress is the time it has taken.
		const ticker = setInterval(() => {
			const seconds = Math.round((performance.now() - started) / 1000);
			context.progress(seconds, undefined, `spack spec has run for ${seconds} seconds`);
		}, SPEC_PROGRESS_MS);
		const [concretized, installed] = await Promise.all([
			runSpack(program, ["-E", "spec", "--json", ...tokens.tokens], {
				timeoutMs: SPACK_TIMEOUTS.specMs,
				maxOutputBytes: LARGE_OUTPUT_BYTES,
				signal: context.signal,
			}),
			runSpack(program, ["-E", "find", "--format", "{hash}"], read(context.signal)),
		]).finally(() => clearInterval(ticker));
		const durationSeconds = Math.round((performance.now() - started) / 100) / 10;
		if (!concretized.ok) return { error: `spack_spec: ${concretized.reason}` };
		const parsed = parseSpecJson(concretized.stdout);
		if (parsed === null) return { error: "spack_spec: spack spec --json printed no spec" };
		let installedHashes: Set<string> | null = null;
		if (installed.ok) installedHashes = parseHashLines(installed.stdout).hashes;
		else if (installed.exited && isNoMatchError(installed.stderr)) installedHashes = new Set();
		else unavailable.installed = installed.reason;
		const nodes = parsed.nodes.map((node) => ({
			name: node.name,
			version: node.version,
			hash: shortHash(node.hash),
			namespace: node.namespace,
			architecture: architectureText(node),
			variants: node.variants,
			dependencies: node.dependencies.map((edge) => ({
				name: edge.name,
				hash: shortHash(edge.hash),
				types: edge.types,
				virtuals: edge.virtuals,
			})),
			external: node.external,
			externalPrefix: node.externalPrefix,
			installed: installedHashes === null ? null : installedHashes.has(node.hash),
		}));
		const list = capped(nodes, MAX_NODES);
		const notices = [...parsed.notices, ...concretized.stderr.split("\n")]
			.map((line) => line.trim())
			.filter((line) => line.length > 0)
			.slice(0, MAX_NOTICES)
			.map((line) => line.slice(0, NOTICE_LENGTH));
		return {
			json: {
				spackVersion: version,
				spec: args.spec,
				roots: parsed.roots.map(shortHash),
				nodes: list.items,
				total: list.total,
				cap: MAX_NODES,
				truncated: list.truncated,
				toInstall: installedHashes === null ? null : nodes.filter((node) => !node.installed && !node.external).length,
				unreadNodes: parsed.malformedNodes,
				notices,
				durationSeconds,
				unavailable,
			},
		};
	},
});

const spackEnv = defineTool({
	name: "spack_env",
	title: "Spack environment",
	description: `Returns the active Spack environment (from SPACK_ENV), the named environments (at most ${MAX_ENVIRONMENTS}), and for one environment (the one named, else the active one) its root specs (at most ${MAX_ROOTS}) with each one's install status, how many roots are installed, and how many specs it has installed. Prefer it over running spack env status, spack env list and spack find: one call answers all three in fields, and nothing is activated, installed or fetched.`,
	input: {
		type: "object",
		properties: {
			environment: {
				type: "string",
				maxLength: 128,
				pattern: ENVIRONMENT_PATTERN,
				description: "A named Spack environment whose roots to return. Default: the active environment.",
			},
		},
	},
	actionClass: "read",
	idempotent: true,
	async run(args: { environment?: string }, context) {
		const refused = args.environment === undefined ? null : checkName("environment", args.environment);
		if (refused !== null) return { error: `spack_env: ${refused}` };
		const found = await spack("spack_env");
		if ("error" in found) return found;
		const { program, version, unavailable } = found;
		const [status, listed] = await Promise.all([
			runSpack(program, ["env", "status"], read(context.signal)),
			runSpack(program, ["-E", "env", "list"], read(context.signal)),
		]);
		const active = status.ok ? parseEnvStatus(status.stdout) : null;
		if (active === null)
			unavailable.active = status.ok ? "spack env status printed nothing the server could read" : status.reason;
		let environments: ReturnType<typeof capped<string>> | null = null;
		if (listed.ok) environments = capped(parseEnvList(listed.stdout).names, MAX_ENVIRONMENTS);
		else unavailable.environments = listed.reason;
		const activeName = active?.active === true ? active.environment : null;
		const target = args.environment ?? activeName;
		let environment = null;
		if (target === null) {
			unavailable.environment =
				active === null
					? "no environment was named, and the active one is unknown"
					: "no environment was named and none is active";
		} else {
			// The active environment is read through SPACK_ENV as Spack itself does; a named one through -e.
			const scope = args.environment === undefined ? [] : ["-e", args.environment];
			const [rootsRun, installedRun] = await Promise.all([
				runSpack(program, [...scope, "find", "-r"], read(context.signal)),
				runSpack(program, [...scope, "find", "--json"], read(context.signal, LARGE_OUTPUT_BYTES)),
			]);
			if (!rootsRun.ok) return { error: `spack_env: ${rootsRun.reason}` };
			const roots = parseEnvRoots(rootsRun.stdout);
			if (roots === null) return { error: "spack_env: spack find -r printed no environment header" };
			const rootList = capped(
				roots.roots.map((root) => ({ ...root, installed: INSTALLED_ROOT_STATUSES.has(root.status) })),
				MAX_ROOTS,
			);
			const installedSpecs = installedRun.ok ? (parseFindJson(installedRun.stdout)?.nodes.length ?? null) : null;
			if (installedSpecs === null)
				unavailable.installedSpecs = installedRun.ok ? "spack find --json printed no JSON list" : installedRun.reason;
			environment = {
				name: roots.environment,
				roots: rootList.items,
				rootsTotal: rootList.total,
				declaredRoots: roots.declaredRoots,
				installedRoots: roots.roots.filter((root) => INSTALLED_ROOT_STATUSES.has(root.status)).length,
				cap: MAX_ROOTS,
				truncated: rootList.truncated,
				unreadLines: roots.unreadLines,
				installedSpecs,
			};
		}
		return {
			json: {
				spackVersion: version,
				active: active === null ? null : activeName,
				environments: environments?.items ?? null,
				environmentsTotal: environments?.total ?? null,
				environmentsCap: MAX_ENVIRONMENTS,
				environmentsTruncated: environments?.truncated ?? null,
				environment,
				unavailable,
			},
		};
	},
});

export const SPACK_TOOLS = [spackFind, spackInfo, spackLocate, spackSpec, spackEnv];
