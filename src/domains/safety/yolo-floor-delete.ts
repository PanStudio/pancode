// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { lstatSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import path from "node:path";
import { canonicalizePath, canonicalizeRawPath } from "../../core/path-canonical.js";
import { isSameOrDescendant } from "../../core/path-containment.js";
import { extractCommandPathWalks, shellCommandSteps } from "./command-path-walks.js";
import type { YoloFloorHit } from "./yolo-floor.js";
import { YOLO_FLOOR_RULE_IDS } from "./yolo-floor.js";

/**
 * System trees a delete may never reach at yolo. `/var/tmp` and `/var/folders`
 * are scratch space, as the classifier already treats them.
 */
const SYSTEM_TREES: ReadonlyArray<string> = [
	"/bin",
	"/boot",
	"/dev",
	"/etc",
	"/proc",
	"/sbin",
	"/sys",
	"/usr",
	"/var",
	"/private/etc",
	"/private/var",
];

const SYSTEM_TREE_EXEMPT: ReadonlyArray<string> = [
	"/var/tmp",
	"/var/folders",
	"/private/var/tmp",
	"/private/var/folders",
];

function inSystemTree(abs: string): boolean {
	if (SYSTEM_TREE_EXEMPT.some((exempt) => isSameOrDescendant(abs, exempt))) return false;
	if (SYSTEM_TREES.some((tree) => isSameOrDescendant(abs, tree))) return true;
	// `/lib*`: /lib, /lib32, /lib64, /libx32 and their kin.
	const top = abs.split("/")[1] ?? "";
	return abs.startsWith("/") && top.startsWith("lib");
}

/** The operator's account name and passwd home, which `~name` expands to; null when the host has none. */
function ownAccount(): { name: string; home: string } | null {
	try {
		const info = userInfo();
		return info.username.length > 0 && info.homedir.length > 0 ? { name: info.username, home: info.homedir } : null;
	} catch {
		return null;
	}
}

/** Home, the account's passwd home, and their real paths, read once per judgment. */
function homeForms(): string[] {
	const forms = new Set<string>();
	const account = ownAccount();
	for (const spelled of [homedir(), ...(account !== null ? [account.home] : [])]) {
		const home = path.resolve(spelled);
		forms.add(home);
		const real = canonicalizePath(home);
		if (real !== null) forms.add(real);
	}
	return [...forms];
}

/**
 * Why a delete landing at `abs` is a floor hit, or null. `/`, the home
 * directory or any ancestor of it, and anything in a system tree are floor.
 * A workspace that is not itself one of those keeps everything strictly
 * inside it out of the system-tree judgment, so a container workspace under
 * /usr/src or /var/www cleans its own build output.
 */
function floorTargetReason(abs: string, homes: ReadonlyArray<string>, workspace: string): string | null {
	if (abs === "/") return "the filesystem root";
	if (homes.some((home) => isSameOrDescendant(home, abs))) {
		return homes.some((home) => home === abs) ? `the home directory ${abs}` : `${abs}, which holds the home directory`;
	}
	const workspaceIsFloor = workspace === "/" || homes.some((home) => isSameOrDescendant(home, workspace));
	if (!workspaceIsFloor && abs !== workspace && isSameOrDescendant(abs, workspace)) return null;
	return inSystemTree(abs) ? `${abs} in a system tree` : null;
}

/**
 * `~`, `~name` for the operator's own account, `$HOME` and `${HOME}` at the start of a word, expanded; null for any
 * other run-time word.
 */
function expandHomeWord(word: string): string | null {
	const home = homedir();
	const account = ownAccount();
	const named =
		account !== null && (word === `~${account.name}` || word.startsWith(`~${account.name}/`))
			? `${account.home}${word.slice(account.name.length + 1)}`
			: word;
	const expanded = named.replace(/^(?:~(?=\/|$)|\$\{HOME\}|\$HOME(?![\w]))/u, home);
	return /[$`]/u.test(expanded) ? null : expanded;
}

/** A directory and every directory above it, the root excluded. */
function ancestors(dir: string): string[] {
	const found: string[] = [];
	for (let at = dir; at !== path.dirname(at); at = path.dirname(at)) found.push(at);
	return found;
}

/** Most directories one walk keeps for its relative deletes. */
const MAX_FLOOR_BASES = 32;

/**
 * Deletes and overwrites a command makes whose target is `/`, the home
 * directory or an ancestor of it, or a system tree: rm, rmdir and unlink
 * however wrapped, `find -delete` and `find -exec rm` by their roots,
 * `rsync --delete` by its operands, and shred. A glob is judged by the
 * directory it expands in. A relative target resolves from the call's cwd
 * and every directory a literal cd can leave the shell in, shred's from every
 * directory any cd of the command can. After a cd the floor cannot place (one
 * naming a variable, a substitution, `~user` or a glob, or one in a loop) a
 * relative target is a hit when it could name a protected root from some
 * directory: `.`, `..`, `*`, `lib`, `etc` or the home directory's own name. A
 * target named only at run time is not placed and is not a floor hit.
 */
export function yoloFloorDeleteHit(command: string, cwd: string, workspace: string): YoloFloorHit | null {
	const homes = homeForms();
	const hit = (abs: string): string | null => floorTargetReason(abs, homes, workspace);
	const place = (target: string, bases: ReadonlyArray<string> | null): string[] => {
		if (path.isAbsolute(target)) {
			const lexical = path.resolve(target);
			const real = canonicalizeRawPath(target, "/");
			return real === null || real === lexical ? [lexical] : [lexical, real];
		}
		if (bases === null) return [];
		return bases.flatMap((base) => {
			const lexical = path.resolve(base, target);
			const real = canonicalizeRawPath(target, base);
			return real === null || real === lexical ? [lexical] : [lexical, real];
		});
	};
	const roots = [...homes.flatMap(ancestors), ...SYSTEM_TREES];
	/** Why a relative target is a hit from a directory the floor cannot place: it may name a protected root. */
	const unplaced = (target: string): string | null => {
		const rest = path.posix
			.normalize(target)
			.split("/")
			.filter((part) => part !== "" && part !== "." && part !== "..")
			.join("/");
		if (rest === "") return `${target} from a directory the floor cannot place, which may be the filesystem root`;
		const named = hit(`/${rest}`) ?? (roots.some((root) => root.endsWith(`/${rest}`)) ? rest : null);
		return named === null
			? null
			: `${target} from a directory the floor cannot place, which may name a protected root (${named})`;
	};
	const judge = (raw: string, bases: ReadonlyArray<string> | null): string | null => {
		const expanded = expandHomeWord(raw);
		if (expanded === null) return null;
		let target = expanded;
		const wildcard = target.search(/[*?[{]/u);
		if (wildcard >= 0) {
			// A glob expands to entries of the directory before its first wildcard.
			const slash = target.lastIndexOf("/", wildcard);
			target = slash < 0 ? "." : slash === 0 ? "/" : target.slice(0, slash);
		}
		if (bases === null && !path.isAbsolute(target)) return unplaced(target);
		for (const abs of place(target, bases)) {
			const reason = hit(abs);
			if (reason !== null) return reason;
		}
		return null;
	};
	const reached = new Set<string>([cwd]);
	let unknown = false;
	for (const walk of extractCommandPathWalks(command)) {
		let bases: string[] | null = [cwd];
		const saved: Array<string[] | null> = [];
		for (const event of walk) {
			if (event.kind === "subshell") {
				if (event.open) saved.push(bases === null ? null : [...bases]);
				else if (saved.length > 0) bases = saved.pop() ?? null;
				continue;
			}
			if (event.kind === "cd") {
				const target = expandHomeWord(event.target);
				if (target === null || event.unmodeled || target.startsWith("~") || /[*?[{]/u.test(target)) {
					bases = null;
					unknown = true;
					continue;
				}
				// A cd may fail, so the shell may still be where it was.
				const landed = place(target, bases);
				if (!path.isAbsolute(target) && bases === null) continue;
				const merged = [...new Set([...(bases ?? []), ...landed])];
				bases = merged.length > MAX_FLOOR_BASES ? null : merged;
				if (bases === null) unknown = true;
				else for (const base of bases) reached.add(base);
				continue;
			}
			if (event.kind !== "delete" || event.scope === "input" || event.scope === "remote") continue;
			const reason = judge(event.target, bases);
			if (reason !== null) return deleteHit(event.target, reason);
		}
	}
	for (const step of shellCommandSteps(command, homedir())) {
		if (step.executable !== "shred") continue;
		for (const operand of step.args.filter((arg) => !arg.startsWith("-"))) {
			const reason = judge(operand, [...reached]) ?? (unknown ? judge(operand, null) : null);
			if (reason !== null) return deleteHit(operand, reason);
		}
	}
	return null;
}

function deleteHit(target: string, reason: string): YoloFloorHit {
	const id = YOLO_FLOOR_RULE_IDS.deleteTarget;
	return {
		ruleId: id,
		reason: `matched ${id}: deletes or overwrites ${reason} (${target}); yolo never deletes the filesystem root, the home directory or an ancestor of it, or a system tree`,
	};
}

/** A bash brace sequence's words: `{1..3}`, `{a..c}`, `{01..10..2}`; null for anything else or too many. */
function braceSequence(body: string): string[] | null {
	const numeric = /^(-?\d+)\.\.(-?\d+)(?:\.\.(-?\d+))?$/u.exec(body);
	if (numeric !== null) {
		const [from, to] = [Number(numeric[1]), Number(numeric[2])];
		const step = Math.abs(Number(numeric[3] ?? 1)) || 1;
		const width = /^-?0\d/u.test(numeric[1] ?? "") || /^-?0\d/u.test(numeric[2] ?? "") ? (numeric[1] ?? "").length : 0;
		if (Math.abs(to - from) / step > 64) return null;
		const out: string[] = [];
		for (let value = from; from <= to ? value <= to : value >= to; value += from <= to ? step : -step)
			out.push(String(value).padStart(width, "0"));
		return out;
	}
	const alpha = /^([A-Za-z])\.\.([A-Za-z])$/u.exec(body);
	if (alpha === null) return null;
	const [from, to] = [(alpha[1] as string).charCodeAt(0), (alpha[2] as string).charCodeAt(0)];
	if (Math.abs(to - from) > 64) return null;
	const out: string[] = [];
	for (let code = from; from <= to ? code <= to : code >= to; code += from <= to ? 1 : -1)
		out.push(String.fromCharCode(code));
	return out;
}

/** Brace alternatives and sequences as bash expands them before globbing; null for too many words or a nesting. */
export function expandBraces(word: string, depth = 0): string[] | null {
	if (depth > 8) return null;
	for (const match of word.matchAll(/\{([^{}]*)\}/gu)) {
		const body = match[1] ?? "";
		const alternatives = body.includes(",") ? body.split(",") : braceSequence(body);
		if (alternatives === null) {
			if (body.includes("..")) return null;
			continue;
		}
		const start = match.index;
		const out: string[] = [];
		for (const alternative of alternatives) {
			const more = expandBraces(`${word.slice(0, start)}${alternative}${word.slice(start + match[0].length)}`, depth + 1);
			if (more === null) return null;
			out.push(...more);
			if (out.length > 64) return null;
		}
		return out;
	}
	return [word];
}

const GLOB_SEGMENT = /[*?[]/u;

/**
 * Whether one path segment as written can name `name`: a literal compares as text, a glob as bash matches it with
 * dotglob off (a leading dot is matched only by a leading dot), or as find's -name matches it with `dotglob`.
 * A glob the reader cannot translate matches anything.
 */
export function segmentNames(segment: string, name: string, dotglob = false): boolean {
	if (!GLOB_SEGMENT.test(segment)) return segment === name;
	if (!dotglob && name.startsWith(".") && !segment.startsWith(".")) return false;
	let source = "";
	for (let index = 0; index < segment.length; index += 1) {
		const char = segment[index] as string;
		if (char === "*") source += ".*";
		else if (char === "?") source += ".";
		else if (char === "[") {
			const close = segment.indexOf("]", index + 2);
			if (close === -1) return true;
			const body = segment.slice(index + 1, close);
			if (body.includes("[")) return true;
			source += `[${body.startsWith("!") ? `^${body.slice(1)}` : body}]`;
			index = close;
		} else source += char.replace(/[.*+?^${}()|[\]\\/-]/gu, "\\$&");
	}
	try {
		return new RegExp(`^${source}$`, "su").test(name);
	} catch {
		return true;
	}
}

/** Whether written segments name `target`, a prefix of it, or (`anywhere`) a run of segments inside it. */
function segmentsReach(written: ReadonlyArray<string>, target: ReadonlyArray<string>, anywhere: boolean): boolean {
	if (written.length > target.length) return false;
	const last = anywhere ? target.length - written.length : 0;
	for (let offset = 0; offset <= last; offset += 1) {
		if (written.every((segment, index) => segmentNames(segment, target[offset + index] as string))) return true;
	}
	return false;
}

const pathSegments = (location: string): string[] => location.split("/").filter((part) => part !== "");

/** A glob directly under the `.git` that names its history and refs as well as HEAD empties it: `.git/*`. */
function emptiesGit(written: ReadonlyArray<string>, git: ReadonlyArray<string>): boolean {
	const last = written.at(-1) ?? "";
	return (
		written.length === git.length + 1 &&
		GLOB_SEGMENT.test(last) &&
		segmentsReach(written.slice(0, -1), git, false) &&
		["HEAD", "objects", "refs"].every((name) => segmentNames(last, name))
	);
}

/** A path the shell follows through its last component: `x/`, `x/.`, `.`, `..`. */
const followsLast = (word: string): boolean => word.endsWith("/") || /(?:^|\/)\.{1,2}$/u.test(word);

const FIND_ACTIONS: ReadonlySet<string> = new Set(["-delete", "-exec", "-execdir", "-ok", "-okdir"]);

const OPERAND_DELETERS: ReadonlySet<string> = new Set(["rm", "rmdir", "unlink", "shred", "mv"]);

/**
 * The operands a find's `-exec rm ...` (`rmdir`, `unlink`, `shred`, `mv`) names besides `{}`, and whether they run in
 * the matched file's directory (`-execdir`, `-okdir`).
 */
function findExecOperands(expression: ReadonlyArray<string>): Array<{ word: string; inMatchDir: boolean }> {
	const out: Array<{ word: string; inMatchDir: boolean }> = [];
	for (let index = 0; index < expression.length; index += 1) {
		const action = expression[index] as string;
		if (!["-exec", "-execdir", "-ok", "-okdir"].includes(action)) continue;
		const program = path.basename(expression[index + 1] ?? "");
		let end = index + 2;
		while (end < expression.length && expression[end] !== ";" && expression[end] !== "+") end += 1;
		if (OPERAND_DELETERS.has(program)) {
			for (const word of expression.slice(index + 2, end)) {
				if (word === "{}" || word.startsWith("-")) continue;
				out.push({ word, inMatchDir: action.endsWith("dir") });
			}
		}
		index = end;
	}
	return out;
}

/**
 * Whether a find expression keeps `.git` out of what it removes: no alternation or negation, and a -name, -iname,
 * -path or -wholename test whose pattern cannot be `.git` or end in `/.git`. A test that rejects nothing, a type or
 * time test alone, or a -regex does not; find's patterns match a leading dot.
 */
function findExcludesGit(written: ReadonlyArray<string>): boolean {
	// Only tests before the first action select what it removes: `find . -delete -name x` deletes everything.
	const action = written.findIndex((word) => FIND_ACTIONS.has(word));
	const expression = action === -1 ? written : written.slice(0, action);
	if (expression.some((word) => ["-o", "-or", ",", "!", "-not", "("].includes(word))) return false;
	return expression.some((word, index) => {
		const pattern = expression[index + 1];
		if (pattern === undefined) return false;
		const fold = word.startsWith("-i");
		const name = fold ? ".git" : ".git";
		const value = fold ? pattern.toLowerCase() : pattern;
		if (word === "-name" || word === "-iname") return !segmentNames(value, name, true);
		if (/^-i?(?:path|wholename)$/u.test(word)) {
			const last = value.split("/").at(-1) ?? "";
			return !value.includes(".git") && !segmentNames(last, name, true) && !/\*\*?$|\*\/?$/u.test(value);
		}
		return false;
	});
}

interface FloorLink {
	/** Where the link lands, as segments, and where it points, or null when the floor cannot place its source. */
	at: string[];
	to: string[] | null;
}

/**
 * Where `word` lands from `start` when the kernel walks it: each `..` climbs from where the walk stands, and a segment
 * that is a link the command planted, with more of the path after it (or `follow`), continues from where the link
 * points, so `link/../.git` climbs from the link's target. Null when the walk goes through a link the floor cannot place.
 */
function physicalSegments(
	start: string,
	word: string,
	links: ReadonlyArray<FloorLink>,
	follow: boolean,
): string[] | null {
	let stack = pathSegments(start);
	const parts = word.split("/");
	for (const [index, part] of parts.entries()) {
		if (part === "" || part === ".") continue;
		if (part === "..") {
			stack = stack.slice(0, -1);
			continue;
		}
		stack = [...stack, part];
		if (!follow && !parts.slice(index + 1).some((later) => later !== "")) continue;
		const link = links.find(
			(entry) => entry.at.length === stack.length && entry.at.every((segment, at) => segment === stack[at]),
		);
		if (link === undefined) continue;
		if (link.to === null) return null;
		stack = [...link.to];
	}
	return stack;
}

/** Whether the path names an existing symbolic link itself, which a link-keeping copy or a move carries along. */
function isSymlink(location: string): boolean {
	try {
		return lstatSync(location).isSymbolicLink();
	} catch {
		return false;
	}
}

/**
 * The floor's reading of a delete of the workspace's own `.git` (maintainer ruling, row 261): deleting, emptying or
 * moving away the `.git` directory or a linked worktree's `.git` file, the workspace root, or a directory above it,
 * through rm, rmdir, unlink, shred, a find whose expression may select `.git` or whose `-exec rm` names it, `xargs rm`
 * fed a literal list or a find, mv, or `git worktree remove`, globs, braces, `$PWD` and `env -C` included, and through a
 * link the same command plants or moves. A relative target resolves from the directory the call starts in and from
 * every directory a cd before it may land in, whatever separates them: a cd that fails, or one undone later (`cd -`,
 * `popd`), leaves the shell where it was. After a cd the floor cannot place, a relative target that could still name
 * the `.git`, the workspace or one of its parents is a hit. A delete inside `.git` (a stale `index.lock`,
 * `.git/worktrees/x`) keeps its ordinary judgment, a bare link name removes only the link, and a target named only at
 * run time is not placed.
 */
export function yoloFloorWorkspaceGitHit(command: string, cwd: string, workspace: string): YoloFloorHit | null {
	const lexicalWorkspace = path.resolve(workspace);
	const realWorkspace = canonicalizePath(lexicalWorkspace) ?? lexicalWorkspace;
	const gitPaths = [...new Set([lexicalWorkspace, realWorkspace])].map((root) => [...pathSegments(root), ".git"]);
	const workspaceNames = new Set(gitPaths.flat());
	const reachesGit = (written: ReadonlyArray<string>): boolean =>
		gitPaths.some((git) => segmentsReach(written, git, false) || emptiesGit(written, git));
	/** Each form a written path takes from each base: as written, and through the real path of what it walks. */
	const placed = (target: string, bases: ReadonlyArray<string>): string[][] => {
		const segments = target.split("/");
		const globAt = segments.findIndex((segment) => GLOB_SEGMENT.test(segment));
		const literal = globAt === -1 ? target : segments.slice(0, globAt).join("/") || (target.startsWith("/") ? "/" : ".");
		const rest = globAt === -1 ? [] : segments.slice(globAt).filter((segment) => segment !== "" && segment !== ".");
		const follow = globAt !== -1 || followsLast(literal) || target.endsWith("/");
		const from = path.isAbsolute(literal) ? ["/"] : bases;
		return from.flatMap((base) => {
			const lexical = path.resolve(base, literal);
			// rm, rmdir and mv act on a link itself unless the path goes through it.
			const parent = follow ? null : canonicalizeRawPath(path.dirname(literal), base);
			const real = follow
				? canonicalizeRawPath(literal, base)
				: parent === null
					? null
					: path.join(parent, path.basename(lexical));
			return [...new Set([lexical, ...(real === null ? [] : [real])])].map((dir) => [...pathSegments(dir), ...rest]);
		});
	};
	/** The words a written path stands for: `$PWD` as each base, `~` as the home, braces expanded; null if unreadable. */
	const spellings = (raw: string, bases: ReadonlyArray<string>): string[] | null => {
		const pwd = /^(?:\$PWD|\$\{PWD\})(?=\/|$)/u.exec(raw);
		const out: string[] = [];
		for (const spelling of pwd === null ? [raw] : bases.map((base) => `${base}${raw.slice(pwd[0].length)}`)) {
			const home = expandHomeWord(spelling);
			if (home === null) continue;
			const words = expandBraces(home);
			if (words === null) return /\.git|^[./]*$/u.test(home) ? null : out;
			out.push(...words);
		}
		return out;
	};
	/** Why a written target reaches the `.git`, or null. */
	const reaches = (
		raw: string,
		bases: ReadonlyArray<string>,
		unplaced: boolean,
		links: ReadonlyArray<FloorLink>,
		follows = false,
	): string | null => {
		const words = spellings(raw, bases);
		if (words === null) return raw;
		for (const word of words) {
			const parts = word.split("/");
			const globAt = parts.findIndex((part) => GLOB_SEGMENT.test(part));
			if (globAt !== -1 && parts.slice(globAt + 1).includes("..")) {
				// `..` after a glob climbs out of whatever matched, a link included: only a name that can be the `.git`,
				// the workspace or a parent of it, or no name at all, may land on one.
				const after = parts.slice(parts.lastIndexOf("..") + 1).filter((part) => part !== "" && part !== ".");
				const next = after[0];
				if (next === undefined || [".git", ...workspaceNames].some((name) => segmentNames(next, name))) return raw;
				continue;
			}
			const through = follows || globAt !== -1 || followsLast(word);
			for (const written of placed(word, bases)) {
				if (reachesGit(written)) return raw;
				for (const link of links) {
					if (written.length < link.at.length || (written.length === link.at.length && !through)) continue;
					if (!link.at.every((segment, index) => segmentNames(written[index] as string, segment))) continue;
					if (link.to === null || reachesGit([...link.to, ...written.slice(link.at.length)])) return raw;
				}
			}
			if (links.length > 0 && globAt === -1) {
				for (const base of path.isAbsolute(word) ? ["/"] : bases) {
					const walked = physicalSegments(base, word, links, through);
					if (walked === null || reachesGit(walked)) return raw;
				}
			}
			if (unplaced && !path.isAbsolute(word)) {
				const inner = path.posix
					.normalize(word)
					.split("/")
					.filter((part) => part !== "" && part !== "." && part !== "..");
				if (inner.length === 0 || gitPaths.some((git) => segmentsReach(inner, git, true))) return raw;
			}
		}
		return null;
	};
	const hit = (spelled: string, how: string): YoloFloorHit => {
		const id = YOLO_FLOOR_RULE_IDS.workspaceGit;
		return {
			ruleId: id,
			reason: `matched ${id}: ${how} ${spelled}, which reaches the workspace's own ${path.join(lexicalWorkspace, ".git")}; yolo never deletes, empties or moves away the workspace's git history, even when the operator named the command; delete inside it by its full path, or ask the operator to run it themselves`,
		};
	};
	// Every directory any walk may stand in, for the readers below that do not follow a walk.
	const reached = new Set<string>([cwd]);
	let unplacedAnywhere = false;
	for (const walk of extractCommandPathWalks(command)) {
		let bases: string[] = [cwd];
		let unplaced = false;
		let links: FloorLink[] = [];
		const saved: Array<{ bases: string[]; unplaced: boolean }> = [];
		const linkTo = (source: string, at: string[], copied: boolean): void => {
			const home = expandHomeWord(source);
			if (home === null || /[*?[{]/u.test(home)) {
				links = [...links, { at, to: null }];
				return;
			}
			const targets = new Set<string>();
			if (copied) {
				// A moved or link-keeping copy of a link points where that link does: one planted earlier in the command,
				// or one already on disk, read from every base.
				for (const base of path.isAbsolute(home) ? ["/"] : bases) {
					const walked = physicalSegments(base, home, links, true);
					if (walked === null) {
						links = [...links, { at, to: null }];
						return;
					}
					const lexical = path.resolve(base, home);
					if (walked.join("/") !== pathSegments(lexical).join("/")) targets.add(`/${walked.join("/")}`);
					if (isSymlink(lexical)) {
						const real = canonicalizeRawPath(home, base);
						if (real === null) {
							links = [...links, { at, to: null }];
							return;
						}
						targets.add(real);
					}
				}
			} else {
				// A symlink's relative text resolves from the link's directory.
				const parent = `/${at.slice(0, -1).join("/")}`;
				targets.add(path.resolve(parent, home));
				const real = canonicalizeRawPath(home, parent);
				if (real !== null) targets.add(real);
			}
			for (const to of targets) links = [...links, { at, to: pathSegments(to) }];
		};
		for (const event of walk) {
			if (event.kind === "subshell") {
				if (event.open) saved.push({ bases: [...bases], unplaced });
				else {
					const back = saved.pop();
					if (back !== undefined) ({ bases, unplaced } = back);
				}
				continue;
			}
			if (event.kind === "cd") {
				const pwd = /^(?:\$PWD|\$\{PWD\})(?=\/|$)/u.exec(event.target);
				const targets =
					pwd === null ? [expandHomeWord(event.target)] : bases.map((base) => `${base}${event.target.slice(pwd[0].length)}`);
				// A cd the floor cannot follow may land anywhere.
				if (
					event.unmodeled ||
					targets.some((target) => target === null || target.startsWith("~") || /[*?[{$`]/u.test(target))
				) {
					unplaced = true;
					unplacedAnywhere = true;
					continue;
				}
				const landed = new Set<string>();
				for (const target of targets as string[]) {
					for (const base of path.isAbsolute(target) ? ["/"] : bases) {
						landed.add(path.resolve(base, target));
						const real = canonicalizeRawPath(target, base);
						if (real !== null) landed.add(real);
						const walked = physicalSegments(base, target, links, true);
						if (walked === null) {
							unplaced = true;
							unplacedAnywhere = true;
						} else landed.add(`/${walked.join("/")}`);
					}
				}
				// A failed cd leaves the shell where it was, so every earlier base stays.
				const next = [...new Set([...bases, ...landed])];
				if (next.length > MAX_FLOOR_BASES) {
					unplaced = true;
					unplacedAnywhere = true;
				} else {
					bases = next;
					for (const base of next) reached.add(base);
				}
				continue;
			}
			if (event.kind === "link") {
				if (event.moved === true) {
					for (const source of event.sources) {
						const spelled = reaches(source, bases, unplaced, links);
						if (spelled !== null) return hit(spelled, "moves away");
					}
				}
				if (!event.symbolic || event.links === undefined) continue;
				const copied = event.origin === "copied";
				for (const link of event.links) {
					for (const at of placed(link, bases)) {
						if (at.some((segment) => GLOB_SEGMENT.test(segment))) continue;
						for (const source of event.sources) {
							linkTo(source, at, copied);
							// A move or copy into an existing directory lands the link inside it.
							if (copied) linkTo(source, [...at, path.basename(source)], copied);
						}
					}
				}
				continue;
			}
			if (event.kind !== "delete" || event.scope === "input" || event.scope === "remote") continue;
			for (const operand of findExecOperands(event.expression ?? [])) {
				if (operand.inMatchDir) {
					if (operand.word.split("/").some((part) => part === ".git" || part === "..")) {
						return hit(operand.word, "deletes, in each matched directory,");
					}
					// The matched directory is not known here: an absolute operand lands as written, and a relative one is
					// read as after a cd the floor cannot place (r261f-4).
					const spelled = reaches(operand.word, bases, true, links);
					if (spelled !== null) return hit(spelled, "deletes, in each matched directory,");
					continue;
				}
				const spelled = reaches(operand.word, bases, unplaced, links);
				if (spelled !== null) return hit(spelled, "deletes, for each find match,");
			}
			if (event.scope === "children" && event.findRoot === "filtered") {
				// A filtered find removes what its expression selects: from the `.git` itself everything it matches, and
				// from above it the `.git` too unless the expression keeps it out. A root under a planted link is read where
				// the link points, and one whose link the floor cannot place is a hit.
				const words = spellings(event.target, bases);
				if (words === null) return hit(event.target, "deletes what find selects under");
				const roots = words.flatMap((word) => [
					...placed(word, bases).flatMap((written) => [
						written,
						...links
							.filter(
								(link) =>
									written.length >= link.at.length &&
									link.at.every((segment, index) => segmentNames(written[index] as string, segment)),
							)
							.map((link) => (link.to === null ? null : [...link.to, ...written.slice(link.at.length)])),
					]),
					...(links.length === 0
						? []
						: (path.isAbsolute(word) ? ["/"] : bases).map((base) => physicalSegments(base, word, links, true))),
				]);
				for (const written of roots) {
					if (written === null) return hit(event.target, "deletes what find selects under");
					if (!gitPaths.some((git) => segmentsReach(written, git, false))) continue;
					const atGit = gitPaths.some((git) => written.length === git.length);
					if (atGit || !findExcludesGit(event.expression ?? [])) return hit(event.target, "deletes what find selects under");
				}
				continue;
			}
			const spelled = reaches(event.target, bases, unplaced, links, event.scope === "children");
			if (spelled !== null) return hit(spelled, "deletes");
		}
	}
	const everywhere = [...reached];
	for (const step of shellCommandSteps(command, homedir())) {
		const executable = path.basename(step.executable);
		if (executable === "shred") {
			const operands = step.args.filter((word) => !word.startsWith("-"));
			for (const operand of operands) {
				const spelled = reaches(operand, everywhere, unplacedAnywhere, []);
				if (spelled !== null) return hit(spelled, "overwrites");
			}
			continue;
		}
		// `xargs rm` fed a here-string or here-document reads its operands from text the walk does not place: any
		// such text naming `.git` is a hit (fail closed).
		if (
			executable === "xargs" &&
			step.args.some((word) => OPERAND_DELETERS.has(path.basename(word))) &&
			command.includes("<<") &&
			/(?:^|[\s'"=/])\.git(?=$|[\s'"/\\])/mu.test(command)
		)
			return hit(".git", "feeds xargs rm");
		if (executable !== "git") continue;
		// `git worktree remove` deletes the worktree it names, the workspace included, from wherever `-C` points.
		let bases = everywhere;
		let index = 0;
		while (index < step.args.length && step.args[index]?.startsWith("-")) {
			const option = step.args[index] as string;
			if (option === "-C" || (option.startsWith("-C") && option.length > 2)) {
				const value = option === "-C" ? (step.args[index + 1] ?? ".") : option.slice(2);
				bases = bases.map((base) => path.resolve(base, value));
				index += option === "-C" ? 2 : 1;
				continue;
			}
			const takesValue = ["-c", "--git-dir", "--work-tree", "--namespace", "--super-prefix", "--config-env"];
			index += takesValue.includes(option) ? 2 : 1;
		}
		if (step.args[index] !== "worktree" || step.args[index + 1] !== "remove") continue;
		for (const operand of step.args.slice(index + 2).filter((word) => !word.startsWith("-"))) {
			const spelled = reaches(operand, bases, unplacedAnywhere, []);
			if (spelled !== null) return hit(spelled, "removes the worktree");
		}
	}
	return null;
}
