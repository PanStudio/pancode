#!/bin/sh
# SPDX-License-Identifier: LicenseRef-PanCode-1.0
# SPDX-FileCopyrightText: 2026 Anthony Kougkas
# PanCode installer: one verified archive holding PanCode and the Node.js it
# runs on, unpacked in your home directory, with no root and no system Node.
#
#   curl -fsSL https://pancode.dev/install.sh | sh
#   curl -fsSL https://pancode.dev/install.sh | sh -s -- --version 0.9.0
#
# What it does, in order:
#   1. Detects OS, CPU and C library (glibc version or musl) and picks the
#      bundle built for them.
#   2. Reads the channel's version from pancode.dev and that release's
#      SHA256SUMS from GitHub, downloads the bundle and verifies its SHA-256.
#      A mismatch stops the install.
#   3. Unpacks the bundle into a versioned directory under the install root.
#      Nothing is fetched from a package registry: the bundle carries the
#      dependency tree the release was tested with.
#   4. Writes a small launcher (default ~/.local/bin/pancode) that runs the
#      new version, replacing it atomically and keeping the previous version
#      for --rollback, and one beside it for each other command the package
#      declares (panstore, pankit).
#
# Shell startup files are edited only with --modify-path. Proxies are honored
# through https_proxy/http_proxy (curl and wget both read them).
#
# The whole body lives in functions and main is called on the last line, so a
# truncated download parses as an incomplete script and runs nothing.
set -eu
# A background run whose parent session died writes into a closed pipe. With
# SIGPIPE ignored that write fails with EPIPE, set -e exits, and the EXIT trap
# still removes the lock and staging; the default SIGPIPE would kill the shell
# before its trap runs (#436).
trap '' PIPE

NPM_PACKAGE="@akougkas/pancode"
# Mirrors package.json engines.node, for the advice printed where no bundle fits.
NODE_MIN="22.19.0"
RELEASE_BASE="https://github.com/akougkas/pancode/releases/download"
CHANNEL_BASE="https://pancode.dev/channel"
LAUNCHER_MARK="# pancode-installer launcher"
MANIFEST_KIND="pancode-installer"
FAILED_CANDIDATE_MARK=".pancode-refused-candidate"
# A bundle is about 85 MB and unpacks to about 330 MB. Refuse early rather
# than die half way through on a quota.
MIN_FREE_KB=500000

usage() {
	cat <<'USAGE'
Usage: install.sh [options]

Install PanCode with the Node.js it runs on. No root, no system Node.

Options:
  --version <spec>      PanCode version: an exact version such as 0.9.0, or
                        latest or beta. Default: the --channel. An exact
                        version pins the install. Env: PANCODE_VERSION
  --channel <name>      latest (default) or beta. Env: PANCODE_CHANNEL
  --leave-prerelease    With the latest channel, move from an active pre-release
                        to stable even when stable is older. Without it, a
                        channel older than the active version is refused.
  --bundle <file>       Install a downloaded bundle (pancode-<version>-<target>.tar.gz)
                        instead of fetching one; for hosts without network
                        access. Pins the install. Env: PANCODE_BUNDLE
  --install-dir <dir>   Install root. Env: PANCODE_INSTALL_DIR
                        Default: $XDG_DATA_HOME/pancode-install on Linux
                        (~/.local/share/pancode-install), ~/Library/Application
                        Support/pancode/install on macOS, or
                        $PANCODE_HOME/install when PANCODE_HOME is set.
  --bin-dir <dir>       Where the pancode launcher goes. Default ~/.local/bin.
                        Env: PANCODE_BIN_DIR
  --include-claude-sdk  Provision the separate Claude Agent SDK component.
                        Default: skip it; interactive Claude setup asks before provisioning.
  --no-modify-path      Keep shell startup files unchanged (default).
  --modify-path         Append a PATH line for the bin dir to your shell's
                        startup file. Without it, the installer only prints one.
  --no-auto-update      Disable background updates. Env: PANCODE_AUTO_UPDATE=0
  --auto-update         Enable background updates (unpinned installs only).
  --rollback            Point the launcher back at the previous installed version.
  --no-post-install     Skip `pancode upgrade --post-install` after installing.
  --gui                 Also set up the desktop app (Linux: starts at login and
                        appears in the app menu; under WSL also in the Windows
                        Start Menu; macOS: starts at login). Env:
                        PANCODE_INSTALL_GUI=1
  --no-gui              Skip the desktop app. Default: ask on a terminal, skip
                        otherwise. Env: PANCODE_INSTALL_GUI=0
  --force               Replace a pancode launcher this installer did not write.
  --dry-run             Print the plan; download and change nothing.
  -h, --help            Show this help.

Environment:
  PANCODE_RELEASE_MIRROR  Base URL (https:// or file://) of a mirror laid out as
                          <base>/channel/<latest|beta> and
                          <base>/v<version>/<release asset>
  PANCODE_TARGET          Force a bundle: linux-x64, linux-arm64,
                          linux-x64-glibc-217, linux-x64-musl, linux-arm64-musl,
                          darwin-x64, darwin-arm64

Remove everything later with:
  pancode uninstall
USAGE
}

log() { printf '[install] %s\n' "$*"; }
ok() { printf '[install] ok: %s\n' "$*"; }
warn() { printf '[install] warning: %s\n' "$*" >&2; }
fail() {
	printf '[install] error: %s\n' "$*" >&2
	exit 1
}
have() { command -v "$1" >/dev/null 2>&1; }

expand_tilde() {
	case "$1" in
		"~") printf '%s\n' "$HOME" ;;
		"~/"*) printf '%s/%s\n' "$HOME" "${1#"~/"}" ;;
		*) printf '%s\n' "$1" ;;
	esac
}

# Absolute path without requiring it to exist.
absolute_path() {
	case "$1" in
		/*) printf '%s\n' "$1" ;;
		*) printf '%s/%s\n' "$PWD" "$1" ;;
	esac
}

# Paths are written into a JSON manifest and a shell launcher without an
# escaping layer, so the characters that would need one are refused instead.
check_plain_path() {
	case "$2" in
		*'"'* | *'\'* | *'$'* | *'`'*) fail "$1 contains a quote, backslash, \$ or backtick, which this installer does not support: $2" ;;
	esac
	case "$2" in
		*"
"*) fail "$1 contains a newline: $2" ;;
	esac
}

# Succeeds when dotted numeric version $1 >= $2.
version_ge() {
	awk -v a="$1" -v b="$2" 'BEGIN {
		na = split(a, x, "."); nb = split(b, y, ".")
		for (i = 1; i <= 3; i++) {
			p = (i <= na) ? x[i] + 0 : 0; q = (i <= nb) ? y[i] + 0 : 0
			if (p > q) exit 0
			if (p < q) exit 1
		}
		exit 0
	}'
}

single_line() {
	[ "$(printf '%s\n' "$1" | wc -l | tr -d ' ')" = 1 ]
}

# Exact semver, or a channel name. Everything else is refused before it can
# become part of a download URL or a directory name.
validate_version() {
	spec="$1"
	case "$spec" in
		v[0-9]*) spec="${spec#v}" ;;
	esac
	if single_line "$spec" && printf '%s\n' "$spec" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$'; then
		printf '%s\n' "$spec"
		return 0
	fi
	case "$spec" in
		latest | beta)
			printf '%s\n' "$spec"
			return 0
			;;
	esac
	fail "invalid --version '$1'; use an exact version such as 0.9.0, or latest or beta"
}

refuse_sudo() {
	# Under sudo, $HOME is root's or a root-owned copy of yours, and the launcher
	# would land where your own shell never looks.
	if [ "$(id -u 2>/dev/null || echo 1)" = 0 ] && [ -n "${SUDO_USER:-}" ] && [ "$SUDO_USER" != root ] &&
		[ -z "${PANCODE_INSTALL_ALLOW_SUDO:-}" ]; then
		fail "do not run this installer with sudo; it installs into your home directory. Rerun the same command without sudo, or set PANCODE_INSTALL_ALLOW_SUDO=1 to install for root on purpose."
	fi
}

pick_downloader() {
	if have curl; then
		downloader=curl
	elif have wget; then
		downloader=wget
	else
		fail "neither curl nor wget was found; install one, or fetch a bundle by hand and pass --bundle"
	fi
}

# download <url> <file>. file:// URLs are copied, so an airgapped mirror on a
# shared filesystem needs no web server.
download() {
	case "$1" in
		file://*)
			cp -- "${1#file://}" "$2" 2>/dev/null
			return
			;;
	esac
	if [ "$downloader" = curl ]; then
		case "$1" in
			https://*) curl -fsSL --proto '=https' --retry 3 --connect-timeout 20 -o "$2" "$1" ;;
			*) curl -fsSL --retry 3 --connect-timeout 20 -o "$2" "$1" ;;
		esac
	else
		wget -q --tries=3 --timeout=20 -O "$2" "$1"
	fi
}

sha256_of() {
	if have sha256sum; then
		sha256sum "$1" | awk '{print $1}'
	elif have shasum; then
		shasum -a 256 "$1" | awk '{print $1}'
	elif have openssl; then
		openssl dgst -sha256 "$1" | awk '{print $NF}'
	else
		fail "no SHA-256 tool found (sha256sum, shasum or openssl); one is needed to verify downloads"
	fi
}

detect_platform() {
	case "$(uname -s 2>/dev/null || echo unknown)" in
		Linux) os=linux ;;
		Darwin) os=darwin ;;
		MINGW* | MSYS* | CYGWIN*) fail "this installer targets Linux and macOS; on Windows, run in PowerShell: irm https://pancode.dev/install.ps1 | iex" ;;
		*) fail "unsupported operating system: $(uname -s 2>/dev/null || echo unknown). Supported: Linux and macOS." ;;
	esac
	case "$(uname -m 2>/dev/null || echo unknown)" in
		x86_64 | amd64) arch=x64 ;;
		aarch64 | arm64) arch=arm64 ;;
		*) fail "unsupported CPU: $(uname -m). Supported: x86_64 and arm64. Install Node $NODE_MIN or newer yourself (conda-forge builds more CPUs), then: npm install -g $NPM_PACKAGE" ;;
	esac
	# An x64 shell under Rosetta on Apple silicon should still get native Node.
	if [ "$os" = darwin ] && [ "$arch" = x64 ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = 1 ]; then
		arch=arm64
	fi
	libc=""
	glibc=""
	[ "$os" = linux ] || return 0
	# Ask glibc first: only glibc answers GNU_LIBC_VERSION, while a glibc host
	# can also carry the musl loader (Debian's musl package installs
	# /lib/ld-musl-*.so.1) and must still get a glibc Node.
	glibc="$(getconf GNU_LIBC_VERSION 2>/dev/null | awk '{print $2}')" || glibc=""
	if [ -n "$glibc" ]; then
		libc=glibc
		return 0
	fi
	if ls /lib/ld-musl-*.so.1 >/dev/null 2>&1 || (ldd --version 2>&1 | grep -qi musl); then
		libc=musl
		return 0
	fi
	libc=glibc
	glibc="$(ldd --version 2>&1 | head -n 1 | grep -Eo '[0-9]+\.[0-9]+' | tail -n 1)" || glibc=""
	[ -n "$glibc" ] || fail "could not determine the glibc version (getconf GNU_LIBC_VERSION and ldd --version both failed); set PANCODE_TARGET to pick a bundle"
}

# Sets node_build (the tarball's platform part), node_index_key (its name in

# Sets target, the bundle built for this OS, CPU and C library.
select_target() {
	if [ -n "${PANCODE_TARGET:-}" ]; then
		target="$PANCODE_TARGET"
	elif [ "$os" = darwin ]; then
		target="darwin-$arch"
	elif [ "$libc" = musl ]; then
		target="linux-$arch-musl"
	elif version_ge "$glibc" 2.28; then
		target="linux-$arch"
	elif [ "$arch" = x64 ] && version_ge "$glibc" 2.17; then
		target="linux-x64-glibc-217"
	elif [ "$arch" = arm64 ]; then
		fail "glibc $glibc is older than 2.28, which arm64 Node.js builds need, and no older-glibc arm64 bundle exists. Use conda-forge nodejs (conda create -n node -c conda-forge 'nodejs>=22'), then run npm install -g $NPM_PACKAGE with that Node."
	else
		fail "glibc $glibc is older than 2.17, the oldest any Node.js 22+ build supports"
	fi
	case "$target" in
		linux-x64 | linux-arm64 | linux-x64-glibc-217 | linux-x64-musl | linux-arm64-musl | darwin-x64 | darwin-arm64) ;;
		*) fail "unknown bundle target '$target'; see --help for PANCODE_TARGET values" ;;
	esac
}

# The version a channel names: one line at <channel base>/<channel>.
resolve_channel() {
	download "$channel_base/$1" "$work/channel" ||
		fail "could not read $channel_base/$1; check the network or proxy (https_proxy), pass --version <exact version>, or set PANCODE_RELEASE_MIRROR"
	resolved="$(head -n 1 "$work/channel" | tr -d ' \r')"
	printf '%s\n' "$resolved" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$' || fail "$channel_base/$1 does not name a version"
	printf '%s\n' "$resolved"
}

# Refuses a channel that resolved to a version older than the active one, using
# the active install's own Node and npm's SemVer. Only an explicit request
# (`pancode upgrade --channel latest` passes --leave-prerelease) moves down; a
# recorded channel never does.
guard_downgrade() {
	current_prefix="$(manifest_field current)"
	[ -n "$current_prefix" ] || return 0
	active_node="$(manifest_field node)"
	active_version="$("$active_node" -e 'process.stdout.write(require(process.argv[1]).version)' "$current_prefix/lib/node_modules/pancode/package.json" 2>/dev/null)" || return 0
	downgrade="$("$active_node" -e 'const s=require(process.argv[1]),r=process.argv[2],a=process.argv[3];process.stdout.write(s.valid(a)&&s.lt(r,a)?(s.prerelease(a)&&!s.prerelease(r)?"prerelease":"older"):"")' "$current_prefix/lib/node_modules/npm/node_modules/semver" "$1" "$active_version" 2>/dev/null)" || return 0
	case "$downgrade:$version" in
		prerelease:latest)
			[ "$leave_prerelease" = 1 ] || fail "the $channel channel resolved to $1, older than the active $active_version; the installation was left unchanged. To leave the pre-release for stable $1, pass --leave-prerelease; to return to the previous install, use --rollback."
			log "leaving the pre-release $active_version for stable $1"
			;;
		prerelease:* | older:*)
			fail "the $channel channel resolved to $1, older than the active $active_version; the installation was left unchanged. To install $1, pass --version $1; to return to the previous install, use --rollback."
			;;
	esac
}

# Downloads the release's bundle for this target into $work and verifies it
# against the release's SHA256SUMS. Sets bundle_file.
fetch_bundle() {
	asset="pancode-$1-$target.tar.gz"
	download "$release_base/v$1/SHA256SUMS" "$work/SHA256SUMS" ||
		fail "could not read $release_base/v$1/SHA256SUMS; PanCode $1 may not exist, or the network or proxy (https_proxy) blocks it"
	expected="$(awk -v file="$asset" '$2 == file || $2 == "*" file {print $1; exit}' "$work/SHA256SUMS")"
	[ -n "$expected" ] || fail "PanCode $1 ships no $target bundle. Install Node $NODE_MIN or newer yourself, then: npm install -g $NPM_PACKAGE@$1"
	log "downloading $asset"
	download "$release_base/v$1/$asset" "$work/$asset" || fail "could not download $release_base/v$1/$asset"
	actual="$(sha256_of "$work/$asset")"
	[ "$actual" = "$expected" ] || fail "$asset has SHA-256 $actual, but the release lists $expected; nothing was installed"
	ok "verified $asset (sha256 $expected)"
	bundle_file="$work/$asset"
}

check_node_runs() {
	if ! ran="$("$node_bin" -e 'process.stdout.write(process.versions.node)' 2>"$work/node.err")"; then
		detail="$(head -n 3 "$work/node.err")"
		hint=""
		case "$detail" in
			*GLIBC* | *libstdc* | *CXXABI*) hint=" This bundle needs a newer C or C++ runtime than this system has; on x64, PANCODE_TARGET=linux-x64-glibc-217 selects the older-glibc bundle." ;;
		esac
		if [ "$libc" = musl ]; then hint=" musl bundles need libstdc++ and libgcc (apk add libstdc++)."; fi
		fail "the bundled Node at $node_bin does not run: $detail.$hint"
	fi
	ok "Node v$ran runs ($target)"
}

free_kb() {
	df -Pk "$1" 2>/dev/null | awk 'NR == 2 {print $4}'
}

check_writable_dir() {
	probe="$2"
	while [ ! -e "$probe" ]; do
		probe="$(dirname "$probe")"
	done
	[ -d "$probe" ] || fail "$1 parent $probe is not a directory"
	[ -w "$probe" ] || fail "$probe is not writable by $(id -un 2>/dev/null || echo "this user") (a read-only home, or the wrong owner); this installer never uses sudo. Choose another location with $3."
}

manifest_field() {
	[ -f "$install_root/install.json" ] || return 0
	sed -n "s/^[[:space:]]*\"$1\": *\"\\([^\"]*\\)\".*/\\1/p" "$install_root/install.json" | head -n 1
}

launcher_is_ours() {
	[ -f "$launcher" ] && [ ! -L "$launcher" ] && grep -q "^$LAUNCHER_MARK" "$launcher" 2>/dev/null
}

check_existing_launcher() {
	[ -e "$launcher" ] || [ -L "$launcher" ] || return 0
	launcher_is_ours && return 0
	if [ -L "$launcher" ]; then
		link_target="$(readlink "$launcher")"
		case "$link_target" in
			/*) checkout_entry="$link_target" ;;
			*) checkout_entry="$bin_dir/$link_target" ;;
		esac
		case "$checkout_entry" in
			*/dist/cli/index.js)
				checkout_root="${checkout_entry%/dist/cli/index.js}"
				if [ -e "$checkout_root/.git" ] && [ -f "$checkout_root/src/cli/index.ts" ]; then
					[ "$force" = 1 ] || fail "source checkout detected at $checkout_root. Keep using that checkout: cd \"$checkout_root\" && pnpm run install:local. Switch this launcher to the managed release: rerun this installer with --force (the checkout is kept). Choose --bin-dir for a separate launcher."
				fi
				;;
		esac
		case "$link_target" in
			*lib/node_modules/"$NPM_PACKAGE"/*)
				warn "replacing $launcher, a link into an npm install of PanCode ($link_target)"
				npm_prefix="${checkout_entry%/lib/node_modules/"$NPM_PACKAGE"/*}"
				npm_prefix="$(cd "$npm_prefix" 2>/dev/null && pwd -P || printf '%s' "$npm_prefix")"
				warn "that npm copy stays on disk; remove it with the npm that installed it: npm uninstall -g --prefix \"$npm_prefix\" $NPM_PACKAGE"
				return 0
				;;
		esac
		[ "$force" = 1 ] || fail "refusing to replace $launcher; it points to $link_target (a source-checkout launcher, perhaps). Rerun with --force to replace it, or choose another --bin-dir."
		warn "replacing pancode symlink that points outside this install: $launcher -> $link_target"
		return 0
	fi
	[ "$force" = 1 ] || fail "refusing to overwrite $launcher, which this installer did not write; move it aside, choose another --bin-dir, or rerun with --force"
	warn "replacing $launcher (--force)"
}

path_contains_dir() {
	case ":${PATH:-}:" in
		*":$1:"*) return 0 ;;
	esac
	return 1
}

shell_rc_file() {
	case "$(basename "${SHELL:-sh}")" in
		zsh) printf '%s\n' "${ZDOTDIR:-$HOME}/.zshrc" ;;
		bash) printf '%s\n' "$HOME/.bashrc" ;;
		fish) printf '%s\n' "${XDG_CONFIG_HOME:-$HOME/.config}/fish/config.fish" ;;
		*) printf '%s\n' "$HOME/.profile" ;;
	esac
}

path_line() {
	case "$(basename "${SHELL:-sh}")" in
		fish) printf 'fish_add_path "%s"\n' "$bin_dir" ;;
		*) printf 'export PATH="%s:$PATH"\n' "$bin_dir" ;;
	esac
}

report_path() {
	if path_contains_dir "$bin_dir"; then
		return 0
	fi
	rc="$(shell_rc_file)"
	if [ "$modify_path" = 1 ] && [ "$dry_run" = 0 ]; then
		if [ -f "$rc" ] && grep -q '# added by pancode install.sh' "$rc"; then
			ok "$rc already has the pancode PATH line"
		else
			mkdir -p "$(dirname "$rc")"
			printf '\n# added by pancode install.sh\n%s\n' "$(path_line)" >>"$rc"
			ok "added $bin_dir to PATH in $rc; open a new shell, or run: $(path_line)"
		fi
		return 0
	fi
	# Last lines of the install, so the command a user copies from the bottom is one that runs as printed.
	warn "$bin_dir is not on your PATH. Until it is, run: $launcher"
	printf '  To add it: %s   (and to %s to keep it, or rerun with --modify-path)\n' "$(path_line)" "$rc" >&2
}

warn_about_shadowing_pancode() {
	found="$(command -v pancode 2>/dev/null || true)"
	[ -n "$found" ] || return 0
	[ "$found" = "$launcher" ] && return 0
	warn "another pancode is on your PATH at $found and shadows $launcher"
	warn "check it with: $found --version; remove it or put $bin_dir earlier on PATH, then run: hash -r"
}

# The installed binary computes the next step for this home: found keys and servers, or the route in use.
print_next_steps() {
	if ! "$node_bin" "$entry" setup --next </dev/null 2>/dev/null; then
		printf 'Run: pancode\n'
	fi
	[ "$install_gui" = 0 ] || printf 'Desktop app: pancode gui\n'
}

# The desktop app is the GUI's background service: one `gui background install` adds the login
# service (a systemd user unit on Linux, a launchd agent on macOS), the app-menu entry on Linux and,
# under WSL, the Windows Start Menu shortcut. Other platforms keep the `pancode gui` hint only.
offer_gui() {
	[ "$install_gui" != 0 ] || return 0
	gui_os="$(uname -s 2>/dev/null)"
	if [ "$gui_os" != Linux ] && [ "$gui_os" != Darwin ]; then
		# Asked for by name, it gets an answer; the default stays quiet where there is nothing to offer.
		if [ "$install_gui" = 1 ]; then warn "the desktop app runs as a login service on Linux and macOS only; start it here with: pancode gui"; fi
		return 0
	fi
	if [ "$install_gui" = ask ]; then
		# curl | sh leaves stdin on the pipe; the question goes to the terminal or is not asked.
		[ -t 1 ] && { : </dev/tty; } 2>/dev/null || return 0
	fi
	if [ "$install_gui" = ask ] && "$node_bin" "$entry" gui background status </dev/null 2>/dev/null | "$node_bin" -e 'try { process.exit(JSON.parse(require("node:fs").readFileSync(0, "utf8")).status === "installed" ? 0 : 1); } catch { process.exit(1); }'; then
		return 0
	fi
	if [ "$install_gui" = ask ]; then
		if [ "$gui_os" = Darwin ]; then
			printf '[install] Add the PanCode desktop app? It starts at login; open it with pancode gui. [Y/n] '
		else
			printf '[install] Add the PanCode desktop app? It starts at login and appears in your app menu. [Y/n] '
		fi
		answer=""
		read -r answer </dev/tty || answer=n
		case "$answer" in "" | [Yy]*) ;; *) return 0 ;; esac
	fi
	# The command's report is JSON for scripts; the installer states the outcome in its own words.
	if "$node_bin" "$entry" gui background install --handover --json </dev/null >"$work/gui.out"; then
		if "$node_bin" -e 'try { process.exit(JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).windows?.status === "installed" ? 0 : 1); } catch { process.exit(1); }' "$work/gui.out"; then
			ok "desktop app installed; open PanCode from the Windows Start Menu or your app menu, or run: pancode gui"
		elif [ "$gui_os" = Darwin ]; then
			ok "desktop app installed; it starts at login; open it with: pancode gui"
		else
			ok "desktop app installed; it starts at login and is in your app menu as PanCode, or run: pancode gui"
		fi
		gui_warning="$("$node_bin" -e 'try { const w=JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).windows; if(w?.status === "failed") process.stdout.write("Windows desktop setup failed: " + String(w.reason || "unknown error") + "; run pancode doctor --fix"); } catch { process.stdout.write("Could not read the desktop setup report; run pancode doctor"); }' "$work/gui.out")"
		[ -z "$gui_warning" ] || warn "$gui_warning"
		log "the desktop app uses PanCode's saved credentials; save a key that lives only in your shell with: pancode auth login <target>"
	else
		warn "the desktop app was not set up. Retry with: pancode doctor --fix (verified service handover waits until active work finishes)"
	fi
}

# The pane host is what bare `pancode` opens: the session beside terminal panes, hosted by
# PanCode's own pinned herdr in its data directory. A herdr of the operator's own on PATH is
# never used for that and never touched. A failure here never fails the install: PanCode runs in the
# plain terminal, says so once, and never downloads on first launch; `pancode panes install` retries.
provision_workspace() {
	# Same command as install.ps1, so both installers provision the pane host identically.
	if "$node_bin" "$entry" tools install herdr --json </dev/null >"$work/workspace.out" 2>"$work/workspace.err"; then
		ok "pane host ready: $("$node_bin" -e 'try { process.stdout.write(String(JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).message || "herdr")); } catch { process.stdout.write("herdr"); }' "$work/workspace.out")"
	else
		warn "the pane host (herdr) was not installed; PanCode runs in the plain terminal until you run: pancode panes install"
	fi
}

default_install_root() {
	if [ -n "${PANCODE_INSTALL_DIR:-}" ]; then
		printf '%s\n' "$PANCODE_INSTALL_DIR"
	elif [ -n "${PANCODE_HOME:-}" ]; then
		printf '%s/install\n' "${PANCODE_HOME%/}"
	elif [ "$(uname -s 2>/dev/null)" = Darwin ]; then
		printf '%s/Library/Application Support/pancode/install\n' "$HOME"
	else
		# A sibling of the data root ($XDG_DATA_HOME/pancode), never inside it:
		# `pancode reset` and `uninstall --keep-config` delete the data root and
		# must not delete the Node that runs them. The XDG spec reads an empty or
		# relative value as unset.
		case "${XDG_DATA_HOME:-}" in
			/*) printf '%s/pancode-install\n' "$XDG_DATA_HOME" ;;
			*) printf '%s/.local/share/pancode-install\n' "$HOME" ;;
		esac
	fi
}

# Lock owner identity: a stable machine id plus the pid namespace, so a pid
# recorded by another machine on a shared filesystem, or by another container
# on this one, is never judged against this host's process table (#436). The
# host name is only a fallback: macOS renames itself per network (Mac.local,
# Mac.lan) and would read its own old lock as foreign forever.
install_lock_host() {
	id=""
	for file in /etc/machine-id /var/lib/dbus/machine-id; do
		if [ -z "$id" ] && [ -r "$file" ]; then id="$(tr -d ' \n' <"$file" 2>/dev/null || true)"; fi
	done
	if [ -z "$id" ] && have ioreg; then
		id="$(ioreg -rd1 -c IOPlatformExpertDevice 2>/dev/null | awk -F'"' '/IOPlatformUUID/ { print $4; exit }')"
	fi
	[ -n "$id" ] || id="$(uname -n 2>/dev/null || hostname 2>/dev/null || true)"
	printf '%s' "$id"
	if [ -r /proc/self/ns/pid ]; then printf '/%s' "$(readlink /proc/self/ns/pid 2>/dev/null || true)"; fi
}

# True only when pid $1 is provably absent here. kill -0 also fails with EPERM
# for another user's live process, so a failure is confirmed against /proc,
# or ps where there is no /proc.
install_pid_gone() {
	case "$1" in '' | *[!0-9]*) return 1 ;; esac
	kill -0 "$1" 2>/dev/null && return 1
	if [ -d /proc/self ]; then
		[ ! -d "/proc/$1" ]
	else
		! ps -p "$1" >/dev/null 2>&1
	fi
}

# A SIGKILLed installer skips its EXIT trap and leaves the lock and its staging
# prefixes behind, failing every later run until someone deletes the lock by
# hand (#436). Reclaim only a lock written by this host whose pid is provably
# gone and whose age exceeds 10 minutes; a foreign or unlabelled owner is never
# adjudicated. Ownership moves by renaming the owner's pid file: one rename
# wins, and the lock directory never disappears, so no concurrent reclaimer or
# fresh acquirer can slip in between.
reclaim_stale_install_lock() {
	lock="$install_root/.install-lock"
	owner_pid="$(cat "$lock/pid" 2>/dev/null || true)"
	owner_host="$(cat "$lock/host" 2>/dev/null || true)"
	[ -n "$owner_host" ] && [ "$owner_host" = "$(install_lock_host)" ] || return 1
	install_pid_gone "$owner_pid" || return 1
	[ -n "$(find "$lock" -prune -mmin +10 2>/dev/null)" ] || return 1
	mv "$lock/pid" "$lock/pid.reclaim.$$" 2>/dev/null || return 1
	# A slower reclaimer that judged the same owner can reach here after the
	# winner wrote its own pid; it hands that file back and stands down.
	if [ "$(cat "$lock/pid.reclaim.$$" 2>/dev/null || true)" != "$owner_pid" ]; then
		mv "$lock/pid.reclaim.$$" "$lock/pid" 2>/dev/null || true
		return 1
	fi
	rm -f "$lock/pid.reclaim.$$"
	warn "reclaimed stale installation lock $lock (pid $owner_pid on $(cat "$lock/hostname" 2>/dev/null || echo "$owner_host"))"
	rm -rf "$install_root/versions/.staging.$owner_pid"
	return 0
}

acquire_install_lock() {
	check_writable_dir "install dir" "$install_root" "--install-dir"
	mkdir -p "$install_root"
	if ! mkdir "$install_root/.install-lock" 2>/dev/null && ! reclaim_stale_install_lock; then
		# Only a lock directory that is there is another run's; any other mkdir failure is ours to report.
		[ -d "$install_root/.install-lock" ] || fail "cannot create $install_root/.install-lock: $(mkdir "$install_root/.install-lock" 2>&1 | sed 's/^mkdir: //')"
		# Exit 75 (EX_TEMPFAIL), not 1: a held lock is another run in progress
		# or a recent crash, so a background update retries later instead of
		# recording a failure (#436).
		printf '[install] error: %s\n' "installation locked at $install_root/.install-lock by pid $(cat "$install_root/.install-lock/pid" 2>/dev/null || echo '?') on $(cat "$install_root/.install-lock/hostname" 2>/dev/null || cat "$install_root/.install-lock/host" 2>/dev/null || echo 'an unrecorded host'). If that process has exited, remove only that lock directory and retry." >&2
		exit 75
	fi
	lock_owned=1
	install_lock_host >"$install_root/.install-lock/host"
	(uname -n 2>/dev/null || hostname 2>/dev/null || true) >"$install_root/.install-lock/hostname"
	printf '%s\n' "$$" >"$install_root/.install-lock/pid"
	touch "$install_root/.install-lock"
	trap cleanup EXIT
	trap 'exit 130' INT
	trap 'exit 143' TERM
	# A background update belongs to the session that started it. If that
	# session is SIGKILLed nothing signals this shell, so a watchdog turns the
	# parent's exit into our TERM and cleanup removes the lock and staging
	# instead of finishing an install nobody is waiting for (#436).
	if [ "${PANCODE_BACKGROUND_UPDATE:-}" = 1 ]; then
		session_pid=$PPID
		installer_pid=$$
		# It also stops when this shell is gone, so a later reuse of our pid is
		# never sent a TERM meant for us.
		(while kill -0 "$session_pid" 2>/dev/null; do kill -0 "$installer_pid" 2>/dev/null || exit 0; sleep 1; done; kill -TERM "$installer_pid" 2>/dev/null) </dev/null >/dev/null 2>&1 &
		watchdog_pid=$!
	fi
}

do_rollback() {
	[ -f "$install_root/install.json" ] || fail "no installer manifest at $install_root/install.json; nothing to roll back"
	node_path="$(manifest_field node)"
	current="$(manifest_field current)"
	helper="$current/lib/node_modules/pancode/scripts/native-install.cjs"
	[ -f "$helper" ] || fail "the active install at $current is incomplete; rerun the installer"
	previous="$(manifest_field previous)"
	previous_version="$("$node_path" -e 'process.stdout.write(require(process.argv[1]).version)' "$previous/lib/node_modules/pancode/package.json" 2>/dev/null)" || fail "no complete previous install"
	active_version="$("$node_path" -e 'process.stdout.write(require(process.argv[1]).version)' "$current/lib/node_modules/pancode/package.json" 2>/dev/null)" || active_version="unknown"
	check_writable_dir "install dir" "$install_root" "--install-dir"
	check_writable_dir "bin dir" "$bin_dir" "--bin-dir"
	if [ "$dry_run" = 1 ]; then
		log "would roll back $install_root from $active_version (versions/${current##*/}) to $previous_version (versions/${previous##*/})"
		return 0
	fi
	acquire_install_lock
	"$node_path" "$helper" rollback "$install_root" </dev/null
}

cleanup() {
	if [ -n "${watchdog_pid:-}" ]; then kill "$watchdog_pid" 2>/dev/null || true; fi
	if [ -n "${unpack_pid:-}" ]; then
		kill -KILL "$unpack_pid" 2>/dev/null || true
		wait "$unpack_pid" 2>/dev/null || true
	fi
	if [ "${lock_owned:-0}" = 1 ]; then rm -rf "$install_root/.install-lock"; fi
	if [ -n "${work:-}" ]; then rm -rf "$work"; fi
	if [ -n "${install_root:-}" ]; then rm -rf "$install_root/versions/.staging.$$"; fi
	return 0
}

main() {
	version_spec="${PANCODE_VERSION:-}"
	channel="${PANCODE_CHANNEL:-latest}"
	bundle_arg="${PANCODE_BUNDLE:-}"
	install_root_arg=""
	bin_dir_arg="${PANCODE_BIN_DIR:-${HOME:-}/.local/bin}"
	include_claude_sdk=0
	modify_path="${PANCODE_MODIFY_PATH:-0}"
	auto_update="${PANCODE_AUTO_UPDATE:-preserve}"
	lock_owned=0
	rollback=0
	leave_prerelease=0
	post_install=1
	install_gui="${PANCODE_INSTALL_GUI:-ask}"
	force=0
	dry_run=0
	work=""

	while [ $# -gt 0 ]; do
		case "$1" in
			--version | --channel | --bundle | --install-dir | --bin-dir)
				[ $# -ge 2 ] || fail "$1 needs a value"
				case "$1" in
					--version) version_spec="$2" ;;
					--channel) channel="$2" ;;
					--bundle) bundle_arg="$2" ;;
					--install-dir) install_root_arg="$2" ;;
					--bin-dir) bin_dir_arg="$2" ;;
				esac
				shift
				;;
			--version=*) version_spec="${1#--version=}" ;;
			--channel=*) channel="${1#--channel=}" ;;
			--bundle=*) bundle_arg="${1#--bundle=}" ;;
			--install-dir=*) install_root_arg="${1#--install-dir=}" ;;
			--bin-dir=*) bin_dir_arg="${1#--bin-dir=}" ;;
			--include-claude-sdk) include_claude_sdk=1 ;;
			--modify-path) modify_path=1 ;;
			--no-modify-path) modify_path=0 ;;
			--no-auto-update) auto_update=0 ;;
			--auto-update) auto_update=1 ;;
			--rollback) rollback=1 ;;
			--leave-prerelease) leave_prerelease=1 ;;
			--no-post-install) post_install=0 ;;
			--gui) install_gui=1 ;;
			--no-gui) install_gui=0 ;;
			--force | -f) force=1 ;;
			--dry-run) dry_run=1 ;;
			--help | -h)
				usage
				exit 0
				;;
			*) fail "unknown option: $1 (see --help)" ;;
		esac
		shift
	done

	case "$channel" in
		latest | beta) ;;
		*) fail "--channel must be latest or beta, got '$channel'" ;;
	esac
	case "$install_gui" in
		0 | 1 | ask) ;;
		*) fail "PANCODE_INSTALL_GUI must be 1 or 0, got '$install_gui'" ;;
	esac
	if [ -n "$version_spec" ]; then
		version="$(validate_version "$version_spec")"
	else
		version="$channel"
	fi
	case "$version" in latest | beta) channel="$version" ;; esac
	if [ "$leave_prerelease" = 1 ] && [ "$version" != latest ]; then
		fail "--leave-prerelease only moves to the latest channel, not $version"
	fi
	mirror="${PANCODE_RELEASE_MIRROR:-}"
	mirror="${mirror%/}"
	release_base="${mirror:-$RELEASE_BASE}"
	channel_base="${mirror:+$mirror/channel}"
	channel_base="${channel_base:-$CHANNEL_BASE}"

	refuse_sudo
	[ -n "${HOME:-}" ] || fail "HOME is not set"
	[ -n "$install_root_arg" ] || install_root_arg="$(default_install_root)"
	install_root="$(absolute_path "$(expand_tilde "$install_root_arg")")"
	install_root="${install_root%/}"
	bin_dir="$(absolute_path "$(expand_tilde "$bin_dir_arg")")"
	bin_dir="${bin_dir%/}"
	launcher="$bin_dir/pancode"
	check_plain_path "install dir" "$install_root"
	check_plain_path "bin dir" "$bin_dir"

	if [ "$rollback" = 1 ]; then
		do_rollback
		return 0
	fi

	detect_platform
	select_target
	bundle_file=""
	if [ -n "$bundle_arg" ]; then
		bundle_file="$(absolute_path "$(expand_tilde "$bundle_arg")")"
		[ -f "$bundle_file" ] || fail "--bundle $bundle_file does not exist"
		source_label="$bundle_file"
	else
		source_label="PanCode $version for $target from $release_base"
	fi

	log "platform:     $os-$arch${libc:+ ($libc${glibc:+ $glibc})}"
	log "bundle:       $source_label"
	log "install root: $install_root"
	log "launcher:     $launcher"

	if [ "$dry_run" = 1 ]; then
		log "would unpack the bundle into $install_root/versions/<version>"
		log "would write $launcher, a launcher beside it for each other command the package declares, and $install_root/install.json, then run: $launcher upgrade --post-install"
		# The same prefix checks as a real run, so a dry run that passes names no blocker the install then hits.
		check_writable_dir "install dir" "$install_root" "--install-dir or PANCODE_INSTALL_DIR"
		check_writable_dir "bin dir" "$bin_dir" "--bin-dir or PANCODE_BIN_DIR"
		check_existing_launcher
		warn_about_shadowing_pancode
		report_path
		ok "dry run complete; nothing was downloaded or changed"
		return 0
	fi

	have tar || fail "tar was not found; it is needed to unpack the bundle"
	have gzip || fail "gzip was not found; it is needed to unpack the bundle"
	# A local bundle and a file:// mirror are read with cp.
	case "${bundle_file:+local}$release_base" in
		local* | file://*) ;;
		*) pick_downloader ;;
	esac
	check_writable_dir "install dir" "$install_root" "--install-dir or PANCODE_INSTALL_DIR"
	check_writable_dir "bin dir" "$bin_dir" "--bin-dir or PANCODE_BIN_DIR"
	check_existing_launcher
	acquire_install_lock
	if [ ! -f "$install_root/install.json" ] && [ ! -f "$install_root/.installer-owner" ]; then
		[ ! -e "$install_root/versions" ] || fail "refusing to claim an existing versions directory without installer ownership"
	fi
	if [ -f "$install_root/install.json" ] && ! grep -Eq '"schema": *3[,}]?$' "$install_root/install.json"; then
		fail "$install_root holds an installation this installer cannot read. Remove that directory (your settings and sessions live elsewhere and stay), or choose another --install-dir, then rerun."
	fi
	printf '%s\n' "$MANIFEST_KIND" >"$install_root/.installer-owner"
	mkdir -p "$install_root/versions" || fail "could not create $install_root"
	available="$(free_kb "$install_root")"
	case "$available" in
		'' | *[!0-9]*) ;;
		*)
			if [ "$available" -lt "$MIN_FREE_KB" ]; then
				fail "only $((available / 1024)) MB free under $install_root; PanCode needs about $((MIN_FREE_KB / 1024)) MB. Free space, or choose --install-dir on a larger filesystem."
			fi
			;;
	esac
	work="$(mktemp -d "$install_root/.work.XXXXXX")" || fail "could not create a work directory under $install_root"

	if [ -z "$bundle_file" ]; then
		case "$version" in
			latest | beta)
				resolved="$(resolve_channel "$version")"
				guard_downgrade "$resolved"
				log "resolved $channel to $resolved"
				;;
			*) resolved="$version" ;;
		esac
		fetch_bundle "$resolved"
	fi

	# Active sessions may still lazily read any prior version.
	staging="$install_root/versions/.staging.$$"
	rm -rf "$staging"
	mkdir -p "$staging"
	# tar runs as a waited background child: a shell defers its INT/TERM trap
	# until a foreground child exits, so a quitting session's installer would
	# outlive it. `wait` returns at once on a trapped signal and cleanup kills
	# tar before removing staging (#436). stdin is closed because under
	# `curl | sh` it carries the rest of this script.
	tar -xzf "$bundle_file" -C "$staging" </dev/null &
	unpack_pid=$!
	unpack_status=0
	wait "$unpack_pid" || unpack_status=$?
	unpack_pid=""
	[ "$unpack_status" = 0 ] || fail "could not unpack $bundle_file under $install_root (a full disk, or not a PanCode bundle)"
	node_bin="$staging/bin/node"
	pkg_dir="$staging/lib/node_modules/pancode"
	[ -x "$node_bin" ] && [ -f "$pkg_dir/package.json" ] || fail "$bundle_file is not a PanCode bundle for Linux or macOS"
	check_node_runs
	installed_version="$("$node_bin" -e 'const p=require(process.argv[1]);if(p.name!==process.argv[2])process.exit(1);process.stdout.write(p.version)' "$pkg_dir/package.json" "$NPM_PACKAGE" 2>/dev/null)" ||
		fail "$bundle_file does not hold the $NPM_PACKAGE package"
	final_prefix="$install_root/versions/$installed_version"
	if [ -e "$final_prefix" ]; then final_prefix="$final_prefix-$(date -u +%Y%m%d%H%M%S)-$$"; fi
	mv "$staging" "$final_prefix"
	node_bin="$final_prefix/bin/node"
	entry="$final_prefix/lib/node_modules/pancode/dist/cli/index.js"
	[ -f "$entry" ] || fail "the bundle has no dist/cli/index.js"
	if [ "$include_claude_sdk" = 1 ]; then
		"$node_bin" "$entry" tools install claude-sdk </dev/null || fail "Claude SDK provisioning failed; previous launcher remains active."
	fi
	ok "installed PanCode $installed_version"

	helper="$final_prefix/lib/node_modules/pancode/scripts/native-install.cjs"
	[ -f "$helper" ] || fail "the bundle has no lifecycle helper; previous install remains active"
	pin=""
	pin_source=version-flag
	case "$version_spec" in [0-9]* | v[0-9]*) pin="$installed_version" ;; esac
	if [ -n "$bundle_arg" ]; then
		pin="$installed_version"
		pin_source=bundle-file
	fi
	"$node_bin" "$helper" activate "$install_root" "$final_prefix" "$launcher" "$channel" "$pin" "$auto_update" "$post_install" "$pin_source" </dev/null || {
		: >"$final_prefix/$FAILED_CANDIDATE_MARK"
		active_version="$("$node_bin" -e 'process.stdout.write(require(process.argv[1]).version)' "$(manifest_field current)/lib/node_modules/pancode/package.json" 2>/dev/null)" || active_version=""
		if [ -n "$active_version" ] && ! version_ge "${installed_version%%-*}" "${active_version%%-*}"; then
			# An older version rejects keys a newer one wrote, and its own doctor --fix exits 1 and changes nothing.
			fail "candidate checks failed; previous install remains active. PanCode $installed_version is older than the active $active_version, and doctor --fix cannot make it read settings a newer version wrote, whatever the lines above advise. To use $installed_version, move the newer settings aside first."
		fi
		# The pancode on PATH is still the previous version, and a version that predates a repair reports nothing to fix.
		fail "candidate checks failed; previous install remains active. Repair with the new version itself, then rerun this installer: \"$node_bin\" \"$entry\" doctor --fix"
	}
	if [ "$post_install" = 1 ]; then
		# --no-gui reaches the post-install too, so it leaves an existing desktop setup and its shortcut alone (F-C17).
		PANCODE_INSTALL_GUI="$install_gui" "$node_bin" "$entry" upgrade --post-install </dev/null || fail "PanCode is installed, but local initialization needs attention; run: $launcher upgrade --post-install. Previous binary remains available via --rollback."
	fi
	provision_workspace
	offer_gui
	warn_about_shadowing_pancode
	print_next_steps
	report_path
}

# A group runs only once its closing brace arrived, so a truncated download runs nothing.
{ main "$@"; }
