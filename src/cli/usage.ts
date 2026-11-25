// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { resolve } from "node:path";
import { validateSettingsFile } from "../core/config.js";
import { cwdHash } from "../core/cwd-hash.js";
import { COST_NOT_MEASURED } from "../core/telemetry/render.js";
import { pancodeStateDir } from "../core/xdg.js";
import { usageReport } from "../domains/telemetry/read-model-usage.js";
import { emptyUsageDiagnostics, usageWindow } from "../domains/telemetry/usage-window.js";
import { printError } from "./shared.js";
import { economyLines } from "./telemetry-read.js";

const HELP = `pancode usage [report] [--repo <path>] [--days <n>] [--json]

Sessions, worker runs, tool and permission decisions, tokens and spend over the
last days, read from PanCode's telemetry. Nothing is written. Input counts the
whole prompt, cached and fresh.

  --repo <path>   only this repository, with its .pancode/worktrees task worktrees
  --days <n>      window in days (default 30)
  --json          print the report as JSON
`;
const DEFAULT_WINDOW_DAYS = 30;

interface ParsedArgs {
	command?: string;
	repo?: string;
	days: number;
	json: boolean;
	help: boolean;
}

function parseArgs(argv: ReadonlyArray<string>): ParsedArgs {
	const out: ParsedArgs = { days: DEFAULT_WINDOW_DAYS, json: false, help: false };
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === undefined) continue;
		if (!out.command && !arg.startsWith("-")) {
			out.command = arg;
			continue;
		}
		switch (arg) {
			case "--json":
				out.json = true;
				break;
			case "--help":
			case "-h":
				out.help = true;
				break;
			case "--repo": {
				const value = argv[i + 1];
				if (!value || value.startsWith("-")) throw new Error("--repo requires a path");
				out.repo = value;
				i += 1;
				break;
			}
			case "--days": {
				const value = argv[i + 1];
				const days = value === undefined ? Number.NaN : Number.parseInt(value, 10);
				if (!Number.isInteger(days) || days <= 0) throw new Error("--days requires a positive integer");
				out.days = days;
				i += 1;
				break;
			}
			default:
				throw new Error(`unknown flag: ${arg}`);
		}
	}
	return out;
}

export async function runUsageCommand(argv: ReadonlyArray<string>): Promise<number> {
	let parsed: ParsedArgs;
	try {
		parsed = parseArgs(argv);
	} catch (error) {
		printError(error instanceof Error ? error.message : String(error));
		process.stderr.write(HELP);
		return 2;
	}
	if (parsed.help) {
		process.stdout.write(HELP);
		return 0;
	}
	if (parsed.command !== undefined && parsed.command !== "report") {
		printError(`unknown usage command: ${parsed.command}`);
		process.stderr.write(HELP);
		return 2;
	}
	const now = Date.now();
	const from = now - parsed.days * 24 * 60 * 60 * 1000;
	const path = parsed.repo === undefined ? null : resolve(parsed.repo);
	const diagnostics = emptyUsageDiagnostics();
	const { repo } = await usageWindow(
		pancodeStateDir(),
		path === null ? null : cwdHash(path),
		parsed.days,
		now,
		diagnostics,
	);
	const report = usageReport(repo, from, now, validateSettingsFile().settings.funding);
	for (const note of diagnostics.notes) process.stderr.write(`pancode usage: ${note}\n`);
	if (parsed.json) {
		process.stdout.write(`${JSON.stringify(report)}\n`);
		return 0;
	}
	const out = (text: string) => process.stdout.write(`${text}\n`);
	out(
		`usage report: ${new Date(from).toISOString()} -> ${new Date(now).toISOString()}${path === null ? "" : ` repo=${path}`}`,
	);
	out(`sessions in window: ${report.sessions.display}`);
	out(`dispatch runs in window: ${report.runs.display}`);
	if (report.stepPipelines.settled.fact.kind !== "measured" || report.stepPipelines.settled.fact.value > 0)
		out(
			`step pipelines: ${report.stepPipelines.settled.display} ended, ${report.stepPipelines.incomplete.display} before the step tool reported pipelineDone`,
		);
	out(`tool decisions: ${report.decisions.total.display} (${report.decisions.blocked.display} blocked/denied)`);
	const approvals = report.approvals;
	out(
		`permission decisions: ${approvals.requested.display} requested, ${approvals.granted.display} granted, ${approvals.denied.display} denied, ${approvals.expired.display} expired; approval rate ${approvals.rate.display}`,
	);
	const judge = report.safetyJudge;
	out(
		`safety judge reviews: ${judge.reviewed.display} (${judge.allowed.display} allowed, ${judge.blocked.display} blocked, ${judge.escalated.display} sent to you, ${judge.noVerdict.display} without a verdict)`,
	);
	out(
		`tokens: ${report.tokens.total.display} (input ${report.tokens.prompt.display} incl. cached ${report.tokens.cacheRead.display}, output ${report.tokens.output.display})`,
	);
	// A window nobody priced in USD (a seat-billed route) shows its spend once, not once per group in every cut.
	if (report.cost.every((cost) => cost.total.usd.display === COST_NOT_MEASURED)) out(`spend: ${COST_NOT_MEASURED}`);
	else
		for (const cost of report.cost) {
			out(`spend by ${cost.groupBy}: ${cost.total.usd.display}`);
			for (const group of cost.groups) out(`  ${group.key}: ${group.usd.display}`);
		}
	// Every cost cut folds the same window, so one economy stands for all of them.
	const economy = report.cost[0]?.economy;
	if (economy !== undefined) for (const line of economyLines(economy)) out(line);
	for (const tool of report.decisions.tools)
		out(`tool ${tool.tool}: ${tool.count.display} ${tool.count.display === "1" ? "decision" : "decisions"}`);
	return 0;
}
