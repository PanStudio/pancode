// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
// Google Analytics 4 with Consent Mode v2. Every storage type starts denied; the
// visitor's Accept grants analytics storage only. The build includes this file
// only when product.json names a measurement id.
(() => {
	const id = document.currentScript?.dataset.ga4;
	if (!id) return;
	const key = "pancode-analytics-consent";
	window.dataLayer = window.dataLayer || [];
	// gtag.js reads the arguments object itself, so this stays a plain function.
	function gtag() {
		// biome-ignore lint/complexity/noArguments: the documented gtag queue format
		window.dataLayer.push(arguments);
	}
	let choice = null;
	try {
		choice = localStorage.getItem(key);
	} catch {
		/* Storage is optional; the choice then lasts for this page only. */
	}
	gtag("consent", "default", {
		analytics_storage: "denied",
		ad_storage: "denied",
		ad_user_data: "denied",
		ad_personalization: "denied",
	});
	if (choice === "granted") gtag("consent", "update", { analytics_storage: "granted" });
	gtag("set", "ads_data_redaction", true);
	gtag("js", new Date());
	gtag("config", id, { allow_google_signals: false, allow_ad_personalization_signals: false });

	// The tag loads after the page, so it never competes with first paint.
	const load = () => {
		const script = document.createElement("script");
		script.async = true;
		script.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(id)}`;
		document.head.append(script);
	};
	if (document.readyState === "complete") load();
	else addEventListener("load", load, { once: true });

	const banner = document.querySelector("[data-consent]");
	const show = () => {
		for (const state of document.querySelectorAll("[data-consent-state]"))
			state.textContent = choice === "granted" ? "accepted" : choice === "denied" ? "declined" : "not made yet";
		if (banner) banner.hidden = choice === "granted" || choice === "denied";
	};
	// Google Analytics sets its cookies on the widest domain it can, so expire
	// each one on every parent of this host as well as on the host itself.
	const forgetCookies = () => {
		const parts = location.hostname.split(".");
		const scopes = ["", ...parts.map((_, i) => `; domain=${parts.slice(i).join(".")}`)];
		for (const cookie of document.cookie.split(";")) {
			const name = cookie.split("=")[0].trim();
			if (!/^_ga(?:_|$)/.test(name)) continue;
			// biome-ignore lint/suspicious/noDocumentCookie: the Cookie Store API is not in every browser yet
			for (const scope of scopes) document.cookie = `${name}=; Max-Age=0; path=/${scope}`;
		}
	};
	for (const button of document.querySelectorAll("[data-consent-choice]"))
		button.addEventListener("click", () => {
			choice = button.dataset.consentChoice === "granted" ? "granted" : "denied";
			try {
				localStorage.setItem(key, choice);
			} catch {
				/* The choice still applies to this page. */
			}
			gtag("consent", "update", { analytics_storage: choice });
			if (choice === "denied") forgetCookies();
			show();
		});
	show();

	const install = /pancode\.dev\/install\.(sh|ps1)|\b(?:npm|bun|pnpm)\s+(?:install|add|i)\s+-g\s+@[\w-]+\/pancode\b/;
	document.addEventListener("click", (event) => {
		const target = event.target instanceof Element ? event.target : null;
		const copy = target?.closest("[data-copy]");
		const command = copy?.dataset.copy ?? "";
		const method = command.match(install);
		if (method)
			gtag("event", "copy_install", { method: method[1] === "ps1" ? "powershell" : method[1] ? "shell" : "npm" });
		if (target?.closest("[data-theme-toggle]"))
			gtag("event", "theme_toggle", { theme: document.documentElement.dataset.theme });
		const link = target?.closest("a[href]");
		if (link) {
			const url = new URL(link.href, location.href);
			if (/(?:^|\.)(?:github\.com|npmjs\.com)$/.test(url.hostname))
				gtag("event", "outbound_click", { link_domain: url.hostname, link_url: url.href });
		}
	});
})();
