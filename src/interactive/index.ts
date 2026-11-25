// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { createInteractiveApplication } from "./interactive-application.js";
import type { InteractiveDeps } from "./interactive-deps.js";

export * from "./interactive-application.js";

/**
 * Process-boundary composition entry point. The application module owns the
 * terminal lifecycle while its collaborators own independently testable state.
 */
export async function startInteractive(deps: InteractiveDeps): Promise<number> {
	return createInteractiveApplication(deps);
}
