// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
(() => {
	const filter = document.querySelector("[data-hub-filter]");
	if (!filter) return;
	const input = filter.querySelector("input");
	const count = filter.querySelector("[data-hub-count]");
	const groups = [...document.querySelectorAll("[data-hub-group]")];
	const rows = groups.flatMap((group) => [...group.querySelectorAll("[data-hub-text]")]);
	const apply = () => {
		const words = input.value.toLowerCase().split(/\s+/).filter(Boolean);
		let shown = 0;
		for (const group of groups) {
			let inGroup = 0;
			for (const row of group.querySelectorAll("[data-hub-text]")) {
				const text = row.getAttribute("data-hub-text");
				const match = words.every((word) => text.includes(word));
				row.hidden = !match;
				if (match) inGroup++;
			}
			group.hidden = inGroup === 0;
			const label = group.querySelector("[data-hub-group-count]");
			if (label) label.textContent = String(inGroup);
			shown += inGroup;
		}
		count.textContent = shown
			? `${shown} of ${rows.length} packs`
			: `No pack matches. ${rows.length} packs in all; clear the filter to see them.`;
	};
	input.addEventListener("input", apply);
	input.addEventListener("keydown", (event) => {
		if (event.key !== "Escape" || !input.value) return;
		event.preventDefault();
		input.value = "";
		apply();
	});
	filter.hidden = false;
	if (input.value) apply();
})();
