import { describe, expect, it } from "vitest";
import {
  runTests,
  resolveConfig,
  loadSpec,
  isRemoteSpec,
  DEFAULT_CONFIG,
  runDeclarativeAssertions,
  extractAssertions,
  extractPostmanScripts,
  resolveJsonPath,
  generateJsonReport,
  generateCliReport,
  printCliReport,
  generateHtmlReport,
} from "../src/index.js";
import type { CliConfig, DeclarativeAssertion } from "../src/types.js";

describe("coverage supplement tests", () => {
  describe("module exports", () => {
    it("exports runTests function", () => {
      expect(typeof runTests).toBe("function");
    });

    it("exports resolveConfig function", () => {
      expect(typeof resolveConfig).toBe("function");
    });

    it("exports loadSpec function", () => {
      expect(typeof loadSpec).toBe("function");
    });

    it("exports isRemoteSpec function", () => {
      expect(typeof isRemoteSpec).toBe("function");
    });

    it("exports DEFAULT_CONFIG object", () => {
      expect(typeof DEFAULT_CONFIG).toBe("object");
      expect(DEFAULT_CONFIG.concurrency).toBe(5);
      expect(DEFAULT_CONFIG.timeout).toBe(30000);
      expect(DEFAULT_CONFIG.failOnError).toBe(true);
    });

    it("exports assertion utilities", () => {
      expect(typeof runDeclarativeAssertions).toBe("function");
      expect(typeof extractAssertions).toBe("function");
      expect(typeof extractPostmanScripts).toBe("function");
      expect(typeof resolveJsonPath).toBe("function");
    });

    it("exports reporter functions", () => {
      expect(typeof generateJsonReport).toBe("function");
      expect(typeof generateCliReport).toBe("function");
      expect(typeof printCliReport).toBe("function");
      expect(typeof generateHtmlReport).toBe("function");
    });
  });

  describe("isRemoteSpec", () => {
    it("returns true for http URLs", () => {
      expect(isRemoteSpec("http://example.com/openapi.json")).toBe(true);
    });

    it("returns true for https URLs", () => {
      expect(isRemoteSpec("https://example.com/openapi.json")).toBe(true);
    });

    it("returns false for local paths", () => {
      expect(isRemoteSpec("./openapi.json")).toBe(false);
      expect(isRemoteSpec("/absolute/path/openapi.json")).toBe(false);
      expect(isRemoteSpec("openapi.json")).toBe(false);
    });

    it("handles edge cases", () => {
      expect(isRemoteSpec("")).toBe(false);
      expect(isRemoteSpec("httpx://example.com")).toBe(false);
    });
  });

  describe("resolveConfig edge cases", () => {
    it("throws when no spec path provided", () => {
      expect(() => resolveConfig({})).toThrow("No OpenAPI spec path provided");
    });

    it("accepts minimal config with spec", () => {
      const config = resolveConfig({ spec: "./openapi.json" });
      expect(config.specPath).toBe("./openapi.json");
      expect(config.concurrency).toBe(5);
      expect(config.timeout).toBe(30000);
      expect(config.failOnError).toBe(true);
    });

    it("parses format strings correctly", () => {
      const config = resolveConfig({ spec: "./openapi.json", format: "json,html" });
      expect(config.formats).toContain("json");
      expect(config.formats).toContain("html");
    });

    it("handles single format", () => {
      const config = resolveConfig({ spec: "./openapi.json", format: "cli" });
      expect(config.formats).toEqual(["cli"]);
    });

    it("resolves filter methods", () => {
      const config = resolveConfig({
        spec: "./openapi.json",
        method: "get,post",
      });
      expect(config.filter?.methods).toContain("get");
      expect(config.filter?.methods).toContain("post");
    });

    it("resolves filter tags", () => {
      const config = resolveConfig({
        spec: "./openapi.json",
        tag: "users,admin",
      });
      expect(config.filter?.tags).toContain("users");
      expect(config.filter?.tags).toContain("admin");
    });

    it("resolves filter operationIds", () => {
      const config = resolveConfig({
        spec: "./openapi.json",
        operationId: "getUsers,createUser",
      });
      expect(config.filter?.operationIds).toContain("getUsers");
      expect(config.filter?.operationIds).toContain("createUser");
    });

    it("resolves concurrency and timeout", () => {
      const config = resolveConfig({
        spec: "./openapi.json",
        concurrency: 10,
        timeout: 60000,
      });
      expect(config.concurrency).toBe(10);
      expect(config.timeout).toBe(60000);
    });

    it("resolves auth bearer token", () => {
      const config = resolveConfig({
        spec: "./openapi.json",
        bearer: "token123",
      });
      expect(config.auth?.type).toBe("bearer");
      expect(config.auth?.token).toBe("token123");
    });

    it("resolves custom headers", () => {
      const config = resolveConfig({
        spec: "./openapi.json",
        header: ["X-Custom: value", "X-Another: test"],
      });
      expect(config.headers?.["X-Custom"]).toBe("value");
      expect(config.headers?.["X-Another"]).toBe("test");
    });

    it("resolves TLS options", () => {
      const config = resolveConfig({
        spec: "./openapi.json",
        ca: "/path/to/ca.pem",
        cert: "/path/to/cert.pem",
        key: "/path/to/key.pem",
        insecure: true,
      });
      expect(config.tls?.caCert).toBe("/path/to/ca.pem");
      expect(config.tls?.clientCert).toBe("/path/to/cert.pem");
      expect(config.tls?.clientKey).toBe("/path/to/key.pem");
      expect(config.tls?.strictSSL).toBe(false);
    });

    it("resolves failOnError", () => {
      const config = resolveConfig({
        spec: "./openapi.json",
        failOnError: false,
      });
      expect(config.failOnError).toBe(false);
    });

    it("resolves mcp transport", () => {
      const config = resolveConfig({
        spec: "./openapi.json",
        mcpTransport: "stdio",
      });
      expect(config.mcpTransport).toBe("stdio");
    });

    it("resolves grpc reflection", () => {
      const config = resolveConfig({
        spec: "./openapi.json",
        grpcReflection: false,
      });
      expect(config.grpcReflection).toBe(false);
    });
  });

  describe("resolveJsonPath", () => {
    it("resolves simple path", () => {
      const obj = { a: { b: { c: 42 } } };
      expect(resolveJsonPath(obj, "$.a.b.c")).toBe(42);
    });

    it("resolves array index", () => {
      const obj = { items: [{ name: "first" }, { name: "second" }] };
      expect(resolveJsonPath(obj, "$.items[1].name")).toBe("second");
    });

    it("returns undefined for missing path", () => {
      const obj = { a: 1 };
      expect(resolveJsonPath(obj, "$.b.c")).toBeUndefined();
    });

    it("handles root path", () => {
      const obj = { a: 1 };
      expect(resolveJsonPath(obj, "$")).toEqual({ a: 1 });
    });

    it("handles path without $ prefix", () => {
      const obj = { a: { b: 2 } };
      expect(resolveJsonPath(obj, "a.b")).toBe(2);
    });
  });

  describe("extractAssertions", () => {
    it("extracts assertions from operation", () => {
      const operation = {
        "x-tests": [
          { name: "status check", assert: "status", value: 200 },
        ],
      };
      const assertions = extractAssertions(operation, {});
      expect(assertions).toHaveLength(1);
      expect(assertions[0]?.name).toBe("status check");
      expect(assertions[0]?.assert).toBe("status");
    });

    it("returns empty array when no assertions", () => {
      const assertions = extractAssertions({}, {});
      expect(assertions).toEqual([]);
    });

    it("extracts from pathItem level", () => {
      const pathItem = {
        "x-tests": [{ name: "path check", assert: "status", value: 200 }],
      };
      const assertions = extractAssertions({}, pathItem);
      expect(assertions).toHaveLength(1);
    });

    it("filters invalid assertions", () => {
      const operation = {
        "x-tests": [
          { name: "valid", assert: "status", value: 200 },
          { name: "missing assert" },
          { assert: "status", value: 200 },
        ],
      };
      const assertions = extractAssertions(operation, {});
      expect(assertions).toHaveLength(1);
    });
  });

  describe("extractPostmanScripts", () => {
    it("extracts postman test scripts", () => {
      const operation = {
        "x-postman-scripts": {
          test: "pm.test('status', () => pm.response.to.have.status(200));",
        },
      };
      const scripts = extractPostmanScripts(operation);
      expect(typeof scripts).toBe("string");
      expect(scripts).toContain("pm.test");
    });

    it("returns undefined when no scripts", () => {
      const scripts = extractPostmanScripts({});
      expect(scripts).toBeUndefined();
    });

    it("returns undefined for non-string test", () => {
      const operation = {
        "x-postman-scripts": { test: 123 },
      };
      expect(extractPostmanScripts(operation)).toBeUndefined();
    });
  });

  describe("runDeclarativeAssertions", () => {
    const context = {
      status: 200,
      headers: { "content-type": "application/json" },
      body: { id: 1, name: "test", active: true },
      bodyText: '{"id":1,"name":"test"}',
      durationMs: 150,
    };

    it("passes status assertion", () => {
      const assertion: DeclarativeAssertion = {
        name: "status is 200",
        assert: "status",
        value: 200,
      };
      const results = runDeclarativeAssertions([assertion], context);
      expect(results[0]?.passed).toBe(true);
    });

    it("fails status assertion", () => {
      const assertion: DeclarativeAssertion = {
        name: "status is 404",
        assert: "status",
        value: 404,
      };
      const results = runDeclarativeAssertions([assertion], context);
      expect(results[0]?.passed).toBe(false);
    });

    it("passes header assertion", () => {
      const assertion: DeclarativeAssertion = {
        name: "content-type header",
        assert: "header",
        key: "content-type",
        contains: "application/json",
      };
      const results = runDeclarativeAssertions([assertion], context);
      expect(results[0]?.passed).toBe(true);
    });

    it("passes bodyContains assertion", () => {
      const assertion: DeclarativeAssertion = {
        name: "body contains test",
        assert: "bodyContains",
        contains: "test",
      };
      const results = runDeclarativeAssertions([assertion], context);
      expect(results[0]?.passed).toBe(true);
    });

    it("passes responseTime assertion", () => {
      const assertion: DeclarativeAssertion = {
        name: "response time under 200ms",
        assert: "responseTime",
        max: 200,
      };
      const results = runDeclarativeAssertions([assertion], context);
      expect(results[0]?.passed).toBe(true);
    });

    it("fails responseTime assertion", () => {
      const assertion: DeclarativeAssertion = {
        name: "response time under 100ms",
        assert: "responseTime",
        max: 100,
      };
      const results = runDeclarativeAssertions([assertion], context);
      expect(results[0]?.passed).toBe(false);
    });

    it("passes jsonPath exists assertion", () => {
      const assertion: DeclarativeAssertion = {
        name: "id exists",
        assert: "jsonPath",
        path: "$.id",
        exists: true,
      };
      const results = runDeclarativeAssertions([assertion], context);
      expect(results[0]?.passed).toBe(true);
    });

    it("passes jsonPath equals assertion", () => {
      const assertion: DeclarativeAssertion = {
        name: "name equals test",
        assert: "jsonPath",
        path: "$.name",
        equals: "test",
      };
      const results = runDeclarativeAssertions([assertion], context);
      expect(results[0]?.passed).toBe(true);
    });

    it("handles missing field gracefully", () => {
      const assertion: DeclarativeAssertion = {
        name: "nonexistent exists",
        assert: "jsonPath",
        path: "$.nonexistent",
        exists: true,
      };
      const results = runDeclarativeAssertions([assertion], context);
      expect(results[0]?.passed).toBe(false);
    });

    it("handles empty assertions array", () => {
      const results = runDeclarativeAssertions([], context);
      expect(results).toEqual([]);
    });

    it("throws error for status assertion without value", () => {
      const assertion: DeclarativeAssertion = {
        name: "invalid status",
        assert: "status",
      };
      const results = runDeclarativeAssertions([assertion], context);
      expect(results[0]?.passed).toBe(false);
      expect(results[0]?.error).toBeDefined();
    });
  });

  describe("reporters edge cases", () => {
    const mockReport = {
      summary: {
        total: 2,
        passed: 1,
        failed: 1,
        passRate: 0.5,
        totalDurationMs: 200,
      },
      results: [
        {
          operationId: "getUsers",
          path: "/users",
          method: "GET",
          status: "passed" as const,
          durationMs: 100,
          protocol: "http",
          response: { status: 200, body: { users: [] } },
          assertions: [{ name: "status", passed: true }],
        },
        {
          operationId: "getUser",
          path: "/users/{id}",
          method: "GET",
          status: "failed" as const,
          durationMs: 100,
          protocol: "http",
          response: { status: 404, body: { error: "not found" } },
          assertions: [{ name: "status", passed: false, error: "expected 200, got 404" }],
        },
      ],
      config: { specPath: "./openapi.json" } as CliConfig,
      generatedAt: new Date().toISOString(),
      version: "0.1.0",
    };

    const testOutputDir = "/tmp/openapi-cli-test-" + Date.now();

    it("generateJsonReport writes file and returns path", () => {
      const filePath = generateJsonReport(mockReport, testOutputDir);
      expect(typeof filePath).toBe("string");
      expect(filePath.endsWith("report.json")).toBe(true);
    });

    it("generateCliReport returns non-empty string", () => {
      const report = generateCliReport(mockReport);
      expect(typeof report).toBe("string");
      expect(report.length).toBeGreaterThan(0);
    });

    it("generateHtmlReport writes file and returns path", () => {
      const filePath = generateHtmlReport(mockReport, testOutputDir);
      expect(typeof filePath).toBe("string");
      expect(filePath.endsWith("report.html")).toBe(true);
    });

    it("printCliReport does not throw", () => {
      expect(() => printCliReport(mockReport)).not.toThrow();
    });

    it("handles report with no results", () => {
      const emptyReport = {
        ...mockReport,
        summary: { ...mockReport.summary, total: 0, passed: 0, failed: 0, passRate: 0 },
        results: [],
      };
      const filePath = generateJsonReport(emptyReport, testOutputDir + "-empty");
      expect(typeof filePath).toBe("string");
    });
  });

  describe("DEFAULT_CONFIG", () => {
    it("has expected default values", () => {
      expect(DEFAULT_CONFIG.outputDir).toBe("./openapi-cli-report");
      expect(DEFAULT_CONFIG.formats).toContain("json");
      expect(DEFAULT_CONFIG.formats).toContain("cli");
      expect(DEFAULT_CONFIG.formats).toContain("html");
      expect(DEFAULT_CONFIG.grpcReflection).toBe(true);
      expect(DEFAULT_CONFIG.mcpTransport).toBe("streamable-http");
    });
  });
});
