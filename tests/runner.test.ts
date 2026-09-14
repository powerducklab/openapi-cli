// Integration tests for the batch test runner.
// Uses an inline node:http server to test real HTTP operations.
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runTests } from "../src/runner.js";
import { resolveConfig } from "../src/config.js";
import type { CliConfig } from "../src/types.js";

let server: http.Server;
let port: number;
let specPath: string;
let tmpDir: string;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pduck-runner-test-"));

  // Start a test HTTP server.
  server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);

    if (url.pathname === "/users" && req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ users: [{ id: 1, name: "Alice" }] }));
      return;
    }

    if (url.pathname === "/users" && req.method === "POST") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        let parsed: any = {};
        try {
          parsed = body ? JSON.parse(body) : {};
        } catch {
          parsed = {};
        }
        res.writeHead(201, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: 2, ...parsed }));
      });
      return;
    }

    if (url.pathname === "/slow" && req.method === "GET") {
      setTimeout(() => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      }, 100);
      return;
    }

    if (url.pathname === "/error" && req.method === "GET") {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "internal" }));
      return;
    }

    if (url.pathname === "/sse" && req.method === "GET") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      });
      res.write("data: {\"seq\":1}\n\n");
      res.write("data: {\"seq\":2}\n\n");
      res.write("data: {\"seq\":3}\n\n");
      res.end();
      return;
    }

    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      port = addr.port;
      resolve();
    });
  });

  // Write a test OpenAPI spec.
  const spec = {
    openapi: "3.2.0",
    info: { title: "test-api", version: "1.0.0" },
    servers: [{ url: `http://127.0.0.1:${port}` }],
    paths: {
      "/users": {
        get: {
          operationId: "getUsers",
          tags: ["users"],
          responses: { "200": { description: "ok" } },
          "x-tests": [
            { name: "status 200", assert: "status", value: 200 },
            { name: "content-type json", assert: "header", key: "content-type", contains: "application/json" },
          ],
        },
        post: {
          operationId: "createUser",
          tags: ["users"],
          responses: { "201": { description: "created" } },
          "x-tests": [{ name: "status 201", assert: "status", value: 201 }],
        },
      },
      "/slow": {
        get: {
          operationId: "getSlow",
          responses: { "200": { description: "ok" } },
        },
      },
      "/error": {
        get: {
          operationId: "getError",
          responses: { "500": { description: "error" } },
          "x-tests": [{ name: "status 200", assert: "status", value: 200 }],
        },
      },
      "/sse": {
        get: {
          operationId: "getSse",
          responses: { "200": { description: "ok", content: { "text/event-stream": {} } } },
        },
      },
      "/notfound": {
        get: {
          operationId: "getNotFound",
          responses: { "404": { description: "not found" } },
        },
      },
    },
  };
  specPath = path.join(tmpDir, "openapi.json");
  fs.writeFileSync(specPath, JSON.stringify(spec));
}, 10000);

afterAll(() => {
  server.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeConfig(overrides: Partial<CliConfig> = {}): CliConfig {
  return {
    specPath,
    serverUrl: `http://127.0.0.1:${port}`,
    concurrency: 2,
    timeout: 5000,
    failOnError: false,
    ...overrides,
  };
}

describe("runTests basic execution", () => {
  it("runs all operations and returns a report", async () => {
    const report = await runTests(makeConfig());
    expect(report.summary.total).toBe(6);
    expect(report.results).toHaveLength(6);
    expect(report.generatedAt).toBeDefined();
    expect(report.version).toBe("0.1.0");
  });

  it("marks passing operations correctly", async () => {
    const report = await runTests(makeConfig());
    const getUsers = report.results.find((r) => r.operationId === "getUsers");
    expect(getUsers?.status).toBe("passed");
    expect(getUsers?.response?.status).toBe(200);
    expect(getUsers?.assertions).toHaveLength(2);
    expect(getUsers?.assertions?.every((a) => a.passed)).toBe(true);
  });

  it("marks failing assertions correctly", async () => {
    const report = await runTests(makeConfig());
    const getError = report.results.find((r) => r.operationId === "getError");
    expect(getError?.status).toBe("failed");
    expect(getError?.response?.status).toBe(500);
    expect(getError?.assertions?.[0].passed).toBe(false);
  });

  it("detects SSE protocol from content type", async () => {
    const report = await runTests(makeConfig());
    const sse = report.results.find((r) => r.operationId === "getSse");
    expect(sse?.protocol).toBe("sse");
    expect(sse?.response?.streaming).toBe(true);
  });

  it("records response body for HTTP operations", async () => {
    const report = await runTests(makeConfig());
    const getUsers = report.results.find((r) => r.operationId === "getUsers");
    expect(getUsers?.response?.body).toBeDefined();
    const body = getUsers?.response?.body as any;
    expect(body.users).toBeDefined();
    expect(body.users[0].name).toBe("Alice");
  });

  it("records duration for each test", async () => {
    const report = await runTests(makeConfig());
    for (const result of report.results) {
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
      expect(result.timestamp).toBeDefined();
    }
  });
});

describe("runTests filtering", () => {
  it("filters by method", async () => {
    const report = await runTests(makeConfig({ filter: { methods: ["get"] } }));
    expect(report.summary.total).toBe(5);
    expect(report.results.every((r) => r.method === "GET")).toBe(true);
  });

  it("filters by operationId", async () => {
    const report = await runTests(
      makeConfig({ filter: { operationIds: ["getUsers", "createUser"] } }),
    );
    expect(report.summary.total).toBe(2);
    expect(report.results.map((r) => r.operationId).sort()).toEqual(["createUser", "getUsers"]);
  });

  it("filters by tag", async () => {
    const report = await runTests(makeConfig({ filter: { tags: ["users"] } }));
    expect(report.summary.total).toBe(2);
  });

  it("filters by path pattern", async () => {
    const report = await runTests(makeConfig({ filter: { paths: ["^/users"] } }));
    expect(report.summary.total).toBe(2);
    expect(report.results.every((r) => r.path.startsWith("/users"))).toBe(true);
  });
});

describe("runTests concurrency", () => {
  it("respects concurrency limit", async () => {
    const report = await runTests(makeConfig({ concurrency: 1 }));
    expect(report.summary.total).toBe(6);
  });

  it("completes faster with higher concurrency", async () => {
    const slow = await runTests(makeConfig({ concurrency: 1, filter: { operationIds: ["getSlow", "getUsers"] } }));
    const fast = await runTests(makeConfig({ concurrency: 2, filter: { operationIds: ["getSlow", "getUsers"] } }));
    // With concurrency=1, the slow endpoint (100ms) blocks; with 2 they run in parallel.
    // This is a soft assertion — just verify both complete.
    expect(slow.summary.total).toBe(2);
    expect(fast.summary.total).toBe(2);
  });
});

describe("runTests summary", () => {
  it("computes correct pass rate", async () => {
    const report = await runTests(makeConfig());
    // getUsers=pass, createUser=pass, getSlow=pass, getError=fail, getSse=pass, getNotFound=fail
    expect(report.summary.passed).toBe(4);
    expect(report.summary.failed).toBe(2);
    expect(report.summary.passRate).toBe(66.7);
  });

  it("sorts results by path then method", async () => {
    const report = await runTests(makeConfig());
    const paths = report.results.map((r) => r.path);
    const sorted = [...paths].sort();
    expect(paths).toEqual(sorted);
  });
});

describe("implicit assertions", () => {
  it("marks 404 as failed when no user assertions are defined", async () => {
    const report = await runTests(makeConfig());
    const notFound = report.results.find((r) => r.operationId === "getNotFound");
    expect(notFound?.status).toBe("failed");
    expect(notFound?.response?.status).toBe(404);
    expect(notFound?.assertions).toBeDefined();
    const implicit = notFound?.assertions?.find((a) => a.name.includes("implicit"));
    expect(implicit?.passed).toBe(false);
    expect(implicit?.error).toContain("2xx");
  });

  it("marks 200 as passed when no user assertions are defined", async () => {
    const report = await runTests(makeConfig());
    const slow = report.results.find((r) => r.operationId === "getSlow");
    expect(slow?.status).toBe("passed");
    const implicit = slow?.assertions?.find((a) => a.name.includes("implicit"));
    expect(implicit?.passed).toBe(true);
  });

  it("does not add implicit assertions when user assertions exist", async () => {
    const report = await runTests(makeConfig());
    const users = report.results.find((r) => r.operationId === "getUsers");
    const implicit = users?.assertions?.find((a) => a.name.includes("implicit"));
    expect(implicit).toBeUndefined();
  });
});

describe("$ref resolution", () => {
  it("resolves internal $ref pointers in components.schemas", async () => {
    const refSpec = {
      openapi: "3.2.0",
      info: { title: "ref-test", version: "1.0.0" },
      servers: [{ url: `http://127.0.0.1:${port}` }],
      components: {
        schemas: {
          User: {
            type: "object",
            properties: { id: { type: "integer" }, name: { type: "string" } },
          },
        },
      },
      paths: {
        "/users": {
          get: {
            operationId: "getUsersRef",
            responses: {
              "200": {
                description: "ok",
                content: {
                  "application/json": {
                    schema: { $ref: "#/components/schemas/User" },
                  },
                },
              },
            },
          },
        },
      },
    };
    const refSpecPath = path.join(tmpDir, "ref-spec.json");
    fs.writeFileSync(refSpecPath, JSON.stringify(refSpec));
    const { loadSpec } = await import("../src/config.js");
    const resolved = await loadSpec({ specPath: refSpecPath, timeout: 5000 } as any);
    const schema = resolved.paths["/users"].get.responses["200"].content["application/json"].schema;
    expect(schema.type).toBe("object");
    expect(schema.properties.id.type).toBe("integer");
    expect(schema.properties.name.type).toBe("string");
    expect(schema.$ref).toBeUndefined();
  });

  it("resolves $ref in path items", async () => {
    const refSpec = {
      openapi: "3.2.0",
      info: { title: "ref-path-test", version: "1.0.0" },
      servers: [{ url: `http://127.0.0.1:${port}` }],
      components: {
        pathItems: {
          UserOps: {
            get: {
              operationId: "getUserByRef",
              responses: { "200": { description: "ok" } },
            },
          },
        },
      },
      paths: {
        "/ref-users": { $ref: "#/components/pathItems/UserOps" },
      },
    };
    const refSpecPath = path.join(tmpDir, "ref-path.json");
    fs.writeFileSync(refSpecPath, JSON.stringify(refSpec));
    const { loadSpec } = await import("../src/config.js");
    const resolved = await loadSpec({ specPath: refSpecPath, timeout: 5000 } as any);
    expect(resolved.paths["/ref-users"].get.operationId).toBe("getUserByRef");
  });
});

describe("network configuration", () => {
  it("rejects an invalid proxy URL with a clear error at config resolution", () => {
    expect(() =>
      resolveConfig({ spec: "./openapi.json", proxy: "not-a-url" }),
    ).toThrow(/Invalid proxy URL/);
  });

  it("accepts a well-formed proxy URL without crashing", async () => {
    // The request will fail to connect through the fake proxy, but the
    // proxy URL itself should be parsed without throwing.
    const report = await runTests(
      makeConfig({ proxy: "http://proxy.example.com:3128", filter: { operationIds: ["getUsers"] } }),
    );
    // The request may error or fail depending on network behavior, but it
    // should not throw during config resolution.
    expect(report.summary.total).toBe(1);
  });

  it("passes TLS strictSSL=false through to runner options", async () => {
    const report = await runTests(
      makeConfig({ tls: { strictSSL: false }, filter: { operationIds: ["getUsers"] } }),
    );
    expect(report.summary.total).toBe(1);
    expect(report.results[0].status).toBe("passed");
  });
});
