// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas

/**
 * The loopback port the proxy listens on inside a proxied sandbox. Every launch
 * has its own network namespace, so one fixed port never collides.
 */
export const EGRESS_PROXY_PORT = 3128;

/** How long the in-sandbox setup may take to bind and hand over its listener before it gives up. */
const SETUP_TIMEOUT_MS = 15_000;

/** Exit code of a launch whose egress setup failed; the command never ran. */
export const EGRESS_SETUP_FAILED_EXIT = 125;

/** The proxy's reason for an origin outside the launch's grants, the one denial a grant can lift. */
export const EGRESS_UNGRANTED = "not in this shell's egress grants";

/** What the bwrap argv builder needs to put the setup ahead of the command. */
export interface EgressBridgeSetup {
	execPath: string;
	port: number;
}

/**
 * Runs inside the sandbox's network namespace on the IPC descriptor the exec
 * seam opened: binds the proxy's loopback port, sends the listening socket to
 * the host, waits for the host's ready, then closes its copy and exits.
 */
const SETUP_JS = [
	'"use strict";',
	'const net = require("node:net");',
	"const port = Number(process.argv[1]);",
	'const fail = (m) => { process.stderr.write("pancode: egress proxy setup failed: " + m + "\\n"); process.exit(1); };',
	`const timer = setTimeout(() => fail("the host did not take the listener"), ${SETUP_TIMEOUT_MS});`,
	"if (typeof process.send !== 'function') fail('no channel to the host');",
	"const server = net.createServer();",
	'server.on("error", (e) => fail(e.message));',
	'server.listen({ port, host: "127.0.0.1" }, () => process.send({ t: "pancode-egress-listener" }, server));',
	'process.on("message", (m) => { if (m && m.t === "pancode-egress-ready") { clearTimeout(timer); server.close(); process.disconnect(); } });',
	'process.on("disconnect", () => { if (server.listening) fail("the host closed the channel"); });',
].join("\n");

/**
 * The shell that runs the setup, then closes the channel descriptor and drops
 * Node's channel variables before it execs the command, so the command holds
 * no control channel. A failed setup exits without running the command.
 */
const SETUP_SH = [
	`NODE_OPTIONS= "$1" -e "$2" "$3" || exit ${EGRESS_SETUP_FAILED_EXIT}`,
	"exec 3>&-",
	"unset NODE_CHANNEL_FD NODE_CHANNEL_SERIALIZATION_MODE",
	"shift 3",
	'exec "$@"',
].join("\n");

/** The argv that goes ahead of the command inside the sandbox. */
export function egressSetupArgv(setup: EgressBridgeSetup): string[] {
	return ["/bin/sh", "-c", SETUP_SH, "pancode-egress", setup.execPath, SETUP_JS, String(setup.port)];
}

/**
 * Proxy variables set inside a proxied launch. Every client this covers sees
 * only the loopback proxy, and the bypass list replaces the parent's with the
 * sandbox's own loopback, where a server the command started is reachable
 * directly; a parent's proxy and bypass hosts never pass through.
 */
export function egressProxyEnv(port: number): Record<string, string> {
	const http = `http://127.0.0.1:${port}`;
	const socks = `socks5h://127.0.0.1:${port}`;
	const loopback = "localhost,127.0.0.1,::1";
	return {
		HTTP_PROXY: http,
		HTTPS_PROXY: http,
		http_proxy: http,
		https_proxy: http,
		ALL_PROXY: socks,
		all_proxy: socks,
		NO_PROXY: loopback,
		no_proxy: loopback,
		npm_config_proxy: http,
		npm_config_https_proxy: http,
		npm_config_noproxy: loopback,
		NODE_USE_ENV_PROXY: "1",
	};
}
