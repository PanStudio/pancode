// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/** Candidate names for drafts and asides, in the order the rounds were started. Browser-safe. */
export const DRAFT_LABELS = ["A", "B", "C", "D"] as const;
export type DraftLabel = (typeof DRAFT_LABELS)[number];
