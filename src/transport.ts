import fs from "node:fs";
import { createPrivateKey } from "node:crypto";
import http from "node:http";
import https from "node:https";
import proxyAgent from "https-proxy-agent";
const { HttpsProxyAgent } = proxyAgent;
import type { CliConfig } from "./types.js";

export function tlsOptions(config: CliConfig): any {
  const tls = config.tls;
  return {
    ...(tls?.caCert ? { ca: fs.readFileSync(tls.caCert) } : {}),
    ...(tls?.clientCert ? { cert: fs.readFileSync(tls.clientCert) } : {}),
    ...(tls?.clientKey ? { key: fs.readFileSync(tls.clientKey) } : {}),
    ...(tls?.pfx ? { pfx: fs.readFileSync(tls.pfx) } : {}),
    ...(tls?.passphrase ? { passphrase: tls.passphrase } : {}),
    rejectUnauthorized: tls?.strictSSL !== false,
  };
}

export function transportAgents(config: CliConfig): any {
  const tls = tlsOptions(config);
  if (config.proxy) {
    const url = new URL(config.proxy);
    if (!["http:", "https:"].includes(url.protocol))
      throw new Error("Only HTTP(S) CONNECT proxies are supported.");
    class Agent extends HttpsProxyAgent {
      callback(req: any, options: any) {
        return super.callback(req, { ...options, ...tls });
      }
    }
    const agent = new Agent({
      protocol: url.protocol,
      host: url.hostname,
      port: Number(url.port || (url.protocol === "https:" ? 443 : 80)),
      ...(url.username || url.password
        ? {
            auth: `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`,
          }
        : {}),
      ca: tls.ca,
      rejectUnauthorized: tls.rejectUnauthorized,
    });
    return { http: agent, https: agent };
  }
  return { http: new http.Agent(), https: new https.Agent(tls) };
}

export function rejectUnsupportedTransport(
  config: CliConfig,
  protocol: string,
) {
  if (
    config.proxy ||
    Object.entries(config.tls || {}).some(([k, v]) =>
      k === "strictSSL" ? v === false : Boolean(v),
    )
  ) {
    throw new Error(
      `${protocol} custom proxy/TLS is not supported by the bundled request engine.`,
    );
  }
}

export function resolveValue(
  value: any,
  variables: Record<string, string> = {},
): any {
  if (typeof value === "string")
    return value.replace(/\{\{([^{}]+)\}\}/g, (_, key) => {
      if (!Object.prototype.hasOwnProperty.call(variables, key))
        throw new Error(`Variable ${key} is not defined.`);
      return variables[key];
    });
  if (Array.isArray(value)) return value.map((v) => resolveValue(v, variables));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, resolveValue(v, variables)]),
    );
  return value;
}

export function sessionAuth(
  config: CliConfig,
  headers: Record<string, string>,
  url?: string,
) {
  const auth = config.auth;
  const put = (key: string, value: string) => {
    for (const k of Object.keys(headers))
      if (k.toLowerCase() === key.toLowerCase()) delete headers[k];
    headers[key] = value;
  };
  if (!auth || auth.type === "none") return url;
  if (auth.type === "basic")
    put(
      "Authorization",
      `Basic ${Buffer.from(`${auth.username || ""}:${auth.password || ""}`).toString("base64")}`,
    );
  else if (auth.type === "bearer")
    put("Authorization", `Bearer ${auth.token || ""}`);
  else if (auth.type === "apikey") {
    if (!auth.key) throw new Error("API key name is required.");
    if (auth.in === "query") {
      if (!url) throw new Error("gRPC API keys require metadata headers.");
      const target = new URL(url);
      target.searchParams.set(auth.key, auth.value || "");
      url = target.href;
    } else put(auth.key, auth.value || "");
  } else
    throw new Error(
      `Authentication ${auth.type} is supported only by the HTTP/SSE runner.`,
    );
  return url;
}

export function grpcTransport(config: CliConfig, address: string): any {
  const options: any = { "grpc.enable_http_proxy": 0 };
  if (!config.proxy) return { address, channelOptions: options };
  const proxy = new URL(config.proxy);
  if (proxy.protocol !== "http:")
    throw new Error("gRPC supports only HTTP CONNECT proxies.");
  const host = new URL(`https://${address}`);
  options["grpc.http_connect_target"] = `dns:///${address}`;
  options["grpc.default_authority"] = host.host;
  options["grpc.ssl_target_name_override"] = host.hostname;
  if (proxy.username || proxy.password)
    options["grpc.http_connect_creds"] =
      `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`;
  return {
    address: `${proxy.hostname}:${proxy.port || 80}`,
    channelOptions: options,
  };
}

export function grpcPrivateKey(material: any): Buffer | undefined {
  if (!material.key || !material.passphrase) return material.key;
  return Buffer.from(
    createPrivateKey({
      key: material.key,
      passphrase: material.passphrase,
    }).export({ format: "pem", type: "pkcs8" }),
  );
}

export function queryUrl(url: string, query?: Record<string, unknown>): string {
  const target = new URL(url);
  for (const [key, value] of Object.entries(query || {})) {
    if (value === undefined || value === null) continue;
    target.searchParams.delete(key);
    for (const item of Array.isArray(value) ? value : [value])
      target.searchParams.append(key, String(item));
  }
  return target.href;
}
