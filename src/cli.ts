#!/usr/bin/env node
/**
 * openapi-cli — batch-test OpenAPI 3.2 documents in CI.
 *
 * Usage:
 *   openapi-cli --spec openapi.json [options]
 *   openapi-cli -c config.json
 */
import { Command } from "commander";
import { resolveConfig } from "./config.js";
import { runTests } from "./runner.js";
import {
  generateJsonReport,
  printCliReport,
  generateHtmlReport,
} from "./reporters/index.js";
import type { CliArgs } from "./config.js";

const program = new Command();

program
  .name("openapi-cli")
  .description("CI-ready CLI for batch-testing OpenAPI 3.2 documents across HTTP, SSE, WebSocket, GraphQL, gRPC and MCP")
  .version("0.2.0")
  .requiredOption("-s, --spec <path-or-url>", "Path or URL (http/https) to OpenAPI 3.2 JSON spec")
  .option("-S, --server <url>", "Override server URL from the spec")
  .option("-o, --output <dir>", "Output directory for reports", "./openapi-cli-report")
  .option("-f, --format <formats>", "Comma-separated report formats: json,cli,html", "json,cli,html")
  .option("-c, --config <path>", "Path to JSON config file (CLI args take precedence)")
  .option("--method <methods>", "Filter by HTTP methods (comma-separated)")
  .option("--path <patterns>", "Filter by path regex patterns (comma-separated)")
  .option("--tag <tags>", "Filter by OpenAPI tags (comma-separated)")
  .option("--operation-id <ids>", "Filter by operationId (comma-separated)")
  .option("-n, --concurrency <n>", "Max concurrent requests", "5")
  .option("-t, --timeout <ms>", "Per-request timeout in ms", "30000")
  .option("-p, --proxy <url>", "HTTP(S) proxy URL")
  .option("--ca <path>", "CA certificate bundle (PEM)")
  .option("--cert <path>", "Client certificate (PEM) for mTLS")
  .option("--key <path>", "Client private key (PEM) for mTLS")
  .option("-k, --insecure", "Skip TLS certificate verification")
  .option("-H, --header <headers...>", "Extra headers (Key: Value, repeatable)")
  .option("--bearer <token>", "Bearer token for Authorization header")
  .option("-v, --variable <vars...>", "Postman variables (KEY=VALUE, repeatable)")
  .option("--env <path>", "Path to .env file")
  .option("--no-fail-on-error", "Exit 0 even if tests fail")
  .option("--grpc-no-reflection", "Disable gRPC server reflection (use proto files)")
  .option("--grpc-proto <paths...>", "Paths to .proto files or directories")
  .option("--mcp-transport <transport>", "MCP transport: streamable-http or stdio", "streamable-http")
  .option("--mcp-command <command>", "MCP stdio command")
  .option("--mcp-args <args>", "MCP stdio arguments (space or comma separated)")
  .option("--mcp-cwd <dir>", "MCP stdio working directory");

program.parse(process.argv);
const opts = program.opts();

async function main() {
  const args: CliArgs = {
    spec: opts.spec,
    server: opts.server,
    output: opts.output,
    format: opts.format,
    config: opts.config,
    method: opts.method,
    path: opts.path,
    tag: opts.tag,
    operationId: opts.operationId,
    concurrency: Number(opts.concurrency),
    timeout: Number(opts.timeout),
    proxy: opts.proxy,
    ca: opts.ca,
    cert: opts.cert,
    key: opts.key,
    insecure: opts.insecure,
    header: opts.header,
    bearer: opts.bearer,
    variable: opts.variable,
    env: opts.env,
    failOnError: process.argv.includes("--no-fail-on-error") ? false : undefined,
    grpcReflection: opts.grpcNoReflection ? false : undefined,
    grpcProto: opts.grpcProto,
    mcpTransport: opts.mcpTransport,
    mcpCommand: opts.mcpCommand,
    mcpArgs: opts.mcpArgs,
    mcpCwd: opts.mcpCwd,
  };

  let config;
  try {
    config = resolveConfig(args);
  } catch (e) {
    console.error(`\x1b[31mError: ${(e as Error).message}\x1b[0m`);
    process.exit(2);
  }

  console.log(`\x1b[36mopenapi-cli v0.2.0 — testing ${config.specPath}\x1b[0m`);
  console.log(`\x1b[90mServer: ${config.serverUrl ?? "(from spec)"} | Concurrency: ${config.concurrency} | Timeout: ${config.timeout}ms\x1b[0m\n`);

  let report;
  try {
    report = await runTests(config);
  } catch (e) {
    console.error(`\x1b[31mFatal error: ${(e as Error).message}\x1b[0m`);
    process.exit(2);
  }

  const formats = config.formats ?? ["json", "cli", "html"];

  if (formats.includes("cli")) {
    printCliReport(report);
  }

  if (formats.includes("json")) {
    const path = generateJsonReport(report, config.outputDir ?? "./openapi-cli-report");
    console.log(`\x1b[90mJSON report: ${path}\x1b[0m`);
  }

  if (formats.includes("html")) {
    const path = generateHtmlReport(report, config.outputDir ?? "./openapi-cli-report");
    console.log(`\x1b[90mHTML report: ${path}\x1b[0m`);
  }

  const hasFailures = report.summary.failed > 0 || report.summary.errors > 0;
  if (hasFailures && config.failOnError !== false) {
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(`\x1b[31mUnexpected error: ${(e as Error).message}\x1b[0m`);
  console.error((e as Error).stack);
  process.exit(2);
});
