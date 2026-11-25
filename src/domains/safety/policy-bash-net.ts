// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { hidesShellContent } from "./policy-bash-paths.js";
import { hasCommandSubstitution, hasSequencingOperators, isUnderOrSame } from "./policy-call-args.js";
import { GIT_INSPECT_RULE_ID, isGitInspection, recognizeCommandChain } from "./policy-command-chain.js";
import {
	BASH_RECOGNIZED_FORM_HINT,
	BUILTIN_ALLOWLIST,
	MAKE_CLEAN_COMMAND,
	matchesRepositoryCommand,
	PROJECT_SCRIPT_COMMANDS,
	pythonRunnerBehindWorkspacePythonPath,
	rgConfigReasons,
	TEST_RUNNER_COMMANDS,
	VERSION_PROBE,
} from "./policy-command-tables.js";
import { matchingProjectCommand } from "./policy-damage-resort.js";
import { decodedAnsiCCommand, projectScriptPreview } from "./policy-damage-scans.js";
import type { SafetyPolicyDecision } from "./policy-engine.js";
import type { ReadScopeInputs } from "./policy-read-only-inspectors.js";
import type { LoadedProjectSafetyPolicy } from "./project-policy.js";
import { scanShellLike } from "./shell-scan.js";
import { bareInlineShellScript } from "./shell-segments.js";
import { commandArgumentSegments } from "./validation-check-match.js";

/**
 * Bash net evaluation (sd-01 §2.2). Net blocks: empty commands and cwd
 * escapes. Net confirms: project policy `requireConfirmation` and command
 * substitution (the content-hiding channel). Everything else passes with an
 * `execRecognition` tag: project policy commands and the built-in no-prompt
 * allowlist are recognized; arbitrary bash, including commands with
 * sequencing operators, is unrecognized and the autonomy mapping at the
 * admission seam decides whether it runs, asks, or is denied. A `contained`
 * command runs in the main-session sandbox (Phase 2c), which bounds what a
 * cwd outside the workspace, a variable, a script or a substitution could
 * reach, so none of those rails apply to it.
 */
export function evaluateBashPolicy(
	input: string | ReadonlyArray<string>,
	callCwd: string,
	workspaceRoot: string,
	posture: string | undefined,
	policy: LoadedProjectSafetyPolicy,
	readScope: ReadScopeInputs,
	contained: boolean,
	/** A write-confined worker sandbox: only the hidden-content ask yields to it (row 371). */
	hiddenContentContained = false,
): Omit<SafetyPolicyDecision, "classification" | "tool" | "actionClass" | "cwd" | "posture" | "command"> {
	// Catalog commands execute as argv, never as shell source. Only bare words
	// have an unambiguous representation in the canonical command matcher.
	// Keep whitespace, empty arguments, and shell syntax out of recognition;
	// joining them would erase argument boundaries or invent a shell chain.
	if (typeof input !== "string" && !input.every((arg) => /^[\w=./:-]+$/u.test(arg))) {
		return {
			kind: posture === "confirmed" || posture === "yolo" ? "allow" : "ask",
			ruleId: "verify-unrecognized-argv",
			reasonCode: "verify-unrecognized-argv",
			reasons: ["project verifier argv is outside the bare-word no-prompt command set"],
			policySource: "builtin-command-allowlist",
			execRecognition: "unrecognized",
		};
	}
	const command = typeof input === "string" ? input : input.join(" ");
	if (command.trim().length === 0) {
		return {
			kind: "block",
			ruleId: "bash-empty-command",
			reasonCode: "bash-empty-command",
			reasons: ["bash command must not be empty"],
			policySource: "builtin-command-allowlist",
		};
	}

	if (
		typeof input === "string" &&
		posture !== "confirmed" &&
		!contained &&
		!hiddenContentContained &&
		hidesShellContent(command, posture)
	) {
		return {
			kind: "ask",
			reasonCode: HIDDEN_CONTENT_RULE_ID,
			ruleId: HIDDEN_CONTENT_RULE_ID,
			reasons: [
				"shell variables, unparsed shell scripts or interpreter source hide which paths it touches from the safety net, so each such command needs your approval",
				// A loop over files was the common case in recorded Opus runs; one
				// command over literal operands does the same without the variable.
				...(/\bfor\s+[A-Za-z_]\w*\s+in\b/u.test(command)
					? [
							"Instead of a loop variable, pass the files as literal operands: `tail -n +1 a.js b.js` prints a header before each file.",
						]
					: []),
			],
			policySource: "builtin-command-allowlist",
			execRecognition: "unrecognized",
		};
	}
	const projectMatch = matchingProjectCommand(policy, command, callCwd);
	if (projectMatch) {
		const base: Omit<
			SafetyPolicyDecision,
			"kind" | "classification" | "tool" | "actionClass" | "cwd" | "posture" | "command"
		> = {
			ruleId: projectMatch.id,
			reasonCode: `project-policy:${projectMatch.id}`,
			reasons: [`allowed by project safety policy command '${projectMatch.id}'`],
			policySource: "project-policy" as const,
			execRecognition: "recognized",
		};
		if (policy.hash !== null) base.policyHash = policy.hash;
		if (policy.path !== null) base.projectPolicyPath = policy.path;
		if (projectMatch.requireConfirmation && posture !== "confirmed" && posture !== "yolo") {
			return {
				...base,
				kind: "ask",
				reasons: [...base.reasons, "project policy requires confirmation"],
			};
		}
		return { ...base, kind: "allow" };
	}
	// A contained command may run from a directory outside the workspace; the
	// sandbox bounds where it writes. Delete and write targets are still judged
	// from that cwd.
	if (!contained && !isUnderOrSame(callCwd, workspaceRoot)) {
		return {
			kind: "block",
			ruleId: "bash-cwd-escape",
			reasonCode: "bash-cwd-escape",
			reasons: [
				`bash cwd '${callCwd}' escapes workspace root '${workspaceRoot}'; use a typed tool or a project policy entry with explicit cwd`,
			],
			policySource: "builtin-command-allowlist",
		};
	}
	// Command substitution is the content-hiding channel: the net cannot scan
	// what `$(...)` or backticks produce at runtime, so default asks. A
	// confirmed one-shot grant or yolo posture admits it after the safety scan.
	// A command that is nothing but `sh -c '<script>'` is recognized by its
	// script. Recognition can only narrow this way: the script is what runs, and
	// judging the wrapper instead is what let the wrapper be a bypass. Only the
	// bare form qualifies; an env prefix, extra operand, redirect or startup
	// option would run beside the script unexamined, so that line is judged whole.
	const recognitionSource = bareInlineShellScript(command) ?? command;
	const recognitionCommand = decodedAnsiCCommand(recognitionSource) ?? recognitionSource;
	if (
		(hasCommandSubstitution(command) || hasCommandSubstitution(recognitionCommand)) &&
		posture !== "confirmed" &&
		posture !== "yolo" &&
		!contained
	) {
		return {
			kind: "ask",
			ruleId: "bash-command-substitution",
			reasonCode: "bash-command-substitution",
			reasons: [
				"command substitution hides what will actually run from the safety net, so each such command needs your approval",
			],
			policySource: "builtin-command-allowlist",
			execRecognition: "unrecognized",
		};
	}
	const testRunner =
		TEST_RUNNER_COMMANDS.find((entry) => entry.re.test(recognitionCommand)) ??
		pythonRunnerBehindWorkspacePythonPath(recognitionCommand);
	if (testRunner !== undefined) {
		return {
			kind: "allow",
			ruleId: testRunner.id,
			reasonCode: testRunner.id,
			reasons: [`matched built-in test runner '${testRunner.id}'`, projectScriptPreview(recognitionCommand, callCwd)],
			policySource: "builtin-command-allowlist",
			execRecognition: "recognized",
			runsWorkspaceCode: true,
		};
	}
	if (MAKE_CLEAN_COMMAND.re.test(recognitionCommand)) {
		return {
			kind: "allow",
			ruleId: MAKE_CLEAN_COMMAND.id,
			reasonCode: MAKE_CLEAN_COMMAND.id,
			reasons: [
				`matched built-in clean step '${MAKE_CLEAN_COMMAND.id}'`,
				projectScriptPreview(recognitionCommand, callCwd),
			],
			policySource: "builtin-command-allowlist",
			execRecognition: "recognized",
			runsWorkspaceCode: true,
		};
	}
	const projectScript = PROJECT_SCRIPT_COMMANDS.find((entry) => entry.re.test(recognitionCommand));
	if (projectScript !== undefined) {
		return {
			kind: "allow",
			reasonCode: "project-script-autonomy",
			ruleId: projectScript.id,
			reasons: [
				"Repository-authored validation code passed the safety checks; default asks for it unless a trusted safety command declaration approves it, and yolo runs it.",
				projectScriptPreview(recognitionCommand, callCwd),
			],
			policySource: "builtin-command-allowlist",
			execRecognition: "unrecognized",
		};
	}
	// Whitespace checking inspects the diff. Recognize only these standalone
	// spellings: keeping this outside
	// BUILTIN_ALLOWLIST prevents a new no-prompt path through && chains.
	if (/^git[ \t]+diff(?:[ \t]+--cached)?[ \t]+--check$/.test(recognitionCommand)) {
		return {
			kind: "allow",
			ruleId: "builtin:git-diff-check",
			reasonCode: "builtin:git-diff-check",
			reasons: ["matched built-in whitespace inspection 'builtin:git-diff-check'"],
			policySource: "builtin-command-allowlist",
			execRecognition: "recognized",
		};
	}
	if (VERSION_PROBE.test(recognitionCommand)) {
		return {
			kind: "allow",
			ruleId: "builtin:version-probe",
			reasonCode: "builtin:version-probe",
			reasons: ["matched built-in toolchain version probe 'builtin:version-probe'"],
			policySource: "builtin-command-allowlist",
			execRecognition: "recognized",
		};
	}
	const chain = recognizeCommandChain(recognitionCommand, callCwd, workspaceRoot, policy, readScope);
	if (chain !== null) {
		const chainReasons = [
			`every step of the command is recognized: ${chain.ruleIds.join(", ")}`,
			...chain.scriptPreviews,
		];
		const runsWorkspaceCode = chain.runsTestRunner ? { runsWorkspaceCode: true as const } : {};
		if (chain.requiresConfirmation && posture !== "confirmed" && posture !== "yolo") {
			return {
				kind: "ask",
				ruleId: "bash-recognized-chain",
				reasonCode: "bash-recognized-chain",
				reasons: [...chainReasons, "project policy requires confirmation for one step"],
				policySource: "builtin-command-allowlist",
				execRecognition: "recognized",
				...runsWorkspaceCode,
			};
		}
		return {
			kind: "allow",
			ruleId: "bash-recognized-chain",
			reasonCode: "bash-recognized-chain",
			reasons: chainReasons,
			policySource: "builtin-command-allowlist",
			execRecognition: chain.requiresAutonomyApproval ? "unrecognized" : "recognized",
			...runsWorkspaceCode,
		};
	}
	// Remaining sequencing operators (pipes, ;, redirects, and && chains with an
	// unrecognized member) defeat per-command recognition, so the command is
	// unrecognized by definition: the autonomy mapping asks in default,
	// runs in yolo, and is denied in a read-only run. The rule pack scanned
	// the full string, so a destructive verb behind an operator was caught before
	// this point.
	if (hasSequencingOperators(command)) {
		// Redirection syntax changes where output goes, not whether repository
		// code executes. Keep script previews even though autonomy admits the call.
		const scriptSegments = commandArgumentSegments(recognitionCommand)
			.map((args) => args.join(" "))
			.filter((part) => matchesRepositoryCommand(part));
		return {
			kind: "allow",
			ruleId: "bash-shell-operators",
			reasonCode: "bash-shell-operators",
			reasons: [
				"shell operators defeat per-command recognition; the autonomy level decides admission",
				...rgConfigReasons(recognitionCommand),
				...readScope.notes.slice(0, 1),
				BASH_RECOGNIZED_FORM_HINT,
				...scriptSegments.map((part) => projectScriptPreview(part, callCwd)),
			],
			policySource: "builtin-command-allowlist",
			execRecognition: "unrecognized",
		};
	}
	for (const entry of BUILTIN_ALLOWLIST) {
		if (entry.re.test(recognitionCommand)) {
			return {
				kind: "allow",
				ruleId: entry.id,
				reasonCode: entry.id,
				reasons: [`matched built-in no-prompt command allowlist '${entry.id}'`],
				policySource: "builtin-command-allowlist",
				execRecognition: "recognized",
			};
		}
	}
	const standaloneWords = scanShellLike(recognitionCommand);
	if (
		standaloneWords.every((word) => !word.operator) &&
		isGitInspection(standaloneWords, recognitionCommand, callCwd, workspaceRoot, readScope)
	) {
		return {
			kind: "allow",
			ruleId: GIT_INSPECT_RULE_ID,
			reasonCode: GIT_INSPECT_RULE_ID,
			reasons: ["the shared Git policy reads this plain git command as inspection only"],
			policySource: "builtin-command-allowlist",
			execRecognition: "recognized",
		};
	}
	return {
		kind: "allow",
		ruleId: "bash-unrecognized",
		reasonCode: "bash-unrecognized",
		reasons: [
			"bash command is outside the no-prompt set; the autonomy level decides admission",
			...rgConfigReasons(recognitionCommand),
			...readScope.notes.slice(0, 1),
			BASH_RECOGNIZED_FORM_HINT,
		],
		policySource: "builtin-command-allowlist",
		execRecognition: "unrecognized",
	};
}

/** Rule id of the ask for a command whose variables or interpreter source hide the paths it touches. */
export const HIDDEN_CONTENT_RULE_ID = "bash-hidden-content";
