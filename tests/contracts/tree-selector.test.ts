// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { deepStrictEqual, doesNotMatch, match, strictEqual } from "node:assert/strict";
import { it } from "node:test";
import type { MessageEntry } from "../../src/domains/session/entries.js";
import type { TreeSnapshot } from "../../src/domains/session/tree/navigator.js";
import { buildEntryPreviews, buildTurnPreview } from "../../src/domains/session/tree/preview.js";
import { stripTerminalSequences } from "../../src/engine/tui.js";
import { listJump, scrollJump } from "../../src/interactive/overlays/confirm-once.js";
import { TreeOverlayView } from "../../src/interactive/overlays/tree-selector.js";

it("previews operator words instead of injected scaffolding and identifies tool-only assistant turns", () => {
	const text = "<system-reminder>Marketplace guidance</system-reminder>\nImplement clearQueue reasons";
	for (const payload of [{ text, operatorText: "Implement clearQueue reasons" }, { text }]) {
		strictEqual(buildTurnPreview({ kind: "user", payload }), "Implement clearQueue reasons");
	}
	strictEqual(buildTurnPreview({ kind: "user", payload: { text, displayText: "/review queue" } }), "/review queue");
	match(
		buildTurnPreview({ kind: "assistant", payload: { text: "", content: [{ type: "toolCall", name: "read" }] } }),
		/tool calls.*read/u,
	);
});

it("reads the entry a finish call leaves as the reply it closed, not as an empty turn", () => {
	const message = (turnId: string, parentTurnId: string | null, role: MessageEntry["role"], payload: unknown) =>
		({ kind: "message", turnId, parentTurnId, timestamp: "2026-09-01T00:00:00Z", role, payload }) satisfies MessageEntry;
	const finished = (turnId: string, parentTurnId: string) =>
		message(turnId, parentTurnId, "assistant", {
			text: "",
			stopReason: "stop",
			terminalToolResult: true,
			toolCallId: `call-${turnId}`,
			toolName: "finish",
		});
	const finishCall = { type: "toolCall", name: "finish", arguments: { state: "done" } };
	const previews = buildEntryPreviews([
		message("ask", null, "user", { text: "Add multiply" }),
		message("said", "ask", "assistant", {
			text: "Added multiply to src/math.mjs.",
			content: [{ type: "text", text: "Added multiply to src/math.mjs." }, finishCall],
		}),
		message("call", "said", "tool_call", { toolCallId: "c1", name: "finish", args: { state: "done" } }),
		message("result", "call", "tool_result", { toolCallId: "c1", toolName: "finish", result: "completion declared" }),
		finished("end", "result"),
		message("again", "end", "user", { text: "Now stop" }),
		message("silent", "again", "assistant", { text: "", content: [finishCall], stopReason: "toolUse" }),
		finished("bare", "silent"),
	]);
	strictEqual(previews.get("end"), "Added multiply to src/math.mjs.");
	strictEqual(previews.get("bare"), "(ended by finish)");
	strictEqual(previews.get("ask"), "Add multiply");
});

function fixture(cwd = "/workspace") {
	const snapshot: TreeSnapshot = {
		sessionId: "session",
		meta: { id: "session", cwd, createdAt: "2026-09-01T00:00:00Z", endedAt: null, model: null, target: null },
		leafId: "newest",
		rootIds: ["oldest"],
		nodesById: {
			oldest: {
				id: "oldest",
				preview: "oldest",
				parentId: null,
				at: "2026-09-01T00:00:00Z",
				kind: "user",
				children: ["branch", "newest"],
			},
			branch: {
				id: "branch",
				preview: "branch",
				parentId: "oldest",
				at: "2026-09-02T00:00:00Z",
				kind: "assistant",
				children: ["marker"],
			},
			marker: {
				id: "marker",
				preview: "marker",
				parentId: "branch",
				at: "2026-09-02T00:00:00Z",
				kind: "compaction",
				children: [],
			},
			newest: {
				id: "newest",
				preview: "newest",
				parentId: "oldest",
				at: "2026-09-03T00:00:00Z",
				kind: "assistant",
				children: [],
			},
		},
	};
	const switched: string[] = [];
	const edits: unknown[] = [];
	let closed = 0;
	const view = new TreeOverlayView(
		{
			cwd: "/workspace/./",
			session: {
				tree: () => snapshot,
				editLabel: (id, label, sessionId) => {
					edits.push([id, label, sessionId]);
					const node = snapshot.nodesById[id];
					if (node) node.label = label;
				},
			},
			onSwitchTurn: (id) => {
				switched.push(id);
			},
			onClose: () => {
				closed++;
			},
		},
		snapshot,
	);
	const text = () => stripTerminalSequences(view.render(86).join("\n"));
	const order = () =>
		[...text().matchAll(/(?:You|Panos|Compacted)\s+(oldest|branch|marker|newest)\b/gu)].map((entry) => entry[1]);
	return { snapshot, view, text, order, switched, edits, closed: () => closed };
}

it("toggles the cwd filter and can recover from an empty filtered list", () => {
	const f = fixture("/another-workspace");
	f.view.handleInput("p");
	match(f.text(), /no turns match the current cwd/u);
	doesNotMatch(f.text(), /oldest/u);
	match(stripTerminalSequences(f.view.getHint()), /folder: this/u);
	f.view.handleInput("\r");
	deepStrictEqual(f.switched, []);
	f.view.handleInput("o");
	f.view.handleInput("p");
	deepStrictEqual(f.order(), ["newest", "branch", "marker", "oldest"]);
	f.view.handleInput("\r");
	deepStrictEqual(f.switched, ["newest"]);
	strictEqual(f.closed(), 1);
});

it("keeps nodes from a session whose normalized cwd matches", () => {
	const f = fixture();
	f.view.handleInput("p");
	deepStrictEqual(f.order(), ["oldest", "branch", "marker", "newest"]);
});

it("cycles sort order with stable timestamp ties and preserves the selected turn", () => {
	const f = fixture();
	f.view.handleInput("\u001b[B");
	f.view.handleInput("o");
	deepStrictEqual(f.order(), ["newest", "branch", "marker", "oldest"]);
	match(f.text(), /❯.*branch/u);
	f.view.handleInput("o");
	deepStrictEqual(f.order(), ["oldest", "branch", "marker", "newest"]);
	f.view.handleInput("s");
	deepStrictEqual(f.order(), ["oldest", "branch", "marker", "newest"], "s moved to o and does nothing");
	f.view.handleInput("\r");
	deepStrictEqual(f.switched, ["branch"]);
});

it("treats p and s as label text while editing and retains filtering and sorting after refresh", () => {
	const f = fixture();
	f.view.handleInput("p");
	f.view.handleInput("o");
	f.view.handleInput("e");
	f.view.handleInput("p");
	f.view.handleInput("s");
	f.view.handleInput("\r");
	deepStrictEqual(f.edits, [["oldest", "ps", "session"]]);
	deepStrictEqual(f.order(), ["newest", "branch", "marker", "oldest"]);
	match(stripTerminalSequences(f.view.getHint()), /folder: this.*order: newest/u);
	match(f.text(), /label:"ps"/u);
});

it("keeps structural rows inert after sorting", () => {
	const f = fixture();
	f.view.handleInput("o");
	f.view.handleInput("\u001b[A");
	f.view.handleInput("\r");
	deepStrictEqual(f.switched, []);
	strictEqual(f.closed(), 0);
	match(f.text(), /not a place to switch/u);
});

it("pages with PgDn and PgUp and jumps with End and Home, clamped at either end", () => {
	const f = fixture();
	f.view.handleInput("\u001b[6~");
	match(f.text(), /❯.*newest/u);
	f.view.handleInput("\u001b[5~");
	match(f.text(), /❯.*oldest/u);
	f.view.handleInput("\u001b[F");
	match(f.text(), /❯.*newest/u);
	f.view.handleInput("\u001b[H");
	match(f.text(), /❯.*oldest/u);
});

it("j and k move the selection like Down and Up (E-13)", () => {
	const f = fixture();
	f.view.handleInput("j");
	f.view.handleInput("\r");
	f.view.handleInput("k");
	f.view.handleInput("\r");
	strictEqual(f.switched.length, 2);
	strictEqual(f.switched[0] !== f.switched[1], true, "j and k selected different turns");
});

it("list and scroll paging stop at their ends; End needs a known bottom (E-13)", () => {
	strictEqual(listJump("\x1b[6~", 0, 25), 10);
	strictEqual(listJump("\x1b[6~", 20, 25), 24);
	strictEqual(listJump("\x1b[5~", 3, 25), 0);
	strictEqual(listJump("\x1b[F", 3, 25), 24);
	strictEqual(listJump("x", 3, 25), null);
	strictEqual(scrollJump("\x1b[6~", 0), 10);
	strictEqual(scrollJump("\x1b[6~", 0, 4), 4);
	strictEqual(scrollJump("\x1b[H", 7), 0);
	strictEqual(scrollJump("\x1b[F", 7, 30), 30);
	strictEqual(scrollJump("\x1b[F", 7), null, "a body with no known bottom leaves End alone");
});
