// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/** The dispatch domain's best-effort stderr diagnostic line, shared by the bundle and the modules lifted from it. */

import { writeDiagnostic } from "../../core/diagnostics.js";

export function reportDispatchDiagnostic(scope: string, error: unknown): void {
	const message = error instanceof Error ? error.message : String(error);
	try {
		writeDiagnostic(`[pancode:dispatch] ${scope}: ${message}\n`);
	} catch {
		// stderr itself is best-effort
	}
}
