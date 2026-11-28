// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/** The roles a dispatched run can hold (fleet DESIGN 4.2), in the order settings and journals list them. */
export const RUN_ROLES = ["builder", "explorer", "seat", "checker", "reviewer", "judge"] as const;
export type RunRole = (typeof RUN_ROLES)[number];
