// SPDX-License-Identifier: LicenseRef-PanCode-1.0
// SPDX-FileCopyrightText: 2026 Anthony Kougkas
/**
 * Public surface of the MCP module: protocol framing, the protocol client
 * and the stdio and Streamable HTTP transports under it, strict configuration
 * loading, and explicit trust.
 */

export { mcpToolActionClass, mcpToolConfirmationRule, mcpToolOwner } from "./action-classes.js";
export {
	createMcpClient,
	createMcpHttpClient,
	createMcpProtocolClient,
	createMcpStdioClient,
	DEFAULT_KILL_GRACE_MS,
	DEFAULT_TEARDOWN_BOUND_MS,
	type McpClient,
	type McpClientOptions,
	type McpProgressUpdate,
	type McpServerInfo,
	type McpServerSpec,
	type McpToolListing,
} from "./client.js";
export { MCP_TOOL_LIST_CAP } from "./client-tools.js";
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
	describeValue,
	formContentErrors,
	type McpElicitationContext,
	type McpElicitationHost,
	type McpElicitationRequest,
	type McpElicitResult,
	type McpElicitValue,
	type McpFormElicitation,
	type McpUrlElicitation,
	readTypedValue,
} from "./elicitation.js";
export {
	type McpEventDescriptor,
	type McpEventListing,
	type McpEventOccurrence,
	mcpEventDeliveryMode,
	mcpEventErrorName,
	mcpEventErrorText,
} from "./events.js";
export {
	MCP_FILE_LIMITS,
	type McpDownloadTarget,
	type McpFileArgument,
	type McpFileInput,
	type McpFileTransferContext,
	type McpNamedFile,
	type McpResolvedTarget,
	type McpUploadRequest,
	type McpUploadTarget,
	mcpFileAccepted,
	mcpFileInput,
	mcpFileModelSchema,
	mcpFileSchema,
	mcpMultipartBody,
	mcpNamedFiles,
	resolveMcpTarget,
	withMcpFileInputs,
} from "./files.js";
export {
	type McpCachedPrompt,
	type McpCatalogIdentity,
	type McpResourceCount,
	type McpServerCatalog,
	mcpCatalogStale,
	mcpPromptsStale,
	readMcpServerCatalog,
	writeMcpServerCatalog,
} from "./metadata-cache.js";
export * from "./oauth.js";
export * from "./oauth-grants.js";
export { mcpPassedEnvironment } from "./passed-environment.js";
export {
	classifyJsonRpcMessage,
	createLineFramer,
	encodeJsonRpcMessage,
	JSON_RPC_INVALID_PARAMS,
	JSON_RPC_METHOD_NOT_FOUND,
	MCP_MISSING_REQUIRED_CLIENT_CAPABILITY,
	MCP_PROTOCOL_VERSION,
	MCP_RESOURCE_NOT_FOUND,
	McpError,
	parseJsonRpcLine,
} from "./protocol.js";
export {
	MCP_CREDENTIAL_KEY_CHARS,
	mcpCredentialRoutes,
	mcpDeclaredHeaderRefusal,
	mcpHeaderCredentialRef,
	mcpOriginOf,
	mcpRemoteEndpoint,
} from "./remote.js";
export {
	type McpHeaderCredentialStore,
	mcpCatalogDigest,
	mcpHeaderBindings,
	mcpHeaderValueRefusal,
	openMcpHeaderCredentialStore,
	resolveMcpHeaders,
} from "./remote-credentials.js";
export {
	isMcpAppResource,
	isMcpResourceNotFound,
	type McpCompletion,
	type McpCompletionReference,
	type McpPromptDescriptor,
	type McpPromptListing,
	type McpPromptResult,
	type McpResourceContents,
	type McpResourceListing,
	type McpResourceRead,
} from "./resources.js";
export {
	type McpAttestedSkill,
	readMcpSkillCatalog,
	writeMcpSkillCatalog,
} from "./skill-catalog.js";
export {
	boundedMcpSkillText,
	findMcpSkill,
	getMcpSkill,
	listMcpSkills,
	type McpSkillEntry,
	type McpSkillListing,
	type McpSkillsTransport,
	mcpClientSkills,
	mcpSkillDisplayNames,
	mcpSkillReferenceServer,
	mcpSkillRelativePath,
	mcpSkillsSettings,
} from "./skills.js";
export {
	judgeMcpSurface,
	type McpSurface,
	type McpSurfaceStatus,
	mcpSurface,
	mcpSurfaceDigest,
	mcpSurfaceRemedy,
} from "./surface.js";
export {
	DEFAULT_RESULT_TEXT_BYTES,
	type McpContentBlock,
	type McpElicitationOutcome,
	type McpToolCallResult,
	type McpToolDescriptor,
	outputSchemaMismatch,
	renderMcpContent,
	resourceLinkLine,
} from "./tool-results.js";
export type { McpTeardownOutcome, McpTransportEvents } from "./transport.js";
export {
	approveMcpSkill,
	approveMcpSurface,
	canonicalProjectRoot,
	currentMcpSkillApproval,
	currentMcpSurfaceApproval,
	judgeMcpSkillApproval,
	MCP_TRUST_ACTION_CLASSES,
	MCP_TRUST_CAPS,
	MCP_TRUST_FILENAME,
	type McpSkillApprovalStatus,
	type McpTrustActionClass,
	type McpTrustOptions,
	mcpSkillApprovalsFor,
	mcpTrustPath,
	type ResolvedMcpServer,
	readMcpTrustState,
	resolveMcpServers,
	revokeMcpSkill,
	revokeMcpUserTrust,
	trustMcpServer,
	untrustMcpServer,
} from "./trust.js";
