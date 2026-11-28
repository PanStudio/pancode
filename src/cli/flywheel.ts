// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { isRecord } from "../core/type-guards.js";
import {
	bundleDeletionRequest,
	forgetIntakeBundle,
	ghEnvironment,
	INTAKE_CLOSED_RETENTION_DAYS,
	INTAKE_MAX_AGE_DAYS,
	REPORT_ID,
	REPORT_SHARING_OFF,
	type ReportCommandRunner,
	readIntakeIndex,
	runReportCommand,
	sweepIntakeStore,
} from "../domains/report/index.js";
import { printError } from "./argv.js";

export const FLYWHEEL_HELP = `pancode dev flywheel --sweep [--store <dir>]
pancode dev flywheel --forget <reportId> [--store <dir>]

Report sharing is turned off in this build: the ranked backlog and --pull print
so and exit 2. What stays is the maintainers' local intake store (--store,
default ~/.local/share/pancode-intake/store), which holds the bundles shares
delivered.

--sweep reads PanStudio/pancode's latest 1000 has-bundle issues through your gh:
a report's own "Please delete the diagnostic bundle for report <id>." comment
from the reporter forgets that bundle, and a debug-only bundle is deleted and
marked expired once its issue has been closed ${INTAKE_CLOSED_RETENTION_DAYS} days or it is ${INTAKE_MAX_AGE_DAYS} days old. Bundles
with the dataset scope are kept. --forget <reportId> deletes a bundle on request,
marks it forgotten, adds it to exclusions.txt so no later dataset takes it, and
prints the confirmation to post. --forget needs no gh.
`;

const CODER_REPOSITORY = "PanStudio/pancode";

export interface FlywheelDeps {
	run?: ReportCommandRunner;
	findGh?: () => string | null;
	env?: NodeJS.ProcessEnv;
	stateDir?: string;
	cwd?: string;
	now?: () => Date;
	stdout?: (text: string) => void;
	stderr?: (text: string) => void;
}

interface Gh {
	run: (args: string[], timeoutMs?: number) => ReturnType<ReportCommandRunner>;
}

function ghFor(gh: string, deps: FlywheelDeps): Gh {
	const run = deps.run ?? runReportCommand;
	const env = ghEnvironment(deps.env ?? process.env);
	return {
		run: (args, timeoutMs = 60_000) => run(gh, ["api", "--hostname", "github.com", ...args], { timeoutMs, env }),
	};
}

function firstLine(result: { stdout: string; stderr: string; timedOut: boolean }): string {
	return result.timedOut ? "timed out" : ((result.stderr.trim() || result.stdout.trim()).split("\n")[0] ?? "");
}

function at(value: unknown, ...path: string[]): unknown {
	let here = value;
	for (const key of path) here = isRecord(here) ? here[key] : undefined;
	return here;
}

function num(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function str(value: unknown): string | null {
	return typeof value === "string" && value !== "" ? value : null;
}

const POINTER_SCAN_LIMIT = 1000;
const PAGE_SIZE = 100;

interface PointerScan {
	/** Each scanned has-bundle issue's closing time (null while open) and its author, for the sweep. */
	issues: Map<number, { closedAt: string | null; author: string | null }>;
}

/** The coder repository's latest has-bundle issues, up to the scan limit. */
async function sharePointers(gh: Gh): Promise<PointerScan> {
	const scan: PointerScan = { issues: new Map() };
	for (let page = 1; page <= POINTER_SCAN_LIMIT / PAGE_SIZE; page += 1) {
		const issues = await gh.run([
			`repos/${CODER_REPOSITORY}/issues?state=all&labels=has-bundle&sort=created&direction=desc&per_page=${PAGE_SIZE}&page=${page}`,
		]);
		if (issues.exitCode !== 0) throw new Error(`gh could not list the has-bundle issues: ${firstLine(issues)}`);
		const items = JSON.parse(issues.stdout) as unknown[];
		for (const item of items) {
			const number = num(at(item, "number"));
			if (number !== null)
				scan.issues.set(number, { closedAt: str(at(item, "closed_at")), author: str(at(item, "user", "login")) });
		}
		if (items.length < PAGE_SIZE) break;
	}
	return scan;
}

/**
 * Honour the reporters' deletion requests, then expire debug-only bundles (R-20). A request counts when it is the exact
 * bundle deletion comment, on the issue that holds the bundle, by that issue's author; any other is listed.
 * Returns the number of issues whose comments could not be read.
 */
async function sweepStore(
	gh: Gh,
	scan: PointerScan,
	store: string,
	now: Date,
	out: (text: string) => void,
	fail: (message: string) => void,
): Promise<number> {
	let failures = 0;
	for (const line of readIntakeIndex(store)) {
		if (line.status !== "held" || line.issue === null) continue;
		const comments: unknown[] = [];
		for (let page = 1; page <= POINTER_SCAN_LIMIT / PAGE_SIZE; page += 1) {
			const listed = await gh.run([
				`repos/${CODER_REPOSITORY}/issues/${line.issue}/comments?per_page=${PAGE_SIZE}&page=${page}`,
			]);
			if (listed.exitCode !== 0) {
				failures += 1;
				fail(`${line.reportId}: gh could not list the comments on #${line.issue}: ${firstLine(listed)}`);
				break;
			}
			const items = JSON.parse(listed.stdout) as unknown[];
			comments.push(...items);
			if (items.length < PAGE_SIZE) break;
		}
		const author = scan.issues.get(line.issue)?.author ?? null;
		for (const comment of comments) {
			if (bundleDeletionRequest(str(at(comment, "body")) ?? "") !== line.reportId) continue;
			const by = str(at(comment, "user", "login"));
			if (author !== null && by === author) {
				const forgotten = forgetIntakeBundle(store, line.reportId);
				out(
					`${line.reportId}: its reporter asked on #${line.issue} to delete it; deleted and excluded. To post: ${forgotten.confirmation}\n`,
				);
				break;
			}
			out(
				`${line.reportId}: ${by ?? "someone"} asked on #${line.issue} to delete it but did not file the report; dev flywheel --forget ${line.reportId} deletes it if that is right\n`,
			);
		}
	}
	const closedAt = new Map<number, string>();
	for (const [issue, facts] of scan.issues) if (facts.closedAt !== null) closedAt.set(issue, facts.closedAt);
	for (const reportId of sweepIntakeStore(store, closedAt, now))
		out(`${reportId}: debug-only bundle past its retention; deleted and marked expired\n`);
	return failures;
}

/** `dev flywheel`: exit 0 swept or forgotten, 1 on no access or a failed sweep, 2 on usage errors or sharing turned off. */
export async function runFlywheelCommand(argv: ReadonlyArray<string>, deps: FlywheelDeps = {}): Promise<number> {
	const out = deps.stdout ?? ((text: string) => process.stdout.write(text));
	const stderr = deps.stderr;
	const fail =
		stderr === undefined ? (message: string) => printError(message) : (message: string) => stderr(`error: ${message}\n`);
	if (argv.includes("--help") || argv.includes("-h")) {
		out(FLYWHEEL_HELP);
		return 0;
	}
	if (!argv.includes("--sweep") && !argv.includes("--forget")) {
		(stderr ?? ((text: string) => process.stderr.write(text)))(`${REPORT_SHARING_OFF}\n`);
		return 2;
	}
	let sweep = false;
	const values = new Map<string, string>();
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index] as string;
		if (arg === "--sweep") {
			sweep = true;
			continue;
		}
		const value = argv[index + 1];
		if (!["--store", "--forget"].includes(arg)) {
			fail(`unknown argument: ${arg}`);
			(stderr ?? ((text: string) => process.stderr.write(text)))(FLYWHEEL_HELP);
			return 2;
		}
		if (value === undefined || value.startsWith("--")) {
			fail(`${arg} needs a value`);
			return 2;
		}
		values.set(arg, value);
		index += 1;
	}
	const forget = values.get("--forget");
	if (sweep && forget !== undefined) {
		fail("--sweep and --forget are separate commands; pass one");
		return 2;
	}
	if (forget !== undefined && !REPORT_ID.test(forget)) {
		fail(`--forget takes a report id (rpt_ and 26 characters), not ${forget}`);
		return 2;
	}
	const store = resolve(
		deps.cwd ?? process.cwd(),
		values.get("--store") ?? join(homedir(), ".local", "share", "pancode-intake", "store"),
	);
	if (forget !== undefined) {
		// Deleting a bundle on request is local: it needs no gh and no key.
		const forgotten = forgetIntakeBundle(store, forget);
		out(
			`${forget}: ${forgotten.held ? "bundle deleted, marked forgotten" : "not in the store; recorded"} and excluded from every later dataset\nTo post on its issue: ${forgotten.confirmation}\n`,
		);
		return 0;
	}
	let gh: string | null;
	if (deps.findGh !== undefined) gh = deps.findGh();
	else {
		const { resolveToolBinary } = await import("../lib/programs/index.js");
		gh = resolveToolBinary("gh").binaryPath;
	}
	if (gh === null) {
		fail("dev flywheel reads GitHub through gh, which is not on PATH");
		return 1;
	}
	try {
		const api = ghFor(gh, deps);
		const failures = await sweepStore(api, await sharePointers(api), store, deps.now?.() ?? new Date(), out, fail);
		return failures === 0 ? 0 : 1;
	} catch (error) {
		fail(error instanceof Error ? error.message : String(error));
		return 1;
	}
}
