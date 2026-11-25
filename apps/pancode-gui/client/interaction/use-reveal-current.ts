// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { useLayoutEffect, useRef } from "react";
import { revealScroll } from "./reveal-model.js";

const CURRENT = ':scope > [aria-current="page"], :scope > [aria-pressed="true"], :scope > [aria-selected="true"]';

/**
 * Keeps a scrolling tab bar's current tab in view, so a narrow screen opened on its last tab shows it
 * (gui-verify 9). `current` names the tab. The bar scrolls when it mounts and when `current` changes, never
 * on other renders, so a bar the operator scrolled by hand stays where they left it. Only the bar scrolls.
 */
export function useRevealCurrent<T extends HTMLElement>(current: unknown) {
	const bar = useRef<T>(null);
	const revealed = useRef<{ node: T; current: unknown } | null>(null);
	useLayoutEffect(() => {
		const node = bar.current;
		if (!node || (revealed.current?.node === node && Object.is(revealed.current.current, current))) return;
		const tab = node.querySelector<HTMLElement>(CURRENT);
		if (!tab) return;
		revealed.current = { node, current };
		const start = tab.getBoundingClientRect().left - node.getBoundingClientRect().left + node.scrollLeft;
		const next = revealScroll(node.scrollLeft, node.clientWidth, start, tab.offsetWidth);
		if (next !== node.scrollLeft) node.scrollLeft = next;
	});
	return bar;
}
