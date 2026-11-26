// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
// A `<details>` used as a small menu closes the way a menu does: on a press anywhere outside it, and
// on Escape pressed inside it, which also hands focus back to its summary. Session tools and the
// composer's route picker share this, so the two disclosures cannot drift apart.

import { type RefObject, useEffect } from "react";

/**
 * The handlers read the element's own `open`, not the caller's state: that state follows the `toggle`
 * event, which the browser queues after the click that opened the menu, so an Escape or a press that
 * arrives first would find no listener and leave the menu open.
 */
export function useDetailsDismiss(panel: RefObject<HTMLDetailsElement | null>): void {
	useEffect(() => {
		const closeOutside = (event: PointerEvent) => {
			if (panel.current?.open && event.target instanceof Node && !panel.current.contains(event.target))
				panel.current.open = false;
		};
		const closeOnEscape = (event: KeyboardEvent) => {
			if (event.key !== "Escape" || !panel.current?.open) return;
			if (!(event.target instanceof Node) || !panel.current.contains(event.target)) return;
			event.preventDefault();
			panel.current.open = false;
			panel.current.querySelector("summary")?.focus();
		};
		document.addEventListener("pointerdown", closeOutside);
		document.addEventListener("keydown", closeOnEscape);
		return () => {
			document.removeEventListener("pointerdown", closeOutside);
			document.removeEventListener("keydown", closeOnEscape);
		};
	}, [panel]);
}
