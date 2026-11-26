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

	// Reach lights the sector of the open tab and walks the three tabs once on first sight.
	const reach = document.querySelector(".reach");
	const tabs = reach?.querySelector(".reach-tabs[data-tabs-ready]");
	const art = reach?.querySelector(".reach-art");
	let round = 0;
	if (tabs && art) {
		const sync = () => {
			const open = tabs.querySelector(".reach-panel:not([hidden])");
			if (open) art.dataset.active = open.dataset.sector;
		};
		tabs.addEventListener("click", sync);
		tabs.addEventListener("keyup", sync);
		sync();
		const buttons = [...tabs.querySelectorAll("[role=tab]")];
		const cancel = () => {
			clearInterval(round);
			round = -1;
			reachObserver.disconnect();
		};
		const reachObserver = new IntersectionObserver(
			(entries) => {
				if (reduced.matches || round || !entries.some((entry) => entry.isIntersecting)) return;
				reachObserver.disconnect();
				let step = 0;
				round = setInterval(() => {
					step += 1;
					buttons[step % buttons.length].click();
					if (step === buttons.length) cancel();
				}, 2400);
			},
			{ threshold: 0.5 },
		);
		for (const type of ["pointerdown", "keydown", "focusin"]) reach.addEventListener(type, cancel, { once: true });
		reachObserver.observe(reach);
	}

	reduced.addEventListener("change", () => {
		if (!reduced.matches) return;
		stageObserver.disconnect();
		stages.forEach(setStage);
		if (term?.dataset.term === "pending") finishTerm();
		if (round > 0) {
			clearInterval(round);
			round = -1;
		}
	});
})();
