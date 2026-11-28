// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * The hub lifecycle: one reviewed plan per operation, applied per package above
 * the atomic package writers. Planning stages sources and writes nothing; apply
 * rechecks reviewed facts inside each writer's lock, keeps every committed write
 * when a later step fails, releases every staged source, and reports disk/state
 * verification, actual component admission and host refresh as separate facts.
 */
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import {
	approveOperatorProjectInstall,
	captureProjectInstallBaseline,
	type ProjectInstallBaseline,
} from "../../core/workspace-trust.js";
import {
	disableExtension,
	type ExtensionCapabilityEnvelope,
	enableExtension,
	removeExtension,
	reviewExtensionEnvelope,
	syncPackBinaries,
} from "../extensions/index.js";
import type { HubImportApplyResult, HubImportPlan } from "../interop/import.js";
import {
	disablePlugin,
	enablePlugin,
	type InstalledPlugin,
	listInstalledPlugins as listPluginCopies,
	newlyBrokenDependents,
	type PluginDependentBreak,
	type PluginDiagnostic,
	type PluginExpectedCopy,
	type PluginMutationResult,
	type PluginScope,
	PluginWriterRefusal,
	pluginContentDigest,
	readPluginInstallRecord,
	removePlugin,
} from "../plugins/index.js";
import {
	classifyHubRequirements,
	commitHubInstallPlan,
	discoverHub,
	type HubInstallPlan,
	hubEntryPublisher,
	hubEntryRef,
	planHubInstall,
	planHubUpdate,
	releaseHubPlan,
	resolveHubPack,
	resolveInstalledHubEntry,
} from "./hub.js";
import { type HubCopyState, hubCopyState, readHubInventory } from "./hub-inventory.js";
import {
	hubNamespace,
	hubPackBaseDir,
	listInstalledHubPacks as listInstalledPlugins,
	observeHubCopy,
	readHubInstallRecord,
	withHubScopeLock,
} from "./hub-packs.js";
import { type HubPair, readHubPairs } from "./hub-pairing.js";
import {
	type HubComponentKind,
	type HubEntryKind,
	type HubPackEntry,
	type HubRequirementRef,
	type HubTier,
	isHubComponentKind,
	isHubKind,
} from "./hub-types.js";
import { validateHubPack } from "./hub-validation.js";

export const HUB_OPERATIONS = ["install", "update", "enable", "disable", "remove"] as const;
export type HubOperation = (typeof HUB_OPERATIONS)[number];

export interface HubPackIdentity {
	ref: HubRequirementRef;
	kind: HubEntryKind;
	name: string;
	scope: PluginScope;
}

export interface HubActionRequest {
	operation: HubOperation;
	/** "kind:name", a bare name when unambiguous, or (install) a local path / GitHub tree. */
	ref: string;
	scope?: PluginScope;
	/** Existing replace-with-recovery semantics only; never a dependency bypass. */
	force?: boolean;
	withRequirements?: boolean;
	catalog?: string;
	/** Refuse local-path shadowing and installed-only fallbacks; resolve from the hub indexes only. */
	catalogOnly?: boolean;
	cwd?: string;
}

export type HubExpectedCopy = PluginExpectedCopy;

export interface HubPlanStep {
	operation: HubOperation;
	identity: HubPackIdentity;
	destination: string;
	/** The installed version and the one this step writes, where either is known. */
	versions?: { from?: string; to?: string };
	source?: {
		sourceUrl: string;
		sha256: string;
		staged: boolean;
		/** Who answers for the package, and the tier and licence its index row states. */
		publisher?: string;
		tier?: HubTier;
		license?: string;
		/** The exact commit a remote source was fetched at. */
		commit?: string;
	};
	content?: {
		valid: boolean;
		resources: Array<{ kind: HubComponentKind; name: string; valid: boolean }>;
		diagnostics: string[];
	};
	expected: HubExpectedCopy[];
	dependencies: {
		requires: HubRequirementRef[];
		missing: HubRequirementRef[];
		inactive: HubRequirementRef[];
	};
	dependents: { newlyBroken: PluginDependentBreak[]; preexisting: PluginDependentBreak[] };
	effectiveAfter?: { scope: PluginScope; loadable: boolean; state: HubCopyState };
	fallbackNote: string;
	recovery: string;
	refusal?: string;
}

/**
 * What a reviewed step adds beyond the copy it changes. Held beside the steps
 * rather than inside them so existing consumers of a step keep their shape.
 */
export interface HubStepReview {
	ref: HubRequirementRef;
	scope: PluginScope;
	/** Extension install or update only: what the staged copy may do, read from its manifest alone. */
	envelope?: ExtensionCapabilityEnvelope;
	envelopeDigest?: string;
	/** Update only: what reaches further than the installed copy; empty means no more than it. */
	growth?: string[];
	/** The other half of a plugin and extension pair, so the review can say what installing one leaves out. */
	pairs: HubPair[];
}

export interface HubActionPlan {
	version: 1;
	id: string;
	createdAt: string;
	cwd: string;
	request: HubActionRequest;
	steps: HubPlanStep[];
	/** One entry per step that has an envelope or a pair to report; absent on a plan built before this field. */
	reviews?: HubStepReview[];
	applicable: boolean;
	diagnostics: string[];
}

export type HubStepStatus = "committed" | "failed" | "unattempted";

export interface HubStepVerification {
	/** Whether the admission read ran before or after the host refreshed its snapshot. */
	evidence: "pre-refresh" | "post-refresh";
	tree: "present" | "absent" | "changed";
	record: "recorded" | "absent" | "unreadable";
	copy?: HubCopyState;
	resources: Array<{ kind: HubComponentKind; name: string; available: boolean; reason?: string }>;
	effective: { scope: PluginScope; loadable: boolean } | null;
}

export interface HubStepOutcome {
	status: HubStepStatus;
	operation: HubOperation;
	identity: HubPackIdentity;
	/** The folder the committed step wrote or removed, so the outcome can say where. */
	destination?: string;
	/** The step came from an import of another agent's files, not from a catalog install. */
	imported?: true;
	verification?: HubStepVerification;
	recovery?: { packageBackup?: string; stateBackup?: string };
	diagnostics: string[];
	error?: {
		code: "stale_plan" | "locked" | "refused" | "writer" | "verification";
		message: string;
		changed?: PluginWriterRefusal["changed"];
		next: string;
	};
}

/**
 * What happened to the running extensions after a change that reached them.
 * Extension runtimes and their hooks restart through a reload that waits for an
 * idle session, so a refresh can only say that it began or that it is queued.
 */
export type HubExtensionRefresh = "reloading" | "queued" | "unavailable";

export type HubRefreshResult =
	| { status: "refreshed"; generation: number; changed: boolean; extensions?: HubExtensionRefresh }
	| { status: "failed"; error: string }
	| { status: "not-applicable"; reason: string };

/** What the committed steps touched, so a host reloads only what the change reaches. */
export interface HubRefreshTouch {
	extensions: boolean;
}

/** Provided by the active host. Must never re-run a lifecycle write. */
export type HubRefreshHost = (cwd: string, touched?: HubRefreshTouch) => HubRefreshResult;

/** Whether a committed step changed an installed extension. */
export function hubRefreshTouch(outcomes: ReadonlyArray<HubStepOutcome>): HubRefreshTouch {
	return {
		extensions: outcomes.some((item) => item.status === "committed" && item.identity.kind === "extension"),
	};
}

export interface HubApplyResult {
	planId: string;
	dryRun: boolean;
	outcomes: HubStepOutcome[];
	committed: number;
	failed: number;
	unattempted: number;
	refresh: HubRefreshResult;
}

// ---------------------------------------------------------------------------
// Staging registry: plans stay JSON-safe; staged sources are tracked by plan id.
// ---------------------------------------------------------------------------

const staged = new Map<string, Map<string, HubInstallPlan>>();

function stepKey(identity: HubPackIdentity): string {
	return `${identity.scope}:${identity.ref}`;
}

function retain(planId: string, identity: HubPackIdentity, plan: HubInstallPlan): void {
	const byStep = staged.get(planId) ?? new Map<string, HubInstallPlan>();
	byStep.set(stepKey(identity), plan);
	staged.set(planId, byStep);
}

/** Cancel: release every staged source and write nothing. Idempotent. */
export function releaseHubAction(plan: Pick<HubActionPlan, "id">): void {
	const byStep = staged.get(plan.id);
	staged.delete(plan.id);
	for (const item of byStep?.values() ?? []) releaseHubPlan(item);
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

function peerOf(scope: PluginScope): PluginScope {
	return scope === "user" ? "project" : "user";
}

function identityOf(kind: HubEntryKind, name: string, scope: PluginScope): HubPackIdentity {
	return { ref: `${kind}:${name}`, kind, name, scope };
}

function copyOf(entries: ReadonlyArray<InstalledPlugin>, identity: HubPackIdentity): InstalledPlugin | undefined {
	return entries.find(
		(item) => item.id === identity.name && (item.kind ?? "plugin") === identity.kind && item.scope === identity.scope,
	);
}

/**
 * Whether a copy competes for the identity's name. A plugin and the extension
 * that serves it share a name and never compete, so
 * the peer, winner and survivor of a step are always read within one namespace.
 */
function competes(item: Pick<InstalledPlugin, "id" | "kind">, identity: HubPackIdentity): boolean {
	return item.id === identity.name && hubNamespace(item.kind) === hubNamespace(identity.kind);
}

function observe(
	cwd: string,
	scope: PluginScope,
	id: string,
	diagnostics: string[],
	kind: HubEntryKind,
): HubExpectedCopy | undefined {
	try {
		return observeHubCopy(scope, id, cwd, kind);
	} catch (error) {
		diagnostics.push(`state for ${scope}:${id} unreadable: ${error instanceof Error ? error.message : String(error)}`);
		return undefined;
	}
}

/**
 * Facts to recheck for one step: the mutated copy, its peer-scope copy when the
 * peer plugin directory exists, and every dependent consulted. Copies written by
 * earlier steps of the same batch are excluded so a plan cannot stale itself.
 */
function expectedFor(
	cwd: string,
	identity: HubPackIdentity,
	consulted: ReadonlyArray<{ scope: PluginScope; id: string }>,
	earlier: ReadonlyArray<HubPackIdentity>,
	diagnostics: string[],
): HubExpectedCopy[] {
	const wanted = new Map<string, { scope: PluginScope; id: string }>();
	wanted.set(`${identity.scope}:${identity.name}`, { scope: identity.scope, id: identity.name });
	if (existsSync(hubPackBaseDir(identity.kind, peerOf(identity.scope), cwd)))
		wanted.set(`${peerOf(identity.scope)}:${identity.name}`, { scope: peerOf(identity.scope), id: identity.name });
	for (const item of consulted) wanted.set(`${item.scope}:${item.id}`, item);
	for (const item of earlier) wanted.delete(`${item.scope}:${item.name}`);
	const out: HubExpectedCopy[] = [];
	for (const item of wanted.values()) {
		const fact = observe(cwd, item.scope, item.id, diagnostics, identity.kind);
		if (fact) out.push(fact);
	}
	return out;
}

function stateAfterInstall(entries: ReadonlyArray<InstalledPlugin>, identity: HubPackIdentity) {
	const existing = copyOf(entries, identity);
	const peer = entries.find(
		(item) => competes(item, identity) && item.scope === peerOf(identity.scope) && item.valid && item.compatible,
	);
	if (identity.scope === "user" && peer) {
		return {
			effectiveAfter: { scope: "project" as const, loadable: peer.loadable, state: hubCopyState(peer) },
			fallbackNote: `the project copy stays effective; the new user copy is shadowed until the project copy is removed`,
		};
	}
	if (existing && !existing.enabled) {
		return {
			effectiveAfter: { scope: identity.scope, loadable: false, state: "disabled" as const },
			fallbackNote:
				peer && identity.scope === "project"
					? "this copy stays disabled and continues to shadow the existing user copy"
					: "this copy stays disabled",
		};
	}
	return {
		effectiveAfter: { scope: identity.scope, loadable: true, state: "loadable" as const },
		fallbackNote:
			peer && identity.scope === "project"
				? "the new project copy shadows the existing user copy"
				: "this copy becomes the effective copy",
	};
}

function contentOf(root: string): NonNullable<HubPlanStep["content"]> {
	const result = validateHubPack(root);
	return {
		valid: result.valid,
		resources: result.validation.resources
			.filter((item): item is typeof item & { kind: HubComponentKind } => isHubComponentKind(item.kind))
			.map((item) => ({ kind: item.kind, name: item.name, valid: item.valid })),
		diagnostics: [...result.diagnostics.map((d) => d.message), ...result.validation.diagnostics.map((d) => d.message)],
	};
}

function installStep(
	planId: string,
	cwd: string,
	scope: PluginScope,
	staged: HubInstallPlan,
	operation: "install" | "update",
	entries: ReadonlyArray<InstalledPlugin>,
	earlier: ReadonlyArray<HubPackIdentity>,
	dependencies: HubPlanStep["dependencies"],
	diagnostics: string[],
): HubPlanStep {
	const identity = identityOf(staged.entry.kind, staged.entry.name, scope);
	retain(planId, identity, staged);
	const existing = copyOf(entries, identity);
	const expected = expectedFor(cwd, identity, [], earlier, diagnostics);
	staged.expect = { copies: expected };
	const refusal =
		existing && operation === "install" && !staged.force
			? `${identity.ref} is already installed in ${scope} scope; update it instead, or reinstall it with \`pancode hub install ${identity.ref} --force\``
			: undefined;
	return {
		operation,
		identity,
		destination: staged.path,
		...(existing?.version || staged.entry.version
			? {
					versions: {
						...(existing?.version ? { from: existing.version } : {}),
						...(staged.entry.version ? { to: staged.entry.version } : {}),
					},
				}
			: {}),
		source: {
			sourceUrl: staged.entry.sourceUrl,
			sha256: staged.sha256,
			staged: staged.sourceRoot !== undefined,
			...hubTrustFacts(staged.entry),
			...(staged.commit ? { commit: staged.commit } : {}),
		},
		content: contentOf(staged.sourceRoot as string),
		expected,
		dependencies,
		dependents: { newlyBroken: [], preexisting: [] },
		...stateAfterInstall(entries, identity),
		recovery: existing
			? "files in the current tree that differ from its record are kept beside it as a backup copy"
			: "nothing to recover; the destination is empty",
		...(refusal ? { refusal } : {}),
	};
}

function hubTrustFacts(entry: HubPackEntry): { publisher: string; tier?: HubTier; license?: string } {
	return {
		publisher: hubEntryPublisher(entry),
		...(entry.tier ? { tier: entry.tier } : {}),
		...(entry.license ? { license: entry.license } : {}),
	};
}

function requirementRefs(status: ReturnType<typeof classifyHubRequirements>): HubPlanStep["dependencies"] {
	return {
		requires: status.ordered.map(hubEntryRef),
		missing: status.unsatisfied.map(hubEntryRef),
		inactive: (status.inactive ?? []).map(hubEntryRef),
	};
}

export function planHubAction(request: HubActionRequest): HubActionPlan {
	const cwd = path.resolve(request.cwd ?? process.cwd());
	const id = randomBytes(8).toString("hex");
	const diagnostics: string[] = [];
	const steps: HubPlanStep[] = [];
	const discoveryOptions = { cwd, ...(request.catalog ? { catalog: request.catalog } : {}) };
	const entries = listInstalledPlugins(cwd, { all: true });
	try {
		if (request.operation === "install") {
			const scope = request.scope ?? "user";
			const entry = resolveHubPack(request.ref, {
				...discoveryOptions,
				...(request.catalogOnly ? { catalogOnly: true } : {}),
			});
			let status: ReturnType<typeof classifyHubRequirements> = { ordered: [], satisfied: [], unsatisfied: [] };
			let refusal: string | undefined;
			try {
				status = classifyHubRequirements(entry, discoverHub(discoveryOptions).entries, { cwd });
			} catch (error) {
				// A requirement absent from every index, or a cycle: refuse, do not throw.
				refusal = error instanceof Error ? error.message : String(error);
			}
			const dependencies = requirementRefs(status);
			if (!refusal && status.inactive?.length)
				refusal = `hub_requirement_inactive: ${dependencies.inactive.join(", ")}; enable or repair those packs first`;
			else if (!refusal && status.unsatisfied.length && !request.withRequirements)
				refusal = `hub_requirement_missing: ${dependencies.missing.join(", ")}; plan with requirements`;
			const identity = identityOf(entry.kind, entry.name, scope);
			if (refusal) {
				// Refused before staging: nothing is fetched for a plan that cannot apply.
				steps.push({
					operation: "install",
					identity,
					destination: path.join(hubPackBaseDir(entry.kind, scope, cwd), entry.name),
					source: { sourceUrl: entry.sourceUrl, sha256: entry.sha256 ?? "", staged: false, ...hubTrustFacts(entry) },
					expected: [],
					dependencies,
					dependents: { newlyBroken: [], preexisting: [] },
					fallbackNote: "no change",
					recovery: "nothing changes",
					refusal,
				});
			} else {
				const earlier: HubPackIdentity[] = [];
				for (const dependency of status.unsatisfied) {
					const step = installStep(
						id,
						cwd,
						scope,
						planHubInstall(dependency, { cwd, scope }),
						"install",
						entries,
						earlier,
						requirementRefs(classifyHubRequirements(dependency, discoverHub(discoveryOptions).entries, { cwd })),
						diagnostics,
					);
					steps.push(step);
					earlier.push(step.identity);
				}
				steps.push(
					installStep(
						id,
						cwd,
						scope,
						planHubInstall(entry, { cwd, scope, force: request.force ?? false }),
						"install",
						entries,
						earlier,
						dependencies,
						diagnostics,
					),
				);
			}
		} else if (request.operation === "update") {
			const identity = resolveInstalledHubEntry(request.ref, {
				cwd,
				...(request.scope ? { scope: request.scope } : {}),
			});
			let stagedPlan: HubInstallPlan | undefined;
			let refusal: string | undefined;
			try {
				stagedPlan = planHubUpdate(request.ref, {
					cwd,
					scope: identity.scope,
					force: request.force ?? false,
					...(request.catalog ? { catalog: request.catalog } : {}),
				});
			} catch (error) {
				refusal = error instanceof Error ? error.message : String(error);
			}
			const requires = identity.requires ?? [];
			const dependencies = {
				requires,
				missing: requires.filter(
					(ref) => !entries.some((item) => item.loadable && `${item.kind ?? "plugin"}:${item.id}` === ref),
				),
				inactive: [],
			};
			if (stagedPlan)
				steps.push(installStep(id, cwd, identity.scope, stagedPlan, "update", entries, [], dependencies, diagnostics));
			else {
				const target = identityOf(identity.kind, identity.name, identity.scope);
				steps.push({
					operation: "update",
					identity: target,
					destination: path.join(hubPackBaseDir(identity.kind, identity.scope, cwd), identity.name),
					expected: [],
					dependencies,
					dependents: { newlyBroken: [], preexisting: [] },
					fallbackNote: "no change",
					recovery: "nothing changes",
					refusal: refusal ?? "update source unavailable",
				});
			}
		} else {
			const resolved = resolveInstalledHubEntry(request.ref, {
				cwd,
				...(request.scope ? { scope: request.scope } : {}),
			});
			const identity = identityOf(resolved.kind, resolved.name, resolved.scope);
			const copy = copyOf(entries, identity);
			if (!copy) throw new Error(`pack not installed: ${identity.ref} (${identity.scope})`);
			let refusal: string | undefined;
			let dependents: HubPlanStep["dependents"] = { newlyBroken: [], preexisting: [] };
			let effectiveAfter: HubPlanStep["effectiveAfter"];
			let fallbackNote: string;
			const requires = copy.manifest?.pancode.requires ?? [];
			const missing = requires.filter(
				(ref) => !entries.some((item) => item.loadable && `${item.kind ?? "plugin"}:${item.id}` === ref),
			);
			if (request.operation === "enable") {
				if (!copy.valid || !copy.compatible) {
					refusal = `${identity.ref} cannot be enabled: ${copy.diagnostics.map((d) => d.message).join("; ")}`;
					if (hubCopyState(copy) === "damaged")
						refusal += `. Inspect local changes first; to replace from the recorded source and preserve changed files in a recovery backup, run pancode hub update ${identity.ref} --${copy.scope} --force`;
				} else if (missing.length)
					refusal = `hub_requirement_missing: ${missing.join(", ")}; install or enable those first`;
				const winner = entries.find((item) => item.id === identity.name && item.effective);
				effectiveAfter = winner
					? {
							scope: winner.scope,
							loadable: winner === copy ? copy.valid && copy.compatible : winner.loadable,
							state: winner === copy ? "loadable" : hubCopyState(winner),
						}
					: undefined;
				fallbackNote =
					winner && winner !== copy
						? `the ${winner.scope} copy stays effective; this ${identity.scope} copy remains shadowed`
						: "this copy becomes loadable";
			} else {
				const projection = newlyBrokenDependents(entries, {
					scope: identity.scope,
					id: identity.name,
					operation: request.operation,
					kind: identity.kind,
				});
				dependents = { newlyBroken: projection.newlyBroken, preexisting: projection.preexisting };
				if (projection.newlyBroken.length)
					refusal = `${request.operation} would break ${projection.newlyBroken
						.map((item) => `${item.scope}:${item.ref} (missing ${item.missing.join(", ")})`)
						.join("; ")}; disable or remove those dependents first`;
				const survivor = projection.effectiveAfter;
				effectiveAfter = survivor
					? { scope: survivor.scope, loadable: survivor.loadable, state: hubCopyState(survivor) }
					: undefined;
				if (request.operation === "disable")
					fallbackNote =
						survivor && survivor.scope === identity.scope
							? survivor.overriddenBy || entries.some((item) => competes(item, identity) && item.scope !== identity.scope)
								? `the disabled ${identity.scope} copy still shadows the ${peerOf(identity.scope)} copy; removal would reveal it`
								: "no other copy exists; nothing falls back"
							: "another copy is already effective";
				else
					fallbackNote = survivor
						? `the ${survivor.scope} copy becomes effective (${survivor.loadable ? "loadable" : hubCopyState(survivor)})`
						: "no other copy exists; the pack will be absent";
			}
			const consulted = entries
				.filter((item) => item.loadable && (item.manifest?.pancode.requires?.length ?? 0) > 0)
				.map((item) => ({ scope: item.scope, id: item.id }));
			steps.push({
				operation: request.operation,
				identity,
				destination: copy.rootPath,
				...(request.operation === "enable" ? { content: contentOf(copy.rootPath) } : {}),
				expected: expectedFor(cwd, identity, consulted, [], diagnostics),
				dependencies: { requires, missing, inactive: [] },
				dependents,
				...(effectiveAfter ? { effectiveAfter } : {}),
				fallbackNote,
				recovery:
					request.operation === "remove"
						? "files that differ from the recorded content are kept beside the destination as a removed backup"
						: "only the enabled flag in state.json changes; no files move",
				...(refusal ? { refusal } : {}),
			});
		}
	} catch (error) {
		releaseHubAction({ id });
		throw error;
	}
	return {
		version: 1,
		id,
		createdAt: new Date().toISOString(),
		cwd,
		request,
		steps,
		reviews: reviewSteps(id, cwd, steps, entries, request.catalog, diagnostics),
		applicable: steps.every((step) => !step.refusal),
		diagnostics,
	};
}

/**
 * The envelope an extension step would install and the pair it belongs to,
 * read from the staged manifest and the catalog. Reading never runs the
 * package, and a failed read only drops the review, never the plan.
 */
function reviewSteps(
	planId: string,
	cwd: string,
	steps: ReadonlyArray<HubPlanStep>,
	installed: ReadonlyArray<InstalledPlugin>,
	catalog: string | undefined,
	diagnostics: string[],
): HubStepReview[] {
	let pairs: ReturnType<typeof readHubPairs> | undefined;
	if (steps.some((step) => step.identity.kind === "plugin" || step.identity.kind === "extension")) {
		try {
			pairs = readHubPairs({ cwd, ...(catalog ? { catalog } : {}) });
		} catch (error) {
			diagnostics.push(
				`plugin and extension pairing unavailable: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
	const reviews: HubStepReview[] = [];
	for (const step of steps) {
		const { identity } = step;
		let envelope: ReturnType<typeof reviewExtensionEnvelope> = null;
		const writes = !step.refusal && (step.operation === "install" || step.operation === "update");
		if (writes && identity.kind === "extension") {
			const sourceRoot = staged.get(planId)?.get(stepKey(identity))?.sourceRoot;
			const installedRoot = step.operation === "update" ? copyOf(installed, identity)?.rootPath : undefined;
			try {
				if (sourceRoot) envelope = reviewExtensionEnvelope(sourceRoot, installedRoot);
			} catch (error) {
				diagnostics.push(
					`${identity.ref} capability envelope unreadable: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}
		const own = pairs?.get(identity.ref) ?? [];
		if (!envelope && own.length === 0) continue;
		reviews.push({
			ref: identity.ref,
			scope: identity.scope,
			...(envelope
				? {
						envelope: envelope.envelope,
						envelopeDigest: envelope.digest,
						...(envelope.growth ? { growth: envelope.growth } : {}),
					}
				: {}),
			pairs: own,
		});
	}
	return reviews;
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

/** Read back one copy: tree, record, inventory state, actual component admission and the surviving effective copy. */
function verifyHubStep(
	identity: HubPackIdentity,
	cwd: string,
	evidence: HubStepVerification["evidence"] = "pre-refresh",
): HubStepVerification {
	const entries = listInstalledPlugins(cwd, { all: true });
	const copy = copyOf(entries, identity);
	const root = path.join(hubPackBaseDir(identity.kind, identity.scope, cwd), identity.name);
	let record: HubStepVerification["record"] = "absent";
	let recordedDigest: string | undefined;
	try {
		const saved = readHubInstallRecord(identity.name, { cwd, scope: identity.scope }, identity.kind);
		record = saved ? "recorded" : "absent";
		recordedDigest = saved?.contentDigest;
	} catch {
		record = "unreadable";
	}
	let tree: HubStepVerification["tree"] = "absent";
	if (existsSync(root)) {
		try {
			tree = recordedDigest && pluginContentDigest(root) !== recordedDigest ? "changed" : "present";
		} catch {
			tree = "changed";
		}
	}
	const kinds = new Set<HubComponentKind>();
	for (const kind of Object.keys(copy?.resources ?? {}))
		if (kind === "skills" || kind === "agents" || kind === "prompts" || kind === "playbooks")
			kinds.add(kind.slice(0, -1) as HubComponentKind);
	const resources: HubStepVerification["resources"] = [];
	if (copy && kinds.size) {
		const inventory = readHubInventory({
			cwd,
			include: { packages: false, copies: false },
			kinds: [...kinds],
			sources: ["package"],
		});
		for (const resource of inventory.resources)
			if (resource.owner?.ref === identity.ref && resource.owner.scope === identity.scope)
				resources.push({
					kind: resource.kind,
					name: resource.name,
					available: resource.availability === "available",
					...(resource.reason ? { reason: resource.reason } : {}),
				});
	}
	const effective = entries.find((item) => competes(item, identity) && item.effective);
	return {
		evidence,
		tree,
		record,
		...(copy ? { copy: hubCopyState(copy) } : {}),
		resources,
		effective: effective ? { scope: effective.scope, loadable: effective.loadable } : null,
	};
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

function nextFor(code: NonNullable<HubStepOutcome["error"]>["code"]): string {
	switch (code) {
		case "stale_plan":
			return "review a fresh plan";
		case "locked":
			return "retry the same plan when the other operation finishes";
		case "refused":
			return "resolve the refusal and review a fresh plan";
		case "verification":
			return "inspect the copy and its recovery paths";
		default:
			return "inspect the diagnostics and recovery paths, then review a fresh plan";
	}
}

function failed(
	step: HubPlanStep,
	code: NonNullable<HubStepOutcome["error"]>["code"],
	message: string,
	extra: Pick<Partial<HubStepOutcome>, "diagnostics" | "recovery"> = {},
): HubStepOutcome {
	return {
		status: "failed",
		operation: step.operation,
		identity: step.identity,
		diagnostics: [],
		...extra,
		error: { code, message, next: nextFor(code) },
	};
}

function writerError(diagnostics: PluginDiagnostic[]): PluginDiagnostic | undefined {
	return diagnostics.find((item) => item.type === "error");
}

function runWriter(plan: HubActionPlan, step: HubPlanStep): PluginMutationResult {
	const { identity } = step;
	if (identity.kind === "extension")
		return withHubScopeLock("extension", identity.scope, plan.cwd, () => {
			for (const expected of step.expected) {
				const observed = observeHubCopy(expected.scope, expected.id, plan.cwd, "extension");
				if (JSON.stringify(expected) !== JSON.stringify(observed))
					throw new PluginWriterRefusal("stale_plan", "extension copy changed since the hub review");
			}
			if (step.operation === "install" || step.operation === "update") {
				const source = staged.get(plan.id)?.get(stepKey(identity));
				if (!source) throw new Error("extension install source was released");
				// Apply only the envelope the operator reviewed; a review that could not be read leaves none to match.
				const review = plan.reviews?.find((item) => item.ref === identity.ref && item.scope === identity.scope);
				source.expectedEnvelopeDigest = review?.envelopeDigest ?? null;
				return commitHubInstallPlan(source);
			}
			const options = { cwd: plan.cwd, scope: identity.scope };
			if (step.operation === "enable") return enableExtension(identity.name, options);
			if (step.operation === "disable") return disableExtension(identity.name, options);
			return removeExtension(identity.name, options);
		});
	const scoped = { cwd: plan.cwd, scope: identity.scope, expect: { copies: step.expected } };
	if (step.operation === "install" || step.operation === "update") {
		const stagedPlan = staged.get(plan.id)?.get(stepKey(identity));
		if (!stagedPlan) throw new Error(`plan ${plan.id} has no staged source for ${identity.ref}; it was released`);
		stagedPlan.expect = scoped.expect;
		return commitHubInstallPlan(stagedPlan);
	}
	if (step.operation === "enable") return enablePlugin(identity.name, scoped);
	if (step.operation === "disable") return disablePlugin(identity.name, scoped);
	return removePlugin(identity.name, scoped);
}

type InstallBaselines = Partial<Record<"extensions" | "plugins", ProjectInstallBaseline | null>>;

function applyStep(plan: HubActionPlan, step: HubPlanStep, baselines: InstallBaselines): HubStepOutcome {
	const peer = peerOf(step.identity.scope);
	const holdPeer =
		step.expected.some((fact) => fact.scope === peer) && existsSync(hubPackBaseDir(step.identity.kind, peer, plan.cwd));
	let result: PluginMutationResult;
	try {
		result = holdPeer
			? withHubScopeLock(step.identity.kind, peer, plan.cwd, () => runWriter(plan, step))
			: runWriter(plan, step);
	} catch (error: unknown) {
		if (error instanceof PluginWriterRefusal) {
			const outcome = failed(step, error.code === "dependents" ? "refused" : error.code, error.message);
			if (error.changed && outcome.error) outcome.error.changed = error.changed;
			return outcome;
		}
		return failed(step, "writer", error instanceof Error ? error.message : String(error));
	}
	const problem = writerError(result.diagnostics);
	if (problem) {
		const code = problem.code === "dependents" ? "refused" : (problem.code ?? "writer");
		const outcome = failed(step, code, problem.message, {
			diagnostics: result.diagnostics.map((d) => d.message),
			...(result.recovery ? { recovery: result.recovery } : {}),
		});
		if (problem.changed && outcome.error) outcome.error.changed = problem.changed;
		return outcome;
	}
	// The operator's own project install is approved before anything reads it
	// back, so the outcome, `config trust` and `hub skills` see one verdict.
	const baseline =
		step.operation === "install" && step.identity.scope === "project"
			? baselines[step.identity.kind === "extension" ? "extensions" : "plugins"]
			: null;
	const approved =
		baseline != null &&
		result.contentDigest !== undefined &&
		approveOperatorProjectInstall(plan.cwd, baseline, [{ id: step.identity.name, contentDigest: result.contentDigest }]);
	// A plugin writer reports the copy's listing diagnostics, read before the
	// approval; an approved copy reports them as they read now.
	const diagnostics =
		approved && step.identity.kind !== "extension"
			? (copyOf(listPluginCopies(plan.cwd, { all: true, id: step.identity.name }), step.identity)?.diagnostics ??
				result.diagnostics)
			: result.diagnostics;
	// The writer committed durably. Verification can only annotate that fact;
	// a read-back failure never turns the commit into a failed step.
	const outcome: HubStepOutcome = {
		status: "committed",
		operation: step.operation,
		identity: step.identity,
		...(step.destination ? { destination: step.destination } : {}),
		...(result.recovery ? { recovery: result.recovery } : {}),
		diagnostics: diagnostics.map((d) => d.message),
	};
	annotateVerification(outcome, plan.cwd, "pre-refresh", step.operation === "remove");
	return outcome;
}

function annotateVerification(
	outcome: HubStepOutcome,
	cwd: string,
	evidence: HubStepVerification["evidence"],
	wantsAbsent: boolean,
): void {
	let verification: HubStepVerification;
	try {
		verification = verifyHubStep(outcome.identity, cwd, evidence);
	} catch (error) {
		outcome.error = {
			code: "verification",
			message: `${evidence} read-back failed: ${error instanceof Error ? error.message : String(error)}`,
			next: nextFor("verification"),
		};
		return;
	}
	outcome.verification = verification;
	const diskOk = wantsAbsent
		? verification.tree === "absent" && verification.record === "absent"
		: verification.tree === "present" && verification.record === "recorded";
	if (diskOk) delete outcome.error;
	else
		outcome.error = {
			code: "verification",
			message: `writer reported success but the ${outcome.identity.scope} copy reads back tree=${verification.tree} record=${verification.record}`,
			next: nextFor("verification"),
		};
}

function unattempted(step: HubPlanStep): HubStepOutcome {
	return { status: "unattempted", operation: step.operation, identity: step.identity, diagnostics: [] };
}

export function applyHubAction(
	plan: HubActionPlan,
	options: { dryRun?: boolean; refresh?: HubRefreshHost } = {},
): HubApplyResult {
	const outcomes: HubStepOutcome[] = [];
	try {
		if (options.dryRun) {
			for (const step of plan.steps) outcomes.push(unattempted(step));
			return summarize(plan, true, outcomes, { status: "not-applicable", reason: "dry run; nothing committed" });
		}
		if (!plan.applicable) {
			for (const step of plan.steps)
				outcomes.push(step.refusal ? failed(step, "refused", step.refusal) : { ...unattempted(step) });
			return summarize(plan, false, outcomes, { status: "not-applicable", reason: "plan refused; nothing committed" });
		}
		// Captured before any step runs: an operator install may approve only a
		// surface that had no state or was trusted (workspace trust).
		const baselines: InstallBaselines = {};
		for (const step of plan.steps) {
			if (step.operation !== "install" || step.identity.scope !== "project") continue;
			const surface = step.identity.kind === "extension" ? "extensions" : "plugins";
			if (!(surface in baselines)) baselines[surface] = captureProjectInstallBaseline(plan.cwd, surface);
		}
		let aborted = false;
		for (const step of plan.steps) {
			if (aborted) {
				outcomes.push(unattempted(step));
				continue;
			}
			const outcome = applyStep(plan, step, baselines);
			outcomes.push(outcome);
			// A durable commit with a verification problem still stops the batch;
			// later steps must not build on a copy whose state cannot be proven.
			if (outcome.status !== "committed" || outcome.error) aborted = true;
		}
	} finally {
		releaseHubAction(plan);
	}
	const committed = outcomes.filter((item) => item.status === "committed");
	const refresh = committed.length
		? retryHubRefresh(plan.cwd, options.refresh, hubRefreshTouch(outcomes))
		: ({ status: "not-applicable", reason: "nothing committed" } as const);
	if (refresh.status === "refreshed")
		for (const outcome of committed)
			annotateVerification(outcome, plan.cwd, "post-refresh", outcome.operation === "remove");
	return summarize(plan, false, outcomes, refresh);
}

/**
 * Pinned programs follow the extension copies an apply committed: downloaded
 * after the reviewed install, pruned on an update, deleted with the last copy.
 * The writers hold scope locks and run synchronously, so this runs after them.
 */
export async function syncHubPackBinaries(
	apply: HubApplyResult,
	cwd: string,
	onProgress?: (message: string) => void,
): Promise<string[]> {
	const ids = new Set(
		apply.outcomes
			.filter((outcome) => outcome.status === "committed" && outcome.identity.kind === "extension")
			.map((outcome) => outcome.identity.name),
	);
	const failures: string[] = [];
	for (const id of ids) failures.push(...(await syncPackBinaries(id, cwd, onProgress ? { onProgress } : {})));
	return failures;
}

function summarize(
	plan: HubActionPlan,
	dryRun: boolean,
	outcomes: HubStepOutcome[],
	refresh: HubRefreshResult,
): HubApplyResult {
	return {
		planId: plan.id,
		dryRun,
		outcomes,
		committed: outcomes.filter((item) => item.status === "committed").length,
		failed: outcomes.filter((item) => item.status === "failed").length,
		unattempted: outcomes.filter((item) => item.status === "unattempted").length,
		refresh,
	};
}

/** Refresh only. Never reinstalls or removes; safe after a partial batch or a failed refresh. */
export function retryHubRefresh(
	cwd: string,
	refresh?: HubRefreshHost,
	touched: HubRefreshTouch = { extensions: false },
): HubRefreshResult {
	if (!refresh)
		return {
			status: "not-applicable",
			reason: touched.extensions
				? "no active session in this process; run /reload in the running TUI to load the extension and its hooks"
				: "no active session in this process; use /reload hub in the running TUI",
		};
	try {
		return refresh(cwd, touched);
	} catch (error) {
		return { status: "failed", error: error instanceof Error ? error.message : String(error) };
	}
}

/** The typed kind of an import: the applied install record when published, else the reviewed manifest bytes. */
function importedKind(plan: HubImportPlan, result: HubImportApplyResult, name: string): HubEntryKind {
	if (result.published) {
		try {
			const saved = readPluginInstallRecord(name, { cwd: plan.cwd, scope: plan.scope });
			if (saved?.kind) return saved.kind;
		} catch {
			// Fall through to the reviewed bytes.
		}
	}
	try {
		const manifest = plan.files?.["plugin.json"];
		const parsed = manifest ? (JSON.parse(manifest) as { extensions?: Record<string, { kind?: unknown }> }) : undefined;
		const kind = parsed?.extensions?.["dev.pancode"]?.kind;
		if (isHubKind(kind)) return kind;
	} catch {
		// Unreadable review bytes: portable default.
	}
	return "plugin";
}

/** Read-only projection of an explicit import into the shared outcome shape. Trust stays foreign; nothing re-runs. */
export function hubImportOutcome(plan: HubImportPlan, result: HubImportApplyResult): HubStepOutcome {
	const name = result.installed ?? plan.id ?? path.basename(plan.source.root);
	const identity = identityOf(importedKind(plan, result, name), name, plan.scope);
	if (!result.published)
		return {
			status: "failed",
			operation: "install",
			identity,
			diagnostics: result.diagnostics,
			error: {
				code: "refused",
				message: result.diagnostics.join("; ") || "import not published",
				next: nextFor("refused"),
			},
		};
	const outcome: HubStepOutcome = {
		status: "committed",
		operation: "install",
		identity,
		imported: true,
		...(plan.destination ? { destination: plan.destination } : {}),
		diagnostics: [
			...result.diagnostics,
			result.admission.gateEnabled === true
				? `imported content keeps its outside origin, and ${result.admission.gate} is on`
				: result.admission.gateEnabled === false
					? `imported content keeps its outside origin, and ${result.admission.gate} is off, so it does not load yet`
					: `imported content keeps its outside origin; it loads only while ${result.admission.gate} is on`,
		],
	};
	annotateVerification(outcome, plan.cwd, "pre-refresh", false);
	return outcome;
}
