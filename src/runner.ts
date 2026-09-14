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

interface OperationInfo {
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

function collectOperations(spec: any, config: CliConfig): OperationInfo[] {
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

async function executeOperation(
  client: ReturnType<typeof createClient>,
  op: OperationInfo,
  config: CliConfig,
  spec: any,
): Promise<TestResult> {
  const startedAt = Date.now();
  const base: Omit<TestResult, "status" | "durationMs" | "timestamp"> = {
    operationId: op.operationId,
    path: op.path,
    method: op.method.toUpperCase(),
    protocol: op.protocol,
  };

  try {
    const assertions = extractAssertions(op.operation, op.pathItem);
    const postmanTest = extractPostmanScripts(op.operation);
    const postmanAssertions: any[] = [];

    let responseData: TestResult["response"];

    switch (op.protocol) {
      case "grpc":
        responseData = await executeGrpc(client, op, config);
        break;
      case "websocket":
        responseData = await executeWebSocket(client, op, config);
        break;
      case "mcp":
        responseData = await executeMcp(client, op, config);
        break;
      case "graphql":
      case "sse":
      case "http":
      default:
        responseData = await executeHttp(client, op, config, spec, postmanTest, postmanAssertions);
        break;
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

    return {
      ...base,
      status: hasFailures ? "failed" : "passed",
      durationMs,
      response: responseData,
      assertions: allAssertions.length ? allAssertions : undefined,
      timestamp: new Date().toISOString(),
    };
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    return {
      ...base,
      status: "error",
      durationMs,
      error: (error as Error).message ?? String(error),
      timestamp: new Date().toISOString(),
    };
  }
}

async function executeHttp(
  client: ReturnType<typeof createClient>,
  op: OperationInfo,
  config: CliConfig,
  spec: any,
  postmanTest: string | undefined,
  postmanAssertions: any[],
): Promise<TestResult["response"]> {
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

  const result = await client.send({
    spec,
    target: { path: op.path, method: op.method },
    serverUrl: config.serverUrl,
    values: config.headers ? { header: config.headers } : undefined,
    auth: config.auth,
    variables: config.variables,
    timeout: config.timeout,
    runner: Object.keys(runnerOptions).length ? runnerOptions : undefined,
    scripts: postmanTest
      ? { test: { exec: postmanTest }, fromSpecExtensions: false }
      : undefined,
    onAssertion: (a: any) => {
      postmanAssertions.push({
        name: a.name ?? "assertion",
        passed: a.passed,
        error: formatAssertionError(a.error),
      });
    },
    maxStreamMs: config.timeout,
    maxEvents: 50,
  });

  return {
    status: result.response?.status,
    statusText: result.response?.statusText,
    contentType: result.response?.contentType,
    sizeBytes: result.response?.sizeBytes,
    body: result.response?.body,
    text: (result.response as any)?.text,
    headers: result.response?.headers,
    events: (result.response as any)?.events,
    streaming: (result.response as any)?.streaming,
  };
}

async function executeGrpc(
  client: ReturnType<typeof createClient>,
  op: OperationInfo,
  config: CliConfig,
): Promise<TestResult["response"]> {
  const xGrpc = op.operation["x-grpc"] ?? {};
  const address = xGrpc.address ?? config.serverUrl?.replace(/^https?:\/\//, "");
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

  return {
    status: statusEvent?.meta?.code ?? 0,
    statusText: statusEvent?.meta?.statusName,
    body: dataEvents.length === 1 ? dataEvents[0].data : dataEvents.map((e: any) => e.data),
    events: events.map((e: any) => ({ kind: e.kind, direction: e.direction, data: e.data, meta: e.meta })),
  };
}

async function executeWebSocket(
  client: ReturnType<typeof createClient>,
  op: OperationInfo,
  config: CliConfig,
): Promise<TestResult["response"]> {
  const xWs = op.operation["x-ws"] ?? {};
  const url = xWs.url ?? config.serverUrl?.replace(/^http/, "ws");
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

  return {
    status: 101,
    statusText: "Switching Protocols",
    body: inbound.map((e: any) => e.data),
    events: events.map((e: any) => ({ kind: e.kind, direction: e.direction, data: e.data })),
    streaming: true,
  };
}

async function executeMcp(
  client: ReturnType<typeof createClient>,
  op: OperationInfo,
  config: CliConfig,
): Promise<TestResult["response"]> {
  const xMcp = op.operation["x-mcp"] ?? {};
  const endpoint = xMcp.endpoint ?? config.serverUrl;
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
    return { status: 200, statusText: "OK", body: result };
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

  return {
    status: result.response?.status,
    statusText: result.response?.statusText,
    body: result.response?.body,
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

function buildSummary(results: TestResult[], durationMs: number): TestSummary {
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
