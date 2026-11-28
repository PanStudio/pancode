// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/** A task as the project lists it: its id and the title the task list shows. */
export interface ScopeTask {
	readonly id: string;
	readonly title: string;
}

const LISTED = 5;

/** Recorded sessions are named by their task's title; the id stands in only when no task lists that session. */
export function sessionTitle(sessionId: string, titles: ReadonlyMap<string, string>) {
	return titles.get(sessionId) ?? sessionId.slice(0, 12);
}

function quoted(tasks: readonly ScopeTask[]) {
	const shown = tasks.slice(0, LISTED).map((task) => `“${task.title}”`);
	const more = tasks.length - shown.length;
	return more > 0 ? `${shown.join(", ")} and ${more} more` : shown.join(", ");
}

function tasksWord(count: number) {
	return count === 1 ? "session" : "sessions";
}

/**
 * Which of the scope's tasks the recorded metrics cover, in plain words. A task without a usage record is named,
 * so a short table never reads as the whole project. Null while the scope lists no tasks. Metrics read for one
 * task speak only of that task: other tasks are outside what was read, not missing from it.
 */
export function metricsScopeNote(input: {
	readonly recorded: readonly string[];
	readonly recordedCount: number;
	readonly tasks: readonly ScopeTask[];
	readonly project: boolean;
	readonly session?: string;
}): string | null {
	if (input.session !== undefined)
		return input.recorded.includes(input.session) ? null : "PanCode has no usage record for this session yet.";
	const { tasks } = input;
	if (!tasks.length) return null;
	const recorded = new Set(input.recorded);
	const missing = tasks.filter((task) => !recorded.has(task.id));
	const whole = input.project ? `this project's ${tasks.length}` : `the ${tasks.length} listed`;
	// A session that ended before its first model turn is recorded but never listed as a task.
	const listed = new Set(tasks.map((task) => task.id));
	const unlisted =
		input.recorded.length === input.recordedCount ? input.recorded.filter((id) => !listed.has(id)).length : 0;
	const beyond = unlisted
		? ` ${unlisted} more recorded ${unlisted === 1 ? "session is" : "sessions are"} not in the session list, so ${unlisted === 1 ? "it is" : "they are"} named by id.`
		: "";
	if (!missing.length) return `Covers all of ${whole} ${tasksWord(tasks.length)}.${beyond}`;
	if (input.recorded.length < input.recordedCount)
		return `Shows the ${input.recorded.length} most recent of ${input.recordedCount} recorded sessions. Not shown here, because they are older or have no usage record yet: ${quoted(missing)}.`;
	const counted = tasks.length - missing.length;
	return `Covers ${counted} of ${whole} ${tasksWord(tasks.length)}. Not counted, because PanCode has no usage record for ${missing.length === 1 ? "it" : "them"} yet: ${quoted(missing)}.${beyond}`;
}

/** The metrics header count: how many recorded sessions the table lists, out of all recorded in scope. */
export function recordedSessionsLabel(shown: number, recorded: number) {
	return shown === recorded
		? `${recorded} recorded ${recorded === 1 ? "session" : "sessions"}`
		: `${shown} most recent of ${recorded} recorded sessions`;
}
