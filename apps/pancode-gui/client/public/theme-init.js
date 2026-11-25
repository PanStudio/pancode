// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
(() => {
	const root = document.documentElement;
	// A new install paints dark; client/shell/theme.ts holds the same default.
	let choice = "dark";
	try {
		const saved = localStorage.getItem("pancode-gui-theme");
		if (saved === "light" || saved === "dark" || saved === "system") choice = saved;
	} catch {
		// Blocked storage keeps the default for first paint.
	}
	if (choice !== "system") root.dataset.theme = choice;
	const theme = choice === "system" ? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light") : choice;
	root.style.colorScheme = theme;
	const paper = getComputedStyle(root).getPropertyValue("--paper").trim();
	const meta = document.querySelector('meta[name="theme-color"]');
	if (meta) {
		meta.setAttribute("content", paper || meta.dataset[theme] || meta.content);
		root.style.backgroundColor = `var(--paper, ${meta.content})`;
	}
})();
