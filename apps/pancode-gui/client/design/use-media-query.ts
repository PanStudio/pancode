// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { useEffect, useState } from "react";

/** Whether a media query matches, following its changes. `fallback` stands where there is no `matchMedia`. */
export function useMediaQuery(query: string, fallback = false): boolean {
	const [matches, setMatches] = useState(() =>
		typeof matchMedia === "function" ? matchMedia(query).matches : fallback,
	);
	useEffect(() => {
		if (typeof matchMedia !== "function") return;
		const list = matchMedia(query);
		const change = () => setMatches(list.matches);
		list.addEventListener("change", change);
		change();
		return () => list.removeEventListener("change", change);
	}, [query]);
	return matches;
}
