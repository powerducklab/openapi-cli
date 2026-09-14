// Tests for the declarative assertion engine.
import { describe, expect, it } from "vitest";
import {
  runDeclarativeAssertions,
  resolveJsonPath,
  extractAssertions,
  extractPostmanScripts,
  type DeclarativeAssertion,
} from "../src/assertions.js";

const ctx = {
  status: 200,
  headers: { "content-type": "application/json", "x-custom": "hello" },
  body: { data: { id: 42, name: "test", items: [{ v: 1 }, { v: 2 }] } },
  bodyText: JSON.stringify({ data: { id: 42, name: "test" } }),
  durationMs: 150,
};

describe("status assertions", () => {
  it("passes when status matches", () => {
    const results = runDeclarativeAssertions(
      [{ name: "status 200", assert: "status", value: 200 }],
      ctx,
    );
    expect(results[0].passed).toBe(true);
  });

  it("fails when status does not match", () => {
    const results = runDeclarativeAssertions(
      [{ name: "status 404", assert: "status", value: 404 }],
      ctx,
    );
    expect(results[0].passed).toBe(false);
  });

  it("throws when value is missing", () => {
    const results = runDeclarativeAssertions(
      [{ name: "bad", assert: "status" }],
      ctx,
    );
    expect(results[0].passed).toBe(false);
    expect(results[0].error).toContain("value");
  });
});

describe("header assertions", () => {
  it("passes when header exists", () => {
    const results = runDeclarativeAssertions(
      [{ name: "has content-type", assert: "header", key: "content-type" }],
      ctx,
    );
    expect(results[0].passed).toBe(true);
  });

  it("passes when header contains substring (case-insensitive)", () => {
    const results = runDeclarativeAssertions(
      [{ name: "content-type is json", assert: "header", key: "Content-Type", contains: "application/json" }],
      ctx,
    );
    expect(results[0].passed).toBe(true);
  });

  it("fails when header does not exist", () => {
    const results = runDeclarativeAssertions(
      [{ name: "has x-missing", assert: "header", key: "x-missing" }],
      ctx,
    );
    expect(results[0].passed).toBe(false);
  });

  it("fails when header does not contain substring", () => {
    const results = runDeclarativeAssertions(
      [{ name: "content-type is xml", assert: "header", key: "content-type", contains: "text/xml" }],
      ctx,
    );
    expect(results[0].passed).toBe(false);
  });
});

describe("bodyContains assertions", () => {
  it("passes when body contains substring", () => {
    const results = runDeclarativeAssertions(
      [{ name: "body has test", assert: "bodyContains", contains: "test" }],
      ctx,
    );
    expect(results[0].passed).toBe(true);
  });

  it("fails when body does not contain substring", () => {
    const results = runDeclarativeAssertions(
      [{ name: "body has missing", assert: "bodyContains", contains: "missing-value" }],
      ctx,
    );
    expect(results[0].passed).toBe(false);
  });
});

describe("jsonPath assertions", () => {
  it("resolves dot-notation paths", () => {
    expect(resolveJsonPath(ctx.body, "$.data.id")).toBe(42);
    expect(resolveJsonPath(ctx.body, "data.name")).toBe("test");
  });

  it("resolves array indices", () => {
    expect(resolveJsonPath(ctx.body, "$.data.items[0].v")).toBe(1);
    expect(resolveJsonPath(ctx.body, "$.data.items[1].v")).toBe(2);
  });

  it("returns undefined for missing paths", () => {
    expect(resolveJsonPath(ctx.body, "$.data.missing")).toBeUndefined();
    expect(resolveJsonPath(ctx.body, "$.data.items[5].v")).toBeUndefined();
  });

  it("passes exists assertion when path exists", () => {
    const results = runDeclarativeAssertions(
      [{ name: "id exists", assert: "jsonPath", path: "$.data.id", exists: true }],
      ctx,
    );
    expect(results[0].passed).toBe(true);
  });

  it("fails exists assertion when path missing", () => {
    const results = runDeclarativeAssertions(
      [{ name: "missing exists", assert: "jsonPath", path: "$.data.missing", exists: true }],
      ctx,
    );
    expect(results[0].passed).toBe(false);
  });

  it("passes equals assertion", () => {
    const results = runDeclarativeAssertions(
      [{ name: "id is 42", assert: "jsonPath", path: "$.data.id", equals: 42 }],
      ctx,
    );
    expect(results[0].passed).toBe(true);
  });

  it("fails equals assertion on mismatch", () => {
    const results = runDeclarativeAssertions(
      [{ name: "id is 99", assert: "jsonPath", path: "$.data.id", equals: 99 }],
      ctx,
    );
    expect(results[0].passed).toBe(false);
  });
});

describe("responseTime assertions", () => {
  it("passes when within max", () => {
    const results = runDeclarativeAssertions(
      [{ name: "fast", assert: "responseTime", max: 1000 }],
      ctx,
    );
    expect(results[0].passed).toBe(true);
  });

  it("fails when exceeds max", () => {
    const results = runDeclarativeAssertions(
      [{ name: "too slow", assert: "responseTime", max: 100 }],
      ctx,
    );
    expect(results[0].passed).toBe(false);
  });
});

describe("extractAssertions", () => {
  it("extracts x-tests from operation", () => {
    const operation = {
      "x-tests": [
        { name: "a", assert: "status", value: 200 },
        { name: "b", assert: "header", key: "content-type" },
      ],
    };
    const assertions = extractAssertions(operation);
    expect(assertions).toHaveLength(2);
    expect(assertions[0].name).toBe("a");
  });

  it("merges x-tests from path item and operation", () => {
    const pathItem = { "x-tests": [{ name: "path-level", assert: "status", value: 200 }] };
    const operation = { "x-tests": [{ name: "op-level", assert: "status", value: 200 }] };
    const assertions = extractAssertions(operation, pathItem);
    expect(assertions).toHaveLength(2);
    expect(assertions[0].name).toBe("path-level");
    expect(assertions[1].name).toBe("op-level");
  });

  it("filters out invalid assertions", () => {
    const operation = {
      "x-tests": [
        { name: "valid", assert: "status", value: 200 },
        { name: "no assert" },
        "not an object",
      ],
    };
    const assertions = extractAssertions(operation);
    expect(assertions).toHaveLength(1);
  });

  it("returns empty array when no x-tests", () => {
    expect(extractAssertions({})).toEqual([]);
  });
});

describe("extractPostmanScripts", () => {
  it("extracts test script from x-postman-scripts", () => {
    const operation = {
      "x-postman-scripts": { test: "pm.test('status', () => pm.response.to.have.status(200))" },
    };
    expect(extractPostmanScripts(operation)).toBe(
      "pm.test('status', () => pm.response.to.have.status(200))",
    );
  });

  it("returns undefined when no scripts", () => {
    expect(extractPostmanScripts({})).toBeUndefined();
  });
});

describe("multiple assertions", () => {
  it("runs all assertions and returns individual results", () => {
    const assertions: DeclarativeAssertion[] = [
      { name: "status ok", assert: "status", value: 200 },
      { name: "status bad", assert: "status", value: 500 },
      { name: "has ct", assert: "header", key: "content-type" },
    ];
    const results = runDeclarativeAssertions(assertions, ctx);
    expect(results).toHaveLength(3);
    expect(results[0].passed).toBe(true);
    expect(results[1].passed).toBe(false);
    expect(results[2].passed).toBe(true);
  });
});
