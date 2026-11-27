// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import type { DomainModule } from "../../core/domain-loader.js";
import { createMuxBundle, detectMuxFor, type MuxDomainOptions } from "./extension.js";
import { MuxManifest } from "./manifest.js";

/** Parameterized module for callers that gate panes off or on explicitly. */
export function createMuxDomainModule(options: MuxDomainOptions): DomainModule<"mux"> {
	// An idle pane host answers a ping on its next 100 ms tick. Asked when the module is listed, the answer arrives
	// while the domains ahead of this one load; asked from the loader, every domain behind it waited out the tick.
	const detecting = detectMuxFor(options);
	// A failure belongs to the loader, which awaits this same promise; until then it must not count as unhandled.
	detecting.catch(() => undefined);
	return {
		manifest: MuxManifest,
		createExtension: (context) => createMuxBundle(context, options, detecting),
	};
}
