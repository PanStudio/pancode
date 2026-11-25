// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import type { ChatLoop } from "../session-control/chat-loop.js";

type SessionSwitchChat = Pick<ChatLoop, "cancel" | "isStreaming" | "whenSettled">;

/** Settle an active turn before its owning session writer can be replaced. */
export function settleChatBeforeSessionSwitch(chat: SessionSwitchChat): Promise<void> | null {
	if (!chat.isStreaming()) return null;
	chat.cancel();
	return chat.whenSettled();
}
