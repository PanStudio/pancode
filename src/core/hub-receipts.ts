// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { startedUnderPancodeAgent } from "./agent-environment.js";
import { writeDiagnostic } from "./diagnostics.js";
import { sha256Hex } from "./hash.js";
import { safeResourceWrite } from "./safe-resource-write.js";
import { withStateFileLockSync } from "./state-file-lock.js";
import type { EventName } from "./telemetry/events.js";
import { telemetryHub } from "./telemetry/hub.js";
import { pancodeStateDir } from "./xdg.js";

export type LifecycleActor = "operator" | "model-confirmed" | "upgrade";
export type LifecycleOperation =
	| "install"
	| "update"
	| "enable"
	| "disable"
	| "remove"
	| "register"
	| "import"
	| "share-import";
export interface LifecycleContext {
	operation?: LifecycleOperation;
	operationId?: string;
	actor?: LifecycleActor;
	source?: string;
}
export interface LifecycleReceipt {
	operationId: string;
	operation: LifecycleOperation;
	kind: string;
	id: string;
	version: string | null;
	contentDigest: string | null;
	envelopeDigest: string | null;
	scope: string;
	source: string;
	at: string;
	actor: LifecycleActor;
}
/** The journal event each lifecycle operation records (#434). */
const LIFECYCLE_EVENTS = {
	install: "hub.installed",
	update: "hub.updated",
	enable: "hub.enabled",
	disable: "hub.disabled",
	remove: "hub.removed",
	register: "hub.registered",
	import: "hub.imported",
	"share-import": "hub.share_imported",
} as const satisfies Record<LifecycleOperation, EventName>;
export const HUB_RECEIPT_LIMIT = 512;
const MAX_BYTES = 1024 * 1024;
function receiptPath(): string {
	return join(pancodeStateDir(), "hub-receipts.json");
}
function read(): LifecycleReceipt[] {
	const file = receiptPath();
	if (!existsSync(file)) return [];
	if (statSync(file).size > MAX_BYTES) throw new Error("PanHub receipt store exceeds its size limit");
	const value = JSON.parse(readFileSync(file, "utf8")) as { version?: unknown; receipts?: unknown };
	if (value.version !== 1 || !Array.isArray(value.receipts)) throw new Error("invalid PanHub receipt store");
	return value.receipts.filter(
		(row): row is LifecycleReceipt =>
			row && typeof row.operationId === "string" && typeof row.id === "string" && typeof row.at === "string",
	);
}
export function readLifecycleReceipts(id?: string, scope?: string, kind?: string): LifecycleReceipt[] {
	try {
		return read().filter(
			(row) =>
				(id === undefined || row.id === id) &&
				(scope === undefined || row.scope === scope) &&
				(kind === undefined || row.kind === kind),
		);
	} catch {
		// A damaged observability store must not prevent browsing or package admission.
		return [];
	}
}
export function recordLifecycleReceipt(
	input: Omit<LifecycleReceipt, "operationId" | "at" | "actor">,
	context: LifecycleContext = {},
): void {
	const receipt: LifecycleReceipt = {
		...input,
		source: (context.source ?? input.source).slice(0, 4096),
		operation: context.operation ?? input.operation,
		operationId: context.operationId ?? randomUUID(),
		at: new Date().toISOString(),
		actor: context.actor ?? (startedUnderPancodeAgent() ? "model-confirmed" : "operator"),
	};
	// The receipt file is state, the latest provenance per package that /hub shows; the journal keeps the
	// operation itself (#434).
	try {
		const { operation, at: _at, source, ...facts } = receipt;
		telemetryHub().emit(LIFECYCLE_EVENTS[operation], {
			...facts,
			sourceId: `sha256:${sha256Hex(source)}`,
		});
	} catch {
		// Recording follows the committed mutation and cannot roll back installed bytes.
	}
	try {
		withStateFileLockSync(
			receiptPath(),
			() => {
				const receipts = [...read().filter((row) => row.operationId !== receipt.operationId), receipt].slice(
					-HUB_RECEIPT_LIMIT,
				);
				let text = JSON.stringify({ version: 1, receipts });
				while (Buffer.byteLength(text) > MAX_BYTES && receipts.length > 1) {
					receipts.shift();
					text = JSON.stringify({ version: 1, receipts });
				}
				if (Buffer.byteLength(text) > MAX_BYTES) throw new Error("PanHub receipt exceeds its size limit");
				safeResourceWrite(receiptPath(), `${text}\n`, { encoding: "utf8" });
			},
			{ timeoutMs: 1000 },
		);
	} catch (error) {
		// Reporting follows the committed mutation and cannot roll back installed bytes.
		writeDiagnostic(
			`[pancode:hub] receipt could not be saved: ${error instanceof Error ? error.message : String(error)}\n`,
		);
	}
}
