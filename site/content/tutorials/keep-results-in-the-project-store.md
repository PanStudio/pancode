Results, datasets and checkpoints do not belong in Git, but scattering them across scratch folders loses track of where each came from. The project store keeps them outside the working tree, in named tags, with a record of what produced each file and whether it has changed since. You, the agent and its workers all see the same store.

::: note Version scope
This tutorial describes the store's local backend. The output below is from the `pancode store` command run on Linux, where the store has been exercised.
:::

::: needs
- PanCode installed, and a project in a Git repository.
- A result file to keep, here `run-042.csv`.
:::

## Put a result in the store

From the project folder:

```sh
pancode store put results run-042.csv --note "baseline, 64 ranks"
```

::: result What you should see
`stored results:run-042.csv (8 B) from /home/alice/proj/run-042.csv`. The `results` tag did not exist, so the put created it.
:::

A tag is a named container and a blob is a file in it; `results:run-042.csv` names one blob. List what you have with `pancode store tags` and `pancode store ls results`. `pancode store where` prints the folder the store lives in, under PanCode's data directory, so it does not count against the repository and every checkout and task worktree of the project shares it.

## Check whether it changed

```sh
pancode store stat results:run-042.csv
```

::: result What you should see
A `ref`, `path`, `bytes` and `sha256` line, and `drift     none`. Drift is `none` while the blob matches its record, `changed` when its bytes no longer match, `missing` when it is gone, and `unrecorded` when there is no record for it.
:::

To check a whole tag at once, run `pancode store verify results`. It prints a count for each state, names any blob that is not `ok`, and exits 1 unless every blob is `ok`, so a job script can stop on it.

`pancode store history results:run-042.csv` lists every put, note and removal, with its hash, its source file and its note. The history is write-once.

## Read it from a script

`store get` prints the path of a read-only copy, so a script reads the stored bytes without any chance of changing them:

```sh
python3 analyze.py "$(pancode store get results:run-042.csv)"
```

Use `--to <path>` to copy the blob somewhere instead. In a session, ask for the same thing in words:

::: prompt Example
Plot the y column of results:run-042.csv against x and save the figure as fig-042.png. Put the figure in the results tag with a note naming the input.
:::

The agent reaches the store through its `store` tool, and reading needs no approval.

When the figure comes from a script the agent ran with its `run_script` tool, the stored record keeps the script's hash and its declared inputs, and an input that came from the store is named by its `<tag>:<blob>`. Notes can be added later, and `derived_from` records which blobs a result was made from.

## Let a worker write results

A dispatched worker reads the store but does not write it unless its dispatch grants it tags. Ask for the grant by name:

::: prompt Example
Hand this to a researcher worker: rerun the analysis for runs 043 to 045 and put each figure in the results tag. Grant it the results tag only.
:::

The tag must exist before the dispatch. The worker may then `put` and `note` into `results` and nowhere else in the store. A read-only run, an ACP agent or a worker on a remote node cannot be granted tags.

## Replace and remove with care

The store keeps no earlier versions of a blob, and no workspace snapshot covers it.

When the agent would replace a blob or remove one, it asks you first and names the blob. From the shell, `pancode store put` over an existing blob replaces it and says `replaced`. `pancode store rm results:run-042.csv` only prints what it would delete; add `--yes` to delete it. The blob's records remain.

::: limits
- The store lives on one host. A worker on another node through an SSH fleet sees that node's own store.
- `put` copies bytes. A large dataset takes its size again in the store.
- Above 64 MiB the record omits the hash; `pancode store verify results --hash-large` hashes such blobs and records the digest as a note.
- `pancode reset --data`, `reset --all`, and `uninstall` without `--keep-data` delete the store, and nothing recovers it.
:::

::: next
- [Keep results in the store](/docs/guide/panstore.html)
- [The store tool and its limits](/docs/guide/tool-usage.html)
- [Workers and fleets](/docs/guide/fleet-dispatch.html)
- [Install on a cluster](/docs/guide/hpc-clusters.html)
:::
