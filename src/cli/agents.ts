// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { loadDomains } from "../core/domain-loader.js";
import { AgentsDomainModule } from "../domains/agents/module.js";
import { type AgentSpec, isUserVisibleAgent } from "../domains/agents/spec.js";
import { ConfigDomainModule } from "../domains/config/module.js";
import { ExtensionsDomainModule } from "../domains/extensions/module.js";
import { ensurePancodeState } from "../domains/install/index.js";
import { PluginsDomainModule } from "../domains/plugins/module.js";
import { SafetyDomainModule } from "../domains/safety/module.js";
import { writeCliFailure } from "./kit/json-out.js";

const HELP = `pancode agents [list] [--json] [--all]
pancode agents validate [--json]

List user-facing agent specs from built-in, plugin, user, and project recipes.

Flags:
  --json   emit specs as JSON instead of the formatted table
  --all    include shadow/internal specs reserved for PanCode orchestration

validate checks this repository's agent setup: project and user agent recipes,
project and user skills, and the fleet bindings in .pancode/settings.local.yaml.
It prints every problem as one "file: field: message" line and exits 1 when
there is any, so the whole list can be handed back to whoever wrote the files.
`;

export async function runAgentsCommand(args: ReadonlyArray<string>): Promise<number> {
	if (args.includes("--help") || args.includes("-h")) {
		process.stdout.write(HELP);
		return 0;
	}
	if (args[0] === "validate") return runAgentsValidate(args.slice(1));
	// `list` is the list verb every other group spells (C14); the bare form stays the default read.
	const listVerb = args[0] === "list";
	const options = listVerb ? args.slice(1) : args;
	const json = options.includes("--json");
	const all = options.includes("--all");
	const unknown = options.find((arg) => arg !== "--json" && arg !== "--all");
	if (unknown) {
		writeCliFailure({
			path: listVerb ? ["agents", "list"] : ["agents"],
			slug: unknown.startsWith("-") ? "unknown_flag" : "unknown_command",
			message: unknown.startsWith("-") ? `unknown flag: ${unknown}` : `unknown agents command: ${unknown}`,
			json,
		});
		return 2;
	}
	ensurePancodeState();
	const result = await loadDomains([
		ConfigDomainModule,
		SafetyDomainModule,
		ExtensionsDomainModule,
		PluginsDomainModule,
		AgentsDomainModule,
	]);
	const agents = result.getContract("agents");
	if (!agents) {
		process.stderr.write("agents: domain not loaded\n");
		await result.stop();
		return 1;
	}
	const specs = all ? agents.listSpecs() : agents.listSpecs().filter(isUserVisibleAgent);
	if (json) {
		const withoutBody = specs.map(({ body: _body, ...rest }) => rest);
		process.stdout.write(`${JSON.stringify(withoutBody, null, 2)}\n`);
	} else {
		for (const spec of specs) {
			renderLine(spec);
		}
	}
	await result.stop();
	return 0;
}

async function runAgentsValidate(args: ReadonlyArray<string>): Promise<number> {
	const json = args.includes("--json");
	const unknown = args.find((arg) => arg !== "--json");
	if (unknown) {
		writeCliFailure({
			path: ["agents", "validate"],
			slug: unknown.startsWith("-") ? "unknown_flag" : "usage",
			message: unknown.startsWith("-") ? `unknown flag: ${unknown}` : `unexpected argument: ${unknown}`,
			json,
		});
		return 2;
	}
	ensurePancodeState();
	const { formatHarnessIssues, validateHarnessAt } = await import("../domains/agents/harness-validate.js");
	const workspaceRoot = process.cwd();
	const issues = validateHarnessAt(workspaceRoot);
	if (json) {
		process.stdout.write(`${JSON.stringify({ ok: issues.length === 0, workspaceRoot, issues }, null, 2)}\n`);
	} else if (issues.length === 0) {
		process.stdout.write(`agents validate: no problems found in ${workspaceRoot}\n`);
	} else {
		process.stdout.write(`${formatHarnessIssues(issues)}\n`);
	}
	return issues.length === 0 ? 0 : 1;
}

function renderLine(spec: AgentSpec): void {
	const shape = `${spec.audience}/${spec.category}/${spec.capabilityClass}/${spec.latencyClass}`;
	const skills = spec.skills.length > 0 ? ` skills=${spec.skills.join(",")}` : "";
	const maximum = spec.budget.maximum ? `..${spec.budget.maximum.toolCalls}` : "";
	const budget = `${spec.budget.toolCalls}${maximum}/${spec.budget.synthesis ? "synthesize" : "stop"}`;
	process.stdout.write(`${spec.id.padEnd(20)} ${shape.padEnd(48)} ${spec.description}${skills} budget=${budget}\n`);
}
