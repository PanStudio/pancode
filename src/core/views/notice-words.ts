// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/** Severity of a footer or overlay notification on the terminal surface. Browser-safe. */
export const NOTIFICATION_LEVELS = ["info", "success", "warning", "error"] as const;
export type NotificationLevel = (typeof NOTIFICATION_LEVELS)[number];

/** Severity of a transcript notice, shared by every surface that reports one. Ordered quietest first. */
export const NOTICE_LEVELS = ["info", "success", "warn", "error"] as const;
export type NoticeLevel = (typeof NOTICE_LEVELS)[number];
