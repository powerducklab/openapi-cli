/**
 * Public types for @powerduck/openapi-cli.
 */

export type ProtocolName =
  | "http"
  | "sse"
  | "websocket"
  | "graphql"
  | "grpc"
  | "mcp";

export type ReportFormat = "json" | "cli" | "html";

export type TestStatus = "passed" | "failed" | "skipped" | "error";

export interface AuthConfig {
  type: "bearer" | "basic" | "apikey" | "none";
  token?: string;
  username?: string;
  password?: string;
  key?: string;
  value?: string;
  in?: "header" | "query";
}

export interface TlsConfig {
  /** Path to a CA certificate bundle (PEM). */
  caCert?: string;
  /** Path to a client certificate (PEM) for mTLS. */
  clientCert?: string;
  /** Path to a client private key (PEM) for mTLS. */
  clientKey?: string;
  /** Skip TLS certificate verification (insecure). */
  strictSSL?: boolean;
}

export interface FilterConfig {
  /** Only test these HTTP methods (e.g. ["get","post"]). */
  methods?: string[];
  /** Only test paths matching any of these regex patterns. */
  paths?: string[];
  /** Only test operations with these tags. */
  tags?: string[];
  /** Only test these operationIds. */
  operationIds?: string[];
}

export interface CliConfig {
  /** Path to the OpenAPI 3.2 JSON file. */
  specPath: string;
  /** Override the server URL from the spec. */
  serverUrl?: string;
  /** Directory to write report files. Default: "./openapi-cli-report". */
  outputDir?: string;
  /** Report formats to generate. Default: ["json","cli","html"]. */
  formats?: ReportFormat[];
  /** Filter which operations to test. */
  filter?: FilterConfig;
  /** Max concurrent requests. Default: 5. */
  concurrency?: number;
  /** Per-request timeout in ms. Default: 30000. */
  timeout?: number;
  /** HTTP(S) proxy URL (e.g. http://proxy:8080). */
  proxy?: string;
  /** TLS / certificate configuration. */
  tls?: TlsConfig;
  /** Extra headers sent with every request. */
  headers?: Record<string, string>;
  /** Authentication configuration. */
  auth?: AuthConfig;
  /** Postman variables ({{name}}) to inject. */
  variables?: Record<string, string>;
  /** Exit with non-zero code if any test fails. Default: true. */
  failOnError?: boolean;
  /** Path to a .env file (KEY=VALUE per line). */
  envFile?: string;
  /** gRPC-specific: use server reflection. Default: true. */
  grpcReflection?: boolean;
  /** gRPC-specific: paths to .proto files or directories. */
  grpcProtoPaths?: string[];
  /** MCP-specific: transport for MCP operations. Default: "streamable-http". */
  mcpTransport?: "streamable-http" | "stdio";
  /** MCP stdio: command to spawn. */
  mcpCommand?: string;
  /** MCP stdio: command arguments. */
  mcpArgs?: string[];
  /** MCP stdio: working directory. */
  mcpCwd?: string;
}

export interface AssertionResult {
  name: string;
  passed: boolean;
  error?: string;
}

export interface TestResult {
  operationId: string;
  path: string;
  method: string;
  protocol: ProtocolName | string;
  status: TestStatus;
  durationMs: number;
  response?: {
    status?: number;
    statusText?: string;
    contentType?: string;
    sizeBytes?: number;
    body?: unknown;
    text?: string;
    headers?: Record<string, string>;
    events?: unknown[];
    streaming?: boolean;
  };
  assertions?: AssertionResult[];
  error?: string;
  timestamp: string;
}

export interface TestSummary {
  total: number;
  passed: number;
  failed: number;
  errors: number;
  skipped: number;
  durationMs: number;
  passRate: number;
}

export interface TestReport {
  summary: TestSummary;
  results: TestResult[];
  config: CliConfig;
  generatedAt: string;
  version: string;
}
