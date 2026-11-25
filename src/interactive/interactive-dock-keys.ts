// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

/** The files and music dock keys: a first tap shows or hides the pane, a second inside the window closes it. */
import type { DockKeyGate } from "../domains/mux/dock-keys.js";
import type { MusicResult } from "../domains/mux/music-operations.js";
import { describeMusicResult, musicResultTone } from "../domains/mux/music-operations.js";
import { panesInactiveWords } from "../session-control/slash-commands.js";
import type { InteractiveDeps } from "./interactive-deps.js";
import type { InteractivePresentation } from "./interactive-presentation.js";

/** Where a dock key arrived: PanCode's composer, or from inside the dock pane itself. */
export type DockKeyOrigin = "composer" | "dock";

export const pressFilesKey = (
	deps: InteractiveDeps,
	notify: InteractivePresentation["notify"],
	dockKeys: DockKeyGate,
	origin: DockKeyOrigin,
): void => {
	const panes = deps.panes;
	if (!panes) {
		notify("info", panesInactiveWords("the files pane is inactive"), "files:info");
		return;
	}
	void dockKeys.press("files", {
		single: async () => {
			const result = await panes.files("toggle");
			if (result.status === "opened") {
				if (result.paneId !== null) {
					notify(
						"success",
						result.revealed ? "files pane shown" : result.existing ? "files pane focused" : "files pane opened",
						"files:open",
					);
				}
			} else if (result.status === "hidden") {
				if (origin === "dock") await deps.mux?.focusSelf();
				notify("info", "files pane hidden, still running; the key shows it again, twice quickly closes it", "files:hide");
			} else if (result.status === "closed") notify("info", "files pane closed", "files:close");
			else if (result.status === "missing-binary") notify("warning", result.detail, "files:missing");
			else notify("warning", result.reason, "files:refused");
		},
		double: async () => {
			await panes.files("close");
			if (origin === "dock") await deps.mux?.focusSelf();
			notify("info", "files pane closed", "files:close");
		},
	});
};

export const pressMusicKey = (
	deps: InteractiveDeps,
	notify: InteractivePresentation["notify"],
	dockKeys: DockKeyGate,
	origin: DockKeyOrigin,
): void => {
	const music = deps.music;
	if (!music) {
		notify(
			"info",
			"music needs the pane layer: restart inside herdr with `pancode --with-panes`, then use /music",
			"music:info",
		);
		return;
	}
	const report = (result: MusicResult): void => {
		const tone = musicResultTone(result);
		notify(tone === "problem" ? "warning" : tone, describeMusicResult(result), "music:toggle");
	};
	void dockKeys.press("music", {
		single: async () => {
			const result = await music.toggle();
			if (origin === "dock" && result.status === "hidden") await deps.mux?.focusSelf();
			report(result);
		},
		double: async () => {
			const result = await music.off();
			if (origin === "dock") await deps.mux?.focusSelf();
			report(result);
		},
	});
};
