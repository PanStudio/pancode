// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/** The project surfaces `pancode config trust` reviews and approves, in review order. Browser-safe. */
export const PROJECT_TRUST_SURFACES = ["safety", "hooks", "settings", "extensions", "plugins", "handbook"] as const;
export type ProjectTrustSurface = (typeof PROJECT_TRUST_SURFACES)[number];
