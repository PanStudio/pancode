// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
// Whether the right sidebar is expanded on a wide screen. It is a per-browser preference like the
// left rail's, shared by the shell (which lays out the column) and the pages that fill it.

import { useSyncExternalStore } from "react";
import { readPref, writePref } from "../interaction/prefs.js";

const ASIDE_KEY = "pancode-gui-aside";
const listeners = new Set<() => void>();

function read(): boolean {
	// Keep the conversation clear when no browser preference can be read.
	return readPref(ASIDE_KEY) === "expanded";
}

let expanded = read();

export function setAsideExpanded(next: boolean): void {
	if (next === expanded) return;
	expanded = next;
	writePref(ASIDE_KEY, next ? "expanded" : "collapsed");
	for (const listener of listeners) listener();
}

export function toggleAside(): void {
	setAsideExpanded(!expanded);
}

export function useAsideExpanded(): boolean {
	return useSyncExternalStore(
		(listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		() => expanded,
		() => false,
	);
}

/** The width at which the right sidebar docks beside the work; narrower, it opens over it. */
export const ASIDE_DOCK_QUERY = "(min-width: 1440px)";
