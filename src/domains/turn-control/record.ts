// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import type { WorkflowDecision } from "./decide.js";

export interface TurnControlRecord {
	readonly version: 1;
	readonly turnId: string;
	readonly factsDigest: string;
	readonly decision: WorkflowDecision;
	readonly decisionHash: string;
	readonly executed:
		| { runIds: ReadonlyArray<string>; blockChars: number; durationMs: number }
		| { refused: string; startedRunIds?: ReadonlyArray<string> }
		| null;
}
