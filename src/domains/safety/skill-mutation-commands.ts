// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { basenameToken, commandTokenIndex } from "./command-token.js";
import { shellCommandArguments } from "./shell-scan.js";
import { expandedShellSegments } from "./shell-segments.js";

/** Recognizable operator CLI installation paths invoked through a model shell.
 * This is command inspection, not confinement of arbitrary scripts or aliases.
 * `excludeHub` keeps only the hard-blocked verbs. Without it the result also
 * covers the verbs that ask the operator under the default posture: the hub,
 * a share import and the extension authoring verbs that execute package code.
 */
export function invokesPancodeSkillMutation(command: string, excludeHub = false): boolean {
	for (const segment of expandedShellSegments(command)) {
		const argv = shellCommandArguments(segment);
		const index = commandTokenIndex(argv);
		if (index === null) continue;
		let args = argv.slice(index);
		const executable = basenameToken(args[0]);
		if (executable === "npx" || (executable === "npm" && args[1] === "exec")) {
			args = args.slice(executable === "npm" ? 2 : 1);
			while (args[0]?.startsWith("-")) args = args.slice(1);
		}
		const program = args[0] ?? "";
		if (basenameToken(program) === "node" || basenameToken(program) === "tsx") {
			// The checked-in and built entry points are also operator CLIs.
			if (!/(?:^|\/)(?:src|dist)\/cli\/index\.(?:js|ts)$/.test(args[1] ?? "")) continue;
			args = args.slice(2);
		} else if (/^pancode(?:@[^/]+)?$/.test(program) || basenameToken(program) === "pancode") {
			args = args.slice(1);
		} else continue;
		if (args.includes("--version") || args.includes("-v")) continue;
		let rootHelp = false;
		let firstRootFlag: string | undefined;
		while (args[0]?.startsWith("-")) {
			const flag = args[0];
			// Startup flags are consumed before dispatch. Help is terminal only
			// when it is the first flag left in the root dispatcher's argv.
			if (flag === "--all" || flag === "--help" || flag === "-h") firstRootFlag ??= flag;
			rootHelp = firstRootFlag === "--help" || firstRootFlag === "-h";
			args = args.slice(flag === "--skill" || flag === "--api-key" ? 2 : 1);
		}
		if (rootHelp) continue;
		// `pancode dev archive` dispatches to `pancode archive`.
		if (args[0] === "dev" && args[1] === "archive") args = args.slice(1);
		if (
			args[0] !== "skills" &&
			args[0] !== "hub" &&
			args[0] !== "plugins" &&
			args[0] !== "extensions" &&
			args[0] !== "interop" &&
			args[0] !== "archive"
		)
			continue;
		if (excludeHub && args[0] === "hub") continue;
		if (resourceCliMutatesSkills(args[0], args.slice(1), !excludeHub)) return true;
	}
	return false;
}

function resourceCliMutatesSkills(
	resource: "skills" | "hub" | "plugins" | "extensions" | "interop" | "archive",
	args: ReadonlyArray<string>,
	confirmable: boolean,
): boolean {
	// Both resource parsers accept flags before the verb. Consume their value
	// options so a catalog path called --yes or --help is not treated as a flag.
	const valueOptions =
		resource === "skills"
			? ["--name", "--category", "--scenario", "--target", "--workspace", "--timeout"]
			: resource === "archive"
				? ["--out"]
				: ["--kind", "--from"];
	let verb: string | undefined;
	let confirmed = false;
	let dryRun = false;
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (arg === undefined) continue;
		if (valueOptions.includes(arg)) {
			index += 1;
			continue;
		}
		if (arg === "--help" || arg === "-h") return false;
		if (arg === "--yes") confirmed = true;
		if (arg === "--dry-run") dryRun = true;
		if (!arg.startsWith("-")) verb ??= arg;
	}
	if (resource === "skills") return verb === "install" || verb === "update" || verb === "sync";
	// An archive import installs packages and writes resources from an archive the
	// model may have authored; its dry run only plans.
	if (resource === "archive") return confirmable && verb === "import" && !dryRun;
	if (resource === "plugins" || resource === "extensions") {
		if (["install", "update", "remove", "enable", "disable", "pin"].includes(verb ?? "")) return true;
		// Both authoring verbs run package code (startup registration, `*.test.ts`),
		// so they need the operator the way an install does.
		return resource === "extensions" && confirmable && (verb === "test" || verb === "validate");
	}
	if (resource === "interop") return verb === "adopt" && confirmed && !dryRun;
	// A package of any kind may carry skills or require a skill dependency.
	// A dry run builds the plan and writes nothing, so it never needs a confirmation.
	if (dryRun && HUB_DRY_RUN_VERBS.includes(verb ?? "")) return false;
	return HUB_MUTATION_VERBS.includes(verb ?? "");
}

/** The hub verbs that implement --dry-run (src/cli/hub.ts, src/cli/hub-import.ts). */
const HUB_DRY_RUN_VERBS = ["install", "import", "update", "enable", "disable", "remove", "package"];

const HUB_MUTATION_VERBS = [
	"install",
	"import",
	"update",
	"remove",
	"enable",
	"disable",
	"pin",
	"register",
	"package",
	"sync",
	"push",
	"remote",
];
