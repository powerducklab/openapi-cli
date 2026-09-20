// Integration tests for data-driven scenario iteration (scenario-level and
// step-level data rows). Uses an inline node:http server like scenario.test.ts.
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runScenario } from "../src/scenario.js";
import type { CliConfig, ScenarioDefinition } from "../src/types.js";

let server: http.Server;
let port: number;
let specPath: string;
let tmpDir: string;
let config: CliConfig;
const itemHits: string[] = [];
const downHits: string[] = [];

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pduck-scenario-data-"));

  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);

    if (url.pathname === "/items" && req.method === "GET") {
      const idx = url.searchParams.get("idx") ?? "";
      itemHits.push(idx);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ idx, token: `t-${idx}` }));
      return;
    }

    if (url.pathname === "/down" && req.method === "GET") {
      downHits.push(req.headers["x-token"] as string);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ saw: req.headers["x-token"] ?? null }));
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

  const spec = {
    openapi: "3.2.0",
    info: { title: "scenario-data-api", version: "1.0.0" },
    servers: [{ url: `http://127.0.0.1:${port}` }],
    paths: {
      "/items": {
        get: {
          operationId: "items",
          parameters: [
            { name: "idx", in: "query", schema: { type: "string" } },
          ],
          responses: { "200": { description: "ok" } },
        },
      },
      "/down": {
        get: {
          operationId: "down",
          parameters: [
            { name: "x-token", in: "header", schema: { type: "string" } },
          ],
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

const twoStep = (): ScenarioDefinition => ({
  name: "data flow",
  steps: [
    {
      ref: "items",
      name: "List items",
      request: {
        values: { query: { idx: "{{idx}}" } },
        extract: [{ name: "token", from: "body", path: "$.token" }],
        assertions: [{ name: "ok", assert: "status", value: 200 }],
      },
    },
    {
      ref: "down",
      name: "Downstream",
      request: {
        values: { header: { "x-token": "{{token}}" } },
        assertions: [
          { name: "token chained", assert: "jsonPath", path: "$.saw", equals: "t-a" },
        ],
      },
    },
  ],
});

describe("scenario-level data rows", () => {
  it("runs the whole sequence once per row with independent scopes", async () => {
    itemHits.length = 0;
    downHits.length = 0;
    const definition = twoStep();
    definition.data = [{ idx: "a" }, { idx: "b" }];
    // The downstream assertion expects t-a; iteration b must not be compared
    // against a, so make the assertion row-aware via separate run below.
    definition.steps[1].request!.assertions = [
      { name: "token present", assert: "jsonPath", path: "$.saw", exists: true },
    ];

    const report = await runScenario(definition, { config });

    expect(report.status).toBe("passed");
    expect(report.iterations).toEqual({ scenarioCount: 2, stepCounts: [1, 1] });
    expect(itemHits).toEqual(["a", "b"]);
    // Each iteration chains its own extracted token.
    expect(downHits).toEqual(["t-a", "t-b"]);

    const items = report.steps.filter((s) => s.ref === "GET /items");
    expect(items).toHaveLength(2);
    expect(items.map((s) => s.scenarioIteration)).toEqual([0, 1]);
    expect(items.every((s) => s.stepIteration === 0)).toBe(true);
    expect((items[0].response?.body as any).idx).toBe("a");
    expect((items[1].response?.body as any).idx).toBe("b");
    // Extracts never leak across scenario iterations: the second iteration
    // scope starts from the row, not from iteration one's token.
    expect(items[1].variablesAfter?.token).toBe("t-b");
    expect(report.summary.passed).toBe(4);
  });
});

describe("step-level data rows", () => {
  it("executes the step once per row and writes back only the last extracts", async () => {
    itemHits.length = 0;
    downHits.length = 0;
    const definition = twoStep();
    definition.steps[0].request!.data = [
      { idx: "a" },
      { idx: "b" },
      { idx: "c" },
    ];
    definition.steps[1].request!.assertions = [
      { name: "last token chained", assert: "jsonPath", path: "$.saw", equals: "t-c" },
    ];

    const report = await runScenario(definition, { config });

    expect(report.status).toBe("passed");
    expect(report.iterations).toEqual({ scenarioCount: 1, stepCounts: [3, 1] });
    expect(itemHits).toEqual(["a", "b", "c"]);
    // The downstream step runs exactly once, using the last row's extract.
    expect(downHits).toEqual(["t-c"]);

    const items = report.steps.filter((s) => s.ref === "GET /items");
    expect(items).toHaveLength(3);
    expect(items.map((s) => s.stepIteration)).toEqual([0, 1, 2]);
    expect(items.every((s) => s.scenarioIteration === 0)).toBe(true);
    // Every iteration runs the step's own assertions.
    expect(items.every((s) => (s.assertions ?? []).length === 1)).toBe(true);
    expect(items.every((s) => s.assertions?.[0].passed)).toBe(true);
  });

  it("combines scenario and step rows as a cartesian grid", async () => {
    itemHits.length = 0;
    const definition = twoStep();
    definition.data = [{ idx: "x" }, { idx: "y" }];
    definition.steps[0].request!.data = [
      { idx: "a" },
      { idx: "b" },
    ];
    definition.steps[1].request!.assertions = [
      { name: "token present", assert: "jsonPath", path: "$.saw", exists: true },
    ];

    const report = await runScenario(definition, { config });

    expect(report.status).toBe("passed");
    // Step rows override the scenario row variable for that step.
    expect(itemHits).toEqual(["a", "b", "a", "b"]);
    const items = report.steps.filter((s) => s.ref === "GET /items");
    expect(items).toHaveLength(4);
    expect(items.map((s) => [s.scenarioIteration, s.stepIteration])).toEqual([
      [0, 0],
      [0, 1],
      [1, 0],
      [1, 1],
    ]);
  });
});

describe("failure handling with data rows", () => {
  it("stops remaining iterations by default and marks the grid skipped", async () => {
    itemHits.length = 0;
    const definition = twoStep();
    definition.steps[0].request!.data = [
      { idx: "a" },
      { idx: "b" },
      { idx: "c" },
    ];
    // Only row b satisfies the assertion; row a fails first and halts.
    definition.steps[0].request!.assertions = [
      { name: "idx is b", assert: "jsonPath", path: "$.idx", equals: "b" },
    ];

    const report = await runScenario(definition, { config });

    expect(report.status).toBe("failed");
    expect(itemHits).toEqual(["a"]);
    const items = report.steps.filter((s) => s.ref === "GET /items");
    expect(items.map((s) => [s.stepIteration, s.status])).toEqual([
      [0, "failed"],
      [1, "skipped"],
      [2, "skipped"],
    ]);
    const down = report.steps.filter((s) => s.ref === "GET /down");
    expect(down).toHaveLength(1);
    expect(down[0].status).toBe("skipped");
    expect(down[0].notRun).toBe(true);
  });

  it("continues through every row when stopOnFailure is false", async () => {
    itemHits.length = 0;
    const definition = twoStep();
    definition.stopOnFailure = false;
    definition.steps[0].request!.data = [
      { idx: "a" },
      { idx: "b" },
    ];
    definition.steps[0].request!.assertions = [
      { name: "idx is b", assert: "jsonPath", path: "$.idx", equals: "b" },
    ];

    const report = await runScenario(definition, { config });

    expect(report.status).toBe("failed");
    expect(itemHits).toEqual(["a", "b"]);
    const items = report.steps.filter((s) => s.ref === "GET /items");
    expect(items.map((s) => s.status)).toEqual(["failed", "passed"]);
  });

  it("marks every unrun execution skipped across future scenario iterations", async () => {
    itemHits.length = 0;
    const definition = twoStep();
    definition.data = [{ idx: "a" }, { idx: "b" }, { idx: "c" }];
    // The first execution fails, halting the whole grid.
    definition.steps[0].request!.assertions = [
      { name: "never", assert: "jsonPath", path: "$.idx", equals: "z" },
    ];

    const events: { type: string; reason?: string }[] = [];
    const report = await runScenario(definition, {
      config,
      onEvent: (e) =>
        events.push({ type: e.type, reason: e.step?.notRunReason }),
    });

    expect(report.status).toBe("failed");
    expect(itemHits).toEqual(["a"]);

    const items = report.steps.filter((s) => s.ref === "GET /items");
    expect(items.map((s) => [s.scenarioIteration, s.status])).toEqual([
      [0, "failed"],
      [1, "skipped"],
      [2, "skipped"],
    ]);
    expect(items.slice(1).every((s) => /Stopped after failed run/.test(s.notRunReason ?? ""))).toBe(true);

    const down = report.steps.filter((s) => s.ref === "GET /down");
    expect(down).toHaveLength(3);
    expect(down.every((s) => s.notRun && s.status === "skipped")).toBe(true);
    // The declared grid (3 scenario runs x 1 row each x 2 steps) reconciles.
    expect(report.steps).toHaveLength(6);
    expect(report.summary).toMatchObject({
      total: 6,
      passed: 0,
      failed: 1,
      skipped: 5,
    });

    // One skip event per unrun execution, mirroring the report grid.
    const skipEvents = events.filter((e) => e.type === "step:skip");
    expect(skipEvents).toHaveLength(5);
    expect(skipEvents.filter((e) => /Stopped after failed step/.test(e.reason ?? ""))).toHaveLength(1);
    expect(skipEvents.filter((e) => /Stopped after failed run/.test(e.reason ?? ""))).toHaveLength(4);
  });
});
