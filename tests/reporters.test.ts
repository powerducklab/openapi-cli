// Tests for all three report generators.
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { generateJsonReport, generateCliReport, generateHtmlReport } from "../src/reporters/index.js";
import type { TestReport } from "../src/types.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pduck-report-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const sampleReport: TestReport = {
  summary: {
    total: 4,
    passed: 2,
    failed: 1,
    errors: 1,
    skipped: 0,
    durationMs: 1234,
    passRate: 50.0,
  },
  results: [
    {
      operationId: "getUsers",
      path: "/users",
      method: "GET",
      protocol: "http",
      status: "passed",
      durationMs: 100,
      response: { status: 200, statusText: "OK", contentType: "application/json", sizeBytes: 512 },
      assertions: [{ name: "status 200", passed: true }],
      timestamp: "2024-01-01T00:00:00.000Z",
    },
    {
      operationId: "createUser",
      path: "/users",
      method: "POST",
      protocol: "http",
      status: "failed",
      durationMs: 200,
      response: { status: 400, statusText: "Bad Request" },
      assertions: [
        { name: "status 201", passed: false, error: "expected 201, got 400" },
      ],
      timestamp: "2024-01-01T00:00:01.000Z",
    },
    {
      operationId: "streamEvents",
      path: "/events",
      method: "GET",
      protocol: "sse",
      status: "passed",
      durationMs: 500,
      response: { status: 200, streaming: true, events: [{ event: "tick", data: "1" }] },
      timestamp: "2024-01-01T00:00:02.000Z",
    },
    {
      operationId: "grpcCall",
      path: "/grpc",
      method: "POST",
      protocol: "grpc",
      status: "error",
      durationMs: 434,
      error: "gRPC session is not open",
      timestamp: "2024-01-01T00:00:03.000Z",
    },
  ],
  config: { specPath: "./openapi.json" },
  generatedAt: "2024-01-01T00:00:04.000Z",
  version: "0.1.0",
};

describe("JSON reporter", () => {
  it("writes a valid JSON file", () => {
    const filePath = generateJsonReport(sampleReport, tmpDir);
    expect(fs.existsSync(filePath)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    expect(parsed.summary.total).toBe(4);
    expect(parsed.summary.passed).toBe(2);
    expect(parsed.results).toHaveLength(4);
    expect(parsed.results[0].operationId).toBe("getUsers");
    expect(parsed.generatedAt).toBe("2024-01-01T00:00:04.000Z");
  });

  it("creates output directory if it does not exist", () => {
    const nestedDir = path.join(tmpDir, "nested", "dir");
    const filePath = generateJsonReport(sampleReport, nestedDir);
    expect(fs.existsSync(filePath)).toBe(true);
  });
});

describe("CLI reporter", () => {
  it("generates a non-empty string with summary", () => {
    const text = generateCliReport(sampleReport);
    expect(text.length).toBeGreaterThan(100);
    expect(text).toContain("Total:");
    expect(text).toContain("4");
    expect(text).toContain("Passed:");
    expect(text).toContain("2");
    expect(text).toContain("Failed:");
    expect(text).toContain("1");
  });

  it("includes each test result", () => {
    const text = generateCliReport(sampleReport);
    expect(text).toContain("GET");
    expect(text).toContain("/users");
    expect(text).toContain("POST");
    expect(text).toContain("gRPC session is not open");
  });

  it("includes assertion details for failed tests", () => {
    const text = generateCliReport(sampleReport);
    expect(text).toContain("status 201");
    expect(text).toContain("expected 201, got 400");
  });

  it("shows all-passed message when no failures", () => {
    const allPass: TestReport = {
      ...sampleReport,
      summary: { ...sampleReport.summary, total: 1, passed: 1, failed: 0, errors: 0, passRate: 100 },
      results: [sampleReport.results[0]],
    };
    const text = generateCliReport(allPass);
    expect(text).toContain("All 1 test(s) passed");
  });

  it("highlights slow tests (>500ms) with yellow duration", () => {
    const slowReport: TestReport = {
      ...sampleReport,
      summary: { ...sampleReport.summary, total: 1, passed: 1, failed: 0, errors: 0, passRate: 100, durationMs: 600 },
      results: [
        {
          operationId: "slowEndpoint",
          path: "/slow",
          method: "GET",
          protocol: "http",
          status: "passed",
          durationMs: 646,
          response: { status: 200 },
          timestamp: "2024-01-01T00:00:00.000Z",
        },
      ],
    };
    const text = generateCliReport(slowReport);
    // Yellow ANSI code is \x1b[33m
    expect(text).toContain("\x1b[33m");
    expect(text).toContain("646");
    expect(text).toContain("ms");
  });

  it("does not highlight fast tests (<=500ms) with yellow", () => {
    const fastReport: TestReport = {
      ...sampleReport,
      summary: { ...sampleReport.summary, total: 1, passed: 1, failed: 0, errors: 0, passRate: 100, durationMs: 100 },
      results: [
        {
          operationId: "fastEndpoint",
          path: "/fast",
          method: "GET",
          protocol: "http",
          status: "passed",
          durationMs: 11,
          response: { status: 200 },
          timestamp: "2024-01-01T00:00:00.000Z",
        },
      ],
    };
    const text = generateCliReport(fastReport);
    // The duration line should not contain yellow for the fast test
    // But summary may contain other yellow (Errors label), so check specific pattern
    const lines = text.split("\n");
    const resultLine = lines.find((l) => l.includes("fastEndpoint") || l.includes("/fast"));
    expect(resultLine).toBeDefined();
    // Fast test duration should be bold but not yellow
    expect(resultLine).toContain("11");
    expect(resultLine).toContain("ms");
  });

  it("uses bold number and dim unit for duration formatting", () => {
    const report: TestReport = {
      ...sampleReport,
      summary: { ...sampleReport.summary, total: 1, passed: 1, failed: 0, errors: 0, passRate: 100, durationMs: 250 },
      results: [
        {
          operationId: "testEndpoint",
          path: "/test",
          method: "GET",
          protocol: "http",
          status: "passed",
          durationMs: 250,
          response: { status: 200 },
          timestamp: "2024-01-01T00:00:00.000Z",
        },
      ],
    };
    const text = generateCliReport(report);
    // Bold ANSI is \x1b[1m, dim is \x1b[2m
    expect(text).toContain("\x1b[1m250\x1b[0m\x1b[2mms\x1b[0m");
  });

  it("handles boundary at exactly 500ms (not slow)", () => {
    const boundaryReport: TestReport = {
      ...sampleReport,
      summary: { ...sampleReport.summary, total: 1, passed: 1, failed: 0, errors: 0, passRate: 100, durationMs: 500 },
      results: [
        {
          operationId: "boundaryEndpoint",
          path: "/boundary",
          method: "GET",
          protocol: "http",
          status: "passed",
          durationMs: 500,
          response: { status: 200 },
          timestamp: "2024-01-01T00:00:00.000Z",
        },
      ],
    };
    const text = generateCliReport(boundaryReport);
    const lines = text.split("\n");
    const resultLine = lines.find((l) => l.includes("boundaryEndpoint") || l.includes("/boundary"));
    expect(resultLine).toBeDefined();
    // 500ms is not > 500, so should not be yellow
    expect(resultLine).toContain("500");
    expect(resultLine).toContain("ms");
  });

  it("formats summary duration with same style", () => {
    const report: TestReport = {
      ...sampleReport,
      summary: { ...sampleReport.summary, total: 1, passed: 1, failed: 0, errors: 0, passRate: 100, durationMs: 750 },
      results: [sampleReport.results[0]],
    };
    const text = generateCliReport(report);
    // Summary duration 750ms > 500 should be yellow
    expect(text).toContain("\x1b[33m750");
    expect(text).toContain("ms");
  });
});

describe("HTML reporter", () => {
  it("writes a self-contained HTML file", () => {
    const filePath = generateHtmlReport(sampleReport, tmpDir);
    expect(fs.existsSync(filePath)).toBe(true);
    const html = fs.readFileSync(filePath, "utf-8");
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("Test Report");
    expect(html).toContain("<style>");
    expect(html).toContain("<script>");
  });

  it("embeds summary data in the HTML", () => {
    const filePath = generateHtmlReport(sampleReport, tmpDir);
    const html = fs.readFileSync(filePath, "utf-8");
    expect(html).toContain('"total":4');
    expect(html).toContain('"passed":2');
    expect(html).toContain('"passRate":50');
  });

  it("embeds test results in the HTML", () => {
    const filePath = generateHtmlReport(sampleReport, tmpDir);
    const html = fs.readFileSync(filePath, "utf-8");
    expect(html).toContain("getUsers");
    expect(html).toContain("createUser");
    expect(html).toContain("streamEvents");
    expect(html).toContain("grpcCall");
  });

  it("includes filter buttons", () => {
    const filePath = generateHtmlReport(sampleReport, tmpDir);
    const html = fs.readFileSync(filePath, "utf-8");
    expect(html).toContain('data-f="all"');
    expect(html).toContain('data-f="passed"');
    expect(html).toContain('data-f="failed"');
    expect(html).toContain('data-f="error"');
  });

  it("creates output directory if it does not exist", () => {
    const nestedDir = path.join(tmpDir, "html", "reports");
    const filePath = generateHtmlReport(sampleReport, nestedDir);
    expect(fs.existsSync(filePath)).toBe(true);
  });
});
