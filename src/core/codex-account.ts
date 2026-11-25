// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { sha256Hex } from "./hash.js";

/** OAI-1 / #423: compare the request's account without persisting its id or token. */
export function codexAccountScope(accessToken: string | undefined): string | null {
	if (!accessToken) return null;
	try {
		const payload = JSON.parse(Buffer.from(accessToken.split(".")[1] ?? "", "base64url").toString("utf8"));
		const account = payload?.["https://api.openai.com/auth"]?.chatgpt_account_id;
		return typeof account === "string" && account.length > 0 ? sha256Hex(account) : null;
	} catch {
		// Non-JWT and malformed credentials cannot identify a subscription account.
		return null;
	}
}
