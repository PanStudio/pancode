// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * Host and user identity for run receipts.
 *
 * Pure environment inspection, no I/O beyond os module lookups.
 */

import { hostname, userInfo } from "node:os";
import type { RunIdentity } from "./types.js";

function nonEmpty(value: string | undefined): string | null {
	return value !== undefined && value.trim().length > 0 ? value.trim() : null;
}

export function detectRunIdentity(env: NodeJS.ProcessEnv = process.env): RunIdentity {
	let user = "unknown";
	try {
		user =
			nonEmpty(userInfo().username) ?? nonEmpty(env.USER) ?? nonEmpty(env.LOGNAME) ?? nonEmpty(env.USERNAME) ?? "unknown";
	} catch {
		user = nonEmpty(env.USER) ?? nonEmpty(env.LOGNAME) ?? nonEmpty(env.USERNAME) ?? "unknown";
	}
	let host = "unknown";
	try {
		host = hostname() || "unknown";
	} catch {
		// Restricted environments may not expose a host identity.
	}
	return { host, user };
}
