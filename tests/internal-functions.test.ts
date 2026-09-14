import { describe, expect, it } from "vitest";
import { formatAssertionError, buildImplicitAssertions } from "../src/runner.js";
import { runDeclarativeAssertions } from "../src/assertions.js";
import type { DeclarativeAssertion } from "../src/assertions.js";

describe("coverage supplement - internal functions", () => {
  describe("formatAssertionError", () => {
    it("returns undefined for null", () => {
      expect(formatAssertionError(null)).toBeUndefined();
    });

    it("returns undefined for undefined", () => {
      expect(formatAssertionError(undefined)).toBeUndefined();
    });

    it("returns undefined for false", () => {
      expect(formatAssertionError(false)).toBeUndefined();
    });

    it("returns string as-is", () => {
      expect(formatAssertionError("test error")).toBe("test error");
    });

    it("returns Error message", () => {
      const error = new Error("error message");
      expect(formatAssertionError(error)).toBe("error message");
    });

    it("returns object.message property", () => {
      const obj = { message: "object error" };
      expect(formatAssertionError(obj)).toBe("object error");
    });

    it("returns object.msg property", () => {
      const obj = { msg: "msg error" };
      expect(formatAssertionError(obj)).toBe("msg error");
    });

    it("prefers message over msg", () => {
      const obj = { message: "first", msg: "second" };
      expect(formatAssertionError(obj)).toBe("first");
    });

    it("returns JSON.stringify for plain object", () => {
      const obj = { code: 500, detail: "server error" };
      const result = formatAssertionError(obj);
      expect(result).toContain("code");
      expect(result).toContain("500");
    });

    it("handles circular reference gracefully", () => {
      const obj: any = { a: 1 };
      obj.self = obj;
      const result = formatAssertionError(obj);
      expect(typeof result).toBe("string");
    });

    it("handles number input", () => {
      const result = formatAssertionError(42);
      expect(typeof result).toBe("string");
    });
  });

  describe("buildImplicitAssertions - HTTP", () => {
    it("passes for 200 status", () => {
      const result = buildImplicitAssertions("http", { status: 200 });
      expect(result).toHaveLength(1);
      expect(result[0]?.passed).toBe(true);
      expect(result[0]?.name).toContain("HTTP status");
    });

    it("passes for 299 status", () => {
      const result = buildImplicitAssertions("http", { status: 299 });
      expect(result[0]?.passed).toBe(true);
    });

    it("fails for 404 status", () => {
      const result = buildImplicitAssertions("http", { status: 404 });
      expect(result[0]?.passed).toBe(false);
      expect(result[0]?.error).toContain("404");
    });

    it("fails for 500 status", () => {
      const result = buildImplicitAssertions("http", { status: 500 });
      expect(result[0]?.passed).toBe(false);
    });

    it("fails for missing status", () => {
      const result = buildImplicitAssertions("http", {});
      expect(result[0]?.passed).toBe(false);
      expect(result[0]?.error).toContain("no status");
    });
  });

  describe("buildImplicitAssertions - SSE", () => {
    it("passes for 200 status", () => {
      const result = buildImplicitAssertions("sse", { status: 200 });
      expect(result).toHaveLength(1);
      expect(result[0]?.passed).toBe(true);
    });

    it("fails for non-2xx status", () => {
      const result = buildImplicitAssertions("sse", { status: 500 });
      expect(result[0]?.passed).toBe(false);
    });
  });

  describe("buildImplicitAssertions - GraphQL", () => {
    it("passes for 200 with no errors", () => {
      const result = buildImplicitAssertions("graphql", {
        status: 200,
        body: { data: { user: { id: 1 } } },
      });
      expect(result).toHaveLength(1);
      expect(result[0]?.passed).toBe(true);
    });

    it("fails for non-2xx status", () => {
      const result = buildImplicitAssertions("graphql", {
        status: 500,
        body: {},
      });
      expect(result[0]?.passed).toBe(false);
      expect(result[0]?.error).toContain("500");
    });

    it("fails for GraphQL errors in body", () => {
      const result = buildImplicitAssertions("graphql", {
        status: 200,
        body: { errors: [{ message: "auth failed" }, { message: "invalid query" }] },
      });
      expect(result[0]?.passed).toBe(false);
      expect(result[0]?.error).toContain("2 error(s)");
    });

    it("fails for missing status", () => {
      const result = buildImplicitAssertions("graphql", { body: {} });
      expect(result[0]?.passed).toBe(false);
    });
  });

  describe("buildImplicitAssertions - gRPC", () => {
    it("passes for statusCode 0", () => {
      const result = buildImplicitAssertions("grpc", { statusCode: 0 });
      expect(result).toHaveLength(1);
      expect(result[0]?.passed).toBe(true);
    });

    it("passes for code 0", () => {
      const result = buildImplicitAssertions("grpc", { code: 0 });
      expect(result[0]?.passed).toBe(true);
    });

    it("fails for statusCode 1", () => {
      const result = buildImplicitAssertions("grpc", { statusCode: 1, statusName: "CANCELLED" });
      expect(result[0]?.passed).toBe(false);
      expect(result[0]?.error).toContain("1");
      expect(result[0]?.error).toContain("CANCELLED");
    });

    it("fails for missing status code", () => {
      const result = buildImplicitAssertions("grpc", {});
      expect(result[0]?.passed).toBe(false);
      expect(result[0]?.error).toContain("unknown");
    });
  });

  describe("buildImplicitAssertions - MCP", () => {
    it("passes for response with result and no error", () => {
      const result = buildImplicitAssertions("mcp", {
        body: { result: { tools: [] } },
      });
      expect(result).toHaveLength(1);
      expect(result[0]?.passed).toBe(true);
    });

    it("fails for response with error", () => {
      const result = buildImplicitAssertions("mcp", {
        body: { error: { code: -32600, message: "Invalid Request" } },
      });
      expect(result[0]?.passed).toBe(false);
      expect(result[0]?.error).toContain("error");
    });

    it("fails for response with top-level error", () => {
      const result = buildImplicitAssertions("mcp", {
        body: {},
        error: "connection failed",
      } as any);
      expect(result[0]?.passed).toBe(false);
    });

    it("fails for missing result", () => {
      const result = buildImplicitAssertions("mcp", { body: {} });
      expect(result[0]?.passed).toBe(false);
      expect(result[0]?.error).toContain("missing 'result'");
    });

    it("passes for result with null value", () => {
      const result = buildImplicitAssertions("mcp", { body: { result: null } });
      expect(result[0]?.passed).toBe(true);
    });
  });

  describe("buildImplicitAssertions - WebSocket", () => {
    it("passes for open event", () => {
      const result = buildImplicitAssertions("websocket", {
        events: [{ kind: "open" }, { kind: "message", data: "hello" }],
      });
      expect(result).toHaveLength(1);
      expect(result[0]?.passed).toBe(true);
    });

    it("passes for state open", () => {
      const result = buildImplicitAssertions("websocket", {
        events: [{ state: "open" }],
      });
      expect(result[0]?.passed).toBe(true);
    });

    it("fails for error event", () => {
      const result = buildImplicitAssertions("websocket", {
        events: [{ kind: "open" }, { kind: "error", message: "connection failed" }],
      });
      expect(result[0]?.passed).toBe(false);
      expect(result[0]?.error).toContain("errored");
    });

    it("fails for state error", () => {
      const result = buildImplicitAssertions("websocket", {
        events: [{ state: "error" }],
      });
      expect(result[0]?.passed).toBe(false);
    });

    it("fails for no open event", () => {
      const result = buildImplicitAssertions("websocket", {
        events: [{ kind: "message", data: "hello" }],
      });
      expect(result[0]?.passed).toBe(false);
      expect(result[0]?.error).toContain("open state");
    });

    it("fails for empty events", () => {
      const result = buildImplicitAssertions("websocket", { events: [] });
      expect(result[0]?.passed).toBe(false);
    });

    it("fails for missing events", () => {
      const result = buildImplicitAssertions("websocket", {});
      expect(result[0]?.passed).toBe(false);
    });
  });

  describe("buildImplicitAssertions - unknown protocol", () => {
    it("returns empty array for unknown protocol", () => {
      const result = buildImplicitAssertions("unknown", { status: 200 });
      expect(result).toEqual([]);
    });
  });

  describe("runDeclarativeAssertions - additional coverage", () => {
    const context = {
      status: 200,
      headers: { "content-type": "application/json", "x-custom": "test-value" },
      body: { id: 1, name: "test", nested: { value: 42 } },
      bodyText: '{"id":1,"name":"test"}',
      durationMs: 150,
    };

    it("passes bodyEquals assertion", () => {
      const assertion: DeclarativeAssertion = {
        name: "body equals",
        assert: "bodyEquals",
        body: '{"id":1,"name":"test"}',
      };
      const results = runDeclarativeAssertions([assertion], context);
      expect(results[0]?.passed).toBe(true);
    });

    it("fails bodyEquals assertion", () => {
      const assertion: DeclarativeAssertion = {
        name: "body equals",
        assert: "bodyEquals",
        body: '{"different":true}',
      };
      const results = runDeclarativeAssertions([assertion], context);
      expect(results[0]?.passed).toBe(false);
    });

    it("throws error for bodyEquals without body", () => {
      const assertion: DeclarativeAssertion = {
        name: "invalid bodyEquals",
        assert: "bodyEquals",
      };
      const results = runDeclarativeAssertions([assertion], context);
      expect(results[0]?.passed).toBe(false);
      expect(results[0]?.error).toContain("requires 'body'");
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

    it("passes jsonPath not exists assertion", () => {
      const assertion: DeclarativeAssertion = {
        name: "nonexistent does not exist",
        assert: "jsonPath",
        path: "$.nonexistent",
        exists: false,
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

    it("passes jsonPath nested equals assertion", () => {
      const assertion: DeclarativeAssertion = {
        name: "nested value equals 42",
        assert: "jsonPath",
        path: "$.nested.value",
        equals: 42,
      };
      const results = runDeclarativeAssertions([assertion], context);
      expect(results[0]?.passed).toBe(true);
    });

    it("fails jsonPath equals assertion", () => {
      const assertion: DeclarativeAssertion = {
        name: "name equals wrong",
        assert: "jsonPath",
        path: "$.name",
        equals: "wrong",
      };
      const results = runDeclarativeAssertions([assertion], context);
      expect(results[0]?.passed).toBe(false);
    });

    it("passes jsonPath without exists/equals (just checks existence)", () => {
      const assertion: DeclarativeAssertion = {
        name: "id exists implicitly",
        assert: "jsonPath",
        path: "$.id",
      };
      const results = runDeclarativeAssertions([assertion], context);
      expect(results[0]?.passed).toBe(true);
    });

    it("throws error for jsonPath without path", () => {
      const assertion: DeclarativeAssertion = {
        name: "invalid jsonPath",
        assert: "jsonPath",
      };
      const results = runDeclarativeAssertions([assertion], context);
      expect(results[0]?.passed).toBe(false);
      expect(results[0]?.error).toContain("requires 'path'");
    });

    it("passes responseTime assertion", () => {
      const assertion: DeclarativeAssertion = {
        name: "response under 200ms",
        assert: "responseTime",
        max: 200,
      };
      const results = runDeclarativeAssertions([assertion], context);
      expect(results[0]?.passed).toBe(true);
    });

    it("fails responseTime assertion", () => {
      const assertion: DeclarativeAssertion = {
        name: "response under 100ms",
        assert: "responseTime",
        max: 100,
      };
      const results = runDeclarativeAssertions([assertion], context);
      expect(results[0]?.passed).toBe(false);
    });

    it("throws error for responseTime without max", () => {
      const assertion: DeclarativeAssertion = {
        name: "invalid responseTime",
        assert: "responseTime",
      };
      const results = runDeclarativeAssertions([assertion], context);
      expect(results[0]?.passed).toBe(false);
      expect(results[0]?.error).toContain("requires 'max'");
    });

    it("throws error for unknown assertion type", () => {
      const assertion = {
        name: "unknown type",
        assert: "unknownType",
      } as DeclarativeAssertion;
      const results = runDeclarativeAssertions([assertion], context);
      expect(results[0]?.passed).toBe(false);
      expect(results[0]?.error).toContain("Unknown assertion type");
    });

    it("passes header assertion without contains", () => {
      const assertion: DeclarativeAssertion = {
        name: "content-type header exists",
        assert: "header",
        key: "content-type",
      };
      const results = runDeclarativeAssertions([assertion], context);
      expect(results[0]?.passed).toBe(true);
    });

    it("fails header assertion for missing header", () => {
      const assertion: DeclarativeAssertion = {
        name: "missing header",
        assert: "header",
        key: "x-missing",
      };
      const results = runDeclarativeAssertions([assertion], context);
      expect(results[0]?.passed).toBe(false);
    });

    it("throws error for header without key", () => {
      const assertion: DeclarativeAssertion = {
        name: "invalid header",
        assert: "header",
      };
      const results = runDeclarativeAssertions([assertion], context);
      expect(results[0]?.passed).toBe(false);
      expect(results[0]?.error).toContain("requires 'key'");
    });
  });
});
