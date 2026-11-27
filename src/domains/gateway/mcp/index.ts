// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * Public surface of the MCP module: protocol framing, the protocol client
 * and the stdio and Streamable HTTP transports under it, strict configuration
 * loading, and explicit trust.
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
	createMcpClient,
	createMcpHttpClient,
	createMcpProtocolClient,
	createMcpStdioClient,
	DEFAULT_KILL_GRACE_MS,
	DEFAULT_RESULT_TEXT_BYTES,
	DEFAULT_TEARDOWN_BOUND_MS,
	MCP_INSTRUCTIONS_BYTES,
	MCP_TOOL_LIST_CAP,
	type McpCallToolOptions,
	type McpClient,
	type McpClientOptions,
	type McpContentBlock,
	type McpHttpServerSpec,
	type McpProgressUpdate,
	type McpProtocolClientOptions,
	type McpServerInfo,
	type McpServerSpec,
	type McpSubscription,
	type McpSubscriptionFilter,
	type McpTeardownOutcome,
	type McpToolCallResult,
	type McpToolDescriptor,
	type McpToolListing,
	type McpTransport,
	type McpTransportEvents,
	mcpRequiredCapabilities,
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
	mcpCatalogStale,
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
	MCP_MISSING_REQUIRED_CLIENT_CAPABILITY,
	MCP_PROTOCOL_VERSION,
	MCP_RESOURCE_NOT_FOUND,
	McpError,
	type McpErrorCode,
	type ProtocolFrame,
	parseJsonRpcLine,
} from "./protocol.js";
export {
	MCP_CREDENTIAL_KEY_CHARS,
	MCP_CREDENTIAL_KEY_PATTERN,
	mcpCredentialKeyRefusal,
	mcpCredentialRoutes,
	mcpDeclaredHeaderRefusal,
	mcpHeaderCredentialRef,
	mcpOriginOf,
	mcpRemoteEndpoint,
	parseMcpHeaderCredentialRef,
} from "./remote.js";
export {
	type McpHeaderBinding,
	type McpHeaderCredentialStore,
	mcpCatalogDigest,
	mcpHeaderBindings,
	mcpHeaderValueRefusal,
	openMcpHeaderCredentialStore,
	resolveMcpHeaders,
} from "./remote-credentials.js";
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
