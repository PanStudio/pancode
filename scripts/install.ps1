# PanCode installer for Windows: one verified archive holding PanCode and the
# Node.js it runs on, unpacked in your user profile, with no administrator
# rights and no system Node.
#
#   irm https://pancode.dev/install.ps1 | iex
#   & ([scriptblock]::Create((irm https://pancode.dev/install.ps1))) -Version 0.9.0
#   powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1 -Bundle .\pancode-0.9.0-win-x64.tar.gz
#
# The Windows counterpart of scripts/install.sh, with the same layout so
# `pancode doctor`, `upgrade` and `uninstall` read both the same way:
#   <InstallDir>\versions\<version>\node.exe
#   <InstallDir>\versions\<version>\lib\node_modules\pancode
#   <InstallDir>\install.json
#   <BinDir>\pancode.exe and pancode.launch
# The launcher is a small native exe (assets\windows-launcher) that starts the
# bundled Node with your arguments unchanged; a .cmd would pass them through
# cmd.exe, which expands %NAME% in them.
# It reads the channel's version from pancode.dev and that release's
# SHA256SUMS from GitHub, downloads the win-x64 or win-arm64 bundle, verifies
# its SHA-256, and adds the launcher to the user PATH and the current
# PowerShell session by default. Use -NoModifyPath (or PANCODE_MODIFY_PATH=0)
# to opt out. PANCODE_RELEASE_MIRROR names a mirror laid out as
# <base>/channel/<latest|beta> and <base>/v<version>/<release asset>.
#
# Native Windows is best effort for PanCode; Linux, macOS and WSL are the
# primary platforms.
#
# Everything runs inside Install-Pancode, called on the last line, so a
# truncated download fails to parse and runs nothing.
[CmdletBinding()]
param(
	[string]$Version = $env:PANCODE_VERSION,
	[string]$Channel = $(if ($env:PANCODE_CHANNEL) { $env:PANCODE_CHANNEL } else { "latest" }),
	[string]$Bundle = $env:PANCODE_BUNDLE,
	[string]$InstallDir = $env:PANCODE_INSTALL_DIR,
	[string]$BinDir = $env:PANCODE_BIN_DIR,
	[switch]$IncludeClaudeSdk,
	[switch]$AddToPath,
	[switch]$NoModifyPath,
	[switch]$NoAutoUpdate,
	[switch]$AutoUpdate,
	[switch]$Rollback,
	[switch]$LeavePrerelease,
	[switch]$NoPostInstall,
	[switch]$Force,
	[switch]$DryRun
)

function Install-Pancode {
	param($Options)
	$ErrorActionPreference = "Stop"
	$ProgressPreference = "SilentlyContinue"
	# Windows PowerShell 5.1 defaults to TLS 1.0, which GitHub refuses.
	[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

	$PackageName = "@akougkas/pancode"
	$LauncherMark = "# pancode-installer launcher"
	$mirror = if ($env:PANCODE_RELEASE_MIRROR) { $env:PANCODE_RELEASE_MIRROR.TrimEnd("/") } else { "" }
	$ReleaseBase = if ($mirror) { $mirror } else { "https://github.com/akougkas/pancode/releases/download" }
	$ChannelBase = if ($mirror) { "$mirror/channel" } else { "https://pancode.dev/channel" }

	function Say([string]$Text) { Write-Host "[install] $Text" }
	function Ok([string]$Text) { Write-Host "[install] ok: $Text" }
	function Warn([string]$Text) { Write-Warning $Text }
	function Fail([string]$Text) { throw "[install] error: $Text" }

	# file:// URLs are copied, so an airgapped mirror on a shared filesystem needs no web server.
	function Get-File([string]$Url, [string]$Out) {
		if ($Url.StartsWith("file://")) {
			$local = ([uri]$Url).LocalPath
			if (-not (Test-Path -LiteralPath $local)) { throw [IO.FileNotFoundException]::new("not found", $local) }
			Copy-Item -LiteralPath $local -Destination $Out
			return
		}
		Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile $Out
	}
	# Why a download failed: "not found" when the server or mirror has no such file (HTTP 404), else the reason
	# the downloader gave, as install.sh reports it.
	function Get-DownloadFailure($Record) {
		$e = $Record.Exception
		$code = 0
		try { if ($e.Response) { $code = [int]$e.Response.StatusCode } } catch { $code = 0 }
		if ($code -eq 404 -or $e -is [IO.FileNotFoundException]) { return "not found" }
		return ([string]$e.Message).Trim()
	}

	if ($Options.Channel -notin @("latest", "beta")) { Fail "-Channel must be latest or beta, got '$($Options.Channel)'" }
	$spec = $Options.Channel
	if ($Options.Version) {
		$v = $Options.Version -replace "^v(?=\d)", ""
		if ($v -notmatch "^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$" -and $v -notin @("latest", "beta")) {
			Fail "invalid -Version '$($Options.Version)'; use an exact version such as 0.9.0, or latest or beta"
		}
		$spec = $v
	}

	if ($spec -in @("latest", "beta")) { $Options.Channel = $spec }
	if ($Options.LeavePrerelease -and $spec -ne "latest") { Fail "-LeavePrerelease only moves to the latest channel, not $spec" }

	$arch = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
	$build = switch ($arch) {
		"AMD64" { "win-x64" }
		"ARM64" { "win-arm64" }
		default { Fail "unsupported CPU '$arch'; Node.js ships win-x64 and win-arm64" }
	}
	$installRoot = if ($Options.InstallDir) { $Options.InstallDir } elseif ($env:PANCODE_HOME) { Join-Path $env:PANCODE_HOME "install" } else { Join-Path $env:LOCALAPPDATA "pancode\install" }
	$binDir = if ($Options.BinDir) { $Options.BinDir } else { Join-Path $env:USERPROFILE ".local\bin" }
	# Resolve against the PowerShell location: [IO.Path]::GetFullPath uses the
	# process directory, which `cd` in an interactive session does not move.
	function Get-AbsolutePath([string]$Path) { $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Path) }
	$installRoot = Get-AbsolutePath $installRoot
	$binDir = Get-AbsolutePath $binDir
	if (($installRoot + $binDir) -match '[%\r\n"]') { Fail "Windows installer paths cannot contain percent, newline or quote characters" }
	# The helper is given the .cmd path, the launcher where no native exe is built, and installs pancode.exe beside it.
	$launcher = Join-Path $binDir "pancode.cmd"
	$exeLauncher = Join-Path $binDir "pancode.exe"
	$exeLaunchFile = Join-Path $binDir "pancode.launch"
	$bundleSource = if ($Options.Bundle) { Get-AbsolutePath $Options.Bundle } else { "PanCode $spec for $build from $ReleaseBase" }
	if ($Options.Bundle -and -not (Test-Path -LiteralPath $bundleSource)) { Fail "-Bundle $bundleSource does not exist" }

	Say "platform:     Windows $build (PowerShell $($PSVersionTable.PSVersion))"
	Say "bundle:       $bundleSource"
	Say "install root: $installRoot"
	Say "launcher:     $exeLauncher"

	if ((Test-Path -LiteralPath $launcher) -and -not ((Get-Content -LiteralPath $launcher -Raw) -match [regex]::Escape($LauncherMark)) -and -not $Options.Force) {
		Fail "refusing to overwrite $launcher, which this installer did not write; move it aside, choose another -BinDir, or pass -Force"
	}
	function Test-OwnedExeLauncher {
		(Test-Path -LiteralPath $exeLaunchFile) -and ((Get-Content -LiteralPath $exeLaunchFile -Raw) -match [regex]::Escape("launch `"$installRoot`""))
	}
	if ((Test-Path -LiteralPath $exeLauncher) -and -not (Test-OwnedExeLauncher) -and -not $Options.Force) {
		Fail "refusing to overwrite $exeLauncher, which this installer did not write for $installRoot; move it aside, choose another -BinDir, or pass -Force"
	}
	if ($Options.DryRun) {
		if ($Options.Rollback) {
			Say "would point $launcher back at the previous version recorded in $installRoot\install.json"
			Ok "dry run complete; nothing was changed"
			return
		}
		Say "would unpack the bundle into $installRoot\versions\<version>"
		Say "would then install the pinned herdr that hosts PanCode's terminal panes: pancode tools install herdr"
		Ok "dry run complete; nothing was downloaded or changed"
		return
	}

	$manifestFile = Join-Path $installRoot "install.json"
	if ($Options.Rollback -and -not (Test-Path -LiteralPath $manifestFile)) { Fail "no installer manifest at $manifestFile; nothing to roll back" }
	# The topmost directories this run creates; a run that ends with no installation removes them again.
	function Get-CreatedTop([string]$Path) {
		$top = $null
		while ($Path -and -not (Test-Path -LiteralPath $Path)) { $top = $Path; $Path = Split-Path -Parent $Path }
		$top
	}
	$createdRootTop = Get-CreatedTop $installRoot
	$createdBinTop = Get-CreatedTop $binDir
	$createdOwner = $false
	$createdVersions = $false
	New-Item -ItemType Directory -Force -Path $installRoot | Out-Null
	$lock = Join-Path $installRoot ".install-lock"
	# A killed installer skips the finally block and leaves the lock and its
	# staging prefix behind (#436). Reclaim only a lock this computer wrote
	# whose pid is gone and whose age exceeds 10 minutes; a foreign or
	# unlabelled owner is never adjudicated. Ownership moves by renaming the
	# owner's pid file, so exactly one reclaimer wins and the lock directory
	# never disappears for a concurrent run to slip in.
	$lockPid = Join-Path $lock "pid"
	$lockHost = Join-Path $lock "host"
	$thisHost = [string]$env:COMPUTERNAME
	try { New-Item -ItemType Directory -Path $lock -ErrorAction Stop | Out-Null }
	catch {
		$ownerPid = ([string](Get-Content -LiteralPath $lockPid -Raw -ErrorAction SilentlyContinue)).Trim()
		$ownerHost = ([string](Get-Content -LiteralPath $lockHost -Raw -ErrorAction SilentlyContinue)).Trim()
		$parsed = 0
		$reclaimed = $false
		if ($ownerHost -and $ownerHost -eq $thisHost -and [int]::TryParse($ownerPid, [ref]$parsed) -and
			-not (Get-Process -Id $parsed -ErrorAction SilentlyContinue) -and
			((Get-Date) - (Get-Item -LiteralPath $lock).LastWriteTime).TotalMinutes -gt 10) {
			$claim = "$lockPid.reclaim.$PID"
			try {
				Move-Item -LiteralPath $lockPid -Destination $claim -ErrorAction Stop
				if (([string](Get-Content -LiteralPath $claim -Raw)).Trim() -eq $ownerPid) {
					Remove-Item -LiteralPath $claim -Force
					Remove-Item -LiteralPath (Join-Path $installRoot "versions\.staging-$ownerPid") -Recurse -Force -ErrorAction SilentlyContinue
					Warn "reclaimed stale installation lock $lock (pid $ownerPid on $ownerHost)"
					$reclaimed = $true
				} else {
					# A slower reclaimer took the winner's fresh pid file; hand it back.
					Move-Item -LiteralPath $claim -Destination $lockPid -ErrorAction SilentlyContinue
				}
			} catch {
				# Another reclaimer renamed the pid file first; this run stands down as locked.
			}
		}
		if (-not $reclaimed) {
			$who = if ($ownerHost) { $ownerHost } else { "an unrecorded host" }
			# Exit 75 (EX_TEMPFAIL), not 1: a held lock is another run or a recent
			# crash, so a background update retries later instead of recording a failure.
			[Console]::Error.WriteLine("[install] error: installation locked at $lock by pid $ownerPid on $who. If that process has exited, remove only that lock directory and retry.")
			exit 75
		}
	}
	[IO.File]::WriteAllText($lockHost, $thisHost)
	[IO.File]::WriteAllText($lockPid, [string]$PID)
	(Get-Item -LiteralPath $lock).LastWriteTime = Get-Date
	$work = $null
	try {
	if ($Options.Rollback) {
		$old = Get-Content -LiteralPath $manifestFile -Raw | ConvertFrom-Json
		$helper = Join-Path $old.current "lib\node_modules\pancode\scripts\native-install.cjs"
		& $old.node $helper rollback $installRoot
		if ($LASTEXITCODE -ne 0) { Fail "rollback failed; active install preserved" }
		return
	}
	$owner = Join-Path $installRoot ".installer-owner"
	if (-not (Test-Path -LiteralPath (Join-Path $installRoot "install.json")) -and -not (Test-Path -LiteralPath $owner)) {
		if (Test-Path -LiteralPath (Join-Path $installRoot "versions")) { Fail "refusing to claim an existing versions directory without installer ownership" }
	}
	if ((Test-Path -LiteralPath $manifestFile) -and [int](Get-Content -LiteralPath $manifestFile -Raw | ConvertFrom-Json).schema -ne 3) {
		Fail "$installRoot holds an installation this installer cannot read. Remove that directory (your settings and sessions live elsewhere and stay), or choose another -InstallDir, then rerun."
	}
	$createdOwner = -not (Test-Path -LiteralPath $owner)
	[IO.File]::WriteAllText($owner, "pancode-installer")
	$createdVersions = -not (Test-Path -LiteralPath (Join-Path $installRoot "versions"))
	New-Item -ItemType Directory -Force -Path (Join-Path $installRoot "versions"), $binDir | Out-Null
	$work = Join-Path $installRoot (".work." + [guid]::NewGuid().ToString("N").Substring(0, 8))
	New-Item -ItemType Directory -Force -Path $work | Out-Null
		$tar = Join-Path $env:SystemRoot "System32\tar.exe"
		if (-not (Test-Path -LiteralPath $tar)) { Fail "tar.exe was not found in $env:SystemRoot\System32; PanCode's installer needs Windows 10 1803 or later" }
		# Retain every installed version while old sessions may still use it.
		$manifestPath = Join-Path $installRoot "install.json"
		$old = if (Test-Path -LiteralPath $manifestPath) { Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json } else { $null }
		$previous = if ($old -and $old.current -and (Test-Path -LiteralPath $old.current)) { $old.current } else { "" }
		if ($Options.Bundle) {
			$bundleFile = $bundleSource
		} else {
			$resolved = $spec
			if ($spec -in @("latest", "beta")) {
				$channelFile = Join-Path $work "channel"
				try { Get-File "$ChannelBase/$spec" $channelFile } catch { Fail "could not read $ChannelBase/$spec ($(Get-DownloadFailure $_)); check the network or proxy (HTTPS_PROXY), pass -Version <exact version>, or set PANCODE_RELEASE_MIRROR" }
				$resolved = ([string](Get-Content -LiteralPath $channelFile -TotalCount 1)).Trim()
				if ($resolved -notmatch "^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$") { Fail "$ChannelBase/$spec does not name a version" }
				if ($previous) {
					$activeVersion = $null
					try { $activeVersion = [string](Get-Content -LiteralPath (Join-Path $previous "lib\node_modules\pancode\package.json") -Raw | ConvertFrom-Json).version } catch { $activeVersion = $null }
					if ($activeVersion) {
						# The active install's own Node and npm's SemVer decide: "older", or "prerelease" when a
						# stable release is older than an active pre-release.
						$downgrade = & (Join-Path $previous "node.exe") -e 'const s=require(process.argv[1]),r=process.argv[2],a=process.argv[3];process.stdout.write(s.valid(a)&&s.lt(r,a)?(s.prerelease(a)&&!s.prerelease(r)?"prerelease":"older"):"")' (Join-Path $previous "node_modules\npm\node_modules\semver") $resolved $activeVersion
						if ($LASTEXITCODE -ne 0) { $downgrade = "" }
						# Only an explicit request (`pancode upgrade --channel latest` passes -LeavePrerelease)
						# moves down; a recorded channel never does.
						if ($downgrade -eq "prerelease" -and $spec -eq "latest") {
							if (-not $Options.LeavePrerelease) { Fail "the $spec channel resolved to $resolved, older than the active $activeVersion; the installation was left unchanged. To leave the pre-release for stable $resolved, pass -LeavePrerelease; to return to the previous install, use -Rollback." }
							Say "leaving the pre-release $activeVersion for stable $resolved"
						} elseif ($downgrade) { Fail "the $spec channel resolved to $resolved, older than the active $activeVersion; the installation was left unchanged. To install $resolved, pass -Version $resolved; to return to the previous install, use -Rollback." }
					}
				}
				Say "resolved $spec to $resolved"
			}
			$asset = "pancode-$resolved-$build.tar.gz"
			$sums = Join-Path $work "SHA256SUMS"
			try { Get-File "$ReleaseBase/v$resolved/SHA256SUMS" $sums } catch {
				$why = Get-DownloadFailure $_
				# A missing release is an answer, not a network fault.
				if ($why -eq "not found") {
					$hint = if ($spec -eq $resolved) { "; check the version, or leave out -Version to install the latest release" } else { "" }
					Fail "PanCode $resolved is not published at $ReleaseBase (it has no v$resolved/SHA256SUMS)$hint"
				}
				Fail "could not read $ReleaseBase/v$resolved/SHA256SUMS ($why); check the network or proxy (HTTPS_PROXY)"
			}
			$expected = (Get-Content -LiteralPath $sums | Where-Object { $_ -match "^([0-9a-f]{64})\s+\*?$([regex]::Escape($asset))$" } | Select-Object -First 1) -replace "\s.*$", ""
			if (-not $expected) { Fail "PanCode $resolved ships no $build bundle" }
			$bundleFile = Join-Path $work $asset
			Say "downloading $asset"
			try { Get-File "$ReleaseBase/v$resolved/$asset" $bundleFile } catch { Fail "could not download $ReleaseBase/v$resolved/$asset ($(Get-DownloadFailure $_))" }
			$actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $bundleFile).Hash.ToLowerInvariant()
			if ($actual -ne $expected) { Fail "$asset has SHA-256 $actual, but the release lists $expected; nothing was installed" }
			Ok "verified $asset (sha256 $expected)"
		}
		# Each version prefix records the digest of the bundle it came from, so reinstalling that bundle
		# activates the prefix again instead of unpacking a second copy beside it.
		$bundleDigest = (Get-FileHash -Algorithm SHA256 -LiteralPath $bundleFile).Hash.ToLowerInvariant()
		$final = $null
		$bundlePackage = $null
		foreach ($kept in Get-ChildItem -LiteralPath (Join-Path $installRoot "versions") -Directory) {
			$dir = $kept.FullName
			# A copy that cannot be read, run or matched to this archive is a miss, and the bundle unpacks beside it.
			try {
				$receipt = Join-Path $dir ".pancode-bundle-sha256"
				if ($kept.Name.StartsWith(".") -or -not (Test-Path -LiteralPath $receipt) -or ([string](Get-Content -LiteralPath $receipt -TotalCount 1)).Trim() -ne $bundleDigest) { continue }
				if ((Test-Path -LiteralPath (Join-Path $dir ".pancode-refused-candidate")) -or
					-not (Test-Path -LiteralPath (Join-Path $dir "node.exe")) -or
					-not (Test-Path -LiteralPath (Join-Path $dir "lib\node_modules\pancode\dist\cli\index.js")) -or
					-not (Test-Path -LiteralPath (Join-Path $dir "lib\node_modules\pancode\scripts\native-install.cjs"))) { continue }
				if (-not $bundlePackage) { $bundlePackage = ((& $tar -xzOf $bundleFile "./lib/node_modules/pancode/package.json") -join "`n") | ConvertFrom-Json }
				$keptVersion = & (Join-Path $dir "node.exe") -e 'try{const p=require(process.argv[1]);if(p.name!==process.argv[2])process.exit(1);process.stdout.write(p.version)}catch{process.exit(1)}' (Join-Path $dir "lib\node_modules\pancode\package.json") $PackageName
				if ($LASTEXITCODE -ne 0 -or $bundlePackage.name -ne $PackageName -or [string]$keptVersion -ne [string]$bundlePackage.version) { continue }
				# The bundle's helper runs the check activation runs; a copy that fails it is left as it is.
				$null = & (Join-Path $dir "node.exe") (Join-Path $dir "lib\node_modules\pancode\scripts\native-install.cjs") probe $dir
				if ($LASTEXITCODE -ne 0) { continue }
			} catch { continue }
			$final = $dir
			$pkg = [pscustomobject]@{ version = [string]$keptVersion }
			break
		}
		$reused = [bool]$final
		if ($reused) {
			Say "this bundle is already unpacked at versions\$(Split-Path -Leaf $final); using it"
		} else {
			$staging = Join-Path $installRoot "versions\.staging-$PID"
			New-Item -ItemType Directory -Force -Path $staging | Out-Null
			& $tar -xzf $bundleFile -C $staging
			if ($LASTEXITCODE -ne 0) { Fail "could not unpack $bundleFile under $installRoot (a full disk, or not a PanCode bundle)" }
			$pkgJson = Join-Path $staging "lib\node_modules\pancode\package.json"
			if (-not (Test-Path -LiteralPath (Join-Path $staging "node.exe")) -or -not (Test-Path -LiteralPath $pkgJson)) { Fail "$bundleFile is not a PanCode bundle for Windows" }
			$ran = & (Join-Path $staging "node.exe") -e "process.stdout.write(process.versions.node)"
			if ($LASTEXITCODE -ne 0 -or -not $ran) { Fail "the bundled Node in $bundleFile does not run" }
			Ok "Node v$ran runs ($build)"
			$pkg = Get-Content -LiteralPath $pkgJson -Raw | ConvertFrom-Json
			if ($pkg.name -ne $PackageName) { Fail "$bundleFile does not hold the $PackageName package" }
			$final = Join-Path $installRoot "versions\$($pkg.version)"
			if (Test-Path -LiteralPath $final) { $final = "$final-$(Get-Date -Format yyyyMMddHHmmss)-$PID" }
			Move-Item -LiteralPath $staging -Destination $final
			Set-Content -LiteralPath (Join-Path $final ".pancode-bundle-sha256") -Value $bundleDigest
		}
		$node = Join-Path $final "node.exe"
		$entry = Join-Path $final "lib\node_modules\pancode\dist\cli\index.js"
		if ($Options.IncludeClaudeSdk) {
			& $node $entry tools install claude-sdk
			if ($LASTEXITCODE -ne 0) { Fail "Claude SDK provisioning failed; previous launcher remains active." }
		}
		Ok "installed PanCode $($pkg.version)"

		$helper = Join-Path $final "lib\node_modules\pancode\scripts\native-install.cjs"
		if (-not (Test-Path -LiteralPath $helper)) { Fail "candidate lacks lifecycle helper; previous install remains active. Run: pancode doctor --fix" }
		$pin = if ($Options.Bundle -or $Options.Version -match "^v?\d+\.\d+\.\d+") { [string]$pkg.version } else { "-" }
		$auto = if ($Options.NoAutoUpdate -or $env:PANCODE_AUTO_UPDATE -eq "0") { "0" } elseif ($env:PANCODE_AUTO_UPDATE -eq "1") { "1" } else { "preserve" }
		if ($Options.AutoUpdate) { $auto = "1" }
		$post = if ($Options.NoPostInstall) { "0" } else { "1" }
		$pinSource = if ($Options.Bundle) { "bundle-file" } else { "version-flag" }
		& $node $helper activate $installRoot $final $launcher $Options.Channel $pin $auto $post $pinSource $(if ($Options.Force) { "1" } else { "0" })
		# The pancode on PATH is still the previous version, and a version that predates a repair reports nothing to fix.
		# A reused prefix may be the active or previous version, which this run did not bring.
		if ($LASTEXITCODE -ne 0 -and -not $reused) { New-Item -ItemType File -Force -Path (Join-Path $final ".pancode-refused-candidate") | Out-Null }
		if ($LASTEXITCODE -ne 0) {
			$activeVersion = $null
			if ($previous) {
				try { $activeVersion = (Get-Content -LiteralPath (Join-Path $previous "lib\node_modules\pancode\package.json") -Raw | ConvertFrom-Json).version } catch { $activeVersion = $null }
			}
			# An older version rejects keys a newer one wrote, and its own doctor --fix exits 1 and changes nothing.
			if ($activeVersion -and [version](($pkg.version -split '-')[0]) -lt [version](($activeVersion -split '-')[0])) {
				Fail "candidate checks failed; previous install remains active. PanCode $($pkg.version) is older than the active $activeVersion, and doctor --fix cannot make it read settings a newer version wrote, whatever the lines above advise. To use $($pkg.version), remove the keys named above from settings.yaml, then rerun this installer."
			}
			$repair = "& '" + $node.Replace("'", "''") + "' '" + $entry.Replace("'", "''") + "' doctor --fix"
			Fail "candidate checks failed; previous install remains active. Repair with the new version itself, then rerun this installer: $repair"
		}
		if (-not $Options.NoPostInstall) {
			& $node $entry upgrade --post-install
			if ($LASTEXITCODE -ne 0) { Fail "PanCode is installed, but local initialization needs attention. Run pancode upgrade --post-install; the previous version remains available with: pancode upgrade --rollback" }
		}
		# When the candidate's helper installed pancode.cmd as the launcher, an exe left beside it would run first.
		$activeLauncher = ""
		try { $activeLauncher = [string](Get-Content -LiteralPath $manifestFile -Raw | ConvertFrom-Json).launcher } catch { $activeLauncher = "" }
		if ($activeLauncher -ne $exeLauncher -and (Test-Path -LiteralPath $exeLauncher) -and (Test-OwnedExeLauncher)) {
			$aside = "$exeLauncher.$([guid]::NewGuid()).old"
			Move-Item -LiteralPath $exeLauncher -Destination $aside
			Remove-Item -LiteralPath $aside, $exeLaunchFile -Force -ErrorAction SilentlyContinue
		}
		if ($activeLauncher) { $launcher = $activeLauncher }
		$reported = & $node $entry --version
		if ($LASTEXITCODE -ne 0) { Fail "active CLI failed version check" }
		Ok "$reported"

		# PanCode hosts its terminal panes in a private copy of herdr, pinned by sha256 and fetched from
		# herdr's releases or PANCODE_TOOLCHAIN_MIRROR. It is part of the install, but never fails it:
		# PanCode runs in the plain terminal, says so once, and never downloads on first launch.
		$panes = $null
		$savedPreference = $ErrorActionPreference
		$ErrorActionPreference = "Continue"
		try { $panes = (& $node $entry tools install herdr --json 2>$null | Out-String) | ConvertFrom-Json } catch { $panes = $null } finally { $ErrorActionPreference = $savedPreference }
		if ($panes -and $panes.ok) {
			Ok "terminal panes ready (powered by herdr $($panes.version), Apache-2.0)"
		} else {
			$why = if ($panes -and $panes.message) { $panes.message } else { "the pane host could not be installed" }
			Warn "terminal panes are not set up yet: $why. PanCode runs in the plain terminal until you run: pancode panes install"
		}

		# Read and write the raw registry value: [Environment]::SetEnvironmentVariable
		# would store it as REG_SZ and stop %USERPROFILE%-style entries expanding.
		$modifyPath = -not $Options.NoModifyPath -and ($Options.AddToPath -or $env:PANCODE_MODIFY_PATH -ne "0")
		function Path-Contains([string]$Path, [string]$Directory) {
			$entries = @([Environment]::ExpandEnvironmentVariables($Path) -split ";" | ForEach-Object { $_.Trim().Trim('"').TrimEnd("\") })
			return $entries -contains $Directory.TrimEnd("\")
		}
		$envKey = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey("Environment", [bool]$modifyPath)
		try {
			$rawPath = if ($envKey) { [string]$envKey.GetValue("Path", "", [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) } else { "" }
			$onPath = Path-Contains $rawPath $binDir
			if (-not $onPath -and $modifyPath) {
				if (-not $envKey) { $envKey = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey("Environment") }
				$kind = if ($envKey.GetValueNames() -contains "Path") { $envKey.GetValueKind("Path") } else { [Microsoft.Win32.RegistryValueKind]::ExpandString }
				$envKey.SetValue("Path", ((@($rawPath.TrimEnd(";"), $binDir) | Where-Object { $_ }) -join ";"), $kind)
				& $node $helper path-added $installRoot $binDir
				if ($LASTEXITCODE -ne 0) { Fail "PATH was added but ownership receipt could not be written; review $manifestPath" }
				# Setting any user variable broadcasts WM_SETTINGCHANGE so new terminals see the change.
				[Environment]::SetEnvironmentVariable("PANCODE_PATH_REFRESH", $null, "User")
				Ok "added $binDir to your user PATH"
			}
			# A terminal opened before an earlier install still has a stale process PATH.
			if ($modifyPath -and -not (Path-Contains $env:Path $binDir)) { $env:Path = "$binDir;$env:Path" }
		} finally {
			if ($envKey) { $envKey.Dispose() }
		}
		$run = if (-not $InvokedAsFile -and (Path-Contains $env:Path $binDir)) { "pancode" } else { "& '" + $launcher.Replace("'", "''") + "'" }
		if (-not $modifyPath -and -not (Path-Contains $env:Path $binDir)) {
			Say "PATH changes disabled; use the launcher commands below."
		}
		# The installed binary computes the next step for this home: found keys and servers, or the route in use.
		$next = $null
		$savedPreference = $ErrorActionPreference
		$ErrorActionPreference = "Continue"
		try { $next = & $node $entry setup --next 2>$null; if ($LASTEXITCODE -ne 0) { $next = $null } } catch { $next = $null } finally { $ErrorActionPreference = $savedPreference }
		if ($next) { $next | ForEach-Object { Write-Host $_ } } else { Write-Host "Run: $run" }
		# The background service is a separate step: `pancode gui background install` adds the logon task.
		Write-Host "Desktop app: $run gui"
		# Last, so the command a user copies from the bottom is one that runs as printed.
		if (-not (Path-Contains $env:Path $binDir)) { Write-Host "$binDir is not on this terminal's PATH. Until it is, run: $run" }
	} finally {
		# Stopping this script (Ctrl+C, a quitting session) leaves tar or a
		# candidate check running and writing into staging; end the whole
		# tree before the lock and staging go (#436).
		Get-CimInstance Win32_Process -Filter "ParentProcessId=$PID" -ErrorAction SilentlyContinue |
			ForEach-Object { & taskkill.exe /T /F /PID $_.ProcessId 2>$null | Out-Null }
		if ($work) { Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue }
		Remove-Item -LiteralPath (Join-Path $installRoot "versions\.staging-$PID") -Recurse -Force -ErrorAction SilentlyContinue
		# A run that ends with no installation takes back only what it created, while it still holds the lock; a
		# directory that holds anything stays, so an existing root or a kept version is left as it was.
		function Remove-IfEmpty([string]$Path) {
			if ((Test-Path -LiteralPath $Path) -and -not (Get-ChildItem -LiteralPath $Path -Force -ErrorAction SilentlyContinue)) {
				Remove-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
				return -not (Test-Path -LiteralPath $Path)
			}
			$false
		}
		function Remove-CreatedChain([string]$Path, [string]$Top) {
			while ($Top -and (Remove-IfEmpty $Path) -and $Path -ne $Top) { $Path = Split-Path -Parent $Path }
		}
		$unclaimed = -not (Test-Path -LiteralPath (Join-Path $installRoot "install.json"))
		if ($unclaimed) {
			if ($createdVersions) { Remove-IfEmpty (Join-Path $installRoot "versions") | Out-Null }
			if ($createdOwner) { Remove-Item -LiteralPath (Join-Path $installRoot ".installer-owner") -Force -ErrorAction SilentlyContinue }
		}
		Remove-Item -LiteralPath $lock -Recurse -Force -ErrorAction SilentlyContinue
		if ($unclaimed) {
			Remove-CreatedChain $installRoot $createdRootTop
			Remove-CreatedChain $binDir $createdBinTop
		}
	}
}

# Set only when PowerShell runs this file with -File; `irm | iex` and a script block leave it empty.
$InvokedAsFile = [bool]$MyInvocation.MyCommand.Path
try {
	Install-Pancode -Options ([pscustomobject]@{
		Version = $Version; Channel = $Channel; Bundle = $Bundle
		InstallDir = $InstallDir; BinDir = $BinDir; IncludeClaudeSdk = [bool]$IncludeClaudeSdk; AddToPath = [bool]$AddToPath
		NoModifyPath = [bool]$NoModifyPath; NoAutoUpdate = [bool]$NoAutoUpdate; AutoUpdate = [bool]$AutoUpdate; Rollback = [bool]$Rollback
		LeavePrerelease = [bool]$LeavePrerelease; NoPostInstall = [bool]$NoPostInstall; Force = [bool]$Force; DryRun = [bool]$DryRun
	})
} catch {
	# An installer refusal is one line with its fix, as on Linux; anything else keeps its position for a bug report.
	$message = $_.Exception.Message
	if (-not $message.StartsWith("[install] error:")) { $message = "[install] error: $message`n$($_.InvocationInfo.PositionMessage)" }
	[Console]::Error.WriteLine($message)
	# A file run reports failure through its exit code; under `irm | iex`, exit would close the caller's shell.
	if ($InvokedAsFile) { exit 1 }
}
