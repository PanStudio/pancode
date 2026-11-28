// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import type { HostLaunchLabel } from "../../core/sandbox/host-launch.js";

/** read's window arguments plus the document-only ones. */
export interface DocumentRequest {
	numbered: boolean;
	offset: number;
	limit: number | null;
	tail: number | null;
	pages?: string;
	member?: string;
	signal: AbortSignal | undefined;
}

/** What a renderer produces: bounded text, or the reason it cannot; `launch` labels a host reader's run (P8). */
export type Rendered = { text: string; launch?: HostLaunchLabel } | { error: string };

/** Ceiling on the text one rendering produces; read's per-call cap windows it further. */
export const RENDER_CAP_BYTES = 4 * 1024 * 1024;
