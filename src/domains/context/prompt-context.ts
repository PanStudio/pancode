// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { readFileSync, statSync } from "node:fs";
import { pancodeUserHandbookPath, USER_HANDBOOK_MAX_BYTES } from "../../core/user-handbook.js";
import { detectProjectTypeHint } from "../session/workspace/project-type.js";
import { codemapPath } from "./codewiki/artifact.js";
import type { CompiledProjectHandbook } from "./compiled-handbook.js";
import type { ProjectPromptContext } from "./contract.js";
import { renderProjectOrientation } from "./orientation.js";
import {
	loadProjectPancodeMd,
	type ParsedPancodeMd,
	renderProjectContextFragment,
	renderProjectTypeFragment,
	renderUserContextFragment,
} from "./pancode-md.js";
import { readPancodeState } from "./state.js";
import { readWikiMeta } from "./wiki/meta.js";
import { wikiCompletenessFromMeta } from "./wiki/staleness.js";

/**
 * Render the project prompt context for `cwd`: the project-type marker, the
 * effective PANCODE.md fragments when readable nonempty handbooks exist, the codewiki availability
 * marker, and the Markdown wiki marker when a valid wiki exists. Shared by the
 * prompts extension (session compile),
 * context-init preload reporting, and `pancode config inspect`, so every surface
 * measures the same text the session prompt would preload.
 */
/** The one line that stands in for a handbook this workspace does not have. */
export const HANDBOOK_ABSENT_FRAGMENT =
	"<handbook>none: this workspace has no PANCODE.md, so do not read one; learn the repository from its files, and the operator can run /context init to write a handbook</handbook>";

function codewikiArtifactPresent(cwd: string): boolean {
	try {
		return statSync(codemapPath(cwd)).isFile();
	} catch {
		return false;
	}
}

type UserHandbookRead = { text: string } | { error: string } | null;
const userHandbookReads = new Map<string, UserHandbookRead>();

/**
 * The user handbook as this process first read it. The read is kept for the
 * process's life, so the prompt prefix it feeds stays byte-identical across
 * every turn and dispatch of a session; an edit applies from the next start.
 */
function readUserHandbook(file: string): UserHandbookRead {
	const cached = userHandbookReads.get(file);
	if (cached !== undefined) return cached;
	let read: UserHandbookRead;
	try {
		const stat = statSync(file);
		if (!stat.isFile()) read = { error: "not a regular file" };
		else if (stat.size > USER_HANDBOOK_MAX_BYTES)
			read = { error: `larger than ${USER_HANDBOOK_MAX_BYTES} bytes; shorten it to load it` };
		else {
			const text = readFileSync(file, "utf8").trim();
			read = text.length > 0 ? { text } : null;
		}
	} catch (error) {
		read =
			(error as NodeJS.ErrnoException).code === "ENOENT"
				? null
				: { error: error instanceof Error ? error.message : String(error) };
	}
	userHandbookReads.set(file, read);
	return read;
}

export interface PromptContextOptions {
	/**
	 * The compiled handbook to serve when no PANCODE.md loads, read from its
	 * cache and never compiled here. Injected rather than imported, so the
	 * bootstrap measures a handbook it writes without a compiled one standing in.
	 */
	compile?: (cwd: string) => CompiledProjectHandbook | null;
}

export function renderPromptContext(cwd: string, options: PromptContextOptions = {}): ProjectPromptContext {
	// Foreground detection uses root filenames only; full source classification belongs to indexing.
	// and this renders on session compile and on every bounded dispatch. An
	// indexed project already recorded its type when init, refresh, or the
	// session-start check stamped state; the marker reads that and detects only
	// where nothing has been recorded yet.
	const state = readPancodeState(cwd);
	const projectType = state?.projectType ?? detectProjectTypeHint(cwd);
	const supportFragments = [
		renderProjectTypeFragment(projectType),
		"<context-evidence>Project handbooks provide standing instructions and navigation hints. They do not establish current branch, HEAD, dirty files, task completion, or implementation behavior. For repository orientation use code_nav mode=project for current Git and recorded task observations, even without an index; on a gateway-only tool surface call gateway with op=call, capability=code_nav, args={mode:project}. Once a loaded skill narrows the tools and its allowed_tools omit code_nav, orient with the tools it allows instead. Read relevant definitions before making behavioral claims or proposing changes; label unverified facts as unknown. Preserve operator edits.</context-evidence>",
	];
	const pieces = [...supportFragments];
	const addSupport = (fragment: string): void => {
		pieces.push(fragment);
		supportFragments.push(fragment);
	};
	const warnings: string[] = [];
	let orientationObservedAt: string | undefined;
	// The operator's own standing instructions come first; every project handbook after them is more specific.
	const userHandbookPath = pancodeUserHandbookPath();
	const userHandbook = readUserHandbook(userHandbookPath);
	if (userHandbook !== null && "text" in userHandbook)
		pieces.push(renderUserContextFragment(userHandbook.text, userHandbookPath));
	else if (userHandbook !== null)
		warnings.push(`pancode: user handbook ${userHandbookPath} ignored: ${userHandbook.error}`);
	const loadedPancodeMd = loadProjectPancodeMd(cwd);
	const pancodeMd: ParsedPancodeMd | null = loadedPancodeMd.value;
	for (const file of loadedPancodeMd.files) pieces.push(renderProjectContextFragment(file.source, file.path));
	for (const issue of loadedPancodeMd.errors) {
		warnings.push(`pancode: unavailable ${issue.path} ignored: ${issue.error}`);
	}
	// Said where the handbook would have been: a model that sees no project
	// context spends its first tool call reading PANCODE.md and gets
	// ENOENT, while the operator's header already says it is missing (#191).
	const handbookSources = loadedPancodeMd.files.map(({ path, source }) => ({ path, source }));
	let compiledHandbook: ProjectPromptContext["compiledHandbook"];
	if (loadedPancodeMd.files.length === 0 && loadedPancodeMd.errors.length === 0) {
		const compiled = options.compile?.(cwd) ?? null;
		if (compiled) {
			pieces.push(renderProjectContextFragment(compiled.source, compiled.path));
			handbookSources.push({ path: compiled.path, source: compiled.source });
			compiledHandbook = { path: compiled.path, sources: compiled.sources, rules: compiled.rules };
		} else addSupport(HANDBOOK_ABSENT_FRAGMENT);
	}
	// Prompt assembly reports recorded snapshots. Current-tree validation belongs
	// to background lifecycle work and code_nav, never a synchronous full-tree
	// hash on the prompt/dispatch path. Presence does not certify parseability.
	if (codewikiArtifactPresent(cwd)) {
		addSupport("<codemap>available snapshot; freshness checked on retrieval; use code_nav</codemap>");
		if (state?.orientation) {
			const orientation = renderProjectOrientation(cwd, state.orientation, state.fingerprint);
			addSupport(orientation);
			if (!orientation.includes("snapshot unavailable")) orientationObservedAt = state.orientation.observedAt;
		} else
			addSupport(
				"<project-orientation>not recorded; use code_nav mode=project for project facts and current status</project-orientation>",
			);
	}
	// Read checkpoint metadata only. Markdown presence is not successful page
	// validation, and source freshness is checked when wiki context is retrieved.
	const meta = readWikiMeta(cwd);
	if (meta) {
		const completeness = wikiCompletenessFromMeta(meta);
		const notes = [`recorded ${meta.updatedAt}; source freshness unchecked here`];
		if (completeness && completeness.owed > 0)
			notes.push(
				`incomplete: ${completeness.pagesWritten} of ${completeness.pagesPlanned} planned pages validated, ${completeness.owed} owed`,
			);
		if (!completeness) notes.push("coverage unknown");
		const available = new Set(meta.pages.map((page) => page.path));
		if (meta.plan?.pages.some((page) => page.status !== "written" && available.has(page.path)))
			notes.push("published pages awaiting successful validation");
		addSupport(
			`<wiki>${meta.pages.length} recorded pages at .pancode/wiki (${notes.join("; ")}); use code_nav mode=wiki; verify claims against current source and evidence</wiki>`,
		);
	}

	return {
		text: pieces.join("\n\n"),
		pancodeMd,
		warnings,
		handbookFiles: loadedPancodeMd.files.map((file) => file.path),
		handbookSources,
		supportFragments,
		...(compiledHandbook ? { compiledHandbook } : {}),
		...(orientationObservedAt !== undefined ? { orientationObservedAt } : {}),
	};
}
