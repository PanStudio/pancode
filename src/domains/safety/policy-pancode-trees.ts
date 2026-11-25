// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { homedir, userInfo } from "node:os";
import path from "node:path";
import { canonicalizePath } from "../../core/path-canonical.js";
import { isSameOrDescendant } from "../../core/path-containment.js";
import { resolvePancodeDirs } from "../../core/xdg.js";
import { extractCommandCdTargets, shellCommandSteps } from "./command-path-walks.js";
import { commandAssignments, setsVariablesAtRunTime } from "./command-pins.js";
import { PANCODE_OWNED_VARIABLE } from "./pancode-tree-floor.js";
import type { PathPolicyOperation } from "./path-policy.js";

/** PanCode's resolved config, data, state and cache trees, and the ways a command can spell them. */
export interface PancodeOwnedTrees {
	roots: ReadonlyArray<string>;
	spellings: ReadonlyArray<string>;
}

export function pancodeOwnedTrees(workspace: string): PancodeOwnedTrees {
	const dirs = resolvePancodeDirs();
	const roots = new Set<string>();
	const add = (dir: string) => {
		roots.add(path.resolve(dir));
		const canonical = canonicalizePath(dir);
		if (canonical !== null) roots.add(canonical);
	};
	const trees = [dirs.config, dirs.data, dirs.state, dirs.cache];
	for (const dir of trees) add(dir);
	// The PANCODE_HOME that holds these trees is PanCode's as a whole, so `cp -r x <home>/` lands in it (FX-8). Not
	// when it is the account's home, or holds the workspace, where it would claim every file the task edits.
	const pancodeHome = process.env.PANCODE_HOME?.trim();
	if (pancodeHome !== undefined && path.isAbsolute(pancodeHome)) {
		const resolvedHome = path.resolve(pancodeHome);
		if (
			path.dirname(resolvedHome) !== resolvedHome &&
			resolvedHome !== path.resolve(homedir()) &&
			!isSameOrDescendant(path.resolve(workspace), resolvedHome) &&
			trees.some((dir) => isSameOrDescendant(path.resolve(dir), resolvedHome))
		)
			add(resolvedHome);
	}
	const home = homedir();
	const spellings = new Set<string>(roots);
	for (const root of roots) {
		if (!isSameOrDescendant(root, home) || root === home) continue;
		const rest = root.slice(home.length);
		for (const prefix of ["~", "$HOME", `\${HOME}`]) spellings.add(`${prefix}${rest}`);
	}
	// `~name` is the account's passwd home whatever HOME holds.
	const account = accountHome();
	for (const root of roots) {
		if (account === null || !isSameOrDescendant(root, account.home) || root === account.home) continue;
		spellings.add(`~${account.name}${root.slice(account.home.length)}`);
	}
	return { roots: [...roots], spellings: [...spellings] };
}

/** Whether text spells one of PanCode's trees, with or without its quotes: a PanCode variable, a root, or a home-relative spelling. */
export function namesPancodeTree(text: string, trees: PancodeOwnedTrees): boolean {
	return [text, text.replace(/["'\\]/gu, "")].some(
		(form) =>
			PANCODE_OWNED_VARIABLE.test(form) ||
			[...trees.roots, ...trees.spellings].some((spelling) => form.includes(spelling)),
	);
}

/** A `$NAME` or `${NAME...}` reference to `name`. */
function referenceTo(name: string): RegExp {
	return new RegExp(`\\$\\{?${name}(?![A-Za-z0-9_])`, "u");
}

/**
 * Whether a write lands on a variable that may hold one of PanCode's trees where no pin placed it (the reading kept
 * `$NAME`): one the command assigns a value naming a tree, directly or through other assignments, however the shell
 * then splits or joins it; or, while the command's text names a tree, one a run-time assigner (`read`, `mapfile`,
 * `printf -v`, `eval`, `${NAME:=...}`) may set, which the command names bare as their operands are, or REPLY and
 * MAPFILE, which `read` and `mapfile` set unnamed.
 */
export function writesThroughPancodeVariable(
	command: string,
	targets: ReadonlyArray<{ path: string }>,
	trees: PancodeOwnedTrees,
): boolean {
	const referenced = new Set(
		targets.flatMap((target) => [...target.path.matchAll(/\$\{?([A-Za-z_]\w*)/gu)].map((match) => match[1] as string)),
	);
	// `$1`, `$@` and their kin hold what `set --` or a function call passes, which the command's text may name.
	if (targets.some((target) => /\$\{?[0-9@*]/u.test(target.path)) && namesPancodeTree(command, trees)) return true;
	if (referenced.size === 0) return false;
	const assignments = commandAssignments(command);
	const tainted = new Set<string>();
	for (let grew = true; grew; ) {
		grew = false;
		for (const { name, text } of assignments) {
			if (tainted.has(name)) continue;
			if (namesPancodeTree(text, trees) || [...tainted].some((held) => referenceTo(held).test(text))) {
				tainted.add(name);
				grew = true;
			}
		}
	}
	if ([...referenced].some((name) => tainted.has(name))) return true;
	if (!namesPancodeTree(command, trees) || !setsVariablesAtRunTime(command)) return false;
	const forms = [command, command.replace(/["'\\]/gu, "")];
	return [...referenced].some(
		(name) =>
			name === "REPLY" ||
			name === "MAPFILE" ||
			forms.some((form) => new RegExp(`(?<![\\w$]|\\$\\{)${name}(?!\\w)`, "u").test(form)),
	);
}

/**
 * The spellings a target takes once the command's own assignments stand in for its references, each value a name
 * holds in the order the assignments run (`A=$HOME`, `D=cli; D+=o`), so a path split over assignments the pins do not
 * read is judged whole. A value holding a substitution is not one the text fixes and stands in for nothing; a name the
 * command does not assign stays as written.
 */
export function assignedSpellings(command: string, target: string): string[] {
	if (!target.includes("$")) return [];
	const held = new Map<string, string[]>();
	for (const match of command.matchAll(/(?<![\w$])([A-Za-z_]\w*)(\+?)=([^\s;&|()<>]*)/gu)) {
		const [, name = "", append, raw = ""] = match;
		if (/\$\(|`/u.test(raw)) continue;
		const values = held.get(name) ?? [];
		const text = raw.replace(/["']/gu, "");
		values.push(append === "+" ? (values.at(-1) ?? "") + text : text);
		held.set(name, values);
	}
	if (held.size === 0) return [];
	const reference = /\$(?:\{([A-Za-z_]\w*)\}|([A-Za-z_]\w*)(?!\w))/gu;
	let forms = [target];
	for (let depth = 0; depth < 4; depth += 1) {
		const next = new Set<string>();
		for (const form of forms) {
			const found = [...form.matchAll(reference)].find((match) => held.has(match[1] ?? match[2] ?? ""));
			if (found === undefined) {
				next.add(form);
				continue;
			}
			const before = form.slice(0, found.index);
			const after = form.slice(found.index + found[0].length);
			for (const value of held.get(found[1] ?? found[2] ?? "") ?? []) next.add(`${before}${value}${after}`);
		}
		forms = [...next].slice(0, 64);
	}
	// A form is judged only when what is left unresolved is a leading reference the spellings know; another reference
	// would be read as a cwd-relative segment that a later `..` folds away.
	return forms.filter(
		(form) =>
			form !== target &&
			!/\$/u.test(form.replace(/^\$\{?(?:HOME|PANCODE_\w+|XDG_(?:CONFIG|DATA|STATE|CACHE)_HOME)(?![\w])\}?/u, "")),
	);
}

/** The account running PanCode and its passwd home, or null where the platform has none. */
function accountHome(): { name: string; home: string } | null {
	try {
		const info = userInfo();
		return { name: info.username, home: info.homedir };
	} catch {
		return null;
	}
}

/** `~name` for the account running PanCode is its passwd home, whatever HOME holds, as bash reads it. */
export function accountHomeExpanded(raw: string): string {
	const account = accountHome();
	if (account === null) return raw;
	const prefix = `~${account.name}`;
	return raw === prefix || raw.startsWith(`${prefix}/`) ? `${account.home}${raw.slice(prefix.length)}` : raw;
}

/**
 * The paths a `mktemp` makes: its template under its `-p`, `--tmpdir` or `-t` directory, which is TMPDIR as the
 * session or the command itself sets it; none for `-u`, which only prints a name.
 */
function mktempTargets(args: ReadonlyArray<string>, temps: ReadonlyArray<string>): string[] {
	let dir: string | null = null;
	let underTemp = false;
	let template: string | null = null;
	for (let index = 0; index < args.length; index += 1) {
		const word = args[index] as string;
		if (word === "--") {
			template ??= args[index + 1] ?? null;
			break;
		}
		if (word === "--dry-run") return [];
		if (word === "--tmpdir") underTemp = true;
		// An empty directory is no directory: mktemp falls back to TMPDIR.
		else if (word.startsWith("--tmpdir=")) {
			dir = word.slice("--tmpdir=".length) || null;
			underTemp = true;
		} else if (word === "--suffix") index += 1;
		else if (word.startsWith("--")) continue;
		else if (word.startsWith("-") && word.length > 1) {
			// A cluster's flags run up to `p`, whose value is the rest of the word or the next one.
			const valued = word.indexOf("p");
			const flags = valued < 0 ? word.slice(1) : word.slice(1, valued);
			if (flags.includes("u")) return [];
			if (flags.includes("t")) underTemp = true;
			if (valued >= 0) {
				const rest = word.slice(valued + 1);
				dir = (rest.length > 0 ? rest : args[index + 1]) || null;
				if (rest.length === 0) index += 1;
				underTemp = true;
			}
		} else template ??= word;
	}
	const name = template ?? "tmp.XXXXXXXXXX";
	if (dir !== null) return [path.join(dir, name)];
	if (template !== null && !underTemp) return [template];
	return temps.map((temp) => path.join(temp, name));
}

/**
 * Write targets the floor reads beyond the general scan (FX-8): an `rsync` destination, what a `mktemp` makes, and
 * every link the command makes. A symbolic or hard link (`ln`, `cp -s`, `cp -l`) whose source is in, or holds, one of
 * PanCode's trees counts as a write there: what the command writes through the link, however it later names, moves or
 * cds into it, lands in that tree. A source with a variable in it is judged as written, so a PanCode variable reads as
 * PanCode's tree.
 */
export function sameCommandWriteTargets(
	command: string,
	cwd: string,
	roots: ReadonlyArray<string>,
): Array<{ operation: PathPolicyOperation; path: string }> {
	const found: Array<{ operation: PathPolicyOperation; path: string }> = [];
	const home = homedir();
	const expand = (word: string) =>
		accountHomeExpanded(word === "~" || word.startsWith("~/") ? path.join(home, word.slice(1)) : word);
	const linked = (source: string, base: string) => {
		const raw = expand(source);
		if (/[$`]/u.test(raw)) {
			found.push({ operation: "write", path: raw });
			return;
		}
		const at = path.resolve(base, raw);
		found.push({ operation: "write", path: at });
		for (const root of roots) if (isSameOrDescendant(root, at)) found.push({ operation: "write", path: root });
	};
	// TMPDIR as the session holds it, and as any assignment in the command sets it for a `mktemp` that reads it.
	const temps = [
		process.env.TMPDIR || "/tmp",
		...commandAssignments(command)
			.filter(({ name }) => name === "TMPDIR")
			.map(({ text }) => expand(text.replace(/["']/gu, ""))),
	];
	// A relative link source is read from the cwd and from each directory the command's cds reach.
	const bases = [cwd];
	for (const destination of extractCommandCdTargets(command))
		bases.push(path.resolve(bases.at(-1) as string, expand(destination)));
	// The directories a link may land in: `$TMPDIR` is a temp directory above; any other variable leaves it unplaced.
	const placed = (destination: string): string[] =>
		temps
			.map((temp) => destination.replace(/\$\{TMPDIR\}|\$TMPDIR(?!\w)/gu, temp))
			.filter((spelled) => !/[$`]/u.test(spelled))
			.flatMap((spelled) => bases.map((base) => path.resolve(base, expand(spelled))));
	for (const step of shellCommandSteps(command, home)) {
		if (step.executable === "mktemp") {
			for (const made of mktempTargets(step.args, temps)) found.push({ operation: "write", path: expand(made) });
			continue;
		}
		const operands: string[] = [];
		let targetDir: string | null = null;
		let links = step.executable === "ln";
		for (let index = 0, options = true; index < step.args.length; index += 1) {
			const word = step.args[index] as string;
			if (options && word === "--") options = false;
			else if (options && word.startsWith("--")) {
				if (["--symbolic-link", "--link"].includes(word) && step.executable === "cp") links = true;
				if (word.startsWith("--target-directory=")) targetDir = word.slice("--target-directory=".length);
				else if (word === "--target-directory" || word === "--suffix") {
					if (word === "--target-directory") targetDir = step.args[index + 1] ?? null;
					index += 1;
				}
			} else if (options && word.startsWith("-") && word.length > 1) {
				if (step.executable === "cp" && /^-[^-]*[sl]/u.test(word)) links = true;
				const valued = /[tS]/u.exec(word);
				if (valued !== null && word.slice(valued.index + 1).length === 0) {
					if (valued[0] === "t") targetDir = step.args[index + 1] ?? null;
					index += 1;
				} else if (valued?.[0] === "t") targetDir = word.slice(valued.index + 1);
			} else operands.push(word);
		}
		if (step.executable === "rsync") {
			const destination = operands.at(-1);
			// `host:path` and `rsync://` are remote; a local destination is a path.
			if (operands.length >= 2 && destination !== undefined && !/^[^/]*:/u.test(destination))
				found.push({ operation: "write", path: destination });
			continue;
		}
		if (!links) continue;
		// A source is resolved from the link's directory, which may be the cwd, a cd's, or the named destination; all count.
		const sources = targetDir !== null || operands.length === 1 ? operands : operands.slice(0, -1);
		const destination = targetDir ?? (operands.length > 1 ? (operands.at(-1) as string) : ".");
		const linkDirs = placed(destination);
		for (const source of sources) {
			for (const base of bases) linked(source, base);
			if (path.isAbsolute(expand(source))) continue;
			for (const linkDir of linkDirs) {
				linked(source, linkDir);
				linked(source, path.dirname(linkDir));
			}
			// A link a variable places may sit at any depth, where its `..` climbs as far as `/`.
			if (linkDirs.length === 0) linked(source.replace(/^(?:\.\.?\/)+/u, ""), "/");
		}
	}
	return found;
}
