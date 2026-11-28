import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { parseRoster, RosterError, readRoster } from "./roster.ts";

const yaml = async (text: string): Promise<unknown> => JSON.parse(text);

describe("campaign roster", () => {
	it("defaults a label from target, model and thinking", () => {
		assert.deepEqual(
			parseRoster({
				roster: [
					{ target: "t", model: "m", thinking: "high" },
					{ target: "t", model: "n" },
				],
			}),
			[
				{ target: "t", model: "m", thinking: "high", label: "t/m@high" },
				{ target: "t", model: "n", thinking: null, label: "t/n" },
			],
		);
	});

	it("names the offending entry", () => {
		const cases: Array<[unknown, RegExp]> = [
			[null, /^roster: expected a mapping with one key, roster$/],
			[{ roster: [], extra: 1 }, /^extra: unknown key/],
			[{ roster: [] }, /^roster: expected a non-empty list/],
			[{ roster: [{ target: "t" }] }, /^roster\[0\]\.model: expected a non-empty string$/],
			[
				{ roster: [{ target: "t", model: "m", thinking: "huge" }] },
				/^roster\[0\]\.thinking: expected one of off, minimal/,
			],
			[{ roster: [{ target: "t", model: "m", cost: 1 }] }, /^roster\[0\]\.cost: unknown key/],
			[{ roster: [{ target: "t", model: "m", label: "-x" }] }, /^roster\[0\]\.label: use at most 80/],
			[
				{
					roster: [
						{ target: "t", model: "m" },
						{ target: "t", model: "m" },
					],
				},
				/^roster\[1\]\.label: "t\/m" names an earlier entry too/,
			],
		];
		for (const [document, pattern] of cases)
			assert.throws(
				() => parseRoster(document),
				(error: unknown) => error instanceof RosterError && pattern.test(error.message),
			);
	});

	it("reports text the host cannot parse, and text over 64 KiB, as roster errors", async () => {
		await assert.rejects(
			readRoster("{", yaml),
			(error: unknown) => error instanceof RosterError && /^roster: not valid YAML: /.test(error.message),
		);
		await assert.rejects(readRoster(" ".repeat(64 * 1024 + 1), yaml), /larger than 64 KiB/);
	});
});
