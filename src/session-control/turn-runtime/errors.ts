// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

/**
 * A turn that never started, with a machine-readable reason attached. The
 * operator-facing message is unchanged prose; `reason` exists because the ACP
 * server has to tell a client *why* PanCode refused to admit the prompt, and
 * parsing that out of the prose would bind a wire contract to a sentence.
 */
export class TurnAdmissionError extends Error {
	constructor(
		message: string,
		readonly reason: string,
	) {
		super(message);
		this.name = "TurnAdmissionError";
	}
}
