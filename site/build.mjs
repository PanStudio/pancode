#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, posix, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { checkPolicy } from "./policy.mjs";
import { fontFiles } from "./tokens.mjs";
import * as markedModule from "./vendor/marked.min.js";

const marked = markedModule.default ?? globalThis.marked;
const root = dirname(fileURLToPath(import.meta.url));
const { values } = parseArgs({
	options: { out: { type: "string" }, revision: { type: "string" }, review: { type: "boolean", default: false } },
});
// A review build adds the unregistered manuscripts in content/drafts. It must
// name its own output so drafts can never enter the public directory.
if (values.review && !values.out) throw new Error("A review build needs --out; drafts never enter site/public.");
if (values.revision && !/^[a-f0-9]{40}$/.test(values.revision))
	throw new Error("Site revision must be a full Git commit.");
const out = resolve(values.out ?? join(root, "public"));
if (out === "/" || out === root || root.startsWith(`${out}/`)) throw new Error("Output must not replace source files.");
await checkPolicy();
const read = (name) => readFile(join(root, name), "utf8");
const product = JSON.parse(await read("product.json"));
const brand = JSON.parse(await read("design-system.json"));
const manifest = JSON.parse(await read("content/docs-manifest.json"));
const index = JSON.parse(await read("content/index.json"));
const catalog = JSON.parse(await read("public-docs.json"));
const captures = JSON.parse(await read("content/captures.json")).captures;
const guideDiagrams = JSON.parse(await read("content/guide-diagrams.json")).diagrams;
const tutorials = JSON.parse(await read("content/tutorials.json"));
if (values.review)
	for (const item of JSON.parse(await read("content/drafts/review-catalog.json")).articles)
		tutorials.push({ ...item, draft: true });
const research = JSON.parse(await read("content/research.json"));
const paths = JSON.parse(await read("content/paths.json")).paths;
const hubCatalog = JSON.parse(await read("content/hub-catalog.json"));
const collections = [
	{
		id: "tutorials",
		label: "Tutorials",
		listing: "/learn.html",
		items: tutorials,
		title: "Tutorials for local models, HPC, and agents · PanCode",
		description:
			"Practical PanCode tutorials: run on a local model, set up a lab model gateway, coordinate coding agents, script CI, and check a numerical change.",
	},
	{
		id: "research",
		label: "Research",
		listing: "/research.html",
		items: research,
		title: "Research: the harness as a systems problem · PanCode",
		description:
			"PanCode treats the coding-agent harness as systems software: five subsystems with source maps, limits and a first experiment, and open questions to take up.",
	},
];
const articles = collections.flatMap((collection) =>
	collection.items.map((item) => ({
		...item,
		collection,
		url: `/${collection.id}/${item.slug}.html`,
		folder: item.draft ? "content/drafts" : `content/${collection.id}`,
	})),
);
// Each article names the guides it puts into practice; every guide page lists
// those articles at its end, so a guide links back to its worked examples.
const related = new Map();
for (const item of articles)
	for (const path of item.guides ?? []) {
		if (!index.some((doc) => doc.path === path)) throw new Error(`Article ${item.slug} names an unknown guide: ${path}`);
		related.set(path, [...(related.get(path) ?? []), item]);
	}
// Learning paths order published tutorials for one kind of reader each.
for (const path of paths) {
	for (const key of ["id", "label", "title", "summary"])
		if (!path[key]) throw new Error(`Learning path ${path.id ?? "?"} is missing ${key}.`);
	if (!/^path-[a-z]+$/.test(path.id)) throw new Error(`Learning path id ${path.id} must look like path-name.`);
	if (!(path.steps?.length >= 3 && path.steps.length <= 5))
		throw new Error(`Learning path ${path.id} needs three to five steps.`);
	for (const slug of path.steps)
		if (!tutorials.some((item) => item.slug === slug && !item.draft))
			throw new Error(`Learning path ${path.id} names an unpublished tutorial: ${slug}`);
}
for (const [id, item] of Object.entries(captures)) {
	for (const key of ["image", "original", "alt", "caption", "label", "interface", "version", "capturedAt", "source"])
		if (!item[key]) throw new Error(`Capture ${id} is missing ${key}.`);
	if (!/^assets\/[a-z0-9/.-]+\.webp$/.test(item.image) || !/^assets\/[a-z0-9/.-]+\.png$/.test(item.original))
		throw new Error(`Capture ${id} must name a WebP image and its PNG original under assets/.`);
	await readFile(join(root, item.image));
	await readFile(join(root, item.original));
	// A recorded capture: the still above is its poster, rendered from the cast at `posterAt`.
	if (item.cast) {
		if (
			!/^assets\/casts\/[a-z0-9-]+\.cast$/.test(item.cast) ||
			!/^assets\/casts\/[a-z0-9-]+\.txt$/.test(item.transcript ?? "") ||
			![item.cols, item.rows, item.duration, item.posterAt].every((n) => Number.isFinite(n) && n >= 0)
		)
			throw new Error(`Capture ${id} names a cast without its transcript, size, duration, or poster time.`);
		await readFile(join(root, item.cast));
		item.transcriptText = (await readFile(join(root, item.transcript), "utf8")).trimEnd();
	}
}
for (const item of articles) {
	if (item.cover && !captures[item.cover]) throw new Error(`Tutorial ${item.slug} names an unknown cover capture.`);
	if (item.cover)
		Object.assign(item, {
			image: `/${captures[item.cover].image}`,
			width: captures[item.cover].width,
			height: captures[item.cover].height,
			alt: captures[item.cover].alt,
		});
}
const redirects = JSON.parse(await read("redirects.json"));
const imageVariants = JSON.parse(await read("image-variants.json"));
const social = JSON.parse(await read("social-images.json"));
for (const [id, item] of Object.entries(social.images)) {
	if (!captures[id] || item.source !== captures[id].original || !/^assets\/social\/[a-z0-9-]+\.png$/.test(item.path))
		throw new Error(`Social preview ${id} must be generated from its capture; run python3 site/image-variants.py.`);
	if (
		createHash("sha256")
			.update(await readFile(join(root, item.path)))
			.digest("hex") !== item.sha256
	)
		throw new Error(`Social preview changed; regenerate image variants: ${item.path}`);
}
for (const item of articles)
	if (item.cover && !social.images[item.cover])
		throw new Error(`Article ${item.slug} has no social preview; run python3 site/image-variants.py --social.`);
if (!social.images[social.default]) throw new Error("The default social preview is missing.");
// Sitemap lastmod and article dateModified come from the last commit that
// touched a page's sources. Without Git history (a deploy snapshot) they are omitted.
// product.json counts only when its version changes, the one field page text shows.
const productVersion = ["-G", '"version":', "--", "product.json"];
function lastModified(files) {
	const plain = files.filter((file) => file !== "product.json");
	const queries = [
		...(plain.length ? [["--", ...plain]] : []),
		...(files.includes("product.json") ? [productVersion] : []),
	];
	try {
		const dates = queries
			.map((query) =>
				execFileSync("git", ["log", "-1", "--format=%cI", ...query], {
					cwd: root,
					encoding: "utf8",
					stdio: ["ignore", "pipe", "ignore"],
				}).trim(),
			)
			.filter(Boolean);
		return dates.length ? dates.reduce((a, b) => (Date.parse(b) > Date.parse(a) ? b : a)) : null;
	} catch {
		return null;
	}
}
// The first commit that added any of a page's sources at its public path. Older
// drafts elsewhere were not published, so renames are not followed.
function firstPublished(files) {
	try {
		const dates = execFileSync("git", ["log", "--diff-filter=A", "--format=%cI", "--", ...files], {
			cwd: root,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		})
			.split("\n")
			.filter(Boolean);
		return dates.length ? dates.reduce((a, b) => (Date.parse(b) < Date.parse(a) ? b : a)) : null;
	} catch {
		return null;
	}
}
// The visible date is the commit's own calendar day, so no time zone shifts it.
function updatedOn(lastmod) {
	const [year, month, day] = lastmod.slice(0, 10).split("-").map(Number);
	const label = new Date(Date.UTC(year, month - 1, day)).toLocaleDateString("en-US", {
		year: "numeric",
		month: "long",
		day: "numeric",
		timeZone: "UTC",
	});
	return `<time datetime="${lastmod}">${label}</time>`;
}
for (const [source, item] of Object.entries(imageVariants)) {
	for (const asset of [{ path: source, sha256: item.sha256 }, ...item.variants]) {
		if (!/^assets\/[a-z0-9/.-]+$/.test(asset.path)) throw new Error("Invalid responsive asset path.");
		const bytes = await readFile(join(root, asset.path));
		if (createHash("sha256").update(bytes).digest("hex") !== asset.sha256)
			throw new Error(`Responsive asset changed; regenerate image variants: ${asset.path}`);
	}
}
for (const [path, target] of Object.entries(redirects)) {
	if (!/^\/[a-z0-9/.-]+\.html$/.test(path) || !/^\/[a-z0-9/.-]*(?:#[a-z0-9_-]+)?$/.test(target))
		throw new Error("Redirects must be static local URLs.");
}
const escapeHtml = (text) =>
	String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const docUrl = (path) => (path === "README.md" ? "/docs.html" : `/docs/${path.replace(/\.md$/, ".html")}`);
const source = manifest.source;
if (source.version !== product.version) throw new Error("Documentation and site source versions differ.");
if (source.mode === "tree" ? source.commit !== undefined : !/^[a-f0-9]{40}$/.test(source.commit))
	throw new Error("Documentation source commit is invalid.");
if (JSON.stringify(index.map((item) => item.path)) !== JSON.stringify(catalog.map((item) => item.path)))
	throw new Error("Documentation index differs from the public allowlist.");
if (manifest.files.length !== catalog.length)
	throw new Error("Documentation manifest differs from the public allowlist.");
// linkRef points reader-facing source links at a public ref while the pinned
// documentation commit is not published yet; the manifest keeps the real pin.
const ref = (product.linkRef ?? source.ref).split("/").map(encodeURIComponent).join("/");
const repository = product.repository.replace(/\/$/, "");
const sourceMap = new Map([
	...index.map((item) => [item.source, docUrl(item.path)]),
	...articles.map((item) => [`site/${item.folder}/${item.source}`, item.url]),
]);
const slug = (text) =>
	text
		.replace(/<[^>]+>/g, "")
		.replace(/&[^;]+;/g, "")
		.toLowerCase()
		.trim()
		.replace(/[^\p{L}\p{N}\s_-]/gu, "")
		.replace(/\s/g, "-");
const anchors = new Map();
for (const item of [
	...index.map((item) => ({ source: item.source, file: `content/docs/${item.path}` })),
	...articles.map((item) => ({ source: `site/${item.folder}/${item.source}`, file: `${item.folder}/${item.source}` })),
]) {
	const tokens = marked.lexer(await read(item.file));
	anchors.set(
		item.source,
		new Set(tokens.filter((token) => token.type === "heading").map((token) => slug(marked.parseInline(token.text)))),
	);
}
const partials = await read("partials.html");
// Drawings under art/ are inlined where a template or partial names them with
// <!-- art:<name> -->, so the page's classes and CSS variables colour them.
const artDir = join(root, "art");
const art = new Map(
	await Promise.all(
		(await readdir(artDir).catch(() => []))
			.filter((name) => name.endsWith(".svg"))
			.map(async (name) => [name.slice(0, -4), (await readFile(join(artDir, name), "utf8")).trim()]),
	),
);
function inlineArt(html, path) {
	return html.replace(/<!--\s*art:([a-z0-9-]+)\s*-->/g, (_, name) => {
		if (!art.has(name)) throw new Error(`${path} names art:${name}, but site/art/${name}.svg does not exist.`);
		return art.get(name);
	});
}
const mast = partials.match(/<header class="mast">[\s\S]*?<\/header>/)[0];
const footer = partials
	.match(/<footer class="colophon[\s\S]*?<\/footer>/)[0]
	.replace(
		"<!-- footer-paths -->",
		paths.map((path) => `<li><a href="/learn.html#${path.id}">${escapeHtml(path.label)}</a></li>`).join(""),
	);
const urls = [];
// Pages that embed a recording; only they get the player, its stylesheet, and its policy.
const castPages = [];

function responsiveImages(html, path) {
	return html.replace(/<img\b[^>]+>/g, (tag) => {
		const source = tag.match(/src="\/([^"]+)"/)?.[1];
		const item = imageVariants[source];
		if (!item) return tag;
		const pancode = source === "assets/brand/pancode-mark.webp";
		const guide = articles.some((item) => item.url === path);
		const article = guide || path.startsWith("/docs");
		// An image that states its own sizes keeps them. Brand marks render at .brand img sizes; listing
		// cards subtract the 1rem padding and 1px border around each card image from the column width.
		const sizes = tag.match(/\ssizes="([^"]+)"/)?.[1]
			? ""
			: pancode
				? "(max-width: 600px) 27px, 32px"
				: guide
					? "(max-width: 600px) calc(100vw - 40px), (max-width: 1100px) calc(100vw - 64px), 1000px"
					: article
						? "(max-width: 600px) calc(100vw - 40px), (max-width: 850px) calc(100vw - 64px), 760px"
						: "(max-width: 600px) calc(100vw - 74px), (max-width: 1100px) calc(50vw - 90px), (max-width: 1344px) calc(50vw - 106px), 566px";
		const srcset = [...item.variants, { path: source, width: item.width }]
			.map((v) => `/${v.path} ${v.width}w`)
			.join(", ");
		if (pancode) tag = tag.replace(`src="/${source}"`, `src="/${item.variants.find((v) => v.width === 64).path}"`);
		if (!/\bwidth=/.test(tag)) tag = tag.replace("<img", `<img width="${item.width}" height="${item.height}"`);
		return tag
			.replace(/\s*\/?>(?=$)/, ` srcset="${srcset}"${sizes && ` sizes="${sizes}"`} decoding="async">`)
			.replace(/ decoding="async"(?=[\s\S]* decoding="async")/, "");
	});
}
// The theme must apply before first paint, and an external script would block
// rendering for a round trip. It is inlined and allowed by its exact hash.
const themeScript = (await read("js/theme.js")).trim();
const themeHash = `'sha256-${createHash("sha256").update(themeScript).digest("base64")}'`;
// GitHub Pages sends no custom headers, so the policy nginx used to send rides
// in a meta tag. frame-ancestors is not honored there and cannot be restored.
const contentSecurityPolicy = `default-src 'self'; script-src 'self' ${themeHash} https://static.cloudflareinsights.com; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self' https://cloudflareinsights.com; frame-src https://www.youtube-nocookie.com; object-src 'none'; base-uri 'self'; form-action 'none'`;
// The terminal player compiles WebAssembly, which only pages embedding a recording allow.
const castContentSecurityPolicy = contentSecurityPolicy.replace(
	"script-src 'self'",
	"script-src 'self' 'wasm-unsafe-eval'",
);
// Whitespace and comment removal only; strings are copied untouched, and spaces
// around operators such as + and - stay, so calc() and selectors keep meaning.
function minifyCss(css) {
	let result = "";
	let text = "";
	const flush = () => {
		result += text
			.replace(/\s+/g, " ")
			.replace(/ ?([{};,>]) ?/g, "$1")
			.replace(/: /g, ":")
			.replace(/;}/g, "}");
		text = "";
	};
	for (let i = 0; i < css.length; ) {
		if (css.startsWith("/*", i)) {
			const end = css.indexOf("*/", i + 2);
			i = end < 0 ? css.length : end + 2;
			text += " ";
		} else if (css[i] === '"' || css[i] === "'") {
			let end = i + 1;
			while (end < css.length && css[end] !== css[i]) end += css[end] === "\\" ? 2 : 1;
			flush();
			result += css.slice(i, end + 1);
			i = end + 1;
		} else text += css[i++];
	}
	flush();
	return `${result.trim()}\n`;
}
const titleSuffix = / · PanCode(?: docs)?$/;
// The paper colour the page shows without JavaScript under each colour-scheme
// preference; the theme script then sets both to the theme it applied.
const paperFor = (scheme) =>
	brand.palette[
		brand.themes[brand.defaultTheme === "system" ? scheme : brand.defaultTheme === "light" ? "light" : "dark"].paper
	];
const themeColors = ["light", "dark"]
	.map(
		(scheme) =>
			`<meta name="theme-color" media="(prefers-color-scheme: ${scheme})" content="${escapeHtml(paperFor(scheme))}">`,
	)
	.join("");
// A page title keeps the product name once.
const pageTitle = (title) => (title.includes("PanCode") ? title : `${title} · PanCode`);
const publisher = {
	"@type": "Person",
	"@id": `${product.origin}/#publisher`,
	name: "Anthony Kougkas",
	url: "https://akougkas.io/",
};
const plainText = (html) =>
	html
		.replace(/<[^>]+>/g, "")
		.replace(/&(amp|lt|gt|quot|#39);/g, (_, name) => ({ amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'" })[name])
		.replace(/\s+/g, " ")
		.trim();
// The overview's question list is a real FAQ; its structured data is read from the same HTML.
const faq = [
	...((await read("index.html")).match(/<div class="faq-items">([\s\S]*?)<\/div><\/div>/)?.[1] ?? "").matchAll(
		/<details><summary>([\s\S]*?)<\/summary>([\s\S]*?)<\/details>/g,
	),
].map(([, question, answer]) => ({
	"@type": "Question",
	name: plainText(question),
	acceptedAnswer: { "@type": "Answer", text: plainText(answer) },
}));
if (faq.length < 3) throw new Error("The overview FAQ was not found; structured FAQ data would be empty.");
function head(
	path,
	title,
	description,
	type = "WebPage",
	{ lastmod = null, published = null, preview = social.default, cast = false } = {},
) {
	const url = `${product.origin}${path}`;
	const article = articles.find((item) => item.url === path);
	const image = social.images[preview];
	const imageUrl = `${product.origin}/${image.path}`;
	// The shared preview card is named for the product; article covers keep their own description.
	const imageAlt = preview === social.default ? product.name : captures[preview].alt;
	const graph = {
		"@context": "https://schema.org",
		"@graph": [
			{
				"@type": "WebSite",
				"@id": `${product.origin}/#site`,
				name: "PanCode",
				url: `${product.origin}/`,
				description: product.description,
				inLanguage: "en",
				publisher: { "@id": publisher["@id"] },
				copyrightHolder: { "@id": publisher["@id"] },
				copyrightYear: 2026,
			},
			{
				"@type": type,
				"@id": `${url}#page`,
				name: title,
				description,
				url,
				isPartOf: { "@id": `${product.origin}/#site` },
				inLanguage: "en",
				primaryImageOfPage: { "@type": "ImageObject", url: imageUrl, width: image.width, height: image.height },
				...(published ? { datePublished: published } : {}),
				...(lastmod ? { dateModified: lastmod } : {}),
			},
			publisher,
		],
	};
	const page = graph["@graph"][1];
	if (type === "Article" || type === "TechArticle") {
		page.headline = title.replace(titleSuffix, "");
		page.mainEntityOfPage = url;
		page.author = {
			"@type": "Person",
			name: article?.author ?? publisher.name,
			url: `${product.origin}/#project`,
		};
		page.publisher = { "@id": publisher["@id"] };
		page.image = [imageUrl, ...(article?.image ? [`${product.origin}${article.image}`] : [])];
		page.about = { "@id": `${product.origin}/#application` };
	}
	if (path !== "/" && path !== "/404.html") {
		const parent = path.startsWith("/docs/")
			? { name: "Docs", path: "/docs.html" }
			: article
				? { name: article.collection.label, path: article.collection.listing }
				: null;
		const crumbs = [
			{ name: "PanCode", path: "/" },
			...(parent ? [parent] : []),
			{ name: title.replace(titleSuffix, ""), path },
		];
		graph["@graph"].push({
			"@type": "BreadcrumbList",
			"@id": `${url}#breadcrumbs`,
			itemListElement: crumbs.map((crumb, i) => ({
				"@type": "ListItem",
				position: i + 1,
				name: crumb.name,
				item: `${product.origin}${crumb.path}`,
			})),
		});
		page.breadcrumb = { "@id": `${url}#breadcrumbs` };
	}
	if (path === "/") {
		graph["@graph"].push({
			"@type": "SoftwareSourceCode",
			name: "PanCode",
			codeRepository: repository,
			programmingLanguage: "TypeScript",
			version: product.version,
			license: `${repository}/blob/main/LICENSE`,
			author: { "@id": publisher["@id"] },
			publisher: { "@id": publisher["@id"] },
			targetProduct: { "@id": `${url}#application` },
		});
		graph["@graph"].push({
			"@type": "SoftwareApplication",
			"@id": `${url}#application`,
			name: product.name,
			url,
			description: product.description,
			applicationCategory: "DeveloperApplication",
			applicationSubCategory: "Coding agent",
			operatingSystem: "Linux, macOS, Windows",
			...(product.publishedVersion ? { softwareVersion: product.publishedVersion } : {}),
			downloadUrl: "https://www.npmjs.com/package/@akougkas/pancode",
			installUrl: `${url}#start`,
			softwareHelp: { "@type": "CreativeWork", url: `${product.origin}/docs.html` },
			license: `${repository}/blob/main/LICENSE`,
			isAccessibleForFree: true,
			offers: { "@type": "Offer", price: "0", priceCurrency: "USD", url: `${url}#start` },
			author: { "@id": publisher["@id"] },
			publisher: { "@id": publisher["@id"] },
			image: imageUrl,
			screenshot: ["gui-task", "tui-verify"].map((id) => ({
				"@type": "ImageObject",
				url: `${product.origin}/${captures[id].original}`,
				caption: captures[id].alt,
			})),
		});
		graph["@graph"].push({ "@type": "FAQPage", "@id": `${url}#questions`, mainEntity: faq });
	}
	return `<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${cast ? castContentSecurityPolicy : contentSecurityPolicy}"><meta name="referrer" content="strict-origin-when-cross-origin">
<title>${escapeHtml(title)}</title><meta name="description" content="${escapeHtml(description)}"><meta name="color-scheme" content="dark light"><meta name="pancode-default-theme" content="${escapeHtml(brand.defaultTheme)}">${themeColors}
<link rel="canonical" href="${url}"><link rel="manifest" href="/site.webmanifest"><link rel="icon" href="/favicon.ico" sizes="16x16 32x32 48x48"><link rel="icon" href="/assets/brand/pancode-mark-small.svg" type="image/svg+xml"><link rel="apple-touch-icon" href="/assets/responsive/pancode-icon-180.png" sizes="180x180"><link rel="author" href="/humans.txt">
${path === "/404.html" ? "" : brand.type.preload.map((name) => `<link rel="preload" href="/assets/fonts/${name}" as="font" type="font/woff2" crossorigin>`).join("")}
<link rel="stylesheet" href="/css/site.css"><link rel="stylesheet" href="/css/art.css"><script>${themeScript}</script>${cast ? `<script src="/js/cast.js" data-player-src="/assets/player/asciinema-player.min.js" data-player-css="/assets/player/asciinema-player.css" data-cast-css="/css/cast.css" defer></script>` : ""}
<meta property="og:locale" content="en_US"><meta property="og:site_name" content="${escapeHtml(product.name)}"><meta property="og:type" content="${type === "Article" || type === "TechArticle" ? "article" : "website"}"><meta property="og:url" content="${url}"><meta property="og:title" content="${escapeHtml(title)}"><meta property="og:description" content="${escapeHtml(description)}"><meta property="og:image" content="${imageUrl}"><meta property="og:image:type" content="image/png"><meta property="og:image:width" content="${image.width}"><meta property="og:image:height" content="${image.height}"><meta property="og:image:alt" content="${escapeHtml(imageAlt)}">${published && type !== "WebPage" ? `<meta property="article:published_time" content="${published}">` : ""}${lastmod && type !== "WebPage" ? `<meta property="article:modified_time" content="${lastmod}">` : ""}
<meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${escapeHtml(title)}"><meta name="twitter:description" content="${escapeHtml(description)}"><meta name="twitter:image" content="${imageUrl}"><meta name="twitter:image:alt" content="${escapeHtml(imageAlt)}">
<meta name="robots" content="${path === "/404.html" ? "noindex" : "index,follow,max-image-preview:large,max-snippet:-1"}"><script type="application/ld+json">${JSON.stringify(graph).replace(/</g, "\\u003c")}</script>`;
}
function shell(html, path, title, description, type, options) {
	const active = path.startsWith("/docs/")
		? "/docs.html"
		: (articles.find((item) => item.url === path)?.collection.listing ?? path);
	const header = mast.replace(/href="(\/|\/docs.html|\/learn.html|\/research.html|\/hub.html)"/g, (all, href) =>
		href === active ? `${all} aria-current="page"` : all,
	);
	let number = 0;
	const result = inlineArt(html.replace("<!-- site-header -->", header).replace("<!-- site-footer -->", footer), path)
		.replace("<!-- site-head -->", head(path, title, description, type, options))
		.replaceAll("<!-- version -->", escapeHtml(product.version))
		.replaceAll("<!-- published-version -->", escapeHtml(product.publishedVersion))
		.replace("<!-- version-source -->", `${repository}/tree/${ref}`)
		.replaceAll("<!-- source-blob -->", `${repository}/blob/${ref}`)
		// Open and close together: a transcript <pre> carries a class and must not gain a stray </div>.
		.replace(
			/<pre(?: data-label="([^"]*)")?>([\s\S]*?)<\/pre>/g,
			(_, label, body) =>
				`<div class="code-block">${label ? `<p class="code-label eyebrow">${label}</p>` : ""}<pre tabindex="0" aria-label="Code example ${++number}">${body}</pre></div>`,
		)
		.replace(
			/<span aria-hidden="true">([↗→←↓])<\/span>/g,
			(_, arrow) =>
				`<span class="arrow arrow-${{ "↗": "diagonal", "→": "forward", "←": "back", "↓": "down" }[arrow]}" aria-hidden="true">${arrow}</span>`,
		);
	return responsiveImages(
		result.replace(
			/ ([↗→←↓])(?=<\/a>)/g,
			(_, arrow) =>
				` <span class="arrow arrow-${{ "↗": "diagonal", "→": "forward", "←": "back", "↓": "down" }[arrow]}" aria-hidden="true">${arrow}</span>`,
		),
		path,
	);
}
// The code fence open after `line`, given the fence open before it, so
// directive syntax shown inside a code example stays literal.
function fence(line, open) {
	const marker = line.match(/^\s*(`{3,}|~{3,})/)?.[1];
	if (!marker) return open;
	if (!open) return marker;
	return marker[0] === open[0] && marker.length >= open.length && line.trim() === marker ? null : open;
}
// The lines of the directive opened at `start`, up to its own closing `:::`.
// A block such as steps may contain a nested directive, usually a capture.
function directiveBody(lines, start) {
	const inner = [];
	for (let i = start + 1, depth = 0, code = null; i < lines.length; i++) {
		if (!code && /^:::\s*[a-z]+/.test(lines[i])) depth++;
		else if (!code && lines[i].trim() === ":::" && depth-- === 0) break;
		code = fence(lines[i], code);
		inner.push(lines[i]);
	}
	return inner;
}
// Guide directives: a line `::: name arguments` opens a block and `:::`
// closes it. The body is Markdown. Directives compose the product's existing
// vocabulary (eyebrows, copper step numbers, rules, captures) into a guide.
function directives(markdown, render) {
	const lines = markdown.split("\n");
	let html = "";
	let buffer = [];
	const flush = () => {
		if (buffer.join("").trim()) html += render(buffer.join("\n"));
		buffer = [];
	};
	for (let i = 0, code = null; i < lines.length; i++) {
		const open = !code && lines[i].match(/^:::\s*([a-z]+)(?:\s+(.*))?$/);
		if (!open) {
			code = fence(lines[i], code);
			buffer.push(lines[i]);
			continue;
		}
		flush();
		const inner = directiveBody(lines, i);
		i += inner.length + 1;
		if (i >= lines.length) throw new Error(`Unclosed guide directive: ${open[1]}`);
		html += directive(open[1], (open[2] ?? "").trim(), inner.join("\n"), (text) => directives(text, render));
	}
	flush();
	return html;
}
function captureFigure(id, { frame = false, index = 0 } = {}) {
	const item = captures[id];
	if (!item) throw new Error(`Unknown capture: ${id}`);
	const image = `<a class="capture-frame" href="/${item.original}"><img src="/${item.image}" width="${item.width}" height="${item.height}" alt="${escapeHtml(item.alt)}" loading="lazy" decoding="async"></a>`;
	const source = `<span class="tag">${escapeHtml(item.interface)} · v${escapeHtml(item.version)}</span>`;
	if (frame)
		return `<li class="guide-frame" id="frame-${escapeHtml(id)}" data-label="${escapeHtml(item.label)}">${image}<p class="caption"><span class="step-number">${String(index + 1).padStart(2, "0")}</span> ${escapeHtml(item.caption)} ${source}</p></li>`;
	if (item.cast) {
		// The still, the download, and the transcript work without scripts; js/cast.js
		// adds a Play button that loads the player only when pressed.
		const length = castLength(item.duration);
		return `<figure class="guide-capture" data-cast="/${item.cast}" data-cast-cols="${item.cols}" data-cast-rows="${item.rows}" data-cast-poster="${item.posterAt}" data-cast-length="${length}">${image}<figcaption class="caption">${escapeHtml(item.caption)} ${source} <a class="cast-download" href="/${item.cast}" download>Recording · ${length}</a></figcaption><details class="cast-transcript"><summary>Transcript</summary><pre class="cast-transcript-text" tabindex="0" aria-label="Transcript of the recording">${escapeHtml(item.transcriptText)}</pre></details></figure>`;
	}
	return `<figure class="guide-capture">${image}<figcaption class="caption">${escapeHtml(item.caption)} ${source}</figcaption></figure>`;
}
function castLength(seconds) {
	const whole = Math.round(seconds);
	return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}
function guideDiagram(id) {
	const item = guideDiagrams[id];
	if (!item) throw new Error(`Unknown guide diagram: ${id}`);
	const nodes = item.stages
		.map(
			(stage) =>
				`<li class="guide-node">${stage.via ? `<p class="guide-via">${escapeHtml(stage.via)}</p>` : ""}${stage.place ? `<p class="eyebrow">${escapeHtml(stage.place)}</p>` : ""}<h3 class="guide-node-label">${escapeHtml(stage.label)}</h3>${stage.body ? `<p>${escapeHtml(stage.body)}</p>` : ""}</li>`,
		)
		.join("");
	return `<figure class="guide-diagram guide-diagram-${escapeHtml(item.type)}"><p class="eyebrow"><span class="chapter">${escapeHtml(item.title)}</span></p><ol class="guide-flow">${nodes}</ol><figcaption class="caption">${escapeHtml(item.caption)}</figcaption></figure>`;
}
function directive(name, args, inner, render) {
	const plain = (text) =>
		text
			.replace(/[*_`>]/g, "")
			.replace(/\s+/g, " ")
			.trim();
	switch (name) {
		case "needs":
			return `<section class="guide-needs">${render(`## ${args || "Before you start"}\n\n${inner}`)}</section>`;
		case "steps": {
			const steps = render(inner)
				.split(/(?=<h3 )/)
				.filter((part) => part.trim());
			// A titled steps group opens its own section, so the contents list and its tracker reach the steps.
			return `${args ? render(`## ${args}`) : ""}<ol class="guide-steps">${steps.map((step, index) => `<li class="guide-step"><span class="step-number" aria-hidden="true">${String(index + 1).padStart(2, "0")}</span><div>${step}</div></li>`).join("")}</ol>`;
		}
		case "prompt":
			return `<figure class="guide-prompt"><figcaption class="eyebrow"><span class="chapter">${escapeHtml(args || "Ask PanCode")}</span></figcaption><blockquote>${render(inner)}</blockquote><button type="button" class="copy" data-copy="${escapeHtml(plain(inner))}" aria-label="Copy the request">Copy</button></figure>`;
		case "result":
			return `<section class="guide-result"><p class="eyebrow"><span class="chapter">${escapeHtml(args || "What you should see")}</span></p>${render(inner)}</section>`;
		case "limits":
			return `<section class="guide-limits"><p class="eyebrow"><span class="chapter">${escapeHtml(args || "Boundaries")}</span></p>${render(inner)}</section>`;
		case "note":
			return `<aside class="guide-note"><p class="eyebrow">${escapeHtml(args || "Note")}</p>${render(inner)}</aside>`;
		case "capture": {
			const ids = args.split(/\s+/).filter(Boolean);
			if (ids.length === 1) return captureFigure(ids[0]);
			const caption = inner.trim()
				? `<figcaption class="caption">${render(inner).replace(/<\/?p>/g, "")}</figcaption>`
				: "";
			return `<figure class="guide-sequence" data-sequence><ol class="guide-frames">${ids.map((id, index) => captureFigure(id, { frame: true, index })).join("")}</ol>${caption}</figure>`;
		}
		case "diagram":
			return guideDiagram(args);
		case "tabs": {
			// Each `### Label` section becomes a tab panel. The heading stays in the
			// panel, so the Markdown and the no-script page read as plain sections.
			const panels = render(inner)
				.split(/(?=<h3 )/)
				.filter((part) => part.trim());
			return `<div class="tab-set" data-tabs="${escapeHtml(args || "Options")}">${panels
				.map((panel) => {
					const [, id, label] = panel.match(/^<h3 id="([^"]+)">([\s\S]*?)<\/h3>/) ?? [];
					if (!id) throw new Error("Each tab in a tabs directive starts with a ### heading");
					const text = label.replace(/<[^>]+>/g, "");
					const windows = /PowerShell|CMD/.test(text) ? ' data-tab-platform="windows"' : "";
					return `<div class="tab-panel" id="tab-${id}" data-tab="${escapeHtml(text)}"${windows}>${panel.replace("<h3 ", '<h3 class="tab-label" ')}</div>`;
				})
				.join("")}</div>`;
		}
		case "compare":
			return `<div class="guide-compare">${render(inner)}</div>`;
		case "next":
			return `<nav class="guide-next" aria-label="${escapeHtml(args || "Next steps")}">${render(inner).replace(/<\/a><\/li>/g, ' <span aria-hidden="true">→</span></a></li>')}</nav>`;
		default:
			throw new Error(`Unknown guide directive: ${name}`);
	}
}
// Resolves a Markdown link in a public source to its page on this site or, for
// anything not published here, to the pinned repository file.
function linkTarget(href, sourcePath, image = false) {
	if (/^(?:https?:|mailto:|\/)/i.test(href)) return href;
	if (href.startsWith("#"))
		return !anchors.has(sourcePath) || anchors.get(sourcePath).has(href.slice(1))
			? href
			: `${repository}/blob/${ref}/${sourcePath}${href}`;
	const [file, hash] = href.split("#");
	const normalized = posix.normalize(posix.join(posix.dirname(sourcePath), file));
	const url = sourceMap.get(normalized);
	if (url && (!hash || anchors.get(normalized)?.has(hash))) return `${url}${hash ? `#${hash}` : ""}`;
	if (image && normalized.startsWith("assets/")) {
		const known = {
			"assets/screenshots/tui-boot.webp": "/assets/tui-boot.webp",
		};
		if (known[normalized]) return known[normalized];
	}
	return `${repository}/blob/${ref}/${normalized}${hash ? `#${hash}` : ""}`;
}
function renderMarkdown(markdown, sourcePath, guide = false) {
	const ids = new Map();
	const target = (href, image = false) => linkTarget(href, sourcePath, image);
	const renderer = new marked.Renderer();
	renderer.heading = function ({ tokens, depth }) {
		const text = this.parser.parseInline(tokens);
		const base = slug(text);
		const count = ids.get(base) ?? 0;
		ids.set(base, count + 1);
		const id = escapeHtml(base + (count ? `-${count}` : ""));
		// A numbered section ("1. Install PanCode") sets its number apart; the heading text stays as written.
		const numbered = depth === 2 && text.match(/^(\d+\.)\s+([\s\S]+)$/);
		if (numbered)
			return `<h2 id="${id}" class="numbered-section"><span class="step-number">${numbered[1]}</span> <span>${numbered[2]}</span></h2>\n`;
		return `<h${depth} id="${id}">${text}</h${depth}>\n`;
	};
	renderer.link = function ({ href, tokens, title }) {
		if (/^(?:javascript|data|vbscript):/i.test(href)) return this.parser.parseInline(tokens);
		return `<a href="${escapeHtml(target(href))}"${title ? ` title="${escapeHtml(title)}"` : ""}>${this.parser.parseInline(tokens)}</a>`;
	};
	renderer.image = ({ href, text }) =>
		`<img src="${escapeHtml(target(href, true))}" alt="${escapeHtml(text)}" loading="lazy" decoding="async">`;
	renderer.code = ({ text, lang }) => {
		const [language, ...rest] = (lang ?? "").split(/\s+/);
		const title = rest.join(" ").match(/^title=(.+)$/)?.[1];
		const label =
			title ??
			{ sh: "Shell", bash: "Shell", powershell: "PowerShell", bat: "CMD", yaml: "YAML", json: "JSON", text: "" }[
				language
			] ??
			"";
		return `<pre${label ? ` data-label="${escapeHtml(label)}"` : ""}><code${language ? ` class="language-${escapeHtml(language)}"` : ""}>${escapeHtml(text)}</code></pre>\n`;
	};
	let table = 0;
	const render = (text) => marked.parse(text, { gfm: true, renderer });
	const body = guide ? directives(markdown, render) : render(markdown);
	return body
		.replace(
			/<table>/g,
			() => `<div class="doc-table" role="region" aria-label="Reference table ${++table}" tabindex="0"><table>`,
		)
		.replace(/<\/table>/g, "</table></div>");
}
// A guide's excerpt is short; its first sentence of body text makes the search
// snippet say what the page covers, without running far past what a result shows.
// An explicit catalog description replaces that when the pair reads poorly.
function docDescription(item, markdown) {
	if (item.description) return item.description;
	const paragraph = marked
		.lexer(markdown)
		.find((token) => token.type === "paragraph" && token.text.trim() !== item.excerpt);
	const sentence = paragraph ? plainText(marked.parseInline(paragraph.text)).match(/^.+?[.!?](?=\s|$)/)?.[0] : null;
	const echo = item.excerpt.toLowerCase().replace(/\.$/, "").split(" ").slice(-4).join(" ");
	return sentence && !sentence.toLowerCase().includes(echo) && item.excerpt.length + sentence.length < 200
		? `${item.excerpt} ${sentence}`
		: item.excerpt;
}
async function writePage(path, html, title, description, type, { sources = [], preview } = {}) {
	const file = join(out, path === "/" ? "index.html" : path.slice(1));
	await mkdir(dirname(file), { recursive: true });
	const lastmod = sources.length ? lastModified(sources) : null;
	const first = lastmod && type !== "WebPage" ? firstPublished(sources.filter((file) => file !== "product.json")) : null;
	const published =
		first && Date.parse(first) <= Date.parse(lastmod) ? first : lastmod && type !== "WebPage" ? lastmod : null;
	const dated = html
		.replace(
			"<!-- updated-fact -->",
			lastmod ? `<div><dt class="eyebrow">Updated</dt><dd>${updatedOn(lastmod)}</dd></div>` : "",
		)
		.replace("<!-- updated-line -->", lastmod ? `<span>Updated ${updatedOn(lastmod)}</span>` : "");
	const cast = /<figure class="guide-capture[^"]*" data-cast="/.test(dated);
	if (cast) castPages.push(path);
	const result = shell(dated, path, title, description, type, {
		lastmod,
		published,
		cast,
		...(preview ? { preview } : {}),
	});
	if (/<!--\s*(?:site-|doc-|tutorial-|source-|hub-|footer-|version|art:)/.test(result))
		throw new Error(`Unresolved template slot in ${path}`);
	await writeFile(file, result);
	if (path !== "/404.html") urls.push({ path, lastmod });
}

const marker = ".pancode-site-build";
const existing = await readdir(out).catch((error) => {
	if (error.code === "ENOENT") return [];
	throw error;
});
if (existing.length && (!existing.includes(marker) || (await readFile(join(out, marker), "utf8")) !== `${root}\n`))
	throw new Error("Refusing to replace an output directory this builder does not own.");
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
await writeFile(join(out, marker), `${root}\n`);
await mkdir(join(out, "assets/brand"), { recursive: true });
await mkdir(join(out, "assets/fonts"), { recursive: true });
for (const name of fontFiles(brand)) await cp(join(root, "assets/fonts", name), join(out, "assets/fonts", name));
await mkdir(join(out, "assets/responsive"), { recursive: true });
for (const path of [
	...Object.values(imageVariants).flatMap((item) => item.variants.map((v) => v.path)),
	"assets/responsive/pancode-icon-180.png",
	"assets/responsive/pancode-icon-192.png",
	"assets/responsive/pancode-icon-512.png",
	"assets/responsive/pancode-icon-maskable-512.png",
])
	await cp(join(root, path), join(out, path));
for (const name of [
	"temperature-calibration.zip",
	"social-card.png",
	"social-card-light.png",
	"social-square.png",
	"social-square-light.png",
])
	await cp(join(root, "assets", name), join(out, "assets", name));
await mkdir(join(out, "assets/social"), { recursive: true });
for (const item of Object.values(social.images)) await cp(join(root, item.path), join(out, item.path));
for (const item of Object.values(captures))
	for (const path of [item.image, item.original, ...(item.cast ? [item.cast] : [])]) {
		await mkdir(dirname(join(out, path)), { recursive: true });
		await cp(join(root, path), join(out, path));
	}
for (const name of ["pancode-mark.webp", "pancode-mark.png"])
	await cp(join(root, "assets/brand", name), join(out, "assets/brand", name));
// The published marks are the sources with their palette references resolved, as render-brand.mjs does for
// rasters. The small cut is the SVG favicon; the light cut is for light grounds.
for (const name of ["pancode-mark.svg", "pancode-mark-small.svg", "pancode-mark-light.svg"])
	await writeFile(
		join(out, "assets/brand", name),
		(await readFile(join(root, "..", "assets/brand", name), "utf8")).replace(
			/var\(--palette-([a-z0-9]+), #[0-9a-f]{6}\)/gi,
			(_, colour) => {
				if (!brand.palette[colour]) throw new Error(`${name} names an unknown palette colour: ${colour}`);
				return brand.palette[colour];
			},
		),
	);
await cp(join(root, "assets/responsive/favicon.ico"), join(out, "favicon.ico"));
await mkdir(join(out, "assets/animations"), { recursive: true });
for (const asset of JSON.parse(await read("animation-assets.json"))) {
	for (const path of [asset.video, asset.lightVideo, asset.poster]) {
		if (!/^assets\/animations\/[a-z-]+\.(?:mp4|webp)$/.test(path))
			throw new Error("Animation assets must name a selected derivative.");
		await cp(join(root, path), join(out, path));
	}
}
await mkdir(join(out, "css"));
// One render-blocking stylesheet: the generated tokens, then the site styles, in
// the order the two separate files cascaded.
await writeFile(join(out, "css/site.css"), minifyCss(`${await read("css/brand.css")}\n${await read("css/site.css")}`));
await writeFile(join(out, "css/landing.css"), minifyCss(await read("css/landing.css")));
await writeFile(join(out, "css/art.css"), minifyCss(await read("css/art.css")));
await mkdir(join(out, "js"));
for (const name of ["site.js", "docs.js", "redirect.js", "hub.js", "landing.js"])
	await cp(join(root, "js", name), join(out, "js", name));
await mkdir(join(out, "content"));
await writeFile(join(out, "content/docs-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
await writePage(
	"/",
	await read("index.html"),
	`PanCode: ${product.tagline.charAt(0).toLowerCase()}${product.tagline.slice(1)}`,
	product.summary,
	"WebPage",
	{ sources: ["index.html", "product.json"] },
);
await writePage(
	"/404.html",
	await read("404.html"),
	"Page not found · PanCode",
	"Find your way back to the PanCode overview, documentation, and tutorials.",
);

const groups = [...new Set(index.map((item) => item.group))];
const template = await read("docs.html");
for (const item of index) {
	const entry = manifest.files.find((file) => file.path === item.path);
	const markdown = await read(`content/docs/${item.path}`);
	if (createHash("sha256").update(markdown).digest("hex") !== entry?.sha256)
		throw new Error(`Documentation hash mismatch: ${item.path}`);
	const examples = (related.get(item.path) ?? []).filter((article) => !article.draft);
	const kinds = [...new Set(examples.map((article) => article.collection.label.toLowerCase()))].join(" and ");
	const relatedBlock = examples.length
		? `\n\n## Related ${kinds}\n\n::: next Related ${kinds}\n${examples.map((article) => `- [${article.title}](${article.url})`).join("\n")}\n:::\n`
		: "";
	const rendered = renderMarkdown(markdown + relatedBlock, item.source, true);
	const headings = [...rendered.matchAll(/<h2 id="([^"]+)"[^>]*>([\s\S]*?)<\/h2>/g)];
	const toc = headings.map(([, id, text]) => `<a href="#${id}">${text.replace(/<[^>]+>/g, "")}</a>`).join("\n");
	const nav = groups
		.map(
			(group) =>
				`<details class="doc-nav-group"${group === item.group || group === "Start" ? " open" : ""}><summary>${escapeHtml(group)}</summary>${index
					.filter((doc) => doc.group === group)
					.map(
						(doc) =>
							`<a href="${docUrl(doc.path)}"${doc.path === item.path ? ' aria-current="page"' : ""}>${escapeHtml(doc.title)}</a>`,
					)
					.join("\n")}</details>`,
		)
		.join("\n");
	const slots = {
		"doc-nav": nav,
		"doc-title": escapeHtml(item.title),
		"doc-source": `${repository}/blob/${ref}/${item.source}`,
		"doc-path": escapeHtml(item.path),
		"doc-content": `${toc ? `<details class="doc-toc-mobile"><summary>On this page</summary>${toc}</details>` : ""}${rendered}`,
		"doc-toc": toc ? `<h2>On this page</h2>${toc}` : "",
		"source-tree": `${repository}/tree/${ref}`,
		"source-version": escapeHtml(source.version),
		"source-ref": escapeHtml(source.ref),
		"source-commit": source.commit ?? "",
		"source-label": item.summary
			? `Guide to v${escapeHtml(source.version)}`
			: source.mode === "release"
				? `Documentation · v${escapeHtml(source.version)}`
				: "From the project documentation",
	};
	let html = template;
	for (const [name, value] of Object.entries(slots)) html = html.replaceAll(`<!-- ${name} -->`, value);
	await writePage(docUrl(item.path), html, pageTitle(item.title), docDescription(item, markdown), "TechArticle", {
		sources: [`content/docs/${item.path}`, item.summary ? `content/doc-summaries/${item.summary}` : `../${item.source}`],
	});
}
const search = index.map(
	({
		path,
		source: _source,
		sections: _sections,
		stripDetails: _strip,
		includeIntro: _intro,
		summary: _summary,
		description: _description,
		...item
	}) => ({
		path,
		...item,
		url: docUrl(path),
	}),
);
await writeFile(join(out, "content/index.json"), `${JSON.stringify(search, null, 2)}\n`);

// The files behind what a reader sees in the article body, so lastmod moves
// when its text, a caption or diagram it shows, or the version it was written
// for changes. Templates and registries are left out: adding a page to a
// registry or restyling the chrome is not a change to every other article.
function articleSources(item, markdown) {
	return [
		`${item.folder}/${item.source}`,
		...(item.cover || /^:::\s*capture/m.test(markdown) ? ["content/captures.json"] : []),
		...(/^:::\s*diagram/m.test(markdown) ? ["content/guide-diagrams.json"] : []),
		...(item.versionScope ? [] : ["product.json"]),
	];
}
const tutorialTemplate = await read("tutorial.html");
for (const item of articles) {
	const folder = item.folder;
	const markdown = await read(`${folder}/${item.source}`);
	const content = renderMarkdown(markdown, `site/${folder}/${item.source}`, true);
	const headings = [...content.matchAll(/<h2 id="([^"]+)"[^>]*>([\s\S]*?)<\/h2>/g)];
	const toc = headings.map(([, id, text]) => `<a href="#${id}">${text.replace(/<[^>]+>/g, "")}</a>`).join("\n");
	const facts = [
		["Written for", `v${item.versionScope ?? product.version}`],
		[
			"Works in",
			(item.interfaces ?? (item.collection.id === "research" ? ["Terminal"] : ["Terminal", "Desktop alpha"])).join(" · "),
		],
		["Basis", item.basis ?? "Documented workflow"],
	]
		.map(([label, value]) => `<div><dt class="eyebrow">${label}</dt><dd>${escapeHtml(value)}</dd></div>`)
		.join("")
		.concat("<!-- updated-fact -->");
	const cover = item.cover
		? captureFigure(item.cover)
				.replace('class="guide-capture"', 'class="guide-capture guide-cover"')
				.replace(' loading="lazy"', ' fetchpriority="high"')
		: item.image
			? `<img class="cover" src="${escapeHtml(item.image)}" width="${item.width}" height="${item.height}" alt="${escapeHtml(item.alt)}" />`
			: "";
	// One row per learning path this tutorial is a step of, from paths.json.
	const pathRows =
		item.collection.id === "tutorials"
			? paths
					.filter((path) => path.steps.includes(item.slug))
					.map((path) => {
						const step = path.steps.indexOf(item.slug);
						const link = (slug, label) => {
							const target = articles.find((article) => article.collection === item.collection && article.slug === slug);
							return `<span>${label}: <a href="${target.url}">${escapeHtml(target.title)}</a></span>`;
						};
						return `<li><a class="path-strip-path" href="${item.collection.listing}#${path.id}">${escapeHtml(path.label)} · step ${step + 1} of ${path.steps.length}</a>${step > 0 ? link(path.steps[step - 1], "Previous") : ""}${step < path.steps.length - 1 ? link(path.steps[step + 1], "Next") : `<span>Last step, <a href="${item.collection.listing}#learning-paths">back to the paths</a></span>`}</li>`;
					})
			: [];
	const pathStrip = pathRows.length
		? `<nav class="path-strip" aria-label="Learning path"><ul>${pathRows.join("")}</ul></nav>`
		: "";
	let html = tutorialTemplate
		.replace("<!-- collection-url -->", item.collection.listing)
		.replace("<!-- collection-label -->", item.collection.label.toLowerCase());
	const slots = {
		"tutorial-description": escapeHtml(item.description),
		"tutorial-path": pathStrip,
		"tutorial-facts": facts,
		"tutorial-cover": cover,
		"tutorial-toc": toc ? `<h2>On this page</h2>${toc}` : "",
		"tutorial-toc-mobile": toc ? `<details class="doc-toc-mobile"><summary>On this page</summary>${toc}</details>` : "",
		"tutorial-status": item.draft
			? `<p class="guide-review"><span class="status-dot"></span>Draft for review · not in the published catalog</p>`
			: item.status
				? `<p class="guide-review">${escapeHtml(item.status)}</p>`
				: "",
		"tutorial-title": escapeHtml(item.title),
		"tutorial-category": escapeHtml(item.category),
		"tutorial-time": escapeHtml(item.time),
		"tutorial-image": escapeHtml(item.image),
		"tutorial-alt": escapeHtml(item.alt),
		"tutorial-width": item.width,
		"tutorial-height": item.height,
		"tutorial-author": escapeHtml(item.author),
		"tutorial-content": content,
		"tutorial-video": item.video
			? `<iframe class="video" loading="lazy" src="https://www.youtube-nocookie.com/embed/${item.video}" title="${escapeHtml(item.title)} recording" allowfullscreen></iframe>`
			: "",
	};
	for (const [name, value] of Object.entries(slots)) html = html.replaceAll(`<!-- ${name} -->`, value);
	await writePage(item.url, html, pageTitle(item.title), item.description, "Article", {
		sources: articleSources(item, markdown),
		...(item.cover ? { preview: item.cover } : {}),
	});
}

const fact = (label, value) => `<div><dt class="eyebrow">${label}</dt><dd>${value}</dd></div>`;

// The PanHub catalog: the rows of the bundled hub/index.yaml as hub-catalog.mjs
// validated them, so the page lists exactly what this release installs.
const hubCommit = source.commit ?? values.revision ?? null;
const hubKinds = ["plugin", "extension", "server", "skill", "agent", "prompt", "playbook"];
const hubPlural = {
	plugin: "Plugins",
	extension: "Extensions",
	server: "Servers",
	skill: "Skills",
	agent: "Agents",
	prompt: "Prompts",
	playbook: "Playbooks",
};
const hubSource = (row) => {
	if (row.source.repository) {
		const repo = row.source.repository.replace(/\.git$/, "").replace(/\/$/, "");
		const path = row.source.path ? `/${row.source.path.split("/").map(encodeURIComponent).join("/")}` : "";
		const label = `${repo.replace(/^https:\/\/github\.com\//, "")}${row.source.path ? `/${row.source.path}` : ""} @ ${row.source.commit.slice(0, 12)}`;
		return `<a href="${escapeHtml(`${repo}/tree/${row.source.commit}${path}`)}">${escapeHtml(label)}</a>`;
	}
	return `<a href="${repository}/tree/${ref}/${row.source.path.split("/").map(encodeURIComponent).join("/")}">${escapeHtml(row.source.path)}</a>`;
};
const hubRow = (row) => {
	const id = `${row.kind}-${row.name}`;
	// The filter text keeps its case, so a product name is never printed as a lowercase command; hub.js folds case.
	const text = [row.kind, row.name, row.publisher, row.tier, row.licence, row.category ?? "", row.description].join(" ");
	const meta = [
		["Publisher", escapeHtml(row.publisher)],
		["Licence", escapeHtml(row.licence)],
		...(row.category ? [["Category", escapeHtml(row.category)]] : []),
		["Source", hubSource(row)],
	]
		.map(([label, value]) => `<div><dt>${label}</dt><dd>${value}</dd></div>`)
		.join("");
	return `<li class="hub-row" id="${escapeHtml(id)}" data-hub-text="${escapeHtml(text)}" data-hub-kind="${escapeHtml(row.kind)}"><div class="hub-row-head"><h3>${escapeHtml(row.name)}</h3><span class="tag">v${escapeHtml(row.version)}</span><span class="tag hub-tier" data-tier="${escapeHtml(row.tier)}">${escapeHtml(row.tier)}</span></div><details class="hub-row-more"><summary>${escapeHtml(row.description)}</summary><dl class="hub-meta">${meta}</dl></details>${hubCommand(row)}</li>`;
};
// A core server is built into PanCode, so its row gives the command another agent host runs to serve it.
const hubBuiltIn = (row) => row.kind === "server" && row.tier === "core";
const hubServe = (row) => `npx -y -p @akougkas/pancode pankit serve ${row.name}`;
// What a bare serve command leaves out, said beside it.
const hubServeNotes = {
	store: {
		html:
			"Started as shown, it runs with no store root configured. In a project, <code>pancode store where</code> prints the full command with its <code>--root</code>, <code>--cache</code> and <code>--project</code>.",
		markdown:
			"Started as shown, it runs with no store root configured; in a project, `pancode store where` prints the full command with its `--root`, `--cache` and `--project`.",
	},
};
const hubCommand = (row) => {
	const command = hubBuiltIn(row) ? hubServe(row) : row.install;
	const label = hubBuiltIn(row) ? "Copy the command that serves" : "Copy the install command for";
	const note =
		hubBuiltIn(row) && hubServeNotes[row.name]
			? `<p class="caption hub-serve-note">${hubServeNotes[row.name].html}</p>`
			: "";
	const line = `<div class="command-line"><code>${escapeHtml(command)}</code><button type="button" class="copy" hidden data-copy="${escapeHtml(command)}" aria-label="${label} ${escapeHtml(`${row.kind}:${row.name}`)}">Copy</button></div>`;
	return note ? `<div class="hub-command">${line}${note}</div>` : line;
};
// The packs a newcomer starts with, in hub-featured.json order, above the full catalog.
const hubFeatured = JSON.parse(await read("hub-featured.json")).map((key) => {
	const row = hubCatalog.rows.find((item) => `${item.kind}:${item.name}` === key);
	if (!row) throw new Error(`hub-featured.json names ${key}, which is not in the PanHub catalog.`);
	return `<li class="hub-featured-row"><div class="hub-row-head"><h3><a href="#${escapeHtml(`${row.kind}-${row.name}`)}">${escapeHtml(row.name)}</a></h3><span class="tag">${escapeHtml(row.kind)}</span><span class="tag hub-tier" data-tier="${escapeHtml(row.tier)}">${escapeHtml(row.tier)}</span></div><p>${escapeHtml(row.description)}</p>${hubCommand(row)}</li>`;
});
const hubKindRows = [...hubKinds, ...new Set(hubCatalog.rows.map((row) => row.kind))]
	.filter((kind, i, all) => all.indexOf(kind) === i)
	.map((kind) => [kind, hubCatalog.rows.filter((row) => row.kind === kind)])
	.filter(([, rows]) => rows.length);
const hubChips = hubKindRows
	.map(
		([kind]) =>
			`<button type="button" class="hub-chip" data-hub-kind="${escapeHtml(kind)}" aria-pressed="false">${hubPlural[kind] ?? escapeHtml(kind)}</button>`,
	)
	.join("");
const hubGroups = hubKindRows
	.map(
		([kind, rows]) =>
			`<section class="hub-group" aria-labelledby="hub-${kind}" data-hub-group><h2 id="hub-${kind}">${hubPlural[kind] ?? escapeHtml(kind)} <span class="hub-group-count" data-hub-group-count>${rows.length}</span></h2><ul class="hub-rows">${rows.map(hubRow).join("")}</ul></section>`,
	)
	.join("\n");
const hubIndexLink = `<a href="${repository}/blob/${hubCommit ?? ref}/${hubCatalog.source.path}"><code>${escapeHtml(hubCatalog.source.path)}</code></a>`;
const hubAt = hubCommit
	? `commit <a href="${repository}/commit/${hubCommit}"><code>${hubCommit.slice(0, 12)}</code></a>`
	: `<code>${escapeHtml(decodeURIComponent(ref))}</code>`;
const hubSlots = {
	"hub-count": String(hubCatalog.rows.length),
	"hub-facts": [
		fact("Ships in", `<code>pancode</code> v${escapeHtml(product.version)}`),
		fact("Command", "<code>pancode hub</code>"),
		fact("Packs", String(hubCatalog.rows.length)),
	].join(""),
	"hub-filter": `<div class="hub-filter" data-hub-filter hidden><label for="hub-query">Filter packs</label><input id="hub-query" type="search" autocomplete="off" spellcheck="false" placeholder="Name, publisher, licence or words from the description"><div class="hub-chips" role="group" aria-label="Kind"><button type="button" class="hub-chip" data-hub-kind="" aria-pressed="true">All</button>${hubChips}</div><p class="hub-filter-count" aria-live="polite" data-hub-count>${hubCatalog.rows.length} of ${hubCatalog.rows.length} packs</p></div>`,
	"hub-featured": `<section class="hub-featured" aria-labelledby="hub-featured-title" data-hub-featured><h2 id="hub-featured-title">Start with these</h2><ul class="hub-featured-rows">${hubFeatured.join("")}</ul></section>`,
	"hub-groups": hubGroups,
	"hub-source": `Bundled with PanCode v${escapeHtml(product.version)}: ${hubIndexLink} at ${hubAt}, sha256 <code class="hub-sha" data-hub-sha256>${hubCatalog.source.sha256}</code>.`,
};
let hubHtml = await read("hub.html");
for (const [name, value] of Object.entries(hubSlots)) hubHtml = hubHtml.replaceAll(`<!-- ${name} -->`, value);
await writePage("/hub.html", hubHtml, product.hub.title, product.hub.description, "WebPage", {
	sources: ["content/hub-catalog.json", "hub-featured.json", "hub.html", "product.json"],
});

for (const collection of collections) {
	const listed = articles.filter((item) => item.collection === collection);
	// A listing shows its featured guides as cards and every guide in its index.
	// Featured cards stack below 768 px and pair up above it; the slot is the card image box at each width.
	const cardSizes =
		"(max-width: 600px) calc(100vw - 40px), (max-width: 767px) calc(100vw - 64px), (max-width: 1100px) calc(50vw - 48px), (max-width: 1344px) calc(50vw - 64px), 608px";
	const cards = listed
		.filter((item) => item.featured)
		.map(
			// The first card image is the listing's largest above-the-fold content.
			(item, position) =>
				`<a class="tutorial-card" href="${item.url}">${item.image ? `<img src="${escapeHtml(item.image)}" width="${item.width}" height="${item.height}" alt="${escapeHtml(item.alt)}" sizes="${cardSizes}"${position === 0 ? ' fetchpriority="high"' : ' loading="lazy"'} decoding="async">` : ""}<p class="eyebrow">${escapeHtml(item.category)} / ${escapeHtml(item.time)}</p><h2>${escapeHtml(item.title)}</h2><p>${escapeHtml(item.description)}</p>${item.status ? `<p class="caption"><span class="chapter">${escapeHtml(item.status)}</span></p>` : ""}<span class="text-link">Read the tutorial <span aria-hidden="true">↗</span></span></a>`,
		)
		.join("\n");
	const learningPaths =
		collection.id === "tutorials"
			? `<div class="learning-paths" id="learning-paths">${paths
					.map((path, number) => {
						const steps = path.steps
							.map((slug, step) => {
								const item = articles.find((article) => article.collection === collection && article.slug === slug);
								return `<li><span class="step-number">${String(step + 1).padStart(2, "0")}</span><a href="${item.url}">${escapeHtml(item.title)}</a><span class="caption">${escapeHtml(item.time)}</span></li>`;
							})
							.join("");
						return `<section class="learning-path" id="${path.id}" aria-labelledby="${path.id}-title"><p class="eyebrow"><span class="chapter">Path ${number + 1} /</span> ${escapeHtml(path.label)}</p><h2 id="${path.id}-title">${escapeHtml(path.title)}</h2><p>${escapeHtml(path.summary)}</p><ol>${steps}</ol></section>`;
					})
					.join("\n")}</div>`
			: "";
	// An index lists guides in groups, one row each: a link, a description and the reading time.
	const indexGroups = (groups, description) =>
		groups
			.map(
				([name, items]) =>
					`<div class="index-group"><h2>${escapeHtml(name)}</h2><ul class="index-rows">${items
						.map(
							(item) =>
								`<li><a href="${item.url}">${escapeHtml(item.title)}</a><span class="index-desc">${description(item)}</span><span class="caption">${escapeHtml(item.time)}</span></li>`,
						)
						.join("")}</ul></div>`,
			)
			.join("\n");
	// The tutorial index groups follow this order; a tutorial in any other category fails the build.
	const tutorialCategories = [
		"Getting started",
		"Models and agents",
		"Checks and records",
		"Safety and autonomy",
		"Workers and fleets",
		"Context and memory",
		"Scientific software",
		"Extend and share",
	];
	if (collection.id === "tutorials")
		for (const item of listed)
			if (!tutorialCategories.includes(item.category))
				throw new Error(`Tutorial ${item.slug} has category ${item.category}, which is not a tutorial index group.`);
	const tutorialIndex =
		collection.id === "tutorials"
			? indexGroups(
					tutorialCategories.map((category) => [category, listed.filter((item) => item.category === category)]),
					(item) =>
						`${escapeHtml(item.description)}${item.status ? ` <span class="chapter index-status">${escapeHtml(item.status)}</span>` : ""}`,
				)
			: "";
	// Research: the five subsystems in order, then the open questions under the subsystem each belongs to.
	const subsystems = collection.id === "research" ? listed.slice(0, 5) : [];
	const researchTask = {
		drivers: "Route",
		memory: "Remember",
		scheduling: "Delegate",
		protection: "Contain",
		accounting: "Verify",
	};
	const researchSubsystems = subsystems.length
		? `<ol class="subsystem-list">${subsystems
				.map((item, number) => {
					if (!researchTask[item.slug]) throw new Error(`Research subsystem ${item.slug} has no PanCode task.`);
					if (!item.question) throw new Error(`Research subsystem ${item.slug} has no question.`);
					return `<li><span class="step-number">${String(number + 1).padStart(2, "0")}</span><a href="${item.url}"><h2>${escapeHtml(item.title)}</h2></a><span class="tag">${researchTask[item.slug]}</span><p>${escapeHtml(item.question)}</p></li>`;
				})
				.join("")}</ol>`
		: "";
	const subsystemOf = (item) => item.category.split(" · ")[0];
	const researchQuestions = subsystems.length
		? indexGroups(
				subsystems
					.map((subsystem) => subsystem.title.split(":")[0])
					.map((name) => [name, listed.slice(5).filter((item) => subsystemOf(item) === name)])
					.filter(([, items]) => items.length),
				(item) => escapeHtml(item.status),
			)
		: "";
	if (
		subsystems.length &&
		listed.slice(5).some((item) => !subsystems.some((s) => s.title.startsWith(`${subsystemOf(item)}:`)))
	)
		throw new Error("Every research question's category must start with the name of a subsystem.");
	await writePage(
		collection.listing,
		(await read(collection.listing.slice(1)))
			.replace("<!-- learning-paths -->", learningPaths)
			.replace("<!-- tutorial-cards -->", cards)
			.replace("<!-- tutorial-index -->", tutorialIndex)
			.replace("<!-- research-subsystems -->", researchSubsystems)
			.replace("<!-- research-questions -->", researchQuestions),
		collection.title,
		collection.description,
		"WebPage",
		{
			sources: [
				collection.listing.slice(1),
				`content/${collection.id}.json`,
				...(learningPaths ? ["content/paths.json"] : []),
			],
		},
	);
}

for (const [path, target] of Object.entries(redirects)) {
	const file = join(out, path.slice(1));
	await mkdir(dirname(file), { recursive: true });
	await writeFile(
		file,
		`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Continue to PanCode</title><meta name="robots" content="noindex"><meta http-equiv="refresh" content="0; url=${escapeHtml(target)}"><link rel="canonical" href="${product.origin}${escapeHtml(target)}"><link rel="stylesheet" href="/css/site.css"><script src="/js/redirect.js" defer></script></head><body><main class="page page-intro"><h1>This page has moved.</h1><p><a data-redirect href="${escapeHtml(target)}">Continue to PanCode →</a></p></main></body></html>`,
	);
}
await writeFile(
	join(out, "sitemap.xml"),
	`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map(({ path, lastmod }) => `  <url><loc>${product.origin}${escapeHtml(path)}</loc>${lastmod ? `<lastmod>${lastmod}</lastmod>` : ""}</url>`).join("\n")}\n</urlset>\n`,
);
await cp(join(root, "robots.txt"), join(out, "robots.txt"));
// humans.txt (humanstxt.org) credits the people behind the site; it carries no build date.
await writeFile(
	join(out, "humans.txt"),
	`/* TEAM */
Author: ${publisher.name}
Role: Creator and maintainer of ${product.name}
Site: ${publisher.url}
GitHub: https://github.com/akougkas

/* THANKS */
The authors of the Pi agent framework, Schibsted Grotesk, Instrument Sans, IBM Plex Mono and marked.

/* SITE */
Product: ${product.name}, ${product.tagline.charAt(0).toLowerCase()}${product.tagline.slice(1)}
Source: ${repository}
License: PanCode License 1.0 (source-available)
Language: English
Standards: HTML, CSS, JSON-LD, llms.txt
Software: static pages built with Node.js and served by GitHub Pages
`,
);

// llms.txt (llmstxt.org) indexes the public pages for language models, and
// llms-full.txt carries their Markdown sources with links resolved to this site.
// Both are generated from the same records as the pages and contain no dates.
const absolute = (href) => (href.startsWith("/") ? `${product.origin}${href}` : href);
function plainDirectives(markdown) {
	const lines = markdown.split("\n");
	const result = [];
	for (let i = 0, code = null; i < lines.length; i++) {
		const open = !code && lines[i].match(/^:::\s*([a-z]+)(?:\s+(.*))?$/);
		if (!open) {
			code = fence(lines[i], code);
			result.push(lines[i]);
			continue;
		}
		const inner = directiveBody(lines, i);
		i += inner.length + 1;
		const [name, args] = [open[1], (open[2] ?? "").trim()];
		const body = plainDirectives(inner.join("\n")).trim();
		const labelled = (label) => `**${args || label}**${body ? `\n\n${body}` : ""}`;
		const block = {
			needs: () => `## ${args || "Before you start"}\n\n${body}`,
			prompt: () => `**${args || "Ask PanCode"}**\n\n${body.replace(/^/gm, "> ")}`,
			result: () => labelled("What you should see"),
			limits: () => labelled("Boundaries"),
			note: () => labelled("Note"),
			next: () => labelled("Next steps"),
			capture: () =>
				[
					...args
						.split(/\s+/)
						.filter(Boolean)
						.map((id) =>
							[
								`![${captures[id].alt}](/${captures[id].image})\n\n*${captures[id].caption}*`,
								...(captures[id].cast
									? [
											`[Recording (asciicast)](/${captures[id].cast}), ${castLength(captures[id].duration)}. Transcript:\n\n\`\`\`text\n${captures[id].transcriptText}\n\`\`\``,
										]
									: []),
							].join("\n\n"),
						),
					...(body ? [body] : []),
				].join("\n\n"),
			diagram: () => {
				const item = guideDiagrams[args];
				const stages = item.stages.map(
					(stage, n) =>
						`${n + 1}. ${stage.label}${stage.place ? ` (${stage.place})` : ""}${stage.body ? `: ${stage.body}` : ""}${stage.via ? ` Moves from the previous stage: ${stage.via}.` : ""}`,
				);
				return `**${item.title}**\n\n${stages.join("\n")}\n\n*${item.caption}*`;
			},
		}[name];
		result.push("", block ? block() : body, "");
	}
	return result.join("\n").replace(/\n{3,}/g, "\n\n");
}
// Applies `transform` to the Markdown outside code fences, leaving examples as written.
function outsideCode(markdown, transform) {
	const parts = [];
	let prose = [];
	let code = null;
	const flush = () => {
		if (prose.length) parts.push(transform(prose.join("\n")));
		prose = [];
	};
	for (const line of markdown.split("\n")) {
		const next = fence(line, code);
		if (code || next) {
			flush();
			parts.push(line);
		} else prose.push(line);
		code = next;
	}
	flush();
	return parts.join("\n");
}
function llmMarkdown(markdown, sourcePath, pageUrl) {
	return outsideCode(plainDirectives(markdown), (part) =>
		part
			.replaceAll("<!-- source-blob -->", `${repository}/blob/${ref}`)
			.replace(/<a href="([^"]+)">([^<]*)<\/a>/g, "[$2]($1)")
			.replace(/(!?)\[([^\]\n]*)\]\(([^)\s]+)((?:\s+"[^"]*")?)\)/g, (_, bang, label, href, title) => {
				const resolved = linkTarget(href, sourcePath, Boolean(bang));
				return `${bang}[${label}](${resolved.startsWith("#") ? `${pageUrl}${resolved}` : absolute(resolved)}${title})`;
			}),
	).trim();
}
const published = articles.filter((item) => !item.draft);
const llmsSummary = `# PanCode

> ${product.description}

PanCode is a harness for development work. Panos, its orchestrator agent, plans a task, runs it on the models you connect and hands parts of it to workers, including the coding agents you already have. It routes across providers, sandboxes commands, checks finished work against what ran and keeps memory, in the terminal, in scripts and CI, in ACP editors or on the desktop. PanHub packs and PanKit servers cover HPC and scientific software.

PanCode needs no account and no root, and sends nothing home. It is source-available under the PanCode License 1.0: free for individuals, small organizations, and noncommercial research and teaching. ${publisher.name} writes and maintains it.

- Install on macOS, Linux, or WSL: \`curl -fsSL ${product.origin}/install.sh | sh\`
- Install on Windows (best effort) in PowerShell: \`irm ${product.origin}/install.ps1 | iex\`
- Install with npm (Node.js 22.19 or newer): \`npm install -g @akougkas/pancode\`
- Connect a model in a project: \`pancode configure\`; then run \`pancode\` for the terminal or \`pancode gui --open\` for the desktop alpha.
- ${product.publishedVersion ? `Current release: v${product.publishedVersion}.` : "Not released yet."} Source: ${repository}. License: PanCode License 1.0.`;
const hubMarkdown = () =>
	[
		`The ${hubCatalog.rows.length} packs listed in the index bundled with PanCode v${product.version}, from \`${hubCatalog.source.path}\` (sha256 ${hubCatalog.source.sha256}). A skill, plugin or extension installs with the command on its row, for your user; add \`--project\` to install it into the current project. A server is built into PanCode, so there is nothing to install: its row gives the command that serves it to another agent host over MCP, and that command takes no install flags. A listing at any tier is not an endorsement.`,
		hubCatalog.rows
			.map(
				(row) =>
					`- \`${row.kind}:${row.name}\` v${row.version}, ${row.tier}, ${row.publisher}, ${row.licence}: ${row.description} ${hubBuiltIn(row) ? `Built into PanCode; serve it to another agent host: \`${hubServe(row)}\`.${hubServeNotes[row.name] ? ` ${hubServeNotes[row.name].markdown}` : ""}` : `Install: \`${row.install}\``}`,
			)
			.join("\n"),
	].join("\n\n");
const llmsLink = (title, url, note) => `- [${title}](${absolute(url)})${note ? `: ${note}` : ""}`;
await writeFile(
	join(out, "llms.txt"),
	`${[
		llmsSummary,
		...groups.map(
			(group) =>
				`## ${group}\n\n${index
					.filter((doc) => doc.group === group)
					.map((doc) => llmsLink(doc.title, docUrl(doc.path), doc.excerpt))
					.join("\n")}`,
		),
		`## PanHub\n\n${llmsLink("PanHub", "/hub.html", product.hub.description)}`,
		...collections.map(
			(collection) =>
				`## ${collection.label}\n\n${published
					.filter((item) => item.collection === collection)
					.map((item) => llmsLink(item.title, item.url, item.description))
					.join("\n")}`,
		),
		`## Optional\n\n${[
			llmsLink(
				"Full text",
				"/llms-full.txt",
				"every guide, the PanHub catalog, and every tutorial and research page above as Markdown in one file",
			),
			llmsLink("Overview", "/", "capabilities, models, installation, and common questions"),
			llmsLink("Source repository", repository, "code, issues, and the full upstream guides"),
			llmsLink("npm package", "https://www.npmjs.com/package/@akougkas/pancode"),
			llmsLink("License", `${repository}/blob/main/LICENSE`, "PanCode License 1.0"),
		].join("\n")}`,
	].join("\n\n")}\n`,
);
const fullSections = [];
for (const item of index) {
	const url = absolute(docUrl(item.path));
	fullSections.push({ url, text: llmMarkdown(await read(`content/docs/${item.path}`), item.source, url) });
}
{
	const url = absolute("/hub.html");
	fullSections.push({ url, text: `# PanHub\n\n> ${product.hub.description}\n\n${hubMarkdown()}` });
}
for (const item of published) {
	const url = absolute(item.url);
	const markdown = llmMarkdown(await read(`${item.folder}/${item.source}`), `site/${item.folder}/${item.source}`, url);
	fullSections.push({ url, text: `# ${item.title}\n\n> ${item.description}\n\n${markdown}` });
}
const llmsFull = `${llmsSummary}

This file holds the public PanCode guides (documentation for v${source.version}), the PanHub catalog, tutorials, and research pages as Markdown. Each section names the page it comes from.

${fullSections.map(({ url, text }) => `---\n\nSource: ${url}\n\n${text}`).join("\n\n")}
`;
await writeFile(join(out, "llms-full.txt"), llmsFull);
console.log(
	`Built ${urls.length} public pages (${index.length} guides, ${tutorials.length} tutorials, ${research.length} research pages); llms-full.txt is ${Buffer.byteLength(llmsFull)} bytes.`,
);

// Stable bootstraps follow released assets even while the rest of the site awaits a redeploy.
// Deploy snapshots carry these inputs inside the site's Docker build context.
const installerRoot = (await readdir(root)).includes("scripts") ? join(root, "scripts") : join(root, "..", "scripts");
for (const name of ["install.sh", "install.ps1", "install.cmd"]) await cp(join(installerRoot, name), join(out, name));
if (castPages.length) {
	await mkdir(join(out, "assets/player"), { recursive: true });
	for (const [from, to] of [
		["vendor/asciinema-player/asciinema-player.min.js", "asciinema-player.min.js"],
		["vendor/asciinema-player/asciinema-player.css", "asciinema-player.css"],
		["vendor/asciinema-player/LICENSE", "asciinema-player-LICENSE.txt"],
		["vendor/cast-symbols/cast-symbols.woff2", "cast-symbols.woff2"],
		["vendor/cast-symbols/LICENSE", "cast-symbols-LICENSE.txt"],
	])
		await cp(join(root, from), join(out, "assets/player", to));
	await writeFile(join(out, "css/cast.css"), minifyCss(await read("css/cast.css")));
	await cp(join(root, "js/cast.js"), join(out, "js/cast.js"));
}
await writeFile(join(out, "CNAME"), `${new URL(product.origin).hostname}\n`);
await writeFile(join(out, ".nojekyll"), "");
await writeFile(
	join(out, "version.json"),
	`${JSON.stringify({ site: product.version, publishedVersion: product.publishedVersion, docsCommit: source.commit ?? null, revision: values.revision ?? null }, null, 2)}\n`,
);
// Blade-only until its retirement: nginx consumes these, GitHub Pages ignores dotfiles.
const nginxRedirects = Object.entries(redirects)
	.map(([path, target]) => {
		const url = new URL(target, product.origin);
		return `location = ${path} { return 308 "${url.pathname}$is_args$args${url.hash}"; }`;
	})
	.join("\n");
await writeFile(join(out, ".pancode-redirects.conf"), `${nginxRedirects}\n`);

await writeFile(
	join(out, ".pancode-revision.conf"),
	// The blade's policy must allow the inlined theme script by the same hash.
	`add_header Content-Security-Policy "${contentSecurityPolicy}" always;\n${
		values.revision
			? `add_header X-Pancode-Site-Revision "${values.revision}" always;\n`
			: "# Local preview has no deployed revision.\n"
	}`,
);

await writeFile(
	join(out, "site.webmanifest"),
	`${JSON.stringify(
		{
			id: "/",
			name: product.name,
			short_name: product.name,
			description: product.tagline,
			lang: "en",
			start_url: "/",
			scope: "/",
			display: "browser",
			background_color: brand.palette[brand.themes[brand.defaultTheme === "light" ? "light" : "dark"].paper],
			theme_color: brand.palette[brand.themes[brand.defaultTheme === "light" ? "light" : "dark"].paper],
			icons: [
				...[192, 512].map((size) => ({
					src: `/assets/responsive/pancode-icon-${size}.png`,
					sizes: `${size}x${size}`,
					type: "image/png",
					purpose: "any",
				})),
				{
					src: "/assets/responsive/pancode-icon-maskable-512.png",
					sizes: "512x512",
					type: "image/png",
					purpose: "maskable",
				},
			],
		},
		null,
		2,
	)}\n`,
);

// Every built reference to a stylesheet, script, font, image, or video carries a
// short hash of the file's bytes, so a deploy changes the URL of anything that
// changed and no visitor pairs new pages with a stale cached asset.
const outputFiles = (await readdir(out, { recursive: true })).map((file) => file.split(sep).join("/"));
const assetHashes = new Map();
async function hashAssets(pattern) {
	for (const file of outputFiles.filter((name) => pattern.test(name)))
		assetHashes.set(
			`/${file}`,
			createHash("sha256")
				.update(await readFile(join(out, file)))
				.digest("hex")
				.slice(0, 10),
		);
}
const versioned = (url, base = "/") => {
	const hash = assetHashes.get(new URL(url, `${product.origin}${base}`).pathname);
	return hash ? `${url}?v=${hash}` : url;
};
await hashAssets(/\.(?:woff2|png|webp|jpe?g|svg|ico|mp4|cast)$/);
for (const file of outputFiles.filter((name) => name.endsWith(".css")))
	await writeFile(
		join(out, file),
		(await readFile(join(out, file), "utf8")).replace(
			/url\((["']?)([^"')?#:]+)\1\)/g,
			(_, quote, url) => `url(${quote}${versioned(url, `/${file}`)}${quote})`,
		),
	);
await hashAssets(/\.(?:css|js)$/);
for (const file of outputFiles.filter((name) => name.endsWith(".html")))
	await writeFile(
		join(out, file),
		(await readFile(join(out, file), "utf8"))
			.replace(
				/(\s(?:href|src|poster|data-src|data-light-src|data-cast|data-player-src|data-player-css|data-cast-css)=")(\/[^"?#]*)"/g,
				(_, attr, url) => `${attr}${versioned(url)}"`,
			)
			.replace(
				/(\ssrcset=")([^"]+)"/g,
				(_, attr, list) =>
					`${attr}${list
						.split(/,\s*/)
						.map((candidate) => candidate.replace(/^\/\S+/, (url) => versioned(url)))
						.join(", ")}"`,
			),
	);
