// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { defineCommandSpec, type LeafFlagsSpec } from "../lib/help.js";

export const spec = defineCommandSpec({
	path: ["auth"],
	summary: "list, check, sign in to or sign out of connection and runtime credentials",
	hidden: false,
});

/** `auth login --api-key` stores the key in the credential store under the runtime id (SPEC 6.4, review R08). */
export const leafFlags: ReadonlyArray<LeafFlagsSpec> = [
	{
		path: ["auth", "login"],
		flags: [{ name: "--api-key", value: "string", placement: "leaf", persistence: "persisted" }],
	},
];
