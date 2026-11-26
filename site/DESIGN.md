# PanCode design language

This is the design authority for every PanCode surface: the public site, PanCode on the desktop, PanCode in the terminal, icons, social cards and the banner. `design-system.json` holds the values; this file says how to use them. The second half covers the public site: a window into a source-available coding tool that helps a reader understand PanCode, install it, and learn to use it. It is not a hosted agent platform, a company brochure, or a development report.

## Identity

PanCode is systems software for coding agents. The look is a terminal at night: true black, one brand green, one azure secondary, warm ivory ink, heavy grotesk headings and a mono face for everything a machine would say. It is modern and technical. It is never retro: no scanlines, no CRT curvature, no matrix rain, no glitch effects, no all-caps mono paragraphs. It is never generic either: no multi-colour gradients, no glass panels, no purple-to-blue hero washes.

Use **PanCode** as the product name in prose, headings and metadata. `pancode` is the command, package, binary and paths, always in the mono face. Do not use gendered pronouns or write about the product as a person. The interfaces are **PanCode in the terminal** and **PanCode on the desktop**. **Panos** is PanCode’s orchestrator agent, the one you talk to: write Panos where a sentence names who answers, plans or dispatches, and PanCode for the product, its settings and what the system did. Workers are never Panos. Panos takes “it”, and commands, files and settings keep the `pancode` name. The desktop interface opens locally in the user's browser and is in alpha; do not imply a native desktop binary or complete feature parity.

### Mark

The mark is a stone of four facets, and the channel between them is the for-all sign, ∀. PAN means all, so the sign says the name: one harness for all models and all agents. PanCode works in the gaps between the tools a developer already has, and the mark draws those gaps. `assets/brand/pancode-mark.svg` is the source, on a 64 unit grid: a 56 unit rounded square with 14 unit corners, cut by a channel 5 units wide whose two arms leave through the upper corners and whose bar sits 25 units from the top. It holds geometry only; every colour is a `var(--palette-<name>, #hex)` reference that `site/render-brand.mjs` rewrites from the palette before rendering, so a palette change reaches every raster in one run.

- The left facet runs `green300` to `green500`, the top `green400` to `teal400`, the right `teal400` to `azure400`, and the point `orange400` to `amber300`. Green leads, the azure of the name closes the right side, and the point is the one warm note. Never recolour, outline, rotate, skew or add effects to the artwork.
- `pancode-mark-small.svg` is the cut for 16 to 24 px: flat `green400`, `green400`, `teal400` and `orange400`, with the channel widened to 7.2 units. The favicon and the 16 px icon use it. Minimum size is 16 px.
- `pancode-mark-light.svg` is the cut for light grounds, in the 600 to 800 steps of the same ramps.
- Fill follows size: below 32 px the mark is flat (the small cut to 24 px, the full cut in flat colour from 25 to 31 px, as in the 28 px header lockup), and from 32 px it is graded. An inline drawing that carries gradients prefixes their ids with its file name and is named once per page; `site/art/mark.svg` carries none.
- The stone is its own container and has no tile. On black and on paper it stands directly on the ground. App icons set it at 80% on a black ground. Clear space is a quarter of the mark's width on every side.
- Single-colour contexts (`assets/acp-registry/icon.svg`) draw the four facets of the small cut in the current colour.
- In the terminal the mark is three cells, `▐∀▌`: the sign in the on-accent ink on a brand green tile, and `[V]` in ASCII mode. Where one cell is all there is, it is `∀` (U+2200) in the brand green.
- There is one mark. Do not draw distinct logos, mascots or badges for PanCode applications or interfaces.

### Wordmark

`assets/brand/pancode-wordmark.svg` (dark grounds) and `pancode-wordmark-light.svg` (light grounds) set the name as outlines. The name is PanCode in Schibsted Grotesk 700 with -0.04em tracking, one word, capital P and C. Pan takes the brand green and Code the secondary azure: `green400` and `azure400` on dark grounds, `green700` and `azure600` on light. The name stands with the mark to its left or alone. In HTML the wordmark is live text in the display face, with the two halves in `--accent` and `--secondary`.

`pancode-display.svg` and `pancode-display-light.svg` set the display name: PANCODE in capitals with the for-all sign at cap height in place of the A, P and N in the brand green, CODE in the azure, and the bar of the sign running `orange400` to `amber300`. It is for display sizes only: the banner, social cards, the 404 page and the terminal welcome. It never appears in running text, navigation or controls, and never below 32 px of cap height.

In the terminal the wordmark is the block lettering in `src/interactive/welcome-art.ts`, PAN over CODE. In truecolor one ramp runs from the brand green at the top of PAN to the secondary azure at the foot of CODE, mixed in RGB so the bridge is a clean teal; the one-band form runs the same ramp left to right. At 256 and 16 colours PAN is the brand green and CODE the secondary azure, as two flat tones. The A of PAN is drawn turned over, as the for-all sign. This green-to-azure ramp and the graded facets of the mark are the only gradients in the identity.

PanCode is one platform. PanStore (the store behind `pancode store`), PanHub (PanCode's marketplace) and PanKit (PanCode's agent toolkit, shareable with other agents over MCP) are parts of it, never products beside it; none gets its own logo or page beyond the PanHub catalog. In HTML their names are one word each, `Pan` in `.brand-pan` (`--accent`) and the rest in `.brand-code` (`--secondary`). Never write PanOS or PanSDK (the extension API is unstable and has no product name), never call PanHub a library, and never describe the parts as a family.

## Colour

`design-system.json` is the sole sanctioned colour source. `palette` lists every hex, `ramps` says what each ramp is for, and `themes` maps semantic roles to palette names for dark and light. `tokens.mjs` generates `css/brand.css`; the build rejects drift. New sanctioned colours require an explicit request and a documented reason here.

- **Ground.** The dark page is true black, `#000000`, for AMOLED screens. Surfaces above it step through the `void` ramp, a near-neutral with a trace of green: `void1` raised, `void2` sunk and hover, `void3` overlay, `void4` hairline, `void5` strong line, `void6` control border.
- **Brand green.** The brand ramp is a teal-green at OKLCH hue 170. `green400` `#07e4b4` is the focal green on black and the colour of Pan in the wordmark, the mark and the terminal rails. It marks the brand, links, the primary action, the focus ring, selection and the terminal prompt. It is never a state: green does not mean success here.
- **Azure secondary.** `azure400` `#4aa8ff` is the colour of Code in the wordmark. It is spent sparingly: section numbers and small mono labels, version tags, one highlight per view. It is never a fill behind running text and never an error or a warning.
- **Mark colours.** `teal400` `#28c6da` is the midpoint of the green and the azure, and `orange400` `#ffa24d` with `amber300` is the warm point of the mark; `teal700` and `orange700` are their light-ground forms. The maintainer asked for a mark that stays in the green tones with one warm splash. These colours belong to the mark and to art built from it, never to an interface role.
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

`design-system.json.motion` supplies shared timings, easing, reveal distance and feedback duration. Use the generated `--motion-*` variables; the build rejects literal durations and custom easing in component CSS. Hover and focus feedback uses 140ms, theme and disclosure changes use 220ms, one-time entrances use 560ms, a schematic route draws in 900ms and a signal crosses a route in 2400ms. Motion confirms an action, reveals content once, or shows a flow in a schematic. A schematic may run its signals while it is in view; it draws once, pauses offscreen and in a hidden tab, and shows its finished state under reduced motion. Nothing else loops and nothing tracks the pointer, except a cursor blink or a live dot that reports real activity.

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

Primary navigation has five entries: Overview, Docs, Tutorials, Research, PanHub. PanHub is the catalog at `/hub.html`; PanStore and PanKit are documented in their guides; their 0.9.0 pages are gone. Installation is on the overview. Capabilities, models, and interface selection also belong there. Docs and Tutorials hold what shipped, opt-in features included. Research holds the five subsystem pages (Drivers, Memory, Scheduling, Protection, Accounting), each with its design, source map, and first experiment, followed by open questions, evidence so far, and how to join; the project owner set this boundary. Existing page URLs redirect to the appropriate section or guide. Avoid another top-level page when a section, tutorial, or research page answers the need.

`public-docs.json` is an explicit allowlist of user-facing repository guides with short labels and five task-oriented groups: Start, Everyday use, Store, hub and toolkit, Extend PanCode, Reference. Each entry may select an authored, task-oriented summary from `content/doc-summaries/`. These summaries explain the essentials for visitors; the full upstream guide remains pinned and hashed in the documentation manifest and linked from the page. The sync script generates checked Markdown from the summary or selected upstream sections; the build renders it as HTML, rewrites links, and generates search and navigation. Public docs do not include the architecture corpus, development audits, agent scratch notes, or internal work journals. Do not add those directories to the allowlist. A link to source code is sufficient for developer detail.

Tutorials are real Markdown articles declared in `content/tutorials.json`. Research pages are declared the same way in `content/research.json`, with their Markdown in `content/research/`; each one names the version it describes and labels any experiment nobody has run yet. Publish useful workflows, actual screenshots, and recorded demonstrations. No empty video frames, invented testimonials, fabricated product screens, engagement counters, or promises of unpublished media. Media needs a useful title, description, accessible alternative, and attribution. An optional YouTube recording uses a real 11-character ID and the privacy-enhanced embed origin. Maintain captions in the recording itself.

## Publisher and copyright

PanCode is a product of **PanStudio**. The public site footer reads **PanCode by PanStudio** above the legal line **Copyright 2026 Anthony Kougkas**. The copyright, LICENSE, NOTICE and SPDX headers do not change with site copy; keep LICENSE and NOTICE linked and do not rewrite their legal contents as part of site copy work. The project is licensed under the **PanCode License 1.0**; call it source-available where a category word is needed, and use no other category word. Link the license and notice; retain the bundled font licenses. Structured data names the organization PanStudio (`https://pancode.dev/`) as publisher, with Anthony Kougkas as its founder and the copyright holder. No "Who builds it" section and no maintainer or solo-builder framing appear on the site; the research page's signed note is signed "Anthony Kougkas, founder, PanStudio". Keep the legal copyright separate from the product story. No other organization mark, ecosystem link, or institutional credit appears anywhere on the site. Do not write research-roots or institutional-pedigree sentences in the product copy. Do not add affiliations, sponsors, funders, grant numbers, copyright owners, or legal claims. Do not replace upstream notices or claim ownership of third-party tools or artwork.

## Site components

One vocabulary across every page. Each item names its tokens; a page never restyles one.

- **Header.** One row, `--header` tall, sticky, the ground at 86% opacity over a 16 px blur, a hairline below. Left, the lockup: the mark at 28 px (`<!-- art:mark -->`), a 12 px gap, then PanCode in the display face. Centre, the primary navigation, the current page underlined in `--accent`. Right, GitHub, the theme toggle (a borderless 36 px round button with an inline sun or moon in `currentColor` and a 44 px hit area) and the small Install action; at 1000 px and below a hairline separates them from the links. At 760 px and below the row is the lockup, the toggle and a Menu listing the five links, GitHub and Install.
- **Footer.** The lockup with "One harness for your models and agents.", then four link columns under mono labels (Start, Learn, Build, Project; Learn names the learning paths from `content/paths.json`), two columns below 768 px, and the publisher and copyright lines under a hairline.
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

The overview shows the product first. Its hero sets the headline in the display face with the second line in the brand green, one sentence, one install command on a code surface, and a terminal window of real recorded output under the PAN field: routes from the mark to named models and agents. The field is the one place the hero glows. What PanCode is follows in three steps (install, connect a model or an agent, give it work) beside the desktop app, and ends on the numbered list of the five pillars. Each pillar then has its own section at one level, in order: 1 Route, 2 Verify, 3 Contain, 4 Delegate, 5 Remember, each with an outcome headline, one short paragraph, one real terminal or desktop screen, one tutorial and one research link. What it costs, Install (method tabs, a copy control on every command, the desktop line and a link to verify the download) and Questions close the page. The hero headline is “The model is a choice. The harness is what you keep.”; the positioning line, used in the footer, metadata and cards, is “One harness for the models and coding agents you already use.”

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
