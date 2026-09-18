/**
 * Batch test runner. Iterates over all operations in an OpenAPI spec,
 * executes each via @powerduck/openapi-request, runs assertions, and collects
 * results. Supports HTTP, SSE, GraphQL, gRPC (unary/server-streaming),
 * MCP (one-shot), and WebSocket (connect-send-close).
 */
import { createClient } from "@powerduck/openapi-request";
import fs from "node:fs";
import type { CliConfig, TestReport, TestResult, TestSummary } from "./types.js";
import { loadSpec } from "./config.js";
import {
  extractAssertions,
  extractPostmanScripts,
  runDeclarativeAssertions,
  type DeclarativeAssertion,
} from "./assertions.js";

const VERSION = "0.1.0";

export interface OperationInfo {
  path: string;
  method: string;
  operation: any;
  pathItem: any;
  operationId: string;
  protocol: string;
}

/** Extract a readable message from any assertion error shape. */
export function formatAssertionError(err: unknown): string | undefined {
  if (!err) return undefined;
  if (typeof err === "string") return err;
  if (err instanceof Error) return err.message;
  const obj = err as Record<string, unknown>;
  if (typeof obj.message === "string") return obj.message;
  if (typeof obj.msg === "string") return obj.msg;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

/**
 * Build implicit assertions when the user defined none.
 *
 * Conventional success criteria per protocol:
 *   HTTP / SSE : HTTP status 2xx (200-299)
 *   GraphQL    : HTTP status 2xx AND no top-level "errors" array in the body
 *   gRPC       : status code 0 (OK)
 *   MCP        : JSON-RPC response has a "result" and no "error"
 *   WebSocket  : connection reached the "open" state
 */
export function buildImplicitAssertions(
  protocol: string,
  response: TestResult["response"],
): Array<{ name: string; passed: boolean; error?: string }> {
  const out: Array<{ name: string; passed: boolean; error?: string }> = [];

  if (protocol === "http" || protocol === "sse") {
    const status = response?.status;
    const ok = typeof status === "number" && status >= 200 && status < 300;
    out.push({
      name: "HTTP status is 2xx (implicit)",
      passed: ok,
      error: ok ? undefined : `expected 2xx, got ${status ?? "no status"}`,
    });
  } else if (protocol === "graphql") {
    const status = response?.status;
    const statusOk = typeof status === "number" && status >= 200 && status < 300;
    const body = response?.body as any;
    const hasGraphQLErrors = Array.isArray(body?.errors) && body.errors.length > 0;
    const ok = statusOk && !hasGraphQLErrors;
    let error: string | undefined;
    if (!statusOk) error = `expected HTTP 2xx, got ${status ?? "no status"}`;
    else if (hasGraphQLErrors) error = `GraphQL response contains ${body.errors.length} error(s)`;
    out.push({
      name: "GraphQL success (implicit)",
      passed: ok,
      error,
    });
  } else if (protocol === "grpc") {
    const code = (response as any)?.statusCode ?? (response as any)?.code;
    const statusName = (response as any)?.statusName ?? (response as any)?.status;
    const ok = code === 0;
    out.push({
      name: "gRPC status is OK (implicit)",
      passed: ok,
      error: ok ? undefined : `expected code 0 (OK), got ${code ?? "unknown"}${statusName ? ` (${statusName})` : ""}`,
    });
  } else if (protocol === "mcp") {
    const body = (response as any)?.body ?? {};
    const hasResult = body.result !== undefined;
    const hasError = body.error !== undefined || (response as any)?.error !== undefined;
    const ok = hasResult && !hasError;
    let error: string | undefined;
    if (hasError) error = "MCP JSON-RPC response contains an error";
    else if (!hasResult) error = "MCP JSON-RPC response missing 'result'";
    out.push({
      name: "MCP JSON-RPC success (implicit)",
      passed: ok,
      error,
    });
  } else if (protocol === "websocket") {
    const events = (response as any)?.events ?? [];
    const opened = events.some((e: any) => e.kind === "open" || e.state === "open");
    const hasError = events.some((e: any) => e.kind === "error" || e.state === "error");
    const ok = opened && !hasError;
    out.push({
      name: "WebSocket connected (implicit)",
      passed: ok,
      error: ok ? undefined : hasError ? "WebSocket connection errored" : "WebSocket did not reach open state",
    });
  }

  return out;
}

/**
 * Run all tests defined in the spec.
 */
export async function runTests(config: CliConfig): Promise<TestReport> {
  const spec = await loadSpec(config);
  const client = createClient();
  const operations = collectOperations(spec, config);

  const startedAt = Date.now();
  const results: TestResult[] = [];

  // Execute with bounded concurrency.
  const queue = [...operations];
  const workers = Math.min(config.concurrency ?? 5, queue.length);
  const workerFns: Promise<void>[] = [];

  for (let i = 0; i < workers; i++) {
    workerFns.push(
      (async () => {
        while (queue.length > 0) {
          const op = queue.shift();
          if (!op) break;
          const result = await executeOperation(client, op, config, spec);
          results.push(result);
        }
      })(),
    );
  }
  await Promise.all(workerFns);

  const durationMs = Date.now() - startedAt;
  const summary = buildSummary(results, durationMs);

  return {
    summary,
    results: results.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method)),
    config,
    generatedAt: new Date().toISOString(),
    version: VERSION,
  };
}

export function collectOperations(spec: any, config: CliConfig): OperationInfo[] {
  const ops: OperationInfo[] = [];
  const methods = ["get", "post", "put", "delete", "patch", "head", "options"];

  for (const [path, pathItemRaw] of Object.entries(spec.paths ?? {})) {
    const pathItem = pathItemRaw as Record<string, any>;
    for (const method of methods) {
      const operation = pathItem[method];
      if (!operation || typeof operation !== "object") continue;

      const opInfo: OperationInfo = {
        path,
        method,
        operation,
        pathItem,
        operationId: operation.operationId ?? `${method.toUpperCase()} ${path}`,
        protocol: inferProtocol(operation, pathItem),
      };

      if (matchesFilter(opInfo, config.filter)) {
        ops.push(opInfo);
      }
    }
  }
  return ops;
}

function inferProtocol(operation: any, pathItem: any): string {
  const xProtocol = operation["x-protocol"] ?? pathItem?.["x-protocol"];
  if (xProtocol) return String(xProtocol).toLowerCase();

  // Detect SSE from response content type.
  const responses = operation.responses ?? {};
  for (const resp of Object.values(responses) as any[]) {
    const content = resp?.content ?? {};
    if (content["text/event-stream"]) return "sse";
  }
  if (operation["x-response-stream"]) return "sse";

  return "http";
}

function matchesFilter(op: OperationInfo, filter?: CliConfig["filter"]): boolean {
  if (!filter) return true;
  if (filter.methods?.length && !filter.methods.includes(op.method.toLowerCase())) return false;
  if (filter.operationIds?.length && !filter.operationIds.includes(op.operationId)) return false;
  if (filter.tags?.length) {
    const opTags = (op.operation.tags ?? []) as string[];
    if (!filter.tags.some((t) => opTags.includes(t))) return false;
  }
  if (filter.paths?.length) {
    const matched = filter.paths.some((pattern) => {
      try {
        return new RegExp(pattern).test(op.path);
      } catch {
        return op.path.includes(pattern);
      }
    });
    if (!matched) return false;
  }
  return true;
}

export interface StepExecutionOptions {
  config: CliConfig;
  spec: any;
  /** Active variable scope injected as {{name}} values. */
  variables?: Record<string, string>;
  /** Per-step request values (path/query/header/body). */
  values?: any;
  /** Override the resolved server URL for this invocation. */
  serverUrl?: string;
  /** Declarative assertions added beyond those declared on the operation. */
  extraAssertions?: DeclarativeAssertion[];
}

export interface StepExecution {
  result: TestResult;
  response: TestResult["response"];
  /** Resolved request snapshot for the result card. */
  request?: TestResult["request"];
  /** Variable scope produced by Postman scripts during this step. */
  env: Record<string, string>;
}

async function executeOperation(
  client: ReturnType<typeof createClient>,
  op: OperationInfo,
  config: CliConfig,
  spec: any,
): Promise<TestResult> {
  const execution = await executeStep(client, op, {
    config,
    spec,
    variables: config.variables,
  });
  return execution.result;
}

/**
 * Execute a single operation with per-step overrides and return the result,
 * the normalized response, and any variables produced by its scripts. Shared
 * by the batch runner (runTests) and the ordered scenario engine (runScenario).
 */
export async function executeStep(
  client: ReturnType<typeof createClient>,
  op: OperationInfo,
  options: StepExecutionOptions,
): Promise<StepExecution> {
  const { config, spec } = options;
  const startedAt = Date.now();
  const base: Omit<TestResult, "status" | "durationMs" | "timestamp"> = {
    operationId: op.operationId,
    path: op.path,
    method: op.method.toUpperCase(),
    protocol: op.protocol,
  };

  try {
    const specAssertions = extractAssertions(op.operation, op.pathItem);
    const assertions = [...specAssertions, ...(options.extraAssertions ?? [])];
    const postmanTest = extractPostmanScripts(op.operation);
    const postmanAssertions: any[] = [];

    let responseData: TestResult["response"];
    let requestSnapshot: TestResult["request"];
    let env: Record<string, string> = {};

    switch (op.protocol) {
      case "grpc": {
        const grpc = await executeGrpc(client, op, config, options.serverUrl);
        responseData = grpc.response;
        requestSnapshot = grpc.request;
        break;
      }
      case "websocket": {
        const ws = await executeWebSocket(client, op, config, options.serverUrl);
        responseData = ws.response;
        requestSnapshot = ws.request;
        break;
      }
      case "mcp": {
        const mcp = await executeMcp(client, op, config, options.serverUrl);
        responseData = mcp.response;
        requestSnapshot = mcp.request;
        break;
      }
      case "graphql":
      case "sse":
      case "http":
      default: {
        const http = await executeHttp(client, op, config, spec, {
          postmanTest,
          postmanAssertions,
          variables: options.variables,
          values: options.values,
          serverUrl: options.serverUrl,
        });
        responseData = http.response;
        requestSnapshot = http.request;
        env = http.env;
        break;
      }
    }

    const durationMs = Date.now() - startedAt;

    // If the operation defines no assertions, add an implicit status check
    // so that 4xx/5xx responses are not silently marked as passed.
    const hasUserAssertions = assertions.length > 0 || postmanAssertions.length > 0;
    const implicitAssertions = !hasUserAssertions
      ? buildImplicitAssertions(op.protocol, responseData)
      : [];

    // Run declarative assertions.
    const declResults = assertions.length
      ? runDeclarativeAssertions(assertions, {
          status: responseData?.status,
          headers: responseData ? (responseData as any).headers : undefined,
          body: responseData?.body,
          bodyText: responseData ? (responseData as any).text : undefined,
          durationMs,
        })
      : [];

    // Deduplicate postman assertions (onAssertion may fire twice per test).
    const seenPostman = new Set<string>();
    const dedupedPostman = postmanAssertions.filter((a) => {
      const key = `${a.name}|${a.passed}|${a.error ?? ""}`;
      if (seenPostman.has(key)) return false;
      seenPostman.add(key);
      return true;
    });

    const allAssertions = [...declResults, ...dedupedPostman, ...implicitAssertions];
    const hasFailures = allAssertions.some((a) => !a.passed);

    const result: TestResult = {
      ...base,
      status: hasFailures ? "failed" : "passed",
      durationMs,
      request: requestSnapshot,
      response: responseData,
      assertions: allAssertions.length ? allAssertions : undefined,
      timestamp: new Date().toISOString(),
    };
    return { result, response: responseData, request: requestSnapshot, env };
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    const stepValues = options.values as
      | { header?: Record<string, unknown>; body?: unknown }
      | undefined;
    const rawHeaders = {
      ...(config.headers ?? {}),
      ...(stepValues?.header ?? {}),
    };
    const headers = Object.fromEntries(
      Object.entries(rawHeaders).map(([key, value]) => [
        key,
        value == null ? "" : String(value),
      ]),
    );
    const fallbackRequest: TestResult["request"] = {
      method: op.method.toUpperCase(),
      url: options.serverUrl ?? config.serverUrl,
      ...(Object.keys(headers).length ? { headers } : {}),
      ...(stepValues?.body !== undefined ? { body: stepValues.body } : {}),
    };
    const result: TestResult = {
      ...base,
      status: "error",
      durationMs,
      request: fallbackRequest,
      error: (error as Error).message ?? String(error),
      timestamp: new Date().toISOString(),
    };
    return { result, response: undefined, request: fallbackRequest, env: {} };
  }
}

interface HttpStepContext {
  postmanTest: string | undefined;
  postmanAssertions: any[];
  variables?: Record<string, string>;
  values?: any;
  serverUrl?: string;
}

async function executeHttp(
  client: ReturnType<typeof createClient>,
  op: OperationInfo,
  config: CliConfig,
  spec: any,
  ctx: HttpStepContext,
): Promise<{
  response: TestResult["response"];
  request: TestResult["request"];
  env: Record<string, string>;
}> {
  const runnerOptions: any = {};
  if (config.proxy) {
    try {
      const proxyUrl = new URL(config.proxy);
      runnerOptions.proxies = [{
        match: "*://*/*",
        host: proxyUrl.hostname,
        port: proxyUrl.port ? Number(proxyUrl.port) : (proxyUrl.protocol === "https:" ? 443 : 80),
        tunnel: true,
      }];
    } catch {
      throw new Error(`Invalid proxy URL: ${config.proxy}`);
    }
  }

  // TLS / certificate options passed through to the underlying requester.
  const tls = config.tls;
  if (tls) {
    const requester: any = { ...(runnerOptions.requester ?? {}) };
    if (tls.strictSSL === false) requester.strictSSL = false;
    if (tls.caCert) requester.ca = fs.readFileSync(tls.caCert);
    if (tls.clientCert) requester.cert = fs.readFileSync(tls.clientCert);
    if (tls.clientKey) requester.key = fs.readFileSync(tls.clientKey);
    if (Object.keys(requester).length) runnerOptions.requester = requester;
  }

  // Per-step values override sampled defaults; global headers merge underneath.
  const stepValues = ctx.values as { header?: Record<string, unknown> } | undefined;
  const mergedHeader: Record<string, unknown> = {
    ...(config.headers ?? {}),
    ...(stepValues?.header ?? {}),
  };
  const values: any = {
    ...(config.headers ? { header: config.headers } : {}),
    ...(stepValues ?? {}),
    ...(Object.keys(mergedHeader).length ? { header: mergedHeader } : {}),
  };

  const result = await client.send({
    spec,
    target: { path: op.path, method: op.method },
    serverUrl: ctx.serverUrl ?? config.serverUrl,
    values: Object.keys(values).length ? values : undefined,
    auth: config.auth,
    variables: ctx.variables,
    timeout: config.timeout,
    runner: Object.keys(runnerOptions).length ? runnerOptions : undefined,
    scripts: ctx.postmanTest
      ? { test: { exec: ctx.postmanTest }, fromSpecExtensions: false }
      : undefined,
    onAssertion: (a: any) => {
      ctx.postmanAssertions.push({
        name: a.name ?? "assertion",
        passed: a.passed,
        error: formatAssertionError(a.error),
      });
    },
    maxStreamMs: config.timeout,
    maxEvents: 50,
  });

  // Merge the full variable-scope snapshots produced by pre-request and test
  // scripts so the scenario engine can chain values across ordered steps.
  const env: Record<string, string> = {};
  const scriptReport = (result as any).scripts as
    | {
        prerequest?: Array<{ environment?: Record<string, string> }>;
        test?: Array<{ environment?: Record<string, string> }>;
      }
    | undefined;
  if (scriptReport) {
    for (const outcome of [...(scriptReport.prerequest ?? []), ...(scriptReport.test ?? [])]) {
      if (outcome.environment) Object.assign(env, outcome.environment);
    }
  }

  const request = (result as { request?: TestResult["request"] }).request;
  return {
    response: {
      status: result.response?.status,
      statusText: result.response?.statusText,
      contentType: result.response?.contentType,
      sizeBytes: result.response?.sizeBytes,
      body: result.response?.body,
      text: (result.response as any)?.text,
      headers: result.response?.headers,
      events: (result.response as any)?.events,
      streaming: (result.response as any)?.streaming,
    },
    request: request
      ? {
          method: request.method,
          url: request.url,
          headers: request.headers,
          ...(request.body !== undefined ? { body: request.body } : {}),
        }
      : undefined,
    env,
  };
}

async function executeGrpc(
  client: ReturnType<typeof createClient>,
  op: OperationInfo,
  config: CliConfig,
  serverUrl?: string,
): Promise<{ response: TestResult["response"]; request: TestResult["request"] }> {
  const xGrpc = op.operation["x-grpc"] ?? {};
  const address = xGrpc.address ?? (serverUrl ?? config.serverUrl)?.replace(/^https?:\/\//, "");
  if (!address) throw new Error("gRPC operation requires x-grpc.address or --server");

  const session = client.connect({
    kind: "grpc",
    address,
    service: xGrpc.service,
    method: xGrpc.method ?? op.operationId,
    reflection: config.grpcReflection,
    protoPaths: config.grpcProtoPaths,
    metadata: config.headers,
  });

  await session.open();
  const kind = (session as any).kind as string;

  // Send a sample or empty message.
  const sample = buildGrpcSample(op.operation);
  if (kind === "unary" || kind === "server_streaming") {
    await session.send(sample);
  } else {
    // client / bidi: send one message then finish.
    await session.send(sample);
    await session.close();
  }

  const events = (session as any).events ?? [];
  const statusEvent = events.find((e: any) => e.kind === "status");
  // gRPC events use "inbound"/"outbound" (not "in"/"out").
  const dataEvents = events.filter((e: any) => e.kind === "data" && e.direction === "inbound");

  if (kind === "unary" || kind === "server_streaming") {
    await session.close();
  }

  const response: TestResult["response"] = {
    status: statusEvent?.meta?.code ?? 0,
    statusText: statusEvent?.meta?.statusName,
    body: dataEvents.length === 1 ? dataEvents[0].data : dataEvents.map((e: any) => e.data),
    events: events.map((e: any) => ({ kind: e.kind, direction: e.direction, data: e.data, meta: e.meta })),
  };
  const grpcMethod = xGrpc.method ?? op.operationId;
  return {
    response,
    request: {
      method: grpcMethod,
      target: xGrpc.service ? `${xGrpc.service}/${grpcMethod}` : grpcMethod,
      url: address,
      ...(Object.keys(sample).length ? { body: sample } : {}),
      ...(config.headers ? { headers: config.headers } : {}),
    },
  };
}

async function executeWebSocket(
  client: ReturnType<typeof createClient>,
  op: OperationInfo,
  config: CliConfig,
  serverUrl?: string,
): Promise<{ response: TestResult["response"]; request: TestResult["request"] }> {
  const xWs = op.operation["x-ws"] ?? {};
  const url = xWs.url ?? (serverUrl ?? config.serverUrl)?.replace(/^http/, "ws");
  if (!url) throw new Error("WebSocket operation requires x-ws.url or --server");

  const session = client.connect({
    kind: "websocket",
    url,
    subprotocols: xWs.subprotocols,
    headers: config.headers,
  });

  await session.open();

  // Send the first message from x-ws.send if defined.
  const messages = xWs.send ?? [];
  for (const msg of messages.slice(0, 3)) {
    await session.send(msg);
  }

  // Wait briefly for inbound messages.
  await new Promise((r) => setTimeout(r, 500));
  await session.close();

  const events = (session as any).events ?? [];
  const inbound = events.filter((e: any) => e.direction === "in" && e.kind !== "open");

  const response: TestResult["response"] = {
    status: 101,
    statusText: "Switching Protocols",
    body: inbound.map((e: any) => e.data),
    events: events.map((e: any) => ({ kind: e.kind, direction: e.direction, data: e.data })),
    streaming: true,
  };
  return {
    response,
    request: {
      method: "WS",
      url,
      ...(messages.length ? { body: messages.slice(0, 3) } : {}),
      ...(config.headers ? { headers: config.headers } : {}),
    },
  };
}

async function executeMcp(
  client: ReturnType<typeof createClient>,
  op: OperationInfo,
  config: CliConfig,
  serverUrl?: string,
): Promise<{ response: TestResult["response"]; request: TestResult["request"] }> {
  const xMcp = op.operation["x-mcp"] ?? {};
  const endpoint = xMcp.endpoint ?? serverUrl ?? config.serverUrl;
  const method = xMcp.method ?? "tools/call";
  const name = xMcp.name;
  const args = xMcp.arguments ?? {};

  if (config.mcpTransport === "stdio") {
    if (!config.mcpCommand) throw new Error("MCP stdio requires --mcp-command");
    const session = client.connect({
      kind: "mcp",
      transport: "stdio",
      command: config.mcpCommand,
      args: config.mcpArgs,
      cwd: config.mcpCwd,
      timeoutMs: config.timeout,
    });
    await session.open();
    const result = await (session as any).request(method, { name, arguments: args });
    await session.close();
    return {
      response: { status: 200, statusText: "OK", body: result },
      request: { method, target: name, body: { name, arguments: args } },
    };
  }

  // Streamable HTTP one-shot via client.send.
  const spec = {
    openapi: "3.2.0",
    info: { title: "mcp", version: "1.0.0" },
    paths: {
      "/mcp": {
        post: {
          operationId: op.operationId,
          "x-protocol": "mcp",
          "x-mcp": { endpoint, method, name, arguments: args },
          responses: { "200": { description: "ok" } },
        },
      },
    },
  };

  const result = await client.send({
    spec,
    target: { path: "/mcp", method: "post" },
    timeout: config.timeout,
    mcp: config.headers ? { headers: config.headers } : undefined,
  });

  const request = (result as { request?: TestResult["request"] }).request;
  return {
    response: {
      status: result.response?.status,
      statusText: result.response?.statusText,
      body: result.response?.body,
    },
    request: {
      ...(request ? { url: request.url, headers: request.headers } : {}),
      method,
      target: name,
      body: { name, arguments: args },
    },
  };
}

function buildGrpcSample(operation: any): Record<string, unknown> {
  const xGrpc = operation["x-grpc"] ?? {};
  if (xGrpc.sample && typeof xGrpc.sample === "object") return xGrpc.sample;
  // Try to derive from requestBody schema.
  const schema = operation.requestBody?.content?.["application/json"]?.schema;
  if (schema?.properties) {
    const out: Record<string, unknown> = {};
    for (const [key, prop] of Object.entries(schema.properties) as [string, any][]) {
      out[key] = prop.default ?? sampleValue(prop.type);
    }
    return out;
  }
  return {};
}

function sampleValue(type: string): unknown {
  switch (type) {
    case "string": return "";
    case "number":
    case "integer": return 0;
    case "boolean": return false;
    case "array": return [];
    case "object": return {};
    default: return "";
  }
}

export function buildSummary(results: TestResult[], durationMs: number): TestSummary {
  const total = results.length;
  const passed = results.filter((r) => r.status === "passed").length;
  const failed = results.filter((r) => r.status === "failed").length;
  const errors = results.filter((r) => r.status === "error").length;
  const skipped = results.filter((r) => r.status === "skipped").length;
  return {
    total,
    passed,
    failed,
    errors,
    skipped,
    durationMs,
    passRate: total > 0 ? Math.round((passed / total) * 1000) / 10 : 0,
  };
}
