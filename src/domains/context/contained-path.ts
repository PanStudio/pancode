// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { realpathSync } from "node:fs";
import { isSameOrDescendant } from "../../core/path-containment.js";

/**
 * Whether `path`, with every link resolved, stays inside `root`. A path that
 * cannot be resolved is not inside: a repository may ship links, and a link
 * that leaves the checkout must not pull outside files into project context.
 */
export function realpathInside(path: string, root: string): boolean {
	try {
		return isSameOrDescendant(realpathSync(path), realpathSync(root));
	} catch {
		return false;
	}
}
