// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * An instruction file another agent loads into every session
 * (~/.claude/CLAUDE.md, ~/.codex/AGENTS.md) adopted into the operator's user
 * handbook (core/user-handbook.ts), which PanCode loads ahead of project
 * handbooks. Each source owns one marked section, so adopting a host again
 * replaces only its own section and leaves the operator's writing alone.
 */

import { existsSync, readFileSync } from "node:fs";
import { sha256Hex } from "../../core/hash.js";
import { safeResourceWrite } from "../../core/safe-resource-write.js";
import { pancodeUserHandbookPath, USER_HANDBOOK_MAX_BYTES } from "../../core/user-handbook.js";
import { inventoryText } from "./inventory.js";
import type { InteropAgentId, InteropInventoryItem } from "./types.js";

const HEADER =
	"# User handbook\n\nPanCode loads this file ahead of project handbooks in every session. Sections between pancode markers were adopted from other coding agents; `pancode interop adopt` replaces only its own sections.\n";

export type InstructionsAdoption =
	| { ok: true; destination: string; digest: string; section: string; replaces: boolean; notes: string[] }
	| { ok: false; reason: string };

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sectionPattern(host: InteropAgentId, name: string): RegExp {
	const id = `${escapeRegExp(host)} ${escapeRegExp(name)}`;
	return new RegExp(`<!-- pancode:adopted ${id} sha256=([0-9a-f]{64}) -->\\n[\\s\\S]*?\\n<!-- pancode:end ${id} -->`);
}

function currentHandbook(destination: string): string | null {
	return existsSync(destination) ? readFileSync(destination, "utf8") : null;
}

function merged(existing: string | null, pattern: RegExp, section: string): string {
	if (existing === null || existing.trim().length === 0) return `${HEADER}\n${section}\n`;
	if (pattern.test(existing)) return existing.replace(pattern, () => section);
	return `${existing.replace(/\s*$/, "")}\n\n${section}\n`;
}

/** Plan one instruction file into its section of the user handbook. */
export function planInstructionsAdoption(item: InteropInventoryItem, host: InteropAgentId): InstructionsAdoption {
	if (item.scope !== "user")
		return {
			ok: false,
			reason: "Project instruction files reach PanCode through the compiled handbook or `pancode context init --adopt`.",
		};
	let body: string;
	try {
		body = inventoryText(item.path).trim();
	} catch (error) {
		return { ok: false, reason: `Cannot read ${item.path}: ${error instanceof Error ? error.message : String(error)}` };
	}
	if (body.length === 0) return { ok: false, reason: "Empty; nothing to adopt." };
	if (body.includes("<!-- pancode:"))
		return { ok: false, reason: "Contains pancode section markers; adopt it by hand." };
	const digest = sha256Hex(body);
	const id = `${host} ${item.name}`;
	const section = `<!-- pancode:adopted ${id} sha256=${digest} -->\n## Adopted from ${item.path}\n\n${body}\n<!-- pancode:end ${id} -->`;
	const destination = pancodeUserHandbookPath();
	let existing: string | null;
	try {
		existing = currentHandbook(destination);
	} catch (error) {
		return { ok: false, reason: `Cannot read ${destination}: ${error instanceof Error ? error.message : String(error)}` };
	}
	const pattern = sectionPattern(host, item.name);
	const previous = existing === null ? null : pattern.exec(existing);
	if (previous?.[1] === digest) return { ok: false, reason: "Already adopted: same content in your user handbook." };
	const next = merged(existing, pattern, section);
	if (Buffer.byteLength(next) > USER_HANDBOOK_MAX_BYTES)
		return {
			ok: false,
			reason: `The user handbook would exceed ${USER_HANDBOOK_MAX_BYTES} bytes, which PanCode refuses to load; shorten ${item.path} or ${destination} first.`,
		};
	const imports = body.split("\n").filter((line) => /^@\S/.test(line.trim())).length;
	return {
		ok: true,
		destination,
		digest,
		section,
		replaces: previous !== null,
		notes: imports > 0 ? [`${imports} @import line(s) are copied as text; the files they name are not read`] : [],
	};
}

/** Write the reviewed section, re-reading the source and the handbook first. */
export function applyInstructionsAdoption(
	item: InteropInventoryItem,
	host: InteropAgentId,
	reviewedDigest: string,
): { ok: true; destination: string } | { ok: false; reason: string } {
	const current = planInstructionsAdoption(item, host);
	if (!current.ok) return current;
	if (current.digest !== reviewedDigest)
		return { ok: false, reason: "Source changed after review; inspect a new plan." };
	const next = merged(currentHandbook(current.destination), sectionPattern(host, item.name), current.section);
	safeResourceWrite(current.destination, next);
	return { ok: true, destination: current.destination };
}
