// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
import { spawn } from "node:child_process";
import { request as httpRequest } from "node:http";
import { fileURLToPath } from "node:url";
import { exchangeLaunchTicket } from "./exchange.js";
import { closeWithTest } from "./test-cleanup.js";
export async function processServer(env: NodeJS.ProcessEnv) {
	const child = spawn(
		process.execPath,
		["--import", "tsx", fileURLToPath(new URL("../../server/main.ts", import.meta.url))],
		{
			cwd: fileURLToPath(new URL("../../", import.meta.url)),
			env: {
				...env,
				PANCODE_WEB_CLI:
					env.PANCODE_WEB_CLI ?? fileURLToPath(new URL("../fixtures/acp-fixture-child.mjs", import.meta.url)),
			},
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
	closeWithTest(async () => {
		if (child.exitCode === null && child.signalCode === null) {
			child.kill("SIGKILL");
			await exited;
		}
	});
	let stdout = "",
		stderr = "";
	child.stderr.on("data", (chunk) => {
		stderr += String(chunk);
	});
	// Boot ends when the server prints its launch URL or exits; a loaded host only makes it slower.
	const launch = await new Promise<URL>((resolve, reject) => {
		child.once("error", reject);
		child.once("exit", () => reject(new Error(`Server exited before launch: ${stderr}`)));
		child.stdout.on("data", (chunk) => {
			stdout += String(chunk);
			const match = stdout.match(/http:\/\/127\.0\.0\.1:\d+\/[^\s#]*#ticket=[\w-]+/);
			if (match) resolve(new URL(match[0]));
		});
	});
	const ticket = new URLSearchParams(launch.hash.slice(1)).get("ticket");
	const credential = await exchangeLaunchTicket(launch, ticket ?? "");
	const request = (path: string, method = "GET", body?: unknown) =>
		new Promise<Response>((resolve, reject) => {
			const call = httpRequest(
				new URL(path, launch),
				{
					method,
					headers: {
						Authorization: `Bearer ${credential}`,
						...(body === undefined
							? {}
							: {
									"Content-Type": "application/json",
									"Content-Length": String(Buffer.byteLength(JSON.stringify(body))),
									"Idempotency-Key": crypto.randomUUID(),
								}),
					},
				},
				(response) => {
					const chunks: Buffer[] = [];
					response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
					response.on("end", () =>
						resolve(
							new Response(Buffer.concat(chunks), {
								status: response.statusCode ?? 500,
								headers: { "Content-Type": String(response.headers["content-type"] ?? "") },
							}),
						),
					);
				},
			);
			call.on("error", reject);
			call.end(body === undefined ? undefined : JSON.stringify(body));
		});
	return {
		child,
		url: launch.href,
		pid: child.pid ?? 0,
		request,
		post: (path: string, body: unknown = {}) => request(path, "POST", body),
		async close(signal: "SIGTERM" | "SIGKILL" = "SIGTERM") {
			child.kill(signal);
			await exited;
		},
	};
}
