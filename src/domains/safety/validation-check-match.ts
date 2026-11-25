// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { isVerificationScriptName, isWriteCapableScriptName } from "../../core/verification-scripts.js";
import { basenameToken, commandTokenIndex } from "./command-token.js";
import { gitSubcommand } from "./read-only-steps.js";
import { scanShellLike, shellCommandArguments, splitSegments } from "./shell-scan.js";

export function checkStepMatch(executable: string, args: ReadonlyArray<string>): boolean {
	return validationMatch(executable, args) !== null || readOnlyCheckMatch(executable, args);
}

/** Package-manager subcommands that install, remove or rewrite the project's dependencies or manifest. */
export const PACKAGE_WRITES: ReadonlySet<string> = new Set([
	"install",
	"i",
	"ci",
	"add",
	"remove",
	"rm",
	"uninstall",
	"un",
	"update",
	"up",
	"upgrade",
	"link",
	"unlink",
	"rebuild",
	"dedupe",
	"prune",
	"init",
	"create",
	"version",
	"import",
	"patch",
]);

/** isort's own spellings of check-only mode (x10-2). */
export function isortCheckFlag(arg: string): boolean {
	return arg === "--check-only" || arg === "--check" || arg === "-c";
}

/** Interpreter flags that change neither where a script comes from nor what it may import. */
export const PLAIN_PYTHON_FLAGS: ReadonlySet<string> = new Set([
	"-B",
	"-E",
	"-I",
	"-O",
	"-OO",
	"-P",
	"-q",
	"-s",
	"-S",
	"-u",
]);

/** Runners that read the tree and write none of it, unless told to update snapshots or fix what they find. */
export const READ_ONLY_RUNNERS: ReadonlySet<string> = new Set(["vitest", "jest", "mocha", "eslint"]);

/** Runners that run their operand in the project's environment; the operand is what runs (x8-2). */
const ENVIRONMENT_RUNNERS: ReadonlyMap<string, string> = new Map([
	["uv", "run"],
	["poetry", "run"],
	["pipenv", "run"],
	["hatch", "run"],
	["pdm", "run"],
	["rye", "run"],
	["bundle", "exec"],
]);

/** The command `uv run`, `poetry run`, `bundle exec` and the like run, past their own flags; null for anything else. */
function environmentRunnerInvocation(
	executable: string,
	args: ReadonlyArray<string>,
): { executable: string; args: ReadonlyArray<string> } | null {
	if (args[0] === undefined || ENVIRONMENT_RUNNERS.get(executable) !== args[0]) return null;
	const inner = args.findIndex((arg, index) => index > 0 && !arg.startsWith("-"));
	return inner < 0 ? null : { executable: basenameToken(args[inner]), args: args.slice(inner + 1) };
}

/** Make targets that run a check, read like the opaque `npm test` and `npm run lint` scripts (x8-2). */
const MAKE_CHECK_TARGETS: ReadonlySet<string> = new Set(["test", "check", "lint"]);

/** `make test`, `make -s lint`, `make -j 4 test check`: only check targets, behind output and parallelism flags. */
function makeCheckMatch(args: ReadonlyArray<string>): boolean {
	let targets = 0;
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index] ?? "";
		if (arg === "-j" || arg === "--jobs") {
			if (/^\d+$/u.test(args[index + 1] ?? "")) index += 1;
			continue;
		}
		// `make -C dir test` runs dir's target; checkReachesOutside holds dir to the workspace (SF-2).
		if (arg === "-C" || arg === "--directory") {
			if (args[index + 1] === undefined) return false;
			index += 1;
			continue;
		}
		if (/^-C./u.test(arg) || arg.startsWith("--directory=")) continue;
		if (/^(?:-s|--silent|--quiet|-k|--keep-going|-j\d+|--jobs=\d+)$/u.test(arg)) continue;
		if (arg.startsWith("-")) return false;
		if (/^[A-Za-z_][A-Za-z0-9_]*=/u.test(arg)) continue;
		if (!MAKE_CHECK_TARGETS.has(arg)) return false;
		targets += 1;
	}
	return targets > 0;
}

/**
 * Read-only checks of other ecosystems by their subcommand (x8-2): cargo check, clippy, build and `insta test`, go vet
 * and build (whose binary the output reader judges, {@link checkReportTargets}), `gofmt -l`, mypy, pyright, pylint, flake8, ruff check, `prettier --check`, the format checks
 * `black --check`, `isort --check-only`, `ruff format --check`, `cargo fmt --check` and `rustfmt --check` (x10-2),
 * `golangci-lint run`, staticcheck (x10-3), biome check and lint,
 * dotnet test, rspec, phpunit, composer test, deno test, check and lint, playwright test, cypress run, tox, nox, hatch
 * test, rake test, `python manage.py test`, `php artisan test`, make's check targets and a project check script
 * run by its interpreter ({@link projectCheckScriptArgs}). An option that writes what they read (`--fix`, `--write`, `-w`, a
 * snapshot update, mypy's `--install-types`, ruff's `--add-noqa`, biome's `--apply`) or a tox or nox environment named
 * as a writer (`-e format`) keeps the run out of the set.
 */
function ecosystemCheckMatch(executable: string, args: ReadonlyArray<string>): boolean {
	const has = (pattern: RegExp) => args.some((arg) => pattern.test(arg));
	const subcommand = args[0] ?? "";
	let matched: boolean;
	switch (executable) {
		case "cargo":
			matched =
				subcommand === "check" ||
				subcommand === "clippy" ||
				subcommand === "build" ||
				// `cargo insta test` writes only pending `.snap.new` files beside a red; its accept forms are writers (SF-2).
				(subcommand === "insta" && args[1] === "test") ||
				(subcommand === "fmt" && args.includes("--check"));
			break;
		case "go":
			matched = subcommand === "vet" || subcommand === "build";
			break;
		case "gofmt":
			matched = has(/^-[ld]$/u);
			break;
		case "mypy":
			matched = !has(/^--install-types/u);
			break;
		case "pylint":
		case "flake8":
		case "staticcheck":
			matched = true;
			break;
		case "golangci-lint":
			matched = subcommand === "run";
			break;
		case "pyright":
			matched = !has(/^--(?:createstub|writebaseline)/u);
			break;
		case "ruff":
			matched = (subcommand === "check" && !has(/^--add-noqa/u)) || (subcommand === "format" && args.includes("--check"));
			break;
		case "black":
		case "rustfmt":
			matched = args.includes("--check");
			break;
		case "isort":
			matched = args.some(isortCheckFlag);
			break;
		case "prettier":
			matched = has(/^(?:--check|-c|--list-different|-l)$/u);
			break;
		case "biome":
			matched = (subcommand === "check" || subcommand === "lint") && !has(/^--apply/u);
			break;
		case "dotnet":
		case "composer":
		case "hatch":
		case "playwright":
			matched = subcommand === "test";
			break;
		case "rspec":
			matched = !args.includes("--init");
			break;
		case "phpunit":
			matched = !has(/^--(?:generate|migrate)-/u);
			break;
		case "deno":
			matched = subcommand === "test" || subcommand === "check" || subcommand === "lint";
			break;
		case "cypress":
			matched = subcommand === "run";
			break;
		case "tox":
		case "nox":
			// An environment or session named as a writer (`-e format`, `-s lint_fix`) is excluded by checkWritesTree below.
			matched = true;
			break;
		case "rake":
			matched = subcommand === "test";
			break;
		case "make":
			matched = makeCheckMatch(args);
			break;
		default: {
			// Interpreter flags such as python's `-u` are not the script's: only what follows the script is screened.
			const script = projectCheckScriptArgs(executable, args);
			if (script !== null) return !script.some(writesSnapshots) && !checkWritesTree([executable, ...script]);
			matched =
				((isPythonExecutable(executable) && basenameToken(args[0]) === "manage.py") ||
					(executable === "php" && basenameToken(args[0]) === "artisan")) &&
				args[1] === "test";
		}
	}
	return matched && !args.some(writesSnapshots) && !checkWritesTree([executable, ...args]);
}

const CHECK_SCRIPT_WORDS: ReadonlySet<string> = new Set(["check", "checks", "test", "tests", "verify", "verification"]);

/**
 * The script and its arguments when a project check script runs under its interpreter (bt-r2 finding 2), else null:
 * `python3 check.py`, `python3 -u verify_stencil.py`, `node scripts/test.mjs` or `bash check.sh`. The script is a
 * relative path inside the tree whose file stem holds one of {@link CHECK_SCRIPT_WORDS} as a whole word. `python -c`,
 * `python -m`, `python3 app.py`, `node checkout.mjs` and a bare `./check.sh` stay outside it.
 */
function projectCheckScriptArgs(executable: string, args: ReadonlyArray<string>): ReadonlyArray<string> | null {
	let index = 0;
	let extensions: RegExp;
	if (isPythonExecutable(executable)) {
		while (PLAIN_PYTHON_FLAGS.has(args[index] ?? "")) index += 1;
		extensions = /\.py$/u;
	} else if (executable === "node") extensions = /\.(?:js|mjs|cjs)$/u;
	else if (executable === "bash" || executable === "sh") extensions = /\.sh$/u;
	else return null;
	const script = args[index] ?? "";
	if (!extensions.test(script) || script.startsWith("/") || script.startsWith("~")) return null;
	const segments = script.split(/[\\/]/u);
	if (segments.includes("..")) return null;
	const stem = (segments.at(-1) ?? "").replace(extensions, "");
	const named = stem
		.toLowerCase()
		.split(/[^a-z0-9]+/u)
		.some((word) => CHECK_SCRIPT_WORDS.has(word));
	return named ? args.slice(index) : null;
}

/**
 * The closed read-only half of the check vocabulary (x5-1): `tsc --noEmit`, `node --check`, `node --test`, and
 * vitest, jest, mocha or eslint, bare or behind `npx`, `npm|pnpm|yarn|bun exec` or `pnpm|yarn <bin>`, the other
 * ecosystems' read-only checks ({@link ecosystemCheckMatch}), also as `python -m <tool>`, and any check behind `uv
 * run`, `poetry run` or `bundle exec`. A snapshot update,
 * `--fix`, `node -e` and a bare `tsc` that emits stay outside it, so they remain changes that retire earlier passes.
 */
export function readOnlyCheckMatch(executable: string, args: ReadonlyArray<string>): boolean {
	const wrapped = environmentRunnerInvocation(executable, args);
	if (wrapped !== null) return checkStepMatch(wrapped.executable, wrapped.args);
	const module = pythonToolModule(executable, args);
	if (module !== null) return readOnlyCheckMatch(module.executable, module.args);
	if (ecosystemCheckMatch(executable, args)) return true;
	if (executable === "npx") {
		if (args.some((arg) => arg === "-c" || arg === "--call" || arg.startsWith("--call="))) return false;
		const inner = npxInvocation(args);
		return inner !== null && inner.executable !== "node" && readOnlyCheckMatch(inner.executable, inner.args);
	}
	const exec = packageExecInvocation(executable, args) ?? packageBinInvocation(executable, args);
	if (exec !== null) return exec.executable !== "node" && readOnlyCheckMatch(exec.executable, exec.args);
	if (executable === "tsc") return args.some((arg) => arg.toLowerCase() === "--noemit");
	if (executable === "node")
		return (
			args.some((arg) => arg === "--test" || arg === "--check" || arg === "-c") &&
			!args.some((arg) => isRuntimeLoaderFlag(arg) || arg === "-p" || arg.startsWith("--print") || writesSnapshots(arg))
		);
	if (!READ_ONLY_RUNNERS.has(executable)) return false;
	return !args.some((arg) => writesSnapshots(arg) || arg.startsWith("--fix"));
}

/** Runtime options that load or evaluate code of their own beside the check they ride on. */
const RUNTIME_LOADER_FLAGS: ReadonlyArray<string> = [
	"--import",
	"--require",
	"--loader",
	"--experimental-loader",
	"--eval",
];

function isRuntimeLoaderFlag(arg: string): boolean {
	return arg === "-r" || arg === "-e" || RUNTIME_LOADER_FLAGS.some((flag) => arg === flag || arg.startsWith(`${flag}=`));
}

/** Options that make a test runner rewrite its own snapshots or goldens instead of comparing against them (x7-2). */
const SNAPSHOT_WRITE_FLAGS: ReadonlySet<string> = new Set([
	"-u",
	"--test-update-snapshots",
	"--snapshot-update",
	"--force-regen",
	"--regen-all",
]);

/**
 * A test runner's option that rewrites its snapshots or goldens: `-u`, `--update*` (`--update-goldens` included), Go's
 * single-dash `-update`, node's `--test-update-snapshots`, syrupy's `--snapshot-update`, pytest-regressions'
 * `--force-regen` and `--regen-all`.
 */
function writesSnapshots(arg: string): boolean {
	return SNAPSHOT_WRITE_FLAGS.has(arg) || arg.startsWith("--update") || /^-update(?:=|$)/u.test(arg);
}

/** Runners whose `test` subcommand runs the tests, with the runner's own options after it. */
const TEST_SUBCOMMAND_RUNNERS: ReadonlySet<string> = new Set(["go", "bun", "deno", "playwright"]);

/**
 * The arguments a validated test runner reads its own options from, or null for any other command: `go test`,
 * `pytest`, `python -m pytest`, `bun test`, `deno test`, `playwright test` and `cargo insta` (x7-2, x8-2);
 * {@link checkWritesTree} unwraps `uv run` first.
 */
function testRunnerArgs(executable: string, args: ReadonlyArray<string>): ReadonlyArray<string> | null {
	if (executable === "pytest" || executable === "py.test") return args;
	if (isPythonExecutable(executable) && moduleArg(args) === "pytest") return args;
	if (TEST_SUBCOMMAND_RUNNERS.has(executable) && args[0] === "test") return args.slice(1);
	return null;
}

/** {@link isWriteCapableScriptName} with `_` read as a separator too, so `nox -s lint_fix` names a writer (SF-2). */
function isWriterName(name: string): boolean {
	return isWriteCapableScriptName(name.replace(/_/gu, "-"));
}

/** Flags that turn a linter or formatter into a writer of the files it checks. */
const TREE_WRITING_FLAGS: ReadonlySet<string> = new Set(["--fix", "--write"]);

/** Formatters whose `-w` writes the files back; elsewhere `-w` names a workspace or a warning filter. */
const W_FLAG_WRITERS: ReadonlySet<string> = new Set(["prettier", "gofmt", "goimports"]);

/**
 * Whether a check command may rewrite the tree it checks (x3-3): a package script, make or just target named as a
 * writer ({@link isWriteCapableScriptName}), `--fix` or `--write`, a formatter's `-w`, or a snapshot update passed to a
 * package script, `node --test` or a validated test runner ({@link testRunnerArgs}), or a `cargo insta` accept, also
 * behind `uv run`, `poetry run` or `bundle exec`. A heuristic on names and flags: a writer spelled otherwise reads as a check, and a
 * read-only script named `format` reads as a change, which only clears passes the run must then earn again.
 */
export function checkWritesTree(argv: ReadonlyArray<string>): boolean {
	const index = commandTokenIndex(argv);
	if (index === null) return false;
	const executable = basenameToken(argv[index]);
	const args = argv.slice(index + 1);
	if (args.some((arg) => TREE_WRITING_FLAGS.has(arg) || arg.startsWith("--fix="))) return true;
	if (W_FLAG_WRITERS.has(executable) && args.includes("-w")) return true;
	const wrapped = environmentRunnerInvocation(executable, args);
	if (wrapped !== null) return checkWritesTree([wrapped.executable, ...wrapped.args]);
	if (executable === "node") return args.includes("--test-update-snapshots");
	// `go test -update`, `pytest --snapshot-update` and `bun test -u` rewrite the goldens they compare against (x7-2).
	if (testRunnerArgs(executable, args)?.some(writesSnapshots) === true) return true;
	if (executable === "cargo" && args[0] === "insta")
		return (
			args[1] === "accept" ||
			args[1] === "review" ||
			args.some(
				(arg, index) =>
					/^--(?:accept|review|force-update-snapshots)/u.test(arg) ||
					/^--unreferenced=(?:delete|auto)$/u.test(arg) ||
					(arg === "--unreferenced" && /^(?:delete|auto)$/u.test(args[index + 1] ?? "")) ||
					writesSnapshots(arg),
			)
		);
	if (executable === "npm" || executable === "pnpm" || executable === "yarn" || executable === "bun") {
		const run = packageScriptRun(executable, args);
		const script = run?.script ?? (args[0] === "run" ? args[1] : args[0]);
		const separator = args.indexOf("--");
		// `npm test -- -u` is a check that rewrites its snapshots (x5-2); pnpm and yarn hand `pnpm test -u` the flag too.
		if (separator >= 0 && args.slice(separator + 1).some(writesSnapshots)) return true;
		if ((executable === "pnpm" || executable === "yarn") && run?.forwarded.some(writesSnapshots) === true) return true;
		return script !== undefined && isWriterName(script);
	}
	if (executable === "make" || executable === "just")
		return args.some((arg) => !arg.startsWith("-") && !arg.includes("=") && isWriterName(arg));
	// A tox environment or nox session named as a writer rewrites the tree (`nox -s lint_fix`, `tox -e format`, SF-2).
	if (executable === "tox" || executable === "nox") return args.flatMap((arg) => arg.split(/[=,]/u)).some(isWriterName);
	return false;
}

/**
 * Validation vocabulary shared with unattended test runners (#377). Labels
 * with `<name>` describe script families; `validationMatch` preserves the
 * actual script name so one script cannot ground a claim about another.
 * `tests/contracts/test-runner-vocabulary.test.ts` prevents admission drift.
 */
export const VALIDATION_COMMAND_LABELS = [
	"npm test",
	"pnpm test",
	"yarn test",
	"bun test",
	"npm run test:<name>",
	"pnpm run test:<name>",
	"yarn run test:<name>",
	"bun run test:<name>",
	"uv run pytest",
	"uv run python -m pytest",
	"node --test",
	"pytest",
	"python -m pytest",
	"python -m unittest",
	"cargo test",
	"go test",
	"ctest",
	"make test",
	"make check",
	"ninja test",
	"meson test",
	"mvn test",
	"gradle test",
] as const;

export type ValidationCommandLabel = (typeof VALIDATION_COMMAND_LABELS)[number];

export function validationMatch(
	executable: string,
	args: ReadonlyArray<string>,
): ValidationCommandLabel | PackageScriptLabel | CheckerLabel | null {
	// A runtime loader (`--import`, `--require`) runs code beside the check, so wherever it appears the run is not the
	// project's check (x6-5).
	if (executable === "node") return args[0] === "--test" && !args.some(isRuntimeLoaderFlag) ? "node --test" : null;
	const script = packageScriptMatch(executable, args);
	if (script !== null) {
		// The same holds for one handed to the script; a runner's own flag (`--run`, `-t name`) is filed under its
		// full command (x5-2).
		return packageScriptRun(executable, args)?.forwarded.some(isRuntimeLoaderFlag) === true ? null : script;
	}
	if (executable === "uv") {
		const invocation = args.join(" ");
		if (/^run(?:\s+--(?:no-sync|frozen|locked))*\s+pytest(?:\s+[\w=./:-]+)*$/.test(invocation)) {
			return "uv run pytest";
		}
		if (/^run(?:\s+--(?:no-sync|frozen|locked))*\s+python\s+-m\s+pytest(?:\s+[\w=./:-]+)*$/.test(invocation)) {
			return "uv run python -m pytest";
		}
	}
	if (executable === "pytest") return "pytest";
	if (isPythonExecutable(executable) && moduleArg(args) === "pytest") return "python -m pytest";
	if (isPythonExecutable(executable) && moduleArg(args) === "unittest") return "python -m unittest";
	// nextest runs the same cargo tests, so it carries their label (x10-3).
	if (executable === "cargo" && (args[0] === "test" || (args[0] === "nextest" && args[1] === "run")))
		return "cargo test";
	if (executable === "go" && args[0] === "test") return "go test";
	if (executable === "ctest") return "ctest";
	if (executable === "make" && args[0] === "test") return "make test";
	if (executable === "make" && args[0] === "check") return "make check";
	if (executable === "ninja" && args[0] === "test") return "ninja test";
	if (executable === "meson" && args[0] === "test") return "meson test";
	if (executable === "mvn" && args[0] === "test") return "mvn test";
	if ((executable === "gradle" || executable === "gradlew") && args[0] === "test") return "gradle test";
	// `npx`, `<pm> exec` and `pnpm dlx` run the checker they name, so the run carries that checker's label (CLI-P24).
	const inner =
		executable === "npx" && !args.some((arg) => arg === "-c" || arg === "--call" || arg.startsWith("--call="))
			? npxInvocation(args)
			: packageExecInvocation(executable, args);
	if (inner !== null) return inner.executable === "node" ? null : validationMatch(inner.executable, inner.args);
	return checkerMatch(executable, args);
}

/** Type and lint checkers the finish vocabulary names by tool, bare or behind a runner. */
type CheckerLabel = "tsc --noEmit" | "biome check" | "biome lint" | "eslint";

/** `tsc --noEmit`, `biome check|lint` and `eslint` while they only read the tree; a write mode keeps them unlabeled. */
function checkerMatch(executable: string, args: ReadonlyArray<string>): CheckerLabel | null {
	if (!readOnlyCheckMatch(executable, args)) return null;
	if (executable === "tsc") return "tsc --noEmit";
	if (executable === "biome" && (args[0] === "check" || args[0] === "lint")) return `biome ${args[0]}`;
	if (executable === "eslint") return "eslint";
	return null;
}

export type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

/** A package-script check's identity: `<pm> test` or `<pm> run <script>`, with any workspace selectors before it. */
type PackageScriptLabel = `${PackageManager} ${string}`;

function packageScriptMatch(executable: string, args: ReadonlyArray<string>): PackageScriptLabel | null {
	const run = packageScriptRun(executable, args);
	if (run === null) return null;
	// A selected workspace's run is not the root's check, so its selectors stay in its identity.
	const scope = run.selectors.map((selector) => `${selector} `).join("");
	if (run.script === "test") return `${run.manager} ${scope}test`;
	if (isVerificationScriptName(run.script)) return `${run.manager} ${scope}run ${run.script}`;
	return null;
}

/**
 * pnpm and yarn commands that a bare word names before any package script of that name (x6-4), so `pnpm ci` or
 * `yarn check` is never read as the project's `ci` or `check` script.
 */
const PACKAGE_MANAGER_BUILTINS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
	[
		"pnpm",
		new Set([
			...PACKAGE_WRITES,
			"exec",
			"dlx",
			"publish",
			"pack",
			"store",
			"why",
			"outdated",
			"audit",
			"config",
			"set",
			"env",
			"list",
			"ls",
			"root",
			"bin",
			"licenses",
			"deploy",
			"fetch",
			"setup",
			"server",
			"doctor",
		]),
	],
	[
		"yarn",
		new Set([
			...PACKAGE_WRITES,
			"exec",
			"dlx",
			"publish",
			"pack",
			"why",
			"outdated",
			"audit",
			"config",
			"set",
			"env",
			"list",
			"info",
			"bin",
			"cache",
			"global",
			"licenses",
			"workspaces",
			"check",
			"node",
			"constraints",
			"plugin",
		]),
	],
]);

/** pnpm workspace selectors before a script that take no value. */
const PNPM_SELECTOR_FLAGS: ReadonlySet<string> = new Set(["-r", "--recursive", "-w", "--workspace-root"]);

/** Selectors before a script that take a value: pnpm's `--filter` and each manager's project directory. */
const PACKAGE_VALUE_SELECTORS: Readonly<Record<PackageManager, ReadonlySet<string>>> = {
	npm: new Set(["--prefix"]),
	pnpm: new Set(["--filter", "-F", "-C", "--dir"]),
	yarn: new Set(["--cwd"]),
	bun: new Set(["--cwd"]),
};

/**
 * The package script a package manager runs: `<pm> test`, `<pm> run <script>`, or for pnpm and yarn a bare script
 * name, past pnpm's `--filter <v>`, `-F <v>`, `-r` and `-w` or yarn's `workspace <name>` (x6-4), and past the project
 * directory (`npm --prefix <dir>`, `pnpm -C <dir>`, `yarn --cwd <dir>`), which stays in the check's identity.
 * `forwarded` are the arguments after the script name. Null for anything else.
 */
export function packageScriptRun(
	executable: string,
	args: ReadonlyArray<string>,
): { manager: PackageManager; selectors: string[]; script: string; forwarded: ReadonlyArray<string> } | null {
	if (executable !== "npm" && executable !== "pnpm" && executable !== "yarn" && executable !== "bun") return null;
	const selected = packageSelectors(executable, args);
	if (selected === null) return null;
	const { selectors, index } = selected;
	const first = args[index];
	if (first === undefined) return null;
	if (first === "test") return { manager: executable, selectors, script: first, forwarded: args.slice(index + 1) };
	if (first === "run") {
		// `pnpm run -s typecheck`: the manager's output flags may also stand between `run` and the script.
		let at = index + 1;
		for (let width = outputFlagWidth(args, at); width > 0; width = outputFlagWidth(args, at)) at += width;
		const script = args[at];
		return script === undefined ? null : { manager: executable, selectors, script, forwarded: args.slice(at + 1) };
	}
	if (executable !== "pnpm" && executable !== "yarn") return null;
	if (first.startsWith("-") || PACKAGE_MANAGER_BUILTINS.get(executable)?.has(first) === true) return null;
	return { manager: executable, selectors, script: first, forwarded: args.slice(index + 1) };
}

/** Package-manager flags that only change what a run prints (CLI-P24), and those of them that take a value. */
const PACKAGE_OUTPUT_FLAGS: ReadonlySet<string> = new Set(["-s", "--silent", "-q", "--quiet", "--color", "--no-color"]);

const PACKAGE_OUTPUT_VALUE_FLAGS: ReadonlySet<string> = new Set(["--loglevel", "--reporter"]);

/** How many words the output-only flag at `index` spans: 0 when none stands there. */
export function outputFlagWidth(args: ReadonlyArray<string>, index: number): number {
	const arg = args[index];
	if (arg === undefined) return 0;
	if (PACKAGE_OUTPUT_FLAGS.has(arg)) return 1;
	const equals = arg.indexOf("=");
	if (equals > 0) return PACKAGE_OUTPUT_VALUE_FLAGS.has(arg.slice(0, equals)) ? 1 : 0;
	return PACKAGE_OUTPUT_VALUE_FLAGS.has(arg) && args[index + 1] !== undefined ? 2 : 0;
}

/**
 * The workspace selectors and project directory before a package manager's command, and the index past them; the
 * manager's output-only flags there are skipped and kept out of the selectors.
 */
export function packageSelectors(
	executable: PackageManager,
	args: ReadonlyArray<string>,
): { selectors: string[]; index: number } | null {
	const selectors: string[] = [];
	const valued = PACKAGE_VALUE_SELECTORS[executable];
	let index = 0;
	for (let arg = args[index]; arg !== undefined; arg = args[index]) {
		const equals = arg.indexOf("=");
		if (valued.has(equals > 0 ? arg.slice(0, equals) : arg)) {
			const value = equals > 0 ? arg.slice(equals + 1) : args[index + 1];
			if (value === undefined) return null;
			selectors.push(...(equals > 0 ? [arg] : [arg, value]));
			index += equals > 0 ? 1 : 2;
		} else if (executable === "pnpm" && PNPM_SELECTOR_FLAGS.has(arg)) {
			selectors.push(arg);
			index += 1;
		} else if (outputFlagWidth(args, index) > 0) {
			// Output-only flags change what the run prints, not what it checks, so they stay out of its identity.
			index += outputFlagWidth(args, index);
		} else break;
	}
	if (executable === "yarn" && args[index] === "workspace" && args[index + 1]?.startsWith("-") === false) {
		selectors.push("workspace", args[index + 1] as string);
		index += 2;
	}
	return { selectors, index };
}

/**
 * The `grounding`-only half of the vocabulary. Every rule here is an exact
 * leading-command match on a canonicalized executable, never a substring guess,
 * so a command that merely mentions `tsc` or `diff` in an argument stays
 * unrecognized. Failing to match is the safe direction for this scope.
 */
export function groundingMatch(executable: string, args: ReadonlyArray<string>): string | null {
	if (executable === "git") {
		const subcommand = gitSubcommand(args)?.subcommand;
		if (subcommand === "diff") return "git diff";
		if (subcommand === "status") return "git status";
		return null;
	}
	if (executable === "node") {
		if (args.includes("--test")) return "node --test";
		if (args.includes("-e") || args.includes("--eval")) return "node -e";
		if (args.includes("--check") || args.includes("-c")) return "node --check";
		return null;
	}
	if (executable === "tsc") return typescriptCheckMatch(args);
	if (executable === "npx") {
		const inner = npxInvocation(args);
		return inner === null ? null : npxRunnerMatch(inner.executable, inner.args);
	}
	return null;
}

/** Test runners recognized behind `npx`, where the runner name is the whole claim. */
const NPX_TEST_RUNNERS: ReadonlySet<string> = new Set(["vitest", "jest", "mocha"]);

function npxRunnerMatch(executable: string, args: ReadonlyArray<string>): string | null {
	if (NPX_TEST_RUNNERS.has(executable)) return `npx ${executable}`;
	if (executable === "tsx" && args.includes("--test")) return "npx tsx --test";
	if (executable === "tsc") return typescriptCheckMatch(args);
	return null;
}

/** `tsc --noEmit` is a typecheck; a bare `tsc` is a build that also typechecks. */
function typescriptCheckMatch(args: ReadonlyArray<string>): string {
	return args.some((arg) => arg.toLowerCase() === "--noemit") ? "tsc --noEmit" : "tsc";
}

/**
 * The command `npx` would run, with npx's own flags consumed. Flags that take a
 * separate value (`-p react`, `--package=x` is self-contained) must not be
 * mistaken for the command name.
 */
export function npxInvocation(args: ReadonlyArray<string>): { executable: string; args: ReadonlyArray<string> } | null {
	const VALUE_FLAGS = new Set(["-p", "--package", "-c", "--call", "--shell"]);
	let index = 0;
	while (index < args.length) {
		const token = args[index];
		if (token === undefined) return null;
		if (VALUE_FLAGS.has(token)) {
			index += 2;
			continue;
		}
		if (token.startsWith("-")) {
			index += 1;
			continue;
		}
		return { executable: basenameToken(token), args: args.slice(index + 1) };
	}
	return null;
}

export function moduleArg(args: ReadonlyArray<string>): string | null {
	for (let index = 0; index < args.length - 1; index += 1) {
		if (args[index] === "-m") return args[index + 1] ?? null;
	}
	return null;
}

/** Python tools that `python -m <tool>` runs as the bare tool of that name. */
const PYTHON_TOOL_MODULES: ReadonlySet<string> = new Set([
	"mypy",
	"ruff",
	"pylint",
	"flake8",
	"black",
	"isort",
	"autopep8",
]);

/** The tool `python -m <tool>` runs, past the interpreter's own options, when it is one of {@link PYTHON_TOOL_MODULES}. */
export function pythonToolModule(
	executable: string,
	args: ReadonlyArray<string>,
): { executable: string; args: ReadonlyArray<string> } | null {
	if (!isPythonExecutable(executable)) return null;
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index] ?? "";
		if (arg === "-m") {
			const module = args[index + 1];
			return module !== undefined && PYTHON_TOOL_MODULES.has(module)
				? { executable: module, args: args.slice(index + 2) }
				: null;
		}
		if (arg === "-W" || arg === "-X") index += 1;
		else if (!arg.startsWith("-") || arg === "-" || arg === "-c") return null;
	}
	return null;
}

/**
 * The binary `npm exec`, `pnpm exec`, `yarn exec`, `bun exec`, `pnpm dlx` or `yarn dlx` runs, past the manager's
 * selectors and output flags and an optional `--`; null for anything else.
 */
export function packageExecInvocation(
	executable: string,
	args: ReadonlyArray<string>,
): { executable: string; args: ReadonlyArray<string> } | null {
	if (executable !== "npm" && executable !== "pnpm" && executable !== "yarn" && executable !== "bun") return null;
	const start = packageSelectors(executable, args)?.index ?? 0;
	const command = args[start];
	if (command !== "exec" && !(command === "dlx" && (executable === "pnpm" || executable === "yarn"))) return null;
	const at = args[start + 1] === "--" ? start + 2 : start + 1;
	const bin = args[at];
	return bin === undefined || bin.startsWith("-") ? null : { executable: basenameToken(bin), args: args.slice(at + 1) };
}

/** Package-manager commands that run a package script, never a binary. */
const SCRIPT_RUNNING_COMMANDS: ReadonlySet<string> = new Set(["run", "test", "start"]);

/**
 * The binary `pnpm <bin>` or `yarn <bin>` runs when the first word is no builtin of theirs (`pnpm vitest run`) and
 * none of the commands that run a package script (`run`, `test`, `start`), past workspace selectors and the project
 * directory (`pnpm --filter web vitest run`, SF-2), which {@link checkReachesOutside} still holds to the workspace.
 */
export function packageBinInvocation(
	executable: string,
	args: ReadonlyArray<string>,
): { executable: string; args: ReadonlyArray<string> } | null {
	const at = executable === "pnpm" || executable === "yarn" ? packageSelectors(executable, args)?.index : 0;
	const bin = at === undefined ? undefined : args[at];
	if (
		bin === undefined ||
		bin.startsWith("-") ||
		SCRIPT_RUNNING_COMMANDS.has(bin) ||
		PACKAGE_MANAGER_BUILTINS.get(executable)?.has(bin) !== false
	)
		return null;
	return { executable: basenameToken(bin), args: args.slice((at ?? 0) + 1) };
}

export function isPythonExecutable(executable: string): boolean {
	return executable === "python" || executable === "python3" || /^python3\.\d+$/.test(executable);
}

/** Input is one command's argv. Literal words must never be reparsed as shell syntax. */
export function pathArgs(segment: ReadonlyArray<string>, commandIndex: number): string[] {
	const args: string[] = [];
	let endOfOptions = false;
	for (let index = commandIndex + 1; index < segment.length; index += 1) {
		const token = segment[index];
		if (token === undefined) continue;
		if (!endOfOptions && token === "--") {
			endOfOptions = true;
			continue;
		}
		if (!endOfOptions && token.startsWith("-")) continue;
		args.push(token);
	}
	return args;
}

/** Literal argv by command, with actual operators and redirections removed. */
export function commandArgumentSegments(command: string): string[][] {
	return splitSegments(scanShellLike(command)).map(shellCommandArguments);
}
