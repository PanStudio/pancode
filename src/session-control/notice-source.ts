// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * Who is speaking in a transcript advisory. An advisory is text addressed to
 * the operator, so it renders as a titled callout; a notice with no source is an
 * event (a bounded one-line state change) and keeps its gutter row. The choice
 * is made by the emitting source and never by terminal width.
 */

import type { NoticeLevel } from "../core/views/notice-words.js";

const NOTICE_SOURCES = [
	"tip",
	"reminder",
	"memory",
	"watchdog",
	"images",
	"approval",
	"budget",
	"safety",
	"fleet",
	"hooks",
] as const;

export type NoticeSource = (typeof NOTICE_SOURCES)[number];

export function isNoticeSource(value: unknown): value is NoticeSource {
	return typeof value === "string" && (NOTICE_SOURCES as readonly string[]).includes(value);
}

export type { NoticeLevel };
