// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * The loopback listener a browser sign-in returns to, and the page it shows:
 * shared by the provider subscription flows and remote MCP server sign-in.
 */

import { readFileSync } from "node:fs";
import { createServer, type RequestListener, type Server } from "node:http";
import { join } from "node:path";
import { resolvePackageRoot } from "./package-root.js";
import { pageColorVars } from "./page-palette.js";

const CALLBACK_HOST = "127.0.0.1";
// The redirect names `localhost`, which also resolves to ::1; PanCode holds both so no other local process can take the IPv6 side.
const CALLBACK_HOST_V6 = "::1";
const RANDOM_PORT_ATTEMPTS = 5;

// The canonical PanCode mark (site/DESIGN.md); package.json `files` ships it.
const MARK_PATH = join("assets", "pancode-mark-gui.webp");
let markImage: string | undefined;

function canonicalMark(): string {
	if (markImage !== undefined) return markImage;
	try {
		const data = readFileSync(join(resolvePackageRoot(), MARK_PATH)).toString("base64");
		markImage = `<img src="data:image/webp;base64,${data}" alt="PanCode" width="64" height="64">`;
	} catch {
		// A missing mark leaves a text-only page; sign-in itself does not depend on it.
		markImage = "";
	}
	return markImage;
}

function escapeHtml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}

/** True black in either browser preference, like the mark it frames. */
const SIGN_IN_COLORS = { paper: "ground", ink: "ink", muted: "muted", success: "success", alert: "alert" } as const;

export function renderPage(ok: boolean, message: string, details?: string): string {
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>PanCode</title>
<style>
:root{color-scheme:dark;${pageColorVars(SIGN_IN_COLORS, "dark")}}
body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;box-sizing:border-box;background:var(--paper);color:var(--ink);font:15px/1.6 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;text-align:center}
main{max-width:520px}
img{display:block;height:64px;width:auto;margin:0 auto 20px}
h1{color:var(--success)}
.failed h1{color:var(--alert)}
h1{margin:0 0 8px;font-size:26px;font-weight:700;letter-spacing:-0.03em}
p{margin:0;color:var(--muted)}
.details{margin-top:16px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:13px;white-space:pre-wrap;word-break:break-word}
</style>
</head>
<body><main${ok ? "" : ' class="failed"'}>${canonicalMark()}<h1>${ok ? "Signed in" : "Sign-in failed"}</h1><p>${escapeHtml(message)}</p>${details ? `<p class="details">${escapeHtml(details)}</p>` : ""}</main></body>
</html>`;
}

function listen(server: Server, port: number, host: string): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(port, host, () => {
			server.off("error", reject);
			resolve();
		});
	});
}

/**
 * Binds the port on 127.0.0.1 and ::1. A port someone else holds on ::1 counts as taken, so the caller falls back
 * as it does for a taken IPv4 port; port 0 retries a few random ports. A host without IPv6 loopback keeps IPv4 only.
 */
export async function listenLoopback(port: number, handler: RequestListener): Promise<Server[]> {
	for (let attempt = 1; ; attempt++) {
		const v4 = createServer(handler);
		await listen(v4, port, CALLBACK_HOST);
		const address = v4.address();
		if (!address || typeof address === "string") return [v4];
		const v6 = createServer(handler);
		try {
			await listen(v6, address.port, CALLBACK_HOST_V6);
			return [v4, v6];
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "EADDRNOTAVAIL" || code === "EAFNOSUPPORT") return [v4];
			v4.close();
			if (port !== 0 || attempt >= RANDOM_PORT_ATTEMPTS) throw error;
		}
	}
}
