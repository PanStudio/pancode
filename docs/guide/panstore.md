# PanStore

PanStore is PanCode's project store: it keeps files as blobs in named tags outside the working tree, with a record of who put each one, from where and with which hash.

The engine is `createLocalStoreBackend` in [local.ts](../../packages/store/src/local.ts), `createSharedStoreBackend` in the same file for a store in a folder several hosts mount ([Storing in a shared folder](#storing-in-a-shared-folder)), or `createS3StoreBackend` in [s3/backend.ts](../../packages/store/src/s3/backend.ts) for a store in an S3 bucket ([Storing in an S3 bucket](#storing-in-an-s3-bucket)), the commands are `runStoreCli` in [cli/index.ts](../../packages/store/src/cli/index.ts), `pancode store` hosts them in [store.ts](../../src/cli/store.ts), and the model's `store` tool is in [store-tool.ts](../../src/tools/store/store-tool.ts).

Its code is the private workspace package `@pancode/store`, bundled into PanCode. It reaches you three ways, all over the same files:

- `pancode store <command>` inside a PanCode project, with the roots, cache and placement from your settings.
- The model's `store` tool.
- The PanKit `store` MCP server ([PanKit](pankit.md)).

Every checkout and task worktree of one repository reaches the same store: the store is keyed by the main checkout's real path, so a task worktree and the checkout it came from share one project key. A project whose tracked settings set `store.projectId` is keyed by that id instead, so checkouts at different paths, on different hosts, reach one store ([Sharing a store across hosts](#sharing-a-store-across-hosts)).

## Commands

Each command below runs as `pancode store <command>`. Changing the backend does not move data. Switch back to the original settings to read the original store. To copy a blob between stores, `get` it to a file, switch settings, then `put` the file.

| Command | What it does |
| --- | --- |
| `tags` | List this project's tags with class, blob count, bytes and description, then the backend's facts and file system free space. |
| `ls <tag> [pattern]` | List blobs in a tag with size, modification time and whether a record exists. `pattern` is a regular expression matched against the whole name, at most 256 characters, with no backreferences and no quantified group that contains another quantifier (such as `(a+)+`). |
| `stat <tag>:<blob>` | Show the blob, its drift (`none`, `changed`, `missing` or `unrecorded`), its sha256, the producing run and who put it. |
| `history <tag>:<blob>` | Show every record of the blob in order. |
| `verify <tag> [pattern] [--hash-large] [--record-unrecorded]` | Compare each recorded blob's size and modification time with its record, and its sha256 when the record holds one. `--hash-large` also hashes blobs whose record omitted the hash and records the digest as a note. `--record-unrecorded` appends a put record, marked recovered, for each blob stored without one, from its bytes as they are now. Exits 1 unless every blob is ok or recorded. |
| `put <tag> <file> [--blob <name>] [--note <text>] [--link]` | Store a file and append its put record. Creates the tag (class `input`) when it does not exist. `--link` shares the file's blocks by a reflink where the file system supports it and copies otherwise; the output ends with `(copy)` when it copied. |
| `get <tag>:<blob> [--to <path>]` | Print the path of a read-only (0400) copy of the blob under the cache, or copy it to `--to`. Edits to that path never reach the stored blob. |
| `rm <tag>:<blob> --yes` | Delete one blob and append a remove record. Without `--yes` it deletes nothing, prints what it would delete and exits 0. |
| `rm-tag <tag> --yes` | Delete a tag. Without `--yes` it deletes nothing, prints what it would delete and exits 0. |
| `adopt [<projectKey>]` | Without a key, list store directories whose project root no longer exists and that carry no project id. With a key, move that store to this project; refuses when this project already has one. |
| `where` | Print the store root, project root, project id, project key, project directory, each root's id and the `pankit serve store` command line that serves this store over MCP from any directory. With a project id, it also names a store still left under the path key, which `adopt <key>` moves. |
| `usage [tag]` | Count blobs and bytes per tag and per root by walking the store, with each root's file system free space. |
| `locks` | List the project's store locks: each holder's key, pid, host and time, and its state (see [Locks](#locks)). |
| `locks break <id> --yes` | Remove a lock that is not `live`. Without `--yes` it removes nothing, prints what it would remove and exits 0. It never touches a blob or a record. |

Every command takes `--json`. Exit codes: 0 success; 1 operational failure (a missing tag or blob, a refused write) or `verify` not ok; 2 invalid usage.

A tag name holds letters, digits, `.`, `_`, `-` and `/`, up to 200 bytes, and no segment starts with `.`. A blob name holds printable ASCII other than `#` and `\`, up to 480 bytes. A tag's class is `input`, `output`, `cache` or `archive`.

`free` in `tags` and "file system free space" in `usage` are the free space of the file system each root is on, read with `statfs`. They are not a quota and other programs share them.

```sh
pancode store put results data.csv --note "first run"
pancode store get results:data.csv
pancode store where
```

`where` ends with the `pankit serve store` line that serves this project's store over MCP from any directory, so an MCP host on this machine can reach the store PanCode uses:

```text
store root   /home/me/.local/share/pancode/data/store
project root /home/me/src/sim
project id   (none)
project key  cb6fe116fff133e1
project dir  /home/me/.local/share/pancode/data/store/projects/cb6fe116fff133e1
root default  /home/me/.local/share/pancode/data/store  id 6f1c2a9e-5b7d-4e8a-9c3f-2d4b6a8e0f17
store server pankit serve store --root /home/me/.local/share/pancode/data/store --cache /home/me/.cache/pancode --project /home/me/src/sim
```

The line names no `--write-tag`, so that server only reads.

## Records and actors

Each blob has an append-only list of records: `put`, `note` and `remove`. A put record carries the bytes' sha256, size and modification time as the put computed them while streaming, never a later read of the blob's name, plus the source path, the producing run when PanCode knows it, and the actor. The hash is omitted above 64 MiB, as for other observed files; `verify --hash-large` hashes such a blob and records its digest as a note.

The actor says who wrote the record:

| Actor | Written by |
| --- | --- |
| `main` | The `store` tool in the main session. |
| `worker` | The `store` tool in a dispatched worker, with the dispatch run id. |
| `standalone` | Any `pancode store` command run from a shell, whoever runs it. |
| `extension` | An extension, with its id. |
| `mcp` | An MCP server writing through a store reference or the builtin `store` server, with the server id as the client. |

A put or remove holds the blob's lock across the change and its record, whether it comes from the CLI, the `store` tool or an MCP server, so no other writer's change lands between them, on this host or on another host sharing the root. A put that fails before the bytes commit changes nothing. A put whose bytes committed but whose record failed exits 1 and says so; the blob then shows drift `unrecorded`, and `verify <tag> --record-unrecorded` records it from the stored bytes. A crash between a remove's delete and its record leaves drift `missing` over the last put record.

## Locks

A writer holds one lock per blob, or per tag's metadata, in `locks/` of the project directory on the primary root. The lock file is written under a temporary name and linked into place, which is atomic on NFS as on a local file system, so a lock is never partial. It names its holder's key, pid, host, boot and time. `locks` reports each lock's state:

| State | Meaning |
| --- | --- |
| `live` | Held on this host by a process that is alive, since the last boot. |
| `dead` | Held on this host by a process that is gone, or before the host last booted. |
| `remote` | Held on another host. |
| `unreadable` | The lock file cannot be read, including a lock written by an older PanStore. |

A writer waits up to 30 seconds for a lock and takes it over only when the lock is `dead`. A shared or s3 store's locks are leases instead ([Storing in a shared folder](#storing-in-a-shared-folder), [Storing in an S3 bucket](#storing-in-an-s3-bucket)). On a local store locks never age out: a `remote` or `unreadable` lock stays until its holder releases it or an operator runs `locks break <id> --yes`, and the refused write names the holder and that command. `locks break` refuses a `live` lock. Check that a `remote` holder has really stopped before breaking its lock.

## Roots and placement

By default the store has one root, `store/` under the PanCode data directory. Projects live at `<root>/projects/<key>/`, with each tag at `tags/<tag>/`. Files are owner-only: 0600 files and 0700 directories. `pancode reset --data`, `reset --all` and `uninstall` without `--keep-data` remove the default root with the data directory, and nothing recovers it afterwards.

To add a second root, list both roots under `store.roots` in the user `settings.yaml`, then run `pancode store where` to confirm them. Three settings add roots and choose where a new tag goes. All three are read at startup (restart PanCode after a change) and are accepted only from the user settings layer; an invalid `store` section is refused as a whole.

| Setting | Default | Meaning |
| --- | --- | --- |
| `store.roots` | `[]` (one root under the data directory) | A list of `{ name, path, durable, purge }`. `path` is absolute, `durable` defaults to `true` and `purge` is free text or `null` describing the site's purge policy. The first root is the primary: it must be durable and holds every tag's records, the locks and `placement.json`. A root with `durable: false` takes only tags of class `cache`. |
| `store.placement.byTag` | `{}` | Tag name to root name, for a tag not yet created. |
| `store.placement.byClass` | `{}` | Tag class (`input`, `output`, `cache`, `archive`) to root name, for a tag not yet created. |

In the user `settings.yaml`:

```yaml
store:
  roots:
    - name: home
      path: /home/me/.local/share/pancode/data/store
    - name: scratch
      path: /scratch/me/pancode-store
      durable: false
      purge: files older than 30 days
  placement:
    byClass:
      cache: scratch
```

Each root gets an id the first time the store writes there: a random UUID in `<root>/root.json`. `where` prints each root's id, or `(none yet)`. Mount paths may differ between hosts; the id says two paths are the same root.

Placement is frozen when a tag is created: `placement.json` on the primary records the root each tag was created on, and changing the rules never moves a tag that exists. A tag placed on a root that is no longer in `store.roots` is unreachable until the root is added back; `pancode doctor` names such tags. With one root the store makes no extra reads for placement.

## Sharing a store across hosts

Two hosts reach one store when both mount the same roots and the project names itself. Set the id in the project's tracked `.pancode/settings.yaml`:

```yaml
store:
  projectId: sim
```

`store.projectId` is 1 to 64 characters of `a-z`, `0-9`, `.`, `_` and `-`, starting with a letter or digit. It is read only from the tracked project file, and only while you trust the project's settings, so an untrusted checkout cannot name another project's store; set in user settings or in the private local file it is ignored with a settings issue. The project key becomes the first 16 hex of the SHA-256 of `project-id:<id>`, so every checkout with that id reaches one project directory, whatever its path. A store already written under the path key stays where it is: `where` names it and `adopt <key>` moves it. The PanKit `store` server takes the id as `--project-id`, and `where` prints it in the `store server` line.

Each host lists the shared roots in its own `store.roots`; the mount paths may differ, since root ids match them. The primary must be shared as well, because it holds the records and the locks.

A dispatch that grants tags to a worker on an SSH fleet node needs `store.projectId`; without one it is refused at admission, naming the setting. With one, the dispatcher refuses a root that is on a file system local to its host, and sends the worker the project key, the id of each root involved (the primary and the roots holding the granted tags) and each tag's directory relative to its root. Before it runs, the worker checks every name against its own configuration: its checkout must have the same project key, each root id must match exactly one of its roots, and each tag must resolve to the same directory. The grant also names the dispatcher's `store.backend`, and the worker refuses it unless its own is the same, because a `local` and a `shared` host take over locks by different rules. The first mismatch refuses the grant, so a worker whose store is not the dispatcher's writes nothing.

## Storing in a shared folder

The store can live in one folder that several hosts mount, such as an NFS export, with locks every host can take over. Set it in each host's user `settings.yaml` and restart PanCode:

```yaml
store:
  backend: shared
  shared:
    root: /mnt/lab/pancode-store
```

With `shared`, `store.shared.root` is required (an absolute path; the mount path may differ between hosts) and `store.roots` and `store.placement` must be empty: the folder is the only root, laid out like a local root, and holds records, locks and every tag. The folder must exist; a host where it is missing refuses writes as `unavailable` instead of creating it locally, and `pancode doctor` shows it and its free space. Set `store.projectId` so checkouts at different paths reach one project directory ([Sharing a store across hosts](#sharing-a-store-across-hosts)). The backend reports `multiNode: true` and `sharedFs: true`.

Locks are leases. The holder links its lock file into place and renews it every 10 seconds. A lease is `dead` after 60 seconds without renewal by the file server's clock, measured with a probe file, or when its holder process is gone on this host. A writer waits up to 30 seconds and can take over a dead lease from any host. Renewal, release and breaking use the same turn file. An expired holder cannot renew. The writer checks its lease before publishing a change, but the check and the file operation are separate: after a stalled writer resumes, verify the affected tag. `locks` lists leases as `live`, `dead` or `unreadable`, and `locks break` refuses a live one.

Everything a local store does works on a shared one: `adopt`, `put --link`, the index, tag grants to a worker on an SSH node (whose host also sets `store.backend: shared`), store references and the PanKit `store` server, which PanCode launches with `--shared`.

## Storing in an S3 bucket

The store can live in one bucket of an S3-compatible object store (AWS S3, MinIO and others that accept conditional writes) instead of local roots. Set it in the user `settings.yaml` and restart PanCode:

```yaml
store:
  backend: s3
  s3:
    endpoint: http://127.0.0.1:9000
    region: us-east-1
    bucket: pancode
    prefix: lab/
    accessKeyId: pancode
    pathStyle: true
```

`store.backend` is `local` (the default), `shared` or `s3`; with `s3`, `store.s3` is required and `store.roots` and `store.placement` must be empty. `pathStyle: true` puts the bucket in the URL path, as MinIO and most self-hosted services need. Then store the secret key:

```bash
pancode store login     # prompts, or reads the key from stdin
pancode store logout    # removes it
```

`login` lists the bucket with the key before it keeps it in PanCode's credential store, so a wrong key or bucket is refused and nothing is stored. `pancode doctor` shows the bucket and whether a key is stored. The bucket's objects are `<prefix>projects/<key>/` per project, laid out like a local root, so hosts that use one bucket and prefix reach one store under the same project key; set `store.projectId` for checkouts at different paths ([Sharing a store across hosts](#sharing-a-store-across-hosts)). `where` prints the bucket location.

A put uploads the file in one request and a `get` downloads it into the store cache. A new blob, tag or record requires an absent key (`If-None-Match`). Replacing a blob requires the ETag seen before the upload (`If-Match`).

Each lease is an object under the project's `locks/`. The holder renews it every 10 seconds. A lease not renewed for 60 seconds by the object store's clock is `dead`; a writer waits up to 30 seconds and can take over a dead lease from any host. Release and break conditionally replace the lease with an empty object, which the next holder reuses. `locks` omits released leases and `locks break` refuses a live one.

The lease and the blob are separate objects, not a transaction. Losing a lease cancels an in-flight upload but cannot undo an accepted change. An ETag cannot distinguish rewrites of identical bytes, and some S3-compatible services ignore `If-Match` on a blob delete. Run `verify` on the tag after a stalled writer resumes.

An s3 store refuses, naming the limit:

- a single put larger than 5 GiB (one request, no multipart upload);
- `adopt`, which moves a project directory between local roots;
- tag grants to a worker on an SSH node, which opens its own host's store;
- write store references from an MCP server, which has no local path to write to;
- the PanKit `store` server, which opens local roots only.

There is no host-local index and no free-space figure; `put --link` copies.

## The index

`tags`, `ls` and `history` answer from a host-local index, a `node:sqlite` database at `<cache>/store/index/<key>.db`, when it is current. Before each answer the index checks the directories it answers for by `stat` and rescans any that changed. Nothing that writes, checks a grant or decides whether a tag or blob exists reads it, and every command scans the store directly when the index cannot answer, so the store works with the database deleted.

## The model's `store` tool

The model reaches the same store through the `store` tool. Its eight ops (`tags`, `create`, `list`, `stat`, `get`, `put`, `note` and `remove`) and the admission each one gets are in [tool-usage.md](tool-usage.md#store-keep-results-and-datasets-outside-the-working-tree). An S3 put admitted as a creation cannot replace an object: if the name is taken, submit the put again for replacement approval. `get` returns a path to a read-only copy that the model passes unchanged to `data`, `read`, `run_script` or an MCP tool.

## Workers and tags

A dispatched worker reads the store but does not write it, unless its dispatch grants tags: `dispatch` with `tags: ["results"]` lets the worker `put` and `note` into `results` only. The tag must exist before the dispatch. A worker's `get` result says the path is a read-only store copy outside the workspace that it may read with `read`, `data` or `run_script`, so a worker in a task worktree reads it instead of stopping at the boundary.

A grant is a permission to write those tags through the store. It does not narrow what else the worker may write, with one exception: in a parallel batch that would otherwise be refused because several writers declare no write roots, each writer that holds a grant and declares no write roots is confined to its granted tags' directories. An S3 grant has no such directories: declare disjoint `intent.write_roots` for parallel writers or dispatch them separately.

A worker on an SSH fleet node opens its own host's store. It can be granted tags only when the project sets `store.projectId` and both hosts mount the store's roots, or its shared folder; see [Sharing a store across hosts](#sharing-a-store-across-hosts).

To run several granted writers at once on the local node, check the worker limit first. `fleet.concurrency: auto` sizes the local node from free memory, and in a container from the cgroup headroom, so a small container can get one worker. A parallel dispatch reserves all its tasks before any of them starts, so such a node refuses the whole plan and no worker runs (`dispatch: reservation denied: node '<id>' capacity exceeded (3/1)`); a single dispatch past the limit is refused with `capacity reached (1/1)`. Set `fleet.concurrency` to the number of writers you dispatch, for example `3`, when the host has room for them ([Worker limits](fleet-dispatch.md#worker-limits-and-fleetconcurrency-auto)).

## MCP servers and store references

An MCP server's declared path argument can name a blob instead of a file with the value `store:<tag>:<blob>` (`./store:a:b` is still a path). PanCode resolves it before the call, in [mcp-store-references.ts](../../src/tools/gateway/mcp-store-references.ts):

- On a read argument the server receives the path of a read-only (0400) copy under the store cache.
- On a write argument the server receives a hidden temporary file in the tag's directory. Its bytes are committed as the blob, with a put record by actor `mcp` naming the server, only when the call succeeded: no error result, no protocol error, no timeout or abort, and a regular file at the temporary path. Otherwise the temporary file is removed.

Admission judges each reference as the `store` call it stands for, so a reference to a records tag or a malformed reference is refused, and a worker writes only the tags its dispatch granted.

The builtin PanKit `store` server is launched by PanCode with this session's roots, cache, project and writable tags as launch arguments, outside the server's declaration digest; when the session may write a tag created after launch, the server is relaunched once. Its `store_put` and `store_note` are admitted as the `store` tool's own put and note into that tag. Its tools are listed in [PanKit](pankit.md#store).

## Limits

- PanStore is exercised on Linux only until its conformance suite runs on the macOS and Windows runners.
- On a local store, a root on a network file system is reported as `sharedFs: unverified`, and the backend still reports `multiNode: false`; a shared store reports `multiNode: true`. Two Linux hosts writing one root have been tested over NFS 4.2 (hard mounts) only; the store does not check which network file system a root is on. A worker on an SSH node gets a tag grant only as described in [Sharing a store across hosts](#sharing-a-store-across-hosts).
- On a local store, a `remote` or `unreadable` lock is never broken automatically: a host that crashed while writing blocks that blob or tag until an operator runs `locks break`.
- PanStore keeps no blob versions and does no deduplication. A put replaces the blob's bytes; its records remain.
- An s3 store refuses puts over 5 GiB, `adopt`, SSH tag grants, write store references and the PanKit `store` server ([Storing in an S3 bucket](#storing-in-an-s3-bucket)).
- A tag grant is a permission, not a confinement, outside the parallel-batch case in [Workers and tags](#workers-and-tags).
- The builtin `store` server's writes are limited to the tags it was started with, but its reads are not confined: it can read every tag of the project, whatever the session's grants.
- `put --link` copies on file systems without reflinks, such as ext4; the output says which happened.
