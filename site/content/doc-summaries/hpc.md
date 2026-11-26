## Install without root

The installer downloads one bundle that holds PanCode, the Node.js it runs on and every dependency, so you do not need `module load nodejs`, a system Node or a package registry. It never uses `sudo` and refuses to run under it.

```sh
curl -fsSL https://pancode.dev/install.sh | sh
export PATH="$HOME/.local/bin:$PATH"
pancode doctor
```

It needs `curl` or `wget`, `tar`, `gzip` and a SHA-256 tool. The installed versions go under `~/.local/share/pancode-install` and the launcher under `~/.local/bin`. Compute nodes that mount the same home directory run the same launcher.

## Work on the cluster

Ask for scheduler work in words, such as "submit job.sh and tell me when it starts". `sbatch`, `squeue` and the other Slurm, PBS, LSF and Flux clients run outside the sandbox with the same review as `ssh`: the safety judge decides first and asks you when it has no verdict, so name the action you want. Run them directly, not from a wrapper script, which stays inside the sandbox and fails.

Shell commands write to the project and temp folders without asking. Add scratch space with an absolute path:

```yaml
safety:
  scratchRoots: [/scratch/alice]
```

Keep results out of Git with `pancode store put results run-042.h5`; every checkout of the project on this host sees them.

## Old glibc, proxies, and quotas

The installer picks the bundle for the host. There are bundles for Linux on x64 and arm64 with glibc 2.28 or newer, for x64 hosts with glibc 2.17 to 2.27, the RHEL and CentOS 7 class, for Alpine on x64 and arm64, and for macOS. Linux arm64 with an older glibc has no bundle; use conda-forge Node and npm instead. `PANCODE_TARGET` forces a bundle when detection is wrong.

Export `https_proxy` before running the installer behind a proxy. An installed version takes about 330 MB, and the Claude Agent SDK, installed only with `--include-claude-sdk`, adds about 224 MB. The installer refuses to start with under about 488 MB free at the install root. On a small home quota, move the install root:

```sh
curl -fsSL https://pancode.dev/install.sh | sh -s -- --install-dir /project/$USER/pancode
```

## Verified downloads

The installer compares the bundle's SHA-256 with the release's `SHA256SUMS`, and a mismatch stops the install. Every release file also has a GitHub build attestation, which `gh attestation verify <file> --repo PanStudio/pancode` checks on a machine with the GitHub CLI.

## Airgapped sites and your own Node

With no route out, download the bundle for the cluster and `install.sh` from the GitHub release on a connected machine, copy both over, and run `sh install.sh --bundle pancode-<version>-<target>.tar.gz`. Nothing else is fetched. A site that mirrors the releases sets `PANCODE_RELEASE_MIRROR` to the mirror's base URL, which can be a `file://` URL on a shared filesystem.

If the site already provides Node 22.19 or newer, you can install with its npm instead: `npm install -g @panstudio/pancode`. When an older `node` comes first on `PATH`, set `PANCODE_NODE` to the newer binary.

Pick versions with `--version` or `--channel`, and undo an upgrade with `--rollback`. The full guide covers the mirror layout; `sh install.sh --help` lists every option.
