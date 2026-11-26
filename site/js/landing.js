// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
(() => {
	if (!("IntersectionObserver" in window)) return;
	const reduced = matchMedia("(prefers-reduced-motion: reduce)");

	// The PAN art draws its routes once in view and runs its signals only while seen.
	const stages = [...document.querySelectorAll(".pan-stage")];
	const seen = new Set();
	const stageObserver = new IntersectionObserver(
		(entries) => {
			for (const entry of entries) {
				if (entry.isIntersecting) seen.add(entry.target);
				else seen.delete(entry.target);
				setStage(entry.target);
			}
		},
		{ threshold: 0.25 },
	);
	function setStage(stage) {
		if (reduced.matches) stage.dataset.pan = "idle";
		else if (seen.has(stage) && !document.hidden) stage.dataset.pan = "live";
		else if (stage.dataset.pan !== "pending") stage.dataset.pan = "idle";
	}
	if (!reduced.matches) for (const stage of stages) stage.dataset.pan = "pending";
	for (const stage of stages) stageObserver.observe(stage);
	document.addEventListener("visibilitychange", () => stages.forEach(setStage));

	// The hero terminal replays its final screen row by row, once.
	const term = document.querySelector(".term[data-term]");
	const rows = term ? [...term.querySelectorAll(".t-row")] : [];
	let timer = 0;
	const finishTerm = () => {
		clearTimeout(timer);
		for (const row of rows) row.classList.add("is-in");
		if (term) term.dataset.term = "done";
	};
	if (term && !reduced.matches && term.getBoundingClientRect().bottom > 0) {
		term.dataset.term = "pending";
		const termObserver = new IntersectionObserver(
			(entries) => {
				if (!entries.some((entry) => entry.isIntersecting)) return;
				termObserver.disconnect();
				let index = 0;
				const next = () => {
					rows[index++]?.classList.add("is-in");
					if (index < rows.length) timer = setTimeout(next, 180);
					else finishTerm();
				};
				next();
			},
			{ threshold: 0.4 },
		);
		termObserver.observe(term);
	}

	reduced.addEventListener("change", () => {
		if (!reduced.matches) return;
		stageObserver.disconnect();
		stages.forEach(setStage);
		if (term?.dataset.term === "pending") finishTerm();
	});
})();
