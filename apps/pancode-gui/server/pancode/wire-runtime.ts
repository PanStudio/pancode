// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
// Browser-safe ACP values, without pulling the wire validators into the shell.
export { ACP_MAX_JOBS } from "../../../../src/acp/runtime.js";

// The modules that own these numbers also build TypeBox schemas at load, which no browser chunk should carry.
// They are restated here; tests/contracts.test.ts holds each equal to its source.
export const ACP_TARGET_MODEL_LIMIT = 64;

export const MODEL_TARGET_PATHS: Readonly<Record<string, string>> = {
	"chat.model": "chat.connection",
	"fleet.default.model": "fleet.default.connection",
	"context.memory.model": "context.memory.connection",
	"context.compaction.model": "chat.connection",
};

export const MAX_SERVED_ARTIFACT_IDS = 64;

export const ASIDE_TEXT_MAX_CHARACTERS = 8000;
