// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
// Cache only the public recovery page. Conversations, API responses, tokens and mutations never enter this cache.
const cacheName = "pancode-recovery-v12";
const recoveryAssets = ["/offline.html", "/offline.css", "/offline.js", "/icon-192.png"];
self.addEventListener("install", (event) => {
	event.waitUntil(
		caches
			.open(cacheName)
			.then((cache) => cache.addAll(recoveryAssets))
			.then(() => self.skipWaiting()),
	);
});
self.addEventListener("activate", (event) => {
	event.waitUntil(
		caches
			.keys()
			.then((names) =>
				Promise.all(
					names
						.filter((name) => name.startsWith("pancode-recovery-") && name !== cacheName)
						.map((name) => caches.delete(name)),
				),
			)
			.then(() => self.clients.claim()),
	);
});
self.addEventListener("fetch", (event) => {
	const url = new URL(event.request.url);
	if (url.origin !== self.location.origin || event.request.method !== "GET" || url.pathname.startsWith("/api/")) return;
	if (event.request.mode === "navigate") {
		event.respondWith(fetch(event.request).catch(async () => (await caches.match("/offline.html")) ?? Response.error()));
	} else if (recoveryAssets.includes(url.pathname)) {
		event.respondWith(caches.match(url.pathname).then((cached) => cached ?? fetch(event.request)));
	}
});
