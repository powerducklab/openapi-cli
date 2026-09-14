/**
 * Configuration resolution: CLI args > config file > defaults.
 * Also handles .env file loading and environment variable expansion.
 */
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import https from "node:https";
import { dereference } from "@powerduck/openapi-parser";
import type { CliConfig } from "./types.js";

export const DEFAULT_CONFIG: Required<
  Pick<
    CliConfig,
    "outputDir" | "formats" | "concurrency" | "timeout" | "failOnError" | "grpcReflection" | "mcpTransport"
  >
> = {
  outputDir: "./openapi-cli-report",
  formats: ["json", "cli", "html"],
  concurrency: 5,
  timeout: 30000,
  failOnError: true,
  grpcReflection: true,
  mcpTransport: "streamable-http",
};

export interface CliArgs {
  spec?: string;
  server?: string;
  output?: string;
  format?: string;
  method?: string;
  path?: string;
  tag?: string;
  operationId?: string;
  concurrency?: number;
  timeout?: number;
  proxy?: string;
  ca?: string;
  cert?: string;
  key?: string;
  insecure?: boolean;
  header?: string[];
  bearer?: string;
  variable?: string[];
  config?: string;
  env?: string;
  failOnError?: boolean;
  grpcReflection?: boolean;
  grpcProto?: string[];
  mcpTransport?: string;
  mcpCommand?: string;
  mcpArgs?: string;
  mcpCwd?: string;
}

/**
 * Resolve the final CliConfig from CLI args, an optional config file,
 * environment variables, and defaults.
 */
export function resolveConfig(args: CliArgs): CliConfig {
  const fileConfig = args.config ? loadConfigFile(args.config) : {};

  const config: CliConfig = {
    specPath: args.spec ?? fileConfig.specPath ?? "",
    serverUrl: args.server ?? fileConfig.serverUrl,
    outputDir: args.output ?? fileConfig.outputDir ?? DEFAULT_CONFIG.outputDir,
    formats: parseFormats(args.format ?? fileConfig.formats),
    filter: resolveFilter(args, fileConfig),
    concurrency: args.concurrency ?? fileConfig.concurrency ?? DEFAULT_CONFIG.concurrency,
    timeout: args.timeout ?? fileConfig.timeout ?? DEFAULT_CONFIG.timeout,
    proxy: args.proxy ?? fileConfig.proxy,
    tls: {
      caCert: args.ca ?? fileConfig.tls?.caCert,
      clientCert: args.cert ?? fileConfig.tls?.clientCert,
      clientKey: args.key ?? fileConfig.tls?.clientKey,
      strictSSL: args.insecure !== undefined ? !args.insecure : fileConfig.tls?.strictSSL,
    },
    headers: mergeHeaders(args.header, fileConfig.headers),
    auth: resolveAuth(args, fileConfig),
    variables: mergeVariables(args.variable, fileConfig.variables),
    failOnError: args.failOnError ?? fileConfig.failOnError ?? DEFAULT_CONFIG.failOnError,
    envFile: args.env ?? fileConfig.envFile,
    grpcReflection: args.grpcReflection ?? fileConfig.grpcReflection ?? DEFAULT_CONFIG.grpcReflection,
    grpcProtoPaths: args.grpcProto ?? fileConfig.grpcProtoPaths,
    mcpTransport: (args.mcpTransport as CliConfig["mcpTransport"]) ?? fileConfig.mcpTransport ?? DEFAULT_CONFIG.mcpTransport,
    mcpCommand: args.mcpCommand ?? fileConfig.mcpCommand,
    mcpArgs: args.mcpArgs ? args.mcpArgs.split(/[\s,]+/).filter(Boolean) : fileConfig.mcpArgs,
    mcpCwd: args.mcpCwd ?? fileConfig.mcpCwd,
  };

  if (config.envFile) {
    loadEnvFile(config.envFile, config);
  }

  // Expand ${ENV_VAR} references in string values.
  expandEnvVars(config);

  if (!config.specPath) {
    throw new Error("No OpenAPI spec path provided. Use --spec <path> or set specPath in config.");
  }

  if (config.proxy) {
    try {
      new URL(config.proxy);
    } catch {
      throw new Error(`Invalid proxy URL: ${config.proxy}`);
    }
  }

  return config;
}

function loadConfigFile(configPath: string): Partial<CliConfig> {
  const resolved = path.resolve(configPath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Config file not found: ${resolved}`);
  }
  const raw = fs.readFileSync(resolved, "utf-8");
  try {
    return JSON.parse(raw) as Partial<CliConfig>;
  } catch (e) {
    throw new Error(`Invalid config file (must be JSON): ${(e as Error).message}`);
  }
}

function parseFormats(raw: unknown): CliConfig["formats"] {
  if (Array.isArray(raw)) return raw as CliConfig["formats"];
  if (typeof raw === "string") {
    return raw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean) as CliConfig["formats"];
  }
  return DEFAULT_CONFIG.formats;
}

function resolveFilter(args: CliArgs, file: Partial<CliConfig>): CliConfig["filter"] {
  const methods = args.method
    ? args.method.split(",").map((s) => s.trim().toLowerCase())
    : file.filter?.methods;
  const paths = args.path ? args.path.split(",").map((s) => s.trim()) : file.filter?.paths;
  const tags = args.tag ? args.tag.split(",").map((s) => s.trim()) : file.filter?.tags;
  const operationIds = args.operationId
    ? args.operationId.split(",").map((s) => s.trim())
    : file.filter?.operationIds;
  if (!methods && !paths && !tags && !operationIds) return undefined;
  return { methods, paths, tags, operationIds };
}

function mergeHeaders(
  cliHeaders: string[] | undefined,
  fileHeaders: Record<string, string> | undefined,
): Record<string, string> | undefined {
  const out: Record<string, string> = { ...(fileHeaders ?? {}) };
  for (const h of cliHeaders ?? []) {
    const idx = h.indexOf(":");
    if (idx > 0) {
      const key = h.slice(0, idx).trim();
      const value = h.slice(idx + 1).trim();
      if (key) out[key] = value;
    }
  }
  return Object.keys(out).length ? out : undefined;
}

function resolveAuth(args: CliArgs, file: Partial<CliConfig>): CliConfig["auth"] {
  if (args.bearer) {
    return { type: "bearer", token: args.bearer };
  }
  return file.auth;
}

function mergeVariables(
  cliVars: string[] | undefined,
  fileVars: Record<string, string> | undefined,
): Record<string, string> | undefined {
  const out: Record<string, string> = { ...(fileVars ?? {}) };
  for (const v of cliVars ?? []) {
    const idx = v.indexOf("=");
    if (idx > 0) {
      out[v.slice(0, idx).trim()] = v.slice(idx + 1).trim();
    }
  }
  return Object.keys(out).length ? out : undefined;
}

function loadEnvFile(envPath: string, config: CliConfig): void {
  const resolved = path.resolve(envPath);
  if (!fs.existsSync(resolved)) return;
  const lines = fs.readFileSync(resolved, "utf-8").split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx > 0) {
      const key = trimmed.slice(0, idx).trim();
      const value = trimmed.slice(idx + 1).trim().replace(/^["']|["']$/g, "");
      if (!(key in process.env)) {
        process.env[key] = value;
      }
    }
  }
}

function expandEnvVars(config: CliConfig): void {
  const expand = (val: unknown): unknown => {
    if (typeof val !== "string") return val;
    return val.replace(/\$\{([^}]+)\}/g, (_, name) => process.env[name] ?? "");
  };
  config.serverUrl = expand(config.serverUrl) as string | undefined;
  config.proxy = expand(config.proxy) as string | undefined;
  if (config.headers) {
    for (const [k, v] of Object.entries(config.headers)) {
      config.headers[k] = expand(v) as string;
    }
  }
  if (config.auth?.token) {
    config.auth.token = expand(config.auth.token) as string;
  }
  if (config.variables) {
    for (const [k, v] of Object.entries(config.variables)) {
      config.variables[k] = expand(v) as string;
    }
  }
}

/**
 * Check whether a spec path is a remote URL.
 */
export function isRemoteSpec(specPath: string): boolean {
  return /^https?:\/\//i.test(specPath.trim());
}

/**
 * Fetch a remote OpenAPI spec over HTTP(S).
 * Follows up to 5 redirects, enforces a timeout, and validates the body.
 */
function fetchRemoteSpec(url: string, timeoutMs: number): Promise<string> {
  const maxRedirects = 5;
  let redirects = 0;

  return new Promise((resolve, reject) => {
    const fetch = (target: string) => {
      const parsed = new URL(target);
      const lib = parsed.protocol === "https:" ? https : http;
      const req = lib.get(
        target,
        {
          timeout: timeoutMs,
          headers: { Accept: "application/json, text/plain, */*", "User-Agent": "@powerduck/openapi-cli" },
        },
        (res) => {
          // Handle redirects.
          if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            if (++redirects > maxRedirects) {
              res.resume();
              reject(new Error(`Too many redirects (>${maxRedirects}) while fetching spec: ${url}`));
              return;
            }
            const next = new URL(res.headers.location, target).toString();
            res.resume();
            fetch(next);
            return;
          }
          if (res.statusCode !== 200) {
            res.resume();
            reject(new Error(`Failed to fetch spec from ${target}: HTTP ${res.statusCode} ${res.statusMessage ?? ""}`.trim()));
            return;
          }
          const chunks: Buffer[] = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
          res.on("error", (e) => reject(new Error(`Error reading spec response: ${e.message}`)));
        },
      );
      req.on("timeout", () => {
        req.destroy(new Error(`Timed out after ${timeoutMs}ms while fetching spec: ${url}`));
      });
      req.on("error", (e) => reject(new Error(`Network error fetching spec ${url}: ${e.message}`)));
    };
    fetch(url);
  });
}

/**
 * Parse raw spec text into a validated OpenAPI object.
 */
function parseSpec(raw: string, source: string): any {
  let spec: any;
  try {
    spec = JSON.parse(raw);
  } catch (e) {
    throw new Error(`Spec from ${source} is not valid JSON: ${(e as Error).message}`);
  }
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) {
    throw new Error(`Spec from ${source} is not a JSON object`);
  }
  if (!spec.paths || typeof spec.paths !== "object") {
    throw new Error(`Spec from ${source} does not contain a valid 'paths' object`);
  }
  return spec;
}

/**
 * Resolve internal $ref pointers in a single-file OpenAPI document.
 * External (cross-file) refs are left intact. Circular refs are ignored.
 */
async function resolveRefs(spec: any, source: string): Promise<any> {
  try {
    const result = await dereference(spec);
    if (result.errors && result.errors.length > 0) {
      // Return original spec if dereferencing produced errors; the caller
      // can still operate on unresolved references for most test paths.
      return spec;
    }
    return result.schema ?? result.specification ?? spec;
  } catch (e) {
    // Dereferencing is best-effort. If it fails, return the original spec
    // so that test execution can still proceed with unresolved $refs.
    return spec;
  }
}

/**
 * Load and parse the OpenAPI spec from a local file or remote URL.
 */
export async function loadSpec(config: CliConfig): Promise<any> {
  const source = config.specPath.trim();

  let raw: string;
  if (isRemoteSpec(source)) {
    raw = await fetchRemoteSpec(source, config.timeout ?? DEFAULT_CONFIG.timeout);
  } else {
    const resolved = path.resolve(source);
    if (!fs.existsSync(resolved)) {
      throw new Error(`OpenAPI spec not found: ${resolved}`);
    }
    const stat = fs.statSync(resolved);
    if (!stat.isFile()) {
      throw new Error(`OpenAPI spec path is not a file: ${resolved}`);
    }
    raw = fs.readFileSync(resolved, "utf-8");
  }

  const spec = parseSpec(raw, source);
  return resolveRefs(spec, source);
}
