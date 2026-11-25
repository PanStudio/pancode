// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
// Runs before first paint; explicit choices take priority over the sanctioned default.
(() => {
	const defaultTheme = document.querySelector('meta[name="pancode-default-theme"]')?.content ?? "dark";
	const requested = new URLSearchParams(location.search).get("theme");
	let saved;
	try {
		saved = localStorage.getItem("pancode-theme");
	} catch {
		/* Storage is optional. */
	}
	const theme = ["light", "dark"].includes(requested)
		? requested
		: ["light", "dark"].includes(saved)
			? saved
			: defaultTheme === "system"
				? matchMedia("(prefers-color-scheme: light)").matches
					? "light"
					: "dark"
				: defaultTheme === "light"
					? "light"
					: "dark";
	document.documentElement.dataset.theme = theme;
	const paper = getComputedStyle(document.documentElement).getPropertyValue("--paper").trim();
	for (const meta of document.querySelectorAll('meta[name="theme-color"]')) meta.content = paper;
})();
