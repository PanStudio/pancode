// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import type { Permission } from "../../contracts/permissions.js";

// Kept apart from approval-model.ts so the app shell can ask "is anything waiting" without loading the
// whole approval model, which the task screen alone needs.
export const isAwaitingAnswer = (permission: Pick<Permission, "status">): boolean =>
	permission.status === "pending" || permission.status === "escalated";
