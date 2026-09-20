/**
 * Ordered, stateful scenario engine.
 *
 * A scenario runs a sequence of operations in order with a single shared
 * variable scope per scenario iteration. Each step can:
 *   - override request values and the server URL,
 *   - extract response values (body JSONPath, header, status) into scope,
 *   - inherit variables produced by earlier steps or by Postman scripts,
 *   - add declarative assertions on top of the operation's own checks,
 *   - repeat itself over step-level data rows.
 *
 * Data-driven iteration:
 *   - definition.data: the whole sequence runs once per row, each time with a
 *     fresh scope; extracts never leak across scenario iterations.
 *   - step.request.data: that step runs once per row inside each scenario
 *     iteration; row values are local to that execution and only the last
 *     execution writes extracts back into the flow.
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

/** Hard guard against pathological declared iteration counts. */
const MAX_SCENARIO_ITERATIONS = 1000;

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
  coords?: {
    scenarioIteration?: number;
    scenarioIterations?: number;
    stepIteration?: number;
    stepIterations?: number;
  },
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
    ...(coords ?? {}),
  };
}

/**
 * Execute a scenario in order with a shared variable scope per scenario
 * iteration. See the file header for data-driven iteration semantics.
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

  const dataRows: Array<Record<string, string> | undefined> =
    definition.data && definition.data.length ? definition.data : [];
  // The declared iteration count always wins when it exceeds the data rows;
  // extra repetitions run with an empty scope instead of being silently dropped.
  const requestedIterations = Math.trunc(Number(definition.iterations));
  const declaredIterations =
    Number.isFinite(requestedIterations) && requestedIterations > 0
      ? Math.min(requestedIterations, MAX_SCENARIO_ITERATIONS)
      : 1;
  const scenarioCount = Math.max(declaredIterations, dataRows.length);
  const scenarioRows: Array<Record<string, string> | undefined> =
    Array.from({ length: scenarioCount }, (_, s) => dataRows[s]);
  const stepCounts = resolved.map(({ step }) =>
    step.request?.data && step.request.data.length ? step.request.data.length : 1,
  );
  const iterations = { scenarioCount: scenarioRows.length, stepCounts };

  const stopOnFailure = definition.stopOnFailure !== false;
  const steps: ScenarioStepResult[] = [];
  let status: ScenarioStatus = "passed";
  let halted = false;
  let cancelled = false;
  /** Exact grid position (scenario, step, row) of the first halt/cancel. */
  let haltPos: { s: number; i: number; t: number } | null = null;
  let haltStatus = "failed";
  let active: Record<string, string> = {
    ...(config.variables ?? {}),
    ...(definition.variables ?? {}),
  };

  emit({
    type: "scenario:start",
    scenario: definition.name,
    status,
    scenarioIterations: scenarioRows.length,
  });

  outer: for (let s = 0; s < scenarioRows.length; s++) {
    // Every scenario iteration starts from an independent variable scope.
    active = {
      ...(config.variables ?? {}),
      ...(definition.variables ?? {}),
      ...(scenarioRows[s] ?? {}),
    };

    for (let i = 0; i < resolved.length; i++) {
      const { step, op, ref } = resolved[i];
      const stepRows: Array<Record<string, string> | undefined> =
        step.request?.data && step.request.data.length ? step.request.data : [undefined];
      const coords = {
        scenarioIteration: s,
        scenarioIterations: scenarioRows.length,
        stepIterations: stepRows.length,
      };

      if (signal?.aborted) {
        status = "cancelled";
        cancelled = true;
        halted = true;
        haltPos = { s, i, t: 0 };
        break outer;
      }

      if (step.skip) {
        // A plan-skipped step still occupies every declared execution so the
        // report grid reconciles with scenario x step iteration counts.
        for (let t = 0; t < stepRows.length; t++) {
          const skipped = baseSkippedResult(i, ref, step, "Skipped by plan", {
            ...coords,
            stepIteration: t,
          });
          steps.push(skipped);
          emit({
            type: "step:skip",
            scenario: definition.name,
            stepIndex: i,
            step: skipped,
            ...coords,
            stepIteration: t,
          });
        }
        continue;
      }

      for (let t = 0; t < stepRows.length; t++) {
        if (signal?.aborted) {
          status = "cancelled";
          cancelled = true;
          halted = true;
          haltPos = { s, i, t };
          break outer;
        }

        emit({
          type: "step:start",
          scenario: definition.name,
          stepIndex: i,
          ...coords,
          stepIteration: t,
        });

        const iterationScope = { ...active, ...(stepRows[t] ?? {}) };
        const execution = await executeStep(client, op, {
          config,
          spec,
          variables: iterationScope,
          values: step.request?.values,
          serverUrl: step.request?.serverUrl,
          extraAssertions: step.request?.assertions,
        });

        // Variables set by Postman scripts (diff against the execution scope).
        const scriptContributed: Record<string, string> = {};
        for (const [key, value] of Object.entries(execution.env)) {
          if (iterationScope[key] !== value) scriptContributed[key] = value;
        }

        // Declarative extraction takes precedence.
        const declarative = applyExtracts(step.request?.extract, execution.response);
        const extracted: Record<string, string> = {
          ...scriptContributed,
          ...declarative,
        };

        // Only the final step iteration writes values back into the flow so
        // earlier data rows cannot pollute downstream steps.
        const isLastStepIteration = t === stepRows.length - 1;
        if (isLastStepIteration) {
          Object.assign(active, execution.env, declarative);
        }

        const stepResult: ScenarioStepResult = {
          ...execution.result,
          index: i,
          ref,
          name: step.name,
          ...coords,
          stepIteration: t,
          extracted: Object.keys(extracted).length ? extracted : undefined,
          variablesAfter: isLastStepIteration
            ? { ...active }
            : { ...active, ...(stepRows[t] ?? {}), ...extracted },
        };
        steps.push(stepResult);
        emit({
          type: "step:finish",
          scenario: definition.name,
          stepIndex: i,
          step: stepResult,
          ...coords,
          stepIteration: t,
        });

        if (stepResult.status === "error") {
          status = "error";
        } else if (stepResult.status === "failed" && status !== "error") {
          status = "failed";
        }

        if (
          (stepResult.status === "failed" || stepResult.status === "error") &&
          stopOnFailure
        ) {
          halted = true;
          haltStatus = stepResult.status;
          haltPos = { s, i, t };
          break outer;
        }
      }
    }
  }

  // Synthesize one skipped result per execution that never ran so the report
  // grid always reconciles with the declared scenario x step counts. Reasons
  // distinguish unrun rows of the failed step, downstream steps in the same
  // scenario iteration, and steps in future scenario iterations.
  if (halted && haltPos) {
    const reasonFor = (s2: number, i2: number): string => {
      if (cancelled) return "Scenario cancelled";
      if (s2 === haltPos.s && i2 === haltPos.i) {
        return `Stopped after ${haltStatus} iteration ${haltPos.t + 1}`;
      }
      if (s2 === haltPos.s) {
        return `Stopped after ${haltStatus} step ${haltPos.i + 1}`;
      }
      return `Stopped after ${haltStatus} run ${haltPos.s + 1}`;
    };

    for (let s2 = haltPos.s; s2 < scenarioRows.length; s2++) {
      for (let i2 = s2 === haltPos.s ? haltPos.i : 0; i2 < resolved.length; i2++) {
        const tail = resolved[i2];
        const tailRows =
          tail.step.request?.data && tail.step.request.data.length
            ? tail.step.request.data.length
            : 1;
        const startT = s2 === haltPos.s && i2 === haltPos.i ? haltPos.t + 1 : 0;
        for (let t2 = startT; t2 < tailRows; t2++) {
          const tailCoords = {
            scenarioIteration: s2,
            scenarioIterations: scenarioRows.length,
            stepIteration: t2,
            stepIterations: tailRows,
          };
          const skipped = baseSkippedResult(
            i2,
            tail.ref,
            tail.step,
            reasonFor(s2, i2),
            tailCoords,
          );
          steps.push(skipped);
          emit({
            type: "step:skip",
            scenario: definition.name,
            stepIndex: i2,
            step: skipped,
            ...tailCoords,
          });
        }
      }
    }
  }

  if (cancelled || (signal?.aborted && status !== "error" && status !== "failed")) {
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
    iterations,
    config,
    startedAt,
    durationMs,
    generatedAt: new Date().toISOString(),
    version: VERSION,
  };
  emit({ type: finishType, scenario: definition.name, status, message: halted ? "halted" : undefined });
  return report;
}
