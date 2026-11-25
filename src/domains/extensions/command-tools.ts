// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { extensionToolName } from "@pancode/sdk/pack";
import type { DynamicToolName } from "../../core/tool-names.js";
import { listInstalledExtensions } from "./state.js";
import { isLoadableExtension } from "./types.js";

/** Available names for dispatch planning; registry construction re-verifies captured declarations. */
export function enabledHarnessExtensionToolNames(cwd = process.cwd()): ReadonlySet<DynamicToolName> {
	return new Set(
		listInstalledExtensions(cwd)
			.filter(isLoadableExtension)
			.flatMap((entry) =>
				(entry.capabilities?.tools ?? []).map((tool) => extensionToolName(entry.id, tool.name) as DynamicToolName),
			),
	);
}
