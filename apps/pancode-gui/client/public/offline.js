// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
try {
	const saved = localStorage.getItem("pancode-gui-theme") ?? "dark";
	if (saved === "light" || saved === "dark") document.documentElement.dataset.theme = saved;
} catch {
	document.documentElement.dataset.theme = "dark";
}
const button = document.getElementById("retry"),
	status = document.getElementById("status");
let pending = false,
	timer;
async function reconnect() {
	if (pending) return;
	pending = true;
	button.disabled = true;
	try {
		const response = await fetch("/manifest.webmanifest", { cache: "no-store", signal: AbortSignal.timeout(2000) });
		if (response.ok && (await response.json()).name === "PanCode") {
			location.reload();
			return;
		}
	} catch {
		/* An unavailable local service is expected during restart or sleep. */
	}
	status.textContent = "Still waiting for PanCode. Your work stays in PanCode; nothing has been sent.";
	pending = false;
	button.disabled = false;
	clearTimeout(timer);
	timer = setTimeout(reconnect, 3000);
}
button.addEventListener("click", reconnect);
window.addEventListener("online", reconnect);
window.addEventListener("pagehide", () => clearTimeout(timer));
void reconnect();
