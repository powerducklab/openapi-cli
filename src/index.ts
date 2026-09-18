/**
 * @powerduck/openapi-cli — CI-ready batch and scenario testing for OpenAPI 3.2.
 *
 * Batch (flat, concurrent):
 *   import { runTests, resolveConfig, printCliReport } from "@powerduck/openapi-cli";
 *   const config = resolveConfig({ spec: "./openapi.json" });
 *   const report = await runTests(config);
 *
 * Scenario (ordered, stateful business flow with shared variables):
 *   import { runScenario } from "@powerduck/openapi-cli";
 *   const scenario = {
 *     name: "register then read profile",
 *     steps: [
 *       { ref: "POST /register", request: { extract: [{ name: "token", from: "body", path: "$.data.token" }] } },
 *       { ref: "GET /me", request: { values: { header: { Authorization: "Bearer {{token}}" } } } },
 *     ],
 *   };
 *   const result = await runScenario(scenario, { config, onEvent: console.log });
 */
export {
  runTests,
  collectOperations,
  executeStep,
  buildSummary,
  formatAssertionError,
  buildImplicitAssertions,
} from "./runner.js";
export { runScenario, resolveSteps, applyExtracts, stepRef } from "./scenario.js";
export { resolveConfig, loadSpec, isRemoteSpec, DEFAULT_CONFIG, type CliArgs } from "./config.js";
export {
  runDeclarativeAssertions,
  extractAssertions,
  extractPostmanScripts,
  resolveJsonPath,
  type DeclarativeAssertion,
} from "./assertions.js";
export {
  generateJsonReport,
  generateCliReport,
  printCliReport,
  generateHtmlReport,
} from "./reporters/index.js";
export type {
  CliConfig,
  TestReport,
  TestResult,
  TestSummary,
  AssertionResult,
  ReportFormat,
  ProtocolName,
  TestStatus,
  AuthConfig,
  TlsConfig,
  FilterConfig,
  ScenarioDefinition,
  ScenarioStep,
  ScenarioStepRequest,
  ScenarioExtract,
  ScenarioStatus,
  ScenarioStepResult,
  ScenarioEvent,
  ScenarioEventType,
  ScenarioReport,
  RunScenarioOptions,
} from "./types.js";
