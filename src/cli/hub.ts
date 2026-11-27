// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { writeDiagnostic } from "../core/diagnostics.js";
import { GLYPH } from "../core/glyphs.js";
import { discoveryScore } from "../core/harness-discovery.js";
import { detectPancodeRepo, PANCODE_SELF_DEVELOPMENT_SKILLS } from "../core/pancode-repo.js";
import { pancodeStateDir } from "../core/xdg.js";
import { ENVELOPE_SEAT_BELT, envelopeLines } from "../domains/extensions/envelope-review.js";
import { readExtensionInstallRecord } from "../domains/extensions/index.js";
import { HUB_VERIFIED_LICENSES, pluginLocalPath } from "../domains/plugins/catalog.js";
import {
	type PluginCandidate,
	type PluginScope,
	readPluginInstallRecord,
	reloadPluginResources,
} from "../domains/plugins/index.js";
import {
	type BuiltinHubServer,
	builtinHubServerFor,
	confirmHubRemote,
	type HubEntry,
	hubEntryDrift,
	hubEntryPublisher,
	hubEntryRef,
	hubWorkspace,
	isBuiltinServerRow,
	pinHubEntry,
	planHubInstall,
	registerHubPackage,
	releaseHubPlan,
	resolveHubPackage,
	resolveInstalledHubEntry,
	syncHub,
} from "../domains/resources/hub.js";
import {
	applyHubLifecycle,
	builtinServerAnswer,
	type HubApplyResult,
	type HubLifecyclePlan,
	type HubOperation,
	planHubLifecycle,
	syncHubPackBinaries,
} from "../domains/resources/hub-actions.js";
import {
	type HubComponentSourceClass,
	type HubCopyInspection,
	type HubCopyUpdate,
	type HubOrigin,
	hubQueryMatches,
	inactiveCopyRemedy,
	inactiveHubCopies,
	inspectHubCopy,
	readHubInventory,
} from "../domains/resources/hub-inventory.js";
import { HUB_ROOT_PUBLIC_KEYS } from "../domains/resources/hub-keys.js";
import {
	installedCopiesNamed,
	listInstalledHubPackages as listInstalledPlugins,
	readHubManifest as readPluginManifest,
} from "../domains/resources/hub-packages.js";
import { describeHubPair } from "../domains/resources/hub-pairing.js";
import { revokedHubDigests } from "../domains/resources/hub-revocations.js";
import {
	autoRefreshRemoteIndex,
	configuredHubIndexUrl,
	describeRefusal,
	readHubTrustRefusal,
	readHubTrustState,
	refreshRemoteIndex,
} from "../domains/resources/hub-trust.js";
import {
	type HubEntryKind,
	type HubProvidedResource,
	type HubTier,
	isHubComponentKind,
	isHubKind,
} from "../domains/resources/hub-types.js";
import { validateHubPackage } from "../domains/resources/hub-validation.js";
import { bareSkillRemedy, isBareSkillDirectory, packageBareSkill } from "../domains/resources/skills/bare-skill.js";
import { knownSkillNames } from "../domains/resources/skills/marketplace.js";
import { createProcessJournal } from "../domains/telemetry/process-journal.js";
import { formatColumns } from "./argv.js";
import { didYouMean } from "./kit/did-you-mean.js";
import { helpRequested } from "./kit/help.js";
import { jsonDocument, writeCliFailure } from "./kit/json-out.js";
import { printError, printOk } from "./shared.js";
import { leaves as hubLeaves } from "./specs/hub.js";
import { terminalColumns, truncate, wrapPlain } from "./text-layout.js";

const HELP = `pancode hub <command>

PanHub, one collection of packs: plugin, extension, skill, agent, prompt, playbook, server.
Common: pancode hub list, pancode hub search <query>, pancode hub install <name>.

Commands:
${hubLeaves.map((leaf) => `  pancode ${leaf.usage}`).join("\n")}

Scope: install and register default to user scope. Other changes pick the
  project copy when there is one; --user or --project picks exactly that copy.
Plans: every change builds one reviewed plan, rechecks it under the pack lock,
  refuses to break enabled dependents, and reports each pack's outcome;
  --dry-run prints the plan and writes nothing.
Sessions: a CLI never refreshes a running session. hub reload refreshes only
  its own process; inside a session use /reload hub.
Search: list and search are pack-oriented; --kind and a query also match what
  a plugin provides and return the owning pack. --from <index.yaml> picks an index.
  Outside PanCode's own checkout they leave out its authoring skills (pancode-dev,
  pancode-test) unless installed; --all lists them.
Updates: a copy behind its catalog row says so; update --all brings every such
  copy forward except extensions, which are reviewed one at a time.
Servers: the PanKit servers PanCode carries are built in and have no copy.
  inspect shows their tools; install and update say so and write nothing;
  enable, disable and remove refuse.
Import: reads a portable, Claude Code or Codex plugin, or a bare skill directory,
  from a path or GitHub tree URL into a foreign-trust pack; it never activates
  hooks, MCP, LSP or scripts.
Components: versioned, body-free rows for discovered skills, agents, prompts and
  playbooks with owner, origin, availability and invocation; --all adds the
  internal diagnostic agents.
Trust: rows show publisher, tier (core, verified, listed) and licence; a listed
  pack installs with foreign trust. Refresh keeps an index only when its
  signatures verify against this build's root key; install, update and list
  refresh first when the kept index is older than six hours. No read fetches a
  remote source or activates a component.
Status: the kept index, its sequences, expiry and revocations.
Package: writes a plugin.json beside a bare skill's SKILL.md so an ordinary
  install keeps what it bundles; the skill's own files are not touched.
Skills: discovered runtime skills, including unmanaged local files. Inventory
  is the fixed, body-free skill read for GUI hosts.
Sync: sync fast-forwards the PanHub catalog from its Git remote and push pushes
  to it; both need integrations.hub.sync on and a remote confirmed with
  hub remote confirm <url>.
`;
/** Publisher, tier and licence; a licence outside the verified allowlist is labelled so it reads as a fact to check. */
function trustLabel(facts: { publisher?: string; tier?: HubTier; license?: string }): string {
	const licence =
		facts.license === undefined
			? undefined
			: facts.tier !== "core" && !HUB_VERIFIED_LICENSES.has(facts.license)
				? `licence: ${facts.license}`
				: facts.license;
	return [facts.publisher ?? "local", facts.tier, licence].filter((part) => part !== undefined).join(" ");
}

/** One short operator label per origin; details stay in the JSON record. */
function originLabel(origin: HubOrigin): string {
	switch (origin.kind) {
		case "bundled":
			return "bundled";
		case "remote":
			return `remote ${origin.url}`;
		case "local":
			return origin.host ? `local (${origin.host}) ${origin.path}` : `local ${origin.path}`;
		case "imported":
			return `imported from ${origin.agent}${origin.marketplace ? ` (${origin.marketplace})` : ""} ${origin.path}`;
		case "core":
			return "core";
		default:
			return origin.detail ? `unknown: ${origin.detail}` : "unknown";
	}
}

interface Parsed {
	command?: string;
	positional: string[];
	scope?: PluginScope;
	kind?: HubEntryKind;
	source?: HubComponentSourceClass;
	from?: string;
	all: boolean;
	force: boolean;
	json: boolean;
	help: boolean;
	dryRun: boolean;
	withRequirements: boolean;
}
function parse(args: ReadonlyArray<string>): Parsed {
	const out: Parsed = {
		positional: [],
		all: false,
		force: false,
		json: false,
		help: false,
		dryRun: false,
		withRequirements: false,
	};
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (!arg) continue;
		if (!out.command && !arg.startsWith("-")) out.command = arg;
		else if (arg === "--help" || arg === "-h") out.help = true;
		else if (arg === "--json") out.json = true;
		else if (arg === "--all") out.all = true;
		else if (arg === "--force" || arg === "-f") out.force = true;
		else if (arg === "--dry-run") out.dryRun = true;
		else if (arg === "--with-requirements") out.withRequirements = true;
		else if (arg === "--kind") {
			const value = args[++i];
			if (!isHubKind(value))
				throw new Error("--kind requires plugin, extension, skill, agent, prompt, playbook, or server");
			out.kind = value;
		} else if (arg === "--source") {
			const value = args[++i];
			if (!value || !["core", "package", "user", "project", "compat"].includes(value))
				throw new Error("--source requires core, package, user, project, or compat");
			out.source = value as HubComponentSourceClass;
		} else if (arg === "--from") {
			const value = args[++i];
			if (!value || value.startsWith("-")) throw new Error("--from requires an index path");
			out.from = value;
		} else if (arg === "--user" || arg === "--project") {
			const scope = arg === "--user" ? "user" : "project";
			if (out.scope && out.scope !== scope) throw new Error("--user and --project are mutually exclusive");
			out.scope = scope;
		} else if (arg.startsWith("-")) throw new Error(`unknown flag: ${arg}`);
		else out.positional.push(arg);
	}
	return out;
}
const LIFECYCLE: ReadonlyArray<HubOperation> = ["install", "update", "enable", "disable", "remove"];
/** Every `pancode hub` subcommand; `inventory` and `import` are routed before parsing. */
const HUB_COMMANDS: ReadonlyArray<string> = [
	...LIFECYCLE,
	"components",
	"drift",
	"import",
	"inspect",
	"inventory",
	"list",
	"package",
	"pin",
	"push",
	"refresh",
	"register",
	"reload",
	"remote",
	"search",
	"skills",
	"status",
	"sync",
	"validate",
];

function verb(operation: HubOperation): string {
	return operation === "install" ? "installed" : operation === "update" ? "updated" : `${operation}d`;
}

function updateLabel(update: HubCopyUpdate): string {
	return update.reason === "newer-version" ? `update ${update.version} available` : "changed content available";
}

/** Existing JSON fields stay where old callers expect them; plan and apply are additive. */
function lifecycleJson(operation: HubOperation, plan: HubLifecyclePlan, apply: HubApplyResult, ok: boolean) {
	const target = plan.steps.at(-1);
	const last = apply.outcomes.at(-1);
	const failure = apply.outcomes.find((item) => item.status === "failed" && item.error);
	const base = { ok, ...(failure ? { error: failure.error?.message } : {}), plan, apply };
	if (operation === "install" || operation === "update")
		return {
			...base,
			confirmed: !apply.dryRun && ok,
			writes: plan.steps.map((step) => ({
				ref: step.identity.ref,
				path: step.destination,
				...(step.source ? { sha256: step.source.sha256, sourceUrl: step.source.sourceUrl } : {}),
			})),
			results: apply.outcomes
				.filter((item) => item.status === "committed")
				.map((item) => (item.recovery ? { recovery: item.recovery } : {})),
			...(last?.recovery ? { recovery: last.recovery } : {}),
			id: target?.identity.name,
			path: target?.destination,
			...(target?.source ? { sha256: target.source.sha256 } : {}),
		};
	if (operation === "remove")
		return {
			...base,
			...(last?.status === "committed" ? { removed: last.identity.ref } : {}),
			...(last?.recovery ? { recovery: last.recovery } : {}),
		};
	const plugin =
		last?.status === "committed"
			? listInstalledPlugins(plan.cwd, { scope: last.identity.scope, all: true }).find(
					(item) => item.id === last.identity.name && (item.kind ?? "plugin") === last.identity.kind,
				)
			: undefined;
	return { ...base, ...(plugin ? { plugin } : {}), diagnostics: last?.diagnostics ?? [] };
}

/**
 * What each reviewed step would be allowed to do and how it pairs, printed
 * before anything is committed so a plain run and a dry run show the same plan.
 */
function printStepReviews(plan: HubLifecyclePlan): void {
	for (const step of plan.steps)
		if (step.source?.publisher)
			process.stdout.write(
				`${step.identity.ref} (${step.identity.scope}): ${trustLabel(step.source)}${step.source.commit ? ` at commit ${step.source.commit}` : ""}\n`,
			);
	for (const review of plan.reviews ?? []) {
		const step = plan.steps.find((item) => item.identity.ref === review.ref && item.identity.scope === review.scope);
		if (!step) continue;
		if (review.envelope) {
			process.stdout.write(`${review.ref} (${review.scope}) would be allowed to:\n`);
			if (review.growth !== undefined)
				process.stdout.write(
					review.growth.length === 0
						? "  reaches no further than the installed copy\n"
						: `  reaches further than the installed copy: ${review.growth.join("; ")}\n`,
				);
			const id = step.identity.kind === "extension" ? step.identity.name : undefined;
			for (const line of envelopeLines(review.envelope, id)) process.stdout.write(`  ${line}\n`);
			process.stdout.write(`  ${ENVELOPE_SEAT_BELT}\n`);
			if (review.envelopeDigest) process.stdout.write(`  envelope sha256 ${review.envelopeDigest}\n`);
		}
		for (const pair of review.pairs)
			process.stdout.write(
				`${review.ref} (${review.scope}): ${describeHubPair({ kind: step.identity.kind, name: step.identity.name }, pair)}\n`,
			);
	}
}

/** One drift line per package; a changed copy also names both digests. */
function printDrift(
	where: string,
	result: { status: "clean" | "changed" | "missing" | "unpinned"; expected?: string; observed?: string },
): void {
	const detail =
		result.status === "clean"
			? "matches its pinned content"
			: result.status === "changed"
				? `differs from its pin (pinned ${result.expected}, on disk ${result.observed}); update it or reinstall with --force`
				: result.status === "missing"
					? "has no files on disk; reinstall it"
					: "has no verified pin; reinstall it from PanHub to record one";
	process.stdout.write(`${where} ${detail}\n`);
}

/** What `hub inspect` prints without --json; the JSON document stays the full record. */
interface InspectView {
	ref: string;
	version?: string | undefined;
	description?: string | undefined;
	facts: Array<[string, string | undefined]>;
	membersHeading: string;
	members: Array<{ kind: string; name: string; description?: string | undefined; note?: string | undefined }>;
	diagnostics: string[];
}

function candidateDiagnostics(candidate: PluginCandidate): string[] {
	return candidate.diagnostics.map((item) => `${item.type}: ${item.message}${item.path ? ` (${item.path})` : ""}`);
}

/** Indented, word-wrapped prose; a stored ellipsis is drawn with the terminal's own glyph. */
function indentedProse(text: string, indent: number, width: number): string[] {
	const prose = text.endsWith("…") ? `${text.slice(0, -1)}${GLYPH.ellipsis}` : text;
	const pad = " ".repeat(indent);
	return wrapPlain(prose, Math.max(20, width - indent), indent).map((line, index) =>
		index === 0 ? `${pad}${line}` : line,
	);
}

function printInspection(view: InspectView): void {
	const width = terminalColumns();
	const lines = [`${view.ref}${view.version ? ` ${view.version}` : ""}`];
	if (view.description) lines.push(...indentedProse(view.description, 2, width));
	for (const [label, value] of view.facts) if (value) lines.push(`${label}: ${value}`);
	if (view.members.length > 0) {
		lines.push(`${view.membersHeading}:`);
		for (const member of view.members) {
			lines.push(`  ${member.kind} ${member.name}${member.note ? ` (${member.note})` : ""}`);
			if (member.description) lines.push(...indentedProse(member.description, 4, width));
		}
	}
	if (view.diagnostics.length > 0) {
		lines.push("diagnostics:");
		for (const diagnostic of view.diagnostics) lines.push(`  ${diagnostic}`);
	}
	process.stdout.write(`${lines.join("\n")}\n`);
}

/** A pack directory on disk that is not installed: its manifest facts only. */
function localInspectView(candidate: PluginCandidate): InspectView {
	const manifest = candidate.manifest;
	return {
		ref: manifest ? `${manifest.pancode.kind ?? "plugin"}:${manifest.name}` : candidate.path,
		version: manifest?.version,
		description: manifest?.description,
		facts: [
			["state", candidate.valid ? "local directory, not installed" : "local directory, invalid"],
			["path", candidate.path],
			["licence", manifest?.license],
			["resources", manifest ? Object.keys(manifest.pancode.resources).join(", ") : undefined],
			["requires", manifest?.pancode.requires?.join(", ")],
			["sha256", candidate.contentDigest],
		],
		membersHeading: "components",
		members: [],
		diagnostics: candidateDiagnostics(candidate),
	};
}

function installedInspectView(installed: { description: string }, inspection: HubCopyInspection): InspectView {
	const copy = inspection.copy;
	const state = [
		`${copy.state} in ${copy.scope} scope`,
		...(copy.overriddenBy ? [`the ${copy.overriddenBy} copy wins`] : []),
		...(copy.update ? [updateLabel(copy.update)] : []),
	].join("; ");
	return {
		ref: copy.ref,
		version: copy.version,
		description: installed.description,
		facts: [
			["state", state],
			["next", copy.state === "loadable" || copy.state === "shadowed" ? undefined : inactiveCopyRemedy(copy)],
			["origin", originLabel(copy.origin)],
			["trust", copy.trust],
			["format", copy.format],
			["path", copy.root],
			["sha256", copy.observedDigest ?? copy.recordedDigest],
			["installed", copy.installedAt],
			[
				"needs on this host",
				inspection.prerequisites.map((item) => `${item.type} ${item.identifier}`).join(", ") || undefined,
			],
		],
		membersHeading: "components",
		members: [
			...inspection.resources.map((resource) => ({
				kind: resource.kind,
				name: resource.name,
				description: resource.description,
				note: [resource.componentId ? `component ${resource.componentId}` : "", resource.valid ? "" : "invalid"]
					.filter(Boolean)
					.join(", "),
			})),
			...inspection.ancillary.map((item) => ({ kind: item.kind, name: item.id, note: item.valid ? "" : "invalid" })),
		],
		diagnostics: [
			...copy.diagnostics,
			...inspection.diagnostics,
			...inspection.resources.flatMap((resource) => resource.diagnostics.map((item) => `${resource.name}: ${item}`)),
		],
	};
}

function catalogInspectView(
	entry: HubEntry,
	candidate: PluginCandidate,
	record: { origin: HubOrigin; format?: string; provides?: HubProvidedResource[] } | undefined,
): InspectView {
	const ref = hubEntryRef(entry);
	return {
		ref,
		version: entry.version ?? candidate.manifest?.version,
		description: entry.description || candidate.manifest?.description,
		facts: [
			["state", `not installed; install with pancode hub install ${ref}`],
			["origin", record ? originLabel(record.origin) : undefined],
			["trust", trustLabel({ ...entry, publisher: hubEntryPublisher(entry) })],
			["format", record?.format],
			["requires", entry.requires?.join(", ")],
			["sha256", candidate.contentDigest ?? entry.sha256],
		],
		membersHeading: "provides",
		members: (record?.provides ?? []).map((hint) => ({
			kind: hint.kind,
			name: hint.name,
			description: hint.description,
		})),
		diagnostics: candidateDiagnostics(candidate),
	};
}

/** A server PanCode carries: its row, its tools with their classes and the environment names it passes through. */
function builtinInspectView(server: BuiltinHubServer): InspectView {
	const entry = server.entry;
	return {
		ref: server.ref,
		version: entry.version ?? server.version,
		description: entry.description || server.title,
		facts: [
			[
				"state",
				server.revoked ? "built in, revoked" : server.damaged ? "built in, damaged" : "built in; pancode mcp list shows it",
			],
			["origin", "bundled"],
			["trust", trustLabel({ ...entry, publisher: hubEntryPublisher(entry) })],
			["environment", server.damaged ? undefined : server.environment.join(", ") || "none"],
			["sha256", entry.sha256],
		],
		membersHeading: "tools",
		members: server.tools.map((tool) => ({ kind: "tool", name: tool.name, note: tool.actionClass })),
		diagnostics: [server.revoked, server.damaged ? `damaged: ${server.damaged}` : undefined].filter(
			(line): line is string => line !== undefined,
		),
	};
}

/** Inspect a built-in server: its row and shipped tools, or exit 1 naming the damage or revocation. */
function inspectBuiltin(server: BuiltinHubServer, parsed: Parsed): number {
	const entry = server.entry;
	const ok = !server.damaged && !server.revoked;
	if (parsed.json)
		process.stdout.write(
			`${JSON.stringify(
				{
					...entry,
					publisher: hubEntryPublisher(entry),
					builtIn: true,
					title: server.title,
					...(server.damaged ? { damaged: server.damaged } : { tools: server.tools, environment: server.environment }),
					...(server.revoked ? { revoked: server.revoked } : {}),
				},
				null,
				2,
			)}\n`,
		);
	else printInspection(builtinInspectView(server));
	return ok ? 0 : 1;
}

interface HubCommandOptions {
	cwd: string;
	scope?: PluginScope;
	catalog?: string;
}

/** One reviewed plan and its outcome lines; the caller decides what follows them. */
function runLifecycleStep(
	operation: HubOperation,
	ref: string,
	scope: PluginScope | undefined,
	parsed: Parsed,
	options: HubCommandOptions,
): { plan: HubLifecyclePlan; apply: HubApplyResult; ok: boolean } {
	const plan = planHubLifecycle({
		operation,
		ref,
		cwd: options.cwd,
		...(scope ? { scope } : {}),
		...(options.catalog ? { catalog: options.catalog } : {}),
		force: parsed.force,
		withRequirements: parsed.withRequirements,
	});
	if (!parsed.json) printStepReviews(plan);
	const apply = applyHubLifecycle(plan, { dryRun: parsed.dryRun });
	const ok = apply.failed === 0 && (apply.dryRun || plan.applicable);
	if (!parsed.json) {
		for (const outcome of apply.outcomes) {
			const step = plan.steps.find(
				(item) => item.identity.ref === outcome.identity.ref && item.identity.scope === outcome.identity.scope,
			);
			const where = `${outcome.identity.ref} (${outcome.identity.scope})`;
			if (outcome.status === "committed")
				printOk(
					`${verb(operation)} ${where}${step?.source ? ` at ${step.destination} (sha256 ${step.source.sha256})` : ""}${
						outcome.recovery?.packageBackup ? `; recovery ${outcome.recovery.packageBackup}` : ""
					}${outcome.error ? `; verification: ${outcome.error.message}` : ""}`,
				);
			else if (outcome.status === "unattempted") {
				// A dry run of a refused step says it would be refused, in the same CLI words as the real run.
				const state = !parsed.dryRun ? "unattempted" : step?.refusal ? "would refuse" : "planned";
				process.stdout.write(
					`${state} ${operation} ${where}${step?.refusal ? `: ${cliRefusal(step.refusal, operation, parsed, step)}` : ""}\n`,
				);
			} else {
				// A refusal already names its fix; the generic next step is the TUI review's wording.
				const next = outcome.error?.code === "refused" ? "" : (outcome.error?.next ?? "");
				const message = cliRefusal(outcome.error?.message ?? "unknown", operation, parsed, step);
				printError(`${operation} ${where} failed: ${message}${next ? `; ${next}` : ""}`);
			}
		}
	}
	return { plan, apply, ok };
}

/** The planner's "plan with requirements" is surface-neutral; on the CLI that plan is one flag away. */
function cliRefusal(
	message: string,
	operation: HubOperation,
	parsed: Parsed,
	step: HubLifecyclePlan["steps"][number] | undefined,
): string {
	const missing = operation === "install" && !parsed.withRequirements ? (step?.dependencies.missing ?? []) : [];
	return message.replace(
		/; plan with requirements$/,
		missing.length ? `; rerun with --with-requirements to install ${missing.join(", ")} too` : "$&",
	);
}

function printRefreshNote(apply: HubApplyResult): void {
	if (!apply.committed) return;
	const refresh = apply.refresh;
	process.stderr.write(
		refresh.status === "not-applicable"
			? apply.outcomes.some((item) => item.status === "committed" && item.identity.kind === "extension")
				? "A running session loads this extension and its hooks after /reload.\n"
				: "A running session picks this up after /reload hub.\n"
			: refresh.status === "failed"
				? `session refresh failed: ${refresh.error}\n`
				: `session resources refreshed (generation ${refresh.generation})\n`,
	);
}

/**
 * Bring every copy its catalog row has moved past up to that row. One copy's
 * refusal does not stop the others, and the exit code still reports it. An
 * extension stays out: each of its updates shows what the code would newly be
 * allowed to reach, which is a review a bulk command would skip.
 */
function updateEveryCopy(parsed: Parsed, options: HubCommandOptions, emit: (value: unknown) => void): number {
	const copies = readHubInventory({
		cwd: options.cwd,
		...(options.catalog ? { catalog: options.catalog } : {}),
		include: { resources: false },
	}).copies.filter((copy) => copy.update && (!parsed.scope || copy.scope === parsed.scope));
	const outdated = copies.filter((copy) => copy.kind !== "extension");
	const extensions = copies.filter((copy) => copy.kind === "extension");
	const results: Array<{ ref: string; scope: PluginScope; ok: boolean; error?: string; apply?: HubApplyResult }> = [];
	let last: HubApplyResult | undefined;
	for (const copy of outdated) {
		try {
			const { apply, ok } = runLifecycleStep("update", copy.ref, copy.scope, parsed, options);
			if (apply.committed) last = apply;
			results.push({ ref: copy.ref, scope: copy.scope, ok, apply });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (!parsed.json) printError(`update ${copy.ref} (${copy.scope}) failed: ${message}`);
			results.push({ ref: copy.ref, scope: copy.scope, ok: false, error: message });
		}
	}
	const ok = results.every((result) => result.ok);
	if (parsed.json)
		emit({ ok, results, skipped: extensions.map((copy) => ({ ref: copy.ref, scope: copy.scope, reason: "extension" })) });
	else {
		if (last) printRefreshNote(last);
		for (const copy of extensions)
			process.stdout.write(
				`skipped ${copy.ref} (${copy.scope}): update it on its own with pancode hub update ${copy.ref} --${copy.scope}\n`,
			);
		if (copies.length === 0) process.stdout.write("every installed pack matches its catalog\n");
	}
	return ok ? 0 : 1;
}

export async function runHubCommand(
	args: ReadonlyArray<string>,
	discoveryOptions: { catalog?: string } = {},
): Promise<number> {
	// Help reads nothing, so it opens no process journal (C15).
	if (args.length > 0 && (args[0] === "--help" || args[0] === "-h")) {
		process.stdout.write(HELP);
		return 0;
	}
	if (args[0] === "inventory" && helpRequested(args.slice(1)))
		return (await import("./skills-inventory.js")).runSkillsInventory(args.slice(1));
	const builtin = builtinLifecycleAnswer(args, discoveryOptions);
	if (builtin !== undefined) return builtin;
	const journal = createProcessJournal(pancodeStateDir(), () =>
		writeDiagnostic("[pancode:telemetry] process journal unavailable; coverage is incomplete\n"),
	);
	let exitCode = 1;
	try {
		exitCode = await executeHubCommand(args, discoveryOptions);
	} finally {
		// A lifecycle command whose process scope did not seal has no durable account, so it cannot report success (#434).
		if (!(await journal.close(exitCode)) && exitCode === 0) exitCode = 1;
	}
	return exitCode;
}

/**
 * A lifecycle command on a server PanCode carries is answered from the bundled index alone, before the process
 * journal opens, so it leaves the PanCode home as it was. Anything else, including an unparsable line, goes on to
 * the ordinary path.
 */
function builtinLifecycleAnswer(
	args: ReadonlyArray<string>,
	discoveryOptions: { catalog?: string },
): number | undefined {
	let parsed: Parsed;
	let server: BuiltinHubServer | undefined;
	try {
		parsed = parse(args);
		if (
			parsed.help ||
			parsed.all ||
			parsed.positional.length !== 1 ||
			!LIFECYCLE.includes(parsed.command as HubOperation)
		)
			return undefined;
		const catalog = parsed.from ?? discoveryOptions.catalog;
		server = builtinHubServerFor(parsed.positional[0] as string, { cwd: process.cwd(), ...(catalog ? { catalog } : {}) });
	} catch {
		return undefined;
	}
	if (!server) return undefined;
	const operation = parsed.command as HubOperation;
	const answer = builtinServerAnswer(operation, server);
	if (parsed.json) {
		const ref = { ref: server.ref, builtIn: true, message: answer.message };
		if (!answer.ok) process.stdout.write(`${JSON.stringify({ ok: false, error: answer.message, ...ref }, null, 2)}\n`);
		else {
			// The plan of no steps, so --json reads like any other install or update and still writes nothing.
			const plan = planHubLifecycle({
				operation,
				ref: parsed.positional[0] as string,
				cwd: process.cwd(),
				...(parsed.scope ? { scope: parsed.scope } : {}),
				...(discoveryOptions.catalog || parsed.from ? { catalog: parsed.from ?? discoveryOptions.catalog } : {}),
				force: parsed.force,
				withRequirements: parsed.withRequirements,
			});
			const apply = applyHubLifecycle(plan, { dryRun: parsed.dryRun });
			process.stdout.write(`${JSON.stringify({ ...lifecycleJson(operation, plan, apply, true), ...ref }, null, 2)}\n`);
		}
	} else if (answer.ok) process.stdout.write(`${answer.message}\n`);
	else printError(answer.message);
	return answer.ok ? 0 : 1;
}

async function executeHubCommand(
	args: ReadonlyArray<string>,
	discoveryOptions: { catalog?: string } = {},
): Promise<number> {
	if (args[0] === "inventory") return (await import("./skills-inventory.js")).runSkillsInventory(args.slice(1));
	if (args[0] === "import") return (await import("./hub-import.js")).runHubImport(args.slice(1));
	let parsed: Parsed;
	try {
		parsed = parse(args);
	} catch (error) {
		printError(error instanceof Error ? error.message : String(error));
		return 2;
	}
	if (parsed.help) {
		process.stdout.write(HELP);
		return 0;
	}
	// A bare group is a usage error (C2): its help goes to stderr with the exit.
	if (!parsed.command) {
		process.stderr.write(HELP);
		return 2;
	}
	// An unknown subcommand is a usage error, never a package reference to resolve (CLI audit 1).
	if (!HUB_COMMANDS.includes(parsed.command)) {
		const message = `unknown subcommand: ${parsed.command}${didYouMean(parsed.command, HUB_COMMANDS)}`;
		writeCliFailure({ path: ["hub"], slug: "unknown_command", message, json: parsed.json });
		return 2;
	}
	if (["install", "update", "list"].includes(parsed.command)) {
		// A refusal leaves the kept index in place; the command continues from it.
		const note = await autoRefreshRemoteIndex().catch((err: unknown) =>
			err instanceof Error ? err.message : String(err),
		);
		if (note) writeDiagnostic(`[pancode:hub] ${note}\n`);
	}
	const options = {
		cwd: process.cwd(),
		...(parsed.scope ? { scope: parsed.scope } : {}),
		...discoveryOptions,
		...(parsed.from ? { catalog: parsed.from } : {}),
	};
	const emit = (value: unknown): void => {
		process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
	};
	try {
		if (parsed.dryRun && parsed.command !== "package" && !LIFECYCLE.includes(parsed.command as HubOperation))
			throw new Error("--dry-run is supported only for hub install, update, enable, disable, remove and package");
		if (parsed.command === "skills") {
			if (parsed.positional.length) throw new Error("hub skills takes no arguments");
			return (await import("./skills.js")).runSkillsRead([
				"list",
				...(parsed.all ? ["--all"] : []),
				...(parsed.json ? ["--json"] : []),
			]);
		}
		if (parsed.command === "components") {
			if (parsed.kind && !isHubComponentKind(parsed.kind))
				throw new Error("hub components --kind requires skill, agent, prompt, or playbook");
			const query = parsed.positional.join(" ");
			const inventory = readHubInventory({
				cwd: options.cwd,
				include: { packages: false },
				...(parsed.kind ? { kinds: [parsed.kind] } : {}),
				...(parsed.source ? { sources: [parsed.source] } : {}),
				...(query ? { query } : {}),
				all: parsed.all,
			});
			// A package the loaders refuse has no component rows, so it answers here
			// or the operator reads its absence as "not installed".
			const inactive =
				parsed.source && parsed.source !== "package"
					? []
					: inactiveHubCopies(inventory.copies).filter(
							(copy) =>
								(!parsed.kind || copy.kind === parsed.kind || copy.kind === "plugin") &&
								(!query || hubQueryMatches(query, copy.name)),
						);
			if (parsed.json) {
				const { packages: _packages, copies: _copies, ...rest } = inventory;
				emit({
					...rest,
					...(inactive.length > 0
						? {
								inactivePackages: inactive.map((copy) => ({
									ref: copy.ref,
									scope: copy.scope,
									state: copy.state,
									remedy: inactiveCopyRemedy(copy),
								})),
							}
						: {}),
				});
			} else {
				for (const resource of inventory.resources) {
					const owner = resource.owner ? `${resource.owner.ref}@${resource.owner.scope}` : resource.source.class;
					process.stdout.write(
						`${resource.kind}\t${resource.name}\t${owner}\t${originLabel(resource.origin)}\t${resource.availability}\t${resource.invocation ?? ""}\n`,
					);
				}
				for (const copy of inactive)
					process.stdout.write(
						`${copy.kind}\t${copy.name}\t${copy.ref}@${copy.scope}\t${originLabel(copy.origin)}\t${copy.state}\t${inactiveCopyRemedy(copy)}\n`,
					);
				if (query && inventory.resources.length === 0 && inactive.length === 0)
					process.stderr.write(
						`no installed component matches "${query}"; pancode hub search also covers packs you have not installed\n`,
					);
				if (inventory.truncated.resources)
					process.stderr.write("component list truncated; narrow with --kind or a query\n");
				for (const diagnostic of inventory.diagnostics) process.stderr.write(`${diagnostic}\n`);
			}
			return 0;
		}
		if (parsed.command === "list" || parsed.command === "search") {
			if (parsed.command === "list" && parsed.positional.length) throw new Error("hub list takes no arguments");
			if (parsed.source) throw new Error("--source applies to hub components");
			const discovery = hubWorkspace(options);
			const query = parsed.positional.join(" ");
			const inventory = readHubInventory({
				cwd: options.cwd,
				...(options.catalog ? { catalog: options.catalog } : {}),
				include: { resources: false },
				...(parsed.kind ? { kinds: [parsed.kind] } : {}),
				...(query ? { query } : {}),
			});
			const selected = new Map(inventory.packages.map((record) => [record.ref, record]));
			// A copy keeps the publisher it was installed from, which may differ from the row's.
			const copyPublisher = (entry: (typeof discovery.entries)[number], scope: PluginScope): string | undefined => {
				const lookup = { cwd: options.cwd ?? process.cwd(), scope };
				try {
					return (
						entry.kind === "extension"
							? readExtensionInstallRecord(entry.name, lookup)
							: readPluginInstallRecord(entry.name, lookup)
					)?.publisher;
				} catch {
					// Damaged state is the inventory's to report; the listing stays readable.
					return undefined;
				}
			};
			const entries = discovery.entries.flatMap((entry) => {
				const record = selected.get(hubEntryRef(entry));
				return record
					? [
							{
								...entry,
								provenance: record.origin,
								copies: record.copies
									.filter((copy) => !options.scope || copy.scope === options.scope)
									.map((copy) => {
										const publisher = copyPublisher(entry, copy.scope);
										return publisher ? { ...copy, publisher } : copy;
									}),
								...(record.format ? { format: record.format } : {}),
								...(record.provides ? { provides: record.provides } : {}),
								publisher: hubEntryPublisher(entry),
								...(isBuiltinServerRow(entry) ? { builtIn: true } : {}),
							},
						]
					: [];
			});
			if (query) {
				const score = (entry: (typeof entries)[number]): number =>
					discoveryScore(
						query,
						entry.name,
						[entry.description, ...(entry.provides ?? []).map((hint) => hint.name), ...(entry.triggers ?? [])].join(" "),
					);
				entries.sort((left, right) => score(right) - score(left));
			}
			if (parsed.json) emit({ entries, diagnostics: discovery.diagnostics });
			else {
				// PanCode's own authoring skills load only in its checkout, so elsewhere the listing offers them on
				// --all. The JSON document stays the whole catalog for the hosts that render their own.
				const offersSelfDevelopment = parsed.all || detectPancodeRepo(options.cwd ?? process.cwd()).isPancodeRepo;
				const selfDevelopment = new Set<string>(PANCODE_SELF_DEVELOPMENT_SKILLS);
				const rows: HubListRow[] = [];
				for (const entry of entries) {
					if (
						!offersSelfDevelopment &&
						entry.kind === "skill" &&
						selfDevelopment.has(entry.name) &&
						entry.copies.length === 0
					)
						continue;
					const states =
						entry.copies
							.map((item) => {
								// The version column is the catalog's, so name the installed one beside its update.
								const installed = item.update && item.version ? `${item.version} installed, ` : "";
								const notes = [
									...("publisher" in item && item.publisher !== entry.publisher ? [`installed from ${item.publisher}`] : []),
									...(item.update ? [`${installed}${updateLabel(item.update)}`] : []),
								];
								return `${item.scope}:${item.state}${notes.length ? ` (${notes.join("; ")})` : ""}`;
							})
							.join(", ") || ("builtIn" in entry ? "built in" : "available");
					rows.push({
						cells: [hubEntryRef(entry), entry.version ?? "-", states, originLabel(entry.provenance), trustLabel(entry)],
						description: entry.description,
					});
				}
				process.stdout.write(formatHubList(rows, terminalColumns()));
				if (query && entries.length === 0)
					process.stderr.write(`no pack matches "${query}"${parsed.kind ? ` (kind ${parsed.kind})` : ""}\n`);
				for (const diagnostic of discovery.diagnostics) process.stderr.write(`${diagnostic}\n`);
			}
			return 0;
		}
		if (parsed.command === "refresh") {
			if (parsed.positional.length) throw new Error("hub refresh takes no arguments");
			const result = await refreshRemoteIndex();
			if (parsed.json) emit(result.ok ? { ok: true, changed: result.changed, state: result.state } : result);
			else if (result.ok)
				printOk(
					`PanHub index sequence ${result.state.indexSequence} ${result.changed ? "verified and kept" : "verified, unchanged"}; expires ${result.state.expires}`,
				);
			else printError(describeRefusal(result));
			return result.ok ? 0 : 1;
		}
		if (parsed.command === "status") {
			if (parsed.positional.length) throw new Error("hub status takes no arguments");
			const state = readHubTrustState();
			const refusal = readHubTrustRefusal();
			const status = {
				url: configuredHubIndexUrl(),
				rootKey: HUB_ROOT_PUBLIC_KEYS.length > 0,
				indexSequence: state?.indexSequence ?? null,
				certificateSequence: state?.certificateSequence ?? null,
				keyId: state?.keyId ?? null,
				commit: state?.commit ?? null,
				expires: state?.expires ?? null,
				expired: state ? !(Date.now() < Date.parse(state.expires)) : null,
				verifiedAt: state?.verifiedAt ?? null,
				revocations: revokedHubDigests().size,
				lastRefusal: refusal ?? null,
			};
			if (parsed.json) emit(status);
			else {
				const rows: Array<[string, string]> = [
					["index", status.url || "off"],
					["root key", status.rootKey ? "present" : "none in this build"],
					["index sequence", status.indexSequence === null ? "none verified" : String(status.indexSequence)],
					["certificate sequence", status.certificateSequence === null ? "none" : String(status.certificateSequence)],
					["signing key", status.keyId ?? "none"],
					["commit", status.commit ?? "none"],
					["expires", status.expires ? `${status.expires}${status.expired ? " (expired)" : ""}` : "none"],
					["verified at", status.verifiedAt ?? "never"],
					["revocations", String(status.revocations)],
					["last refusal", refusal ? `${refusal.at} ${refusal.reason}: ${refusal.message}` : "none"],
				];
				for (const [label, value] of rows) process.stdout.write(`${label}: ${value}\n`);
			}
			return 0;
		}
		if (parsed.command === "reload") {
			if (parsed.positional.length) throw new Error("hub reload takes no arguments");
			const snapshot = reloadPluginResources(options.cwd);
			// A CLI process refreshes only itself and then exits; the exit stays 0 (NIGHT-DECISIONS 2), the notice says so.
			process.stderr.write(
				"pancode hub reload: refreshes only this exiting process; use /reload hub in a running session\n",
			);
			if (parsed.json) emit(snapshot);
			else printOk("PanHub refreshed for this process; use /reload hub in an active session");
			return 0;
		}
		if (parsed.command === "sync" || parsed.command === "push") {
			if (parsed.positional.length) throw new Error(`hub ${parsed.command} takes no arguments`);
			await syncHub(parsed.command);
			if (parsed.json) process.stdout.write(`${JSON.stringify(jsonDocument({ ok: true, direction: parsed.command }))}\n`);
			else printOk(`hub ${parsed.command} complete`);
			return 0;
		}
		if (parsed.command === "remote") {
			if (parsed.positional.length !== 2 || parsed.positional[0] !== "confirm")
				throw new Error("hub remote confirm requires a URL");
			const url = confirmHubRemote(parsed.positional[1] as string);
			if (parsed.json) emit({ ok: true, remote: url });
			else printOk(`confirmed PanHub remote ${url}`);
			return 0;
		}
		const ref = parsed.positional[0];
		if (parsed.command === "update" && parsed.all) {
			if (ref) throw new Error("hub update takes a pack reference or --all, not both");
			return updateEveryCopy(parsed, options, emit);
		}
		if (parsed.command === "drift" && !ref) {
			const results = listInstalledPlugins(options.cwd, { ...options, all: true }).map((item) => ({
				id: item.id,
				kind: item.kind ?? "plugin",
				scope: item.scope,
				...hubEntryDrift({ kind: item.kind ?? "plugin", name: item.id }, { ...options, scope: item.scope }),
			}));
			if (parsed.json) emit({ results });
			else if (results.length === 0) process.stdout.write("no installed packs\n");
			else for (const item of results) printDrift(`${item.kind}:${item.id} (${item.scope})`, item);
			return results.some((item) => item.status !== "clean") ? 1 : 0;
		}
		if (!ref || parsed.positional.length !== 1)
			throw new Error(`hub ${parsed.command} requires one path or pack reference`);
		if (parsed.command === "register") {
			const entry = registerHubPackage(ref, { ...options, force: parsed.force });
			if (parsed.json) emit({ ok: true, entry });
			else
				printOk(
					`registered ${hubEntryRef(entry)}${entry.version ? ` ${entry.version}` : ""} from ${entry.sourceUrl}; install it with \`pancode hub install ${hubEntryRef(entry)}\``,
				);
			return 0;
		}
		if (parsed.command === "package") {
			const packaged = packageBareSkill(pluginLocalPath(ref, options.cwd), { force: parsed.force, dryRun: parsed.dryRun });
			if (parsed.json) emit({ ok: true, ...packaged });
			else {
				if (parsed.dryRun) process.stdout.write(packaged.manifest);
				else printOk(`wrote ${packaged.manifestPath}`);
				for (const note of packaged.identity.notes) process.stderr.write(`${note}\n`);
				if (!parsed.dryRun)
					process.stderr.write(
						`Check it with pancode hub validate ${path.dirname(packaged.manifestPath)}, then install it with pancode hub install ${path.dirname(packaged.manifestPath)}.\n`,
					);
			}
			return 0;
		}
		if (parsed.command === "validate") {
			const local = pluginLocalPath(ref, options.cwd);
			if (local.endsWith("SKILL.md"))
				return (await import("./skills.js")).runSkillsRead(["validate", local, ...(parsed.json ? ["--json"] : [])]);
			if (isBareSkillDirectory(local)) {
				const code = (await import("./skills.js")).runSkillsRead([
					"validate",
					path.join(local, "SKILL.md"),
					...(parsed.json ? ["--json"] : []),
				]);
				if (!parsed.json) process.stderr.write(`${bareSkillRemedy(local)}\n`);
				return code;
			}
			const packageRoot = existsSync(local) && statSync(local).isFile() ? path.dirname(local) : local;
			const result = validateHubPackage(packageRoot, {
				cwd: options.cwd,
				authoring: { knownSkills: knownSkillNames(options.cwd) },
			});
			if (parsed.json) emit(result);
			else {
				const name = result.manifest?.name ?? path.basename(packageRoot);
				for (const resource of result.validation.resources)
					for (const diag of resource.diagnostics)
						if (diag.severity === "warning")
							process.stderr.write(`  warning: ${resource.name}: ${diag.message}${diag.path ? ` (${diag.path})` : ""}\n`);
				if (result.valid) {
					const count = result.validation.resources.length;
					printOk(`pack ${name} is valid (${count} resource${count === 1 ? "" : "s"} checked)`);
				} else {
					if (!result.manifestValid) {
						printError(`pack ${name} manifest is invalid`);
						for (const diag of result.diagnostics) {
							process.stderr.write(`  [manifest] ${diag.message}${diag.path ? ` (${diag.path})` : ""}\n`);
						}
					} else if (!result.validation.contentValid) {
						printError(`pack ${name} authored content is invalid`);
						for (const diag of result.validation.diagnostics) {
							process.stderr.write(`  [${diag.code}] ${diag.message}${diag.path ? ` (${diag.path})` : ""}\n`);
						}
					}
				}
			}
			return result.valid ? 0 : 1;
		}
		if (parsed.command === "inspect") {
			// A built-in server by ref or by its bundled directory: the same validated facts either way.
			const builtin = builtinHubServerFor(ref, options);
			if (builtin) return inspectBuiltin(builtin, parsed);
			const local = pluginLocalPath(ref);
			if (existsSync(local)) {
				const candidate = readPluginManifest(local);
				if (parsed.json) emit(candidate);
				else printInspection(localInspectView(candidate));
				return candidate.valid ? 0 : 1;
			}
			// Precedence is a cross-scope fact: list both scopes first, then narrow
			// to the requested scope, so a user copy shadowed by a project copy never
			// reads as effective.
			const installed = installedCopiesNamed(
				listInstalledPlugins(options.cwd, { all: true }).filter((item) => !parsed.scope || item.scope === parsed.scope),
				ref,
			)[0];
			if (installed) {
				const inspection = inspectHubCopy(ref, { ...options, scope: installed.scope });
				// Existing fields stay as they are; `hub` is the additive deeper read.
				if (parsed.json) emit({ ...installed, hub: inspection });
				else printInspection(installedInspectView(installed, inspection));
				return installed.valid ? 0 : 1;
			}
			const entry = resolveHubPackage(ref, options);
			const record = readHubInventory({
				cwd: options.cwd,
				...(options.catalog ? { catalog: options.catalog } : {}),
				include: { resources: false, copies: false },
				ref: hubEntryRef(entry),
			}).packages[0];
			const plan = planHubInstall(entry, options);
			try {
				const candidate = readPluginManifest(plan.sourceRoot as string);
				if (!parsed.json) {
					printInspection(catalogInspectView(entry, candidate, record));
					return candidate.valid ? 0 : 1;
				}
				emit({
					...candidate,
					...(record
						? {
								hub: {
									origin: record.origin,
									...(record.format ? { format: record.format } : {}),
									...(record.provides ? { provides: record.provides } : {}),
								},
							}
						: {}),
				});
				return candidate.valid ? 0 : 1;
			} finally {
				releaseHubPlan(plan);
			}
		}
		if (LIFECYCLE.includes(parsed.command as HubOperation)) {
			const operation = parsed.command as HubOperation;
			const { plan, apply, ok } = runLifecycleStep(operation, ref, parsed.scope, parsed, options);
			const binaries = apply.dryRun
				? []
				: await syncHubPackBinaries(apply, options.cwd, (message) => {
						if (!parsed.json) process.stderr.write(`${message}\n`);
					});
			for (const failure of binaries) printError(`a pinned program did not download: ${failure}`);
			if (parsed.json) emit(lifecycleJson(operation, plan, apply, ok));
			else printRefreshNote(apply);
			return ok && binaries.length === 0 ? 0 : 1;
		}
		const entry = resolveInstalledHubEntry(ref, options);
		const scoped = { ...options, scope: entry.scope };
		if (parsed.command === "pin") {
			const pin = pinHubEntry(entry, scoped);
			if (parsed.json) emit({ id: entry.name, ...pin });
			else printOk(`pinned ${hubEntryRef(entry)} (${entry.scope}) at sha256 ${pin.sha256}`);
			return 0;
		}
		if (parsed.command === "drift") {
			const result = hubEntryDrift(entry, scoped);
			if (parsed.json) emit(result);
			else printDrift(`${hubEntryRef(entry)} (${entry.scope})`, result);
			return result.status === "clean" ? 0 : 1;
		}
		throw new Error(`unknown hub command: ${parsed.command}`);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (parsed.json) emit({ ok: false, error: message });
		else printError(message);
		return 1;
	}
}

interface HubListRow {
	cells: ReadonlyArray<string>;
	description: string;
}

/**
 * `hub list` and `hub search` as a table: one row of facts per pack, and the first sentence of its description on an
 * indented line under it, cut to the terminal so a long description never wraps across the table. Publisher and
 * origin (a local path or git url) make the full row wider than most terminals, so when it does not fit they move
 * to their own indented line under the row instead.
 */
function formatHubList(rows: ReadonlyArray<HubListRow>, width: number): string {
	if (rows.length === 0) return "";
	const table = (cells: ReadonlyArray<ReadonlyArray<string>>) => formatColumns(cells).trimEnd().split("\n");
	let lines = table([["pack", "version", "state", "origin", "publisher"], ...rows.map((row) => row.cells)]);
	const wide = lines.every((line) => line.length <= width);
	if (!wide) lines = table([["pack", "version", "state"], ...rows.map((row) => row.cells.slice(0, 3))]);
	const out = [lines[0] ?? ""];
	for (const [index, row] of rows.entries()) {
		out.push((lines[index + 1] ?? "").trimEnd());
		if (!wide) out.push(`  ${truncate(`${row.cells[4] ?? "-"}, from ${row.cells[3] ?? "-"}`, Math.max(20, width - 2))}`);
		const summary = firstSentence(row.description);
		if (summary) out.push(`  ${truncate(summary, Math.max(20, width - 2))}`);
	}
	return `${out.join("\n")}\n`;
}

function firstSentence(text: string): string {
	const flat = text.replace(/\s+/gu, " ").trim();
	const end = flat.search(/[.!?](?= [A-Z(])/u);
	return end === -1 ? flat : flat.slice(0, end + 1);
}
