// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
// Whether the pane is open and which view it shows. Docked, it is the shell's right sidebar and its
// open state is the shell's per-browser preference; as a slide-over on a narrow screen it opens only
// when asked, for this view.

import { useCallback, useRef, useState, useSyncExternalStore } from "react";
import { useMediaQuery } from "../design/use-media-query.js";
import { readPref, writePref } from "../interaction/prefs.js";
import { ASIDE_DOCK_QUERY, setAsideExpanded, useAsideExpanded } from "../shell/aside-state.js";
import { type PaneSection, type PaneTarget, paneTargetParts } from "./pane-context.js";
import { isPaneView, type PaneView, ROOT_VIEW } from "./pane-model.js";

const VIEW_KEY = "pancode-gui-pane-view";

function initialView(): PaneView {
	const stored = readPref(VIEW_KEY);
	return isPaneView(stored) ? stored : ROOT_VIEW;
}

// The section the last show asked for, until the drill that holds it has shown it. The page that
// owns the pane hands it only the view, so the request is kept here beside it; one session page is
// mounted at a time, and any other navigation of the pane drops it.
let requestedSection: PaneSection | null = null;
const sectionListeners = new Set<() => void>();

function requestSection(section: PaneSection | null): void {
	if (requestedSection === section) return;
	requestedSection = section;
	for (const listener of sectionListeners) listener();
}

function subscribeSection(listener: () => void): () => void {
	sectionListeners.add(listener);
	return () => sectionListeners.delete(listener);
}

const settleSection = () => requestSection(null);

/** The section a show asked the pane to open at, and how its drill says it has been shown. */
export function usePaneSection(): { section: PaneSection | null; settle: () => void } {
	const section = useSyncExternalStore(subscribeSection, () => requestedSection);
	return { section, settle: settleSection };
}

export interface PaneState {
	readonly open: boolean;
	readonly view: PaneView;
	/**
	 * Open the pane on a view, or at a section of one. `trigger` is the id of the control to return
	 * focus to on close.
	 */
	show(target: PaneTarget, trigger: string): void;
	/** Open the pane, or close it when it is already showing this view. */
	toggle(view: PaneView, trigger: string): void;
	close(): void;
	setView(view: PaneView): void;
}

export function usePaneState(fallbackTrigger: string): PaneState {
	const [view, setViewState] = useState<PaneView>(initialView);
	const expanded = useAsideExpanded();
	const wide = useMediaQuery(ASIDE_DOCK_QUERY);
	const [slideOver, setSlideOver] = useState(false);
	// A slide-over does not outlive a change of layout.
	const [layout, setLayout] = useState(wide);
	if (layout !== wide) {
		setLayout(wide);
		setSlideOver(false);
	}
	const opener = useRef<string | null>(null);
	const open = wide ? expanded : slideOver;
	const setOpen = useCallback(
		(next: boolean) => {
			if (wide) setAsideExpanded(next);
			else setSlideOver(next);
		},
		[wide],
	);
	const storeView = useCallback((next: PaneView) => {
		setViewState(next);
		writePref(VIEW_KEY, next);
	}, []);
	const setView = useCallback(
		(next: PaneView) => {
			requestSection(null);
			storeView(next);
		},
		[storeView],
	);
	const close = useCallback(() => {
		requestSection(null);
		const dismissed = document.activeElement;
		setOpen(false);
		requestAnimationFrame(() => {
			const current = document.activeElement;
			if (current === dismissed || current === document.body || current?.closest(".pane"))
				document.getElementById(opener.current ?? fallbackTrigger)?.focus();
		});
	}, [fallbackTrigger, setOpen]);
	const show = useCallback(
		(target: PaneTarget, trigger: string) => {
			const { view: next, section } = paneTargetParts(target);
			opener.current = trigger;
			requestSection(section);
			storeView(next);
			setOpen(true);
		},
		[storeView, setOpen],
	);
	const toggle = useCallback(
		(next: PaneView, trigger: string) => {
			if (open && view === next) close();
			else show(next, trigger);
		},
		[open, view, close, show],
	);
	return { open, view, show, toggle, close, setView };
}
