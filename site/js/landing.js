// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
(() => {
	if (!("IntersectionObserver" in window)) return;
	const reduced = matchMedia("(prefers-reduced-motion: reduce)");
	// A share of the element in view, or of the viewport when the element is taller than it.
	const steps = Array.from({ length: 21 }, (_, i) => i / 20);
	const shown = (entry, share) =>
		entry.isIntersecting &&
		entry.intersectionRect.height >=
			share * Math.min(entry.boundingClientRect.height, entry.rootBounds?.height ?? innerHeight) - 1;

	// The PAN art draws its routes once in view and runs its signals only while seen.
	const stages = [...document.querySelectorAll(".pan-stage")];
	const seen = new Set();
	const stageObserver = new IntersectionObserver(
		(entries) => {
			for (const entry of entries) {
				if (shown(entry, 0.25)) seen.add(entry.target);
				else seen.delete(entry.target);
				setStage(entry.target);
			}
		},
		{ threshold: steps },
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
				if (!entries.some((entry) => shown(entry, 0.4))) return;
				termObserver.disconnect();
				let index = 0;
				const next = () => {
					rows[index++]?.classList.add("is-in");
					if (index < rows.length) timer = setTimeout(next, 180);
					else finishTerm();
				};
				next();
			},
			{ threshold: steps },
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
		// The round starts once half of Reach is in view and ends for good if Reach or the page is hidden.
		const reachObserver = new IntersectionObserver(
			(entries) => {
				if (reduced.matches || round < 0) return;
				const visible = entries.some((entry) => shown(entry, 0.5));
				if (round && !visible) cancel();
				if (round || !visible || document.hidden) return;
				let step = 0;
				round = setInterval(() => {
					step += 1;
					buttons[step % buttons.length].click();
					if (step === buttons.length) cancel();
				}, 2400);
			},
			{ threshold: steps },
		);
		for (const type of ["pointerdown", "keydown", "focusin"]) reach.addEventListener(type, cancel, { once: true });
		document.addEventListener("visibilitychange", () => {
			if (document.hidden && round > 0) cancel();
		});
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
