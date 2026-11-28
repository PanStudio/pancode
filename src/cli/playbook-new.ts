// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolvePackageRoot } from "../core/package-root.js";
import { pancodeProjectRoot } from "../core/project-root.js";
import { jsonDocument, writeCliFailure } from "./kit/json-out.js";
import type { ErrorSlug } from "./kit/slugs.js";

const BUILTINS = [
	"build-review",
	"build-test",
	"build-test-review",
	"build-verify",
	"build-verify-review-fix",
	"debug-fix",
	"docs-review",
	"plan-build",
	"plan-build-review",
	"review-fix",
	"scout-build-review",
	"sdlc",
	"seat-stretch",
	"tdd",
	"test-fix",
	"tests-add",
] as const;
const SAFE_STEM = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/u;

export function runPlaybookNew(argv: ReadonlyArray<string>): number {
	const json = argv.includes("--json");
	const args = argv.filter((arg) => arg !== "--json");
	const usage = (message: string, slug: ErrorSlug = "usage"): number => {
		writeCliFailure({ path: ["playbook", "new"], slug, message, json });
		return 2;
	};
	const name = args[0];
	const fromIndex = args.indexOf("--from");
	const builtin = fromIndex === -1 ? undefined : args[fromIndex + 1];
	const known = BUILTINS.join(", ");
	if (name === undefined) return usage("name the new playbook: pancode playbook new <name> --from <builtin>");
	if (name.startsWith("-") && name !== "--from") return usage(`unknown flag: ${name}`, "unknown_flag");
	if (!SAFE_STEM.test(name)) return usage(`'${name}' is not a safe file stem`);
	if (fromIndex === -1 || builtin === undefined) return usage("--from <builtin> is required");
	const expected = new Set([name, "--from", builtin]);
	const unknown = args.find((arg) => !expected.has(arg));
	if (unknown !== undefined)
		return unknown.startsWith("-")
			? usage(`unknown flag: ${unknown}`, "unknown_flag")
			: usage(`unknown argument: ${unknown}`);
	if (!(BUILTINS as ReadonlyArray<string>).includes(builtin)) {
		return usage(`unknown built-in playbook '${builtin}'. Known built-in playbooks: ${known}`);
	}
	const destination = join(pancodeProjectRoot(process.cwd(), "playbooks"), ".pancode", "playbooks", `${name}.md`);
	if (existsSync(destination)) return usage(`destination already exists: ${destination}`, "io");
	const source = join(resolvePackageRoot(), "src", "domains", "agents", "playbooks", `${builtin}.md`);
	mkdirSync(dirname(destination), { recursive: true });
	const sourceText = readFileSync(source, "utf8");
	const renamed = sourceText.replace(/^name:\s*[^\n]+$/mu, `name: ${name}`);
	writeFileSync(destination, renamed, { flag: "wx" });
	process.stdout.write(json ? `${JSON.stringify(jsonDocument({ path: destination }))}\n` : `${destination}\n`);
	return 0;
}
