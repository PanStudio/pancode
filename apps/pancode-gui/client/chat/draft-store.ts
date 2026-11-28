// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * The composer's draft store and its session storage. It sits apart from `composer-model.ts` so the model stays
 * free of storage, listeners and key minting.
 */

import type { SteerMode } from "../../contracts/steering.js";
import { DEFAULT_STEER_MODE, type Draft } from "./composer-model.js";
import { DRAFT_INDEX, DRAFT_KEY, MAX_DRAFT_STORES, storedDraftIds, stores } from "./draft-registry.js";

export { discardDraftStore, MAX_DRAFT_STORES, resetDraftStores } from "./draft-registry.js";

interface SavedDraft {
	readonly draft: Draft;
	readonly submittedKey: string | null;
}

function randomKey(): string {
	return crypto.randomUUID();
}

/**
 * The draft, held outside the component tree. The timeline re-renders on every
 * streamed delta; a draft that lived in the same component re-rendered the
 * textarea with it, which is the single largest perceived-speed cost in the
 * chat. Subscribers here are only the composer.
 */
export class DraftStore {
	readonly #mint: () => string;
	readonly #listeners = new Set<() => void>();
	#state: Draft;
	#submittedKey: string | null = null;
	#restoredSubmission = false;

	constructor(mint: () => string = randomKey, saved?: SavedDraft) {
		this.#mint = mint;
		this.#state = saved?.draft ?? { text: "", mode: DEFAULT_STEER_MODE, key: mint() };
		this.#submittedKey = saved?.submittedKey ?? null;
		this.#restoredSubmission = this.#submittedKey !== null;
	}

	readonly snapshot = (): Draft => this.#state;
	readonly submittedKey = (): string | null => this.#submittedKey;
	readonly uncertainSubmission = (): boolean => this.#restoredSubmission && this.#submittedKey === this.#state.key;

	readonly subscribe = (listener: () => void): (() => void) => {
		this.#listeners.add(listener);
		return () => {
			this.#listeners.delete(listener);
		};
	};

	/** Typing, and the retry and starter-prompt fills. Edits after a send get a new key. */
	write(text: string): void {
		if (text === this.#state.text) return;
		if (this.#submittedKey === this.#state.key) this.#restoredSubmission = false;
		this.#commit({ ...this.#state, text, key: this.#submittedKey === this.#state.key ? this.#mint() : this.#state.key });
	}

	chooseMode(mode: SteerMode): void {
		if (mode === this.#state.mode) return;
		if (this.#submittedKey === this.#state.key) this.#restoredSubmission = false;
		this.#commit({ ...this.#state, mode, key: this.#submittedKey === this.#state.key ? this.#mint() : this.#state.key });
	}

	/** Attachment edits after an attempted send change its body and therefore its request identity. */
	attachmentsChanged(): void {
		if (this.#submittedKey !== this.#state.key) return;
		this.#restoredSubmission = false;
		this.#commit({ ...this.#state, key: this.#mint() });
	}

	/** An unchanged retry keeps this key; editing after a send starts a new request. */
	markSubmitted(sent: Draft): void {
		if (this.#state.key === sent.key) {
			this.#submittedKey = sent.key;
			this.#notify();
		}
	}

	/** A cleared draft is a new message. */
	clear(): void {
		this.#submittedKey = null;
		this.#restoredSubmission = false;
		this.#commit({ text: "", mode: this.#state.mode, key: this.#mint() });
	}

	/** Acknowledging a send must never erase text typed while the request was in flight. */
	acknowledge(sent: Draft): void {
		if (this.#submittedKey === sent.key) this.#submittedKey = null;
		this.#restoredSubmission = false;
		if (this.#state.key === sent.key && this.#state.text === sent.text && this.#state.mode === sent.mode) {
			this.clear();
			return;
		}
		// Typing after the submitted text is the common case. Keep only the new
		// suffix; if the earlier text was edited, leave it intact for review.
		const text =
			this.#state.text !== sent.text && this.#state.text.startsWith(sent.text)
				? this.#state.text.slice(sent.text.length).trimStart()
				: this.#state.text;
		// The remaining draft is a new request. Reusing the acknowledged key would
		// make the server return the previous result instead of sending it.
		this.#commit({ ...this.#state, text, key: this.#state.key === sent.key ? this.#mint() : this.#state.key });
	}

	/** A definite refusal kept no message, so the same text may be sent as a new request. */
	refuse(sent: Draft): void {
		if (this.#submittedKey !== sent.key) return;
		this.#submittedKey = null;
		this.#restoredSubmission = false;
		if (this.#state.key === sent.key) this.#commit({ ...this.#state, key: this.#mint() });
		else this.#notify();
	}

	#commit(next: Draft): void {
		this.#state = next;
		this.#notify();
	}

	#notify(): void {
		for (const listener of this.#listeners) listener();
	}
}

function savedDraft(id: string): SavedDraft | undefined {
	try {
		const raw = sessionStorage.getItem(`${DRAFT_KEY}${id}`);
		if (!raw) return;
		const value: unknown = JSON.parse(raw);
		if (typeof value !== "object" || value === null) return;
		const draft = (value as { draft?: unknown }).draft;
		const submittedKey = (value as { submittedKey?: unknown }).submittedKey;
		if (typeof draft !== "object" || draft === null) return;
		const fields = draft as Partial<Draft>;
		if (
			typeof fields.text !== "string" ||
			typeof fields.key !== "string" ||
			!/^[!-~]{1,128}$/.test(fields.key) ||
			(fields.mode !== "next-slot" && fields.mode !== "end-of-turn")
		)
			return;
		return {
			draft: { text: fields.text, mode: fields.mode, key: fields.key },
			submittedKey: submittedKey === fields.key ? fields.key : null,
		};
	} catch {
		return;
	}
}

function persistDraft(id: string, store: DraftStore): void {
	try {
		const draft = store.snapshot();
		const key = `${DRAFT_KEY}${id}`;
		const index = storedDraftIds();
		if (draft.text === "") {
			sessionStorage.removeItem(key);
			sessionStorage.setItem(DRAFT_INDEX, JSON.stringify(index.filter((entry) => entry !== id)));
			return;
		}
		sessionStorage.setItem(
			key,
			JSON.stringify({ draft, submittedKey: store.submittedKey() === draft.key ? draft.key : null }),
		);
		if (index.includes(id)) return;
		index.push(id);
		while (index.length > MAX_DRAFT_STORES) {
			const oldest = index.shift();
			if (oldest) sessionStorage.removeItem(`${DRAFT_KEY}${oldest}`);
		}
		sessionStorage.setItem(DRAFT_INDEX, JSON.stringify(index));
	} catch {
		// The draft still lives in memory when browser storage is unavailable or full.
	}
}

export function draftStore(id: string): DraftStore {
	let store = stores.get(id);
	if (!store) {
		if (stores.size >= MAX_DRAFT_STORES) {
			const oldest = stores.keys().next().value;
			if (oldest !== undefined) stores.delete(oldest);
		}
		const created = new DraftStore(randomKey, savedDraft(id));
		created.subscribe(() => persistDraft(id, created));
		store = created;
	}
	stores.delete(id);
	stores.set(id, store);
	return store;
}
