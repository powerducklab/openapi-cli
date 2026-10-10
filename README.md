# @powerduck/openapi-cli

[![npm version](https://img.shields.io/npm/v/@powerduck/openapi-cli)](https://www.npmjs.com/package/@powerduck/openapi-cli)
[![license](https://img.shields.io/npm/l/@powerduck/openapi-cli)](https://github.com/powerducklab/openapi-cli/blob/main/LICENSE)
[![downloads](https://img.shields.io/npm/dm/@powerduck/openapi-cli)](https://www.npmjs.com/package/@powerduck/openapi-cli)

CI-ready command-line tool for batch-testing OpenAPI 3.2 documents across six protocols. Runs every operation in your spec, runs assertions against each response, and produces JSON, CLI, and HTML reports.

---

Powerduck is an open-source developer tooling platform for teams building modern API workflows.

- **6 Protocols** — HTTP, SSE, WebSocket, GraphQL, gRPC, and MCP
- **Batch Testing** — Run every operation in your OpenAPI spec concurrently
- **Assertion Engine** — Validate status codes, headers, response bodies, and schemas
- **3 Report Formats** — JSON for CI, CLI for terminal, HTML for dashboards
- **Authentication** — Bearer tokens, API keys, Basic auth, OAuth2, and custom headers
- **Filtering** — Run tests by tag, path, method, operationId, or regex
- **Concurrency Control** — Configurable bounded parallelism
- **gRPC Reflection** — Auto-discover gRPC services via server reflection
- **MCP Integration** — Streamable HTTP and stdio MCP transport support
- **GitHub Actions** — First-class CI integration with annotations and summaries

---

## Quick Start

### Install

```bash
npm install -g @powerduck/openapi-cli
```

### Run tests from the CLI

```bash
openapi-cli --spec openapi.json --server https://api.example.com
```

### Programmatic usage

```typescript
import {
  resolveConfig,
  runTests,
  generateJsonReport,
  generateHtmlReport,
} from "@powerduck/openapi-cli";

const config = resolveConfig({
  spec: "./openapi.json",
  format: "json,html",
  output: "./reports",
  concurrency: 5,
});

const report = await runTests(config);

const jsonPath = generateJsonReport(report, config.outputDir);
const htmlPath = generateHtmlReport(report, config.outputDir);

console.log("Passed:", report.summary.passed, "/", report.summary.total);
```

### GitHub Actions CI

```yaml
name: API Tests
on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npm ci
      - name: Run API tests
        run: npx @powerduck/openapi-cli --spec openapi.json --server ${{ secrets.API_URL }} --output ./reports
        env:
          BEARER_TOKEN: ${{ secrets.BEARER_TOKEN }}
      - name: Upload reports
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: openapi-cli-reports
          path: ./reports
```

---

## Links

- [Official Website](https://www.powerduck.com/opensource/openapi-cli.html)
- [Documentation](https://www.powerduck.com/docs/openapi-cli/introduction)
- [GitHub](https://github.com/powerducklab/openapi-cli)
- [npm](https://www.npmjs.com/package/@powerduck/openapi-cli)

---

## Features

- **6 protocols** — HTTP, SSE, WebSocket, GraphQL, gRPC, and MCP
- **Batch testing** — Run every operation in your OpenAPI spec concurrently
- **Assertion engine** — Validate status codes, headers, response bodies, and schemas
- **3 report formats** — JSON for CI, CLI for terminal, HTML for dashboards
- **Authentication** — Bearer tokens, API keys, Basic auth, OAuth2, and custom headers
- **Filtering** — Run tests by tag, path, method, operationId, or regex
- **Concurrency control** — Configurable bounded parallelism
- **gRPC reflection** — Auto-discover gRPC services via server reflection
- **MCP integration** — Streamable HTTP and stdio MCP transport support
- **GitHub Actions** — First-class CI integration with annotations and summaries
- **Config file support** — JSON config file with environment variable expansion
- **TLS/SSL options** — Custom CA certs, client certificates, and insecure mode
- **Proxy support** — HTTP/HTTPS proxy with authentication
- **Timeout & retries** — Configurable per-request timeout and retry policies
- **Dual ESM/CJS** — Works with `import` and `require`, with bundled TypeScript declarations

---

## CLI Reference

### Commands

```bash
openapi-cli [options]

# Basic usage
openapi-cli --spec openapi.json --server https://api.example.com

# Filter by tag
openapi-cli --spec openapi.json --server https://api.example.com --tag users,orders

# Filter by method and path
openapi-cli --spec openapi.json --server https://api.example.com --method get --path "/users/*"

# Custom output
openapi-cli --spec openapi.json --server https://api.example.com --output ./reports --format json,html,cli

# With auth
openapi-cli --spec openapi.json --server https://api.example.com --bearer $TOKEN --header "X-Env: staging"

# Config file
openapi-cli --config ./openapi-cli.config.json
```

### Options

| Option                | Type       | Default                | Description                                                 |
| --------------------- | ---------- | ---------------------- | ----------------------------------------------------------- |
| `--spec`              | `string`   | -                      | Path or URL to OpenAPI spec (required)                      |
| `--server`            | `string`   | -                      | Server URL override                                         |
| `--output`            | `string`   | `./openapi-cli-report` | Output directory                                            |
| `--format`            | `string`   | `json,cli,html`        | Output formats (comma-separated)                            |
| `--method`            | `string`   | -                      | Filter by HTTP method (comma-separated)                     |
| `--path`              | `string`   | -                      | Filter by path pattern (comma-separated)                    |
| `--tag`               | `string`   | -                      | Filter by tag (comma-separated)                             |
| `--operation-id`      | `string`   | -                      | Filter by operationId (comma-separated)                     |
| `--concurrency`       | `number`   | `5`                    | Max concurrent requests                                     |
| `--timeout`           | `number`   | `30000`                | Request timeout in ms                                       |
| `--bearer`            | `string`   | -                      | Bearer token for authentication                             |
| `--header`            | `string[]` | -                      | Custom headers (Key: Value)                                 |
| `--variable`          | `string[]` | -                      | Server variables (key=value)                                |
| `--config`            | `string`   | -                      | Path to JSON config file                                    |
| `--env`               | `string`   | -                      | Path to .env file                                           |
| `--no-fail-on-error`  | `flag`     | off                    | Exit 0 even when tests fail (default: non-zero on failure)  |
| `--grpc-no-reflection`| `flag`     | off                    | Disable gRPC reflection and use proto files                 |
| `--grpc-proto`        | `string[]` | -                      | gRPC proto file paths                                       |
| `--mcp-transport`     | `string`   | `streamable-http`      | MCP transport type                                          |
| `--mcp-command`       | `string`   | -                      | MCP server command (stdio)                                  |
| `--mcp-args`          | `string`   | -                      | MCP server arguments                                        |
| `--mcp-cwd`           | `string`   | -                      | MCP server working directory                                |
| `--proxy`             | `string`   | -                      | Proxy URL                                                   |
| `--ca`                | `string`   | -                      | CA certificate path                                         |
| `--cert`              | `string`   | -                      | Client certificate path                                     |
| `--key`               | `string`   | -                      | Client key path                                             |
| `--insecure`          | `flag`     | off                    | Disable SSL verification                                    |

---

## Config File

```json
{
  "specPath": "./openapi.json",
  "serverUrl": "https://api.example.com",
  "outputDir": "./reports",
  "formats": ["json", "html"],
  "concurrency": 10,
  "timeout": 60000,
  "failOnError": true,
  "filter": {
    "tags": ["users", "orders"],
    "methods": ["get", "post"]
  },
  "auth": {
    "type": "bearer",
    "token": "${BEARER_TOKEN}"
  },
  "headers": {
    "X-Env": "staging"
  },
  "variables": {
    "version": "v2"
  }
}
```

---

## TypeScript Types

```typescript
import type {
  CliConfig,
  CliArgs,
  TestReport,
  TestResult,
  AssertionResult,
} from "@powerduck/openapi-cli";
```

---

## Links

- [Official Website](https://www.powerduck.com/opensource/openapi-cli.html)
- [Documentation](https://www.powerduck.com/docs/openapi-cli/introduction/)
- [Live Demo](https://www.powerduck.com/demo/)
- [GitHub](https://github.com/powerducklab/openapi-cli)
- [npm](https://www.npmjs.com/package/@powerduck/openapi-cli)

## License

MIT © [POWERDUCK LIMITED](https://www.powerduck.com)

## Transport and scenario contract (0.2.13)

Requires Node.js 18.17 or newer. CLI arguments override JSON configuration only
when explicitly supplied; `openapi-cli --config config.json` accepts `specPath`
from that file. Concurrency must be an integer from 1–100 and timeout from
1–600000 milliseconds. Report versions match the installed package.

- HTTP/SSE use the request engine's agents for HTTP(S) CONNECT proxies (including
  credentials), custom CA, PEM client certificates and PFX. JSON `tls` accepts
  `caCert`, `clientCert`, `clientKey`, `pfx`, `passphrase`, and `strictSSL`.
  Custom proxy/client certificates force HTTP/1 to use those agents.
- WebSocket reads `x-websocket` (legacy `x-ws` is accepted), preserves the endpoint
  path when overriding the server, and uses `timeout` for opening the connection.
  The smoke test sends up to three extension messages or one step `values.body`,
  then collects messages for up to 500 ms.
- gRPC forwards metadata/authentication and `values.body`, uses `timeout` for
  unary deadlines and `maxStreamMs` (or timeout) for streaming deadlines, and
  half-closes client streams before reading their final result. PEM TLS supports
  encrypted private keys; PFX and HTTPS proxies are rejected. HTTP CONNECT proxy
  settings are per channel and never change process environment variables.
  Proto paths disable reflection by default unless explicitly overridden.
- MCP honors operation transport/command settings unless explicitly overridden.
  A step body `{ "method": "tools/list", "params": {} }` invokes that method;
  a plain body supplies `tools/call` arguments. Results retain the `{result}`
  envelope; tool `isError` responses fail implicit assertions.
- GraphQL and MCP HTTP currently reject custom proxy/TLS settings because their
  bundled fetch transport cannot apply them. They never silently ignore these settings.
- HTTP/SSE forward the request library's complete static auth configuration,
  including `parameters` for signing schemes. Manual WebSocket/gRPC/MCP sessions
  support Basic, Bearer and API key auth; query API keys require a URL transport.
  OAuth token acquisition is owned by the caller; pass a resolved token.
- Scenario values and variables reach manual sessions as well as HTTP. WebSocket
  and MCP support `values.query`; gRPC uses `values.header` as metadata.
  `AbortSignal` cancels the active request and marks the scenario cancelled;
  sessions and owned agents are closed after completion or failure.

Programmatic hosts can supply `resolveTransport({protocol, url})` to resolve
per-target `{proxy, tls}` settings, for example system proxies, bypass rules and
host-specific client certificates. JSON configuration also forwards `requester`
(`followRedirects`, `maxRedirects`, `disableCookies`, `protocolVersion`) and
`maxEvents`, `maxStreamMs`, `maxResponseSize` to supported request transports.

### Extended HTTP methods

HTTP operation discovery includes all nine fixed OpenAPI 3.2 methods (including `trace` and `query`) and custom verbs in `additionalOperations`, such as `PROPFIND`, `REPORT`, and `CUSTOM-VERB`. Shared method helpers come from `@powerduck/openapi-parser/methods`; path metadata is not interpreted as an operation. Custom verbs must be valid HTTP tokens. Use OpenAPI 3.2 when declaring QUERY or `additionalOperations`.
