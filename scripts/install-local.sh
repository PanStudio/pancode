#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PanCode-1.0
# SPDX-FileCopyrightText: 2026 Anthony Kougkas
set -Eeuo pipefail
IFS=$'\n\t'

usage() {
	cat <<'USAGE'
Usage: scripts/install-local.sh [--skip-deps] [--no-build] [--dry-run] [--force]

Install PanCode from this source checkout by placing deterministic symlinks at:
  ${PANCODE_BIN_DIR:-$HOME/.local/bin}/pancode, and beside it pankit
After linking, the script runs the installed CLI's post-install checks and
structure repair so a fresh install passes plain pancode doctor.

Options:
  --skip-deps    Skip the frozen pnpm dependency sync.
  --no-build     Do not run pnpm run build; require an existing dist/cli/index.js.
  --dry-run      Print planned actions without changing files.
  --force        Replace an existing pancode or pankit symlink even if it points outside this repo.
  -h, --help     Show this help.
USAGE
}

log() { printf '[install-local] %s\n' "$*"; }
ok() { printf '[install-local] ok: %s\n' "$*"; }
warn() { printf '[install-local] warning: %s\n' "$*" >&2; }
fail() { printf '[install-local] error: %s\n' "$*" >&2; exit 1; }

need_cmd() {
	command -v "$1" >/dev/null 2>&1 || fail "required command not found: $1"
}

# The "~/" pattern is quoted so bash does not tilde-expand it, which turned
# PANCODE_BIN_DIR="~/bin" into "$HOME/~/bin".
expand_tilde() {
	case "$1" in
		"~") printf '%s\n' "$HOME" ;;
		"~/"*) printf '%s/%s\n' "$HOME" "${1#"~/"}" ;;
		*) printf '%s\n' "$1" ;;
	esac
}

normalize_path() {
	node - "$1" <<'NODE'
const path = require("node:path");
console.log(path.resolve(process.argv[2]));
NODE
}

# Prints the path with every symlink resolved, or nothing when it cannot be
# resolved. `pancode uninstall` treats an unresolvable path as unresolved rather
# than as a match, because a dangling link is still something the operator will
# hit and still not this installation.
resolve_path() {
	node - "$1" <<'NODE'
const fs = require("node:fs");
try {
	console.log(fs.realpathSync(process.argv[2]));
} catch {
	process.exit(1);
}
NODE
}

# The `pancode` a shell will find, when that is not the launcher this install is
# about. Mirrors `otherPancodeOnPath` in src/cli/uninstall.ts: same comparison,
# same wording, so the install and the uninstall describe one PATH the same way.
# That function is TypeScript and this script runs before there is a dist to
# import, so the shape is repeated here rather than shared.
#
# Both sides are resolved before they are compared. Comparing the raw paths
# reported a second installation whenever the name resolved through a link into
# the very launcher this run had just written.
other_pancode_on_path() {
	local path_pancode="$1" local_link="$2" resolved_path_pancode resolved_local_link
	[[ -z "$path_pancode" ]] && return 1
	[[ "$path_pancode" == "$local_link" ]] && return 1
	resolved_path_pancode="$(resolve_path "$path_pancode" 2>/dev/null || true)"
	resolved_local_link="$(resolve_path "$local_link" 2>/dev/null || true)"
	if [[ -n "$resolved_path_pancode" && "$resolved_path_pancode" == "$resolved_local_link" ]]; then
		return 1
	fi
	printf '%s\n' "$path_pancode"
}

# Being on PATH is not enough: an earlier PATH entry (an old npm-global pancode,
# say) shadows the freshly linked launcher, and a bare `pancode` then answers for
# the other installation. The README promises this warning.
warn_about_shadowing_pancode() {
	local path_pancode survivor
	path_pancode="$(command -v pancode 2>/dev/null || true)"
	survivor="$(other_pancode_on_path "$path_pancode" "$link_path" || true)"
	[[ -z "$survivor" ]] && return 0
	warn "another pancode is on your PATH at $survivor"
	warn "it shadows the launcher this install links at $link_path"
	warn "check it with: $survivor --version"
	warn "remove the shadowing install or reorder PATH, then run: hash -r"
}

path_is_under_repo() {
	local candidate normalized_repo
	candidate="$(normalize_path "$1")"
	normalized_repo="$(normalize_path "$repo_root")"
	[[ "$candidate" == "$normalized_repo" || "$candidate" == "$normalized_repo"/* ]]
}

path_contains_dir() {
	local wanted entry normalized_entry
	wanted="$(normalize_path "$1")"
	IFS=':' read -r -a path_entries <<< "${PATH:-}"
	for entry in "${path_entries[@]}"; do
		[[ -z "$entry" ]] && continue
		normalized_entry="$(normalize_path "$entry")"
		[[ "$normalized_entry" == "$wanted" ]] && return 0
	done
	return 1
}

verify_node_engine() {
	node - <<'NODE'
const fs = require("node:fs");
const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
const range = String(pkg.engines?.node ?? "").trim();
const match = /^>=\s*(\d+)\.(\d+)\.(\d+)$/.exec(range);
if (!match) {
	console.error(`[install-local] error: unsupported package engines.node range: ${range || "<missing>"}`);
	process.exit(1);
}
const required = match.slice(1).map(Number);
const current = process.versions.node.split(".").map(Number);
const ok = current[0] > required[0]
	|| (current[0] === required[0] && current[1] > required[1])
	|| (current[0] === required[0] && current[1] === required[1] && current[2] >= required[2]);
if (!ok) {
	console.error(`[install-local] error: Node ${process.version} does not satisfy ${range}`);
	process.exit(1);
}
console.log(`[install-local] ok: Node ${process.version} satisfies ${range}`);
NODE
}


# The verification line names the launcher this run installed, by path. A bare
# `pancode` resolves through PATH and can answer for an older install earlier on it,
# which verifies that one instead of this one. The last two lines match
# scripts/install.sh: a returning user lands in chat on a detected route, and a
# new home starts configure by itself.
print_next_steps() {
	cat <<NEXT

Verify the install you just made:
  $link_path --version
If this shell still finds an old pancode, run \`hash -r\` (Bash) or \`rehash\` (Zsh).

Run: pancode
Desktop app: pancode gui
NEXT
}

skip_deps=0
no_build=0
dry_run=0
force=0

while [[ $# -gt 0 ]]; do
	case "$1" in
		--skip-deps) skip_deps=1 ;;
		--no-build) no_build=1 ;;
		--dry-run) dry_run=1 ;;
		--force|-f) force=1 ;;
		--help|-h) usage; exit 0 ;;
		*) fail "unknown option: $1" ;;
	esac
	shift
done

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
repo_root="$(cd "$script_dir/.." && pwd -P)"
cd "$repo_root"

need_cmd node
if [[ $skip_deps -eq 0 || $no_build -eq 0 ]]; then
	command -v pnpm >/dev/null 2>&1 || fail "pnpm is required; run corepack enable pnpm or npm install -g pnpm@10.34.5"
fi
verify_node_engine

bin_dir="$(expand_tilde "${PANCODE_BIN_DIR:-$HOME/.local/bin}")"
cli_target="$repo_root/dist/cli/index.js"
link_path="$bin_dir/pancode"

log "source root: $repo_root"
log "bin dir:     $bin_dir"
log "link path:   $link_path"
log "target:      $cli_target"

if [[ $dry_run -eq 1 ]]; then
	log "dry run: no files will be changed"
fi

# pnpm validates every workspace manifest against pnpm-lock.yaml and reuses its
# content-addressed store; a hand-rolled node_modules freshness test can miss drift.
if [[ $skip_deps -eq 1 ]]; then
	log "skipping dependency install (--skip-deps)"
else
	if [[ $dry_run -eq 1 ]]; then
		log "would run: pnpm install --frozen-lockfile"
	else
		log "running: pnpm install --frozen-lockfile"
		pnpm install --frozen-lockfile
	fi
fi

if [[ $no_build -eq 1 ]]; then
	log "skipping build (--no-build)"
else
	if [[ $dry_run -eq 1 ]]; then
		log "would run: pnpm run build"
	else
		log "running: pnpm run build"
		pnpm run build
	fi
fi

if [[ $dry_run -eq 0 ]]; then
	[[ -f "$cli_target" ]] || fail "missing built CLI: $cli_target (run pnpm run build or omit --no-build)"
	chmod +x "$cli_target"
	[[ -x "$cli_target" ]] || fail "built CLI is not executable: $cli_target"
	mkdir -p "$bin_dir"
else
	log "would verify executable: $cli_target"
	log "would create bin dir if needed: $bin_dir"
fi

# Every link is checked before any is written, so a refusal leaves the bin dir as it was.
check_link() {
	local name="$1" link="$2" target="$3" raw_target existing_target current_target
	[[ -e "$link" || -L "$link" ]] || return 0
	[[ -L "$link" ]] || fail "refusing to overwrite non-symlink at $link"
	raw_target="$(readlink "$link")"
	if [[ "$raw_target" = /* ]]; then
		existing_target="$(normalize_path "$raw_target")"
	else
		existing_target="$(normalize_path "$bin_dir/$raw_target")"
	fi
	current_target="$(normalize_path "$target")"
	if [[ "$existing_target" == "$current_target" ]]; then
		ok "existing $name symlink already points at this checkout"
	elif path_is_under_repo "$existing_target"; then
		log "existing $name symlink points inside this repo; it will be replaced"
	elif [[ $force -eq 1 ]]; then
		warn "replacing $name symlink that points outside this repo: $existing_target"
	else
		fail "refusing to replace $link; it points to $existing_target (use --force if this is intentional)"
	fi
}

# The package's other commands (pankit), from its bin map, so a source install offers what a
# tarball install does. A command whose built file is missing is named and skipped.
companions=()
while IFS=$'\t' read -r name target; do
	[[ -n "$name" ]] || continue
	if [[ $dry_run -eq 0 && ! -f "$repo_root/$target" ]]; then
		warn "missing built $name: $repo_root/$target; it is not linked"
		continue
	fi
	companions+=("$name"$'\t'"$repo_root/$target")
done < <(node -e '
	const bin = require(process.argv[1]).bin;
	if (bin && typeof bin === "object")
		for (const [name, target] of Object.entries(bin))
			if (name !== "pancode" && /^[a-z][a-z0-9-]*$/.test(name) && typeof target === "string" && !target.includes("..") && !target.startsWith("/"))
				console.log(`${name}\t${target.replace(/^\.\//, "")}`);
' "$repo_root/package.json")

check_link pancode "$link_path" "$cli_target"
for entry in ${companions[@]+"${companions[@]}"}; do
	check_link "${entry%%$'\t'*}" "$bin_dir/${entry%%$'\t'*}" "${entry#*$'\t'}"
done

if [[ $dry_run -eq 1 ]]; then
	log "would link: $link_path -> $cli_target"
	for entry in ${companions[@]+"${companions[@]}"}; do
		log "would link: $bin_dir/${entry%%$'\t'*} -> ${entry#*$'\t'}"
	done
else
	ln -sfn "$cli_target" "$link_path"
	ok "linked $link_path -> $cli_target"
	for entry in ${companions[@]+"${companions[@]}"}; do
		chmod +x "${entry#*$'\t'}"
		ln -sfn "${entry#*$'\t'}" "$bin_dir/${entry%%$'\t'*}"
		ok "linked $bin_dir/${entry%%$'\t'*} -> ${entry#*$'\t'}"
	done
	version_output="$("$link_path" --version 2>/dev/null || true)"
	if [[ -n "$version_output" ]]; then
		ok "$version_output"
	else
		warn "installed link did not return a version; run: $link_path --version"
	fi
fi

if path_contains_dir "$bin_dir"; then
	ok "$bin_dir is on PATH"
else
	warn "$bin_dir is not on PATH"
	printf '[install-local] add it for this shell with:\n  export PATH="%s:$PATH"\n' "$bin_dir" >&2
fi

# Outside that branch on purpose. A bin dir that is not on PATH is the case
# where some *other* pancode is the only one a bare name can reach, and the old
# check skipped it there. A dry run reports it too: the divergence is a fact
# about the machine, not about whether this run wrote anything.
warn_about_shadowing_pancode

if [[ $dry_run -eq 1 ]]; then
	log "would run: node $cli_target upgrade --post-install"
	log "would run: node $cli_target doctor --fix"
	ok "dry run complete"
	print_next_steps
	exit 0
fi

log "running: node $cli_target upgrade --post-install"
node "$cli_target" upgrade --post-install || fail "post-install checks did not finish; run: pancode doctor --fix. Then rerun this installer."
log "running: node $cli_target doctor --fix"
node "$cli_target" doctor --fix || fail "doctor --fix could not bring the install to green; inspect the output above"

print_next_steps
