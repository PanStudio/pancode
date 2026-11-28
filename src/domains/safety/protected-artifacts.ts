// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import path from "node:path";
import { artifactDefaultPath } from "../../core/artifact-paths.js";
import { isSameOrDescendant } from "../../core/path-containment.js";
import type { ProtectedArtifactSource } from "../../core/telemetry/session-vocabulary.js";
import { ToolNames } from "../../core/tool-names.js";
import { checkWordOf } from "./check-prefix.js";
import { basenameToken, commandTokenIndex } from "./command-token.js";
import {
	classifyFindDelete,
	classifyGitOperation,
	classifyPathOperation,
	classifyRedirect,
	compareStrings,
	normalizePathKey,
	pipedOnward,
	resetShapeHolds,
	stepOnlyReads,
} from "./destructive-operations.js";
import { heredocDataText } from "./heredoc-data.js";
import { heredocInertRedirectTokens } from "./heredoc-scan.js";
import { commandSteps } from "./shell-command-verdict.js";
import { cachedShellScan, scanShellLike, shellCommandArguments, splitSegments } from "./shell-scan.js";
import { substitutionSegments } from "./shell-segments.js";
import type { PackageManager } from "./validation-check-match.js";
import {
	groundingMatch,
	outputFlagWidth,
	packageScriptRun,
	packageSelectors,
	pathArgs,
	validationMatch,
} from "./validation-check-match.js";

export interface ProtectedArtifact {
	path: string;
	protectedAt: string;
	reason: string;
	validationCommand?: string;
	validationExitCode?: number;
	source: ProtectedArtifactSource;
}

export interface ProtectedArtifactState {
	artifacts: ProtectedArtifact[];
}

export type DestructiveCommandOperation =
	| "rm"
	| "mv"
	| "truncate"
	| "redirect"
	| "cp"
	| "git_checkout"
	| "git_restore"
	| "git_reset_hard"
	| "git_clean"
	| "find_delete";

export interface ProtectedArtifactCommandMatch {
	artifactPath: string;
	commandPath: string;
	reason: string;
}

export type DestructiveCommandClassification =
	| { kind: "benign"; matches: [] }
	| {
			kind: "destructive";
			operation: DestructiveCommandOperation;
			matches: ProtectedArtifactCommandMatch[];
	  };

export type ValidationCommandDetection = { kind: "validation"; matched: string } | { kind: "none" };

/**
 * Which vocabulary of checking commands a caller wants recognized.
 *
 * `finish-contract` is the strict set: commands that assert something about
 * correctness and fail loudly when it does not hold. It is the default because
 * the consumers that spend it are gates. The finish contract counts a match as
 * a validating turn, and the mutation-report validator counts one as the
 * difference between `pass` and `unmeasured`. A turn whose only command was
 * `git diff` has validated nothing, so admitting read-verification here would
 * hand both gates a way to be satisfied by inspection alone.
 *
 * `grounding` is the wider set: everything strict plus the read-verification
 * and ad-hoc shapes agents actually reach for (`git diff`, `node -e`,
 * `npx vitest`, `tsc --noEmit`). Its consumer, dispatch validation grounding,
 * spends a match on nothing. An unmatched claim there is reported and never
 * downgrades a quality label, so the cost of a miss is noise in the receipt
 * rather than a gate opening. Commands such as `git diff` and
 * `node -e "import(...)"` can ground inspection claims even when they do not
 * satisfy the strict validation vocabulary.
 */
export type ValidationCommandScope = "finish-contract" | "grounding";

export interface NormalizedArtifact {
	key: string;
	artifact: ProtectedArtifact;
}

/**
 * Paths a tool call would mutate, derived from the tool's path arguments:
 * write/edit's path, or every entry of `paths` (the form an ACP call that
 * names several targets maps to), and the artifact writers' defaults. Bash
 * mutation targets are handled separately through command classification.
 */
export function toolMutationPaths(toolName: string, args: Record<string, unknown> | undefined): string[] {
	if (toolName === ToolNames.Artifact) {
		return [mutationPathArg(args) ?? artifactDefaultPath(args?.kind)];
	}
	if (toolName === ToolNames.Write || toolName === ToolNames.Edit) {
		const candidate = mutationPathArg(args);
		const many = Array.isArray(args?.paths)
			? args.paths.filter((path): path is string => typeof path === "string" && path.length > 0)
			: [];
		return [...(candidate === null ? [] : [candidate]), ...many.filter((path) => path !== candidate)];
	}
	return [];
}

/**
 * Shared protected-artifact decision used by both the orchestrator middleware
 * guard and mediated worker runtimes. Keeping target extraction and bash
 * classification in one function prevents a dispatched worker from applying
 * a weaker interpretation of the same frozen protection state.
 */
export function protectedArtifactMutationBlockReason(
	state: ProtectedArtifactState,
	toolName: string,
	args: Record<string, unknown> | undefined,
): string | null {
	if (state.artifacts.length === 0) return null;
	for (const candidate of toolMutationPaths(toolName, args)) {
		if (isProtectedPath(state, candidate)) {
			return `protected artifact blocked: ${toolName} would modify protected path ${candidate}`;
		}
	}
	if (toolName !== ToolNames.Bash) return null;
	const command = typeof args?.command === "string" && args.command.length > 0 ? args.command : null;
	if (command === null) return null;
	const classification = classifyDestructiveCommand(command, state.artifacts, callRunsElsewhere(args?.cwd));
	if (classification.kind === "benign") return null;
	const affected = classification.matches.map((match) => match.artifactPath).join(", ");
	return `protected artifact blocked: ${classification.operation} would affect ${affected}`;
}

function mutationPathArg(args: Record<string, unknown> | undefined): string | null {
	if (!args) return null;
	const candidate = args.path ?? args.file_path ?? args.filePath;
	return typeof candidate === "string" && candidate.length > 0 ? candidate : null;
}

export function protectArtifact(state: ProtectedArtifactState, artifact: ProtectedArtifact): ProtectedArtifactState {
	const artifacts = artifactMap(state.artifacts);
	const key = normalizePathKey(artifact.path);
	if (key !== null) artifacts.set(key, cloneArtifact(artifact));
	return stateFromMap(artifacts);
}

function isProtectedPath(state: ProtectedArtifactState, artifactPath: string): boolean {
	const candidate = normalizePathKey(artifactPath);
	if (candidate === null) return false;
	for (const artifact of normalizedArtifacts(state.artifacts)) {
		if (isSameOrDescendant(candidate, artifact.key, path.posix)) return true;
	}
	return false;
}

/**
 * Whether a bash call's own `cwd` puts the shell somewhere other than the directory relative command paths are
 * judged from: then a path the command names lands elsewhere, as after a cd (M-27).
 */
function callRunsElsewhere(cwd: unknown): boolean {
	if (typeof cwd !== "string" || cwd.length === 0) return false;
	const here = normalizePathKey(process.cwd());
	return here === null || normalizePathKey(cwd) !== here;
}

function classifyDestructiveCommand(
	command: string,
	protectedArtifacts: ReadonlyArray<ProtectedArtifact>,
	runsElsewhere = false,
): DestructiveCommandClassification {
	const artifacts = normalizedArtifacts(protectedArtifacts);
	if (artifacts.length === 0) return { kind: "benign", matches: [] };

	// C-7: a here-document the parsed call proves is data is content, not shell text (row 287).
	const text = heredocDataText(command) ?? command;
	const scanned = scanShellLike(text);
	const segments = splitSegments(scanned).flatMap((tokens) => [tokens, ...substitutionSegments(tokens, 0)]);
	// FX-1: a `>` in a here-document body is input text, not a redirect, unless a shell may still read that body.
	const inert = heredocInertRedirectTokens(text);
	const redirectSegments =
		inert === null ? null : splitSegments(inert).flatMap((tokens) => [tokens, ...substitutionSegments(tokens, 0)]);
	// M-27: a hard reset is judged by what it rewrites only while every step before it leaves git's state alone.
	let priorReads = resetShapeHolds(text, scanned);
	let moved = runsElsewhere;
	for (const tokens of segments) {
		const segment = shellCommandArguments(tokens);
		if (redirectSegments === null) {
			const redirect = classifyRedirect(tokens, artifacts);
			if (redirect.kind === "destructive") return redirect;
		}

		const commandIndex = commandTokenIndex(segment);
		const reading = { precise: priorReads && !pipedOnward(scanned, tokens), moved };
		priorReads &&= stepOnlyReads(tokens, segment, commandIndex);
		if (commandIndex === null) continue;
		const executable = basenameToken(segment[commandIndex]);
		if (executable === "cd" || executable === "pushd" || executable === "popd") moved = true;
		if (executable === "rm") {
			const result = classifyPathOperation(
				"rm",
				"rm can remove protected artifacts",
				pathArgs(segment, commandIndex),
				artifacts,
			);
			if (result.kind === "destructive") return result;
			continue;
		}
		if (executable === "mv") {
			const result = classifyPathOperation(
				"mv",
				"mv can move or overwrite protected artifacts",
				pathArgs(segment, commandIndex),
				artifacts,
			);
			if (result.kind === "destructive") return result;
			continue;
		}
		if (executable === "truncate") {
			const result = classifyPathOperation(
				"truncate",
				"truncate can overwrite protected artifacts",
				pathArgs(segment, commandIndex),
				artifacts,
			);
			if (result.kind === "destructive") return result;
			continue;
		}
		if (executable === "cp") {
			const args = pathArgs(segment, commandIndex);
			const destination = args.at(-1);
			const result = classifyPathOperation(
				"cp",
				"cp can overwrite protected artifacts",
				destination === undefined ? [] : [destination],
				artifacts,
			);
			if (result.kind === "destructive") return result;
			continue;
		}
		if (executable === "git") {
			const result = classifyGitOperation(segment.slice(commandIndex + 1), artifacts, {
				...reading,
				precise: reading.precise && commandIndex === 0 && segment[0] === "git",
			});
			if (result.kind === "destructive") return result;
			continue;
		}
		if (executable === "find") {
			const result = classifyFindDelete(segment.slice(commandIndex + 1), artifacts);
			if (result.kind === "destructive") return result;
		}
	}
	for (const tokens of redirectSegments ?? []) {
		const redirect = classifyRedirect(tokens, artifacts);
		if (redirect.kind === "destructive") return redirect;
	}

	return { kind: "benign", matches: [] };
}

export function detectValidationCommand(
	command: string,
	scope: ValidationCommandScope = "finish-contract",
): ValidationCommandDetection {
	for (const tokens of splitSegments(scanShellLike(command, true))) {
		const segment = shellCommandArguments(tokens);
		const matchAt = (executable: string, args: ReadonlyArray<string>) =>
			validationMatch(executable, args) ?? (scope === "grounding" ? groundingMatch(executable, args) : null);
		// A built-in prefix or a declared wrapper (`scripts/test-slot.sh pnpm test`) is read through to the check it runs;
		// the whole command's exit still settles it (FX-44).
		const commandIndex = checkWordOf(segment, (executable, args) => matchAt(executable, args) !== null).index;
		if (commandIndex === null) continue;
		const matched = matchAt(basenameToken(segment[commandIndex]), segment.slice(commandIndex + 1));
		if (matched !== null) return { kind: "validation", matched };
	}
	return { kind: "none" };
}

/**
 * The command's single-line form: a backslash-newline is a line continuation, not a separator, so
 * `npm test \<newline>  -- -x` is `npm test -- -x` (x7-4). A here-document body is data the shell does not join here,
 * so it stays as written, terminator line included (S2).
 */
export function joinLineContinuations(command: string): string {
	const join = (text: string) =>
		text.replace(/([ \t]*)(?<=(?:^|[^\\])(?:\\\\)*)\\\n([ \t]*)/gu, (_, before: string, after: string) =>
			before.length > 0 || after.length > 0 ? " " : "",
		);
	let joined = "";
	let cursor = 0;
	for (const body of cachedShellScan(command, true).bodies) {
		joined += `${join(command.slice(cursor, body.start))}${command.slice(body.start, body.end)}`;
		cursor = body.end;
	}
	return `${joined}${join(command.slice(cursor))}`;
}

/**
 * The name an observed check's outcome is filed under: the command with trailing output plumbing (`2>&1`, `| tail`,
 * `| head`, `| tee log`, `> log`) removed, so `make test 2>&1 | tail -5` and `make test` settle each other. Under `pipefail` a pipeline exits
 * 0 only when the check did, so a green settles the name however it was piped; `head` can turn a green into a red
 * (SIGPIPE), so a red behind it lands nowhere ({@link checkFailureAttributable}). Tools and arguments stay distinct, so
 * `pytest` never settles `pytest -q` (bt-27).
 */
export function observedValidationCommand(command: string): string {
	let current = joinLineContinuations(command).trim();
	for (;;) {
		const next = current
			.replace(/\s*\|&?\s*(?:tail|head|tee)(?:\s+[^|;&<>]*)?$/u, "")
			.replace(/\s+2>&1$/u, "")
			.replace(/\s+(?:[0-9]?>>?|&>>?)\s*[^\s|;&<>"']+$/u, "")
			.trim();
		if (next === current) return current;
		current = next;
	}
}

/** npm's own abbreviations of `test` and `run`. */
const NPM_COMMAND_ALIASES: ReadonlyMap<string, string> = new Map([
	["t", "test"],
	["tst", "test"],
	["run-script", "run"],
	["rum", "run"],
	["urn", "run"],
]);

/**
 * The check an observed name ({@link observedValidationCommand}) runs, so respellings of one check settle each other
 * while each outcome keeps the name it was filed under (SF-2). One literal step is read past `time` and the transparent
 * wrappers (`timeout 300 npm test` is `npm test`), and an npm, pnpm or yarn script run as `<pm> [selectors] run
 * <script> [args]`, so `npm test`, `npm t` and `npm run test` are one check. Anything else is its own text: arguments,
 * environment prefixes and tools stay distinct, so `pytest` never settles `pytest -q` (bt-27).
 */
export function checkIdentity(name: string): string {
	const steps = commandSteps(name);
	const [step] = steps;
	if (steps.length !== 1 || step === undefined || !step.literal || step.grouped) return `text:${name}`;
	const [executable = "", first, ...rest] = step.argv.slice(step.command);
	const args = first === undefined ? [] : [(executable === "npm" && NPM_COMMAND_ALIASES.get(first)) || first, ...rest];
	const run =
		executable === "npm" || executable === "pnpm" || executable === "yarn" ? packageScriptRun(executable, args) : null;
	const argv =
		run !== null
			? [executable, ...run.selectors, "run", run.script, ...run.forwarded]
			: executable === "npm" || executable === "pnpm" || executable === "yarn"
				? [executable, ...withoutLeadingOutputFlags(executable, args)]
				: [executable, ...args];
	return `argv:${JSON.stringify(argv)}`;
}

/** A package manager's words with its output-only flags before the command removed (`pnpm -s exec x` is `pnpm exec x`). */
function withoutLeadingOutputFlags(executable: PackageManager, args: ReadonlyArray<string>): string[] {
	const end = packageSelectors(executable, args)?.index ?? 0;
	const kept: string[] = [];
	for (let index = 0; index < end; ) {
		const width = outputFlagWidth(args, index);
		if (width === 0) kept.push(args[index] as string);
		index += Math.max(width, 1);
	}
	return [...kept, ...args.slice(end)];
}

function artifactMap(artifacts: ReadonlyArray<ProtectedArtifact>): Map<string, ProtectedArtifact> {
	const out = new Map<string, ProtectedArtifact>();
	for (const artifact of artifacts) {
		const key = normalizePathKey(artifact.path);
		if (key !== null) out.set(key, cloneArtifact(artifact));
	}
	return out;
}

function stateFromMap(artifacts: ReadonlyMap<string, ProtectedArtifact>): ProtectedArtifactState {
	return {
		artifacts: Array.from(artifacts.entries())
			.sort(([left], [right]) => compareStrings(left, right))
			.map(([, artifact]) => cloneArtifact(artifact)),
	};
}

function normalizedArtifacts(artifacts: ReadonlyArray<ProtectedArtifact>): NormalizedArtifact[] {
	const out = Array.from(artifactMap(artifacts).entries()).map(([key, artifact]) => ({ key, artifact }));
	out.sort((left, right) => compareStrings(left.key, right.key));
	return out;
}

function cloneArtifact(artifact: ProtectedArtifact): ProtectedArtifact {
	const cloned: ProtectedArtifact = {
		path: artifact.path,
		protectedAt: artifact.protectedAt,
		reason: artifact.reason,
		source: artifact.source,
	};
	if (artifact.validationCommand !== undefined) cloned.validationCommand = artifact.validationCommand;
	if (artifact.validationExitCode !== undefined) cloned.validationExitCode = artifact.validationExitCode;
	return cloned;
}
