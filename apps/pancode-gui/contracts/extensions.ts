// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import {
	AcpExtensionReloadSchema,
	AcpHubReloadSchema,
	AcpSessionExtensionsSchema,
	AcpExtensionsCapability as ExtensionsCapability,
	AcpHubCapability as HubCapability,
} from "./wire.js";

export { ExtensionsCapability, HubCapability };

import type { Static } from "typebox";

// `_pancode/extensions/*` and `_pancode/hub/reload`: the terminal's /extensions view and the two
// reloads. The agent bounds extensions at 64, lines at 40 and every string at 512 bytes.

export const SessionExtensions = AcpSessionExtensionsSchema;
export type SessionExtensions = Static<typeof SessionExtensions>;

export const ExtensionReload = AcpExtensionReloadSchema;
export type ExtensionReload = Static<typeof ExtensionReload>;

export const HubReload = AcpHubReloadSchema;
