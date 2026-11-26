# PanCode design language

This is the design authority for every PanCode surface: the public site, PanCode on the desktop, PanCode in the terminal, icons, social cards and the banner. `design-system.json` holds the values; this file says how to use them. The second half covers the public site: a window into a source-available coding tool that helps a reader understand PanCode, install it, and learn to use it. It is not a hosted agent platform, a company brochure, or a development report.

## Identity

PanCode is systems software for coding agents. The look is a terminal at night: true black, one brand green, one azure secondary, warm ivory ink, heavy grotesk headings and a mono face for everything a machine would say. It is modern and technical. It is never retro: no scanlines, no CRT curvature, no matrix rain, no glitch effects, no all-caps mono paragraphs. It is never generic either: no multi-colour gradients, no glass panels, no purple-to-blue hero washes.

Use **PanCode** as the product name in prose, headings and metadata. `pancode` is the command, package, binary and paths, always in the mono face. Do not use gendered pronouns or write about the product as a person. The interfaces are **PanCode in the terminal** and **PanCode on the desktop**. **Panos** is PanCode’s orchestrator agent, the one you talk to: write Panos where a sentence names who answers, plans or dispatches, and PanCode for the product, its settings and what the system did. Workers are never Panos. Panos takes “it”, and commands, files and settings keep the `pancode` name. The desktop interface opens locally in the user's browser and is in alpha; do not imply a native desktop binary or complete feature parity.

### Mark

The mark is the P of the wordmark: the Schibsted Grotesk 700 P in the brand green, 10 units tall on a 16 unit grid with its stem on whole units, on a black tile with a 3 unit corner radius. `assets/brand/pancode-mark.svg` is the source. It holds geometry only; every colour is a `var(--palette-<name>, #hex)` reference that `site/render-brand.mjs` rewrites from the palette before rendering, so a palette change reaches every raster in one run.

- The P is `green400` and the tile is `black`. Never recolour, outline, rotate, skew or add effects to the artwork.
- Minimum size is 16 px, where one grid unit is one pixel. Render at whole multiples of 16 where possible so the stem stays crisp.
- Clear space is 3 grid units on every side, which the tile already provides. On black the tile disappears and the glyph floats; on any other ground the tile is the container.
- Single-colour contexts (`assets/acp-registry/icon.svg`) draw the P alone in the current colour. In the terminal the mark is three cells, `▐P▌`: the P in the on-accent ink on a brand green tile, and `[P]` in ASCII mode.
- There is one mark. Do not draw distinct logos, mascots or badges for PanCode applications or interfaces.

### Wordmark

`assets/brand/pancode-wordmark.svg` (dark grounds) and `pancode-wordmark-light.svg` (light grounds) set the name as outlines. The name is PanCode in Schibsted Grotesk 700 with -0.04em tracking, one word, capital P and C. Pan takes the brand green and Code the secondary azure: `green400` and `azure400` on dark grounds, `green700` and `azure600` on light. The name stands without the mark beside it. In HTML the wordmark is live text in the display face, with the two halves in `--accent` and `--secondary`.

In the terminal the wordmark is the block lettering in `src/interactive/welcome-art.ts`, PAN over CODE. In truecolor one ramp runs from the brand green at the top of PAN to the secondary azure at the foot of CODE, mixed in RGB so the bridge is a clean teal; the one-band form runs the same ramp left to right. At 256 and 16 colours PAN is the brand green and CODE the secondary azure, as two flat tones. This green-to-azure ramp is the only gradient in the identity.

PanCode is one platform. PanStore (the store behind `pancode store`), PanHub (PanCode's marketplace) and PanKit (PanCode's agent toolkit, shareable with other agents over MCP) are parts of it, never products beside it; none gets its own logo or page beyond the PanHub catalog. In HTML their names are one word each, `Pan` in `.brand-pan` (`--accent`) and the rest in `.brand-code` (`--secondary`). Never write PanOS or PanSDK (the extension API is unstable and has no product name), never call PanHub a library, and never describe the parts as a family.

## Colour

`design-system.json` is the sole sanctioned colour source. `palette` lists every hex, `ramps` says what each ramp is for, and `themes` maps semantic roles to palette names for dark and light. `tokens.mjs` generates `css/brand.css`; the build rejects drift. New sanctioned colours require an explicit request and a documented reason here.

- **Ground.** The dark page is true black, `#000000`, for AMOLED screens. Surfaces above it step through the `void` ramp, a near-neutral with a trace of green: `void1` raised, `void2` sunk and hover, `void3` overlay, `void4` hairline, `void5` strong line, `void6` control border.
- **Brand green.** The brand ramp is a teal-green at OKLCH hue 170. `green400` `#07e4b4` is the focal green on black and the colour of Pan in the wordmark, the mark and the terminal rails. It marks the brand, links, the primary action, the focus ring, selection and the terminal prompt. It is never a state: green does not mean success here.
- **Azure secondary.** `azure400` `#4aa8ff` is the colour of Code in the wordmark. It is spent sparingly: section numbers and small mono labels, version tags, one highlight per view. It is never a fill behind running text and never an error or a warning.
- **States.** Success is `leaf`, warning is `amber`, error is `red`, info takes the `azure` ramp. Each has a foreground and a wash per theme. Leaf is a true green at OKLCH hue 144, 26 degrees from the brand teal, so success never reads as the brand. Every state also carries a glyph or a word; colour alone never carries meaning.
- **Text.** Dark uses the `ink` ramp, light uses `pine`. Primary text is not pure white: `ink1` is a warm ivory that avoids halation on black. `faint` is for decoration and disabled labels only, on the ground and the first raised surface.
- **Light theme.** A warm off-white paper (`mist1`) with white raised surfaces. The focal green cannot carry text on a light ground, so links and focus use `green700` and the secondary uses `azure600`, and filled controls invert: a black fill with brand green text. Black slabs with green type are what keep the light theme PanCode.
- **Code and terminal surfaces** stay dark in both themes and take the `--code-*` and `--syntax-*` tokens. Product captures keep their own surface and are never recoloured.
- **Data series** use `--viz-1` to `--viz-8` in order. A chart with one series uses the brand green; a second series uses azure.

Semantic roles for component CSS: `--paper`, `--paper-raised`, `--paper-sunk`, `--paper-overlay`, `--ink`, `--ink-soft`, `--muted`, `--faint`, `--line`, `--line-strong`, `--line-control`, `--accent`, `--accent-hover`, `--accent-pressed`, `--accent-soft`, `--on-accent`, `--fill`, `--fill-hover`, `--on-fill`, `--secondary`, `--secondary-soft`, `--success`, `--warning`, `--error`, `--info` (each with a `-soft` wash), `--focus`, `--selection`, `--on-selection`. `--accent` is for text, rules and icons; `--fill` and `--on-fill` are for filled controls, because the two differ on light. Literal colours, inline styles, new colour names and alternative palettes are rejected by `policy.mjs`.

The sanctioned `defaultTheme` is `dark`. It also accepts `light` or `system`; only `system` follows the operating-system preference. A saved visitor choice takes priority and persists across pages. An explicit `?theme=dark` or `?theme=light` URL overrides the display for that visit without overwriting the saved choice. The generated CSS applies the same default without JavaScript.

Contrast is checked, not assumed. Body and muted text meet 4.5:1 on every surface they sit on, large text and control borders meet 3:1, in both themes.

## Type

Three self-hosted faces, each with one job. Their files and licenses are listed in `design-system.json` under `type`, and the build, the brand kit and the token generator all read that list.

- **Schibsted Grotesk** is the display face: headings and the wordmark, weight 700, tracking -0.04em at display size and -0.035em at headline size, line height 1.0 to 1.06. Headings never slant. Emphasis inside a heading is a colour: the brand green in an `h1`, the soft ink in an `h2`.
- **Instrument Sans** is the text face: body, navigation, controls and titles, weights 400, 500 and 600. Italic is for citation and genuine emphasis in running text.
- **IBM Plex Mono** is the machine face: commands, code, paths, labels, section numbers and data, weights 400 and 500. Labels are uppercase at 0.72rem with 0.1em tracking. Never set a paragraph in mono.

The scale is in `type.scale`: display, headline, title, lede, body, small, caption, label and code, generated as `--type-*` font shorthands with matching `--tracking-*`. Component CSS takes sizes from these or from existing element and class styles. Body measure is 65 characters.

## Shape

- **Space** is a 4 px base: `--space-1` to `--space-9` (4, 8, 12, 16, 24, 32, 48, 64, 96 px).
- **Radius.** `--radius-xs` 4 px for inline code and tags, `--radius-sm` 6 px for buttons and inputs, `--radius` 10 px for panels, code blocks, cards, captures and menus, `--radius-lg` 16 px for hero media and dialogs, `--radius-pill` for status chips and switches only. Circles are for dots and round icon controls. A nested element takes the outer radius minus the gap, or none.
- **Borders.** Hairlines (`--line`) separate. Control borders (`--line-control`) mark things that take input. An accent border marks the one selected or primary thing. The focus ring is 2 px of `--focus` at a 2 px offset, so the ground shows between control and ring.
- **Elevation.** Shadows do not read on true black. On dark, height is a lighter surface step plus a hairline: level 1 is `--paper-raised` with a `--line` border, level 2 (menus, popovers, sticky bars) is `--paper-sunk` with `--line-strong`, level 3 (dialogs) is `--paper-overlay` with `--line-strong`. `--elevation-2` and `--elevation-3` add a shadow only so an overlay darkens what it covers. On light, height is white on mist plus a soft shadow.
- **Glow** is the neon, and it is rationed. `--glow-brand`, `--glow-brand-soft`, `--glow-accent`, `--glow-text` and `--glow-halo` exist for four uses only: the mark or wordmark where it is the subject of the view (site hero, terminal welcome, app splash); the one primary action under hover or keyboard focus; one hero media frame per page; a live indicator such as a running cursor or an active worker dot. Never on body text, running headings or links; never on panels, cards, tables, inputs or code blocks at rest; never on a state colour; never more than one glowing element in view. In the light theme every glow token resolves to `none`.

Favor rules and open layouts over nested panels and grids of interchangeable cards.

## Motion

`design-system.json.motion` supplies shared timings, easing, reveal distance and feedback duration. Use the generated `--motion-*` variables; the build rejects literal durations and custom easing in component CSS. Hover and focus feedback uses 140ms, theme and disclosure changes use 220ms, and one-time entrances use 560ms. Motion confirms an action or reveals content once. Nothing pulses, loops or tracks the pointer, except a cursor blink or a live dot that reports real activity, and both stop under reduced motion.

## Terminal

PanCode in the terminal takes the same roles through `src/interactive/theme/tokens.ts`, the only place a terminal colour may be written. Truecolor uses the palette hex. `design-system.json.terminal` gives the nearest 256-colour indexes and the 16-colour names for each role in both themes. At 16 colours the brand teal is cyan and success is green, so the two stay apart with no ramp to lean on. A light terminal takes the light theme's roles: `green700` for the brand, `azure600` for the secondary. Glyphs carry state alongside colour at every depth.

## Voice

Write for someone using the product, not for the person building it.

- Say what the reader can do, with the command that does it.
- Short declarative sentences, present tense, second person. No exclamation marks.
- Name real things: the file, the flag, the model, the limit.
- State limits and alpha status where the reader chooses the feature.
- Interface labels are verbs or nouns in sentence case. An error says what happened and what to do next.
- Never use a dash to interrupt a sentence with a clause. Write a second sentence.

Do not use superlatives, fabricated outcomes, corporate sales language, rhetorical contrasts, repetitive slogans, unexplained runtime jargon, or development status narration. Avoid wording such as “revolutionary,” “seamlessly,” “unlock the power,” and “single pane of glass.” Do not expose agent deliberations, coding-session transcripts, implementation audits, check inventories, or repository paths as promotional prose. Document user commands and behavior accurately. Claims must be supported by the repository; identify experimental or alpha features where the user chooses them. Marketing paragraphs have a hard limit of 65 words. Technical reference pages may be longer when the information is necessary for a task.

## Public information structure

Primary navigation has five entries: Overview, Docs, Tutorials, Research, PanHub. PanHub is the catalog at `/hub.html`; PanStore and PanKit are documented in their guides, and their 0.9.0 pages redirect there. Installation is on the overview. Capabilities, models, project attribution, and interface selection also belong there. Docs and Tutorials hold what shipped, opt-in features included. Research holds the five subsystem pages (Drivers, Memory, Scheduling, Protection, Accounting), each with its design, source map, and first experiment, followed by open questions, evidence so far, and how to join; the project owner set this boundary. Existing page URLs redirect to the appropriate section or guide. Avoid another top-level page when a section, tutorial, or research page answers the need.

`public-docs.json` is an explicit allowlist of user-facing repository guides with short labels and five task-oriented groups: Start, Everyday use, Store, hub and toolkit, Extend PanCode, Reference. Each entry may select an authored, task-oriented summary from `content/doc-summaries/`. These summaries explain the essentials for visitors; the full upstream guide remains pinned and hashed in the documentation manifest and linked from the page. The sync script generates checked Markdown from the summary or selected upstream sections; the build renders it as HTML, rewrites links, and generates search and navigation. Public docs do not include the architecture corpus, development audits, agent scratch notes, or internal work journals. Do not add those directories to the allowlist. A link to source code is sufficient for developer detail.

Tutorials are real Markdown articles declared in `content/tutorials.json`. Research pages are declared the same way in `content/research.json`, with their Markdown in `content/research/`; each one names the version it describes and labels any experiment nobody has run yet. Publish useful workflows, actual screenshots, and recorded demonstrations. No empty video frames, invented testimonials, fabricated product screens, engagement counters, or promises of unpublished media. Media needs a useful title, description, accessible alternative, and attribution. An optional YouTube recording uses a real 11-character ID and the privacy-enhanced embed origin. Maintain captions in the recording itself.

## Copyright

The public site footer reads **Copyright 2026 Anthony Kougkas**. Keep the repository LICENSE and NOTICE linked; do not rewrite their legal contents as part of site copy work. The project is licensed under the **PanCode License 1.0**; call it source-available where a category word is needed. Link the license and notice; retain the bundled font licenses. The project section uses the small label “Who builds it” and the heading “Built by one maintainer.” Keep the legal copyright separate from the product story. PanCode is a standalone project with no parent organization. The project section credits its author and links the source and tutorials; no organization mark, ecosystem link, or institutional credit appears anywhere on the site. Do not write research-roots or institutional-pedigree sentences in the product copy. Do not add affiliations, sponsors, funders, grant numbers, copyright owners, or legal claims. Do not replace upstream notices or claim ownership of third-party tools or artwork.

## Site components

One vocabulary across every page. Each item names its tokens; a page never restyles one.

- **Header.** Sticky, the ground at 86% opacity over a 16 px blur, a hairline below. The lockup is the mark at 36 px beside PanCode in the display face. The current page is underlined in `--accent`.
- **Primary action** (`.btn`). `--fill` with `--on-fill` text, weight 600, `--radius-sm`. Hover and keyboard focus move to `--fill-hover` and add `--glow-brand`. One per view carries the eye; the header's small one is the same control.
- **Text link** (`.text-link`). Ink text, weight 500, with an arrow in `--accent` that moves a few pixels on hover. Links in running text are `--accent` and underlined.
- **Label** (`.eyebrow`). The mono label style in `--muted`. A section number inside it (`.chapter`) and a step number (`.step-number`) are `--secondary`.
- **Tag** (`.tag`). Mono, `--muted`, a control border, `--radius-xs`.
- **Code.** Inline code sits on `--paper-raised` with `--radius-xs`. A block sits on `--code` with a `--code-border` hairline and `--radius`; its copy control uses `--code-muted` and turns `--code-accent` on hover and success. The prompt glyph is `--syntax-prompt`.
- **Tabs.** A rule with an `--accent` underline under the selected tab.
- **Capture frame.** A product capture on its own dark surface with a `--line-control` border and `--radius`.

## Guides

A guide is a field guide in this language, not a transplanted article style. Its heading uses the page introduction: an azure chapter label for the category, the display-face title, the answer as the lede, and a ruled row of facts (written for, works in, basis). The body keeps a reading measure while captures, capture sequences, and diagrams use the full column beside a sticky "On this page" rail that marks the section being read. Steps sit on one rule with azure numbers; checklists use accent ticks; results take an accent rule, boundaries an amber warning rule and notes an azure rule; a draft or unmeasured status line is amber; comparisons name their rows in the first column. Code blocks can carry a label band that also holds the copy control.

Captures keep their dark surface in both themes and open in the media dialog. A sequence shows one state at a time behind an accessible tab list; its frames share one grid cell, so switching never moves the page, and each frame keeps its caption, version tag, and full-size link. Without JavaScript every frame is visible in order. Guide diagrams are exact HTML labels on one rule: each stage names its place and what it does, and azure transitions name what moves between stages. Their rules draw once, in order, when the diagram first enters the view.

Guide CSS uses only the semantic colors, the space scale, the radius, and the motion tokens. Font sizes come from existing element and class styles (`eyebrow`, `caption`, `lede`, `step-number`, `tag`, headings), so guides add no type scale.

## Accessibility and implementation

Use semantic HTML, a single main heading, a visible keyboard focus, a skip link, labeled controls, accurate alt text, and readable line lengths. Body and muted text and text links must meet WCAG AA contrast. Interactive boundaries meet 3:1. Layout must work at 320px and 200% zoom. Menus close with Escape and return focus. Motion respects `prefers-reduced-motion`. Core content and navigation work without JavaScript.

The site is static HTML and CSS with small progressive enhancements. Use CSS layers, fluid type, grid, logical properties, and semantic themes. JavaScript adds theme choice, copying, article search, and local live reload. The published site loads Cloudflare Web Analytics' beacon and no other tracker; its Content-Security-Policy allows that beacon's script and reporting origins and nothing else remote except the YouTube embed. No remote font requests, autoplay, or dependency-heavy client framework is required. Build and browser checks are part of delivery. Keep verification artifacts in ignored local scratch, never in the published output.

## Overview page and media

The overview is typographic first. Its hero sets the headline in the display face with the second line in the brand green, the five premises with azure mono labels, one install command on a code surface, and the mark at the right over a cell grid that fades into the ground under `--glow-halo`. This is the one place on the site where the mark glows. Each chapter carries a small still mark in its margin column, which sticks beside the chapter body on wide screens and sits above it on narrow ones.

Generated media may replace a still mark in the hero, a chapter margin or the closing section. It must use the sanctioned palette on a true-black ground, contain no rendered text, logos or other brands, and ship as a silent, compressed derivative with a poster and intrinsic dimensions. A film plays once, never loops unattended, loads only when visible, pauses offscreen and in hidden tabs, and is replaced by its poster under reduced motion and on data-saving connections. No rectangular backdrop: the film's black sits on the page's black. The artwork of the retired identity must not appear anywhere.

Hover and keyboard focus receive equivalent feedback. Directional link arrows move only a few pixels. Copy controls give a brief success or failure state, restore their label after repeated use, and announce the outcome. Code controls stay outside the scrolling code surface. Mobile controls have at least a 44px touch area; code examples reserve space for their copy control. Native disclosures retain a useful immediate fallback when smooth size interpolation is unsupported.

Product captures open in a native modal dialog with fit and actual-size views, previous and next controls, Escape dismissal, and focus return. Load the full WebP only on demand; preserve the original PNG link and modified-click behavior. The image can scroll at actual size. No-JavaScript readers retain the direct image links.

Only below-fold sections receive a one-time reveal. Focus reveals content immediately. An operating-system change to reduced motion completes pending reveals and disables animation. Content remains accessible without JavaScript or IntersectionObserver. Documentation search supports arrow keys and Escape, and both contents lists reflect the currently read section.

## Responsive assets, performance, and search

Generate image derivatives from the actual captures and sanctioned marks with `python3 site/image-variants.py`. The builder checks source and derivative hashes before publishing them. Use intrinsic dimensions, `srcset`, and accurate `sizes` to limit downloads and prevent layout shifts. The hero has high fetch priority; below-fold product captures load lazily. Fonts stay local, the text and display faces are preloaded, and only the faces and licenses listed in `design-system.json` enter the public build. Never load a full-resolution image viewer capture before it is requested.

Documentation navigation is closed in server-rendered HTML and opened in its desktop column by progressive enhancement. Avoid initially opening a mobile sidebar and closing it after paint. Page and tutorial metadata, canonical URLs, sitemap entries, social previews, article data, and breadcrumbs are generated from the same records. Keep the recorded npm version accurate, and link the version badge to the actual pinned source until its package release exists. Do not invent publish dates, reviews, ratings, prices, or unsupported rich-result claims. The one offer in the structured data is the free one: PanCode costs nothing to install. Social previews show the product: each guide uses its cover capture, other pages use the desktop task capture. Sitemap dates, article publish and update dates, and the visible Updated date come from git history, never from the build clock. `robots.txt` and the llms files stay open to search and AI crawlers so the product is described from its own pages.

Run the browser check for layout, keyboard, touch, both themes, and reduced motion, and run the performance check against a quiet local preview. Its cold-cache mobile lab budgets are FCP below 2.5s, LCP below 3s, and CLS below 0.1 under 2Mbps, 100ms latency, and 4x CPU slowdown. These are local regression checks; field Core Web Vitals require observation after production deployment.

## Regenerating and adopting the identity

After a palette or artwork change: `node site/tokens.mjs`, `node site/render-brand.mjs`, `python3 site/image-variants.py`, `node site/render-cards.mjs`, then `python3 scripts/media-assets.py --sync`. `site/assets/brand/provenance.json` records the rendered mark's hash and dimensions.

Other PanCode surfaces adopt the mark, the tokens, the fonts and their licenses through `node site/export-brand.mjs --out <directory>`, which exports no site layout CSS. The desktop app projects that kit with its own sync scripts.
