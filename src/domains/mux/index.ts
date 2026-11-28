// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
export type { MuxContract, MuxOpenUtilityPaneRequest, MuxPaneOpenFailure } from "./contract.js";
export { detectMux, resolveSocketCandidates } from "./detect.js";
export { MUX_METHOD_MIN_PROTOCOL } from "./protocol.js";
export { createMuxClient } from "./socket-client.js";
export type { MuxLog, MuxPaneRecord, MuxPaneRef } from "./types.js";
export {
	describeYaziProfile,
	ensureYaziProfile,
	inspectCurrentYaziProfile,
	resetYaziProfile,
	userYaziConfigDir,
	yaziProfileDir,
} from "./yazi/profile.js";
