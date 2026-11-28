// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
// The drafts this window created, so "New task" reuses only its own (#420). sessionStorage is the
// narrowest identity that survives reload without sharing writes between normal new tabs or windows
// opened through openAppWindow (noopener). Browser duplication or opener-based creation can clone it.

import { sessionStringList } from "../chat/draft-registry.js";
import { withOwnDraft } from "./shell-model.js";

const OWN_DRAFTS_KEY = "pancode-own-drafts";

export function ownDrafts(): string[] {
	return sessionStringList(OWN_DRAFTS_KEY);
}

export function rememberOwnDraft(id: string): void {
	try {
		sessionStorage.setItem(OWN_DRAFTS_KEY, JSON.stringify(withOwnDraft(ownDrafts(), id)));
	} catch {
		// Without storage this window forgets its draft, and the next New task starts a fresh session instead.
	}
}
