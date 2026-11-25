// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { resolve } from "node:path";
import { sha256Hex } from "./hash.js";

/** The session store's bucket for a working directory: its resolved path, hashed. */
export function cwdHash(cwd: string): string {
	const normalized = resolve(cwd);
	return sha256Hex(normalized).slice(0, 16);
}
