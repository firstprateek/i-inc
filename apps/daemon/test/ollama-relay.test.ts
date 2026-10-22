// tools/m1/ollama-forward.mjs: the relay between the machines and Ollama is an allowlisting HTTP proxy
// (T66), so a machine with no internet can't use Ollama to reach one: no pulls from a registry host
// of its choosing, no cloud models, no model that isn't installed.
import http from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const relayPath = resolve(import.meta.dirname, "../../../tools/m1/ollama-forward.mjs");
const relayModule = (await import(relayPath)) as {
  createRelay: (o: {
    ollama: { host: string; port: number };
    now?: () => number;
    log?: (l: string) => void;
  }) => http.Server;
  modelProblem: (n: unknown) => string | null;
  ALLOWED: Map<string, string[] | null>;
};
const { createRelay, modelProblem, ALLOWED } = relayModule;

let ollama: http.Server;
let relay: http.Server;
let hits: { method: string; url: string; body: string }[];
let tagsCalls: number;
let clock: number;
let logs: string[];
let models: Record<string, unknown>[];

const listen = (s: http.Server) =>
  new Promise<number>((r) => s.listen(0, "127.0.0.1", () => r((s.address() as AddressInfo).port)));

beforeEach(async () => {
  hits = [];
  tagsCalls = 0;
  clock = 1_000_000;
  logs = [];
  models = [
    { name: "qwen3:8b", model: "qwen3:8b" },
    { name: "nomic-embed-text:latest", model: "nomic-embed-text:latest" },
    { name: "gpt-oss:120b-cloud", model: "gpt-oss:120b-cloud", remote_host: "https://ollama.com:443" },
  ];
  ollama = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString();
      if (req.url === "/api/tags") {
        tagsCalls++;
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ models }));
      }
      hits.push({ method: req.method ?? "", url: req.url ?? "", body });
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      res.write('{"response":"he"}\n');
      setTimeout(() => res.end('{"response":"llo","done":true}\n'), 5);
    });
  });
  const upstream = await listen(ollama);
  relay = createRelay({
    ollama: { host: "127.0.0.1", port: upstream },
    now: () => clock,
    log: (l) => logs.push(l),
  });
});
afterEach(async () => {
  relay.closeAllConnections();
  ollama.closeAllConnections();
  await Promise.all([new Promise((r) => relay.close(r)), new Promise((r) => ollama.close(r))]);
});

async function call(method: string, path: string, body?: unknown, raw?: string) {
  const port = await listen(relay).catch(() => (relay.address() as AddressInfo).port);
  return new Promise<{ status: number; text: string }>((resolveCall, reject) => {
    const payload = raw ?? (body === undefined ? undefined : JSON.stringify(body));
    const req = http.request(
      { host: "127.0.0.1", port, method, path, headers: { connection: "close" } },
      (res) => {
        let text = "";
        res.on("data", (c) => {
          text += c;
        });
        res.on("end", () => resolveCall({ status: res.statusCode ?? 0, text }));
      },
    );
    req.on("error", reject);
    req.end(payload);
  });
}

describe("the Ollama relay", () => {
  it("forwards the calls an agent needs, streaming the answer, for an installed model", async () => {
    const r = await call("POST", "/api/chat", {
      model: "qwen3:8b",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(r.status).toBe(200);
    expect(r.text).toBe('{"response":"he"}\n{"response":"llo","done":true}\n');
    expect(hits).toHaveLength(1);
    expect(hits[0]?.method).toBe("POST");
    expect(JSON.parse(hits[0]?.body ?? "{}").model).toBe("qwen3:8b");
    for (const [path, body] of [
      ["/api/generate", { model: "qwen3:8b", prompt: "x" }],
      ["/api/embed", { model: "nomic-embed-text", input: "x" }],
      ["/api/embeddings", { model: "nomic-embed-text:latest", prompt: "x" }],
      ["/api/show", { model: "qwen3:8b" }],
      ["/api/show", { name: "qwen3:8b" }],
      ["/v1/chat/completions", { model: "qwen3:8b", messages: [] }],
      ["/v1/completions", { model: "qwen3:8b", prompt: "x" }],
      ["/v1/embeddings", { model: "nomic-embed-text", input: "x" }],
    ] as const) {
      expect((await call("POST", path, body)).status, path).toBe(200);
    }
    expect((await call("GET", "/api/tags")).status).toBe(200);
    expect((await call("GET", "/api/ps")).status).toBe(200);
    expect((await call("GET", "/v1/models")).status).toBe(200);
  });

  it("forwards only the allowlisted paths: a pull, push, create, copy, delete or blob never reaches Ollama", async () => {
    const before = hits.length;
    for (const [method, path] of [
      ["POST", "/api/pull"],
      ["POST", "/api/push"],
      ["POST", "/api/create"],
      ["POST", "/api/copy"],
      ["DELETE", "/api/delete"],
      ["POST", "/api/delete"],
      ["POST", "/api/blobs/sha256:abc"],
      ["HEAD", "/api/blobs/sha256:abc"],
      ["GET", "/"],
      ["GET", "/api/version"],
      ["GET", "/api/chat"],
      ["POST", "/api/tags"],
      ["POST", "/v1/models"],
      ["POST", "/api/chat/"],
      ["POST", "/api/chat/../pull"],
      ["POST", "/api//pull"],
      ["POST", "/api/%70ull"],
      ["POST", "/api/chat%2f..%2fpull"],
      ["POST", "/API/chat"],
      ["POST", "/api/chat;/../pull"],
      ["POST", "http://evil.example/api/pull"],
    ] as const) {
      const r = await call(method, path, { model: "qwen3:8b", name: "evil.example/x" });
      expect(r.status, `${method} ${path}`).toBe(403);
    }
    expect(hits).toHaveLength(before);
  });

  it("ignores a query string, and sends Ollama the path alone", async () => {
    const r = await call("POST", "/api/chat?stream=false&x=/api/pull", { model: "qwen3:8b" });
    expect(r.status).toBe(200);
    expect(hits[0]?.url).toBe("/api/chat");
  });

  it("refuses a model that isn't installed, including one whose name would make the host pull from a registry", async () => {
    for (const model of [
      "evil.example/c2VjcmV0/x",
      "evil.example:5000/data/x:latest",
      "registry.ollama.ai/library/qwen3:8b",
      "hf.co/someone/model",
      "llama3",
      "qwen3", // only qwen3:8b is installed: qwen3 is qwen3:latest
      "qwen3:70b",
    ]) {
      const r = await call("POST", "/api/chat", { model });
      expect(r.status, model).toBe(403);
    }
    expect(hits).toEqual([]);
  });

  it("refuses cloud models, even when Ollama lists them", async () => {
    for (const model of [
      "gpt-oss:120b-cloud",
      "qwen3-coder:480b-cloud",
      "x:cloud",
      "x:cloud-big",
      "model:CLOUD",
    ]) {
      const r = await call("POST", "/api/generate", { model, prompt: "secret" });
      expect(r.status, model).toBe(403);
    }
    expect(hits).toEqual([]);
  });

  it("refuses a missing, odd or doubled model name, and a body that isn't a JSON object", async () => {
    expect((await call("POST", "/api/chat", {})).status).toBe(400);
    expect((await call("POST", "/api/chat", { model: 7 })).status).toBe(403);
    expect((await call("POST", "/api/chat", { model: ["qwen3:8b"] })).status).toBe(403);
    expect((await call("POST", "/api/chat", { model: "" })).status).toBe(403);
    expect((await call("POST", "/api/chat", { model: "qwen3:8b\nx" })).status).toBe(403);
    expect((await call("POST", "/api/chat", undefined, "not json")).status).toBe(400);
    expect((await call("POST", "/api/chat", undefined, "[1]")).status).toBe(400);
    expect((await call("POST", "/api/chat", undefined, "null")).status).toBe(400);
    // /api/show names the model as `model` or `name`; both are checked when both are sent.
    expect((await call("POST", "/api/show", { model: "qwen3:8b", name: "evil.example/x" })).status).toBe(403);
    expect(hits).toEqual([]);
  });

  it("asks Ollama what is installed once per half minute, and notices a model that is added", async () => {
    await call("POST", "/api/chat", { model: "qwen3:8b" });
    await call("POST", "/api/chat", { model: "qwen3:8b" });
    expect(tagsCalls).toBe(1);
    expect((await call("POST", "/api/chat", { model: "newmodel:1b" })).status).toBe(403);
    models.push({ name: "newmodel:1b", model: "newmodel:1b" });
    clock += 29_000;
    expect((await call("POST", "/api/chat", { model: "newmodel:1b" })).status).toBe(403);
    clock += 2_000;
    expect((await call("POST", "/api/chat", { model: "newmodel:1b" })).status).toBe(200);
    expect(tagsCalls).toBe(2);
  });

  it("refuses an oversized request without forwarding it", async () => {
    const big = JSON.stringify({ model: "qwen3:8b", prompt: "x".repeat(33 * 1024 * 1024) });
    const r = await call("POST", "/api/generate", undefined, big).catch(() => ({ status: 413, text: "" }));
    expect([413, 0]).toContain(r.status);
    expect(hits).toEqual([]);
  });

  it("answers 502 when Ollama is down, and logs each request", async () => {
    await new Promise((r) => ollama.close(r));
    const r = await call("POST", "/api/chat", { model: "qwen3:8b" });
    expect(r.status).toBe(502);
    expect(logs.some((l) => l.includes("refused (502)"))).toBe(true);
  });

  it("logs the machine, the call and the model", async () => {
    await call("POST", "/api/chat", { model: "qwen3:8b" });
    await call("POST", "/api/pull", { name: "x" });
    expect(logs.some((l) => l.includes("POST /api/chat [qwen3:8b] -> 200"))).toBe(true);
    expect(logs.some((l) => l.includes("/api/pull") && l.includes("refused (403)"))).toBe(true);
  });
});

describe("what makes a model name unusable", () => {
  it("is a cloud name, a registry host, or not a name", () => {
    expect(modelProblem("qwen3:8b")).toBeNull();
    expect(modelProblem("library/qwen3:8b")).toBeNull();
    expect(modelProblem("a.b/c")).toMatch(/registry/);
    expect(modelProblem("a:5000/c")).toMatch(/registry/);
    expect(modelProblem("m:cloud")).toMatch(/cloud/);
    expect(modelProblem("m-cloud")).toMatch(/cloud/);
    expect(modelProblem(undefined)).toMatch(/needed/);
    expect(modelProblem("a b")).toMatch(/not a model/);
    expect(modelProblem("-x")).toMatch(/not a model/);
  });

  it("allowlists exactly the calls the design names", () => {
    expect([...ALLOWED.keys()].sort()).toEqual(
      [
        "GET /api/ps",
        "GET /api/tags",
        "GET /v1/models",
        "POST /api/chat",
        "POST /api/embed",
        "POST /api/embeddings",
        "POST /api/generate",
        "POST /api/show",
        "POST /v1/chat/completions",
        "POST /v1/completions",
        "POST /v1/embeddings",
      ].sort(),
    );
  });
});
