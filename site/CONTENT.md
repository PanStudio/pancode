# Product articles and the personal channel

The product site helps a developer or curious newcomer understand fit, install
PanCode, connect a suitable model, and complete a useful first task. Lead with
what the user can do. A research institution is not a product benefit.

Anthony's personal site, akougkas.io, holds personal essays: the insight and
judgment behind the work, in the first person. They are not another copy of the
product guide, and they do not belong on this site. Link related articles in
context; give distinct pages distinct titles, descriptions, and canonical URLs.

## Article shape

Answer one concrete question in the opening. Describe the supported workflow,
relevant configuration, observable result, important limits, and a next action.
Usually 600–1200 words; keep paragraphs within DESIGN.md's 65-word limit.
Reference public user guides and release records. Distinguish documented behavior
from an independently executed demonstration. State the version scope when
commands or formats may change. Do not invent screenshots, benchmarks, costs,
adoption numbers, or testimonials.

Use existing Overview, Docs, Tutorials, and Research navigation. The install
section and first-session tutorial are useful next actions. More articles are
justified by more answered user questions, not keyword permutations.

## Shipped work and research

Docs and Tutorials hold what shipped, opt-in and beta features included. If a
reader can turn it on at the stated version and it does what the page says, it
belongs there, and the page states what turns it on and its limits.

Research is the builder's door. It holds
five subsystem pages, registered first in `content/research.json` in this
order: Drivers, Memory, Scheduling, Protection, Accounting. The overview's
chapters name the same five in task words (Route, Remember, Delegate,
Contain, Verify); the subsystem names belong to Research. A subsystem page
opens with the design and a source map: each mechanism, the `src/` files that
hold it, whether it is on by default, and the setting that turns it off. Name
only mechanisms confirmed in source, state the tree or release they were read
from, and list the limits the source shows. Open-question pages follow the
subsystem pages, and each one's `category` names the subsystem it belongs to.

Pages live in `content/research/` and `content/research.json` has the same
shape as `content/tutorials.json`. Every research page is an invitation to
contributors and outside researchers, and has these parts:

- The question, stated so that an answer could be wrong.
- What is known and measured so far, with sample sizes and the build measured.
  Say when a sample is small, when a result came from a design that no longer
  exists, and when nothing has been measured.
- Why the answer matters.
- How to use PanCode on it today, with commands that exist at the stated
  version.
- A first experiment, labelled "proposed, not yet run" until someone has run it
  and recorded the result.
- How to join: GitHub issues and `CONTRIBUTING.md`.

Name no lab, advisor, or funding. Publish numbers on the page and no data files.
No private paths, hostnames, or agent logs. A research page may run longer than a
tutorial. When a question is settled and the result ships, the how-to moves to
Docs or Tutorials and the Research page says what was found. Personal essays stay
on akougkas.io.

## First guide batch

The owner approved these six guides on September 27, 2026. They are published
from `content/tutorials/` and registered in `content/tutorials.json`.

- Choose a model for your project.
- Coordinate the coding agents you already use.
- Keep a long coding task on track.
- Check a change against your repository.
- Add skills and plugins deliberately.
- Work from a laptop with remote workers.

New manuscripts and their review metadata go in `content/drafts/`. They are not
registered in `content/tutorials.json` and do not enter the normal public output. After
review, move approved Markdown to `content/tutorials/`, supply actual image
metadata and reading-time estimates, register it, and run the existing site
checks. Do not claim a tutorial was tested until its recorded workflow ran.

Learning paths live in `content/paths.json`. Each path serves one kind of reader
and orders three to five published tutorials as its steps; the build stops if a
path has fewer or more steps, or names a tutorial that is not published. The
learn page renders the paths, and every step page gets a path strip with its
place in the path and Previous and Next links. A step's next list should lead
to its path successor.

## Creator and dates

Anthony Kougkas creates and maintains PanCode, and the site credits him as the
author of its articles. Do not narrate earlier prototypes or projects as
PanCode history. Credit upstream projects and contributors. Do not manufacture
dates.

New writing uses its actual publication date. Historical release notes and
milestones use verified event dates. A newly authored guide about an old feature
is still newly authored. The builder takes article and guide dates from Git:
`datePublished` is the commit that first added the page's source at its public
path, and `dateModified` and the visible "Updated" date are the last commit that
changed it. Do not imply a historical publishing record that Git does not
establish.

## Comparisons and adoption

Explain model choice, execution location, licensing, connector capabilities,
permissions, context controls, and inspection of results. Name modes and versions.
Opinion about separating model development from harness design belongs in a
clearly argued essay. Claims about better outcomes require repeatable tasks,
environments, checks, and a documented cost basis. Do not caricature other tools.

The desired outcome is a useful installed workflow. Search ranking and adoption
are hypotheses until measured. Aggregate npm downloads are a noisy proxy, not
unique installations. The published site loads Cloudflare Web Analytics' beacon,
which counts page views without cookies, and no other tracker. Do not add a
tracker or an unsupported adoption claim.

## Family pages

PanStore, PanKit and PanSDK each have one product page, written in
`content/family/<id>.md` and registered in `family.json`. A page answers what
the tool is (one paragraph), how to get it, one short example taken from its
package README, and what it does not do, in a `limits` block that links the
guide's limits. It links the full guide, the npm page and the source. PanKit's
page lists its servers.

All three ship in the one `pancode` package: installing PanCode installs the
`panstore` and `pankit` commands and the `pancode/sdk/*` exports. Never print a
scoped `@pancode/` package name, and never claim signing that the release does
not perform. The page header shows the package version the build reads, the
command or import, and the licence, from `family.json`; do not repeat them as
prose.

PanHub's page is the catalog, generated from the bundled index and labelled as
the packs bundled with this release. A listing is not an endorsement; the page
says what each tier means. PanCode's page is the overview.

## Guide composition

Tutorials and draft guides render through `tutorial.html` as field guides. The
heading states the answer (the catalog `description`), the version it was
written for, the interfaces it uses, and its basis: "Recorded session" only
when the workflow ran as described; otherwise "Documented workflow". The basis
names no version; each figure carries its own. The cover
is a capture id from `content/captures.json`, chosen for the task, never a
generic screen reused across guides.

Each tutorial and research entry lists `guides`: the one to three
`public-docs.json` paths it puts into practice. Every docs page ends with a
Related list built from these entries, so a guide links to its worked
examples. Name a guide only when the article uses that feature; the build fails
on a path that is not published.

Markdown stays the source. A line `::: name arguments` opens a guide block and
`:::` closes it; the body is Markdown.

| Block | Use it for |
| --- | --- |
| `::: note Label` | Version scope or what a result establishes |
| `::: needs` | The "Before you start" checklist |
| `::: steps` | An ordered procedure; each `###` heading is one numbered step |
| `::: prompt Label` | A request to type into PanCode, with a copy control |
| `::: result Label` | What the reader should see, and what it does not prove |
| `::: limits Label` | Boundaries of the workflow |
| `::: compare` | A table whose first column names the rows |
| `::: capture id [id ...]` | One capture, or a sequence of states with a caption line |
| `::: diagram id` | An HTML diagram from `content/guide-diagrams.json` |
| `::: next` | A short list of links; arrows are added |

A code fence can name its file: ` ```yaml title=.pancode/quality.yaml `.
Keep paragraphs within the 65-word limit; `policy.mjs` checks drafts too.

## Captures

`content/captures.json` registers every product capture used by a guide: the
WebP image, its PNG original, dimensions, a short tab label, specific alt text,
a one-sentence caption, the interface, the version, the capture date, and how
it was made. Capture the released package, not a development build, in an
isolated profile with no private endpoints, conversations, or host names; the
only credential in it is the GitHub Copilot login the `copilot` target uses.
Caption what the screen shows, including unwelcome results. Add new
WebP images to `image-variants.py` and regenerate derivatives. A capture used
as a guide cover also needs a social preview: run
`python3 site/image-variants.py --social`.

A terminal capture can carry its recording: `cast` (an asciicast v2 file in
`assets/casts/`), `transcript` (the plain-text screens beside it), `cols`,
`rows`, `duration` in seconds, and `posterAt`, the time the still shows. The
page keeps the still, a download link and the transcript; a Play button loads
the vendored asciinema player on request, and only pages with a recording allow
`'wasm-unsafe-eval'` in their policy. `node site/capture/run.mjs --scratch
<directory> --pancode <build> --components <dir> [--only <ids>] [--publish]`
reruns the recordings in `capture/scenarios.json` in a fresh sandboxed profile,
renders their stills with the same player, and refuses to publish any that
name a host, a user, a private address or a key. Live scenarios run on
GitHub Copilot through the `copilot-sdk` runtime: the harness copies the
operator's Copilot login into the profile and binds `--components`, the
components directory of a scratch home where `pancode tools install
copilot-sdk` ran, read-only. `node site/capture/run.mjs --scratch <directory>
--release <version> --components <dir> [--publish]` re-records every scenario
from that npm release and writes wall times to `<directory>/timings.json`. `node
site/capture/quote-check.mjs [--scratch <directory>]` checks that each `text`
fence a tutorial attributes to a recording (the line before it says recording
or recorded) still appears in that recording's transcript; the release run
ends with it. `python3 site/capture/cast-symbols.py` rebuilds the symbol
font the player falls back to for glyphs IBM Plex Mono lacks.

## Review builds

`node site/build.mjs --review --out <directory>` adds the manuscripts in
`content/drafts/` to a scratch build; it refuses the public output. For a live
review preview beside the normal one, run
`node site/dev.mjs --snapshot --review --dir .preview-review --port 4191`, and
check it with `node site/browser-check.mjs --review --url http://127.0.0.1:4191`.

