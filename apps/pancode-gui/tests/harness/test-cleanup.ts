// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { after } from "node:test";

/**
 * Runs `cleanup` when the test that called this ends, however it ends: node:test binds a hook made inside a
 * running test to that test, and runs it when a timeout cancels the test too. A harness registers here before
 * it boots, because a test cancelled mid-boot never reaches its own `t.after(h.close)`, and what the boot left
 * running kept the test file alive with no end. Only under the test runner, which marks each file's process
 * with NODE_TEST_CONTEXT: a script that boots a harness closes it itself, and a hook there would start a test
 * report.
 */
export function closeWithTest(cleanup: () => Promise<unknown>) {
	if (process.env.NODE_TEST_CONTEXT !== undefined) after(cleanup);
}
