#!/usr/bin/env python3
# SPDX-License-Identifier: LicenseRef-PanCode-1.0
# SPDX-FileCopyrightText: 2026 Anthony Kougkas
"""Generate an explicit public documentation snapshot from the repository."""
import argparse
import hashlib
import json
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

SITE = Path(__file__).resolve().parent
ROOT = SITE.parent
CONTENT = SITE / "content"
DEST = CONTENT / "docs"
INDEX = CONTENT / "index.json"
MANIFEST = CONTENT / "docs-manifest.json"


def git(*args):
    return subprocess.check_output(["git", *args], cwd=ROOT, stderr=subprocess.PIPE)


def encoded(value):
    return (json.dumps(value, indent=2, ensure_ascii=False) + "\n").encode()


def later_prerelease(candidate, version):
    # Between releases a checkout carries the next version's pre-release
    # (0.9.1-rc.1, 0.9.1-dev) while the site stays on the last stable release,
    # which scripts/release-readiness.mjs requires.
    match = re.fullmatch(r"(\d+)\.(\d+)\.(\d+)-(?:rc|dev)(?:[.+].*)?", candidate)
    core = re.fullmatch(r"(\d+)\.(\d+)\.(\d+)", version)
    return bool(match and core) and tuple(map(int, match.groups())) > tuple(map(int, core.groups()))


def inputs(mode, ref=None):
    """Build a snapshot. "release" reads the tag v<version>, "repository" reads
    one commit, and "tree" reads the current files without recording a commit."""
    product = json.loads((SITE / "product.json").read_text())
    version = product["version"]
    tree = mode == "tree"
    if mode == "release" and ref != f"v{version}":
        raise ValueError(f"release snapshots require --source-ref v{version}")
    commit = None if tree else git("rev-parse", "--verify", f"{ref}^{{commit}}").decode().strip()
    catalog = json.loads((SITE / "public-docs.json").read_text())
    files, index, entries = {}, [], []
    for item in catalog:
        source, path = item["source"], item["path"]
        if not re.fullmatch(r"(?:docs/guide/[^/]+\.md|README\.md)", source) or ".." in Path(source).parts:
            raise ValueError(f"source is not a public user guide: {source}")
        if not path.endswith(".md") or ".." in Path(path).parts or path in files:
            raise ValueError(f"invalid or duplicate public path: {path}")
        raw = (ROOT / source).read_bytes() if tree else git("show", f"{commit}:{source}")
        text = raw.decode()
        intro = re.split(r"^## ", text, maxsplit=1, flags=re.M)[0]
        intro = re.sub(r"^# .*\n", "", intro, count=1).strip()
        # Introductory implementation pointers belong in the repository, while
        # actual setup instructions and usage examples must remain public.
        intro = "\n\n".join(block for block in intro.split("\n\n") if not (
            re.search(r"\.ts\)", block) and block.lstrip().startswith("`")
            or block.lstrip().startswith("The [TUI design contract]")
        ))
        if item.get("sections"):
            chunks = re.split(r"(?=^## )", text, flags=re.M)
            by_heading = {chunk.split("\n", 1)[0][3:].strip(): chunk for chunk in chunks if chunk.startswith("## ")}
            missing = set(item["sections"]) - by_heading.keys()
            if missing:
                raise ValueError(f"public section disappeared from {source}: {sorted(missing)}")
            text = "\n\n".join(([intro] if item.get("includeIntro") and intro else []) + [by_heading[heading].strip() for heading in item["sections"]])
        else:
            body = re.sub(r"\A[\s\S]*?(?=^## )", "", text, count=1, flags=re.M) if re.search(r"^## ", text, re.M) else ""
            text = f"{intro}\n\n{body}"
        if item.get("stripDetails"):
            text = re.sub(r"<details>[\s\S]*?</details>", "", text)
        # The website offers short, task-oriented guides. Their upstream source
        # remains pinned and hashed, while the site's authored summary is checked
        # alongside the generated HTML input and search index.
        summary = item.get("summary")
        if summary:
            if not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*\.md", summary):
                raise ValueError(f"invalid public summary: {summary}")
            text = (CONTENT / "doc-summaries" / summary).read_text()
        text = f"# {item['title']}\n\n{item['excerpt']}\n\n{text.strip()}\n"
        files[path] = text.encode()
        index.append({**item, "headings": re.findall(r"^#{2,3}\s+(.+)$", text, re.M)})
        entries.append({"path": path, "source": source, "sha256": hashlib.sha256(files[path]).hexdigest(), "sourceSha256": hashlib.sha256(raw).hexdigest()})
    if tree:
        repo_version = json.loads((ROOT / "package.json").read_text())["version"]
    else:
        repo_version = json.loads(git("show", f"{commit}:package.json"))["version"]
    # A development tree carries the upcoming version with a -dev suffix. Only a
    # release snapshot, taken at the tag, must match exactly. A tree snapshot
    # also previews a later pre-release.
    if repo_version != version and not (mode != "release" and repo_version == f"{version}-dev") and not (tree and later_prerelease(repo_version, version)):
        raise ValueError(f"repository version {repo_version} differs from site version {version}")
    # A tree snapshot names no commit: before the first release the history it
    # would name is not public, so its file hashes are the whole provenance.
    pin = {"ref": "main"} if tree else {"ref": commit if mode == "repository" else ref, "commit": commit}
    manifest = {
        "schema": 2, "corpus": "public-guides", "corpusPolicy": "site/public-docs.json",
        "source": {"version": version, **pin, "mode": mode}, "files": entries,
    }
    return files, encoded(index), encoded(manifest)


def check():
    manifest = json.loads(MANIFEST.read_text())
    source = manifest["source"]
    mode = source.get("mode")
    if mode not in ("release", "repository", "tree"):
        raise ValueError(f"unknown documentation snapshot mode: {mode}")
    published = json.loads((SITE / "product.json").read_text()).get("publishedVersion")
    if mode == "tree" and published:
        raise ValueError(f"a tree snapshot is valid only before the first release; product.json records v{published}, so pin with --snapshot-ref or --source-ref")
    files, index, expected = inputs(mode, source.get("ref"))
    actual = {p.relative_to(DEST).as_posix(): p.read_bytes() for p in DEST.rglob("*") if p.is_file()}
    errors = []
    for path in sorted(set(files) | set(actual)):
        if files.get(path) != actual.get(path):
            errors.append(f"documentation drift: {path}")
    if INDEX.read_bytes() != index:
        errors.append("documentation search index differs from the repository")
    if MANIFEST.read_bytes() != expected:
        errors.append("documentation source manifest differs from the repository")
    if errors:
        raise ValueError("\n".join(errors))
    print(f"Checked {len(files)} public guides against their declared repository source.")


def sync(mode, ref=None):
    files, index, manifest = inputs(mode, ref)
    CONTENT.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="docs-snapshot-", dir=CONTENT) as temp:
        staged = Path(temp) / "docs"
        for path, raw in files.items():
            target = staged / path
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(raw)
        if DEST.exists():
            shutil.rmtree(DEST)
        staged.rename(DEST)
    INDEX.write_bytes(index)
    MANIFEST.write_bytes(manifest)
    print(f"Generated {len(files)} public guides from {'the current tree' if mode == 'tree' else ref}.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--check", action="store_true")
    mode.add_argument("--worktree", action="store_true", help="read the current files; commit this snapshot only before the first release")
    mode.add_argument("--source-ref", help="read the release tag matching product.json")
    mode.add_argument("--snapshot-ref", help="pin public docs to an existing repository commit without creating a package release")
    args = parser.parse_args()
    try:
        if args.check:
            check()
        else:
            if args.worktree:
                sync("tree")
            else:
                sync("repository" if args.snapshot_ref else "release", args.snapshot_ref or args.source_ref)
    except (OSError, ValueError, KeyError, subprocess.CalledProcessError) as error:
        print(f"sync-docs: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
