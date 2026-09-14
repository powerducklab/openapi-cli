/**
 * @powerduck/openapi-cli — CI-ready batch testing for OpenAPI 3.2 documents.
 *
 * Programmatic API:
 *   import { runTests, resolveConfig, generateJsonReport, printCliReport, generateHtmlReport } from "@powerduck/openapi-cli";
 *
 *   const config = resolveConfig({ spec: "./openapi.json" });
 *   const report = await runTests(config);
 *   printCliReport(report);
 *   generateJsonReport(report, "./out");
 *   generateHtmlReport(report, "./out");
 */
export { runTests } from "./runner.js";
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
} from "./types.js";
