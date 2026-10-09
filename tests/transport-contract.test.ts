import { test, expect } from "vitest";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { createClient } from "@powerduck/openapi-request";
import { executeStep } from "../src/runner";
import { runScenario } from "../src/scenario";
import { resolveConfig } from "../src/config";
const require = createRequire(import.meta.url);
const listen = (server: any): Promise<number> =>
  new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve(server.address().port)),
  );
const close = (server: any) =>
  new Promise<void>((resolve) => {
    server.close(resolve);
    server.closeAllConnections?.();
  });
const spec = (operation: any) => ({
  openapi: "3.2.0",
  info: { title: "Contracts", version: "1" },
  paths: {
    "/run": {
      post: { responses: { 200: { description: "OK" } }, ...operation },
    },
  },
});
const op = (operation: any, protocol: string) => ({
  operation,
  pathItem: {},
  path: "/run",
  method: "post",
  protocol,
  operationId: "run",
});

test("rejects invalid concurrency instead of silently executing zero tests", () => {
  for (const concurrency of [0, -1, NaN, 1.5])
    expect(() => resolveConfig({ spec: "x.json", concurrency })).toThrow(
      /concurrency/,
    );
});

test("cancelling a scenario aborts its active HTTP request", async () => {
  let started!: () => void;
  const connected = new Promise<void>((resolve) => {
    started = resolve;
  });
  const server = http.createServer((_req, _res) => started());
  const port = await listen(server);
  try {
    const controller = new AbortController();
    const running = runScenario(
      { name: "cancel", steps: [{ ref: "POST /run" }] },
      {
        spec: spec({}),
        config: {
          specPath: "memory",
          serverUrl: `http://127.0.0.1:${port}`,
          timeout: 30000,
        },
        signal: controller.signal,
      },
    );
    await connected;
    controller.abort();
    const report = await running;
    expect(report.status).toBe("cancelled");
  } finally {
    await close(server);
  }
});

test("WebSocket uses x-websocket path, step body, variables and authentication", async () => {
  const { WebSocketServer } = require("ws");
  const server = http.createServer();
  const websocket = new WebSocketServer({ server });
  let auth, requestUrl, message;
  websocket.on("connection", (socket: any, request: any) => {
    auth = request.headers.authorization;
    requestUrl = request.url;
    socket.on("message", (data: any) => {
      message = data.toString();
      socket.send(data.toString());
    });
  });
  const port = await listen(server);
  try {
    const operation = { "x-websocket": { url: "ws://unused.example/socket" } };
    const result = await executeStep(
      createClient(),
      op(operation, "websocket"),
      {
        spec: spec(operation),
        config: {
          specPath: "memory",
          serverUrl: `http://127.0.0.1:${port}`,
          auth: { type: "bearer", token: "{{token}}" },
          timeout: 1000,
        },
        variables: { token: "secret" },
        values: { body: "hello" },
      },
    );
    expect(result.result.status).toBe("passed");
    expect(auth).toBe("Bearer secret");
    expect(requestUrl).toBe("/socket");
    expect(message).toBe("hello");
  } finally {
    for (const socket of websocket.clients) socket.terminate();
    websocket.close();
    await close(server);
  }
});

test("gRPC consumes step body and metadata and records real status and message events", async () => {
  const grpc = require("@grpc/grpc-js"),
    loader = require("@grpc/proto-loader");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cli-grpc-"));
  const proto = path.join(directory, "test.proto");
  fs.writeFileSync(
    proto,
    'syntax="proto3";package test; service Echo {rpc Unary(Message) returns(Message);rpc Upload(stream Message) returns(Message);} message Message {string text=1;}',
  );
  const definition = grpc.loadPackageDefinition(loader.loadSync(proto));
  const server = new grpc.Server();
  let auth;
  server.addService(definition.test.Echo.service, {
    Unary: (call: any, done: any) => {
      auth = call.metadata.get("authorization")[0];
      done(null, call.request);
    },
    Upload: (call: any, done: any) => {
      let text = "";
      call.on("data", (m: any) => (text += m.text));
      call.on("end", () => done(null, { text }));
    },
  });
  const port = await new Promise<number>((resolve, reject) =>
    server.bindAsync(
      "127.0.0.1:0",
      grpc.ServerCredentials.createInsecure(),
      (e: any, p: number) => (e ? reject(e) : resolve(p)),
    ),
  );
  try {
    for (const method of ["Unary", "Upload"]) {
      const operation = {
        "x-grpc": {
          address: `127.0.0.1:${port}`,
          service: "test.Echo",
          method,
          protoPaths: [proto],
        },
      };
      const result = await executeStep(createClient(), op(operation, "grpc"), {
        spec: spec(operation),
        config: {
          specPath: "memory",
          auth: { type: "bearer", token: "secret" },
          timeout: 1000,
        },
        values: { body: { text: "actual" } },
      });
      expect(result.result.status).toBe("passed");
      expect(result.response?.status).toBe(0);
      expect(result.response?.body).toEqual({ text: "actual" });
    }
    expect(auth).toBe("Bearer secret");
  } finally {
    server.forceShutdown();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("HTTP applies custom CA and encoded proxy credentials to CONNECT agents", async () => {
  const { execFileSync } = await import("node:child_process");
  const https = await import("node:https");
  const net = await import("node:net");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cli-tls-"));
  const key = path.join(directory, "key.pem"),
    cert = path.join(directory, "cert.pem");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      key,
      "-out",
      cert,
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
    ],
    { stdio: "ignore" },
  );
  const target = https.createServer(
    { key: fs.readFileSync(key), cert: fs.readFileSync(cert) },
    (_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end('{"ok":true}');
    },
  );
  const port = await listen(target);
  let proxyAuth: string | undefined;
  const sockets = new Set<any>();
  const proxy = http.createServer();
  proxy.on("connect", (req, socket, head) => {
    proxyAuth = req.headers["proxy-authorization"];
    const upstream = net.connect(port, "127.0.0.1", () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      socket.pipe(upstream);
      upstream.pipe(socket);
    });
    for (const s of [socket, upstream]) {
      sockets.add(s);
      s.on("error", () => s.destroy());
      s.on("close", () => sockets.delete(s));
    }
  });
  const proxyPort = await listen(proxy);
  try {
    const operation = { responses: { 200: { description: "OK" } } };
    const result = await executeStep(createClient(), op(operation, "http"), {
      spec: spec(operation),
      config: {
        specPath: "memory",
        serverUrl: `https://localhost:${port}`,
        timeout: 2000,
        proxy: `http://user:p%40ss@127.0.0.1:${proxyPort}`,
        tls: { caCert: cert },
      },
    });
    expect(result.result.status, JSON.stringify(result.result)).toBe("passed");
    expect(result.response?.body).toEqual({ ok: true });
    expect(proxyAuth).toBe(
      `Basic ${Buffer.from("user:p@ss").toString("base64")}`,
    );
  } finally {
    for (const socket of sockets) socket.destroy();
    await close(proxy);
    await close(target);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("MCP keeps operation stdio settings and sends method-specific params", async () => {
  let connected: any,
    sent: any,
    closed = 0;
  const client = {
    connect: (options: any) => {
      connected = options;
      return {
        open: async () => {},
        request: async (...args: any[]) => {
          sent = args;
          return { tools: [] };
        },
        close: async () => {
          closed++;
        },
      };
    },
  };
  const operation = {
    "x-mcp": {
      transport: "stdio",
      command: "node",
      args: ["server.js"],
      method: "tools/list",
    },
  };
  const result = await executeStep(client as any, op(operation, "mcp"), {
    spec: spec(operation),
    config: resolveConfig({ spec: "memory" }),
    values: { body: { method: "resources/read", params: { uri: "{{uri}}" } } },
    variables: { uri: "test://one" },
  });
  expect(result.result.status).toBe("passed");
  expect(connected.transport).toBe("stdio");
  expect(connected.command).toBe("node");
  expect(sent[0]).toBe("resources/read");
  expect(sent[1]).toEqual({ uri: "test://one" });
  expect(closed).toBe(1);
});

test("GraphQL rejects unsupported custom transports instead of silently bypassing them", async () => {
  const result = await executeStep(createClient(), op({}, "graphql"), {
    spec: spec({}),
    config: { specPath: "memory", proxy: "http://127.0.0.1:1" },
  });
  expect(result.result.status).toBe("error");
  expect(result.result.error).toMatch(/custom proxy\/TLS/);
});
