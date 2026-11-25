// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

import { readFileSync, statSync } from "node:fs";
import { join, posix, relative } from "node:path";
import { enumerateWorkspaceFiles } from "../../core/workspace-files.js";
import { packageScripts } from "./bootstrap-project.js";
import type { BootstrapGenerateInput } from "./bootstrap-types.js";
import { packageManager } from "./package-manager.js";
import { HANDBOOK_TARGETS, type PancodeMdSection } from "./pancode-md.js";
import { forbidsCitation } from "./tree-facts.js";

export interface ModelGroundingCorpus {
	lower: string;
	indexedPaths: ReadonlySet<string>;
	symbolDefinitions: ReadonlyMap<string, ReadonlySet<string>>;
	/** Every visible repository path, including docs, configs and CI files the codemap does not index. */
	repositoryPaths: ReadonlySet<string>;
	/** Lowercased text of the visible repository files, read once on first need. */
	repositoryText: () => string;
	/** Lowercased text of one visible repository file, or null when it cannot be read. */
	fileText: (path: string) => string | null;
	/** Opening text of each long package script body, whitespace-collapsed. */
	scriptRecitals: ReadonlyArray<string>;
	/** Script-specific bodies prevent test:full's smoke glob from being attributed to test. */
	scriptBodies: ReadonlyMap<string, string>;
	/** The repository's launcher identifies exact script invocations in model citations. */
	packageManager: string;
}

/** Long enough that quoting it restates the script rather than naming a command. */
const SCRIPT_RECITAL_CHARS = 40;

/** Files larger than this are data, not rules; skip them when grounding citations. */
const GROUNDING_FILE_MAX_BYTES = 1024 * 1024;
/** Total text read for grounding; bounds memory on very large repositories. */
const GROUNDING_TEXT_MAX_BYTES = 96 * 1024 * 1024;

function repositoryGroundingText(cwd: string, paths: ReadonlyArray<string>): string {
	const chunks: string[] = [];
	let total = 0;
	for (const path of paths) {
		if (total >= GROUNDING_TEXT_MAX_BYTES) break;
		try {
			const full = join(cwd, path);
			if (statSync(full).size > GROUNDING_FILE_MAX_BYTES) continue;
			const bytes = readFileSync(full);
			if (bytes.includes(0)) continue;
			chunks.push(bytes.toString("utf8").toLowerCase());
			total += bytes.length;
		} catch {
			// A file that vanished or cannot be read simply grounds nothing.
		}
	}
	return chunks.join("\n");
}

/**
 * Root files a generation run never reads or cites: its own output, and PanCode's
 * hand-written PANCODE-DEV.md, which the generated handbook is compared against.
 */
export const GENERATION_EXCLUDED_FILES: ReadonlySet<string> = new Set(["PANCODE.md", "PANCODE-DEV.md"]);

/**
 * Everything Scout is allowed to cite: every indexed path, every indexed symbol,
 * every runnable package script rendered the way this repository would type it,
 * and the text of repository files. Sibling agent-context prose and the existing
 * handbook are quoted to the model as input, never evidence: a rule stated only
 * in a sibling handbook would otherwise ground the model line that copies it.
 */
export function createModelGroundingCorpus(input: BootstrapGenerateInput): ModelGroundingCorpus {
	const siblingPaths = new Set(input.siblingFiles.map((file) => relative(input.cwd, file.path).split("\\").join("/")));
	const indexedPaths = new Set(input.codewiki.files.map((file) => file.path));
	const pathsById = new Map(input.codewiki.files.map((file) => [file.id, file.path]));
	const symbolDefinitions = new Map<string, Set<string>>();
	for (const symbol of input.codewiki.symbols) {
		const path = pathsById.get(symbol.fileId);
		if (path === undefined) continue;
		const definitions = symbolDefinitions.get(symbol.name) ?? new Set<string>();
		definitions.add(path);
		symbolDefinitions.set(symbol.name, definitions);
	}
	const pm = packageManager(input.cwd);
	const scripts = packageScripts(input.cwd);
	const evidence = [
		...(input.evidence?.files
			.filter((file) => !siblingPaths.has(file.path))
			.map((file) => `${file.path}\n${file.excerpt}`) ?? []),
		...(input.enforcement ? [JSON.stringify(input.enforcement)] : []),
		input.expectedProjectName ?? "",
		input.projectType,
		[...indexedPaths].join("\n").slice(0, 64_000),
		...Object.entries(scripts).flatMap(([name, command]) => [`${pm} run ${name}`, `${pm} ${name}`, command]),
		input.codewiki.symbols
			.map((symbol) => symbol.name)
			.join("\n")
			.slice(0, 128_000),
	].join("\n");
	let repositoryPaths: ReadonlyArray<string> = input.repositoryFiles ?? [];
	try {
		if (!input.repositoryFiles)
			repositoryPaths = enumerateWorkspaceFiles(input.cwd).filter((path) => !GENERATION_EXCLUDED_FILES.has(path));
	} catch {
		// An unreadable tree leaves the indexed evidence as the only grounding.
	}
	let text: string | null = null;
	const fileTexts = new Map<string, string | null>();
	const textPaths = repositoryPaths.filter((path) => !siblingPaths.has(path));
	return {
		lower: evidence.toLowerCase(),
		indexedPaths,
		symbolDefinitions,
		// Five models attributed test:full's glob to test; keep each script's own selector evidence.
		scriptBodies: new Map(Object.entries(scripts)),
		packageManager: pm,
		scriptRecitals: Object.values(scripts)
			.map((command) => command.replace(/\s+/g, " ").trim())
			.filter((command) => command.length >= SCRIPT_RECITAL_CHARS)
			.map((command) => command.slice(0, SCRIPT_RECITAL_CHARS)),
		repositoryPaths: new Set(repositoryPaths),
		repositoryText: () => {
			text ??= repositoryGroundingText(input.cwd, textPaths);
			return text;
		},
		fileText: (path) => {
			if (!fileTexts.has(path))
				fileTexts.set(path, textPaths.includes(path) ? repositoryGroundingText(input.cwd, [path]) || null : null);
			return fileTexts.get(path) ?? null;
		},
	};
}

export const CODE_TOKEN_RE = /`([^`\n]+)`/g;

/**
 * A citation anchored to a location: `src/cart.ts:26`, `src/cart.ts:40-42`, or
 * `src/cart.ts:26:8`. The codewiki digest handed to the model prints its key
 * symbols in exactly this form, so this is the shape a model that read the
 * evidence writes back.
 */
const CITED_LOCATION_RE = /^(.*[^:]):(\d+)(?:[-:]\d+)?$/;

/** A symbol written as a call: `priceCart()`. */
const CITED_CALL_RE = /^(.+?)\(\s*\)$/;

/** A concrete file path: a directory part and a file name with an extension, no pattern, home or URL. */
const CONCRETE_FILE_RE = /^[^\s~/:][^\s:]*\/[^\s/]*\.[A-Za-z0-9]+$/;

function groundedLiteral(literal: string, evidence: ModelGroundingCorpus): boolean {
	const lower = literal.toLowerCase();
	const path = literal.replace(/^\.\//, "").replace(/\/$/, "");
	// Cited paths decide which workers receive a rule (`handbook-units.ts`), so a
	// file path must name a file from the repository root. A substring match let
	// `tests/chat-composer.test.ts` through for `apps/pancode-gui/tests/`, and
	// the rule then claimed the GUI tests live at the root.
	if (CONCRETE_FILE_RE.test(path)) return evidence.indexedPaths.has(path) || evidence.repositoryPaths.has(path);
	if (evidence.lower.includes(lower) || evidence.indexedPaths.has(path) || evidence.repositoryPaths.has(path))
		return true;
	// A directory is real when some visible file lives under it.
	if (literal.includes("/")) {
		for (const candidate of evidence.repositoryPaths) if (candidate.startsWith(`${path}/`)) return true;
	}
	return evidence.repositoryText().includes(lower);
}

/**
 * A one-level glob, `docs/*.md`, over a directory holding files it would match
 * deeper down. It reads as the directory's whole scope: a handbook said the
 * documentation-links check covers `docs/*.md` and two root guides, "all
 * three", while the check reads Markdown under `docs/` at every depth.
 */
function narrowerThanTree(token: string, evidence: ModelGroundingCorpus): boolean {
	const slash = token.lastIndexOf("/");
	const dir = token.slice(0, slash).replace(/^\.\//, "");
	const name = token.slice(slash + 1);
	if (slash <= 0 || !name.includes("*") || name.includes("**") || /[?<>{}[\]]/.test(name) || /[*?<>{}[\]]/.test(dir))
		return false;
	const pattern = new RegExp(
		`^${name
			.split("*")
			.map((piece) => piece.replace(/[.+^$()|\\]/g, "\\$&"))
			.join("[^/]*")}$`,
	);
	for (const path of evidence.repositoryPaths) {
		if (!path.startsWith(`${dir}/`)) continue;
		const rest = path.slice(dir.length + 1);
		if (rest.includes("/") && pattern.test(rest.slice(rest.lastIndexOf("/") + 1))) return true;
	}
	return false;
}

/**
 * A citation may be a pattern rather than a name: a glob (`src/engine/**`,
 * `PANCODE_*`), a placeholder (`tests/<name>.test.ts`), or a command chain joined
 * with `&&`. Each literal piece of at least three characters must ground on
 * its own, so a pattern can never smuggle in a name the repository lacks, and
 * a one-level glob must not hide deeper matches (`narrowerThanTree`).
 */
function groundedName(token: string, evidence: ModelGroundingCorpus): boolean {
	const parts = token.split(/\s*&&\s*/).filter((part) => part.length > 0);
	if (parts.length > 1) return parts.every((part) => groundedName(part, evidence));
	if (narrowerThanTree(token, evidence)) return false;
	const literals = token
		.split(/<[^<>]*>|\*+|\?|\{[^{}]*\}/)
		.map((piece) => piece.trim())
		.filter((piece) => piece.length > 0);
	if (literals.length === 1 && literals[0] === token) return groundedLiteral(token, evidence);
	const meaningful = literals.filter((piece) => piece.replace(/[^A-Za-z0-9]/g, "").length >= 3);
	return meaningful.length > 0 && meaningful.every((piece) => groundedLiteral(piece, evidence));
}

/**
 * The names a citation carries under its decoration. The corpus holds paths,
 * symbol names, and scripts, so a token that adds a file offset or call parens
 * to one of them cannot match it whole, and requiring the whole token to match
 * deleted precisely the lines that had done the most reading. A Gotchas section
 * whose five bullets each named a real file and line lost all five and
 * vanished; the run after that lost every line that wrote `priceCart()` for the
 * symbol `priceCart`. Peeling the decoration cannot loosen the rule, because
 * the bare name still has to ground on its own.
 */
function citedNames(token: string): string[] {
	const names: string[] = [];
	let current = token;
	for (let round = 0; round < 2; round += 1) {
		const next = (CITED_CALL_RE.exec(current)?.[1] ?? CITED_LOCATION_RE.exec(current)?.[1])?.trim();
		if (next === undefined || next.length === 0 || next === current) break;
		names.push(next);
		current = next;
	}
	return names;
}

export function groundedToken(token: string, evidence: ModelGroundingCorpus): boolean {
	return groundedName(token, evidence) || citedNames(token).some((name) => groundedName(name, evidence));
}

/**
 * A slash makes a word a path only when it names one. Two prose words joined
 * by a slash (verb pairs, the input-output abbreviation) grounded as a
 * substring somewhere and came back wrapped as code. Patterns pass on to the citation
 * rule, which grounds their literal pieces.
 */
function repositoryPathToken(token: string, evidence: ModelGroundingCorpus): boolean {
	const path = token.replace(/^\.\//, "").replace(/\/$/, "");
	if (/[*?<>{}]/.test(path)) return true;
	if (evidence.indexedPaths.has(path) || evidence.repositoryPaths.has(path)) return true;
	for (const candidate of evidence.repositoryPaths) if (candidate.startsWith(`${path}/`)) return true;
	return false;
}

/**
 * A case hump marks an identifier, except in a proper noun: `TypeScript` and
 * `GitHub` are PascalCase words, not names in this repository. A PascalCase
 * word is code only when the index defines it; lowerCamel is always code.
 */
function camelCaseIdentifier(token: string, evidence: ModelGroundingCorpus): boolean {
	if (!/[a-z0-9][A-Z]/.test(token)) return false;
	return /^[a-z]/.test(token) || evidence.symbolDefinitions.has(token.replace(/\(\)$/, ""));
}

// Nemotron's accurate first draft cited no names in backticks, so the citation rule dropped every line.
// Backtick a bare name only when it reads as code and passes the same check a backticked citation faces.
function wrapBareCitations(line: string, evidence: ModelGroundingCorpus): string {
	return line
		.split(/(`[^`\n]*`|\]\([^)\s]*\))/)
		.map((part, index) => {
			if (index % 2 === 1) return part;
			return part.replace(
				/\b(?:pnpm|npm|yarn|bun)\s+(?:run\s+)?[A-Za-z0-9_:@./*-]+|[A-Za-z0-9_$@.][A-Za-z0-9_$@./*?+<>-]*/g,
				(match) => {
					const token = match.replace(/[.,;:!?]+$/, "");
					const punctuation = match.slice(token.length);
					const words = token.split(/\s+/);
					const script = words[1] === "run" && words.length === 3 ? words[2] : words.length === 2 ? words[1] : undefined;
					const invocation =
						words[0] === evidence.packageManager && script !== undefined && evidence.scriptBodies.has(script);
					// "e.g" or "bold**" must not count as a name.
					const dotted = token.replace(/\b\w{1,2}\./g, "");
					const codeLike =
						/[_@]/.test(token) ||
						(token.includes("/") ? repositoryPathToken(token, evidence) : camelCaseIdentifier(token, evidence)) ||
						(dotted.includes(".") && /^\.?[\w-]+(?:\.[\w-]+)*$/.test(dotted));
					return invocation || (codeLike && groundedToken(token, evidence)) ? `\`${token}\`${punctuation}` : match;
				},
			);
		})
		.join("");
}

// Real symbols were attributed to importing files; use indexed definitions to correct unambiguous ownership.
// A path followed by 's ("in the index file's sibling") names a neighbor, not the owner: leave it.
export function correctSymbolAttributions(line: string, evidence: ModelGroundingCorpus): string {
	return line.replace(
		/(`[A-Za-z_$][\w$]*(?:\(\))?`(?:\s*(?:,\s*(?:(?:and|or)\s+)?|(?:and|or)\s+)`[A-Za-z_$][\w$]*(?:\(\))?`)*)\s+(in|from|of)\s+`([^`\n]+)`(?!['\u2019]s\b)/g,
		(match, symbols: string, relation: string, citedPath: string) => {
			const path = citedPath.replace(/^\.\//, "");
			if (!/^[\w./-]+\.[A-Za-z0-9]+$/.test(path)) return match;
			const owners = [...symbols.matchAll(CODE_TOKEN_RE)].map((symbol) => {
				const definitions = evidence.symbolDefinitions.get((symbol[1] ?? "").replace(/\(\)$/, ""));
				if (definitions?.has(path)) return path;
				return definitions?.size === 1 ? [...definitions][0] : undefined;
			});
			const owner = owners[0];
			if (owner === undefined || owner === path || !owners.every((candidate) => candidate === owner)) return match;
			return `${symbols} ${relation} \`${owner}\``;
		},
	);
}

const REVIEW_REQUIREMENT_RE = /\breviewers?\b|\brequired reviews?\b/i;
/** An approval gate: approval in a sentence about a deployment environment, not "approval before disabling a check". */
const APPROVAL_GATE_RE = /^(?=.*\bapprov(?:al|als|e|es|ed|ing)\b)(?=.*\benvironments?\b)/is;
/**
 * Review policy stated as configuration: branch protection and rulesets
 * (`required_pull_request_reviews`, `required_approving_review_count`,
 * `require_code_owner_reviews`), deployment environments (`reviewers:`,
 * `required_reviewers`), or a CODEOWNERS file.
 */
const REVIEW_POLICY_KEY_RE =
	/["']?\b(?:required_pull_request_reviews|required_approving_review_count|require_code_owner_reviews?|required_reviewers|dismiss_stale_reviews|require_last_push_approval|reviewers)["']?\s*:/i;

function statesReviewPolicy(path: string, text: string): boolean {
	return /(?:^|\/)CODEOWNERS$/.test(path) || REVIEW_POLICY_KEY_RE.test(text) || REVIEW_REQUIREMENT_RE.test(text);
}

/** A cited path as the repository names it: `./src/cart.ts:26` is `src/cart.ts`. */
function citedPath(token: string): string {
	const path = token.trim().replace(/^\.\//, "");
	return CITED_LOCATION_RE.exec(path)?.[1] ?? path;
}

/** Cut `drop` from each parenthesized citation list, `(`a`, `b`)`, and the list when none remain. */
function withoutCitations(sentence: string, drop: ReadonlySet<string>): string {
	return sentence.replace(/\s*\((`[^`\n]+`(?:\s*(?:,|;|\band\b)\s*`[^`\n]+`)*)\)/g, (list, inner: string) => {
		const spans = [...inner.matchAll(CODE_TOKEN_RE)];
		const kept = spans.filter((span) => !drop.has(citedPath(span[1] ?? ""))).map((span) => span[0]);
		if (kept.length === spans.length) return list;
		return kept.length > 0 ? ` (${kept.join(", ")})` : "";
	});
}

/** A line's list marker, and its prose sentences split without breaking inside a code span. */
function proseSentences(line: string): { prefix: string; sentences: string[] } {
	const prefix = /^\s*(?:[-*+]\s+|\d+[.)]\s+)?/.exec(line)?.[0] ?? "";
	const body = line.slice(prefix.length);
	const masked = body.replace(/`[^`\n]*`/g, (span) => `\`${"x".repeat(span.length - 2)}\``);
	const sentences: string[] = [];
	let from = 0;
	for (const match of masked.matchAll(/[.!?](?=\s+[A-Z`*])/g)) {
		const at = (match.index ?? 0) + 1;
		sentences.push(body.slice(from, at));
		from = at;
	}
	sentences.push(body.slice(from));
	return { prefix, sentences };
}

interface ClaimCitations {
	/** Which code spans are cited files; concrete paths below the root by default. */
	cites?: (path: string) => boolean;
	/** Cited files that do not support the claim, cut from citation lists when another cited file does. */
	unsupporting?: (cited: string[]) => string[];
	/** The evidence was read in full and contradicts the claim: cut the sentence instead of marking it. */
	refuted?: (cited: string[]) => boolean;
}

/**
 * Append `(unverified: …)` to each sentence of a line that makes a `claim` the
 * files it cites do not support; `unsupported` names what is missing, or null.
 * The claim may still hold, so the sentence stays, marked as not found in what
 * it cites, rather than vanishing as a safety rule.
 */
function withUnsupportedClaimsMarked(
	line: string,
	claim: RegExp,
	unsupported: (cited: string[]) => string | null,
	citations: ClaimCitations = {},
): string {
	if (!claim.test(line)) return line;
	const cites = citations.cites ?? ((path: string) => CONCRETE_FILE_RE.test(path));
	const { prefix, sentences } = proseSentences(line);
	const marked = sentences.map((sentence) => {
		if (!claim.test(sentence)) return sentence;
		const cited = [
			...new Set([...sentence.matchAll(CODE_TOKEN_RE)].map((match) => citedPath(match[1] ?? "")).filter(cites)),
		];
		const missing = cited.length > 0 ? unsupported(cited) : null;
		if (missing === null) return withoutCitations(sentence, new Set(citations.unsupporting?.(cited) ?? []));
		if (citations.refuted?.(cited) === true) return "";
		const note = ` (unverified: ${missing})`;
		const end = /([.!?])(\s*)$/.exec(sentence);
		return end ? `${sentence.slice(0, end.index)}${note}${end[1]}${end[2]}` : `${sentence.trimEnd()}${note}`;
	});
	return `${prefix}${marked.join("").trim()}`;
}

/**
 * Every generated handbook said the `release` environment "in
 * `.github/workflows/release.yml`" requires the owner as reviewer: the path is
 * real, so the citation grounded, but reviewers are a GitHub environment setting
 * that only `CONTRIBUTING.md` describes, and the workflow names no reviewer. A
 * later one cited both for the environment's owner approval; the workflow is cut
 * from that citation list, since the guide states the policy.
 */
function withUnsupportedReviewRequirementsMarked(line: string, evidence: ModelGroundingCorpus): string {
	const statesPolicy = (path: string): boolean => {
		const text = evidence.fileText(path);
		return text === null || statesReviewPolicy(path, text);
	};
	return withUnsupportedClaimsMarked(
		line,
		new RegExp(`${REVIEW_REQUIREMENT_RE.source}|${APPROVAL_GATE_RE.source}`, "is"),
		(cited) =>
			cited.some(statesPolicy) ? null : `${cited.map((path) => `\`${path}\``).join(", ")} states no review policy`,
		{
			// A root guide such as `CONTRIBUTING.md` states review policy, so it counts as cited.
			cites: (path) => CONCRETE_FILE_RE.test(path) || evidence.repositoryPaths.has(path),
			unsupporting: (cited) => cited.filter((path) => !statesPolicy(path)),
		},
	);
}

/** CI named in prose: an acronym, never a lowercase `ci-tests` stem. */
const CI_PROSE_RE = /\bCI\b|\b[Cc]ontinuous [Ii]ntegration\b|\bGitHub Actions\b/;
const WORKFLOW_PATH_RE = /\.github\/workflows\b/;

/** Cut each sentence of a line that `drops`; the line is empty when none remains. */
function withoutSentences(line: string, drops: (sentence: string) => boolean): string {
	const { prefix, sentences } = proseSentences(line);
	const kept = sentences.filter((sentence) => !drops(sentence));
	if (kept.length === sentences.length) return line;
	const body = kept.join("").trim();
	return body ? `${prefix}${body}` : "";
}

/**
 * Cut each sentence of a model line that speaks for CI, in either voice. PanCode
 * does not verify what CI runs, so a rule names the check and what it refuses:
 * handbooks said both pin `--check` modes "fail CI on drift" when CI reached
 * neither by name, and a phrase list of passive claims let "CI enforces" and
 * "CI will reject" through. The line drops when no sentence remains.
 */
export function withoutCiStatements(line: string): string {
	return withoutSentences(line, namesCi);
}

function namesCi(text: string): boolean {
	return CI_PROSE_RE.test(text.replace(/`[^`\n]*`/g, ""));
}

/** Where a clause ends inside a sentence: a colon, a semicolon, or a comma before `so`, `and` or `but`. */
const CLAUSE_END_RE = /(?:[:;]|,(?=\s+(?:so|and|but)\s))(?=\s)/g;

/**
 * Cut the clauses of a line that speak for CI and keep the rest of each
 * sentence. A carried hard invariant states its rule before a colon and its
 * reason after it, as in "Keep X: `scripts/check.js` fails CI otherwise", so
 * cutting the whole sentence would drop the rule with the claim. A kept
 * clause loses the conjunction that tied it to a cut one. A sentence with no
 * clause left drops whole, and the line is empty when none remains.
 */
export function withoutCiClauses(line: string): string {
	if (!namesCi(line)) return line;
	const { prefix, sentences } = proseSentences(line);
	const kept = sentences.flatMap((sentence) => {
		if (!namesCi(sentence)) return [sentence];
		const masked = sentence.replace(/`[^`\n]*`/g, (span) => `\`${"x".repeat(span.length - 2)}\``);
		const clauses: string[] = [];
		let from = 0;
		for (const match of masked.matchAll(CLAUSE_END_RE)) {
			const at = (match.index ?? 0) + 1;
			clauses.push(sentence.slice(from, at));
			from = at;
		}
		clauses.push(sentence.slice(from));
		const remaining = clauses.flatMap((clause, index) => {
			if (namesCi(clause)) return [];
			const previous = clauses[index - 1];
			return [previous !== undefined && namesCi(previous) ? clause.replace(/^(\s*)(?:so|and|but)\s+/, "$1") : clause];
		});
		if (remaining.length === 0) return [];
		const body = remaining.join("").replace(/[\s:;,]+$/, "");
		const opened = namesCi(clauses[0] ?? "")
			? body.replace(/^(\s*)(\p{Ll})/u, (_, space: string, letter: string) => `${space}${letter.toUpperCase()}`)
			: body;
		return [/[.!?]$/.test(opened) ? opened : `${opened}.`];
	});
	const body = kept.join(" ").replace(/\s+/g, " ").trim();
	return body ? `${prefix}${body}` : "";
}

/**
 * Cut each sentence that cites a workflow file. A workflow defines what CI
 * runs, and every generated handbook cited `.github/workflows/release.yml` for
 * an owner review that only `CONTRIBUTING.md` states; the path is real, so the
 * citation grounded. A citation list that also names a supporting guide has
 * already lost the workflow (`withUnsupportedReviewRequirementsMarked`).
 */
export function withoutWorkflowCitations(line: string): string {
	return withoutSentences(line, (sentence) => WORKFLOW_PATH_RE.test(sentence));
}

const PRELOAD_CLAIM_RE = /\bpre-?load(?:s|ed|ing)?\b/i;
const MODULE_FILE_RE = /\.(?:[cm]?[jt]s|tsx|jsx)$/;
const SHELL_SYNTAX_RE = /[;&|<>`$(){}\n'"\\]/;
const NODE_PRELOAD_FLAGS = new Set(["--import", "--require", "-r", "--loader", "--experimental-loader"]);
/** Options without a value that leave Node running the program after its preloads. */
const NODE_RUNNING_FLAGS = new Set(["--test", "--watch", "--enable-source-maps", "--no-warnings", "--trace-warnings"]);
/** Options with an inline value that leave Node running the program, and the values each accepts. */
const NODE_RUNNING_VALUED_FLAGS = new Map([["--test-concurrency", /^[1-9]\d*$/]]);

/**
 * What a package script makes Node preload and run, read only from a plain
 * `node` command whose preload flags precede the program. Shell syntax (an
 * `echo`, a `cd` before the command, a chain) and flags after the program,
 * which become the program's own arguments, prove nothing. So does any option
 * not known to leave Node running the program: a non-executing mode such as
 * `--check`, an unknown flag, or an invalid value such as
 * `--disable-proto=invalid`, on which Node exits before it preloads anything.
 */
function plainNodeLaunch(script: string, dir: string): { preloads: string[]; program: string | null } | null {
	if (SHELL_SYNTAX_RE.test(script)) return null;
	const words = script.trim().split(/\s+/);
	if (words[0] !== "node") return null;
	const preloads: string[] = [];
	for (let index = 1; index < words.length; index++) {
		const word = words[index] ?? "";
		if (word === "--") {
			const program = words[index + 1];
			return { preloads, program: program === undefined ? null : posix.join(dir, program) };
		}
		if (!word.startsWith("-")) return { preloads, program: posix.join(dir, word) };
		const equals = word.indexOf("=");
		const flag = equals === -1 ? word : word.slice(0, equals);
		const inline = equals === -1 ? undefined : word.slice(equals + 1);
		if (NODE_PRELOAD_FLAGS.has(flag)) {
			const value = inline ?? words[++index];
			if (!value || value.startsWith("-")) return null;
			preloads.push(posix.join(dir, value));
			continue;
		}
		const runs = inline === undefined ? NODE_RUNNING_FLAGS.has(flag) : NODE_RUNNING_VALUED_FLAGS.get(flag)?.test(inline);
		if (!runs) return null;
	}
	return { preloads, program: null };
}

/**
 * Mark a module a line calls preloaded that no package script preloads. A
 * generated handbook called both `tests/harness/tmp-root.ts` and
 * `tests/harness/scratch-env.ts` preloaded; `test:file` preloads only the first,
 * and tests import the second's helpers. Scripts of every visible package.json
 * count, resolved from that package's directory, so a workspace app's own
 * preload is supported. Only a plain `node` command counts (`plainNodeLaunch`);
 * anything less certain marks the claim. The program such a script runs, such
 * as a test runner, is the launcher, not a claimed preload.
 */
function withUnsupportedPreloadsMarked(line: string, evidence: ModelGroundingCorpus): string {
	if (!PRELOAD_CLAIM_RE.test(line)) return line;
	// fileText is lowercased, so every comparison here is.
	const preloaded = new Set<string>();
	const launchers = new Set<string>();
	const scriptTexts: string[] = [];
	const addPreloads = (dir: string, script: string): void => {
		scriptTexts.push(script.toLowerCase());
		const launch = plainNodeLaunch(script, dir);
		if (!launch) return;
		for (const path of launch.preloads) preloaded.add(path.toLowerCase());
		if (launch.program) launchers.add(launch.program.toLowerCase());
	};
	for (const script of evidence.scriptBodies.values()) addPreloads("", script);
	for (const path of evidence.repositoryPaths) {
		if (!path.endsWith("/package.json")) continue;
		try {
			const scripts = (JSON.parse(evidence.fileText(path) ?? "{}") as { scripts?: unknown }).scripts;
			if (!scripts || typeof scripts !== "object") continue;
			for (const script of Object.values(scripts))
				if (typeof script === "string") addPreloads(posix.dirname(path), script);
		} catch {
			// An unparsable manifest preloads nothing.
		}
	}
	const missingPreloads = (cited: string[]): string[] =>
		cited.filter(
			(path) => MODULE_FILE_RE.test(path) && !preloaded.has(path.toLowerCase()) && !launchers.has(path.toLowerCase()),
		);
	// A module no script text names, and that launches nothing itself, is verified absent: the claim is
	// dropped, not marked. A cited launcher such as a spawn script may preload in its own code.
	const namedByNoScript = (path: string): boolean => {
		const lower = path.toLowerCase();
		if (/--(?:import|require|loader)\b|preload/.test(evidence.fileText(path) ?? "--import")) return false;
		return !scriptTexts.some((text) => text.includes(lower) || text.includes(posix.basename(lower)));
	};
	return withUnsupportedClaimsMarked(
		line,
		PRELOAD_CLAIM_RE,
		(cited) => {
			const missing = missingPreloads(cited);
			if (missing.length === 0) return null;
			return `${missing.map((path) => `\`${path}\``).join(", ")} ${missing.length === 1 ? "is" : "are"} not preloaded by a package script`;
		},
		{ refuted: (cited) => scriptTexts.length > 0 && missingPreloads(cited).every(namedByNoScript) },
	);
}

/**
 * Keep a Scout line only when it cites the repository and every citation is real.
 *
 * This used to require the line to be a verbatim member of the sibling-file
 * corpus, which made Scout a copier rather than a reader: in a repository with no
 * sibling agent-context files, and that is exactly the repository `context init`
 * exists for, the corpus held only paths and symbol names, so no sentence could
 * ever match and the model's entire contribution was deleted by construction.
 *
 * The replacement rule is one sentence and strictly more general than the term
 * blacklist it also replaces: a line must contain at least one backticked token,
 * and every backticked token must name a real indexed path, symbol, script, or
 * a string that occurs in the supplied evidence. "A dedicated team owns every
 * change" cites nothing and is dropped. "`src/commands.ts` owns argv parsing and
 * the help text" names a file that exists and survives. An invented command like
 * `npm publish` in a repository with no publish script is dropped even though the
 * rest of the sentence is unremarkable, which was the real failure mode.
 */
export function groundedModelBody(body: string, evidence: ModelGroundingCorpus): string {
	const maxChars = MODEL_SECTION_MAX_CHARS;
	const kept: string[] = [];
	let inFence = false;
	for (const rawLine of body.split(/\r?\n/)) {
		const trimmed = rawLine.trim();
		if (trimmed.startsWith("```")) {
			inFence = !inFence;
			continue;
		}
		if (trimmed.length === 0 || /^#{1,6}\s|^---+$/.test(trimmed)) continue;
		// A fenced command block is the single highest-value thing Scout can return,
		// and dropping the fence used to drop the commands with it. Inline the line
		// instead, so it faces the same citation rule as any other line.
		// Keep a nested bullet's indentation; flattening it turned a recipe's
		// sub-steps into unrelated top-level rules.
		const indent = inFence ? "" : (/^(\s*)[-*+]\s/.exec(rawLine)?.[1] ?? "").replace(/\t/g, "  ");
		const cited = correctSymbolAttributions(
			wrapBareCitations(inFence ? `\`${trimmed.replace(/`/g, "")}\`` : `${indent}${trimmed}`, evidence),
			evidence,
		);
		const marked = withUnsupportedReviewRequirementsMarked(cited, evidence);
		const line = withoutWorkflowCitations(
			inFence ? cited : withUnsupportedPreloadsMarked(withoutCiStatements(marked), evidence),
		);
		if (!line) continue;
		const codeTokens = [...line.matchAll(CODE_TOKEN_RE)]
			.map((match) => match[1]?.trim())
			.filter((token): token is string => token !== undefined && token.length > 0);
		if (codeTokens.length === 0) continue;
		// Five of six models broadened test's four explicit smoke files to test:full's glob.
		// Judge a single named script against its own body, rather than the repository-wide corpus.
		const invokedScripts = new Set(
			codeTokens.flatMap((token) => {
				const words = token.split(/\s+/);
				const name = words[1] === "run" && words.length === 3 ? words[2] : words.length === 2 ? words[1] : undefined;
				return words[0] === evidence.packageManager && name !== undefined && evidence.scriptBodies.has(name) ? [name] : [];
			}),
		);
		if (invokedScripts.size === 1) {
			const command = evidence.scriptBodies.get([...invokedScripts][0] ?? "") ?? "";
			if (codeTokens.some((token) => /[*?]/.test(token) && !command.includes(token))) continue;
		}
		if (!codeTokens.every((token) => groundedToken(token, evidence))) continue;
		// The verification section already carries every declared script exactly.
		// A rule that quotes a script body restates the manifest, and a small model
		// copying a long one cut it short and then guessed at what the cut hid.
		const collapsed = line.replace(/\s+/g, " ");
		if (!inFence && evidence.scriptRecitals.some((recital) => collapsed.includes(recital))) continue;
		if (line.replace(CODE_TOKEN_RE, "").trim().length === 0 && !inFence) continue;
		kept.push(line);
	}
	const bounded: string[] = [];
	let length = 0;
	for (const line of kept) {
		const nextLength = length + (bounded.length > 0 ? 1 : 0) + line.length;
		if (nextLength > maxChars) break;
		bounded.push(line);
		length = nextLength;
	}
	return bounded.join("\n").trim();
}

/**
 * A grounded model section may use the whole per-section budget the parser
 * allows. At 1200 characters a recipe section was cut after two bullets.
 */
const MODEL_SECTION_MAX_CHARS = HANDBOOK_TARGETS.sectionChars;

/** One model-written rule line, kept only when it passes the citation rule whole. */
export function groundedModelLine(line: string, evidence: ModelGroundingCorpus | null): string | null {
	const trimmed = line.replace(/\s+/g, " ").trim();
	if (trimmed.length === 0) return null;
	if (!evidence) return trimmed;
	return groundedModelBody(trimmed, evidence) || null;
}

export function sanitizeModelSection(
	section: PancodeMdSection,
	evidence: ModelGroundingCorpus,
): PancodeMdSection | null {
	const body = groundedModelBody(section.body, evidence);
	if (body.length < 40) return null;
	const title = section.title.replace(/\s+/g, " ").trim();
	return title.length > 0 ? { title, body } : null;
}

/**
 * Why a rule's citations fail against the tree, or null when it cites nothing
 * or every concrete file it names exists and its text survives grounding.
 */
export function staleCitationReason(line: string, corpus: ModelGroundingCorpus): string | null {
	const cited = [...line.matchAll(CODE_TOKEN_RE)].filter((match) => match[1]);
	if (cited.length === 0) return null;
	// A citation the rule forbids bringing in is expected to be absent.
	const unforbidden = cited.filter((match) => !forbidsCitation(line, match.index));
	if (unforbidden.length === 0) return null;
	const citations = unforbidden.map((match) => match[1] ?? "");
	const missing = citations.filter((token) => !groundedToken(token, corpus));
	if (missing.length === 0 && unforbidden.length < cited.length) return null;
	const missingFile = missing.some((token) => CONCRETE_FILE_RE.test(citedPath(token)));
	if (!missingFile && groundedModelBody(line, corpus).length > 0) return null;
	return missing.length > 0
		? `does not resolve in this tree: ${missing.join(", ")}`
		: "its citations do not pass the citation rule";
}
