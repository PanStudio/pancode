#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { spawn } from "node:child_process";
import { watch } from "node:fs";
import { readFile, rename, rm, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const site = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const { values } = parseArgs({
	// `pnpm run site:dev -- --port 4180` forwards the separator itself.
	args: argv[0] === "--" ? argv.slice(1) : argv,
	options: {
		port: { type: "string", default: "4321" },
		host: { type: "string", default: "0.0.0.0" },
		snapshot: { type: "boolean", default: false },
		review: { type: "boolean", default: false },
		dir: { type: "string", default: ".preview" },
		serve: { type: "string" },
	},
});
// --serve <dir> serves a directory build.mjs already wrote, as GitHub Pages
// serves it: no build, no watch, no reload script, redirect paths answered with
// their built meta-refresh page and a missing path with 404.html.
const serving = values.serve !== undefined;
// A second preview (for example --review beside the normal one) needs its own
// directory; two servers must never swap the same output.
if (!/^\.preview[a-z0-9-]*$/.test(values.dir)) throw new Error("--dir must be an ignored .preview directory name.");
const out = serving ? resolve(values.serve) : join(site, values.dir);
if (serving) {
	const marker = await readFile(join(out, ".pancode-site-build"), "utf8").catch(() => null);
	if (marker === null) {
		console.error(`dev: ${out} is not a site build; build it first with node site/build.mjs --out ${values.serve}`);
		process.exit(1);
	}
}
const next = join(site, `${values.dir}-next`);
const previous = join(site, `${values.dir}-previous`);
const clients = new Set();
const mime = {
	".html": "text/html; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".js": "application/javascript; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".webmanifest": "application/manifest+json; charset=utf-8",
	".xml": "application/xml",
	".txt": "text/plain; charset=utf-8",
	".cast": "application/x-asciicast",
	".webp": "image/webp",
	".mp4": "video/mp4",
	".png": "image/png",
	".svg": "image/svg+xml",
	".woff2": "font/woff2",
};
// The built pages inline the theme script; allow exactly the hashes they declare.
let scriptHashes = "";
// Pages with a recording also allow WebAssembly compilation for the player, as their meta policy does.
const devCsp = (cast = false) =>
	`default-src 'self'; script-src 'self'${cast ? " 'wasm-unsafe-eval'" : ""}${scriptHashes}; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-src https://www.youtube-nocookie.com; object-src 'none'; base-uri 'self'; form-action 'none'`;
function run(command, args) {
	return new Promise((done, reject) => {
		const child = spawn(command, args, { cwd: site, stdio: "inherit" });
		child.on("error", reject);
		child.on("exit", (code) => (code === 0 ? done() : reject(new Error(`${command} exited ${code}`))));
	});
}
let building = false;
let pending = false;
async function build() {
	if (building) {
		pending = true;
		return;
	}
	building = true;
	try {
		if (!values.snapshot) await run("python3", [join(site, "sync-docs.py"), "--worktree"]);
		// --review adds the unregistered manuscripts in content/drafts to this preview only.
		const buildArgs = [join(site, "build.mjs"), "--out", next, ...(values.review ? ["--review"] : [])];
		const buildLock = process.env.PANCODE_SITE_BUILD_LOCK;
		await run(
			buildLock ? "flock" : process.execPath,
			buildLock ? [buildLock, process.execPath, ...buildArgs] : buildArgs,
		);
		await rm(previous, { recursive: true, force: true });
		try {
			await rename(out, previous);
		} catch (error) {
			if (error.code !== "ENOENT") throw error;
		}
		await rename(next, out);
		const page = await readFile(join(out, "index.html"), "utf8");
		scriptHashes = [...new Set(page.match(/'sha256-[A-Za-z0-9+/=]+'/g) ?? [])].map((hash) => ` ${hash}`).join("");
		await rm(previous, { recursive: true, force: true });
		for (const client of clients) client.write("data: reload\n\n");
		console.log(`PanCode preview updated ${new Date().toLocaleTimeString()}`);
	} catch (error) {
		console.error(`Preview build failed; the last working preview is still served.\n${error.message}`);
	} finally {
		building = false;
		if (pending) {
			pending = false;
			await build();
		}
	}
}
if (!serving) await build();
const redirects = serving ? {} : JSON.parse(await readFile(join(site, "redirects.json"), "utf8"));
const server = createServer(async (request, response) => {
	response.setHeader("Cache-Control", "no-store");
	response.setHeader("X-Content-Type-Options", "nosniff");
	// A served build carries its own policy in each page's meta tag, as on Pages.
	if (!serving) response.setHeader("Content-Security-Policy", devCsp());
	response.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
	response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
	try {
		const url = new URL(request.url, "http://localhost");
		if (!serving && url.pathname === "/__events") {
			response.writeHead(200, { "Content-Type": "text/event-stream", Connection: "keep-alive" });
			response.write(": connected\n\n");
			clients.add(response);
			request.on("close", () => clients.delete(response));
			return;
		}
		if (!serving && url.pathname === "/__reload.js") {
			response.writeHead(200, { "Content-Type": mime[".js"] });
			response.end('new EventSource("/__events").onmessage = () => location.reload();');
			return;
		}
		const path = decodeURIComponent(url.pathname);
		if (!serving && (redirects[path] || path === "/index.html")) {
			const target = new URL(redirects[path] ?? "/", url);
			target.search = url.search;
			response.writeHead(308, { Location: `${target.pathname}${target.search}${target.hash}` });
			response.end();
			return;
		}
		const file = resolve(out, `.${path === "/" ? "/index.html" : path}`);
		if (!file.startsWith(out + sep) || path.split("/").some((part) => part.startsWith("."))) {
			response.writeHead(404);
			response.end("Not found");
			return;
		}
		let target = file;
		let status = 200;
		const isFile = (candidate) =>
			stat(candidate).then(
				(entry) => entry.isFile(),
				() => false,
			);
		// Pages also answers /name with name.html and /dir/ with dir/index.html.
		if (!(await isFile(target))) {
			target = null;
			if (serving)
				for (const item of [`${file}.html`, join(file, "index.html")])
					if (await isFile(item)) {
						target = item;
						break;
					}
		}
		if (!target) {
			target = join(out, "404.html");
			status = 404;
		}
		let body = await readFile(target);
		if (!serving && extname(target) === ".html" && body.includes("'wasm-unsafe-eval'"))
			response.setHeader("Content-Security-Policy", devCsp(true));
		if (!serving && extname(target) === ".html" && !url.searchParams.has("__static"))
			body = Buffer.from(body.toString().replace("</body>", '<script src="/__reload.js" defer></script></body>'));
		response.writeHead(status, { "Content-Type": mime[extname(target)] ?? "application/octet-stream" });
		response.end(request.method === "HEAD" ? undefined : body);
	} catch {
		response.writeHead(400);
		response.end("Bad request");
	}
});
server.listen(Number(values.port), values.host, () =>
	console.log(
		serving
			? `\nServing ${out} as Pages serves it: http://${values.host === "0.0.0.0" ? "localhost" : values.host}:${values.port}/\n`
			: `\nPanCode preview: http://localhost:${values.port}/\nWatching site source and public repository guides.\n`,
	),
);
let timer;
function changed() {
	clearTimeout(timer);
	timer = setTimeout(() => {
		void build();
	}, 250);
}
if (!serving) {
	watch(site, { recursive: true }, (_event, name) => {
		if (!name || /^(?:\.preview|public|content\/docs|content\/index\.json)/.test(name)) return;
		if (/\.(?:html|css|js|mjs|json|md|py|webp|png|mp4)$/.test(name)) changed();
	});
	watch(join(site, "../docs/guide"), { recursive: true }, changed);
	for (const name of ["README.md", "package.json"]) watch(join(site, "..", name), changed);
}
const heartbeat = setInterval(() => {
	for (const client of clients) client.write(": keepalive\n\n");
}, 20000);
for (const signal of ["SIGINT", "SIGTERM"])
	process.on(signal, () => {
		clearInterval(heartbeat);
		for (const client of clients) client.end();
		server.close(() => process.exit(0));
		server.closeAllConnections();
	});
