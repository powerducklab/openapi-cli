# @powerduck/openapi-cli

[![npm version](https://img.shields.io/npm/v/@powerduck/openapi-cli)](https://www.npmjs.com/package/@powerduck/openapi-cli)
[![license](https://img.shields.io/npm/l/@powerduck/openapi-cli)](https://github.com/powerducklab/openapi-cli/blob/main/LICENSE)
[![downloads](https://img.shields.io/npm/dm/@powerduck/openapi-cli)](https://www.npmjs.com/package/@powerduck/openapi-cli)

CI-ready command-line tool for batch-testing OpenAPI 3.2 documents across six protocols. Runs every operation in your spec, runs assertions against each response, and produces JSON, CLI, and HTML reports.

---

Powerduck is an open-source developer tooling platform for teams building modern API workflows.

- **6 Protocols** — HTTP/1.1, HTTP/2, HTTP/3, WebSocket, SSE, and gRPC
- **Batch Testing** — Run every operation in your OpenAPI spec concurrently
- **Assertion Engine** — Validate status codes, headers, response bodies, and schemas
- **3 Report Formats** — JSON for CI, CLI for terminal, HTML for dashboards
- **Authentication** — Bearer tokens, API keys, Basic auth, OAuth2, and custom headers
- **Filtering** — Run tests by tag, path, method, operationId, or regex
- **Concurrency Control** — Configurable parallelism with rate limiting
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

console.log("Passed:", report.passed, "/", report.total);
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

- **6 protocols** — HTTP/1.1, HTTP/2, HTTP/3, WebSocket, SSE, and gRPC
- **Batch testing** — Run every operation in your OpenAPI spec concurrently
- **Assertion engine** — Validate status codes, headers, response bodies, and schemas
- **3 report formats** — JSON for CI, CLI for terminal, HTML for dashboards
- **Authentication** — Bearer tokens, API keys, Basic auth, OAuth2, and custom headers
- **Filtering** — Run tests by tag, path, method, operationId, or regex
- **Concurrency control** — Configurable parallelism with rate limiting
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

| Option             | Type       | Default                | Description                              |
| ------------------ | ---------- | ---------------------- | ---------------------------------------- |
| `--spec`           | `string`   | -                      | Path or URL to OpenAPI spec (required)   |
| `--server`         | `string`   | -                      | Server URL override                      |
| `--output`         | `string`   | `./openapi-cli-report` | Output directory                         |
| `--format`         | `string`   | `json,cli,html`        | Output formats (comma-separated)         |
| `--method`         | `string`   | -                      | Filter by HTTP method (comma-separated)  |
| `--path`           | `string`   | -                      | Filter by path pattern (comma-separated) |
| `--tag`            | `string`   | -                      | Filter by tag (comma-separated)          |
| `--operationId`    | `string`   | -                      | Filter by operationId (comma-separated)  |
| `--concurrency`    | `number`   | `5`                    | Max concurrent requests                  |
| `--timeout`        | `number`   | `30000`                | Request timeout in ms                    |
| `--bearer`         | `string`   | -                      | Bearer token for authentication          |
| `--header`         | `string[]` | -                      | Custom headers (Key: Value)              |
| `--variable`       | `string[]` | -                      | Server variables (key=value)             |
| `--config`         | `string`   | -                      | Path to JSON config file                 |
| `--env`            | `string`   | -                      | Path to .env file                        |
| `--failOnError`    | `boolean`  | `true`                 | Exit with non-zero code on test failure  |
| `--grpcReflection` | `boolean`  | `true`                 | Enable gRPC server reflection            |
| `--grpcProto`      | `string[]` | -                      | gRPC proto file paths                    |
| `--mcpTransport`   | `string`   | `streamable-http`      | MCP transport type                       |
| `--mcpCommand`     | `string`   | -                      | MCP server command (stdio)               |
| `--mcpArgs`        | `string`   | -                      | MCP server arguments                     |
| `--mcpCwd`         | `string`   | -                      | MCP server working directory             |
| `--proxy`          | `string`   | -                      | Proxy URL                                |
| `--ca`             | `string`   | -                      | CA certificate path                      |
| `--cert`           | `string`   | -                      | Client certificate path                  |
| `--key`            | `string`   | -                      | Client key path                          |
| `--insecure`       | `boolean`  | `false`                | Disable SSL verification                 |

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

## License

MIT © [POWERDUCK LIMITED](https://www.powerduck.com)
