// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AnyTool } from "@pancode/sdk/tool";
import { BASE_ENV_ALLOWLIST } from "../src/exec.js";
import { environment, probe, server } from "../src/servers/spack/index.js";
import {
	compilersOf,
	parseAmbiguousSpecError,
	parseEnvList,
	parseEnvRoots,
	parseEnvStatus,
	parseFindJson,
	parseHashLines,
	parseHashPrefixLines,
	parseLocation,
	parseRepoListJson,
	parseRepoListText,
	parseSpackInfo,
	parseSpackVersionFile,
	parseSpecJson,
	scanJsonDocuments,
} from "../src/servers/spack/parse.js";
import { SPACK_MISSING, SPACK_TIMEOUTS, specTokens } from "../src/servers/spack/program.js";
import { MAX_NODES, MAX_SPECS } from "../src/servers/spack/tools.js";

/**
 * The spack server: its parsers against Spack's output, and its tools against
 * stub `spack` programs that record their argv and environment.
 *
 * Inputs and where they come from:
 * - ZLIB_RECORD, GCC_RECORD, GLIBC_RECORD: records of `spack find --json`,
 *   captured from Spack 1.2.2 (package_hash and annotations left out).
 * - ZLIB_SPEC_NODE: the root node of `spack spec --json zlib`, captured from
 *   Spack 1.2.2 (package_hash and annotations left out); the spec document
 *   around it and SPEC_NOTICES, the first lines a first `spack spec` printed,
 *   are captured from the same run.
 * - INFO_ZLIB: `spack info zlib`, captured from Spack 1.2.2.
 * - INFO_WRAPPED: two entries of `spack info kokkos`, captured from Spack
 *   1.2.2 and trimmed to those entries.
 * - INFO_OLD and INFO_BROKEN: constructed, in the layout of Spack before 1.0
 *   and in a layout the parser does not know.
 * - AMBIGUOUS, the `spack location` paths, ENV_ROOTS, `spack env status` and
 *   `spack env list` output, and REPO_LIST_*: captured from Spack 1.2.2, with
 *   install and cache paths replaced by /opt/spack and /opt/spack-cache.
 * - Everything else (malformed inputs, cap-sized lists, version files) is
 *   constructed.
 */

const ZLIB_HASH = "dhj67ylb3eluwl2llwkxiorzttkq3gef";
const GCC_HASH = "zpevy7hd2gpslwai2o7ldl26j65ivnzq";
const GLIBC_HASH = "thy5vqoaouxdwkh5hofjegtbqsl7r25d";

const FLAGS = { cflags: [], cppflags: [], cxxflags: [], fflags: [], ldflags: [], ldlibs: [] };
const ARCH_V4 = { platform: "linux", platform_os: "ubuntu24.04", target: "x86_64_v4" };
const ARCH = { platform: "linux", platform_os: "ubuntu24.04", target: "x86_64" };

const ZLIB_DEPENDENCIES = [
	{
		name: "compiler-wrapper",
		hash: "gy7tlaoliz6borna6pp3uq7wa7x4uaqt",
		parameters: { deptypes: ["build"], virtuals: [] },
	},
	{ name: "gcc", hash: GCC_HASH, parameters: { deptypes: ["build"], virtuals: ["c", "cxx"] } },
	{ name: "gcc-runtime", hash: "llzcadohanpsmrx345p6xg2pzxiuyy7t", parameters: { deptypes: ["link"], virtuals: [] } },
	{ name: "glibc", hash: GLIBC_HASH, parameters: { deptypes: ["link"], virtuals: ["libc"] } },
	{ name: "gmake", hash: "lxfk7xqsq7mkpamcjyjhshdcz3tuyxnw", parameters: { deptypes: ["build"], virtuals: [] } },
];

const ZLIB_RECORD = {
	name: "zlib",
	version: "1.2.13",
	arch: ARCH_V4,
	namespace: "builtin",
	parameters: { build_system: "makefile", optimize: true, pic: true, shared: true, ...FLAGS },
	dependencies: ZLIB_DEPENDENCIES,
	hash: ZLIB_HASH,
};

const GCC_RECORD = {
	name: "gcc",
	version: "13.3.0",
	arch: ARCH,
	namespace: "builtin",
	parameters: { binutils: true, build_system: "autotools", languages: ["c", "c++", "fortran"], ...FLAGS },
	external: {
		path: "/usr",
		module: null,
		extra_attributes: { compilers: { c: "/usr/bin/gcc", cxx: "/usr/bin/g++", fortran: "/usr/bin/gfortran" } },
	},
	hash: GCC_HASH,
};

const GLIBC_RECORD = {
	name: "glibc",
	version: "2.39",
	arch: ARCH,
	namespace: "builtin",
	parameters: { build_system: "autotools", ...FLAGS },
	external: { path: "/usr", module: null, extra_attributes: {} },
	hash: GLIBC_HASH,
};

const ZLIB_SPEC_NODE = {
	...ZLIB_RECORD,
	version: "1.3.2",
	hash: "5n7xctyywdtbz73foc3sivbkdq6rahrg",
};

const SPEC_NOTICES = [
	"==> Compilers have been configured automatically from PATH inspection",
	'==> Installing "clingo-bootstrap@=spack~apps~docs+ipo+optimized+python+static_libstdcpp build_system=cmake build_type=Release platform=linux os=centos7 target=x86_64" from a buildcache',
];

const specDocument = (nodes: unknown[]) => JSON.stringify({ spec: { _meta: { version: 5 }, nodes } });

const INFO_ZLIB = `MakefilePackage:   zlib

Description:
    A free, general-purpose, legally unencumbered lossless data-compression
    library.

Homepage: https://zlib.net

Preferred version:  
    1.3.2     http://zlib.net/fossils/zlib-1.3.2.tar.gz

Safe versions:  
    1.3.2     http://zlib.net/fossils/zlib-1.3.2.tar.gz
    1.3.1     http://zlib.net/fossils/zlib-1.3.1.tar.gz
    1.3       http://zlib.net/fossils/zlib-1.3.tar.gz
    1.2.13    http://zlib.net/fossils/zlib-1.2.13.tar.gz

Deprecated versions:  
    None

Variants:
    build_system [makefile]        generic, makefile
        Build systems supported by the package

    optimize [true]                false, true
        Enable -O2 for a more optimized lib

    pic [true]                     false, true
        Produce position-independent code (for shared libs)

    shared [true]                  false, true
        Enables the build of shared libraries.


Dependencies:
    c            build

    cxx          build

    gmake        build
      when build_system=makefile


Licenses:
    Zlib

`;

const INFO_WRAPPED = `CMakePackage:   kokkos

Variants:
    amdgpu_target [none]                        none, gfx1010, gfx1011,
                                                gfx1012, gfx1013, gfx1030
      when +rocm
        AMD GPU architecture

Dependencies:
    hpx cxxstd=14                      build, link
      when +hpx cxxstd=14
`;

const INFO_OLD = `Package:   mpileaks

Description:
    Tool to detect and report MPI objects.

Build Dependencies:
    adept-utils  callpath  mpi

Link Dependencies:
    mpi

`;

const INFO_BROKEN = `AutotoolsPackage:   example

Variants:
    Name [Default]    When    Allowed values    Description
    ==============    ====    ==============    ===========

Safe versions:
    1.0    https://example.org/example-1.0.tar.gz
`;

const AMBIGUOUS = `==> Error: zlib matches multiple packages.
  Matching packages:
    dhj67yl zlib@1.2.13 platform=linux os=ubuntu24.04 target=x86_64_v4 %c,cxx=gcc@13.3.0
    5n7xcty zlib@1.3.2 platform=linux os=ubuntu24.04 target=x86_64_v4 %c,cxx=gcc@13.3.0
  Use a more specific spec (e.g., prepend '/' to the hash).
`;

const ENV_ROOTS = `==> In environment demo (2 root specs)
[+] zlib@1.2.13
 -  zlib-ng

`;

const REPO_LIST_JSON =
	'[{"name":"builtin","namespace":"builtin","path":"https://github.com/spack/spack-packages.git","api_version":"","status":"uninitialized","error":null}]';
const REPO_LIST_TEXT_ABSENT = " -  builtin        https://github.com/spack/spack-packages.git\n";
const REPO_LIST_TEXT_PRESENT =
	"[+] builtin    v2.2    /opt/spack-cache/package_repos/fncqgg4/repos/spack_repo/builtin\n";

test("the version file names Spack's version, old and new layouts", () => {
	assert.equal(parseSpackVersionFile('#: PEP440 canonical\n__version__ = "1.2.2"\n'), "1.2.2");
	assert.equal(parseSpackVersionFile("spack_version_info = (0, 21, 2)\n"), "0.21.2");
	assert.equal(parseSpackVersionFile("__version__ = get_version()\n"), null);
	assert.equal(parseSpackVersionFile(""), null);
});

test("scanJsonDocuments separates notices from the JSON documents", () => {
	const text = `${SPEC_NOTICES.join("\n")}\n${specDocument([])}\n${specDocument([])}\n`;
	const { documents, notices } = scanJsonDocuments(text);
	assert.equal(documents.length, 2);
	assert.deepEqual(notices, SPEC_NOTICES);
	assert.deepEqual(scanJsonDocuments('{"open": [1, 2'), { documents: [], notices: ['{"open": [1, 2'] });
});

test("parseFindJson reads records, counts malformed ones, and refuses non-JSON", () => {
	assert.deepEqual(parseFindJson("[]"), { nodes: [], malformedRecords: 0 });
	const parsed = parseFindJson(JSON.stringify([ZLIB_RECORD, GCC_RECORD, GLIBC_RECORD, { name: "nohash" }]));
	assert.ok(parsed);
	assert.equal(parsed.malformedRecords, 1);
	const [zlib, gcc] = parsed.nodes;
	assert.equal(zlib?.version, "1.2.13");
	assert.deepEqual(zlib?.architecture, { platform: "linux", os: "ubuntu24.04", target: "x86_64_v4" });
	assert.deepEqual(zlib?.variants, { build_system: "makefile", optimize: true, pic: true, shared: true });
	assert.equal(zlib?.external, false);
	assert.equal(gcc?.external, true);
	assert.equal(gcc?.externalPrefix, "/usr");
	const byHash = new Map(parsed.nodes.map((node) => [node.hash, node]));
	assert.deepEqual(zlib && compilersOf(zlib, byHash), [{ name: "gcc", version: "13.3.0", languages: ["c", "cxx"] }]);
	assert.equal(parseFindJson("==> Error: no environment in nosuch\n"), null);
	assert.equal(parseFindJson('{"not": "a list"}'), null);
});

test("parseFindJson reads the specs of an environment and Spack 0.x compiler fields", () => {
	// `spack -e demo find --json` prints the same records, limited to the environment.
	const parsed = parseFindJson(`${JSON.stringify([ZLIB_RECORD])}\n`);
	assert.deepEqual(
		parsed?.nodes.map((node) => node.name),
		["zlib"],
	);
	const old = parseFindJson(
		JSON.stringify([
			{
				name: "zlib",
				version: "1.2.13",
				arch: { platform: "linux", platform_os: "rhel8", target: { name: "zen2", vendor: "AuthenticAMD" } },
				compiler: { name: "gcc", version: "11.2.0" },
				hash: "abcdefgabcdefgabcdefgabcdefgabcd",
			},
		]),
	);
	const node = old?.nodes[0];
	assert.ok(node);
	assert.equal(node.architecture?.target, "zen2");
	assert.deepEqual(compilersOf(node, new Map()), [{ name: "gcc", version: "11.2.0", languages: null }]);
});

test("parseSpecJson reads a small tree, keeps shared nodes once, and refuses other JSON", () => {
	const tree = [ZLIB_SPEC_NODE, GCC_RECORD, GLIBC_RECORD];
	const text = `${SPEC_NOTICES.join("\n")}\n${specDocument(tree)}\n${specDocument([GLIBC_RECORD])}\n`;
	const parsed = parseSpecJson(text);
	assert.ok(parsed);
	assert.deepEqual(parsed.roots, ["5n7xctyywdtbz73foc3sivbkdq6rahrg", GLIBC_HASH]);
	assert.deepEqual(
		parsed.nodes.map((node) => node.name),
		["zlib", "gcc", "glibc"],
	);
	assert.deepEqual(parsed.nodes[0]?.dependencies[1], {
		name: "gcc",
		hash: GCC_HASH,
		types: ["build"],
		virtuals: ["c", "cxx"],
	});
	assert.deepEqual(parsed.notices, SPEC_NOTICES);
	assert.equal(parseSpecJson('{"spec": {}}'), null);
	assert.equal(parseSpecJson("==> Error: invalid spec\n"), null);
	assert.equal(parseSpecJson(specDocument([{ name: "x" }]))?.malformedNodes, 1);
});

test("parseSpackInfo reads every section of spack info", () => {
	const info = parseSpackInfo(INFO_ZLIB);
	assert.ok(info);
	assert.equal(info.packageClass, "MakefilePackage");
	assert.equal(info.name, "zlib");
	assert.equal(info.description, "A free, general-purpose, legally unencumbered lossless data-compression library.");
	assert.equal(info.homepage, "https://zlib.net");
	assert.equal(info.preferredVersion, "1.3.2");
	assert.deepEqual(
		info.versions?.map((entry) => entry.version),
		["1.3.2", "1.3.1", "1.3", "1.2.13"],
	);
	assert.deepEqual(info.variants?.[1], {
		name: "optimize",
		default: "true",
		values: ["false", "true"],
		when: null,
		description: "Enable -O2 for a more optimized lib",
	});
	assert.deepEqual(info.dependencies, [
		{ spec: "c", types: ["build"], when: null },
		{ spec: "cxx", types: ["build"], when: null },
		{ spec: "gmake", types: ["build"], when: "build_system=makefile" },
	]);
	assert.deepEqual(info.licenses, ["Zlib"]);
	assert.deepEqual(info.otherSections, []);
});

test("parseSpackInfo reads wrapped values, conditions, and specs with spaces", () => {
	const info = parseSpackInfo(INFO_WRAPPED);
	assert.deepEqual(info?.variants, [
		{
			name: "amdgpu_target",
			default: "none",
			values: ["none", "gfx1010", "gfx1011", "gfx1012", "gfx1013", "gfx1030"],
			when: "+rocm",
			description: "AMD GPU architecture",
		},
	]);
	assert.deepEqual(info?.dependencies, [{ spec: "hpx cxxstd=14", types: ["build", "link"], when: "+hpx cxxstd=14" }]);
});

test("parseSpackInfo reads per-type dependencies and keeps a section it cannot read as text", () => {
	const old = parseSpackInfo(INFO_OLD);
	assert.equal(old?.packageClass, "Package");
	assert.deepEqual(old?.dependencies, [
		{ spec: "adept-utils", types: ["build"], when: null },
		{ spec: "callpath", types: ["build"], when: null },
		{ spec: "mpi", types: ["build"], when: null },
		{ spec: "mpi", types: ["link"], when: null },
	]);
	const broken = parseSpackInfo(INFO_BROKEN);
	assert.ok(broken);
	assert.equal(broken.variants, null);
	assert.equal(broken.otherSections.length, 1);
	assert.equal(broken.otherSections[0]?.title, "Variants");
	assert.match(broken.otherSections[0]?.text ?? "", /Allowed values/);
	assert.deepEqual(
		broken.versions?.map((entry) => entry.version),
		["1.0"],
	);
	assert.equal(parseSpackInfo(""), null);
	assert.equal(parseSpackInfo("no sections here\n"), null);
});

test("parseLocation and the ambiguous-spec error", () => {
	assert.equal(
		parseLocation("/opt/spack/opt/spack/linux-x86_64_v4/zlib-1.2.13-dhj67ylb3eluwl2llwkxiorzttkq3gef\n"),
		"/opt/spack/opt/spack/linux-x86_64_v4/zlib-1.2.13-dhj67ylb3eluwl2llwkxiorzttkq3gef",
	);
	assert.equal(parseLocation("==> Error: Spec 'zlib' matches no installed packages.\n"), null);
	assert.equal(parseLocation(""), null);
	assert.deepEqual(parseAmbiguousSpecError(AMBIGUOUS), {
		spec: "zlib",
		matches: [
			{ hash: "dhj67yl", spec: "zlib@1.2.13 platform=linux os=ubuntu24.04 target=x86_64_v4 %c,cxx=gcc@13.3.0" },
			{ hash: "5n7xcty", spec: "zlib@1.3.2 platform=linux os=ubuntu24.04 target=x86_64_v4 %c,cxx=gcc@13.3.0" },
		],
	});
	assert.equal(parseAmbiguousSpecError("==> Error: zlib matches multiple packages.\n"), null);
	assert.equal(parseAmbiguousSpecError("==> Error: Spec 'zlib' matches no installed packages.\n"), null);
});

test("env status, env list and an environment's roots", () => {
	assert.deepEqual(parseEnvStatus("==> No active environment\n"), { active: false });
	assert.deepEqual(parseEnvStatus("==> In environment demo\n"), { active: true, environment: "demo" });
	assert.deepEqual(parseEnvStatus("==> Using spack.yaml in current directory: /work/project\n"), {
		active: true,
		environment: "/work/project",
	});
	assert.equal(parseEnvStatus("Traceback (most recent call last):\n"), null);
	assert.deepEqual(parseEnvList("    demo\n    empty-env\n"), { names: ["demo", "empty-env"], malformed: 0 });
	assert.deepEqual(parseEnvList(""), { names: [], malformed: 0 });
	assert.deepEqual(parseEnvList("    demo\n    two words\n"), { names: ["demo"], malformed: 1 });
	assert.deepEqual(parseEnvRoots(ENV_ROOTS), {
		environment: "demo",
		declaredRoots: 2,
		roots: [
			{ spec: "zlib@1.2.13", status: "installed" },
			{ spec: "zlib-ng", status: "absent" },
		],
		unreadLines: 0,
	});
	assert.equal(parseEnvRoots("==> In environment empty-env (no root specs)\n")?.declaredRoots, 0);
	assert.equal(parseEnvRoots("[+] zlib\n"), null);
	assert.equal(parseEnvRoots("==> In environment demo (1 root spec)\n?? zlib\n")?.unreadLines, 1);
});

test("find --format lines and repo list in both forms", () => {
	assert.deepEqual(parseHashPrefixLines(`${ZLIB_HASH} /opt/spack/zlib\n${GCC_HASH} /usr\nnot a line\n`), {
		entries: [
			{ hash: ZLIB_HASH, prefix: "/opt/spack/zlib" },
			{ hash: GCC_HASH, prefix: "/usr" },
		],
		malformed: 1,
	});
	assert.deepEqual(parseHashLines(`${ZLIB_HASH}\n==> 1 installed package\nNOT-A-HASH\n`), {
		hashes: new Set([ZLIB_HASH]),
		malformed: 1,
	});
	assert.deepEqual(parseRepoListJson(REPO_LIST_JSON), [
		{ name: "builtin", status: "uninitialized", location: "https://github.com/spack/spack-packages.git" },
	]);
	assert.equal(parseRepoListJson('[{"name": "builtin"}]'), null);
	assert.equal(parseRepoListJson("usage: spack repo list [-h]"), null);
	assert.deepEqual(parseRepoListText(REPO_LIST_TEXT_ABSENT), [
		{ name: "builtin", status: "uninitialized", location: "https://github.com/spack/spack-packages.git" },
	]);
	assert.equal(parseRepoListText(REPO_LIST_TEXT_PRESENT)?.[0]?.status, "installed");
	assert.equal(parseRepoListText("==> 1 package repository.\n"), null);
});

test("a spec is split on spaces and refused when it could reach anything but a spec", () => {
	assert.deepEqual(specTokens("hdf5@1.14 +mpi ~fortran ^openmpi@5: %gcc"), {
		tokens: ["hdf5@1.14", "+mpi", "~fortran", "^openmpi@5:", "%gcc"],
	});
	assert.deepEqual(specTokens("/dhj67yl"), { tokens: ["/dhj67yl"] });
	assert.deepEqual(specTokens("^[virtuals=mpi] openmpi"), { tokens: ["^[virtuals=mpi]", "openmpi"] });
	for (const spec of [
		'zlib"',
		"zlib'",
		"zlib; ls",
		"zlib | cat",
		"zlib && ls",
		"zlib $HOME",
		"zlib\nls",
		"zlib\\",
		"zlib -v",
		"--help",
		"./spec.json",
		"spec.yaml",
		"/etc/passwd",
		"",
		"   ",
		"x".repeat(257),
	]) {
		assert.ok("refused" in specTokens(spec), JSON.stringify(spec));
	}
});

// Tools against stub programs.

interface Reply {
	stdout?: string;
	stderr?: string;
	code?: number;
	sleepMs?: number;
}

interface StubSpack {
	root: string;
	bin: string;
	calls(): Array<{ argv: string[]; env: Record<string, string> }>;
}

/**
 * A stub `spack` in `<root>/bin`, run by an absolute node so no shell adds
 * variables. It records each call's argv and environment and answers from
 * `replies`, keyed by the argv joined with spaces; with `version`, the
 * checkout around it declares that Spack version.
 */
function stubSpack(replies: Record<string, Reply>, version: string | null = "1.2.2"): StubSpack {
	const root = mkdtempSync(join(tmpdir(), "kit-spack-"));
	const bin = join(root, "bin");
	mkdirSync(bin);
	if (version !== null) {
		mkdirSync(join(root, "lib", "spack", "spack"), { recursive: true });
		writeFileSync(join(root, "lib", "spack", "spack", "__init__.py"), `__version__ = "${version}"\n`);
	}
	writeFileSync(join(root, "replies.json"), JSON.stringify(replies));
	const log = join(root, "calls.jsonl");
	const program = join(bin, "spack");
	writeFileSync(
		program,
		`#!${process.execPath}
const fs = process.getBuiltinModule("node:fs");
const argv = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ argv, env: process.env }) + "\\n");
const replies = JSON.parse(fs.readFileSync(${JSON.stringify(join(root, "replies.json"))}, "utf8"));
const reply = replies[argv.join(" ")] ?? { stderr: "==> Error: the stub has no reply for " + argv.join(" ") + "\\n", code: 3 };
const finish = () => {
	if (reply.stdout) fs.writeSync(1, reply.stdout);
	if (reply.stderr) fs.writeSync(2, reply.stderr);
	process.exit(reply.code ?? 0);
};
if (reply.sleepMs) setTimeout(finish, reply.sleepMs);
else finish();
`,
	);
	chmodSync(program, 0o755);
	return {
		root,
		bin,
		calls: () =>
			existsSync(log)
				? readFileSync(log, "utf8")
						.trim()
						.split("\n")
						.map((line) => JSON.parse(line))
				: [],
	};
}

const context = { signal: new AbortController().signal, log: () => {} };

function tool(name: string): AnyTool {
	const found = server.tools.find((entry) => entry.name === name);
	assert.ok(found, name);
	return found;
}

async function run(name: string, args: Record<string, unknown> = {}) {
	return (await tool(name).run(args as never, context)) as { json?: Record<string, unknown>; error?: string };
}

/** Run `body` with PATH and every variable the server reads set as given, all others of those unset. */
async function withEnv<T>(values: Record<string, string>, body: () => Promise<T>): Promise<T> {
	const names = ["PATH", ...environment];
	const saved = new Map(names.map((name) => [name, process.env[name]]));
	for (const name of names) delete process.env[name];
	Object.assign(process.env, values);
	try {
		return await body();
	} finally {
		for (const [name, value] of saved) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	}
}

/** The environment a spack command gets: the base allowlist and the server's names where set, and LC_ALL=C. */
function expectedEnv(): Record<string, string> {
	const env: Record<string, string> = {};
	for (const name of [...BASE_ENV_ALLOWLIST, ...environment]) {
		const value = process.env[name];
		if (value !== undefined) env[name] = value;
	}
	return { ...env, LC_ALL: "C" };
}

const FIND_ALL = {
	"--color=never -E find --json --deps": { stdout: JSON.stringify([ZLIB_RECORD, GCC_RECORD, GLIBC_RECORD]) },
	"--color=never -E find --format {hash} {prefix}": {
		stdout: `${ZLIB_HASH} /opt/spack/opt/spack/linux-x86_64_v4/zlib-1.2.13-${ZLIB_HASH}\n${GCC_HASH} /usr\n`,
	},
	"--color=never -E find --explicit --format {hash}": { stdout: `${ZLIB_HASH}\n` },
};

test("spack_find runs three find commands with --color=never and only the allowlisted environment", {
	skip: process.platform === "win32",
}, async () => {
	const spack = stubSpack(FIND_ALL);
	await withEnv({ PATH: spack.bin, SPACK_DISABLE_LOCAL_CONFIG: "1" }, async () => {
		const result = await run("spack_find");
		assert.ok(result.json, JSON.stringify(result));
		assert.equal(result.json.spackVersion, "1.2.2");
		assert.equal(result.json.total, 2);
		assert.deepEqual(result.json.specs, [
			{
				name: "zlib",
				version: "1.2.13",
				hash: "dhj67yl",
				namespace: "builtin",
				architecture: "linux-ubuntu24.04-x86_64_v4",
				compilers: [{ name: "gcc", version: "13.3.0", languages: ["c", "cxx"] }],
				prefix: `/opt/spack/opt/spack/linux-x86_64_v4/zlib-1.2.13-${ZLIB_HASH}`,
				external: false,
				explicit: true,
			},
			{
				name: "gcc",
				version: "13.3.0",
				hash: "zpevy7h",
				namespace: "builtin",
				architecture: "linux-ubuntu24.04-x86_64",
				compilers: [],
				prefix: "/usr",
				external: true,
				explicit: false,
			},
		]);
		const calls = spack.calls();
		assert.deepEqual(calls.map((call) => call.argv.join(" ")).sort(), Object.keys(FIND_ALL).sort());
		for (const call of calls) assert.deepEqual(call.env, expectedEnv());
		assert.equal(calls[0]?.env.SPACK_DISABLE_LOCAL_CONFIG, "1");
	});
});

test("spack_find in an environment passes -e <name>, and a spec is checked for repositories first", {
	skip: process.platform === "win32",
}, async () => {
	const spack = stubSpack({
		"--color=never -E repo list --json": { stdout: REPO_LIST_JSON.replace("uninitialized", "installed") },
		"--color=never -e demo find --json --deps zlib@1.2 +shared": { stdout: JSON.stringify([ZLIB_RECORD]) },
		"--color=never -e demo find --format {hash} {prefix} zlib@1.2 +shared": { stdout: `${ZLIB_HASH} /opt/z\n` },
		"--color=never -e demo find --explicit --format {hash} zlib@1.2 +shared": {
			stderr: "==> Error: No package matches the query: zlib@1.2 +shared\n",
			code: 1,
		},
	});
	await withEnv({ PATH: spack.bin }, async () => {
		const result = await run("spack_find", { spec: "zlib@1.2 +shared", environment: "demo" });
		assert.equal(result.json?.environment, "demo");
		assert.deepEqual(
			(result.json?.specs as Array<Record<string, unknown>>).map((spec) => [spec.hash, spec.explicit]),
			[["dhj67yl", false]],
		);
		assert.deepEqual(spack.calls()[0]?.argv, ["--color=never", "-E", "repo", "list", "--json"]);
		assert.equal(spack.calls().length, 4);
	});
});

test("spack_find with no match returns an empty list and Spack's message", {
	skip: process.platform === "win32",
}, async () => {
	const noMatch = { stderr: "==> Error: No package matches the query: zlib@9\n", code: 1 };
	const spack = stubSpack({
		"--color=never -E repo list --json": { stdout: "[]" },
		"--color=never -E find --json --deps zlib@9": noMatch,
		"--color=never -E find --format {hash} {prefix} zlib@9": noMatch,
		"--color=never -E find --explicit --format {hash} zlib@9": noMatch,
	});
	await withEnv({ PATH: spack.bin }, async () => {
		const result = await run("spack_find", { spec: "zlib@9" });
		assert.deepEqual(result.json?.specs, []);
		assert.equal(result.json?.message, "No package matches the query: zlib@9");
	});
});

test("bad arguments are refused before anything is spawned", { skip: process.platform === "win32" }, async () => {
	const spack = stubSpack({});
	await withEnv({ PATH: spack.bin }, async () => {
		const refusals: Array<[string, Record<string, unknown>]> = [
			["spack_find", { spec: 'zlib"' }],
			["spack_find", { spec: "zlib; rm -rf /" }],
			["spack_find", { spec: "zlib -v" }],
			["spack_find", { environment: "-x" }],
			["spack_find", { environment: "../other" }],
			["spack_info", { package: "--help" }],
			["spack_info", { package: "Zlib" }],
			["spack_locate", { spec: "--install-dir" }],
			["spack_locate", { spec: "zlib", package: "zlib" }],
			["spack_locate", {}],
			["spack_spec", { spec: "./spec.json" }],
			["spack_spec", { spec: "zlib $(id)" }],
			["spack_env", { environment: "-e" }],
		];
		for (const [name, args] of refusals) {
			const result = await run(name, args);
			assert.match(result.error ?? "", new RegExp(`^${name}: `), `${name} ${JSON.stringify(args)}`);
		}
	});
	assert.deepEqual(spack.calls(), []);
});

test("spack is found on PATH, else through SPACK_ROOT, and its absence is a tool error naming it", {
	skip: process.platform === "win32",
}, async () => {
	const spack = stubSpack(FIND_ALL, "1.1.0");
	const empty = mkdtempSync(join(tmpdir(), "kit-spack-empty-"));
	await withEnv({ PATH: empty, SPACK_ROOT: spack.root }, async () => {
		const result = await run("spack_find");
		assert.equal(result.json?.spackVersion, "1.1.0");
		const probed = await probe();
		assert.equal(probed.available, true);
		assert.match(probed.sources?.[0]?.detail ?? "", /\(via SPACK_ROOT\), version 1\.1\.0$/);
	});
	await withEnv({ PATH: spack.bin }, async () => {
		const probed = await probe();
		assert.match(probed.sources?.[0]?.detail ?? "", /\(via PATH\), version 1\.1\.0$/);
	});
	await withEnv({ PATH: empty, SPACK_ROOT: empty }, async () => {
		const calls: Record<string, Record<string, unknown>> = {
			spack_find: {},
			spack_info: { package: "zlib" },
			spack_locate: { package: "zlib" },
			spack_spec: { spec: "zlib" },
			spack_env: {},
		};
		for (const [name, args] of Object.entries(calls)) {
			assert.equal((await run(name, args)).error, `${name}: ${SPACK_MISSING}`);
		}
		assert.deepEqual(await probe(), {
			available: false,
			reason: SPACK_MISSING,
			sources: [{ name: "spack", found: false, detail: SPACK_MISSING }],
		});
	});
	// The probe and the version read run nothing.
	assert.equal(spack.calls().length, 3);
});

test("a read tool refuses, naming the command to run, while a package repository is not fetched", {
	skip: process.platform === "win32",
}, async () => {
	const absent = stubSpack({ "--color=never -E repo list --json": { stdout: REPO_LIST_JSON } });
	await withEnv({ PATH: absent.bin }, async () => {
		for (const [name, args] of [
			["spack_info", { package: "zlib" }],
			["spack_locate", { package: "zlib" }],
			["spack_locate", { spec: "zlib@1.2.13" }],
			["spack_find", { spec: "mpi" }],
		] as const) {
			const result = await run(name, args);
			assert.equal(result.json?.available, false, name);
			assert.match(String(result.json?.reason), /Run `spack repo update builtin` once/);
		}
	});
	assert.ok(absent.calls().every((call) => call.argv.join(" ") === "--color=never -E repo list --json"));

	// Spack 1.0 and 1.1 have no --json on repo list; the server reads its text.
	const older = stubSpack({ "--color=never -E repo list": { stdout: REPO_LIST_TEXT_ABSENT } }, "1.1.0");
	await withEnv({ PATH: older.bin }, async () => {
		const result = await run("spack_info", { package: "zlib" });
		assert.match(String(result.json?.reason), /spack repo update builtin/);
	});

	// A hash names an installed spec without a repository lookup, and Spack before 1.0 ships its packages.
	const hash = stubSpack({ "--color=never -E location --install-dir /dhj67yl": { stdout: "/opt/z\n" } });
	await withEnv({ PATH: hash.bin }, async () => {
		assert.equal((await run("spack_locate", { spec: "/dhj67yl" })).json?.prefix, "/opt/z");
	});
	const legacy = stubSpack({ "--color=never -E info zlib": { stdout: INFO_ZLIB } }, "0.23.1");
	await withEnv({ PATH: legacy.bin }, async () => {
		assert.equal((await run("spack_info", { package: "zlib" })).json?.preferredVersion, "1.3.2");
	});
	assert.deepEqual(
		legacy.calls().map((call) => call.argv),
		[["--color=never", "-E", "info", "zlib"]],
	);
});

test("spack_locate returns a checked path and lists the matches of an ambiguous spec", {
	skip: process.platform === "win32",
}, async () => {
	const packageDir = mkdtempSync(join(tmpdir(), "kit-spack-pkg-"));
	writeFileSync(join(packageDir, "package.py"), "");
	const spack = stubSpack({
		"--color=never -E repo list --json": { stdout: "[]" },
		"--color=never -E location --package-dir zlib": { stdout: `${packageDir}\n` },
		"--color=never -E location --package-dir nosuch": { stdout: "/opt/spack-cache/packages/nosuch\n" },
		"--color=never -E location --install-dir zlib": { stderr: AMBIGUOUS, code: 1 },
	});
	await withEnv({ PATH: spack.bin }, async () => {
		assert.equal((await run("spack_locate", { package: "zlib" })).json?.packageDirectory, packageDir);
		assert.match((await run("spack_locate", { package: "nosuch" })).error ?? "", /no package named nosuch/);
		const ambiguous = await run("spack_locate", { spec: "zlib" });
		assert.match(ambiguous.error ?? "", /zlib matches 2 installed specs: dhj67yl zlib@1\.2\.13 .*; 5n7xcty zlib@1\.3\.2/);
	});
});

test("spack_info returns the parsed sections and counts the ones it could not read", {
	skip: process.platform === "win32",
}, async () => {
	const spack = stubSpack({
		"--color=never -E repo list --json": { stdout: "[]" },
		"--color=never -E info example": { stdout: INFO_BROKEN },
	});
	await withEnv({ PATH: spack.bin }, async () => {
		const result = await run("spack_info", { package: "example" });
		assert.equal(result.json?.variants, null);
		assert.equal(result.json?.unreadSectionsTotal, 1);
		const unavailable = result.json?.unavailable as Record<string, string>;
		assert.match(unavailable.variants ?? "", /could not read/);
		assert.match(unavailable.homepage ?? "", /no Homepage section/);
	});
});

test("spack_find and spack_spec respect their caps and say so", { skip: process.platform === "win32" }, async () => {
	const hash = (index: number) => index.toString(36).padStart(32, "a");
	const records = Array.from({ length: MAX_SPECS + 5 }, (_, index) => ({ name: `p${index}`, hash: hash(index) }));
	const nodes = Array.from({ length: MAX_NODES + 5 }, (_, index) => ({ name: `n${index}`, hash: hash(index) }));
	const spack = stubSpack({
		"--color=never -E find --json --deps": { stdout: JSON.stringify(records) },
		"--color=never -E find --format {hash} {prefix}": {
			stdout: records.map((record) => `${record.hash} /opt/${record.name}`).join("\n"),
		},
		"--color=never -E find --explicit --format {hash}": { stdout: "" },
		"--color=never -E spec --json big": { stdout: `${SPEC_NOTICES[0]}\n${specDocument(nodes)}\n` },
		"--color=never -E find --format {hash}": { stdout: `${hash(0)}\n` },
		"--color=never -E repo list --json": { stdout: "[]" },
	});
	await withEnv({ PATH: spack.bin }, async () => {
		const found = await run("spack_find");
		assert.equal((found.json?.specs as unknown[]).length, MAX_SPECS);
		assert.deepEqual([found.json?.total, found.json?.cap, found.json?.truncated], [MAX_SPECS + 5, MAX_SPECS, true]);
		const spec = await run("spack_spec", { spec: "big" });
		const listed = spec.json?.nodes as Array<Record<string, unknown>>;
		assert.equal(listed.length, MAX_NODES);
		assert.deepEqual([spec.json?.total, spec.json?.cap, spec.json?.truncated], [MAX_NODES + 5, MAX_NODES, true]);
		assert.deepEqual([listed[0]?.installed, listed[1]?.installed], [true, false]);
		assert.deepEqual(spec.json?.notices, [SPEC_NOTICES[0]]);
		assert.equal(spec.json?.toInstall, MAX_NODES + 4);
	});
});

test("a command that outlives its timeout is a tool error that says so", {
	skip: process.platform === "win32",
}, async () => {
	const spack = stubSpack({
		"--color=never env status": { stdout: "==> No active environment\n" },
		"--color=never -E env list": { stdout: "    demo\n" },
		"--color=never -e demo find -r": { sleepMs: 10_000 },
		"--color=never -e demo find --json": { stdout: "[]" },
	});
	const saved = SPACK_TIMEOUTS.readMs;
	SPACK_TIMEOUTS.readMs = 300;
	try {
		await withEnv({ PATH: spack.bin }, async () => {
			const result = await run("spack_env", { environment: "demo" });
			assert.match(result.error ?? "", /^spack_env: spack -e demo find timed out after 0\.3 seconds$/);
		});
	} finally {
		SPACK_TIMEOUTS.readMs = saved;
	}
});

test("spack_env reads status and list, and the roots of the named environment through -e", {
	skip: process.platform === "win32",
}, async () => {
	const spack = stubSpack({
		"--color=never env status": { stdout: "==> No active environment\n" },
		"--color=never -E env list": { stdout: "    demo\n    empty-env\n" },
		"--color=never -e demo find -r": { stdout: ENV_ROOTS },
		"--color=never -e demo find --json": { stdout: JSON.stringify([ZLIB_RECORD, GCC_RECORD]) },
	});
	await withEnv({ PATH: spack.bin }, async () => {
		const result = await run("spack_env", { environment: "demo" });
		assert.deepEqual(result.json?.environments, ["demo", "empty-env"]);
		assert.equal(result.json?.active, null);
		assert.deepEqual(result.json?.environment, {
			name: "demo",
			roots: [
				{ spec: "zlib@1.2.13", status: "installed", installed: true },
				{ spec: "zlib-ng", status: "absent", installed: false },
			],
			rootsTotal: 2,
			declaredRoots: 2,
			installedRoots: 1,
			cap: 200,
			truncated: false,
			unreadLines: 0,
			installedSpecs: 2,
		});
		const none = await run("spack_env");
		assert.equal(none.json?.environment, null);
		assert.match((none.json?.unavailable as Record<string, string>).environment ?? "", /none is active/);
	});
	assert.deepEqual(
		spack
			.calls()
			.map((call) => call.argv.join(" "))
			.sort(),
		[
			"--color=never -E env list",
			"--color=never -E env list",
			"--color=never -e demo find --json",
			"--color=never -e demo find -r",
			"--color=never env status",
			"--color=never env status",
		],
	);
});
