// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { deepStrictEqual, ok, strictEqual, throws } from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runFlywheelCommand } from "../../src/cli/flywheel.js";
import { runTelemetryShare } from "../../src/cli/telemetry-share.js";
import type { TelemetryContext } from "../../src/core/telemetry/context.js";
import {
	bundleDeletionComment,
	openShare,
	REPORT_SHARING_OFF,
	type ReportCommandRunner,
	readIntakeIndex,
	type SealedShare,
	type SharePlaintext,
	sealShare,
	telemetryShareDigest,
} from "../../src/domains/report/index.js";
import { openCallJournal } from "../../src/domains/telemetry/call-journal.js";
import { telemetrySessionDirectory } from "../../src/domains/telemetry/paths.js";
import { packShare, planShare, resolveShareScopes, telemetryShareSource } from "../../src/domains/telemetry/share.js";

const vector = JSON.parse(readFileSync(new URL("../fixtures/share-seal-vector.json", import.meta.url), "utf8")) as {
	recipient: { publicKey: string; kid: string; privateKeyPem: string };
	ephemeralPrivateKey: string;
	nonce: string;
	plaintext: SharePlaintext;
	envelope: SealedShare;
};

async function sealedSession(stateDir: string, sessionId: string): Promise<void> {
	const context: TelemetryContext = { sessionId, agent: { role: "main", id: sessionId } };
	const journal = await openCallJournal({
		directory: telemetrySessionDirectory(stateDir, sessionId),
		context,
		writer: { pancodeVersion: "0.0.0-test", piVersion: "test" },
	});
	const records = [
		{ kind: "session.opened", data: {} },
		{ kind: "tool.settled", data: { tool: "read", outcome: "ok", durationMs: 3 } },
		{ kind: "tool.settled", data: { tool: "read", outcome: "blocked", durationMs: 0, blocked: "refused" } },
		{ kind: "tool.settled", data: { tool: "ledger_private_lookup", outcome: "error", durationMs: 1 } },
		{
			kind: "turn.settled",
			data: { stopReason: "stop", terminal: { cause: null, stage: null, retries: 0, callIds: [] } },
		},
	];
	for (const { kind, data } of records)
		journal.enqueue({ kind, data, ctx: context, wallMs: Date.now(), mono: performance.now() } as Parameters<
			typeof journal.enqueue
		>[0]);
	await journal.flush();
	ok(await journal.seal());
	await journal.close();
}

test("sealing the contract's test vector reproduces its envelope byte for byte, and it opens to the plaintext", () => {
	const sealed = sealShare(vector.plaintext, {
		recipient: { publicKey: vector.recipient.publicKey },
		ephemeralPrivateKey: Buffer.from(vector.ephemeralPrivateKey, "base64"),
		nonce: Buffer.from(vector.nonce, "base64"),
	});
	deepStrictEqual(sealed, vector.envelope);
	strictEqual(sealed.kid, vector.recipient.kid);
	deepStrictEqual(openShare(vector.envelope, vector.recipient.privateKeyPem), vector.plaintext);
});

test("a fresh seal opens with the recipient key and names only its key id, share id and kind", () => {
	const sealed = sealShare(vector.plaintext, { recipient: { publicKey: vector.recipient.publicKey } });
	deepStrictEqual(Object.keys(sealed).sort(), ["ct", "epk", "format", "kid", "kind", "nonce", "shareId", "v"]);
	ok(!JSON.stringify(sealed).includes(vector.plaintext.archive));
	deepStrictEqual(openShare(sealed, vector.recipient.privateKeyPem), vector.plaintext);
	// The shipped recipient is the maintainers' key, whose id the contract fixes.
	strictEqual(sealShare(vector.plaintext).kid, "d7aad758f9cb9edc");
});

test("a key past its notAfter seals nothing (SF-20)", () => {
	const expired = { publicKey: vector.recipient.publicKey, notAfter: "2026-01-01" };
	const lastDay = new Date("2026-01-01T23:00:00Z");
	strictEqual(sealShare(vector.plaintext, { recipient: expired, now: lastDay }).kid, vector.recipient.kid);
	throws(() => sealShare(vector.plaintext, { recipient: expired, now: new Date("2026-01-02T00:00:00Z") }), /too old/u);
	throws(() => sealShare(vector.plaintext, { now: new Date("2099-01-01T00:00:00Z") }), /too old/u);
});

test("an altered envelope does not open", () => {
	const pem = vector.recipient.privateKeyPem;
	const ct = Buffer.from(vector.envelope.ct, "base64");
	ct[0] = (ct[0] ?? 0) ^ 1;
	throws(() => openShare({ ...vector.envelope, ct: ct.toString("base64") }, pem), /does not authenticate/u);
	// The share id is authenticated: moving the ciphertext under another id fails.
	throws(() => openShare({ ...vector.envelope, shareId: "shr_ffffffffffffffff" }, pem), /does not authenticate/u);
	throws(() => openShare({ ...vector.envelope, kind: "report-bundle" }, pem), /another share/u);
	throws(() => openShare({ ...vector.envelope, kid: "0000000000000000" }, pem), /sealed to key/u);
	throws(() => openShare({ ...vector.envelope, v: 2 }, pem), /not a version 1/u);
});

test("the digest counts events and tools by closed names only, collapsing operator tools into other", async () => {
	const root = await mkdtemp(join(tmpdir(), "report-share-"));
	try {
		const stateDir = join(root, "operator");
		const sessionId = "ses_digest";
		await sealedSession(stateDir, sessionId);
		const { scopes, skipped } = resolveShareScopes(stateDir, {
			sessions: [sessionId],
			runs: [],
			repo: null,
			since: null,
			until: null,
		});
		const source = telemetryShareSource(stateDir);
		const writer = { pancodeVersion: "0.0.0-test", piVersion: "test" };
		const archive = packShare(planShare({ scopes, skipped, profile: "content-free", source, writer }));
		const digest = telemetryShareDigest(archive, { platform: "darwin", install: "npm", profile: "content-free" });
		strictEqual(digest.os, "macos");
		deepStrictEqual(digest.scopes, { session: 1, run: 0, process: 0 });
		deepStrictEqual(digest.tools, { read: { ok: 1, error: 0, denied: 1 }, other: { ok: 0, error: 1, denied: 0 } });
		strictEqual(digest.events["tool.settled"], 3);
		strictEqual(digest.events["turn.settled"], 1);
		ok(digest.records >= 5);
		ok(!JSON.stringify(digest).includes("ledger"));
		throws(() => telemetryShareDigest(Buffer.from("nope"), { platform: "linux", install: "npm", profile: "x" }));
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("telemetry share --send is turned off", async () => {
	const root = await mkdtemp(join(tmpdir(), "telemetry-share-send-"));
	try {
		const stateDir = join(root, "state");
		await sealedSession(stateDir, "ses_send");
		let out = "";
		let err = "";
		const code = await runTelemetryShare(["--session", "ses_send", "--send", "--consent", "debug", "--yes"], {
			stateDir,
			interactive: false,
			stdout: (text) => {
				out += text;
			},
			stderr: (text) => {
				err += text;
			},
		});
		strictEqual(code, 2);
		strictEqual(err, `${REPORT_SHARING_OFF}\n`);
		strictEqual(out, "");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("dev flywheel's backlog and --pull are turned off and ask gh nothing", async () => {
	for (const argv of [[], ["--json"], ["--kind", "failure", "--top", "2"], ["--pull", "all"]]) {
		let calls = 0;
		let out = "";
		let err = "";
		const code = await runFlywheelCommand(argv, {
			run: async () => {
				calls += 1;
				return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
			},
			findGh: () => "/usr/bin/gh",
			env: {},
			stdout: (text) => {
				out += text;
			},
			stderr: (text) => {
				err += text;
			},
		});
		strictEqual(code, 2, argv.join(" "));
		strictEqual(err, `${REPORT_SHARING_OFF}\n`);
		strictEqual(out, "");
		strictEqual(calls, 0);
	}
});

const NOW = new Date("2026-11-20T12:00:00Z");
const daysAgo = (days: number) => new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
const rid = (n: number) => `rpt_${String(n).padStart(26, "0")}`;

/** A store holding six bundles: lines the sweep, a reporter's request and a stranger's request each decide. */
function seedIntakeStore(store: string): void {
	mkdirSync(join(store, "bundles"), { recursive: true });
	const held = (n: number, issue: number | null, scopes: string[], receivedDaysAgo: number) => {
		writeFileSync(join(store, "bundles", `${rid(n)}.tar.gz`), `bundle ${n}`);
		return {
			reportId: rid(n),
			shareId: `shr_${String(n).padStart(16, "0")}`,
			issue,
			receivedOn: daysAgo(receivedDaysAgo).slice(0, 10),
			pancode: "0.8.5",
			keyId: "d7aad758f9cb9edc",
			sha256: "0".repeat(64),
			scopes,
			content: "none",
			status: "held",
			expiresOn: null,
		};
	};
	const index = [
		held(1, 11, ["debug"], 120),
		held(2, 12, ["debug", "dataset"], 120),
		held(3, 13, ["debug"], 10),
		held(4, null, ["debug"], 181),
		held(5, 14, ["debug"], 10),
		held(6, 15, ["debug"], 10),
	];
	writeFileSync(join(store, "index.jsonl"), index.map((line) => `${JSON.stringify(line)}\n`).join(""));
}

const statuses = (store: string) =>
	Object.fromEntries(readIntakeIndex(store).map((line) => [line.reportId, line.status]));
const bundleKept = (store: string, n: number) => existsSync(join(store, "bundles", `${rid(n)}.tar.gz`));

test("dev flywheel --sweep expires debug-only bundles past retention and forgets on the reporter's own request (R-20)", async () => {
	const root = await mkdtemp(join(tmpdir(), "flywheel-sweep-"));
	try {
		const store = join(root, "store");
		seedIntakeStore(store);
		const calls: string[][] = [];
		const issue = (number: number, author: string, closedDaysAgo: number | null) => ({
			number,
			body: "",
			closed_at: closedDaysAgo === null ? null : daysAgo(closedDaysAgo),
			user: { login: author },
		});
		const run: ReportCommandRunner = async (_file, args) => {
			calls.push([...args]);
			const reply = (value: unknown) => ({ exitCode: 0, stdout: JSON.stringify(value), stderr: "", timedOut: false });
			const joined = args.join(" ");
			if (joined.includes("labels=has-bundle"))
				return reply([
					issue(11, "rep11", 91),
					issue(12, "rep12", 91),
					issue(13, "rep13", null),
					issue(14, "rep14", null),
					issue(15, "rep15", null),
				]);
			if (joined.includes("issues/14/comments"))
				return reply([
					{ body: "Thanks for the fix.", user: { login: "rep14" } },
					{ body: bundleDeletionComment(rid(5)), user: { login: "rep14" } },
				]);
			if (joined.includes("issues/15/comments"))
				return reply([{ body: bundleDeletionComment(rid(6)), user: { login: "drive-by" } }]);
			if (/issues\/\d+\/comments/u.test(joined)) return reply([]);
			return { exitCode: 1, stdout: "", stderr: `unexpected ${joined}`, timedOut: false };
		};
		let out = "";
		let err = "";
		const code = await runFlywheelCommand(["--sweep", "--store", store], {
			run,
			findGh: () => "/usr/bin/gh",
			env: {},
			cwd: root,
			now: () => NOW,
			stdout: (text) => {
				out += text;
			},
			stderr: (text) => {
				err += text;
			},
		});
		strictEqual(code, 0, err);
		deepStrictEqual(statuses(store), {
			[rid(1)]: "expired",
			[rid(2)]: "held",
			[rid(3)]: "held",
			[rid(4)]: "expired",
			[rid(5)]: "forgotten",
			[rid(6)]: "held",
		});
		deepStrictEqual(
			[1, 2, 3, 4, 5, 6].map((n) => bundleKept(store, n)),
			[false, true, true, false, false, true],
		);
		strictEqual(readFileSync(join(store, "exclusions.txt"), "utf8"), `${rid(5)}\n`);
		ok(out.includes(`drive-by asked on #15`) && out.includes(`--forget ${rid(6)}`), out);
		// Every gh call is a read: nothing is posted for the maintainer.
		ok(
			calls.every((args) => args[0] === "api" && !args.includes("-X") && !args.includes("--method")),
			JSON.stringify(calls),
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("dev flywheel --forget deletes a stored bundle on request without gh and keeps it out of every later pull (R-20)", async () => {
	const root = await mkdtemp(join(tmpdir(), "flywheel-forget-"));
	try {
		const store = join(root, "store");
		seedIntakeStore(store);
		let out = "";
		const forget = (id: string) =>
			runFlywheelCommand(["--forget", id, "--store", store], {
				findGh: () => null,
				env: {},
				cwd: root,
				stdout: (text) => {
					out += text;
				},
				stderr: () => {},
			});
		strictEqual(await forget(rid(2)), 0);
		strictEqual(statuses(store)[rid(2)], "forgotten");
		strictEqual(bundleKept(store, 2), false);
		ok(out.includes(`The diagnostic bundle for report ${rid(2)} is deleted`), out);
		strictEqual(await forget(rid(9)), 0);
		ok(out.includes(`${rid(9)}: not in the store; recorded`), out);
		deepStrictEqual(readFileSync(join(store, "exclusions.txt"), "utf8").split("\n").filter(Boolean), [rid(2), rid(9)]);
		strictEqual(
			readFileSync(join(store, "bundles", ".gitignore"), "utf8")
				.split("\n")
				.includes("*"),
			true,
		);
		// The seeded bundles/ was made with the default mode; the store tightens it.
		strictEqual(statSync(join(store, "bundles")).mode & 0o777, 0o700);
		strictEqual(await forget("rpt_nope"), 2);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
