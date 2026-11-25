// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, parse, relative, resolve, sep } from "node:path";
import { sha256Hex } from "../../core/hash.js";
import { relativePathEscapes } from "../../core/path-containment.js";
import { ensureProjectIgnore, pancodeProjectRoot } from "../../core/project-root.js";
import { safeResourceWrite } from "../../core/safe-resource-write.js";
import { gitOutput } from "./bootstrap-git.js";
import type { HandbookLedgerEntry } from "./bootstrap-types.js";
import { handbookLedgerPath } from "./handbook-ledger.js";
import { isBootstrapGenerationState, readPancodeState, writePancodeState } from "./state.js";

/** The hash of a file's bytes as they are on disk, or null when it does not exist. */
export function hashExistingFile(path: string): string | null {
	try {
		return sha256Hex(readFileSync(path));
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw err;
	}
}

interface LedgerFile {
	version: 1;
	commit: string | null;
	entries: HandbookLedgerEntry[];
	verifiedCommit?: string;
	verifiedAt?: string;
	verification?: HandbookLedgerEntry[];
}

export function readLedgerFile(cwd: string): Partial<LedgerFile> {
	try {
		const parsed: unknown = JSON.parse(readFileSync(handbookLedgerPath(cwd), "utf8"));
		return parsed !== null && typeof parsed === "object" ? (parsed as Partial<LedgerFile>) : {};
	} catch {
		return {};
	}
}

export function writeLedgerFile(cwd: string, ledger: LedgerFile): void {
	safeResourceWrite(handbookLedgerPath(cwd), `${JSON.stringify(ledger, null, 2)}\n`);
}

/**
 * Every adopted unit `context init` judged, with its verdict, so an operator can
 * see why a sibling handbook rule did or did not reach PANCODE.md. The last
 * `--verify` record is kept.
 */
export function writeHandbookLedger(cwd: string, entries: ReadonlyArray<HandbookLedgerEntry>): void {
	const commit = gitOutput(cwd, ["rev-parse", "HEAD"])?.trim() || null;
	const { verifiedCommit, verifiedAt, verification } = readLedgerFile(cwd);
	writeLedgerFile(cwd, {
		version: 1,
		commit,
		entries: entries.map((entry) => ({ ...entry, commit })),
		...(typeof verifiedCommit === "string" ? { verifiedCommit } : {}),
		...(typeof verifiedAt === "string" ? { verifiedAt } : {}),
		...(Array.isArray(verification) ? { verification } : {}),
	});
}

function timestampForPath(now: Date): string {
	return now
		.toISOString()
		.replace(/[-:]/g, "")
		.replace(/\.\d{3}Z$/, "Z");
}

/**
 * Writes `content` as a proposal for `handbookPath` with its sidecar: the hash
 * of the handbook it was drafted against and of the proposal itself, which
 * `--accept` checks before it writes.
 */
export function writeProposalFile(
	cwd: string,
	now: Date,
	content: string,
	handbookPath: string,
	sourceHash: string | null,
	extra: Record<string, unknown>,
): string {
	const dir = proposalsDir(cwd);
	ensureProjectIgnore(cwd);
	mkdirSync(dir, { recursive: true });
	const proposalPath = join(dir, `PANCODE-${timestampForPath(now)}-${randomUUID()}.md`);
	writeFileSync(proposalPath, content, { encoding: "utf8", flag: "wx" });
	// Proposal provenance belongs to the candidate, never to the untouched handbook.
	writeFileSync(
		`${proposalPath}.json`,
		`${JSON.stringify({
			version: 1,
			createdAt: now.toISOString(),
			handbookPath,
			sourceHash,
			proposalHash: sha256Hex(content),
			...extra,
		})}\n`,
		{ encoding: "utf8", flag: "wx" },
	);
	return proposalPath;
}

/** Handbook names a proposal may target; any other sidecar target is refused. */
const PROPOSAL_TARGETS: ReadonlySet<string> = new Set(["PANCODE.md", "PANCODE.override.md", "PANCODE-DEV.md"]);

/** The handbook a proposal's sidecar names, when it is a handbook inside the project; PANCODE.md otherwise. */
function proposalTarget(cwd: string, named: unknown): string | null {
	if (named === undefined) return join(cwd, "PANCODE.md");
	if (typeof named !== "string") return null;
	const target = resolve(named);
	const inside = relative(resolve(cwd), target);
	if (relativePathEscapes(inside) || !PROPOSAL_TARGETS.has(basename(target))) return null;
	return target;
}

function proposalsDir(cwd: string): string {
	return join(cwd, ".pancode", "proposals");
}

/** A proposal's id: its file name without `PANCODE-` and `.md`, which `--accept` takes. */
export function proposalId(proposalPath: string): string {
	return parse(proposalPath).name.replace(/^PANCODE-/, "");
}

function resolveProposal(cwd: string, ref: string | undefined): { path: string } | { error: string } {
	const dir = proposalsDir(cwd);
	let names: string[];
	try {
		names = readdirSync(dir)
			.filter((name) => /^PANCODE-.+\.md$/.test(name))
			.sort((a, b) => a.localeCompare(b));
	} catch {
		names = [];
	}
	if (ref === undefined) {
		const latest = names.at(-1);
		return latest ? { path: join(dir, latest) } : { error: "no proposal in .pancode/proposals" };
	}
	if (ref.includes("/") || ref.includes("\\")) {
		const path = resolve(cwd, ref);
		if (dirname(path) !== dir || !names.includes(parse(path).base))
			return { error: `${ref} is not a proposal in .pancode/proposals` };
		return { path };
	}
	const matches = names.filter(
		(name) => name === ref || name === `${ref}.md` || name === `PANCODE-${ref}.md` || name.endsWith(`-${ref}.md`),
	);
	if (matches.length === 1) return { path: join(dir, matches[0] as string) };
	return { error: matches.length === 0 ? `no proposal matches ${ref}` : `${ref} matches ${matches.length} proposals` };
}

export type AcceptProposalResult =
	| { ok: true; proposalPath: string; handbookPath: string }
	| { ok: false; proposalPath?: string; reason: string };

/**
 * Drops the last `--verify` verdicts for the handbook file at `handbookPath`
 * once new text replaces it: they judged text that is gone, and `--verify`
 * judges the new text.
 */
export function dropVerifyVerdicts(cwd: string, handbookPath: string): void {
	const root = pancodeProjectRoot(cwd);
	const file = relative(root, handbookPath).split(sep).join("/");
	const ledger = readLedgerFile(root);
	if (Array.isArray(ledger.verification) && ledger.verification.some((entry) => entry.source.file === file))
		writeLedgerFile(root, {
			version: 1,
			commit: ledger.commit ?? null,
			entries: ledger.entries ?? [],
			...(ledger.verifiedCommit ? { verifiedCommit: ledger.verifiedCommit } : {}),
			...(ledger.verifiedAt ? { verifiedAt: ledger.verifiedAt } : {}),
			verification: ledger.verification.filter((entry) => entry.source.file !== file),
		});
}

/**
 * What an accepted proposal changes besides the handbook: the generation that
 * drafted a new PANCODE.md becomes state.lastBootstrap, and the replaced
 * file's verify verdicts are dropped.
 */
function recordAcceptedProposal(cwd: string, handbookPath: string, generation: unknown): void {
	dropVerifyVerdicts(cwd, handbookPath);
	const state = readPancodeState(cwd);
	if (state && handbookPath === join(cwd, "PANCODE.md") && isBootstrapGenerationState(generation))
		writePancodeState(cwd, { ...state, lastBootstrap: generation });
}

/**
 * Writes a stored proposal's bytes to PANCODE.md, but only while the handbook
 * still hashes to the sidecar's `sourceHash`, so an edit made after the draft
 * was written is never overwritten. `ref` is a proposal path, file name or id;
 * without it the newest proposal is taken.
 */
export function acceptHandbookProposal(cwd: string, ref?: string): AcceptProposalResult {
	const resolved = resolveProposal(cwd, ref);
	if ("error" in resolved) return { ok: false, reason: resolved.error };
	const proposalPath = resolved.path;
	let sidecar: { sourceHash?: unknown; proposalHash?: unknown; handbookPath?: unknown; generation?: unknown };
	let bytes: Buffer;
	try {
		sidecar = JSON.parse(readFileSync(`${proposalPath}.json`, "utf8")) as typeof sidecar;
		bytes = readFileSync(proposalPath);
	} catch {
		return { ok: false, proposalPath, reason: "the proposal or its .json sidecar cannot be read" };
	}
	if (sidecar.proposalHash !== sha256Hex(bytes))
		return { ok: false, proposalPath, reason: "the proposal was edited after it was written" };
	const handbookPath = proposalTarget(cwd, sidecar.handbookPath);
	if (handbookPath === null)
		return { ok: false, proposalPath, reason: "the proposal names a target that is not a handbook in this project" };
	let currentHash: string | null;
	try {
		currentHash = hashExistingFile(handbookPath);
	} catch {
		return { ok: false, proposalPath, reason: `${relative(cwd, handbookPath)} cannot be read` };
	}
	if (sidecar.sourceHash !== currentHash)
		return {
			ok: false,
			proposalPath,
			reason: `${relative(cwd, handbookPath)} changed since the proposal was written; draft it again`,
		};
	safeResourceWrite(handbookPath, bytes);
	recordAcceptedProposal(cwd, handbookPath, sidecar.generation);
	return { ok: true, proposalPath, handbookPath };
}
