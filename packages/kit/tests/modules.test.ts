// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AnyTool } from "@pancode/sdk/tool";
import { environment, probe, server } from "../src/servers/modules/index.js";
import { findModuleTool, passedVariables } from "../src/servers/modules/locate.js";
import {
	markDefaults,
	moduleNameProblem,
	parseLmodShow,
	parseLmodSpiderDetail,
	parseLmodTerseAvail,
	parseLmodTerseList,
	parseLmodTerseNames,
	parseLmodTerseSpider,
	parseLmodVersion,
	parseModulesJsonAvail,
	parseModulesJsonList,
	parseModulesJsonSavelist,
	parseModulesSaveshow,
	parseModulesShow,
	parseModulesVersion,
	tclWords,
	versionAtLeast,
} from "../src/servers/modules/parse.js";
import { MAX_LISTED, MAX_MODULEFILE_BYTES, MAX_PLAN_SHOWS, PLAN_DEPTH } from "../src/servers/modules/tools.js";

/**
 * The modules server. Where each input comes from:
 * - captured from Lmod 9.5 (stderr of `$LMOD_CMD bash ...`, modulefile
 *   directories replaced by /apps/modulefiles): LMOD_VERSION, LMOD_LIST,
 *   LMOD_AVAIL, LMOD_AVAIL_DEFAULTS, LMOD_SHOW_GCC, LMOD_SHOW_HDF5,
 *   LMOD_SHOW_CMAKE, LMOD_SPIDER_ALL, LMOD_SPIDER_GCC, LMOD_SPIDER_OPENMPI,
 *   LMOD_SPIDER_GCC_PAGE, LMOD_SAVELIST, LMOD_DESCRIBE;
 * - captured from Environment Modules 5.7.0 (stderr of
 *   `$MODULES_CMD bash ...`, the same replacement, and the home directory
 *   replaced by /home/user): MODULES_VERSION, MODULES_LIST, MODULES_AVAIL,
 *   MODULES_AVAIL_DEFAULTS, MODULES_SHOW_FFTW, MODULES_SHOW_HDF5,
 *   MODULES_SAVELIST, MODULES_SAVESHOW;
 * - constructed: the malformed inputs, "VERSION=3.2.10" (the form of
 *   Environment Modules 3), and every stub program's output below.
 * The tools run in process against stub programs that record their argv and
 * environment.
 */

const LMOD_VERSION = `
Modules based on Lua: Version 9.5 2026-11-19 19:10 -06:00
    https://lmod.readthedocs.io
`;
const MODULES_VERSION = "Modules Release 5.7.0 (2026-09-21)\n";

const LMOD_LIST = "gcc/12.3.0\nopenmpi/4.1.6\npython/3.11.9\ncmake/3.27.9\n";
const MODULES_LIST = `{"python/3.11.9": { "name": "python/3.11.9", "type": "modulefile", "variants": {}, "symbols": [ "default" ], "tags": [], "pathname": "/apps/modulefiles/tcl/python/3.11.9", "via": []},
"zlib/1.3.1": { "name": "zlib/1.3.1", "type": "modulefile", "variants": {}, "symbols": [], "tags": [ "auto-loaded" ], "pathname": "/apps/modulefiles/tcl2/zlib/1.3.1", "via": []},
"fftw/3.3.10": { "name": "fftw/3.3.10", "type": "modulefile", "variants": {}, "symbols": [], "tags": [], "pathname": "/apps/modulefiles/tcl/fftw/3.3.10", "via": []},
"hdf5/1.14.3": { "name": "hdf5/1.14.3", "type": "modulefile", "variants": {}, "symbols": [], "tags": [], "pathname": "/apps/modulefiles/tcl/hdf5/1.14.3", "via": []}}
`;

const LMOD_AVAIL = `/apps/modulefiles/hier/gcc/12.3.0:
openmpi/
openmpi/4.1.6
/apps/modulefiles/lua:
cmake/
cmake/3.27.9
gcc/
gcc/12.3.0
gcc/13.2.0
/apps/modulefiles/tcl:
fftw/
fftw/3.3.10
hdf5/
hdf5/1.14.3
python/
python/3.11.9
python/3.12.4
/apps/modulefiles/tcl2:
python/
python/3.10.14
zlib/
zlib/1.3.1
`;
const LMOD_AVAIL_DEFAULTS = `/apps/modulefiles/hier/gcc/12.3.0:
openmpi/4.1.6
/apps/modulefiles/lua:
cmake/3.27.9
gcc/12.3.0
/apps/modulefiles/tcl:
fftw/3.3.10
hdf5/1.14.3
python/3.11.9
/apps/modulefiles/tcl2:
zlib/1.3.1
`;

const MODULES_AVAIL = `{"/apps/modulefiles/tcl": {
"fftw/3.3.10": { "name": "fftw/3.3.10", "type": "modulefile", "symbols": [], "tags": [ "loaded" ], "pathname": "/apps/modulefiles/tcl/fftw/3.3.10", "via": []},
"hdf5/1.14.3": { "name": "hdf5/1.14.3", "type": "modulefile", "symbols": [], "tags": [ "loaded" ], "pathname": "/apps/modulefiles/tcl/hdf5/1.14.3", "via": []},
"python/3.11.9": { "name": "python/3.11.9", "type": "modulefile", "symbols": [ "default" ], "tags": [ "loaded" ], "pathname": "/apps/modulefiles/tcl/python/3.11.9", "via": []},
"python/3.12.4": { "name": "python/3.12.4", "type": "modulefile", "symbols": [], "tags": [], "pathname": "/apps/modulefiles/tcl/python/3.12.4", "via": []}
},
"/apps/modulefiles/tcl2": {
"python/3.10.14": { "name": "python/3.10.14", "type": "modulefile", "symbols": [], "tags": [], "pathname": "/apps/modulefiles/tcl2/python/3.10.14", "via": []},
"zlib/1.3.1": { "name": "zlib/1.3.1", "type": "modulefile", "symbols": [], "tags": [ "auto-loaded" ], "pathname": "/apps/modulefiles/tcl2/zlib/1.3.1", "via": []}
}}
`;
const MODULES_AVAIL_DEFAULTS = `{"/apps/modulefiles/tcl": {
"fftw/3.3.10": { "name": "fftw/3.3.10", "type": "modulefile", "symbols": [], "tags": [ "loaded" ], "pathname": "/apps/modulefiles/tcl/fftw/3.3.10", "via": []},
"hdf5/1.14.3": { "name": "hdf5/1.14.3", "type": "modulefile", "symbols": [], "tags": [ "loaded" ], "pathname": "/apps/modulefiles/tcl/hdf5/1.14.3", "via": []},
"python/3.11.9": { "name": "python/3.11.9", "type": "modulefile", "symbols": [ "default" ], "tags": [ "loaded" ], "pathname": "/apps/modulefiles/tcl/python/3.11.9", "via": []}
},
"/apps/modulefiles/tcl2": {
"python/3.10.14": { "name": "python/3.10.14", "type": "modulefile", "symbols": [], "tags": [], "pathname": "/apps/modulefiles/tcl2/python/3.10.14", "via": []},
"zlib/1.3.1": { "name": "zlib/1.3.1", "type": "modulefile", "symbols": [], "tags": [ "auto-loaded" ], "pathname": "/apps/modulefiles/tcl2/zlib/1.3.1", "via": []}
}}
`;

const DASHES = "-".repeat(76);
const LMOD_SHOW_GCC = `${DASHES}
   /apps/modulefiles/lua/gcc/12.3.0.lua:
${DASHES}
whatis("GNU compiler collection 12.3.0")
help([[The GNU compilers.
Second help line.]])
family("compiler")
setenv("GCC_ROOT","/opt/gcc/12.3.0")
prepend_path("PATH","/opt/gcc/12.3.0/bin")
prepend_path("LD_LIBRARY_PATH","/opt/gcc/12.3.0/lib64")
prepend_path("MODULEPATH","/apps/modulefiles/hier/gcc/12.3.0")

`;
const LMOD_SHOW_HDF5 = `${DASHES}
   /apps/modulefiles/tcl/hdf5/1.14.3:
${DASHES}
whatis("HDF5 1.14.3")
prereq_any("zlib")
prereq_any("fftw")
setenv("HDF5_DIR","/opt/hdf5/1.14.3")
prepend_path{"PATH","/opt/hdf5/1.14.3/bin",delim=":",priority="0"}

`;
const LMOD_SHOW_CMAKE = `${DASHES}
   /apps/modulefiles/lua/cmake/3.27.9.lua:
${DASHES}
whatis("CMake build system")
depends_on("gcc/12.3.0")
conflict("cmake3")
append_path("PATH","/opt/cmake/3.27.9/bin")

`;

const MODULES_DASHES = "-".repeat(67);
const MODULES_SHOW_FFTW = `${MODULES_DASHES}
/apps/modulefiles/tcl/fftw/3.3.10:

module-whatis\t{FFTW 3.3.10}
module\t\tload zlib
setenv\t\tFFTW_ROOT /opt/fftw/3.3.10
append-path\tPKG_CONFIG_PATH /opt/fftw/3.3.10/lib/pkgconfig
${MODULES_DASHES}
`;
const MODULES_SHOW_HDF5 = `${MODULES_DASHES}
/apps/modulefiles/tcl/hdf5/1.14.3:

module-whatis\t{HDF5 1.14.3}
prereq\t\tzlib
prereq\t\tfftw
setenv\t\tHDF5_DIR /opt/hdf5/1.14.3
prepend-path\tPATH /opt/hdf5/1.14.3/bin
${MODULES_DASHES}
`;

const LMOD_SPIDER_ALL = `cmake/
cmake/3.27.9
gcc/
gcc/12.3.0
gcc/13.2.0
openmpi/
openmpi/4.1.6
python/
python/3.10.14
python/3.11.9
python/3.12.4
`;
const LMOD_SPIDER_GCC = "gcc/12.3.0\ngcc/13.2.0\n";
const WIDE = "-".repeat(296);
const LMOD_SPIDER_OPENMPI = `
${WIDE}
  openmpi: openmpi/4.1.6
${WIDE}

    You will need to load all module(s) on any one of the lines below before the "openmpi/4.1.6" module is available to load.

      gcc/12.3.0
 

 
`;
const LMOD_SPIDER_GCC_PAGE = `
${WIDE}
  gcc: gcc/12.3.0
${WIDE}

    This module can be loaded directly: module load gcc/12.3.0

    Help:
      The GNU compilers.
      Second help line.


 
`;

const LMOD_SAVELIST = "default\nmytools\n";
const LMOD_DESCRIBE = "gcc\nopenmpi\npython\n";
const MODULES_SAVELIST = `{"default": { "name": "default", "target": "", "pathname": "/home/user/.module/default"},
"mytools": { "name": "mytools", "target": "", "pathname": "/home/user/.module/mytools"}}
`;
const MODULES_SAVESHOW = `${MODULES_DASHES}
/home/user/.module/mytools:

module use --append /apps/modulefiles/tcl
module use --append /apps/modulefiles/tcl2
module load python
module load --tag=auto-loaded zlib
module load fftw

${MODULES_DASHES}
`;

// parsers ---------------------------------------------------------------------

test("module names that could reach argv as an option or split into words are refused", () => {
	assert.equal(moduleNameProblem("gcc/12.3.0", "name"), null);
	assert.equal(moduleNameProblem("py-numpy/1.26+mkl", "name"), null);
	assert.match(moduleNameProblem("-rf", "name") ?? "", /must not begin with -/);
	for (const bad of ["a b", "x;y", "$(id)", "gcc\n", "", "../x"])
		assert.notEqual(moduleNameProblem(bad, "name"), null, JSON.stringify(bad));
	assert.match(moduleNameProblem("a".repeat(129), "name") ?? "", /at most 128/);
	assert.match(moduleNameProblem(3, "name") ?? "", /must be a string/);
});

test("versions: Lmod, Environment Modules 4+ and 3, and comparison", () => {
	assert.equal(parseLmodVersion(LMOD_VERSION), "9.5");
	assert.equal(parseModulesVersion(MODULES_VERSION), "5.7.0");
	assert.equal(parseModulesVersion("VERSION=3.2.10\nDATE=2012-12-21\n"), "3.2.10");
	assert.equal(parseLmodVersion("command not found"), null);
	assert.equal(versionAtLeast("5.7.0", [4, 5]), true);
	assert.equal(versionAtLeast("4.5", [4, 5]), true);
	assert.equal(versionAtLeast("4.4.1", [4, 5]), false);
	assert.equal(versionAtLeast("3.2.10", [4, 5]), false);
	assert.equal(versionAtLeast("git", [4, 5]), null);
});

test("list: Lmod terse and Environment Modules JSON, in load order", () => {
	const lmod = parseLmodTerseList(LMOD_LIST);
	assert.deepEqual(
		lmod?.modules.map((entry) => entry.fullName),
		["gcc/12.3.0", "openmpi/4.1.6", "python/3.11.9", "cmake/3.27.9"],
	);
	assert.deepEqual(lmod?.modules[0], { fullName: "gcc/12.3.0", name: "gcc", version: "12.3.0" });
	assert.deepEqual(parseLmodTerseList("No modules loaded\n"), { modules: [], malformedLines: 0 });
	const modules = parseModulesJsonList(MODULES_LIST);
	assert.deepEqual(
		modules?.modules.map((entry) => entry.fullName),
		["python/3.11.9", "zlib/1.3.1", "fftw/3.3.10", "hdf5/1.14.3"],
	);
	assert.deepEqual(parseModulesJsonList("{}"), { modules: [], malformedLines: 0 });
	assert.equal(parseLmodTerseList("gcc/12.3.0\nnot a module line\n")?.malformedLines, 1);
	assert.equal(parseModulesJsonList("module: command not found"), null);
	assert.equal(parseModulesJsonList(`{"x/1": 3, "y/2": {"name": "y/2"}}`)?.malformedLines, 1);
});

test("avail: directories, hierarchy and defaults from both tools", () => {
	const lmod = parseLmodTerseAvail(LMOD_AVAIL);
	assert.ok(lmod);
	assert.equal(lmod.modules.length, 10);
	assert.deepEqual(lmod.modules[0], {
		fullName: "openmpi/4.1.6",
		name: "openmpi",
		version: "4.1.6",
		modulepath: "/apps/modulefiles/hier/gcc/12.3.0",
	});
	const lmodDefaults = parseLmodTerseAvail(LMOD_AVAIL_DEFAULTS);
	assert.ok(lmodDefaults);
	const marked = markDefaults(lmod.modules, lmodDefaults.modules);
	assert.deepEqual(
		marked.filter((row) => row.isDefault).map((row) => row.fullName),
		["openmpi/4.1.6", "cmake/3.27.9", "gcc/12.3.0", "fftw/3.3.10", "hdf5/1.14.3", "python/3.11.9", "zlib/1.3.1"],
	);

	const modules = parseModulesJsonAvail(MODULES_AVAIL);
	const modulesDefaults = parseModulesJsonAvail(MODULES_AVAIL_DEFAULTS);
	assert.ok(modules && modulesDefaults);
	const python = markDefaults(modules.modules, modulesDefaults.modules).filter((row) => row.name === "python");
	// -d lists python/3.10.14 as the default of /apps/modulefiles/tcl2, but tcl comes first on MODULEPATH.
	assert.deepEqual(
		python.map((row) => [row.fullName, row.modulepath, row.isDefault]),
		[
			["python/3.11.9", "/apps/modulefiles/tcl", true],
			["python/3.12.4", "/apps/modulefiles/tcl", false],
			["python/3.10.14", "/apps/modulefiles/tcl2", false],
		],
	);
	assert.deepEqual(parseModulesJsonAvail("{}"), { modules: [], malformedLines: 0 });
	assert.deepEqual(parseLmodTerseAvail(""), { modules: [], malformedLines: 0 });

	const broken = parseLmodTerseAvail("/apps/modulefiles/lua:\ngcc/12.3.0\n!! garbage !!\n");
	assert.equal(broken?.modules.length, 1);
	assert.equal(broken?.malformedLines, 1);
	assert.equal(parseModulesJsonAvail("[1, 2]"), null);
});

test("show: Lmod on a Lua and a Tcl modulefile", () => {
	const gcc = parseLmodShow(LMOD_SHOW_GCC);
	assert.ok(gcc);
	assert.equal(gcc.modulefile, "/apps/modulefiles/lua/gcc/12.3.0.lua");
	assert.equal(gcc.unreadLines, 0);
	assert.deepEqual(gcc.directives.setenv, [{ name: "GCC_ROOT", value: "/opt/gcc/12.3.0" }]);
	assert.deepEqual(
		gcc.directives.prependPath.map((change) => change.name),
		["PATH", "LD_LIBRARY_PATH", "MODULEPATH"],
	);
	assert.deepEqual(gcc.directives.families, ["compiler"]);
	assert.deepEqual(gcc.directives.whatis, ["GNU compiler collection 12.3.0"]);

	const hdf5 = parseLmodShow(LMOD_SHOW_HDF5);
	assert.ok(hdf5);
	assert.equal(hdf5.modulefile, "/apps/modulefiles/tcl/hdf5/1.14.3");
	assert.deepEqual(hdf5.directives.requires, [{ anyOf: ["zlib"] }, { anyOf: ["fftw"] }]);
	assert.deepEqual(hdf5.directives.prependPath, [{ name: "PATH", value: "/opt/hdf5/1.14.3/bin" }]);

	const cmake = parseLmodShow(LMOD_SHOW_CMAKE);
	assert.deepEqual(cmake?.directives.loads, ["gcc/12.3.0"]);
	assert.deepEqual(cmake?.directives.conflicts, ["cmake3"]);
	assert.deepEqual(cmake?.directives.appendPath, [{ name: "PATH", value: "/opt/cmake/3.27.9/bin" }]);

	const odd = parseLmodShow(LMOD_SHOW_CMAKE.replace('conflict("cmake3")', "os.exit(1) -- not a directive"));
	assert.equal(odd?.unreadLines, 1);
	assert.equal(parseLmodShow("Lmod has detected the following error: Failed to find\n"), null);
});

test("show: Environment Modules on Tcl modulefiles", () => {
	const fftw = parseModulesShow(MODULES_SHOW_FFTW);
	assert.ok(fftw);
	assert.equal(fftw.modulefile, "/apps/modulefiles/tcl/fftw/3.3.10");
	assert.deepEqual(fftw.directives.loads, ["zlib"]);
	assert.deepEqual(fftw.directives.whatis, ["FFTW 3.3.10"]);
	assert.deepEqual(fftw.directives.appendPath, [{ name: "PKG_CONFIG_PATH", value: "/opt/fftw/3.3.10/lib/pkgconfig" }]);
	assert.equal(fftw.unreadLines, 0);
	const hdf5 = parseModulesShow(MODULES_SHOW_HDF5);
	assert.deepEqual(hdf5?.directives.requires, [{ anyOf: ["zlib"] }, { anyOf: ["fftw"] }]);
	assert.deepEqual(hdf5?.directives.setenv, [{ name: "HDF5_DIR", value: "/opt/hdf5/1.14.3" }]);

	const odd = parseModulesShow(MODULES_SHOW_HDF5.replace("prereq\t\tfftw", "puts stderr {hello"));
	assert.equal(odd?.unreadLines, 1);
	assert.equal(parseModulesShow("ERROR: Unable to locate a modulefile for 'nope/1'\n"), null);
	assert.deepEqual(tclWords('setenv A "b c" {d e}'), ["setenv", "A", "b c", "d e"]);
	assert.equal(tclWords("setenv A {unclosed"), null);
});

test("spider: every name, one name's versions, and a version's page", () => {
	const all = parseLmodTerseSpider(LMOD_SPIDER_ALL);
	assert.deepEqual(all?.modules.find((entry) => entry.name === "python")?.versions, ["3.10.14", "3.11.9", "3.12.4"]);
	assert.equal(all?.modules.length, 4);
	assert.deepEqual(parseLmodTerseSpider(LMOD_SPIDER_GCC)?.modules, [{ name: "gcc", versions: ["12.3.0", "13.2.0"] }]);
	assert.deepEqual(parseLmodSpiderDetail(LMOD_SPIDER_OPENMPI), {
		fullName: "openmpi/4.1.6",
		loadableDirectly: false,
		loadFirst: [["gcc/12.3.0"]],
	});
	assert.deepEqual(parseLmodSpiderDetail(LMOD_SPIDER_GCC_PAGE), {
		fullName: "gcc/12.3.0",
		loadableDirectly: true,
		loadFirst: [],
	});
	assert.equal(parseLmodTerseSpider("gcc/12.3.0\n*** odd ***\n")?.malformedLines, 1);
	assert.equal(parseLmodTerseSpider("*** odd ***\n"), null);
	assert.equal(parseLmodSpiderDetail("no page here\n"), null);
});

test("collections: names and contents from both tools", () => {
	assert.deepEqual(parseLmodTerseNames(LMOD_SAVELIST), { names: ["default", "mytools"], malformedLines: 0 });
	assert.deepEqual(parseLmodTerseNames(LMOD_DESCRIBE)?.names, ["gcc", "openmpi", "python"]);
	assert.deepEqual(parseModulesJsonSavelist(MODULES_SAVELIST), { names: ["default", "mytools"], malformedLines: 0 });
	assert.deepEqual(parseModulesSaveshow(MODULES_SAVESHOW), {
		modules: ["python", "zlib", "fftw"],
		modulepath: ["/apps/modulefiles/tcl", "/apps/modulefiles/tcl2"],
		unreadLines: 0,
	});
	assert.equal(parseModulesSaveshow(MODULES_SAVESHOW.replace("module load fftw", "module swap a b"))?.unreadLines, 1);
	assert.equal(parseLmodTerseNames("Lmod Warning: something odd here\n"), null);
	assert.equal(parseModulesJsonSavelist("not json"), null);
	assert.equal(parseModulesSaveshow("ERROR: Collection nope cannot be found\n"), null);
});

// finding the tool ------------------------------------------------------------

function scratch(prefix: string): string {
	return mkdtempSync(join(tmpdir(), `pankit-modules-${prefix}-`));
}

function executable(path: string, body = "#!/bin/sh\nexit 0\n"): string {
	writeFileSync(path, body);
	chmodSync(path, 0o755);
	return path;
}

test("the tool is found through LMOD_CMD, then MODULES_CMD, then modulecmd on PATH", {
	skip: process.platform === "win32",
}, () => {
	const dir = scratch("find");
	const lmod = executable(join(dir, "lmod"));
	const tcl = executable(join(dir, "modulecmd.tcl"));
	const modulecmd = executable(join(dir, "modulecmd"));
	const empty = scratch("empty");

	const both = findModuleTool({ LMOD_CMD: lmod, MODULES_CMD: tcl, PATH: dir }, dir);
	assert.ok(both.ok);
	assert.deepEqual(both.tool, { kind: "lmod", program: lmod, via: "LMOD_CMD" });

	const modules = findModuleTool({ MODULES_CMD: tcl, PATH: dir }, dir);
	assert.ok(modules.ok);
	assert.deepEqual(modules.tool, { kind: "environment-modules", program: tcl, via: "MODULES_CMD" });

	const path = findModuleTool({ PATH: dir }, dir);
	assert.ok(path.ok);
	assert.deepEqual(path.tool, { kind: "environment-modules", program: modulecmd, via: "PATH" });

	const stale = findModuleTool({ LMOD_CMD: join(dir, "gone"), MODULES_CMD: tcl, PATH: empty }, dir);
	assert.ok(stale.ok);
	assert.equal(stale.tool.via, "MODULES_CMD");
	assert.deepEqual(stale.sources[0], {
		name: "LMOD_CMD",
		found: false,
		detail: `set to ${join(dir, "gone")}, which is not an executable file`,
	});
});

test("without a tool the reason names all three places and where they come from", async () => {
	const empty = scratch("none");
	const none = findModuleTool({ PATH: empty }, empty);
	assert.equal(none.ok, false);
	assert.ok(!none.ok);
	assert.match(none.reason, /LMOD_CMD/);
	assert.match(none.reason, /MODULES_CMD/);
	assert.match(none.reason, /modulecmd/);
	assert.match(none.reason, /module is a shell function/);
	assert.match(none.reason, /login shell PanCode or the MCP host was started from/);
	assert.deepEqual(
		none.sources.map((source) => [source.name, source.found]),
		[
			["LMOD_CMD", false],
			["MODULES_CMD", false],
			["modulecmd", false],
		],
	);
	const result = await withEnv({ LMOD_CMD: undefined, MODULES_CMD: undefined, PATH: empty }, () => probe());
	assert.equal(result.available, false);
	assert.match(result.reason ?? "", /No module tool found/);
});

test("the environment it declares passes the module variables and nothing else", () => {
	assert.deepEqual(
		[...environment],
		[
			"MODULEPATH",
			"MODULESHOME",
			"LOADEDMODULES",
			"_LMFILES_",
			"LMOD_*",
			"MODULES_*",
			"_ModuleTable*",
			"__LMOD_*",
			"__MODULES_*",
		],
	);
	assert.deepEqual(
		passedVariables({
			MODULEPATH: "/a",
			LMOD_CMD: "/l",
			LMOD_SYSTEM_NAME: "x",
			MODULES_CMD: "/m",
			_ModuleTable001_: "t",
			__LMOD_REF_COUNT_PATH: "p",
			_LMFILES_: "f",
			LMODX: "no",
			MODULEPATHS: "no",
			AWS_SECRET_ACCESS_KEY: "no",
		}),
		[
			"LMOD_CMD",
			"LMOD_SYSTEM_NAME",
			"MODULEPATH",
			"MODULES_CMD",
			"_LMFILES_",
			"_ModuleTable001_",
			"__LMOD_REF_COUNT_PATH",
		],
	);
});

// the tools against stub programs ---------------------------------------------

const context = { signal: new AbortController().signal, log: () => {}, progress: () => {} };

function tool(name: string): AnyTool {
	const found = server.tools.find((entry) => entry.name === name);
	assert.ok(found, name);
	return found;
}

async function run(name: string, args: Record<string, unknown> = {}): Promise<{ json?: unknown; error?: string }> {
	return (await tool(name).run(args as never, context)) as { json?: unknown; error?: string };
}

async function call(name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
	const result = await run(name, args);
	assert.ok("json" in result, JSON.stringify(result));
	return result.json as Record<string, unknown>;
}

async function withEnv<T>(values: Record<string, string | undefined>, body: () => Promise<T>): Promise<T> {
	const saved = Object.fromEntries(Object.keys(values).map((name) => [name, process.env[name]]));
	const apply = (from: Record<string, string | undefined>) => {
		for (const [name, value] of Object.entries(from)) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	};
	apply(values);
	try {
		return await body();
	} finally {
		apply(saved);
	}
}

interface Stub {
	dir: string;
	program: string;
	/** Each call's arguments after `bash`, in order. */
	calls(): string[];
	/** The environment the last call saw, for the variables it records. */
	lastEnv(): Record<string, string>;
	/** MODULEPATH as each call saw it. */
	modulepaths(): string[];
}

const RECORDED = [
	"LC_ALL",
	"LMOD_PAGER",
	"LMOD_COLORIZE",
	"LMOD_REDIRECT",
	"LMOD_TERSE_DECORATIONS",
	"LMOD_SITE_NAME",
	"MODULES_PAGER",
	"MODULES_COLOR",
	"MODULEPATH",
	"PANKIT_TEST_UNLISTED",
];

/**
 * A module tool that writes the stderr of `responses[<args after bash>]` (and
 * exits with its code) and records its argv and environment. It also prints
 * shell code on stdout, which the server must never use.
 */
function stub(name: string, responses: Record<string, { stderr: string; code?: number }>): Stub {
	const dir = scratch(name);
	const log = join(dir, "calls.log");
	const envLog = join(dir, "env.log");
	const paths = join(dir, "modulepath.log");
	const cases = Object.entries(responses).map(([args, response], index) => {
		const file = join(dir, `response-${index}.txt`);
		writeFileSync(file, response.stderr);
		return `\t${JSON.stringify(args)}) cat ${JSON.stringify(file)} >&2; echo 'export PANKIT_HACKED=1;'; exit ${response.code ?? 0} ;;`;
	});
	const record = RECORDED.map((variable) => `printf '%s=%s\\n' ${variable} "\${${variable}-<unset>}"`).join("\n");
	const program = executable(
		join(dir, name),
		`#!/bin/sh
[ "$1" = bash ] || exit 9
shift
printf '%s\\n' "$*" >> ${JSON.stringify(log)}
printf '%s\\n' "\${MODULEPATH-<unset>}" >> ${JSON.stringify(paths)}
{
${record}
} > ${JSON.stringify(envLog)}
case "$*" in
${cases.join("\n")}
	*) echo "stub: no response for $*" >&2; exit 3 ;;
esac
`,
	);
	const readLines = (file: string) =>
		existsSync(file)
			? readFileSync(file, "utf8")
					.split("\n")
					.filter((line) => line.length > 0)
			: [];
	return {
		dir,
		program,
		calls: () => readLines(log),
		modulepaths: () => readLines(paths),
		lastEnv: () =>
			Object.fromEntries(
				readLines(envLog).map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
			),
	};
}

const lmodVersion = { "--version": { stderr: LMOD_VERSION } };
const modulesVersion = { "--version": { stderr: MODULES_VERSION } };
const unix = { skip: process.platform === "win32" };

function asLmod<T>(fake: Stub, body: () => Promise<T>, extra: Record<string, string | undefined> = {}): Promise<T> {
	return withEnv({ LMOD_CMD: fake.program, MODULES_CMD: undefined, ...extra }, body);
}

function asModules<T>(fake: Stub, body: () => Promise<T>, extra: Record<string, string | undefined> = {}): Promise<T> {
	return withEnv({ LMOD_CMD: undefined, MODULES_CMD: fake.program, ...extra }, body);
}

test("Lmod avail: exact argv, pager and colour off, module variables passed and others not", unix, async () => {
	const fake = stub("lmod", {
		...lmodVersion,
		"-t avail py": { stderr: LMOD_AVAIL },
		"-t -d avail py": { stderr: LMOD_AVAIL_DEFAULTS },
	});
	const result = await asLmod(fake, () => call("modules_avail", { name: "py" }), {
		LMOD_SITE_NAME: "testsite",
		PANKIT_TEST_UNLISTED: "leak",
		LMOD_PAGER: "less",
		LMOD_COLORIZE: "yes",
	});
	assert.deepEqual(fake.calls(), ["--version", "-t avail py", "-t -d avail py"]);
	assert.deepEqual(fake.lastEnv(), {
		LC_ALL: "C",
		LMOD_PAGER: "none",
		LMOD_COLORIZE: "no",
		LMOD_REDIRECT: "no",
		LMOD_TERSE_DECORATIONS: "no",
		LMOD_SITE_NAME: "testsite",
		MODULES_PAGER: "<unset>",
		MODULES_COLOR: "<unset>",
		MODULEPATH: process.env.MODULEPATH ?? "<unset>",
		PANKIT_TEST_UNLISTED: "<unset>",
	});
	assert.equal(result.tool, "lmod");
	assert.equal(result.version, "9.5");
	assert.deepEqual(
		(result.modules as Array<Record<string, unknown>>).map((row) => [row.fullName, row.isDefault]),
		[
			["python/3.11.9", true],
			["python/3.12.4", false],
			["python/3.10.14", false],
		],
	);
	assert.equal(process.env.PANKIT_HACKED, undefined);
});

test(
	"Environment Modules avail: exact argv with options after the subcommand, pager and colour off",
	unix,
	async () => {
		const fake = stub("modulecmd", {
			...modulesVersion,
			"avail -j -C 3.1": { stderr: MODULES_AVAIL },
			"avail -d -j -C 3.1": { stderr: MODULES_AVAIL_DEFAULTS },
		});
		const result = await asModules(fake, () => call("modules_avail", { name: "3.1", match: "contains" }), {
			MODULES_PAGER: "less -R",
			MODULES_COLOR: "always",
		});
		assert.deepEqual(fake.calls(), ["--version", "avail -j -C 3.1", "avail -d -j -C 3.1"]);
		const env = fake.lastEnv();
		assert.equal(env.MODULES_PAGER, "");
		assert.equal(env.MODULES_COLOR, "never");
		assert.equal(env.LC_ALL, "C");
		assert.equal(env.LMOD_PAGER, "<unset>");
		assert.equal(result.tool, "environment-modules");
		assert.deepEqual(
			(result.modules as Array<Record<string, unknown>>).map((row) => row.fullName),
			["fftw/3.3.10", "python/3.11.9", "python/3.12.4", "python/3.10.14", "zlib/1.3.1"],
		);
	},
);

test("a name that is an option or not one word is refused before anything runs", unix, async () => {
	const fake = stub("lmod", { ...lmodVersion });
	const attempts: Array<[string, Record<string, unknown>]> = [
		["modules_avail", { name: "-t" }],
		["modules_avail", { name: "a b" }],
		["modules_show", { name: "--help" }],
		["modules_show", { name: "x;id" }],
		["modules_spider", { name: "-x" }],
		["modules_plan", { modules: ["gcc", "--force"] }],
		["modules_plan", { modules: [] }],
		["modules_collections", { name: "a b" }],
	];
	for (const [name, args] of attempts) {
		const result = await asLmod(fake, () => run(name, args));
		assert.ok("error" in result, `${name} ${JSON.stringify(args)}`);
	}
	assert.deepEqual(fake.calls(), []);
	// Checked before the tool is looked for, so the answer is the name's problem even with no tool.
	const result = await withEnv({ LMOD_CMD: undefined, MODULES_CMD: undefined, PATH: scratch("nopath") }, () =>
		run("modules_show", { name: "-rf" }),
	);
	assert.match(result.error ?? "", /must not begin with -/);
});

test("with no module tool every tool says why without running anything", async () => {
	const empty = scratch("notool");
	for (const name of ["modules_list", "modules_avail", "modules_collections"]) {
		const result = await withEnv({ LMOD_CMD: undefined, MODULES_CMD: undefined, PATH: empty }, () => run(name));
		assert.match(result.error ?? "", /No module tool found/);
	}
});

test("modules_spider on Environment Modules is unavailable and runs nothing", unix, async () => {
	const fake = stub("modulecmd", { ...modulesVersion });
	const result = await asModules(fake, () => run("modules_spider", { name: "gcc" }));
	assert.match(result.error ?? "", /Environment Modules/);
	assert.match(result.error ?? "", /modules_avail/);
	assert.deepEqual(fake.calls(), []);
});

test("modules_spider on Lmod: the versions, and for name/version what to load first", unix, async () => {
	const fake = stub("lmod", {
		...lmodVersion,
		"-t spider openmpi": { stderr: "openmpi/4.1.6\n" },
		"--width=300 spider openmpi/4.1.6": { stderr: LMOD_SPIDER_OPENMPI },
	});
	const result = await asLmod(fake, () => call("modules_spider", { name: "openmpi/4.1.6" }));
	assert.deepEqual(fake.calls(), ["--version", "-t spider openmpi", "--width=300 spider openmpi/4.1.6"]);
	assert.deepEqual(result.modules, [{ name: "openmpi", versions: ["4.1.6"] }]);
	assert.deepEqual(result.detail, { fullName: "openmpi/4.1.6", loadableDirectly: false, loadFirst: [["gcc/12.3.0"]] });
});

function lmodShow(path: string, body: string): { stderr: string } {
	return { stderr: `${DASHES}\n   ${path}:\n${DASHES}\n${body}\n` };
}

test("modules_show returns the directives and the modulefile's text, capped", unix, async () => {
	const files = scratch("files");
	const small = join(files, "small.lua");
	writeFileSync(small, 'setenv("A", "b")\n');
	const large = join(files, "large.lua");
	writeFileSync(large, `-- ${"x".repeat(MAX_MODULEFILE_BYTES + 100)}\n`);
	const fake = stub("lmod", {
		...lmodVersion,
		"show small": lmodShow(small, 'setenv("A","b")'),
		"show large": lmodShow(large, 'setenv("A","b")'),
		"show nope/1": {
			stderr:
				'Lmod has detected the following error:  Failed to find the following module(s):  "nope/1" in your\nMODULEPATH\n',
			code: 1,
		},
	});
	const shown = await asLmod(fake, () => call("modules_show", { name: "small" }));
	assert.equal(shown.modulefile, small);
	assert.equal(shown.text, 'setenv("A", "b")\n');
	assert.equal(shown.textTruncated, false);
	assert.deepEqual((shown.directives as Record<string, unknown>).setenv, [{ name: "A", value: "b" }]);
	const big = await asLmod(fake, () => call("modules_show", { name: "large" }));
	assert.equal((big.text as string).length, MAX_MODULEFILE_BYTES);
	assert.equal(big.textTruncated, true);
	assert.equal(big.textBytes, MAX_MODULEFILE_BYTES + 104);
	const missing = await asLmod(fake, () => run("modules_show", { name: "nope/1" }));
	assert.match(missing.error ?? "", /exited with 1: Lmod has detected the following error: +Failed to find/);
	assert.ok(!fake.calls().some((line) => /\bload\b/.test(line)));
});

test("modules_plan reads modules in order, follows declared needs, and never runs load", unix, async () => {
	const files = scratch("plan");
	const modulefile = (name: string) => {
		const path = join(files, name.replace("/", "-"));
		writeFileSync(path, "-- stub\n");
		return path;
	};
	const fake = stub("lmod", {
		...lmodVersion,
		"show gcc/12.3.0": lmodShow(
			modulefile("gcc/12.3.0"),
			'family("compiler")\nprepend_path("MODULEPATH","/apps/modulefiles/hier/gcc/12.3.0")',
		),
		"show openmpi/4.1.6": lmodShow(modulefile("openmpi/4.1.6"), 'prereq("gcc/12.3.0")\nfamily("mpi")'),
		"show hdf5": lmodShow(modulefile("hdf5"), 'prereq_any("zlib")\nprereq_any("fftw")'),
		"show zlib": lmodShow(modulefile("zlib"), 'setenv("ZLIB","1")'),
		"show fftw": lmodShow(modulefile("fftw"), 'load("zlib")'),
	});
	const result = await asLmod(fake, () => call("modules_plan", { modules: ["gcc/12.3.0", "openmpi/4.1.6", "hdf5"] }), {
		MODULEPATH: "/apps/modulefiles/lua",
	});
	assert.equal(result.declaredOnly, true);
	assert.match(
		result.note as string,
		/Conflicts, family swaps and conditionals are decided only when a module is really loaded/,
	);
	assert.deepEqual(result.commands, [
		"module load gcc/12.3.0",
		"module load openmpi/4.1.6",
		"module load zlib",
		"module load fftw",
		"module load hdf5",
	]);
	assert.deepEqual(result.addedForRequirements, ["zlib", "fftw"]);
	assert.deepEqual(result.modulepathAdded, ["/apps/modulefiles/hier/gcc/12.3.0"]);
	assert.deepEqual(fake.calls(), [
		"--version",
		"show gcc/12.3.0",
		"show openmpi/4.1.6",
		"show hdf5",
		"show zlib",
		"show fftw",
	]);
	// The modules after gcc are read with gcc's MODULEPATH addition in front, though nothing was loaded.
	assert.deepEqual(fake.modulepaths().slice(1, 3), [
		"/apps/modulefiles/lua",
		"/apps/modulefiles/hier/gcc/12.3.0:/apps/modulefiles/lua",
	]);
	assert.ok(!fake.calls().some((line) => /(^| )(load|restore|swap|purge)( |$)/.test(line)));
});

test("modules_plan stops at its depth and its count of shows and says so", unix, async () => {
	const files = scratch("plancap");
	const path = join(files, "m");
	writeFileSync(path, "-- stub\n");
	const chain: Record<string, { stderr: string }> = { ...lmodVersion };
	for (let index = 0; index <= PLAN_DEPTH + 2; index++)
		chain[`show c${index}`] = lmodShow(path, `prereq("c${index + 1}")`);
	const deep = stub("lmod", chain);
	const deepResult = await asLmod(deep, () => call("modules_plan", { modules: ["c0"] }));
	assert.equal(deepResult.depthLimitReached, true);
	assert.equal(deepResult.truncated, false);
	assert.equal(Math.max(...(deepResult.needs as Array<{ depth: number }>).map((need) => need.depth)), PLAN_DEPTH);
	assert.equal(deep.calls().length, 1 + 1 + PLAN_DEPTH);

	const wide: Record<string, { stderr: string }> = { ...lmodVersion };
	const requested = Array.from({ length: 20 }, (_, index) => `m${index}`);
	for (const name of requested) {
		const needs = Array.from({ length: 6 }, (_, index) => `${name}n${index}`);
		wide[`show ${name}`] = lmodShow(path, needs.map((need) => `prereq("${need}")`).join("\n"));
		for (const need of needs) wide[`show ${need}`] = lmodShow(path, 'setenv("X","1")');
	}
	const many = stub("lmod", wide);
	const manyResult = await asLmod(many, () => call("modules_plan", { modules: requested }));
	assert.equal(manyResult.truncated, true);
	assert.equal(manyResult.showsRun, MAX_PLAN_SHOWS);
	assert.equal(many.calls().length, 1 + MAX_PLAN_SHOWS);
});

test("lists respect their cap and say they were cut", unix, async () => {
	const names = Array.from({ length: MAX_LISTED + 20 }, (_, index) => `tool${index}/1.0`);
	const fake = stub("lmod", {
		...lmodVersion,
		"-t avail": { stderr: `/apps/modulefiles:\n${names.join("\n")}\n` },
		"-t -d avail": { stderr: `/apps/modulefiles:\n${names.join("\n")}\n` },
		"-t list": { stderr: `${names.join("\n")}\n` },
	});
	for (const name of ["modules_avail", "modules_list"]) {
		const result = await asLmod(fake, () => call(name));
		assert.equal((result.modules as unknown[]).length, MAX_LISTED, name);
		assert.equal(result.total, MAX_LISTED + 20, name);
		assert.equal(result.cap, MAX_LISTED, name);
		assert.equal(result.truncated, true, name);
	}
});

test("Environment Modules before 4.5 is refused by name, since it has no JSON output", unix, async () => {
	const fake = stub("modulecmd", { "--version": { stderr: "Modules Release 4.1.4 (2018-04-05)\n" } });
	const result = await asModules(fake, () => run("modules_avail"));
	assert.match(result.error ?? "", /Environment Modules 4\.1\.4 .* needs Environment Modules 4\.5 or later/);
	assert.deepEqual(fake.calls(), ["--version"]);
});

test("collections: a name that is not saved is an error on both tools", unix, async () => {
	const lmod = stub("lmod", {
		...lmodVersion,
		"-t savelist": { stderr: LMOD_SAVELIST },
		"-t describe mytools": { stderr: LMOD_DESCRIBE },
	});
	const saved = await asLmod(lmod, () => call("modules_collections", { name: "mytools" }));
	assert.deepEqual(saved.modules, ["gcc", "openmpi", "python"]);
	assert.equal(saved.modulepath, null);
	assert.match((saved.unavailable as Record<string, string>).modulepath ?? "", /describe/);
	const missing = await asLmod(lmod, () => run("modules_collections", { name: "nope" }));
	assert.match(missing.error ?? "", /no saved collection named nope/);
	assert.ok(!lmod.calls().includes("-t describe nope"));

	const modules = stub("modulecmd", {
		...modulesVersion,
		"savelist -j": { stderr: MODULES_SAVELIST },
		"saveshow mytools": { stderr: MODULES_SAVESHOW },
		"saveshow nope": { stderr: "ERROR: Collection nope cannot be found\n", code: 1 },
	});
	const list = await asModules(modules, () => call("modules_collections"));
	assert.deepEqual(list.collections, ["default", "mytools"]);
	const shown = await asModules(modules, () => call("modules_collections", { name: "mytools" }));
	assert.deepEqual(shown.modulepath, ["/apps/modulefiles/tcl", "/apps/modulefiles/tcl2"]);
	const absent = await asModules(modules, () => run("modules_collections", { name: "nope" }));
	assert.match(absent.error ?? "", /ERROR: Collection nope cannot be found/);
});

test("every tool is a read and says it cannot load modules for the session", () => {
	assert.deepEqual(
		server.tools.map((entry) => entry.name),
		["modules_list", "modules_avail", "modules_show", "modules_spider", "modules_plan", "modules_collections"],
	);
	for (const entry of server.tools) {
		assert.equal(entry.actionClass, "read", entry.name);
		assert.match(
			entry.description,
			/no tool can|nothing is loaded|never runs module load|cannot load|unavailable/,
			entry.name,
		);
	}
	assert.match(
		tool("modules_list").description,
		/session's starting environment, not the state after some later shell command/,
	);
});
