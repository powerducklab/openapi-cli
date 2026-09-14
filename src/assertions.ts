/**
 * Assertion engine. Supports two sources:
 * 1. Declarative `x-tests` array on the operation (simple, JSON-serializable).
 * 2. Postman `x-postman-scripts.test` string (full pm.* API, executed by
 *    @powerduck/openapi-request's script sandbox and surfaced via onAssertion).
 */
import type { AssertionResult } from "./types.js";

export interface DeclarativeAssertion {
  name: string;
  /** What to assert. */
  assert: "status" | "header" | "bodyContains" | "jsonPath" | "responseTime" | "bodyEquals";
  /** Expected status code (for assert=status). */
  value?: number;
  /** Header name (for assert=header). */
  key?: string;
  /** Substring to check (for assert=header / bodyContains). */
  contains?: string;
  /** JSONPath expression (for assert=jsonPath). Simple dot-notation supported. */
  path?: string;
  /** Expected value at path (for assert=jsonPath). */
  equals?: unknown;
  /** Whether the path must exist (for assert=jsonPath). */
  exists?: boolean;
  /** Max response time in ms (for assert=responseTime). */
  max?: number;
  /** Expected body string (for assert=bodyEquals). */
  body?: string;
}

export interface AssertionContext {
  status?: number;
  headers?: Record<string, string>;
  body?: unknown;
  bodyText?: string;
  durationMs: number;
}

/**
 * Run declarative assertions against a response context.
 */
export function runDeclarativeAssertions(
  assertions: DeclarativeAssertion[],
  ctx: AssertionContext,
): AssertionResult[] {
  return assertions.map((a) => {
    try {
      const passed = evaluateAssertion(a, ctx);
      return { name: a.name, passed };
    } catch (e) {
      return {
        name: a.name,
        passed: false,
        error: (e as Error).message,
      };
    }
  });
}

function evaluateAssertion(a: DeclarativeAssertion, ctx: AssertionContext): boolean {
  switch (a.assert) {
    case "status":
      if (a.value === undefined) throw new Error("status assertion requires 'value'");
      return ctx.status === a.value;

    case "header": {
      if (!a.key) throw new Error("header assertion requires 'key'");
      const headerValue = findHeader(ctx.headers ?? {}, a.key);
      if (headerValue === undefined) return false;
      if (a.contains !== undefined) {
        return headerValue.toLowerCase().includes(a.contains.toLowerCase());
      }
      return true;
    }

    case "bodyContains": {
      if (a.contains === undefined) throw new Error("bodyContains assertion requires 'contains'");
      const text = ctx.bodyText ?? JSON.stringify(ctx.body ?? "");
      return text.includes(a.contains);
    }

    case "bodyEquals": {
      if (a.body === undefined) throw new Error("bodyEquals assertion requires 'body'");
      const text = ctx.bodyText ?? JSON.stringify(ctx.body ?? "");
      return text === a.body;
    }

    case "jsonPath": {
      if (!a.path) throw new Error("jsonPath assertion requires 'path'");
      const value = resolveJsonPath(ctx.body, a.path);
      if (a.exists !== undefined) {
        return a.exists ? value !== undefined : value === undefined;
      }
      if (a.equals !== undefined) {
        return deepEqual(value, a.equals);
      }
      return value !== undefined;
    }

    case "responseTime": {
      if (a.max === undefined) throw new Error("responseTime assertion requires 'max'");
      return ctx.durationMs <= a.max;
    }

    default:
      throw new Error(`Unknown assertion type: ${a.assert}`);
  }
}

function findHeader(headers: Record<string, string>, name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lower) return v;
  }
  return undefined;
}

/**
 * Minimal JSONPath resolver supporting dot notation and array indices.
 * e.g. "$.data.items[0].id" or "data.user.name"
 */
export function resolveJsonPath(obj: unknown, path: string): unknown {
  const clean = path.replace(/^\$\.?/, "");
  if (!clean) return obj;
  const parts = clean.split(/\.|\[(\d+)\]/).filter((p) => p !== undefined && p !== "");
  let current: unknown = obj;
  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    if (/^\d+$/.test(part)) {
      current = (current as unknown[])[Number(part)];
    } else {
      current = (current as Record<string, unknown>)[part];
    }
  }
  return current;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (typeof a !== "object") return a === b;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  const aKeys = Object.keys(a as Record<string, unknown>);
  const bKeys = Object.keys(b as Record<string, unknown>);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((k) =>
    deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
  );
}

/**
 * Extract declarative assertions from an OpenAPI operation.
 * Looks for `x-tests` on the operation or path item.
 */
export function extractAssertions(operation: any, pathItem?: any): DeclarativeAssertion[] {
  const fromOp = operation?.["x-tests"];
  const fromPath = pathItem?.["x-tests"];
  const combined = [...(Array.isArray(fromPath) ? fromPath : []), ...(Array.isArray(fromOp) ? fromOp : [])];
  return combined.filter((a) => a && typeof a === "object" && a.assert && a.name);
}

/**
 * Extract Postman test scripts from an operation.
 * Looks for `x-postman-scripts.test` on the operation.
 */
export function extractPostmanScripts(operation: any): string | undefined {
  const scripts = operation?.["x-postman-scripts"];
  if (scripts && typeof scripts === "object" && typeof scripts.test === "string") {
    return scripts.test;
  }
  return undefined;
}
