// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { existsSync, lstatSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { detectPancodeRepo } from "../../core/pancode-repo.js";
import { realpathInside } from "./contained-path.js";

export interface PancodeMdFingerprintFooter {
	initAt: string;
	model: string;
	gitHead: string | null;
	treeHash: string;
	loc: number;
}

export interface PancodeMdSection {
	title: string;
	body: string;
}

export interface ParsedPancodeMd {
	projectName: string;
	identity: string;
	conventions: string[];
	invariants: string[];
	sections: PancodeMdSection[];
	importedAgentContext: string | null;
	/** The `pancode:` override comment heading the Conventions section, without its delimiters. */
	conventionsOverride?: string;
	/** How many custom sections precede Conventions; zero when Conventions leads them. */
	sectionsBeforeConventions?: number;
	fingerprint: PancodeMdFingerprintFooter | null;
	firstInit: boolean;
	warnings: string[];
}

export interface LoadedPancodeMdFile {
	path: string;
	/** Exact UTF-8 authored source for prompt rendering. */
	source: string;
	/** Optional generator-format projection; never the authority for authored text. */
	value: ParsedPancodeMd | null;
}

export interface PancodeMdLoadError {
	path: string;
	error: string;
}

export interface LoadedProjectPancodeMd {
	/** Effective files in ancestor-to-descendant order. */
	files: LoadedPancodeMdFile[];
	/** Selected files that could not be read or were empty. */
	errors: PancodeMdLoadError[];
	/** The layered structured projection, or null when no selected file matches the generator format. */
	value: ParsedPancodeMd | null;
}

export type PancodeMdParseResult =
	| { ok: true; value: ParsedPancodeMd }
	| { ok: false; errors: string[]; warnings: string[] };

export interface SerializePancodeMdInput {
	projectName: string;
	identity: string;
	conventions: ReadonlyArray<string>;
	invariants: ReadonlyArray<string>;
	sections?: ReadonlyArray<PancodeMdSection>;
	importedAgentContext?: string;
	/** Written as `<!-- pancode: ... -->` on the line after the Conventions heading. */
	conventionsOverride?: string;
	/** Custom sections rendered between Hard invariants and Conventions. */
	sectionsBeforeConventions?: number;
	fingerprint?: PancodeMdFingerprintFooter | null;
}

const FOOTER_RE = /<!--\s*pancode:fingerprint v1\s*\n([\s\S]*?)\n\s*-->/;
/**
 * Size targets for a generated handbook. The parser warns past them, the
 * bootstrap clamps model output to them, and the merge caps to them. Ten
 * model invariants, eight conventions and 4000-character sections hold a change
 * recipe section as large as the one that decided real tasks. A fleet worker
 * receives 6000 characters with invariants first, so generated invariants stop
 * at sixteen rules and 3000 characters in total, leaving room for the Tests and
 * Gotchas rules that follow them, and the whole file targets 12000 characters.
 */
export const HANDBOOK_TARGETS = {
	lines: 200,
	chars: 12_000,
	conventions: 8,
	conventionChars: 600,
	invariants: 16,
	invariantsTotalChars: 3000,
	modelInvariants: 10,
	invariantChars: 800,
	sections: 8,
	sectionChars: 4000,
} as const;

const H1_RE = /^#\s+(.+?)\s*$/gm;
const H2_RE = /^##\s+(.+?)\s*$/gm;

function normalizeSource(source: string): string {
	return source
		.replace(/^\uFEFF/, "")
		.replace(/\r\n/g, "\n")
		.replace(/\r/g, "\n")
		.trimStart();
}

function normalizeInline(value: string): string {
	return value
		.replace(/\s+/g, " ")
		.trim()
		.replace(/^#{1,6}\s+/, "")
		.trim();
}

/**
 * The same text with every character inside a fenced code block or an HTML
 * comment replaced by a filler, newlines kept, so offsets into the mask are
 * offsets into the original. Heading scans run on the mask and slice from the
 * source, so a `# comment` line in a fenced shell example is not a second H1
 * and a `## not a heading` inside a fence does not split a section.
 */
function maskNonHeadingRegions(text: string): string {
	const lines = text.split("\n");
	const out: string[] = [];
	let fence: { char: string; length: number } | null = null;
	let inComment = false;
	for (const line of lines) {
		let masked = false;
		if (fence) {
			masked = true;
			const close = /^\s{0,3}(`{3,}|~{3,})\s*$/.exec(line);
			if (close?.[1] && close[1][0] === fence.char && close[1].length >= fence.length) fence = null;
		} else if (inComment) {
			masked = true;
			if (line.includes("-->")) inComment = false;
		} else {
			const open = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
			if (open?.[1]) {
				fence = { char: open[1][0] ?? "`", length: open[1].length };
				masked = true;
			} else if (/^\s*<!--/.test(line)) {
				masked = true;
				if (!line.includes("-->")) inComment = true;
			}
		}
		// A non-whitespace filler: the heading regexes end in `\s*$`, which would
		// otherwise run through a blank-masked block and swallow it into the
		// heading match.
		out.push(masked ? "_".repeat(line.length) : line);
	}
	return out.join("\n");
}

function normalizeNestedMarkdown(value: string): string {
	const body = normalizeSource(value).trim();
	// Demote authored H1/H2 inside a section body so it cannot outrank the
	// section, but only where a heading scan would see one: a fence or comment
	// keeps its bytes.
	const mask = maskNonHeadingRegions(body);
	let out = "";
	let cursor = 0;
	for (const match of mask.matchAll(/^(#{1,2})(\s+)/gm)) {
		if (match.index === undefined) continue;
		out += `${body.slice(cursor, match.index)}###${match[2] ?? ""}`;
		cursor = match.index + match[0].length;
	}
	return out + body.slice(cursor);
}

function charLen(value: string): number {
	return [...value].length;
}

function parseFooter(source: string): {
	body: string;
	footer: PancodeMdFingerprintFooter | null;
	firstInit: boolean;
	errors: string[];
	warnings: string[];
} {
	const warnings: string[] = [];
	const markerCount = (source.match(/pancode:fingerprint v1/g) ?? []).length;
	const match = FOOTER_RE.exec(source);
	if (!match) {
		if (markerCount > 0) {
			return {
				body: source,
				footer: null,
				firstInit: false,
				errors: ["malformed fingerprint footer"],
				warnings,
			};
		}
		return { body: source, footer: null, firstInit: true, errors: [], warnings };
	}

	const footerEnd = match.index + match[0].length;
	const trailing = source.slice(footerEnd).trim();
	if (trailing.length > 0) warnings.push("trailing content after fingerprint footer omitted from structured fields");
	let parsed: unknown;
	try {
		parsed = JSON.parse(match[1] ?? "");
	} catch {
		return {
			body: source.slice(0, match.index),
			footer: null,
			firstInit: false,
			errors: ["fingerprint footer is not valid JSON"],
			warnings,
		};
	}
	const footer = validateFooter(parsed);
	if (!footer) {
		return {
			body: source.slice(0, match.index),
			footer: null,
			firstInit: false,
			errors: ["fingerprint footer has invalid shape"],
			warnings,
		};
	}
	return {
		body: source.slice(0, match.index),
		footer,
		firstInit: false,
		errors: [],
		warnings,
	};
}

function validateFooter(value: unknown): PancodeMdFingerprintFooter | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
	const obj = value as Record<string, unknown>;
	if (typeof obj.initAt !== "string" || obj.initAt.length === 0) return null;
	if (typeof obj.model !== "string" || obj.model.length === 0) return null;
	if (!(typeof obj.gitHead === "string" || obj.gitHead === null)) return null;
	if (typeof obj.treeHash !== "string" || !/^[0-9a-f]{64}$/.test(obj.treeHash)) return null;
	if (typeof obj.loc !== "number" || !Number.isInteger(obj.loc) || obj.loc < 0) return null;
	return {
		initAt: obj.initAt,
		model: obj.model,
		gitHead: obj.gitHead,
		treeHash: obj.treeHash,
		loc: obj.loc,
	};
}

function readSections(body: string): PancodeMdSection[] {
	const headings = [...maskNonHeadingRegions(body).matchAll(H2_RE)];
	const sections: PancodeMdSection[] = [];
	for (let i = 0; i < headings.length; i += 1) {
		const heading = headings[i];
		if (!heading || heading.index === undefined) continue;
		const next = headings[i + 1];
		const title = (heading[1] ?? "").trim();
		const start = heading.index + heading[0].length;
		const end = next?.index ?? body.length;
		sections.push({ title, body: body.slice(start, end).trim() });
	}
	return sections;
}

function sectionBody(sections: ReadonlyArray<PancodeMdSection>, title: string): string {
	return sections.find((section) => section.title.toLowerCase() === title.toLowerCase())?.body ?? "";
}

const RESERVED_SECTION_TITLES = new Set(["conventions", "hard invariants", "imported agent context"]);

function extraSections(sections: ReadonlyArray<PancodeMdSection>): PancodeMdSection[] {
	return sections.filter((section) => !RESERVED_SECTION_TITLES.has(section.title.toLowerCase()));
}

function identityParagraph(afterH1: string): string {
	const firstSection = /^##\s+/m.exec(maskNonHeadingRegions(afterH1));
	const beforeFirstSection = firstSection ? afterH1.slice(0, firstSection.index) : afterH1;
	const paragraphs = beforeFirstSection
		.trim()
		.split(/\n\s*\n/)
		.map((part) => part.replace(/\s+/g, " ").trim())
		.filter((part) => part.length > 0 && !/^<!--(?:(?!-->).)*-->$/.test(part));
	return paragraphs[0] ?? "";
}

function parseBullets(section: string): string[] {
	if (section.trim().length === 0) return [];
	return section
		.split("\n")
		.map((line) => /^[-*]\s+(.+?)\s*$/.exec(line)?.[1]?.trim())
		.filter((line): line is string => Boolean(line));
}

function parseNumbered(section: string): string[] {
	if (section.trim().length === 0) return [];
	return section
		.split("\n")
		.map((line) => /^\d+\.\s+(.+?)\s*$/.exec(line)?.[1]?.trim())
		.filter((line): line is string => Boolean(line));
}

export function parsePancodeMd(source: string): PancodeMdParseResult {
	const normalized = normalizeSource(source);
	const warnings: string[] = [];
	const footerResult = parseFooter(normalized);
	warnings.push(...footerResult.warnings);
	if (footerResult.errors.length > 0) return { ok: false, errors: footerResult.errors, warnings };

	const h1Matches = [...maskNonHeadingRegions(footerResult.body).matchAll(H1_RE)];
	if (h1Matches.length === 0) return { ok: false, errors: ["missing H1 heading"], warnings };
	if (h1Matches.length > 1) return { ok: false, errors: ["more than one H1 heading"], warnings };

	const h1 = h1Matches[0];
	if (!h1 || h1.index === undefined) return { ok: false, errors: ["missing H1 heading"], warnings };
	const projectName = (h1[1] ?? "").trim();
	const errors: string[] = [];
	if (projectName.length === 0) errors.push("project name must not be empty");
	if (charLen(projectName) > 80) warnings.push("project name is longer than the generator target");

	const afterH1 = footerResult.body.slice(h1.index + h1[0].length);
	const identity = identityParagraph(afterH1);
	if (identity.length === 0) errors.push("identity paragraph is required");
	if (charLen(identity) > 600) warnings.push("identity paragraph is longer than the generator target");

	const sections = readSections(afterH1);
	const conventionsBody = sectionBody(sections, "conventions");
	const conventions = parseBullets(conventionsBody);
	const conventionsOverride = /^<!--\s*pancode:\s*(.*?)\s*-->$/.exec(
		conventionsBody.split("\n", 1)[0]?.trim() ?? "",
	)?.[1];
	const conventionsAt = sections.findIndex((section) => section.title.toLowerCase() === "conventions");
	const sectionsBeforeConventions = conventionsAt < 0 ? 0 : extraSections(sections.slice(0, conventionsAt)).length;
	const invariants = parseNumbered(sectionBody(sections, "hard invariants"));
	const customSections = extraSections(sections);
	const importedAgentContext = sectionBody(sections, "imported agent context") || null;
	if (conventions.length > HANDBOOK_TARGETS.conventions) {
		warnings.push(`conventions exceed the generator target of ${HANDBOOK_TARGETS.conventions} bullets`);
	}
	if (invariants.length > HANDBOOK_TARGETS.invariants) {
		warnings.push(`hard invariants exceed the generator target of ${HANDBOOK_TARGETS.invariants} numbered rules`);
	}
	if (customSections.length > HANDBOOK_TARGETS.sections) {
		warnings.push(`custom sections exceed the generator target of ${HANDBOOK_TARGETS.sections} H2 sections`);
	}
	for (const [index, item] of conventions.entries()) {
		if (charLen(item) > HANDBOOK_TARGETS.conventionChars)
			warnings.push(`convention ${index + 1} is longer than the generator target`);
	}
	for (const [index, item] of invariants.entries()) {
		if (charLen(item) > HANDBOOK_TARGETS.invariantChars)
			warnings.push(`hard invariant ${index + 1} is longer than the generator target`);
	}
	for (const [index, section] of customSections.entries()) {
		if (charLen(section.title) > 80)
			warnings.push(`custom section ${index + 1} title is longer than the generator target`);
		if (charLen(section.body) > HANDBOOK_TARGETS.sectionChars)
			warnings.push(`custom section ${index + 1} body is longer than the generator target`);
	}
	if (errors.length > 0) return { ok: false, errors, warnings };

	return {
		ok: true,
		value: {
			projectName,
			identity,
			conventions,
			invariants,
			sections: customSections,
			importedAgentContext,
			...(conventionsOverride ? { conventionsOverride } : {}),
			...(sectionsBeforeConventions > 0 ? { sectionsBeforeConventions } : {}),
			fingerprint: footerResult.footer,
			firstInit: footerResult.firstInit,
			warnings,
		},
	};
}

function validateForSerialization(input: SerializePancodeMdInput): void {
	const test = parsePancodeMd(renderWithoutParse(input));
	if (!test.ok) {
		throw new Error(`PANCODE.md serialization failed validation: ${test.errors.join("; ")}`);
	}
}

/** The handbook's one header comment: how fleet workers receive its sections. */
const WORKER_SCOPE_NOTE =
	"<!-- Fleet workers get Conventions, Tests, Gotchas, Git or release, and Docs or prose rules in every path; other rules reach the workers that touch a path they cite. -->";

function renderWithoutParse(input: SerializePancodeMdInput): string {
	const lines: string[] = [
		`# ${normalizeInline(input.projectName)}`,
		"",
		normalizeInline(input.identity),
		"",
		WORKER_SCOPE_NOTE,
	];
	// Invariants lead: small models keep early instructions best (IFScale), and
	// these are the rules whose violation breaks the build or crosses a boundary.
	const invariants = input.invariants.map((item) => normalizeInline(item)).filter((item) => item.length > 0);
	if (invariants.length > 0) {
		lines.push("", "## Hard invariants", "", ...invariants.map((item, index) => `${index + 1}. ${item}`));
	}
	const conventions = input.conventions.map((item) => normalizeInline(item)).filter((item) => item.length > 0);
	const pushConventions = (): void => {
		if (conventions.length === 0) return;
		const override = input.conventionsOverride ? [`<!-- pancode: ${normalizeInline(input.conventionsOverride)} -->`] : [];
		lines.push("", "## Conventions", "", ...override, ...conventions.map((item) => `- ${item}`));
	};
	const sections = input.sections ?? [];
	const leading = Math.min(input.sectionsBeforeConventions ?? 0, sections.length);
	for (const [index, section] of sections.entries()) {
		if (index === leading) pushConventions();
		const title = normalizeInline(section.title);
		const body = normalizeNestedMarkdown(section.body);
		if (title.length > 0 && body.length > 0) lines.push("", `## ${title}`, "", body);
	}
	if (leading >= sections.length) pushConventions();
	const imported = input.importedAgentContext ? normalizeNestedMarkdown(input.importedAgentContext) : undefined;
	if (imported && imported.length > 0) {
		lines.push("", "## Imported agent context", "", imported);
	}
	if (!input.fingerprint) return `${lines.join("\n")}\n`;
	const footer = JSON.stringify(input.fingerprint, null, 2);
	return `${lines.join("\n")}\n\n<!-- pancode:fingerprint v1\n${footer}\n-->\n`;
}

export function serializePancodeMd(input: SerializePancodeMdInput): string {
	validateForSerialization(input);
	return renderWithoutParse(input);
}

export function renderProjectTypeFragment(projectType: string): string {
	return `<project-type>${projectType}</project-type>`;
}

function escapeXmlAttribute(value: string): string {
	return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

const FENCE = /^ {0,3}(`{3,}|~{3,})/u;
const ATX_HEADING = /^( {0,3})(#{1,5})(?=[ \t]|$)/u;

/**
 * Pushes a handbook's ATX headings one level down, outside fenced code, so its
 * own `# Title` sits under the prompt's sections instead of beside them.
 * Level-six headings stay; the line count never changes.
 */
export function demoteHandbookHeadings(text: string): string {
	let fence: string | null = null;
	return text
		.split("\n")
		.map((line) => {
			const marker = FENCE.exec(line)?.[1];
			if (marker !== undefined) {
				if (fence === null) fence = marker;
				else if (marker[0] === fence[0] && marker.length >= fence.length && line.trim() === marker) fence = null;
				return line;
			}
			return fence === null ? line.replace(ATX_HEADING, "$1#$2") : line;
		})
		.join("\n");
}

/** The operator's user handbook, ahead of every project handbook and named apart from them. */
export function renderUserContextFragment(text: string, sourcePath: string): string {
	return `<user-context path="${escapeXmlAttribute(sourcePath)}">\n${demoteHandbookHeadings(text)}\n</user-context>`;
}

export function renderProjectContextFragment(parsed: ParsedPancodeMd | string, sourcePath?: string): string {
	const source = sourcePath ? ` path="${escapeXmlAttribute(sourcePath)}"` : "";
	if (typeof parsed === "string") {
		return `<project-context${source}>\n${demoteHandbookHeadings(parsed)}\n</project-context>`;
	}
	const sections: string[] = [`# ${parsed.projectName}`, parsed.identity];
	if (parsed.conventions.length > 0) {
		sections.push("## Conventions", ...parsed.conventions.map((item) => `- ${item}`));
	}
	if (parsed.invariants.length > 0) {
		sections.push("## Hard invariants", ...parsed.invariants.map((item, index) => `${index + 1}. ${item}`));
	}
	for (const section of parsed.sections) {
		sections.push(`## ${section.title}`, section.body);
	}
	if (parsed.importedAgentContext) {
		sections.push("## Imported agent context", parsed.importedAgentContext);
	}
	return `<project-context${source}>\n${sections.join("\n\n")}\n</project-context>`;
}

const PROJECT_CONTEXT_CANDIDATES = ["PANCODE.override.md", "PANCODE.md"] as const;
// PanCode's own checkout keeps a hand-written handbook under its own name, so
// `context init` stays free to generate PANCODE.md there for comparison.
const SELF_REPOSITORY_HANDBOOK = "PANCODE-DEV.md";

function selectedPancodeMdPath(directory: string, walkRoot: string, errors: PancodeMdLoadError[]): string | null {
	const candidates =
		detectPancodeRepo(directory).repoRoot === resolve(directory)
			? [SELF_REPOSITORY_HANDBOOK, ...PROJECT_CONTEXT_CANDIDATES]
			: PROJECT_CONTEXT_CANDIDATES;
	for (const filename of candidates) {
		const filePath = join(directory, filename);
		if (!existsSync(filePath)) continue;
		// A cloned repository may ship a link to any file on this machine. Only
		// a link that stays inside the project may stand in for its handbook.
		try {
			if (lstatSync(filePath).isSymbolicLink() && !realpathInside(filePath, walkRoot)) {
				errors.push({ path: filePath, error: `${filename} is a link that leaves the project; ignored` });
				continue;
			}
		} catch {
			// The read below reports anything lstat could not.
		}
		try {
			if (statSync(filePath).isFile()) return filePath;
		} catch {
			// Preserve candidate precedence and let the read below own the
			// actionable error instead of silently falling back to the base file.
			return filePath;
		}
	}
	return null;
}

function readPancodeMdPath(
	filePath: string,
): { ok: true; source: string; value: ParsedPancodeMd | null } | { ok: false; error: string } {
	let content: string;
	try {
		content = readFileSync(filePath, "utf8");
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : String(err) };
	}
	if (content.trim().length === 0) return { ok: false, error: "handbook is empty" };
	// Authored Markdown needs no generator schema. Preserve it even when a
	// structured projection cannot be derived; producer validation stays strict.
	const parsed = parsePancodeMd(content);
	return { ok: true, source: content, value: parsed.ok ? parsed.value : null };
}

function mergePancodeMdFiles(files: ReadonlyArray<LoadedPancodeMdFile>): ParsedPancodeMd | null {
	const values = files.flatMap((file) => (file.value ? [file.value] : []));
	const nearest = values.at(-1);
	if (!nearest) return null;
	return {
		projectName: nearest.projectName,
		identity: values.map((value) => value.identity).join("\n\n"),
		conventions: values.flatMap((value) => value.conventions),
		invariants: values.flatMap((value) => value.invariants),
		sections: values.flatMap((value) => value.sections),
		importedAgentContext:
			values
				.map((value) => value.importedAgentContext)
				.filter((value): value is string => value !== null)
				.join("\n\n") || null,
		fingerprint: nearest.fingerprint,
		firstInit: nearest.firstInit,
		warnings: values.flatMap((value) => value.warnings),
	};
}

/**
 * Load effective project handbooks from the repository root through `cwd`.
 * Candidate selection follows pi-coding-agent 0.84's
 * `loadProjectContextFiles`: an override wins over the base file in the same
 * directory. PanCode's override additionally resets the inherited
 * handbook chain for that subtree, as required by the project-context
 * contract. Handbooks below the override may add new layers.
 */
export function loadProjectPancodeMd(cwd: string): LoadedProjectPancodeMd {
	// The walk ends at the enclosing repository root (a `.git` directory, or a
	// `.git` file in a worktree or submodule). A handbook written for a folder
	// that holds many repositories would otherwise tell every one of them how
	// to behave. Outside any repository only `cwd`'s own handbook applies, since
	// a parent such as `/tmp` may hold a handbook any local user can write.
	let directories: string[] = [];
	let directory = resolve(cwd);
	while (true) {
		directories.unshift(directory);
		if (existsSync(join(directory, ".git"))) break;
		const parent = dirname(directory);
		if (parent === directory) {
			directories = [resolve(cwd)];
			break;
		}
		directory = parent;
	}
	const walkRoot = directories[0] ?? resolve(cwd);

	const errors: PancodeMdLoadError[] = [];
	const selectedPaths: string[] = [];
	for (const current of directories) {
		const selected = selectedPancodeMdPath(current, walkRoot, errors);
		if (!selected) continue;
		if (basename(selected) === "PANCODE.override.md") {
			selectedPaths.length = 0;
		}
		selectedPaths.push(selected);
	}

	const files: LoadedPancodeMdFile[] = [];
	for (const filePath of selectedPaths) {
		const read = readPancodeMdPath(filePath);
		if (read.ok) files.push({ path: filePath, source: read.source, value: read.value });
		else errors.push({ path: filePath, error: read.error });
	}
	return { files, errors, value: mergePancodeMdFiles(files) };
}

export function tryReadPancodeMd(
	cwd: string,
): { ok: true; source: string; value: ParsedPancodeMd | null } | { ok: false; error: string } | null {
	const filePath = join(cwd, "PANCODE.md");
	if (!existsSync(filePath)) return null;
	return readPancodeMdPath(filePath);
}
