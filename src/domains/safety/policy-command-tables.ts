// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { probeToolEnv } from "../../core/bash-exec.js";
import { commandArgumentSegments } from "./validation-check-match.js";

export const BUILTIN_ALLOWLIST: ReadonlyArray<{ id: string; re: RegExp }> = [
	{ id: "builtin:pwd", re: /^pwd$/ },
	// ls is not here: its operands must pass the workspace scope check (`ls /etc`,
	// `ls ..`, `ls link/` through a symlink) and -R walks without bound, so it is
	// recognized only through readOnlyInspectionRule.
	{ id: "builtin:git-status", re: /^git\s+status(?:\s+--short|\s+--branch|\s+-sb)*$/ },
	{ id: "builtin:git-diff", re: /^git\s+diff(?:\s+--cached|\s+--stat|\s+--name-only|\s+--\s+[\w./-]+)*$/ },
	{ id: "builtin:git-log", re: /^git\s+log\s+--oneline(?:\s+-n\s+[1-9]\d{0,2})?(?:\s+--\s+[\w./-]+)?$/ },
];

/**
 * A deny-mode fleet worker ran `node --version`, the call fell to
 * bash-unrecognized, and the refusal counted toward WORKER_REFUSAL_LIMIT until
 * the worker ended at three (0.6.3 dogfood). Each tool lists only the spellings
 * that print a version and exit: `node version`, `python version` and
 * `make version` run a workspace file or Makefile target, `python -v` starts a
 * verbose interpreter on stdin, and `yarn version` bumps the package. The
 * bare tool name is required, so `./node` or `/tmp/node` never matches. The
 * probe is recognized only standalone, like `git diff --check`: a
 * BUILTIN_ALLOWLIST entry would also recognize `node --version | cat` and
 * `node --version && git status` as chain steps.
 */
export const VERSION_PROBE = versionProbePattern();

function versionProbePattern(): RegExp {
	const probes: ReadonlyArray<readonly [string, ReadonlyArray<string>]> = [
		["node", ["--version", "-v"]],
		["npm", ["--version", "-v"]],
		["pnpm", ["--version", "-v"]],
		["yarn", ["--version", "-v"]],
		["bun", ["--version", "-v"]],
		["deno", ["--version", "-V"]],
		["python", ["--version", "-V"]],
		["python3", ["--version", "-V"]],
		["pip", ["--version", "-V"]],
		["pip3", ["--version", "-V"]],
		["uv", ["--version", "-V"]],
		["go", ["version"]],
		["cargo", ["--version", "-V", "version"]],
		["rustc", ["--version", "-V"]],
		["ruby", ["--version", "-v"]],
		["java", ["--version"]],
		["javac", ["--version"]],
		["gcc", ["--version"]],
		["g\\+\\+", ["--version"]],
		["clang", ["--version"]],
		["make", ["--version"]],
		["cmake", ["--version"]],
		["git", ["--version", "version"]],
		["tsc", ["--version", "-v"]],
	];
	const alternatives = probes.map(([tool, flags]) => `${tool}[ \\t]+(?:${flags.join("|")})`);
	return new RegExp(`^(?:${alternatives.join("|")})$`);
}

/**
 * Interpreter flags a `python -m pytest|unittest` run may carry (bt-12): short
 * switches that only buffer, warn, isolate or skip bytecode (`-B`, `-u`, `-I`,
 * clustered as `-Bu`), a closed `-X` list, and `-W` with a builtin warning
 * category. `-c`, `-i`, `-X pycache_prefix=` and a dotted `-W` category (which
 * Python imports) stay unrecognized, so no flag runs code beyond the runner.
 */
const PYTHON_RUNNER_FLAGS = String.raw`(?:[ \t]+(?:-[BbEIOPqsu]+|-X[ \t]*(?:dev|utf8(?:=[01])?|faulthandler|importtime|tracemalloc(?:=\d+)?|warn_default_encoding)|-W[ \t]*(?:default|error|always|module|once|ignore)(?:::[A-Za-z]*Warning)?))*`;

/**
 * Test runners run without an ask in default and yolo modes (#377). They
 * execute repository-authored code, which the maintainer accepted so a
 * headless run can verify its own work by the project's own command. Every id
 * here maps to a `detectValidationCommand` label, and
 * `tests/contracts/test-runner-vocabulary.test.ts` fails when the two drift.
 * Arguments stay bare words: quoting, substitution, and operators fall through
 * to the rails below. A package script's arguments after `--` may not begin
 * with `-`, so `--import`, `--require`, `--config` or `--prefix` keeps its ask.
 * Words are separated by spaces and tabs only, so a line break cannot start a
 * second command inside a recognized one.
 */
export const TEST_RUNNER_COMMANDS: ReadonlyArray<{ id: string; re: RegExp }> = [
	{
		id: "builtin:npm-test",
		re: /^npm[ \t]+(?:test|run[ \t]+test)(?:[ \t]+--[ \t]+[\w=./:][\w=./:-]*(?:[ \t]+[\w=./:][\w=./:-]*)*)?$/,
	},
	{
		id: "builtin:pnpm-test",
		re: /^pnpm[ \t]+(?:test|run[ \t]+test)(?:[ \t]+--[ \t]+[\w=./:][\w=./:-]*(?:[ \t]+[\w=./:][\w=./:-]*)*)?$/,
	},
	{
		id: "builtin:yarn-test",
		re: /^yarn[ \t]+(?:test|run[ \t]+test)(?:[ \t]+--[ \t]+[\w=./:][\w=./:-]*(?:[ \t]+[\w=./:][\w=./:-]*)*)?$/,
	},
	{
		id: "builtin:bun-test",
		re: /^bun[ \t]+(?:test|run[ \t]+test)(?:[ \t]+--[ \t]+[\w=./:][\w=./:-]*(?:[ \t]+[\w=./:][\w=./:-]*)*)?$/,
	},
	{
		id: "builtin:npm-test-script",
		re: /^npm[ \t]+run[ \t]+test:[\w=./:-]+(?:[ \t]+--[ \t]+[\w=./:][\w=./:-]*(?:[ \t]+[\w=./:][\w=./:-]*)*)?$/,
	},
	{
		id: "builtin:pnpm-test-script",
		re: /^pnpm[ \t]+run[ \t]+test:[\w=./:-]+(?:[ \t]+--[ \t]+[\w=./:][\w=./:-]*(?:[ \t]+[\w=./:][\w=./:-]*)*)?$/,
	},
	{
		id: "builtin:yarn-test-script",
		re: /^yarn[ \t]+run[ \t]+test:[\w=./:-]+(?:[ \t]+--[ \t]+[\w=./:][\w=./:-]*(?:[ \t]+[\w=./:][\w=./:-]*)*)?$/,
	},
	{
		id: "builtin:bun-test-script",
		re: /^bun[ \t]+run[ \t]+test:[\w=./:-]+(?:[ \t]+--[ \t]+[\w=./:][\w=./:-]*(?:[ \t]+[\w=./:][\w=./:-]*)*)?$/,
	},
	// uv can provision dependencies before pytest; --no-sync keeps #377's
	// unattended allowance from authorizing environment synchronization.
	{
		id: "builtin:uv-pytest",
		re: /^uv[ \t]+run(?:[ \t]+--(?:frozen|locked))*[ \t]+--no-sync(?:[ \t]+--(?:no-sync|frozen|locked))*[ \t]+pytest(?:[ \t]+[\w=./:-]+)*$/,
	},
	{
		id: "builtin:uv-python-pytest",
		re: /^uv[ \t]+run(?:[ \t]+--(?:frozen|locked))*[ \t]+--no-sync(?:[ \t]+--(?:no-sync|frozen|locked))*[ \t]+python[ \t]+-m[ \t]+pytest(?:[ \t]+[\w=./:-]+)*$/,
	},
	{ id: "builtin:node-test", re: /^node[ \t]+--test(?:[ \t]+[\w=./:-]+)*$/ },
	{ id: "builtin:pytest", re: /^pytest(?:[ \t]+[\w=./:-]+)*$/ },
	{
		id: "builtin:python-pytest",
		re: new RegExp(String.raw`^python(?:3(?:\.\d+)?)?${PYTHON_RUNNER_FLAGS}[ \t]+-m[ \t]+pytest(?:[ \t]+[\w=./:-]+)*$`),
	},
	{
		id: "builtin:python-unittest",
		re: new RegExp(String.raw`^python(?:3(?:\.\d+)?)?${PYTHON_RUNNER_FLAGS}[ \t]+-m[ \t]+unittest(?:[ \t]+[\w=./:-]+)*$`),
	},
	{ id: "builtin:cargo-test", re: /^cargo[ \t]+test(?:[ \t]+[\w=./:-]+)*$/ },
	{ id: "builtin:go-test", re: /^go[ \t]+test(?:[ \t]+[\w=./:-]+)*$/ },
	{ id: "builtin:ctest", re: /^ctest(?:[ \t]+[\w=./:-]+)*$/ },
	{ id: "builtin:make-test", re: /^make[ \t]+test(?:[ \t]+[\w=./:-]+)*$/ },
	{ id: "builtin:make-check", re: /^make[ \t]+check(?:[ \t]+[\w=./:-]+)*$/ },
	{ id: "builtin:ninja-test", re: /^ninja[ \t]+test(?:[ \t]+[\w=./:-]+)*$/ },
	{ id: "builtin:meson-test", re: /^meson[ \t]+test(?:[ \t]+[\w=./:-]+)*$/ },
	{ id: "builtin:mvn-test", re: /^mvn[ \t]+test(?:[ \t]+[\w=./:-]+)*$/ },
	{ id: "builtin:gradle-test", re: /^(?:gradle|(?:\.\/)?gradlew)[ \t]+test(?:[ \t]+[\w=./:-]+)*$/ },
];

/**
 * The clean step of `make clean && make test`, which ended sdlc coders at
 * WORKER_REFUSAL_LIMIT. It runs the same Makefile `make test` already runs
 * unattended, so it carries the same workspace-code gate. It stays out of
 * TEST_RUNNER_COMMANDS because a clean validates nothing and must not count as
 * evidence, and it takes no arguments, so `make clean all` stays unrecognized.
 */
export const MAKE_CLEAN_COMMAND = { id: "builtin:make-clean", re: /^make[ \t]+clean$/ };

/** Test runners that resolve imports through PYTHONPATH. */
const PYTHON_TEST_RUNNER_IDS: ReadonlySet<string> = new Set([
	"builtin:uv-pytest",
	"builtin:uv-python-pytest",
	"builtin:pytest",
	"builtin:python-pytest",
	"builtin:python-unittest",
]);

/**
 * A src-layout Python project is tested as `PYTHONPATH=src python3 -m pytest`.
 * The bare runner was recognized, but the prefixed form fell to
 * bash-unrecognized, so a non-interactive worker was refused the exact check
 * its task named and finished with a test that contradicted its own fix
 * (DF-16). The prefix is read only when every entry is a relative path with no
 * `..`, which keeps the import roots inside the call's workspace cwd: the
 * runner already executes that repository's code, so the prefix adds no reach.
 */
export function pythonRunnerBehindWorkspacePythonPath(command: string): { id: string; re: RegExp } | undefined {
	const match = /^PYTHONPATH=([\w./:-]+)[ \t]+(\S.*)$/.exec(command);
	if (match === null) return undefined;
	const entries = (match[1] ?? "").split(":");
	const inWorkspace = entries.every(
		(entry) => entry.length > 0 && !entry.startsWith("/") && !entry.split("/").includes(".."),
	);
	if (!inWorkspace) return undefined;
	const runner = match[2] ?? "";
	return TEST_RUNNER_COMMANDS.find((entry) => PYTHON_TEST_RUNNER_IDS.has(entry.id) && entry.re.test(runner));
}

/**
 * Repository scripts that are not test runners. They still count as validation
 * evidence (`npm run <verification script>`). Their net verdict passes after
 * safety checks, while autonomy asks in default unless project policy
 * explicitly declares the command safe.
 */
export const PROJECT_SCRIPT_COMMANDS: ReadonlyArray<{ id: string; re: RegExp }> = [
	{
		id: "builtin:npm-lint",
		re: /^npm[ \t]+run[ \t]+lint(?:[ \t]+--[ \t]+[\w=./:][\w=./:-]*(?:[ \t]+[\w=./:][\w=./:-]*)*)?$/,
	},
	{
		id: "builtin:npm-build",
		re: /^npm[ \t]+run[ \t]+build(?:[ \t]+--[ \t]+[\w=./:][\w=./:-]*(?:[ \t]+[\w=./:][\w=./:-]*)*)?$/,
	},
	{
		id: "builtin:npm-typecheck",
		re: /^npm[ \t]+run[ \t]+typecheck(?:[ \t]+--[ \t]+[\w=./:][\w=./:-]*(?:[ \t]+[\w=./:][\w=./:-]*)*)?$/,
	},
	{
		id: "builtin:npm-ci-script",
		re: /^npm[ \t]+run[ \t]+ci(?:[ \t]+--[ \t]+[\w=./:][\w=./:-]*(?:[ \t]+[\w=./:][\w=./:-]*)*)?$/,
	},
];

export function matchesRepositoryCommand(command: string): boolean {
	return [...TEST_RUNNER_COMMANDS, ...PROJECT_SCRIPT_COMMANDS].some((entry) => entry.re.test(command));
}

/**
 * What the recognized spelling looks like, carried on every unrecognized-bash
 * decision. It rides the decision's reasons so the approval overlay, the audit
 * record, and any surface that renders them all say the same thing: an agent
 * that hits this rail should learn the form that passes instead of retrying the
 * same shape. A headless denial carries only the first reason after the
 * cause, cut at 240 characters, so the note naming the refused step goes
 * ahead of this hint and the hint stays under that cut.
 */
export const BASH_RECOGNIZED_FORM_HINT =
	"Runs without asking: cat, head, tail, grep, rg, find, ls, wc, od, xxd, cmp, sha256sum, sed -n and git inspection on workspace paths, joined by &&, ||, ; or |, redirected only to /dev/null, with cwd as the cwd argument.";

/**
 * A step quoted for a refusal note. Headless guidance keeps 240 characters,
 * and a long step would leave no room for the reason that follows it.
 */
export function quotedStep(step: string): string {
	return `\`${step.length > 80 ? `${step.slice(0, 77)}...` : step}\``;
}

/**
 * ripgrep reads extra options from the file `RIPGREP_CONFIG_PATH` names, and
 * that file can add `--follow`, `--pre` and `-z`, which {@link parseRgArgs}
 * refuses on the command line. Admission judges from the command text alone,
 * so an rg that would run with a config is never recognized. The variable is
 * left in the tool environment so the operator's rg keeps working. Until the
 * login profile has been captured the tool environment is unknown, and rg is
 * not recognized either, so admission judges it as it does any unrecognized command.
 */
const RG_CONFIG_ENV = "RIPGREP_CONFIG_PATH";

const RG_CONFIG_REASONS = {
	set: `ripgrep reads options from the file ${RG_CONFIG_ENV} names, which can add --follow, --pre or -z behind the command text; with it set rg is not recognized as read-only`,
	pending: `the login environment bash commands run with is still being captured, so whether ${RG_CONFIG_ENV} names a ripgrep config that can add --follow, --pre or -z is unknown; rg is not recognized as read-only until it is`,
} as const;

/** Why rg cannot be recognized under the tool environment it would run with, or null when it can. */
export function rgConfigRefusal(): string | null {
	const probe = probeToolEnv(RG_CONFIG_ENV);
	return probe === "unset" ? null : RG_CONFIG_REASONS[probe];
}

/** The reason a command with an `rg` step is not recognized because of the ripgrep config variable, or none. */
export function rgConfigReasons(command: string): string[] {
	if (!commandArgumentSegments(command).some((args) => args[0] === "rg")) return [];
	const refusal = rgConfigRefusal();
	return refusal === null ? [] : [refusal];
}
