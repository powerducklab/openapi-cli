// Tests for config resolution: CLI args > config file > defaults.
import { describe, expect, it, beforeEach, afterEach, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { resolveConfig, loadSpec, isRemoteSpec, DEFAULT_CONFIG } from "../src/config.js";
import type { CliArgs } from "../src/config.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pduck-cli-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("resolveConfig defaults", () => {
  it("applies default values when only spec is provided", () => {
    const config = resolveConfig({ spec: "./openapi.json" });
    expect(config.specPath).toBe("./openapi.json");
    expect(config.outputDir).toBe(DEFAULT_CONFIG.outputDir);
    expect(config.formats).toEqual(DEFAULT_CONFIG.formats);
    expect(config.concurrency).toBe(DEFAULT_CONFIG.concurrency);
    expect(config.timeout).toBe(DEFAULT_CONFIG.timeout);
    expect(config.failOnError).toBe(true);
    expect(config.grpcReflection).toBe(true);
    expect(config.mcpTransport).toBe("streamable-http");
  });

  it("throws when no spec path is provided", () => {
    expect(() => resolveConfig({})).toThrow(/No OpenAPI spec path/);
  });
});

describe("resolveConfig CLI args", () => {
  it("parses comma-separated formats", () => {
    const config = resolveConfig({ spec: "./o.json", format: "json,html" });
    expect(config.formats).toEqual(["json", "html"]);
  });

  it("parses comma-separated methods filter", () => {
    const config = resolveConfig({ spec: "./o.json", method: "get,post" });
    expect(config.filter?.methods).toEqual(["get", "post"]);
  });

  it("parses Key: Value headers", () => {
    const config = resolveConfig({
      spec: "./o.json",
      header: ["Authorization: Bearer abc", "X-Custom: value"],
    });
    expect(config.headers).toEqual({
      Authorization: "Bearer abc",
      "X-Custom": "value",
    });
  });

  it("parses KEY=VALUE variables", () => {
    const config = resolveConfig({
      spec: "./o.json",
      variable: ["host=api.example.com", "token=xyz"],
    });
    expect(config.variables).toEqual({ host: "api.example.com", token: "xyz" });
  });

  it("sets bearer auth", () => {
    const config = resolveConfig({ spec: "./o.json", bearer: "my-token" });
    expect(config.auth).toEqual({ type: "bearer", token: "my-token" });
  });

  it("sets insecure mode (strictSSL=false)", () => {
    const config = resolveConfig({ spec: "./o.json", insecure: true });
    expect(config.tls?.strictSSL).toBe(false);
  });

  it("parses concurrency and timeout as numbers", () => {
    const config = resolveConfig({ spec: "./o.json", concurrency: 10, timeout: 5000 });
    expect(config.concurrency).toBe(10);
    expect(config.timeout).toBe(5000);
  });

  it("parses mcp args as space/comma separated", () => {
    const config = resolveConfig({
      spec: "./o.json",
      mcpTransport: "stdio",
      mcpCommand: "npx",
      mcpArgs: "-y @modelcontextprotocol/server-everything",
    });
    expect(config.mcpCommand).toBe("npx");
    expect(config.mcpArgs).toEqual(["-y", "@modelcontextprotocol/server-everything"]);
  });
});

describe("resolveConfig file", () => {
  it("loads config from a JSON file", () => {
    const configPath = path.join(tmpDir, "config.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        specPath: "./from-file.json",
        serverUrl: "https://api.example.com",
        concurrency: 3,
        timeout: 10000,
        headers: { "X-From-File": "yes" },
      }),
    );
    const config = resolveConfig({ config: configPath });
    expect(config.specPath).toBe("./from-file.json");
    expect(config.serverUrl).toBe("https://api.example.com");
    expect(config.concurrency).toBe(3);
    expect(config.timeout).toBe(10000);
    expect(config.headers).toEqual({ "X-From-File": "yes" });
  });

  it("CLI args take precedence over config file", () => {
    const configPath = path.join(tmpDir, "config.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify({ specPath: "./file.json", concurrency: 3, timeout: 10000 }),
    );
    const config = resolveConfig({ config: configPath, concurrency: 8, timeout: 2000 });
    expect(config.concurrency).toBe(8);
    expect(config.timeout).toBe(2000);
    expect(config.specPath).toBe("./file.json");
  });

  it("config file failOnError=false is respected when CLI flag is absent", () => {
    const configPath = path.join(tmpDir, "config-no-fail.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify({ specPath: "./file.json", failOnError: false }),
    );
    const config = resolveConfig({ config: configPath });
    expect(config.failOnError).toBe(false);
  });

  it("explicit failOnError=true overrides config file false", () => {
    const configPath = path.join(tmpDir, "config-no-fail.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify({ specPath: "./file.json", failOnError: false }),
    );
    const config = resolveConfig({ config: configPath, failOnError: true });
    expect(config.failOnError).toBe(true);
  });

  it("throws when config file does not exist", () => {
    expect(() => resolveConfig({ config: "/nonexistent/config.json" })).toThrow(
      /Config file not found/,
    );
  });

  it("throws when config file is invalid JSON", () => {
    const configPath = path.join(tmpDir, "bad.json");
    fs.writeFileSync(configPath, "not json{");
    expect(() => resolveConfig({ config: configPath })).toThrow(/Invalid config file/);
  });
});

describe("resolveConfig env vars", () => {
  it("expands ${ENV_VAR} in serverUrl", () => {
    process.env.TEST_API_HOST = "api.example.com";
    const config = resolveConfig({
      spec: "./o.json",
      server: "https://${TEST_API_HOST}/v1",
    });
    expect(config.serverUrl).toBe("https://api.example.com/v1");
    delete process.env.TEST_API_HOST;
  });

  it("expands ${ENV_VAR} in headers", () => {
    process.env.TEST_TOKEN = "secret123";
    const config = resolveConfig({
      spec: "./o.json",
      header: ["Authorization: Bearer ${TEST_TOKEN}"],
    });
    expect(config.headers?.Authorization).toBe("Bearer secret123");
    delete process.env.TEST_TOKEN;
  });

  it("loads .env file", () => {
    const envPath = path.join(tmpDir, ".env");
    fs.writeFileSync(envPath, "ENV_HOST=env.example.com\nENV_TOKEN=envtoken\n");
    const config = resolveConfig({
      spec: "./o.json",
      env: envPath,
      server: "https://${ENV_HOST}/api",
      header: ["Authorization: Bearer ${ENV_TOKEN}"],
    });
    expect(config.serverUrl).toBe("https://env.example.com/api");
    expect(config.headers?.Authorization).toBe("Bearer envtoken");
  });

  it(".env does not overwrite existing process.env variables", () => {
    process.env.ENV_PRESERVE = "original";
    const envPath = path.join(tmpDir, ".env2");
    fs.writeFileSync(envPath, "ENV_PRESERVE=overwritten\n");
    resolveConfig({ spec: "./o.json", env: envPath });
    expect(process.env.ENV_PRESERVE).toBe("original");
    delete process.env.ENV_PRESERVE;
  });

  it(".env strips surrounding quotes from values", () => {
    const envPath = path.join(tmpDir, ".env3");
    fs.writeFileSync(envPath, 'QUOTED="hello world"\nSINGLE=\'foo bar\'\n');
    const config = resolveConfig({
      spec: "./o.json",
      env: envPath,
      header: ["X-Quoted: ${QUOTED}", "X-Single: ${SINGLE}"],
    });
    expect(config.headers?.["X-Quoted"]).toBe("hello world");
    expect(config.headers?.["X-Single"]).toBe("foo bar");
  });

  it(".env ignores comment lines and blank lines", () => {
    const envPath = path.join(tmpDir, ".env4");
    fs.writeFileSync(envPath, "# this is a comment\n\nCOMMENT_VAR=visible\n# another comment\n");
    const config = resolveConfig({
      spec: "./o.json",
      env: envPath,
      header: ["X-Visible: ${COMMENT_VAR}"],
    });
    expect(config.headers?.["X-Visible"]).toBe("visible");
  });

  it("missing .env file is silently ignored", () => {
    expect(() =>
      resolveConfig({ spec: "./o.json", env: "/nonexistent/.env" }),
    ).not.toThrow();
  });
});

describe("isRemoteSpec", () => {
  it("detects http URLs", () => {
    expect(isRemoteSpec("http://example.com/spec.json")).toBe(true);
  });
  it("detects https URLs", () => {
    expect(isRemoteSpec("https://example.com/spec.json")).toBe(true);
  });
  it("is case-insensitive", () => {
    expect(isRemoteSpec("HTTPS://example.com/spec.json")).toBe(true);
  });
  it("returns false for local paths", () => {
    expect(isRemoteSpec("./openapi.json")).toBe(false);
    expect(isRemoteSpec("/abs/path/openapi.json")).toBe(false);
    expect(isRemoteSpec("openapi.json")).toBe(false);
  });
  it("trims whitespace before checking", () => {
    expect(isRemoteSpec("  https://example.com/spec.json  ")).toBe(true);
  });
});

describe("loadSpec local", () => {
  it("loads and parses a valid OpenAPI JSON file", async () => {
    const specPath = path.join(tmpDir, "openapi.json");
    const spec = {
      openapi: "3.2.0",
      info: { title: "test", version: "1.0.0" },
      paths: { "/users": { get: { operationId: "getUsers" } } },
    };
    fs.writeFileSync(specPath, JSON.stringify(spec));
    const loaded = await loadSpec({ specPath } as any);
    expect(loaded.openapi).toBe("3.2.0");
    expect(loaded.paths["/users"]).toBeDefined();
  });

  it("throws when spec file does not exist", async () => {
    await expect(loadSpec({ specPath: "/nonexistent/openapi.json" } as any)).rejects.toThrow(
      /OpenAPI spec not found/,
    );
  });

  it("throws when spec is invalid JSON", async () => {
    const specPath = path.join(tmpDir, "bad.json");
    fs.writeFileSync(specPath, "not json");
    await expect(loadSpec({ specPath } as any)).rejects.toThrow(/not valid JSON/);
  });

  it("throws when spec has no paths", async () => {
    const specPath = path.join(tmpDir, "nopaths.json");
    fs.writeFileSync(specPath, JSON.stringify({ openapi: "3.2.0", info: { title: "t" } }));
    await expect(loadSpec({ specPath } as any)).rejects.toThrow(/paths/);
  });

  it("throws when spec path is a directory", async () => {
    await expect(loadSpec({ specPath: tmpDir } as any)).rejects.toThrow(/not a file/);
  });
});

describe("loadSpec remote", () => {
  let server: http.Server;
  let port: number;
  const validSpec = JSON.stringify({
    openapi: "3.2.0",
    info: { title: "remote", version: "1.0.0" },
    paths: { "/remote": { get: { operationId: "remoteOp" } } },
  });

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      if (req.url === "/spec.json") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(validSpec);
      } else if (req.url === "/bad.json") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("not json");
      } else if (req.url === "/nopaths.json") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ openapi: "3.2.0" }));
      } else if (req.url === "/redirect") {
        res.writeHead(302, { location: "/spec.json" });
        res.end();
      } else if (req.url === "/loop") {
        res.writeHead(302, { location: "/loop" });
        res.end();
      } else if (req.url === "/slow") {
        setTimeout(() => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(validSpec);
        }, 2000);
      } else {
        res.writeHead(404);
        res.end("not found");
      }
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    port = (server.address() as { port: number }).port;
  });

  afterAll(() => {
    server.close();
  });

  it("fetches and parses a valid remote spec", async () => {
    const loaded = await loadSpec({
      specPath: `http://127.0.0.1:${port}/spec.json`,
      timeout: 5000,
    } as any);
    expect(loaded.openapi).toBe("3.2.0");
    expect(loaded.paths["/remote"]).toBeDefined();
  });

  it("follows redirects", async () => {
    const loaded = await loadSpec({
      specPath: `http://127.0.0.1:${port}/redirect`,
      timeout: 5000,
    } as any);
    expect(loaded.openapi).toBe("3.2.0");
  });

  it("throws on too many redirects", async () => {
    await expect(
      loadSpec({ specPath: `http://127.0.0.1:${port}/loop`, timeout: 5000 } as any),
    ).rejects.toThrow(/Too many redirects/);
  });

  it("throws on HTTP 404", async () => {
    await expect(
      loadSpec({ specPath: `http://127.0.0.1:${port}/missing`, timeout: 5000 } as any),
    ).rejects.toThrow(/HTTP 404/);
  });

  it("throws on invalid JSON from remote", async () => {
    await expect(
      loadSpec({ specPath: `http://127.0.0.1:${port}/bad.json`, timeout: 5000 } as any),
    ).rejects.toThrow(/not valid JSON/);
  });

  it("throws when remote spec has no paths", async () => {
    await expect(
      loadSpec({ specPath: `http://127.0.0.1:${port}/nopaths.json`, timeout: 5000 } as any),
    ).rejects.toThrow(/paths/);
  });

  it("throws on fetch timeout", async () => {
    await expect(
      loadSpec({ specPath: `http://127.0.0.1:${port}/slow`, timeout: 500 } as any),
    ).rejects.toThrow(/Timed out|ECONNRESET|socket/);
  });
});
