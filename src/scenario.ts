/**
 * Ordered, stateful scenario engine.
 *
 * A scenario runs a sequence of operations in order with a single shared
 * variable scope. Each step can:
 *   - override request values and the server URL,
 *   - extract response values (body JSONPath, header, status) into scope,
 *   - inherit variables produced by earlier steps or by Postman scripts,
 *   - add declarative assertions on top of the operation's own checks.
 *
 * Progress is streamed through `onEvent`, and an AbortSignal cancels the run.
 */
import { createClient } from "@powerduck/openapi-request";
import {
  buildSummary,
  collectOperations,
  executeStep,
  type OperationInfo,
} from "./runner.js";
import { loadSpec } from "./config.js";
import { resolveJsonPath } from "./assertions.js";
import type {
  CliConfig,
  RunScenarioOptions,
  ScenarioDefinition,
  ScenarioEvent,
  ScenarioEventType,
  ScenarioExtract,
  ScenarioReport,
  ScenarioStatus,
  ScenarioStep,
  ScenarioStepResult,
  TestResult,
} from "./types.js";

const VERSION = "0.1.0";

interface ResolvedStep {
  step: ScenarioStep;
  op: OperationInfo;
  ref: string;
}

/** Normalize a step reference to "METHOD /path". */
export function stepRef(step: ScenarioStep): string {
  if (step.method && step.path) {
    return `${step.method.toUpperCase()} ${step.path}`;
  }
  const ref = (step.ref ?? "").trim();
  const space = ref.indexOf(" ");
  if (space > 0) {
    return `${ref.slice(0, space).toUpperCase()} ${ref.slice(space + 1).trim()}`;
  }
  return ref;
}

/** Resolve every step reference up front so a bad plan fails before any call. */
export function resolveSteps(
  definition: ScenarioDefinition,
  operations: OperationInfo[],
): ResolvedStep[] {
  const byRef = new Map<string, OperationInfo>();
  const byOperationId = new Map<string, OperationInfo>();
  for (const op of operations) {
    byRef.set(`${op.method.toUpperCase()} ${op.path}`, op);
    byOperationId.set(op.operationId, op);
  }

  const resolved: ResolvedStep[] = [];
  const missing: string[] = [];

  definition.steps.forEach((step, index) => {
    const ref = stepRef(step);
    const op = byRef.get(ref) ?? (ref ? byOperationId.get(ref) : undefined);
    if (!op) {
      missing.push(`step ${index} ("${step.name ?? ref}") -> ${ref || "<empty ref>"}`);
      return;
    }
    resolved.push({ step, op, ref: `${op.method.toUpperCase()} ${op.path}` });
  });

  if (missing.length) {
    throw new Error(`Scenario references operations not present in the spec: ${missing.join("; ")}`);
  }
  return resolved;
}

function findHeader(headers: Record<string, string> | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower) return value;
  }
  return undefined;
}

function stringifyValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** Read declared extracts out of a normalized response. Missing values are omitted. */
export function applyExtracts(
  extracts: ScenarioExtract[] | undefined,
  response: TestResult["response"],
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!extracts?.length) return out;

  for (const ex of extracts) {
    let raw: unknown;
    if (ex.from === "status") {
      raw = response?.status;
    } else if (ex.from === "header") {
      raw = ex.key ? findHeader(response?.headers, ex.key) : undefined;
    } else {
      raw = resolveJsonPath(response?.body, ex.path ?? "$");
    }
    if (raw !== undefined && raw !== null) {
      out[ex.name] = stringifyValue(raw);
    }
  }
  return out;
}

function baseSkippedResult(
  index: number,
  ref: string,
  step: ScenarioStep,
  reason: string,
): ScenarioStepResult {
  return {
    index,
    ref,
    name: step.name,
    operationId: ref,
    path: ref.includes(" ") ? ref.slice(ref.indexOf(" ") + 1) : ref,
    method: ref.includes(" ") ? ref.slice(0, ref.indexOf(" ")) : "",
    protocol: "",
    status: "skipped",
    durationMs: 0,
    timestamp: new Date().toISOString(),
    notRun: true,
    notRunReason: reason,
  };
}

/**
 * Execute a scenario in order with a shared variable scope.
 */
export async function runScenario(
  definition: ScenarioDefinition,
  options: RunScenarioOptions,
): Promise<ScenarioReport> {
  const { config, onEvent, signal } = options;
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();

  const emit = (event: ScenarioEvent) => {
    try {
      onEvent?.(event);
    } catch {
      // A throwing listener must never abort the run.
    }
  };

  const spec = options.spec ?? (await loadSpec(config));
  // Scenario steps may target any operation, ignoring the batch filter.
  const operations = collectOperations(spec as any, { ...config, filter: undefined });
  const resolved = resolveSteps(definition, operations);
  const client = createClient();

  const active: Record<string, string> = {
    ...(config.variables ?? {}),
    ...(definition.variables ?? {}),
  };

  const stopOnFailure = definition.stopOnFailure !== false;
  const steps: ScenarioStepResult[] = [];
  let status: ScenarioStatus = "passed";
  let halted = false;

  emit({ type: "scenario:start", scenario: definition.name, status });

  for (let i = 0; i < resolved.length; i++) {
    const { step, op, ref } = resolved[i];

    if (signal?.aborted) {
      status = "cancelled";
      steps.push(baseSkippedResult(i, ref, step, "Scenario cancelled"));
      emit({ type: "step:skip", scenario: definition.name, stepIndex: i, step: steps[i] });
      halted = true;
      break;
    }

    if (step.skip) {
      const skipped = baseSkippedResult(i, ref, step, "Skipped by plan");
      steps.push(skipped);
      emit({ type: "step:skip", scenario: definition.name, stepIndex: i, step: skipped });
      continue;
    }

    emit({ type: "step:start", scenario: definition.name, stepIndex: i });

    const execution = await executeStep(client, op, {
      config,
      spec,
      variables: { ...active },
      values: step.request?.values,
      serverUrl: step.request?.serverUrl,
      extraAssertions: step.request?.assertions,
    });

    // Variables set by Postman scripts (diff against the pre-step scope).
    const before = { ...active };
    Object.assign(active, execution.env);
    const scriptContributed: Record<string, string> = {};
    for (const [key, value] of Object.entries(execution.env)) {
      if (before[key] !== value) scriptContributed[key] = value;
    }

    // Declarative extraction takes precedence.
    const declarative = applyExtracts(step.request?.extract, execution.response);
    Object.assign(active, declarative);

    const extracted: Record<string, string> = { ...scriptContributed, ...declarative };
    const stepResult: ScenarioStepResult = {
      ...execution.result,
      index: i,
      ref,
      name: step.name,
      extracted: Object.keys(extracted).length ? extracted : undefined,
      variablesAfter: { ...active },
    };
    steps.push(stepResult);
    emit({
      type: "step:finish",
      scenario: definition.name,
      stepIndex: i,
      step: stepResult,
    });

    if (stepResult.status === "error") {
      status = "error";
    } else if (stepResult.status === "failed" && status !== "error") {
      status = "failed";
    }

    if ((stepResult.status === "failed" || stepResult.status === "error") && stopOnFailure) {
      halted = true;
      for (let j = i + 1; j < resolved.length; j++) {
        const tail = resolved[j];
        const skipped = baseSkippedResult(
          j,
          tail.ref,
          tail.step,
          `Stopped after ${stepResult.status} step ${i}`,
        );
        steps.push(skipped);
        emit({ type: "step:skip", scenario: definition.name, stepIndex: j, step: skipped });
      }
      break;
    }
  }

  if (signal?.aborted && status !== "error" && status !== "failed") {
    status = "cancelled";
  }

  const durationMs = Date.now() - startedAtMs;
  const finishType: ScenarioEventType = status === "cancelled" ? "scenario:cancel" : "scenario:finish";
  const report: ScenarioReport = {
    name: definition.name,
    description: definition.description,
    status,
    summary: buildSummary(steps, durationMs),
    steps,
    variables: active,
    config,
    startedAt,
    durationMs,
    generatedAt: new Date().toISOString(),
    version: VERSION,
  };
  emit({ type: finishType, scenario: definition.name, status, message: halted ? "halted" : undefined });
  return report;
}
