/**
 * JSON reporter: writes the full TestReport as a pretty-printed JSON file.
 */
import fs from "node:fs";
import path from "node:path";
import type { TestReport } from "../types.js";

export function generateJsonReport(report: TestReport, outputDir: string): string {
  const dir = path.resolve(outputDir);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, "report.json");
  fs.writeFileSync(filePath, JSON.stringify(report, null, 2), "utf-8");
  return filePath;
}
