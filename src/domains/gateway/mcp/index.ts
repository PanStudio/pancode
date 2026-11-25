// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * Public surface of the local stdio MCP module: protocol framing, the
 * one-process client, strict configuration loading, and explicit trust.
 */

export { mcpToolActionClass, mcpToolConfirmationRule, mcpToolOwner } from "./action-classes.js";
export {
	defaultMcpBuiltinSource,
	type McpBuiltinLaunchContext,
	type McpBuiltinSource,
	mcpBuiltinLaunchArgs,
	mcpBuiltinLaunchEnvironment,
} from "./builtin.js";
export {
	createMcpStdioClient,
	DEFAULT_KILL_GRACE_MS,
	DEFAULT_TEARDOWN_BOUND_MS,
	MCP_TOOL_LIST_CAP,
	type McpClient,
	type McpClientOptions,
	type McpServerSpec,
	type McpTeardownOutcome,
	type McpToolCallResult,
	type McpToolDescriptor,
	type McpToolListing,
	renderMcpContent,
} from "./client.js";
export {
	loadMcpServerConfig,
	MCP_CONFIG_CAPS,
	MCP_CONFIG_VERSION,
	MCP_PROJECT_CONFIG_RELATIVE_PATH,
	MCP_USER_CONFIG_FILENAME,
	type McpConfigLoadResult,
	type McpPathArgumentAccess,
	type McpServerEntryScript,
	type McpToolPathArguments,
	mcpConfigPaths,
	mcpServerDigest,
	mcpServerFileArguments,
	parseMcpConfigText,
	pluginServerRevocation,
} from "./config.js";
export {
	type McpCatalogIdentity,
	type McpServerCatalog,
	readMcpServerCatalog,
	writeMcpServerCatalog,
} from "./metadata-cache.js";
export {
	classifyJsonRpcMessage,
	createLineFramer,
	DEFAULT_MAX_LINE_BYTES,
	encodeJsonRpcMessage,
	JSON_RPC_INVALID_PARAMS,
	JSON_RPC_METHOD_NOT_FOUND,
	type JsonRpcErrorObject,
	type JsonRpcId,
	type JsonRpcMessage,
	type JsonRpcNotification,
	type JsonRpcRequest,
	type JsonRpcResponse,
	type LineFramer,
	MCP_PROTOCOL_VERSION,
	McpError,
	type McpErrorCode,
	type ProtocolFrame,
	parseJsonRpcLine,
} from "./protocol.js";
export {
	judgeMcpSurface,
	type McpSurface,
	type McpSurfaceStatus,
	mcpSurface,
	mcpSurfaceDigest,
	mcpSurfaceRemedy,
	mcpSurfaceRemedyFor,
} from "./surface.js";
export {
	approveMcpSurface,
	canonicalProjectRoot,
	currentMcpSurfaceApproval,
	grantMcpBuiltinNetwork,
	MCP_TRUST_ACTION_CLASSES,
	MCP_TRUST_CAPS,
	MCP_TRUST_FILENAME,
	type McpTrustActionClass,
	type McpTrustOptions,
	mcpBuiltinTrustRefusal,
	mcpTrustPath,
	type ResolvedMcpServer,
	readMcpTrustState,
	resolveMcpServers,
	revokeMcpBuiltinNetwork,
	trustMcpServer,
	untrustMcpServer,
} from "./trust.js";
