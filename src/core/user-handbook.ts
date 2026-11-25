// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * The operator's user handbook: `<config>/PANCODE.md`, standing
 * instructions PanCode loads ahead of every project handbook. The context
 * domain reads it into the prompt; interop adoption writes the instruction
 * files other agents load for every session (~/.claude/CLAUDE.md,
 * ~/.codex/AGENTS.md) into it after review. Both go through this path and cap.
 */
import path from "node:path";
import { pancodeConfigDir } from "./xdg.js";

export const USER_HANDBOOK_FILENAME = "PANCODE.md";

/** Larger is refused, not cut: the file rides in every session's prompt. */
export const USER_HANDBOOK_MAX_BYTES = 32 * 1024;

export function pancodeUserHandbookPath(): string {
	return path.join(pancodeConfigDir(), USER_HANDBOOK_FILENAME);
}
