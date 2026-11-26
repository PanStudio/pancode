// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { deepStrictEqual, ok } from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { parse } from "yaml";

type Workflow = Record<string, unknown> & { permissions?: unknown; jobs?: Record<string, Record<string, unknown>> };

const directory = ".github/workflows";
/** The only job whose token may write repository contents: the signed hub index. A release writes with the App's token. */
const CONTENTS_WRITERS = ["hub-index.yml#sign"];
/** The ci.yml job name that expands to the branch-protection checks ci (22) and ci (24). */
const CI_TEST_JOB = `ci (\${{ matrix.node }})`;
const PINNED = /^[^@\s]+@[0-9a-f]{40}$/u;

function readWorkflows(): Record<string, Workflow> {
	return Object.fromEntries(
		readdirSync(directory)
			.filter((file) => /\.ya?ml$/u.test(file))
			.sort()
			.map((file) => [file, parse(readFileSync(join(directory, file), "utf8")) as Workflow]),
	);
}

const writesContents = (permissions: unknown): boolean =>
	permissions === "write-all" ||
	(typeof permissions === "object" &&
		permissions !== null &&
		(permissions as Record<string, unknown>).contents === "write");

/** Every `[path, value]` under `key` anywhere in `value`. */
function findKey(value: unknown, key: string, path = ""): Array<[string, unknown]> {
	if (Array.isArray(value)) return value.flatMap((item, index) => findKey(item, key, `${path}[${index}]`));
	if (typeof value !== "object" || value === null) return [];
	return Object.entries(value).flatMap(
		([name, inner]): Array<[string, unknown]> => [
			...(name === key ? [[`${path}.${name}`, inner] as [string, unknown]] : []),
			...findKey(inner, key, `${path}.${name}`),
		],
	);
}

function workflowPolicyProblems(workflows: Record<string, Workflow>): string[] {
	const problems: string[] = [];
	const writers: string[] = [];
	for (const [file, workflow] of Object.entries(workflows)) {
		if (writesContents(workflow.permissions)) problems.push(`${file} grants contents: write to every job`);
		for (const [id, job] of Object.entries(workflow.jobs ?? {}))
			if (writesContents(job.permissions)) writers.push(`${file}#${id}`);
		for (const [path] of findKey(workflow, "continue-on-error"))
			problems.push(`${file} uses continue-on-error at ${path}`);
		if (/ignore[-_]scripts/iu.test(JSON.stringify(workflow))) problems.push(`${file} skips install scripts`);
		if (JSON.stringify(workflow).includes("--if-present"))
			problems.push(`${file} passes a missing script with --if-present`);
		for (const [, ref] of findKey(workflow, "uses"))
			if (typeof ref === "string" && !ref.startsWith("./") && !PINNED.test(ref))
				problems.push(`${file} uses ${ref}, not pinned by a full commit SHA`);
	}
	if (JSON.stringify(writers.sort()) !== JSON.stringify(CONTENTS_WRITERS))
		problems.push(`contents: write is granted to ${writers.join(", ") || "no job"}; only ${CONTENTS_WRITERS.join(", ")}`);
	const test = workflows["ci.yml"]?.jobs?.test as
		| { name?: unknown; strategy?: { matrix?: { node?: unknown } } }
		| undefined;
	if (test?.name !== CI_TEST_JOB || JSON.stringify(test.strategy?.matrix?.node) !== "[22,24]")
		problems.push("ci.yml has no ci (22) and ci (24) jobs");
	return problems;
}

describe("workflow policy", () => {
	it("keeps write access, failure handling, scripts, action pins and ci job names as the release expects", () => {
		deepStrictEqual(workflowPolicyProblems(readWorkflows()), []);
	});

	it("fails a workflow that tolerates failure, adds a contents writer, floats an action or renames the ci jobs", () => {
		const mutated = (change: (workflows: Record<string, Workflow>) => void): string[] => {
			const workflows = readWorkflows();
			change(workflows);
			return workflowPolicyProblems(workflows);
		};
		type Job = Record<string, unknown> & { steps: Array<Record<string, unknown>> };
		const job = (workflows: Record<string, Workflow>, file: string, id: string): Job => {
			const found = workflows[file]?.jobs?.[id];
			ok(found, `${file} has a job ${id}`);
			return found as Job;
		};
		const cases: Array<[string, (workflows: Record<string, Workflow>) => void, RegExp]> = [
			[
				"step continue-on-error",
				(w) => Object.assign(job(w, "ci.yml", "test").steps[0] ?? {}, { "continue-on-error": true }),
				/continue-on-error/u,
			],
			[
				"job continue-on-error",
				(w) => Object.assign(job(w, "ci.yml", "check"), { "continue-on-error": true }),
				/continue-on-error/u,
			],
			[
				"second writer",
				(w) => Object.assign(job(w, "ci.yml", "build"), { permissions: { contents: "write" } }),
				/contents: write/u,
			],
			[
				"write-all job",
				(w) => Object.assign(job(w, "report-labels.yml", "label"), { permissions: "write-all" }),
				/contents: write/u,
			],
			[
				"workflow-wide writer",
				(w) => Object.assign(w["ci.yml"] as Workflow, { permissions: { contents: "write" } }),
				/every job/u,
			],
			[
				"renamed ci (22)",
				(w) => Object.assign(job(w, "ci.yml", "test"), { name: "ci (node 22)" }),
				/no ci \(22\) and ci \(24\) jobs/u,
			],
			[
				"ignore-scripts",
				(w) => job(w, "ci.yml", "test").steps.push({ run: "pnpm install --ignore-scripts" }),
				/install scripts/u,
			],
			[
				"if-present",
				(w) => job(w, "hub-index.yml", "sign").steps.push({ run: "pnpm run --if-present hub:check" }),
				/--if-present/u,
			],
			["floating action", (w) => job(w, "ci.yml", "test").steps.push({ uses: "actions/checkout@v6" }), /not pinned/u],
		];
		for (const [label, change, expected] of cases) {
			const problems = mutated(change);
			ok(problems.length === 1 && expected.test(problems[0] as string), `${label}: ${JSON.stringify(problems)}`);
		}
	});
});
