// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * The shared backend: one folder several hosts mount, holding one fenced change log for every project stored in
 * it, so adopting a project from one key to another is a single transition. Slot `n` of the log is a proposal at
 * `log/p/<bucket>/<n>` and a decision at `log/d/<bucket>/<n>`, each a complete fsynced file `link()`ed into place
 * once; the store's clock is the mtime the file server gives a fresh probe file. Pages and blob bytes are
 * immutable files under `pages/` and `objects/`. `staging/<projectKey>/<tag>/` is where a worker granted a tag
 * writes the files the host then puts; nothing there is part of the store.
 *
 * The folder must be on Linux, on a file system that links atomically and looks names up fresh: a local one, or
 * NFS mounted with `lookupcache=none` or `lookupcache=positive`. Anything else is refused.
 */
import { createHash, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream, constants as fsConstants } from "node:fs";
import {
	chmod,
	copyFile,
	link,
	mkdir,
	open,
	readdir,
	readFile,
	realpath,
	rm,
	stat,
	statfs,
	unlink,
} from "node:fs/promises";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { StoreBackend } from "../backend/backend.js";
import { registerStoreBackend } from "../backend/registry.js";
import { StoreRefusal } from "../backend/types.js";
import { hashStoreFile } from "../hash.js";
import { ensureStoreRootId, readStoreRootId } from "../identity.js";
import { createLogStoreBackend } from "../log/backend.js";
import { type LogMedium, randomId } from "../log/machine.js";
import type { LogWitness, StoreLog } from "../log/types.js";
import { STORE_DEFAULT_ROOT_NAME } from "../paths/index.js";

export interface SharedStoreOptions {
	/** The shared folder, absolute. It must exist: an unmounted share is refused, not created. */
	root: string;
	/** The cache root: `getBlobAsPath` copies live under `<cacheDir>/store/<projectKey>`. */
	cacheDir: string;
	/** `storeProjectKey` of the project's main checkout, or `storeProjectKeyForId` of its project id. */
	projectKey: string;
	/** The project id its tracked settings give it, kept with the project in the log; absent when it has none. */
	projectId?: string;
	/** The project's main checkout, kept with the project in the log when the store first writes it. */
	projectRoot: string;
}

const SLOT_DIGITS = 15;
const SLOTS_PER_BUCKET = 4096;
/** File systems whose link() is atomic and whose lookups see every host's names at once. */
const QUALIFIED_FS = new Set(["ext2", "ext3", "ext4", "xfs", "btrfs", "tmpfs", "zfs", "f2fs", "bcachefs"]);
const NFS_FS = new Set(["nfs", "nfs4"]);

function errnoOf(error: unknown): string | undefined {
	return (error as NodeJS.ErrnoException | null)?.code;
}

/** A mount's point and options from one line of /proc/self/mountinfo, its octal escapes decoded. */
function parseMountinfo(text: string): Array<{ point: string; fstype: string; options: string[] }> {
	const decoded = (value: string) =>
		value.replace(/\\([0-7]{3})/gu, (_, octal: string) => String.fromCharCode(Number.parseInt(octal, 8)));
	const mounts: Array<{ point: string; fstype: string; options: string[] }> = [];
	for (const line of text.split("\n")) {
		const fields = line.split(" ");
		const separator = fields.indexOf("-");
		if (separator < 6 || fields[4] === undefined) continue;
		mounts.push({
			point: decoded(fields[4]),
			fstype: fields[separator + 1] ?? "",
			options: [...(fields[5] ?? "").split(","), ...(fields[separator + 3] ?? "").split(",")],
		});
	}
	return mounts;
}

async function qualifyMount(root: string): Promise<void> {
	const refuse = (why: string) =>
		new StoreRefusal("unavailable", `The shared store folder ${root} cannot keep PanStore's log: ${why}.`);
	if (process.platform !== "linux") throw refuse("a shared store is supported on Linux only");
	const resolved = await realpath(root);
	const mounts = parseMountinfo(await readFile("/proc/self/mountinfo", "utf8"));
	let best: (typeof mounts)[number] | undefined;
	for (const mount of mounts) {
		const inside = resolved === mount.point || resolved.startsWith(mount.point === "/" ? "/" : `${mount.point}/`);
		// The last match of the longest point is the mount on top.
		if (inside && (best === undefined || mount.point.length >= best.point.length)) best = mount;
	}
	if (best === undefined) throw refuse("its mount cannot be found");
	if (NFS_FS.has(best.fstype)) {
		const lookup = best.options.find((option) => option.startsWith("lookupcache="))?.slice("lookupcache=".length);
		if (lookup !== "none" && lookup !== "pos" && lookup !== "positive")
			throw refuse(
				`it is NFS mounted without lookupcache=positive or lookupcache=none, so a host can miss a name another created`,
			);
		return;
	}
	if (!QUALIFIED_FS.has(best.fstype)) throw refuse(`its file system ${best.fstype} is not one known to link atomically`);
}

/** fsync a directory, so the names just made in it survive a crash. */
async function syncDir(dir: string): Promise<void> {
	const handle = await open(dir, "r");
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}

/** Write `text` to the new file `file` and fsync it. */
async function writeNew(file: string, text: string): Promise<void> {
	const handle = await open(file, "wx", 0o444);
	try {
		await handle.writeFile(text);
		await handle.sync();
	} finally {
		await handle.close();
	}
}

async function readOrNull(file: string): Promise<string | null> {
	try {
		return await readFile(file, "utf8");
	} catch (error) {
		if (errnoOf(error) === "ENOENT") return null;
		throw error;
	}
}

async function exists(file: string): Promise<boolean> {
	try {
		await stat(file);
		return true;
	} catch (error) {
		if (errnoOf(error) === "ENOENT") return false;
		throw error;
	}
}

function sharedMedium(root: string): LogMedium {
	const logDir = path.join(root, "log");
	const tmpDir = path.join(logDir, "tmp");
	const clockDir = path.join(logDir, "clock");
	const slotPath = (kind: "p" | "d", slot: number) =>
		path.join(
			logDir,
			kind,
			String(Math.floor(slot / SLOTS_PER_BUCKET)).padStart(SLOT_DIGITS, "0"),
			String(slot).padStart(SLOT_DIGITS, "0"),
		);
	const itemPath = (kind: "page" | "payload", id: string) =>
		path.join(root, kind === "page" ? "pages" : "objects", id.slice(0, 2), id);
	/** A slot known to hold a proposal: slots are never removed, so the newest is at or after it. */
	let known = 0;

	/** Link a complete, fsynced file holding `text` to `target` once; false when `target` exists. */
	async function createOnce(target: string, text: string): Promise<boolean> {
		const temp = path.join(tmpDir, `${process.pid}.${randomId()}`);
		await writeNew(temp, text);
		try {
			await mkdir(path.dirname(target), { recursive: true });
			try {
				await link(temp, target);
			} catch (error) {
				if (errnoOf(error) !== "EEXIST") throw error;
				// NFS answers a retried LINK whose first try made the name with EEXIST: the bytes tell.
				return (await readOrNull(target)) === text;
			}
			await syncDir(path.dirname(target));
			return true;
		} finally {
			await unlink(temp).catch(() => undefined);
		}
	}

	async function witness(): Promise<LogWitness> {
		// The file server stamps a new file's mtime from its own clock, the one every host of the folder shares.
		const probe = path.join(clockDir, `${process.pid}.${randomId()}`);
		const handle = await open(probe, "wx", 0o600);
		try {
			await handle.writeFile("t");
			await handle.sync();
			const mtime = (await handle.stat()).mtimeMs;
			return { lo: Math.floor(mtime), hi: Math.floor(mtime) + 1000 };
		} finally {
			await handle.close();
			await unlink(probe).catch(() => undefined);
		}
	}

	async function newestByListing(): Promise<number> {
		const proposals = path.join(logDir, "p");
		const buckets = (await readdir(proposals).catch(() => [] as string[]))
			.filter((name) => /^\d{15}$/u.test(name))
			.sort();
		for (const bucket of buckets.reverse()) {
			const slots = (await readdir(path.join(proposals, bucket))).filter((name) => /^\d{15}$/u.test(name)).sort();
			const last = slots[slots.length - 1];
			if (last !== undefined) return Number(last);
		}
		return 0;
	}

	async function* walk(kind: "page" | "payload") {
		const dir = path.join(root, kind === "page" ? "pages" : "objects");
		for (const shard of await readdir(dir).catch(() => [] as string[])) {
			for (const id of await readdir(path.join(dir, shard)).catch(() => [] as string[])) {
				const info = await stat(path.join(dir, shard, id)).catch(() => null);
				if (info?.isFile()) yield { kind, id, bytes: info.size, modifiedMs: info.mtimeMs };
			}
		}
	}

	return {
		async qualify() {
			await qualifyMount(root);
			await ensureStoreRootId(root);
			for (const dir of [tmpDir, clockDir, path.join(logDir, "p"), path.join(logDir, "d")])
				await mkdir(dir, { recursive: true });
			await mkdir(path.join(root, "pages"), { recursive: true });
			await mkdir(path.join(root, "objects"), { recursive: true });
			// A link over an existing name must fail, or two writers could both take one slot.
			const probe = path.join(tmpDir, `probe.${randomId()}`);
			await writeNew(`${probe}.a`, "a");
			await writeNew(`${probe}.b`, "b");
			try {
				await link(`${probe}.a`, `${probe}.c`);
				let refused = false;
				try {
					await link(`${probe}.b`, `${probe}.c`);
				} catch (error) {
					refused = errnoOf(error) === "EEXIST";
				}
				if (!refused)
					throw new StoreRefusal(
						"unavailable",
						`The shared store folder ${root} cannot keep PanStore's log: link() over an existing name did not fail with EEXIST.`,
					);
			} finally {
				for (const suffix of [".a", ".b", ".c"]) await unlink(`${probe}${suffix}`).catch(() => undefined);
			}
		},

		async newestProposal() {
			let newest = known > 0 ? known : await newestByListing();
			// A listing can lag another host's create; a lookup of the next name cannot, on a qualified mount.
			while (await exists(slotPath("p", newest + 1))) newest += 1;
			known = newest;
			return newest;
		},

		async readProposal(slot) {
			const text = await readOrNull(slotPath("p", slot));
			return text === null ? null : { text, witness: await witness() };
		},

		async claimProposal(slot, id, text) {
			if (!(await createOnce(slotPath("p", slot), text))) {
				const existing = await readOrNull(slotPath("p", slot));
				let mine = false;
				try {
					mine = existing !== null && (JSON.parse(existing) as { id?: unknown }).id === id;
				} catch {
					mine = false;
				}
				if (!mine) return { won: false };
			}
			known = Math.max(known, slot);
			return { won: true, witness: await witness() };
		},

		readDecision: (slot) => readOrNull(slotPath("d", slot)),

		async claimDecision(slot, text) {
			await createOnce(slotPath("d", slot), text);
		},

		witness,

		async putPage(id, text) {
			const file = itemPath("page", id);
			await mkdir(path.dirname(file), { recursive: true });
			await writeNew(file, text);
			await syncDir(path.dirname(file));
		},

		getPage: (id) => readOrNull(itemPath("page", id)),

		async stagePayload(source, options) {
			const id = randomId();
			const target = itemPath("payload", id);
			await mkdir(path.dirname(target), { recursive: true });
			const aborted = () => new StoreRefusal("io", `Staging ${source} into the store was aborted.`);
			if (options.signal?.aborted) throw aborted();
			let sha256: string;
			let bytes = 0;
			let linked = false;
			try {
				if (options.mode === "link") {
					try {
						await copyFile(source, target, fsConstants.COPYFILE_EXCL | fsConstants.COPYFILE_FICLONE_FORCE);
						linked = true;
					} catch (error) {
						if (errnoOf(error) === "EEXIST") throw error;
						await rm(target, { force: true });
					}
				}
				if (linked) {
					// The clone is what the blob holds; its hash is of those bytes, whatever the source does next.
					sha256 = await hashStoreFile(target, options.signal);
					bytes = (await stat(target)).size;
				} else {
					const hash = createHash("sha256");
					await pipeline(
						createReadStream(source),
						new Transform({
							transform(chunk: Buffer, _encoding, callback) {
								hash.update(chunk);
								bytes += chunk.length;
								callback(null, chunk);
							},
						}),
						createWriteStream(target, { flags: "wx", mode: 0o600 }),
						...(options.signal !== undefined ? [{ signal: options.signal }] : []),
					);
					sha256 = hash.digest("hex");
				}
				const handle = await open(target, "r");
				try {
					await handle.sync();
				} finally {
					await handle.close();
				}
				await chmod(target, 0o444);
				await syncDir(path.dirname(target));
			} catch (error) {
				await rm(target, { force: true });
				if (options.signal?.aborted) throw aborted();
				throw error;
			}
			return { id, bytes, sha256, link: linked ? "reflink" : "copy" };
		},

		async readPayload(id, target, signal) {
			if (signal?.aborted) throw new StoreRefusal("io", "The read from the store was aborted.");
			try {
				await copyFile(itemPath("payload", id), target, fsConstants.COPYFILE_EXCL | fsConstants.COPYFILE_FICLONE);
			} catch (error) {
				if (errnoOf(error) === "ENOENT" && !(await exists(itemPath("payload", id))))
					throw new StoreRefusal("io", `The store's payload ${itemPath("payload", id)} is missing.`);
				throw error;
			}
		},

		payloadKey: (id) => itemPath("payload", id),

		async *listStored() {
			yield* walk("page");
			yield* walk("payload");
		},

		async deleteStored(kind, id) {
			await rm(itemPath(kind, id), { force: true });
		},
	};
}

export function createSharedStoreBackend(options: SharedStoreOptions): StoreBackend & { log: StoreLog } {
	if (!path.isAbsolute(options.root))
		throw new StoreRefusal("invalid-name", `The shared store folder ${options.root} is not an absolute path.`);
	const root = path.resolve(options.root);
	const medium = sharedMedium(root);
	const mounted = async (): Promise<void> => {
		try {
			if ((await stat(root)).isDirectory()) return;
		} catch {
			// Refused below like a file in its place.
		}
		throw new StoreRefusal(
			"unavailable",
			`The shared store folder ${root} is not there; mount it (or create it) before using the store.`,
		);
	};
	const probeLinks = async (): Promise<"reflink" | "copy"> => {
		const probe = path.join(root, "log", "tmp", `links.${randomBytes(6).toString("hex")}`);
		try {
			await writeNew(probe, "l");
			await copyFile(probe, `${probe}.clone`, fsConstants.COPYFILE_EXCL | fsConstants.COPYFILE_FICLONE_FORCE);
			return "reflink";
		} catch {
			return "copy";
		} finally {
			await rm(probe, { force: true });
			await rm(`${probe}.clone`, { force: true });
		}
	};
	return createLogStoreBackend({
		kind: "shared",
		location: root,
		logName: `shared\0${root}`,
		medium: {
			...medium,
			async qualify() {
				await mounted();
				await medium.qualify();
			},
			// Every call reads the tip first, so an unmounted folder never answers as an empty store.
			async newestProposal() {
				await mounted();
				return medium.newestProposal();
			},
		},
		cacheDir: options.cacheDir,
		projectKey: options.projectKey,
		projectRoot: options.projectRoot,
		...(options.projectId !== undefined ? { projectId: options.projectId } : {}),
		facts: async () => {
			const freeBytes = await statfs(root)
				.then((info) => Number(info.bavail) * Number(info.bsize))
				.catch(() => null);
			return {
				kind: "shared",
				mapping: "every project's tags and blobs are one change log in the shared folder; a blob's bytes are a file",
				tiers: false,
				multiNode: true,
				durable: true,
				conditionalPut: "if-absent",
				blobVersions: false,
				freeBytes,
				roots: [
					{
						name: STORE_DEFAULT_ROOT_NAME,
						id: await readStoreRootId(root),
						durable: true,
						sharedFs: true,
						purge: null,
						freeBytes,
					},
				],
				links: (await exists(path.join(root, "log", "tmp"))) ? await probeLinks() : "copy",
			};
		},
	});
}

registerStoreBackend("shared", createSharedStoreBackend);
