// Integration tests for the ordered scenario engine.
// Uses an inline node:http server to verify real variable chaining across steps.
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runScenario, resolveSteps, stepRef } from "../src/scenario.js";
import { collectOperations } from "../src/runner.js";
import { loadSpec } from "../src/config.js";
import type { CliConfig, ScenarioDefinition } from "../src/types.js";

let server: http.Server;
let port: number;
let specPath: string;
let tmpDir: string;
let spec: any;
let config: CliConfig;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pduck-scenario-test-"));

  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);

    if (url.pathname === "/register" && req.method === "POST") {
      res.writeHead(201, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: { accessToken: "tok-abc", userId: 42 } }));
      return;
    }

    if (url.pathname === "/me" && req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          authed: req.headers.authorization ?? null,
          script: req.headers["x-script"] ?? null,
          uid: url.searchParams.get("uid"),
        }),
      );
      return;
    }

    if (url.pathname === "/boom" && req.method === "GET") {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "internal" }));
      return;
    }

    if (url.pathname === "/login" && req.method === "POST") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ received: body ? JSON.parse(body) : {} }));
      });
      return;
    }

    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      port = (server.address() as { port: number }).port;
      resolve();
    });
  });

  spec = {
    openapi: "3.2.0",
    info: { title: "scenario-api", version: "1.0.0" },
    servers: [{ url: `http://127.0.0.1:${port}` }],
    paths: {
      "/register": {
        post: {
          operationId: "register",
          responses: { "201": { description: "created" } },
          "x-postman-scripts": {
            test: 'pm.test("set script var", function () { pm.environment.set("scriptVar", "sv-9"); });',
          },
        },
      },
      "/me": {
        get: {
          operationId: "me",
          parameters: [
            { name: "uid", in: "query", schema: { type: "string" } },
            { name: "Authorization", in: "header", schema: { type: "string" } },
            { name: "x-script", in: "header", schema: { type: "string" } },
          ],
          responses: { "200": { description: "ok" } },
        },
      },
      "/boom": {
        get: {
          operationId: "boom",
          responses: { "500": { description: "error" } },
        },
      },
      "/login": {
        post: {
          operationId: "login",
          requestBody: {
            content: { "application/json": { schema: { type: "object" } } },
          },
          responses: { "200": { description: "ok" } },
        },
      },
    },
  };

  specPath = path.join(tmpDir, "openapi.json");
  fs.writeFileSync(specPath, JSON.stringify(spec));
  config = { specPath, serverUrl: `http://127.0.0.1:${port}`, timeout: 5000, failOnError: false };
}, 10000);

afterAll(() => {
  server.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const happyScenario: ScenarioDefinition = {
  name: "register then profile",
  steps: [
    {
      ref: "register",
      name: "Register account",
      request: {
        extract: [
          { name: "token", from: "body", path: "$.data.accessToken" },
          { name: "uid", from: "body", path: "$.data.userId" },
        ],
      },
    },
    {
      ref: "GET /me",
      name: "Read profile",
      request: {
        values: {
          header: { Authorization: "Bearer {{token}}", "x-script": "{{scriptVar}}" },
          query: { uid: "{{uid}}" },
        },
        assertions: [
          { name: "token used", assert: "jsonPath", path: "$.authed", equals: "Bearer tok-abc" },
          { name: "uid chained", assert: "jsonPath", path: "$.uid", equals: "42" },
          { name: "script var chained", assert: "jsonPath", path: "$.script", equals: "sv-9" },
        ],
      },
    },
  ],
};

describe("runScenario happy path", () => {
  it("runs steps in order and chains extracted + script variables", async () => {
    const events: string[] = [];
    const report = await runScenario(happyScenario, {
      config,
      onEvent: (e) => events.push(e.type),
    });

    expect(report.status).toBe("passed");
    expect(report.steps.map((s) => s.ref)).toEqual(["POST /register", "GET /me"]);
    expect(report.steps.every((s) => s.status === "passed")).toBe(true);

    // Declarative extraction.
    expect(report.steps[0].extracted?.token).toBe("tok-abc");
    expect(report.steps[0].extracted?.uid).toBe("42");
    // Postman script variable propagated into the shared scope.
    expect(report.variables.scriptVar).toBe("sv-9");

    // The second request actually used the chained values (server echoes them).
    const meBody = report.steps[1].response?.body as any;
    expect(meBody.authed).toBe("Bearer tok-abc");
    expect(meBody.uid).toBe("42");
    expect(meBody.script).toBe("sv-9");

    expect(events).toEqual([
      "scenario:start",
      "step:start",
      "step:finish",
      "step:start",
      "step:finish",
      "scenario:finish",
    ]);
  });

  it("emits per-step results with variable snapshots", async () => {
    const report = await runScenario(happyScenario, { config });
    expect(report.steps[0].variablesAfter?.token).toBe("tok-abc");
    expect(report.steps[1].variablesAfter?.scriptVar).toBe("sv-9");
    expect(report.summary.passed).toBe(2);
    expect(report.summary.passRate).toBe(100);
  });

  it("records the resolved request snapshot for every step", async () => {
    const report = await runScenario(happyScenario, { config });
    for (const step of report.steps) {
      expect(step.request?.method).toBeTruthy();
      expect(step.request?.url).toContain(`127.0.0.1:${port}`);
    }
    // The second step consumed the chained token in its headers.
    const second = report.steps[1];
    expect(second.request?.method).toBe("GET");
    expect(second.request?.url).toContain("/me");
    expect(second.request?.headers?.["Authorization"] ??
      second.request?.headers?.["authorization"]).toBe("Bearer tok-abc");
  });
});

describe("runScenario references", () => {
  it("accepts explicit method+path references", async () => {
    const scenario: ScenarioDefinition = {
      name: "explicit refs",
      steps: [{ method: "post", path: "/register" }],
    };
    const report = await runScenario(scenario, { config });
    expect(report.status).toBe("passed");
    expect(report.steps[0].ref).toBe("POST /register");
  });

  it("rejects unknown references before any request is sent", async () => {
    const loaded = await loadSpec(config);
    const ops = collectOperations(loaded, { ...config, filter: undefined });
    const bad: ScenarioDefinition = {
      name: "bad",
      steps: [{ ref: "DELETE /ghost" }, { ref: "register" }],
    };
    expect(() => resolveSteps(bad, ops)).toThrow(/not present in the spec/);
    await expect(runScenario(bad, { config, spec: loaded })).rejects.toThrow(/not present/);
  });

  it("normalizes reference strings", () => {
    expect(stepRef({ ref: "get /me" })).toBe("GET /me");
    expect(stepRef({ method: "post", path: "/login" })).toBe("POST /login");
  });
});

describe("runScenario failure handling", () => {
  it("stops at the first failure by default and skips downstream steps", async () => {
    const scenario: ScenarioDefinition = {
      name: "halt",
      steps: [{ ref: "register" }, { ref: "boom" }, { ref: "me" }],
    };
    const report = await runScenario(scenario, { config });
    expect(report.status).toBe("failed");
    expect(report.steps[0].status).toBe("passed");
    expect(report.steps[1].status).toBe("failed");
    expect(report.steps[2].notRun).toBe(true);
    expect(report.steps[2].status).toBe("skipped");
  });

  it("continues through failures when stopOnFailure is false", async () => {
    const scenario: ScenarioDefinition = {
      name: "continue",
      stopOnFailure: false,
      steps: [{ ref: "register" }, { ref: "boom" }, { ref: "me" }],
    };
    const report = await runScenario(scenario, { config });
    expect(report.status).toBe("failed");
    expect(report.steps.map((s) => s.status)).toEqual(["passed", "failed", "passed"]);
    expect(report.steps.every((s) => !s.notRun)).toBe(true);
  });

  it("honours explicit per-step skip", async () => {
    const events: string[] = [];
    const scenario: ScenarioDefinition = {
      name: "skipped",
      steps: [{ ref: "register", skip: true }, { ref: "me" }],
    };
    const report = await runScenario(scenario, { config, onEvent: (e) => events.push(e.type) });
    expect(report.status).toBe("passed");
    expect(report.steps[0].status).toBe("skipped");
    expect(report.steps[0].notRun).toBe(true);
    expect(events).toContain("step:skip");
  });
});

describe("runScenario cancellation and inputs", () => {
  it("reports cancelled when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const scenario: ScenarioDefinition = {
      name: "cancel",
      steps: [{ ref: "register" }, { ref: "me" }],
    };
    const report = await runScenario(scenario, { config, signal: controller.signal });
    expect(report.status).toBe("cancelled");
    expect(report.steps.every((s) => s.notRun)).toBe(true);
  });

  it("merges initial scenario variables", async () => {
    const scenario: ScenarioDefinition = {
      name: "initial vars",
      variables: { username: "alice" },
      steps: [
        {
          ref: "login",
          request: {
            values: { body: { user: "{{username}}" } },
            assertions: [
              { name: "body templated", assert: "jsonPath", path: "$.received.user", equals: "alice" },
            ],
          },
        },
      ],
    };
    const report = await runScenario(scenario, { config });
    expect(report.status).toBe("passed");
    expect(report.variables.username).toBe("alice");
  });
});
