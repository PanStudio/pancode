// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import path from "node:path";
import { basenameToken, commandTokenIndex } from "./command-token.js";
import { collectScriptWriteTargets } from "./read-only-steps.js";
import type { ShellToken } from "./shell-scan.js";
import { SHELL_WRITE_REDIRECTIONS } from "./shell-scan.js";
import { pathArgs } from "./validation-check-match.js";

const STANDARD_DEV_TARGETS = new Set(["/dev/null", "/dev/stdout", "/dev/stderr", "/dev/tty", "/dev/zero"]);

export function collectRedirectTargets(segment: ReadonlyArray<ShellToken>, out: string[]): void {
	for (let index = 0; index < segment.length - 1; index += 1) {
		const target = redirectWriteTarget(segment[index], segment[index + 1]);
		if (target !== null) out.push(target);
	}
}

export function redirectWriteTarget(operator: ShellToken | undefined, target: ShellToken | undefined): string | null {
	if (!operator?.operator || target === undefined || target.operator || !SHELL_WRITE_REDIRECTIONS.has(operator.value))
		return null;
	// >& duplicates or closes a descriptor when its operand is a number or -;
	// Bash also accepts a filename here, redirecting stdout and stderr to it.
	if (operator.value === ">&" && /^(?:\d+-?|-)$/u.test(target.value)) return null;
	return target.value;
}

export function collectInvokedWriteTargets(segment: ReadonlyArray<string>, out: string[]): void {
	const cmdIndex = commandTokenIndex(segment);
	if (cmdIndex === null) return;
	const executable = basenameToken(segment[cmdIndex]);
	if (executable === "tee") {
		for (const arg of pathArgs(segment, cmdIndex)) out.push(arg);
		return;
	}
	// mkdir and touch create filesystem entries at every path operand. The
	// recorded workspace escape (`mkdir -p /abs/outside && cd ...` in the
	// skill-mastery app-idea battery) rode exactly this blind spot: redirects
	// and tee were classified, directory creation was not.
	if (executable === "mkdir" || executable === "touch") {
		for (const arg of pathArgs(segment, cmdIndex)) out.push(arg);
		return;
	}
	if (executable === "ln") {
		const args = pathArgs(segment, cmdIndex);
		const destination = args.at(-1);
		if (args.length >= 2 && destination !== undefined) out.push(destination);
		return;
	}
	if (executable === "cp" || executable === "mv" || executable === "install") {
		const args = pathArgs(segment, cmdIndex);
		const targetDir = targetDirectoryOption(segment, cmdIndex);
		if (targetDir !== null) {
			out.push(targetDir);
			for (const source of args) {
				if (source !== targetDir) out.push(path.posix.join(targetDir, path.posix.basename(source)));
			}
			return;
		}
		const destination = args.at(-1);
		if (args.length >= 2 && destination !== undefined) out.push(destination);
		return;
	}
	if (executable === "dd") {
		for (const arg of segment.slice(cmdIndex + 1)) {
			if (arg.startsWith("of=") && arg.length > 3) out.push(arg.slice(3));
		}
	}
}

/** The directory of `-t DIR`, `-tDIR` or `--target-directory[=]DIR`, when the command names one. */
function targetDirectoryOption(segment: ReadonlyArray<string>, commandIndex: number): string | null {
	for (let index = commandIndex + 1; index < segment.length; index += 1) {
		const token = segment[index];
		if (token === undefined) continue;
		if (token === "--") break;
		if (token === "-t" || token === "--target-directory") return segment[index + 1] ?? null;
		if (token.startsWith("--target-directory=")) return token.slice("--target-directory=".length);
		if (/^-[^-]*t/u.test(token)) {
			const rest = token.slice(token.indexOf("t") + 1);
			return rest.length > 0 ? rest : (segment[index + 1] ?? null);
		}
	}
	return null;
}

/**
 * In-place stream-editor writes: `sed -i` (GNU `-iSUFFIX` / `--in-place` and
 * BSD `-i ''` forms) rewrites its file operands in place, which the redirect and
 * tee/cp/mv detectors miss. Weak models reach for `sed -i` constantly, so
 * recognizing it here lets both the classifier and the finish-contract treat it
 * as the write it is. The sed script operand is dropped (it is not a file), so
 * an address-form script such as `/pat/d` cannot be mistaken for an out-of-cwd
 * write target.
 */
export function collectInPlaceEditTargets(segment: ReadonlyArray<string>, out: string[]): void {
	const cmdIndex = commandTokenIndex(segment);
	if (cmdIndex === null) return;
	collectScriptWriteTargets(basenameToken(segment[cmdIndex]), segment.slice(cmdIndex + 1), out);
	if (basenameToken(segment[cmdIndex]) !== "sed") return;
	if (!hasSedInPlaceFlag(segment, cmdIndex)) return;
	for (const operand of sedFileOperands(segment, cmdIndex)) out.push(operand);
}

export function hasSedInPlaceFlag(segment: ReadonlyArray<string>, cmdIndex: number): boolean {
	for (let index = cmdIndex + 1; index < segment.length; index += 1) {
		const token = segment[index];
		if (token === undefined) continue;
		if (token === "--") break;
		if (token === "--in-place" || token.startsWith("--in-place=")) return true;
		if (token.startsWith("--")) continue;
		// A short-option cluster carrying `i` (`-i`, `-i.bak`, `-ni`) requests
		// in-place editing; sed's other short flags (`-n`, `-e`, `-r`, ...) do not.
		if (token.startsWith("-") && token.length > 1 && token.slice(1).includes("i")) return true;
	}
	return false;
}

/**
 * File operands of a sed invocation, with the inline script dropped. `-e`/`-f`/
 * `--expression`/`--file` supply the script explicitly, so when one is present
 * every bare operand is a file; otherwise the first bare operand is the script.
 */
export function sedFileOperands(segment: ReadonlyArray<string>, cmdIndex: number): string[] {
	const operands: string[] = [];
	let sawScriptFlag = false;
	let endOfOptions = false;
	for (let index = cmdIndex + 1; index < segment.length; index += 1) {
		const token = segment[index];
		if (token === undefined) continue;
		if (!endOfOptions && token === "--") {
			endOfOptions = true;
			continue;
		}
		if (!endOfOptions && token.startsWith("-") && token.length > 1) {
			if (token === "-e" || token === "-f") {
				sawScriptFlag = true;
				index += 1;
				continue;
			}
			if (token === "-l") {
				index += 1;
				continue;
			}
			if (token === "--expression" || token === "--file") {
				sawScriptFlag = true;
				index += 1;
				continue;
			}
			if (token.startsWith("--expression=") || token.startsWith("--file=")) {
				sawScriptFlag = true;
				continue;
			}
			continue;
		}
		operands.push(token);
	}
	if (!sawScriptFlag && operands.length > 0) operands.shift();
	return operands;
}

export function isInterestingWriteTarget(target: string): boolean {
	if (target.length === 0) return false;
	if (STANDARD_DEV_TARGETS.has(target)) return false;
	if (target.startsWith("/dev/fd/")) return false;
	return true;
}
