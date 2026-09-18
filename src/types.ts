/**
 * Public types for @powerduck/openapi-cli.
 */
import type { RequestValues } from "@powerduck/openapi-request";
import type { DeclarativeAssertion } from "./assertions.js";

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

/**
 * Best-effort snapshot of the request actually sent, after variable
 * substitution and header merging. Secrets are included as sent; callers
 * decide what to redact before persisting or displaying.
 */
export interface RequestSnapshot {
  method?: string;
  /** Fully resolved URL for HTTP-style protocols. */
  url?: string;
  headers?: Record<string, string>;
  /** Request body, gRPC message, WS payload or MCP arguments. */
  body?: unknown;
  /** Protocol-specific target, e.g. "package.Service/Method" or an MCP tool. */
  target?: string;
}

export interface TestResult {
  operationId: string;
  path: string;
  method: string;
  protocol: ProtocolName | string;
  status: TestStatus;
  durationMs: number;
  /** Snapshot of the resolved request, when the protocol could capture it. */
  request?: RequestSnapshot;
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

/* ------------------------------------------------------------------ *
 * Scenario testing: ordered, stateful multi-step business flows.
 * ------------------------------------------------------------------ */

/** Pull a value out of one step's response into the shared scenario scope. */
export interface ScenarioExtract {
  /** Variable name written into the scenario scope. */
  name: string;
  /** Response part to read from. */
  from: "body" | "header" | "status";
  /** Dot/JSONPath into the JSON body when from="body" (e.g. "$.data.token"). */
  path?: string;
  /** Response header name when from="header". */
  key?: string;
}

/** Per-step request overrides and verification rules. */
export interface ScenarioStepRequest {
  /** Request values merged over the operation's sampled defaults. */
  values?: RequestValues;
  /** Override the resolved server URL for this step only. */
  serverUrl?: string;
  /** Declarative variables extracted after the response arrives. */
  extract?: ScenarioExtract[];
  /** Declarative assertions added on top of the operation's spec assertions. */
  assertions?: DeclarativeAssertion[];
}

/** A single ordered operation invocation inside a scenario. */
export interface ScenarioStep {
  /** Reference as "METHOD /path" (e.g. "POST /login") or an operationId. */
  ref?: string;
  /** Explicit method, paired with `path`; an alternative to `ref`. */
  method?: string;
  /** Explicit path, paired with `method`; an alternative to `ref`. */
  path?: string;
  /** Human-readable step label shown in reports and live events. */
  name?: string;
  request?: ScenarioStepRequest;
  /** Compile-time skip; the step is reported as skipped and never sent. */
  skip?: boolean;
}

/** A named, ordered sequence of operations with shared variable scope. */
export interface ScenarioDefinition {
  name: string;
  description?: string;
  steps: ScenarioStep[];
  /** Initial scenario variables, merged over CliConfig.variables. */
  variables?: Record<string, string>;
  /** Stop at the first failed/error step. Default: true. */
  stopOnFailure?: boolean;
}

export type ScenarioStatus = "passed" | "failed" | "error" | "cancelled";

/** Result of executing one scenario step. */
export interface ScenarioStepResult extends TestResult {
  /** Zero-based position in the scenario. */
  index: number;
  /** Resolved operation reference ("METHOD /path"). */
  ref: string;
  name?: string;
  /** Variables written by this step (declarative extraction + scripts). */
  extracted?: Record<string, string>;
  /** Full scenario variable scope after this step completed. */
  variablesAfter?: Record<string, string>;
  /** True when the step never executed (explicit skip or halted by a prior failure). */
  notRun?: boolean;
  notRunReason?: string;
}

export type ScenarioEventType =
  | "scenario:start"
  | "step:start"
  | "step:finish"
  | "step:skip"
  | "scenario:finish"
  | "scenario:cancel";

/** Live progress event emitted while a scenario runs. */
export interface ScenarioEvent {
  type: ScenarioEventType;
  scenario: string;
  stepIndex?: number;
  step?: ScenarioStepResult;
  status?: ScenarioStatus;
  message?: string;
}

/** Aggregate result of a full scenario execution. */
export interface ScenarioReport {
  name: string;
  description?: string;
  status: ScenarioStatus;
  summary: TestSummary;
  steps: ScenarioStepResult[];
  /** Final shared variable scope. */
  variables: Record<string, string>;
  config: CliConfig;
  startedAt: string;
  durationMs: number;
  generatedAt: string;
  version: string;
}

/** Options for {@link runScenario}. */
export interface RunScenarioOptions {
  /** Runner configuration (server, auth, proxy, TLS, timeouts, ...). */
  config: CliConfig;
  /** Pre-parsed spec document; when omitted it is loaded from config.specPath. */
  spec?: unknown;
  /** Live progress callback, invoked defensively (a throw never aborts the run). */
  onEvent?: (event: ScenarioEvent) => void;
  /** Aborting cancels the scenario; remaining steps are reported as skipped. */
  signal?: AbortSignal;
}
