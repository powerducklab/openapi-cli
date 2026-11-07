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

    if (url.pathname.startsWith("/cookies/")) {
      res.setHeader("content-type", "application/json");
      if (url.pathname === "/cookies/set") res.setHeader("set-cookie", ["session=round141; Path=/cookies; HttpOnly", "scoped=hidden; Path=/private"]);
      if (url.pathname === "/cookies/clear") res.setHeader("set-cookie", "session=; Path=/cookies; Max-Age=0");
      res.end(JSON.stringify({ cookie: req.headers.cookie ?? null }));
      return;
    }

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
  it("resolves assertion expectations from preceding steps without mutating the plan", async () => {
    const scenario = structuredClone(happyScenario);
    scenario.steps[1].request!.assertions = [
      { name: "token {{token}}", assert: "jsonPath", path: "$.authed", equals: "Bearer {{token}}" },
      { name: "uid", assert: "jsonPath", path: "$.uid", equals: "{{uid}}" },
      { name: "script", assert: "jsonPath", path: "$.script", equals: "{{scriptVar}}" },
    ];
    const report = await runScenario(scenario, { config });
    expect(report.status).toBe("passed");
    expect(report.steps[1].assertions?.find(a => a.name === "token {{token}}")?.passed).toBe(true);
    expect(scenario.steps[1].request!.assertions[0].equals).toBe("Bearer {{token}}");
  });

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


it("executes explicit step scripts and propagates their variables to the next request", async () => {
  const report = await runScenario({ name: "script flow", steps: [
    { ref: "POST /login", request: { values: { body: { username: "{{scriptUser}}" } }, scripts: {
      preRequest: 'pm.environment.set("scriptUser", "script-round-3");',
      test: 'pm.test("script body", function () { pm.expect(pm.response.json().received.username).to.eql("script-round-3"); }); pm.environment.set("nextScriptValue", "script-chained");',
    } } },
    { ref: "GET /me", request: { values: { header: { "x-script": "{{nextScriptValue}}" } }, assertions: [
      { name: "chained script", assert: "jsonPath", path: "$.script", equals: "script-chained" },
    ] } },
  ] }, { config });
  expect(report.status).toBe("passed");
  expect(report.steps[0].assertions).toContainEqual(expect.objectContaining({ name: "script body", passed: true }));
  expect(report.variables.nextScriptValue).toBe("script-chained");
  expect(report.steps[1].status).toBe("passed");
});

it("reports a failing explicit script assertion instead of silently passing", async () => {
  const report = await runScenario({ name: "script failure", steps: [
    { ref: "GET /me", request: { scripts: { test: 'pm.test("must fail", function () { pm.expect(1).to.eql(2); });' } } },
  ] }, { config });
  expect(report.status).toBe("failed");
  expect(report.steps[0].assertions).toContainEqual(expect.objectContaining({ name: "must fail", passed: false }));
});

it.each(["test", "preRequest"] as const)("does not report success when %s throws outside pm.test", async (phase) => {
  const report = await runScenario({ name: "script exception", steps: [
    { ref: "GET /me", request: { scripts: { [phase]: 'throw new Error("UI_SCRIPT_EXCEPTION_138");' } } },
  ] }, { config });
  expect(report.status).toBe("failed");
  expect(report.steps[0].response?.status).toBe(200);
  expect(JSON.stringify(report.steps[0])).toContain("UI_SCRIPT_EXCEPTION_138");
});


it("shares real cookies across steps, respects paths and expiry, and isolates runs", async () => {
  const cookieSpec = { openapi: "3.0.3", info: { title: "Cookies", version: "1" },
    servers: [{ url: `http://127.0.0.1:${port}` }],
    paths: Object.fromEntries(["set", "echo", "clear"].map(name => [`/cookies/${name}`, { get: { responses: { "200": { description: "OK" } } } }])) };
  const step = (name: string, cookie?: string | null) => ({ ref: `GET /cookies/${name}`, request: { assertions: [
    { name: "HTTP success", assert: "status" as const, value: 200 },
    ...(cookie !== undefined ? [{ name: "cookie", assert: "jsonPath" as const, path: "$.cookie", equals: cookie }] : []),
  ] } });
  const report = await runScenario({ name: "cookies", iterations: 2, steps: [step("echo", null), step("set"), step("echo", "session=round141"), step("clear"), step("echo", null), step("set")] }, { config, spec: cookieSpec });
  expect(report.status).toBe("passed");
  const isolated = await runScenario({ name: "isolated", steps: [step("echo", null)] }, { config, spec: cookieSpec });
  expect(isolated.status).toBe("passed");
  const disabled = await runScenario({ name: "disabled", steps: [step("set"), step("echo", null)] }, { config: { ...config, requester: { disableCookies: true } }, spec: cookieSpec });
  expect(disabled.status).toBe("passed");
});
