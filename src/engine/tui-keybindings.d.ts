// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import type { PancodeAppKeybindings } from "../domains/config/keybindings.js";

// Keep Pi's ambient augmentation at the engine boundary; action IDs remain PanCode-owned.
declare module "@earendil-works/pi-tui" {
	interface Keybindings extends PancodeAppKeybindings {}
}
