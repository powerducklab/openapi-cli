/**
 * CLI reporter: prints a colored, human-readable summary to stdout.
 * No external dependencies — uses ANSI escape codes directly.
 */
import type { TestReport, TestResult } from "../types.js";

const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
  bgGreen: "\x1b[42m",
  bgRed: "\x1b[41m",
  bgYellow: "\x1b[43m",
};

/**
 * Format duration with highlighted number and dimmed unit.
 * Numbers > 500ms are highlighted in yellow for slow test detection.
 */
function formatDuration(ms: number | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return `${C.dim}--ms${C.reset}`;
  const isSlow = ms > 500;
  const numberColor = isSlow ? `${C.bold}${C.yellow}` : C.bold;
  return `${numberColor}${ms}${C.reset}${C.dim}ms${C.reset}`;
}

export function generateCliReport(report: TestReport): string {
  const lines: string[] = [];
  const { summary, results } = report;

  lines.push("");
  lines.push(`${C.bold}${C.cyan}╔══════════════════════════════════════════════════════╗${C.reset}`);
  lines.push(`${C.bold}${C.cyan}║          Powerduck Test Report                       ║${C.reset}`);
  lines.push(`${C.bold}${C.cyan}╚══════════════════════════════════════════════════════╝${C.reset}`);
  lines.push("");

  // Summary bar.
  const passColor = summary.passRate >= 80 ? C.green : summary.passRate >= 50 ? C.yellow : C.red;
  lines.push(
    `${C.bold}  Total:${C.reset} ${summary.total}   ` +
      `${C.green}Passed:${C.reset} ${summary.passed}   ` +
      `${C.red}Failed:${C.reset} ${summary.failed}   ` +
      `${C.yellow}Errors:${C.reset} ${summary.errors}   ` +
      `${passColor}Rate:${C.reset} ${summary.passRate}%   ` +
      `${C.dim}Time:${C.reset} ${formatDuration(summary.durationMs)}`,
  );
  lines.push("");

  // Progress bar.
  const barWidth = 50;
  const passedWidth = summary.total > 0 ? Math.round((summary.passed / summary.total) * barWidth) : 0;
  const failedWidth = summary.total > 0 ? Math.round((summary.failed / summary.total) * barWidth) : 0;
  const errorWidth = summary.total > 0 ? Math.round((summary.errors / summary.total) * barWidth) : 0;
  const bar =
    C.green + "█".repeat(passedWidth) +
    C.red + "█".repeat(failedWidth) +
    C.yellow + "█".repeat(errorWidth) +
    C.gray + "░".repeat(Math.max(0, barWidth - passedWidth - failedWidth - errorWidth)) +
    C.reset;
  lines.push(`  [${bar}]`);
  lines.push("");

  // Per-result details.
  for (const result of results) {
    lines.push(formatResult(result));
  }

  lines.push("");
  if (summary.failed > 0 || summary.errors > 0) {
    lines.push(`${C.bold}${C.red}  ✗ ${summary.failed + summary.errors} test(s) did not pass${C.reset}`);
  } else {
    lines.push(`${C.bold}${C.green}  ✓ All ${summary.total} test(s) passed${C.reset}`);
  }
  lines.push(`  ${C.dim}Generated: ${report.generatedAt}${C.reset}`);
  lines.push("");

  return lines.join("\n");
}

function formatResult(r: TestResult): string {
  const icon =
    r.status === "passed" ? `${C.green}✓${C.reset}` :
    r.status === "failed" ? `${C.red}✗${C.reset}` :
    r.status === "error" ? `${C.yellow}!${C.reset}` :
    `${C.gray}-${C.reset}`;

  const statusBadge =
    r.status === "passed" ? `${C.bgGreen}${C.bold} PASS ${C.reset}` :
    r.status === "failed" ? `${C.bgRed}${C.bold} FAIL ${C.reset}` :
    r.status === "error" ? `${C.bgYellow}${C.bold} ERROR ${C.reset}` :
    `${C.gray} SKIP ${C.reset}`;

  const proto = r.protocol ? ` ${C.cyan}[${r.protocol}]${C.reset}` : "";
  const statusCode = r.response?.status != null ? ` ${C.dim}${r.response.status}${C.reset}` : "";

  let line = `  ${icon} ${statusBadge} ${C.bold}${r.method}${C.reset} ${r.path}${proto}${statusCode} ${formatDuration(r.durationMs)}`;

  if (r.error) {
    line += `\n      ${C.red}${r.error}${C.reset}`;
  }

  if (r.assertions?.length) {
    for (const a of r.assertions) {
      const aIcon = a.passed ? `${C.green}  ✓${C.reset}` : `${C.red}  ✗${C.reset}`;
      line += `\n      ${aIcon} ${a.name}${a.error ? ` — ${C.red}${a.error}${C.reset}` : ""}`;
    }
  }

  return line;
}

/**
 * Print the CLI report to stdout and return it.
 */
export function printCliReport(report: TestReport): string {
  const text = generateCliReport(report);
  console.log(text);
  return text;
}
