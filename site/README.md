# PanCode public site

A static public window into PanCode: one overview, user documentation, practical tutorials, and open research questions. The site has no account flow or hosted agent service. Read [DESIGN.md](DESIGN.md) before making changes.

## Live local preview

From the repository root, after `corepack pnpm install`:

```sh
corepack pnpm run site:dev
```

Open **http://localhost:4321/**. The command runs `node site/dev.mjs`, which builds the site, regenerates the public guides from current repository files, serves the result, watches the site sources, `docs/guide/`, `README.md` and `package.json`, and reloads connected browsers after each rebuild. A failed rebuild prints its error and keeps serving the last working build. Stop it with Ctrl+C.

Regenerating the guides rewrites `site/content/docs/`, `site/content/index.json` and `site/content/docs-manifest.json` when a guide changed. Use `corepack pnpm run site:dev -- --snapshot` to preview the committed documentation snapshot without regenerating it. The server listens on all local interfaces so a forwarded browser can reach it. Pass `-- --host 127.0.0.1` for loopback-only access, or `-- --port 4180` for another port. Generated output is in ignored `.preview/` directories; verification screenshots stay outside the public tree.

Review the unregistered guides in `content/drafts/` in a second preview with its own output directory: `node site/dev.mjs --snapshot --review --dir .preview-review --port 4191`. Two previews must never share a directory.

Serve a finished build as Pages would with `node site/dev.mjs --serve <directory> [--host 127.0.0.1] [--port 4187]`. It refuses a directory without the build's ownership marker, does not build, watch or inject a reload script, maps `/name` to `name.html` and `/dir/` to `dir/index.html`, and answers a missing path with `404.html` and status 404. Point `browser-check.mjs` and `performance-check.mjs` at it to check exactly what would be published.

## PanHub catalog

PanCode is one platform: the site has no product family, no page for PanStore or the extension API (their 0.9.0 URLs are gone, not redirected), and `policy.mjs` and `check.py` reject PanSDK, "family" and a `panstore` command anywhere a visitor or crawler reads. The PanHub page's title and description live in the `hub` object of `product.json`.

`/hub.html` lists the packs in the index bundled with this release; community pack trees are fetched and only their rows ship. `node site/hub-catalog.mjs` reads the bundled `hub/index.yaml`, validates every row with PanCode's own PanHub row validator, drops revoked digests, and writes `content/hub-catalog.json` with the index commit and sha256. A row the validator rejects is refused with its row named, and nothing is written. Run it again after `hub/index.yaml` changes. `node site/hub-catalog.mjs --check` fails when the committed catalog no longer matches the index; `--index <file>` and `--catalog <file>` point it at other files. The build never reads the network: the page is the committed snapshot, with a filter that needs JavaScript and a full list without it. `node --test site/tests/hub-catalog.test.mjs` covers the generator.

## Design and prose rules

- `design-system.json` is the sanctioned palette, semantic theme map, type, space, radius, elevation, glow and motion tokens, and the voice and copy policy.
- `tokens.mjs` generates `css/brand.css`; component CSS cannot introduce literal colors.
- `DESIGN.md` documents the PanCode identity, naming, writing, copyright, and accessibility rules.
- `partials.html` supplies one header and footer. Primary navigation is Overview, Docs, Tutorials, Research, PanHub.
- `art/<name>.svg` is a drawing the build inlines wherever a template or partial writes `<!-- art:<name> -->`; a missing file fails the build. Drawings carry classes only, coloured by `css/art.css`, so they follow the theme. `policy.mjs` rejects inline styles, literal colours and scripts in them.
- `policy.mjs` runs on every build and checks palette drift, color declarations, art, motion tokens, public copy length, disallowed phrases, navigation, attribution, and documentation boundaries.

The identity is a cool graphite dark and a cream light with a brand green, an azure secondary and cool near-white ink. The wordmark sets Pan in the green and Code in the azure. The mark is a stone of four facets with the for-all sign as the channel between them; its hand-written SVG sources are `assets/brand/pancode-mark.svg` and its small and light cuts at the repository root, `node site/render-brand.mjs` renders them into `site/assets/brand/`, and the provenance file there records the rendered hash and dimensions.

Export the selected artwork, tokens, fonts, and licenses for another PanCode project with `node site/export-brand.mjs --out <scratch>/pancode-brand-kit`. The kit contains no site layout code.

The live theme default is controlled by `defaultTheme` in `design-system.json`. Use `dark` (current), `light`, or `system`. Saved visitor preferences still take priority. Regenerate tokens and deploy a committed build after changing it; the initial HTML metadata and no-JavaScript CSS use the same setting.

After an explicitly authorized token change:

```sh
node site/tokens.mjs
```

## Generated documentation

`public-docs.json` explicitly selects user-facing repository sources, short labels, task groups, and optional source sections or authored summaries. The current visitor guides use brief summaries in `content/doc-summaries/`; edit those files, then regenerate the snapshot. `sync-docs.py` checks summary paths and produces the Markdown snapshot, search index, and provenance manifest. The manifest retains a hash of each full upstream guide and, for a pinned snapshot, its immutable source commit. Each public page links to that full guide. Neither summary Markdown nor the architecture corpus, audits, or agent work journals enter the public build. When section selection is used, every selected upstream heading must still exist.

```sh
python3 site/sync-docs.py --worktree
python3 site/sync-docs.py --check
```

`--worktree` writes a tree snapshot: mode `tree`, ref `main`, full input hashes, and generated document hashes, with no commit. `--check` regenerates it from the current files, so committing an unchanged snapshot does not invalidate it, and editing a selected guide, a summary or `public-docs.json` without regenerating fails. `pnpm run lint` runs `--check` as the `site-docs-snapshot` hygiene check. A tree snapshot is the committed pin only before the first release, while `publishedVersion` is empty; `--check` rejects it once a release is recorded. Before that release the public history does not exist yet, so a commit would name nothing a reader could find.

For a future release snapshot, after its matching tag exists:

```sh
python3 site/sync-docs.py --source-ref v<VERSION>
```

`product.json.version` describes the documentation source; `publishedVersion` describes the released npm package and stays empty until the first release. They intentionally differ during development. The overview and structured source metadata use `version`, set to the upcoming release while a development tree is pinned (a `-dev` package version is accepted for tree and repository snapshots). A tree preview also accepts a pre-release of a later version, such as `0.9.1-rc.1` while the site stays on `0.9.0`; deployment and release checks reject tree snapshots once a release exists, so regenerate the committed pin with `--snapshot-ref <COMMIT>` or `--source-ref v<VERSION>` before committing. While `publishedVersion` is empty the site names no current release and omits `softwareVersion` from its structured data. The source version link points to the pinned repository snapshot. Keep `publishedVersion` accurate to the npm registry; update it only after confirming the published package. Installation always uses the actual npm package, with no link to an unpublished release tag.

A website can also pin the reviewed source without creating a package release:

```sh
python3 site/sync-docs.py --snapshot-ref <COMMIT>
python3 site/sync-docs.py --check
```

Repository snapshots use a full commit as their source reference and validate against its original document bytes. They remain valid after later working-tree changes. Production accepts an immutable repository or release snapshot and rejects a tree snapshot. `deployment-check.mjs` also refuses a site with no recorded release, so the first stable release is the first deployment.

## Tutorials, research pages, and recordings

Research pages use the same registry shape in `content/research.json`, with Markdown in `content/research/`. They render at `/research/<slug>.html` and are listed at `/research.html`. Every old `/experimental` URL stays in `redirects.json`.

Write a useful Markdown article in `content/tutorials/` and register it in `content/tutorials.json`. [CONTENT.md](CONTENT.md) describes the guide blocks, the capture registry, and review builds; a `cover` names a capture in `content/captures.json` in place of `image`, `width`, `height`, and `alt`. Supply a slug, title, description, category, reading time, author, image dimensions, alt text, and source filename. The builder creates both its article and listing entry. An optional `video` field accepts a real YouTube ID and uses the privacy-enhanced embed domain. Publish captions with the recording. Empty media entries and fictional product demonstrations are not allowed.

`assets/temperature-calibration.zip` is the standalone runnable example from the recorded local PanCode session. It contains only the implementation, seven tests, private package manifest, and README. It is published through the explicit build asset list so the tutorial does not depend on a separate product repository push. Test an extracted archive with `npm test` in its `temperature-calibration/` directory when replacing it.

## Build and verify

```sh
python3 site/sync-docs.py --check
node site/tokens.mjs --check
node site/policy.mjs
node site/build.mjs
python3 site/check.py
python3 site/tests/sync-docs.test.py
node site/hub-catalog.mjs --check
node --test site/tests/hub-catalog.test.mjs
python3 site/image-variants.py --check
pnpm exec biome check site
node site/browser-check.mjs
node site/performance-check.mjs
# add --paths /tutorials/<slug>.html to measure guides with captures
```

The static checker validates the link graph, anchors, metadata, source provenance, and rendered documentation. The browser check covers both themes at 320, 390, 768, 850, 1024, and 1440px, including the catalog and the privacy page; all guides receive desktop accessibility checks. Every page may fetch only from the site itself, apart from the Google Analytics origins above, and with an id set the consent banner must sit inside the viewport. It exercises the primary navigation by keyboard at every width and in the mobile Menu, the absence of the retired 0.9.0 family pages, the catalog filter and its Escape reset, repeated copying, search keyboard navigation, active contents links, FAQ controls, screenshot viewing and zoom, menu keyboard behavior, saved themes, runtime reduced-motion changes, touch tablet rotation, redirects, 404 handling, and navigation without JavaScript. It writes screenshots and results to `/tmp/pancode-site-review` by default; pass `--out` elsewhere. Pass `--url`, `--out`, or `--chrome` to override defaults; browser dependencies are reused from the GUI workspace.

Responsive images and square browser icons are generated from approved originals with `python3 site/image-variants.py`; `image-variants.json` records the hashes and sizes. Every build verifies these assets and adds responsive image attributes. The full-size viewer capture loads only when opened. The performance check measures cold-cache mobile FCP, LCP, layout shift, and initial asset transfers at 2Mbps download, 100ms latency, and 4x CPU slowdown. It writes `/tmp/pancode-site-review/performance.json` and enforces documented budgets. Run it without another browser audit in parallel. These local measurements do not represent field Core Web Vitals.

## Search and crawler outputs

The build writes `sitemap.xml`, `robots.txt`, `llms.txt`, `llms-full.txt`, and `humans.txt` from the same records as the pages. Each sitemap entry carries a `lastmod` from the last commit that touched the page sources; a build outside a git checkout omits it rather than guessing. `robots.txt` names the major search and AI crawlers, allows every page and asset, and blocks only the internal docs manifest. `llms.txt` is a short Markdown index of every docs, tutorial, and research page; `llms-full.txt` carries their full Markdown with absolute links and a `Source:` line per page. `humans.txt` credits the author and names the source and license.

Page titles and descriptions follow the canonical product copy: the overview title is `PanCode:` plus `product.json` `tagline`, its description is `summary`, and every other page is `<title> · PanCode` unless its title already names PanCode. `description`, the longer product description, feeds the structured data and `llms.txt`. Every page has a structured data graph (WebSite, a Person publisher, WebPage, breadcrumbs, and the article or software type that fits), and the home page adds a SoftwareApplication with a free offer and its author, and a FAQPage built from its questions. Each page declares `theme-color` for light and dark colour-scheme preferences, set to the paper the page shows without JavaScript; the theme script then sets both to the applied theme.

`python3 site/image-variants.py --icons` renders the icon set from the rendered mark: `favicon.ico` (16, 32 and 48 px, published at the site root), the 180 px touch icon, the 192 and 512 px manifest icons, and a maskable 512 px icon. The build also publishes the mark sources with their palette references resolved; the small cut is the SVG favicon. After an artwork change, run `node site/render-brand.mjs` and then this command. Social previews are real product captures: `python3 site/image-variants.py --social` renders a 1200x630 PNG for every tutorial cover plus the default GUI capture into `assets/social/`, recorded in `social-images.json`. Hreflang alternates are not used because the site has one language. `check.py` enforces sitemap coverage and format, redirect exclusion, preview size, FAQ coverage, the robots policy, and llms link coverage.

`node site/build.mjs --out <directory>` supports an alternative output path. It refuses to replace a nonempty directory without its ownership marker. Output contains only published HTML, selected browser scripts and styles, product assets, fonts and licenses, search metadata, and the source manifest.

## Deployment

GitHub Pages serves https://pancode.dev from the `gh-pages` branch, which holds only the built website. No Pages workflow deploys it. Two paths commit to that branch.

A stable release deploys the site as part of publication. `scripts/release/build.mjs` builds the site in an isolated checkout of the release commit, re-pinned there with `python3 site/sync-docs.py --snapshot-ref <COMMIT>`, on every CI run. `deployPages` in `scripts/release/publish.mjs` then replaces the tree of `gh-pages` with it, writes the channel files `channel/latest` and `channel/beta` that the installers and update checks read, commits and pushes. The first release finds no `gh-pages` and starts the branch; set Pages to serve that branch with the custom domain `pancode.dev`. A pre-release moves only `channel/beta` and leaves the site as it is.

A website-only change between releases uses `bash site/publish-pages.sh` from a clean, committed tree. It runs `deployment-check.mjs` and `sync-docs.py --check`, builds with the current `HEAD` as the revision, runs `check.py`, and commits the output to the local `gh-pages` branch on top of the remote tip, stopping if the two have diverged. It never pushes. Review the commit and push the branch when authorized. Run it from `main`, so the published revision is a commit readers can find. It publishes the documentation pin committed in `content/docs-manifest.json`, which can be older than the one a release deployed, because the release re-pin stays in its isolated checkout.

## Analytics

`analytics.ga4` in `product.json` holds the site's Google Analytics 4 measurement id. When it is empty, the build emits no tag, no consent banner and no `js/analytics.js`, and the page policy names no remote script or connection origin; `/privacy.html` then says analytics is off. When it holds an id (`G-...`), every page loads `js/analytics.js` with the id, carries a hidden consent banner, and its Content-Security-Policy adds `https://www.googletagmanager.com` to `script-src`, `https://*.google-analytics.com https://*.analytics.google.com https://www.googletagmanager.com` to `connect-src`, and `https://*.google-analytics.com https://*.googletagmanager.com` to `img-src`.

`js/analytics.js` sets Google Consent Mode v2 defaults to denied for `analytics_storage`, `ad_storage`, `ad_user_data` and `ad_personalization`, applies a stored choice (`localStorage` key `pancode-analytics-consent`), turns Google signals and ad personalization off, then loads `gtag.js` asynchronously after the page's `load` event. Until the visitor accepts, Google Analytics sets no cookies and receives cookieless pings. Accept grants `analytics_storage` only; Decline, on the banner or the privacy page, sets it back to denied and expires the `_ga` cookies. Besides page views it sends `outbound_click` (links to GitHub or npm), `copy_install` (copying a PanCode install command) and `theme_toggle`. `check.py` holds every page to the policy and tag that match the configured id, `policy.mjs` refuses any remote script origin other than `www.googletagmanager.com` in `js/analytics.js`, and the browser check fails a page that requests any other remote origin. The live preview's header policy does not allow Google, so a local preview never reports. Search Console is verified by a DNS TXT record and reads `/sitemap.xml`; it needs no site change.

`linkRef` in `product.json` is normally unset. When set, it points reader-facing source links at a public ref while the pinned commit is unpublished. The manifest still records the real pin.

The hosted installers are the release's own: the build copies `scripts/install.sh`, `scripts/install.ps1` and `scripts/install.cmd` into the output unmodified, and `check.py` fails the build when they differ. Because the site deploys with a stable release, `https://pancode.dev/install.sh` is the newest stable release's installer. Each GitHub release also attaches `install.sh`, `install.ps1` and `install.cmd`, and the attached scripts are the documented fallback when the site is unreachable. `install.cmd` fetches the latest release's `install.ps1`.

GitHub Pages cannot send response headers or HTTP redirects. The Content-Security-Policy and referrer policy ride in `<meta>` tags, and each entry in `redirects.json` becomes a small page with a meta refresh, a canonical link and a script redirect. `frame-ancestors` and `X-Frame-Options` are not available. `CNAME` and `.nojekyll` are written by the build, and `/version.json` records the site version, the documentation commit and the deployed revision.

Preview the exact deployment build locally with `node site/build.mjs --out <directory>` and `python3 site/check.py <directory>`.
