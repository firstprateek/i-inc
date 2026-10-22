// tools/m1/ollama-forward.mjs: the relay between the machines and Ollama is an allowlisting HTTP proxy
// (T66), so a machine with no internet can't use Ollama to reach one: no pulls from a registry host
// of its choosing, no cloud models, no model that isn't installed.
import http from "node:http";
import type { AddressInfo } from "node:net";
import net from "node:net";
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
  registryHost: (n: string) => boolean;
  oddModelKeys: (o: Record<string, unknown>) => string[];
  LIMITS: Record<string, number>;
  ALLOWED: Map<string, string[] | null>;
};
const { createRelay, modelProblem, registryHost, oddModelKeys, ALLOWED } = relayModule;

let ollama: http.Server;
let relay: http.Server;
let hits: { method: string; url: string; body: string }[];
let tagsCalls: number;
let clock: number;
let logs: string[];
let models: Record<string, unknown>[];
let upstreamPort: number;

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
    { name: "hf.co/someone/model:Q4_K_M", model: "hf.co/someone/model:Q4_K_M" },
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
  upstreamPort = upstream;
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
      "hf.co/someone/other-model",
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
    const big = JSON.stringify({ model: "qwen3:8b", prompt: "x".repeat(5 * 1024 * 1024) });
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

describe("the model check cannot be got round", () => {
  it("serves a model that is installed locally even though its name has a registry host", async () => {
    expect((await call("POST", "/api/chat", { model: "hf.co/someone/model:Q4_K_M" })).status).toBe(200);
  });

  it("refuses a key that reads as model or name without being spelt so, whatever the case or encoding", async () => {
    for (const raw of [
      '{"model":"qwen3:8b","MODEL":"gpt-oss:120b-cloud"}',
      '{"MODEL":"qwen3:8b"}',
      '{"Model":"qwen3:8b"}',
      '{"model":"qwen3:8b","mOdEl":"x"}',
      '{"model":"qwen3:8b","Name":"evil.example/x"}',
      '{"model":"qwen3:8b","NAME":"x:cloud"}',
      '{"model":"qwen3:8b","\\u004dodel":"gpt-oss:120b-cloud"}',
      '{"model":"qwen3:8b","mode\\u006c ":"x"}',
      '{"model":"qwen3:8b","ſame":"x"}',
      '{"model":"qwen3:8b","modeꞁ":"x"}',
    ]) {
      const r = await call("POST", "/api/chat", undefined, raw);
      expect([400, 403], raw).toContain(r.status);
    }
    expect(hits).toEqual([]);
    expect(oddModelKeys({ model: "a", MODEL: "b", Name: "c", name: "d", other: 1 })).toEqual([
      "MODEL",
      "Name",
    ]);
  });

  it("forwards the object it checked, re-written, not the bytes it received", async () => {
    // A doubled key: the last wins in JSON.parse and in Ollama, and what is sent has the key once.
    await call("POST", "/api/chat", undefined, '{"model":"gpt-oss:120b-cloud","model":"qwen3:8b","x":1}');
    expect(hits).toHaveLength(1);
    expect(hits[0]?.body).toBe('{"model":"qwen3:8b","x":1}');
    expect((hits[0]?.body.match(/"model"/g) ?? []).length).toBe(1);
    // The other way round is refused: the model that counts is the cloud one.
    const refused = await call(
      "POST",
      "/api/chat",
      undefined,
      '{"model":"qwen3:8b","model":"gpt-oss:120b-cloud"}',
    );
    expect(refused.status).toBe(403);
    // Whitespace, an escaped key that spells `model`, and key order don't matter: one key, checked.
    hits.length = 0;
    await call("POST", "/api/chat", undefined, ' { "mod\\u0065l" : "qwen3:8b" , "stream" : false } ');
    expect(hits[0]?.body).toBe('{"model":"qwen3:8b","stream":false}');
  });
});

describe("the relay's limits", () => {
  const rawSocket = (port: number) =>
    new Promise<net.Socket>((r, j) => {
      const sock = net.connect(port, "127.0.0.1", () => r(sock));
      sock.on("error", j);
    });
  const closed = (sock: net.Socket) =>
    new Promise<void>((r) => (sock.destroyed ? r() : sock.once("close", () => r())));
  const small = (limits: Record<string, number>) => {
    relay.closeAllConnections();
    return createRelay({ ollama: { host: "127.0.0.1", port: upstreamPort }, limits });
  };
  async function serve(server: http.Server) {
    relay = server;
    return listen(server);
  }

  it("refuses a body over the cap, by its declared length without reading it and by its size when it has no length", async () => {
    const port = await serve(small({ maxBody: 1000 }));
    const sock = await rawSocket(port);
    sock.write(
      "POST /api/chat HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 30000000\r\n\r\n",
    );
    const answer = await new Promise<string>((r) => sock.once("data", (d) => r(String(d))));
    expect(answer).toContain("413");
    sock.destroy();
    const chunked = await rawSocket(port);
    chunked.write("POST /api/chat HTTP/1.1\r\nHost: x\r\nTransfer-Encoding: chunked\r\n\r\n");
    chunked.write(`${(2000).toString(16)}\r\n${"x".repeat(2000)}\r\n`);
    const answer2 = await new Promise<string>((r) => chunked.once("data", (d) => r(String(d))));
    expect(answer2).toContain("413");
    chunked.destroy();
    expect(hits).toEqual([]);
  });

  it("drops a connection that promises a body and does not send it", async () => {
    const port = await serve(small({ receiveMs: 150 }));
    const sock = await rawSocket(port);
    sock.on("error", () => {});
    sock.write("POST /api/chat HTTP/1.1\r\nHost: x\r\nContent-Length: 3000000\r\n\r\n{");
    await closed(sock);
    const idle = await rawSocket(port); // and one that sends nothing at all
    idle.on("error", () => {});
    await closed(idle);
    expect(hits).toEqual([]);
  });

  it("allows a few connections from one address, and no more", async () => {
    const port = await serve(small({ perAddress: 2, receiveMs: 5000 }));
    const a = await rawSocket(port);
    const b = await rawSocket(port);
    const c = await rawSocket(port).catch(() => undefined);
    c?.on("error", () => {});
    if (c) await closed(c);
    expect(c === undefined || c.destroyed).toBe(true);
    a.destroy();
    b.destroy();
    await closed(a);
    await closed(b);
    // The count goes back down when they close.
    const d = await rawSocket(port);
    const answer = new Promise<string>((r) => d.once("data", (x) => r(String(x))));
    d.write("GET /api/tags HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n");
    expect(await answer).toContain("200");
    d.destroy();
  });

  it("caps the connections it holds in all", async () => {
    const server = small({ maxConnections: 2, perAddress: 10, receiveMs: 5000 });
    const port = await serve(server);
    expect(server.maxConnections).toBe(2);
    const a = await rawSocket(port);
    const b = await rawSocket(port);
    const c = await rawSocket(port).catch(() => undefined);
    c?.on("error", () => {});
    if (c) await closed(c);
    expect(c === undefined || c.destroyed).toBe(true);
    a.destroy();
    b.destroy();
  });

  it("lets a long generation stream for longer than the time to receive a request", async () => {
    ollama.removeAllListeners("request");
    ollama.on("request", (req, res) => {
      req.resume();
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      let n = 0;
      const tick = setInterval(() => {
        res.write(`{"n":${n++}}\n`);
        if (n === 3) {
          clearInterval(tick);
          res.end();
        }
      }, 300);
    });
    clock += 60_000; // tags are fetched afresh; the fake above answers any path, so give it a tags list
    const tagsServer = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ models }));
    });
    const tagsPort = await listen(tagsServer);
    const gen = http.createServer((req, res) => {
      if (req.url === "/api/tags") return tagsServer.emit("request", req, res);
      ollama.emit("request", req, res);
    });
    const genPort = await listen(gen);
    const port = await serve(
      createRelay({ ollama: { host: "127.0.0.1", port: genPort }, limits: { receiveMs: 200, idleMs: 3000 } }),
    );
    const r = await new Promise<string>((resolveCall, reject) => {
      const req = http.request({ host: "127.0.0.1", port, method: "POST", path: "/api/chat" }, (res) => {
        let text = "";
        res.on("data", (c) => {
          text += c;
        });
        res.on("end", () => resolveCall(text));
      });
      req.on("error", reject);
      req.end(JSON.stringify({ model: "qwen3:8b" }));
    });
    expect(r).toBe('{"n":0}\n{"n":1}\n{"n":2}\n');
    gen.closeAllConnections();
    tagsServer.closeAllConnections();
    await Promise.all([new Promise((x) => gen.close(x)), new Promise((x) => tagsServer.close(x))]);
    void tagsPort;
  });
});

describe("what makes a model name unusable", () => {
  it("is a cloud name, a registry host, or not a name", () => {
    expect(modelProblem("qwen3:8b")).toBeNull();
    expect(modelProblem("library/qwen3:8b")).toBeNull();
    expect(modelProblem("a.b/c")).toBeNull(); // served only if installed: the relay checks that
    expect(registryHost("a.b/c")).toBe(true);
    expect(registryHost("a:5000/c")).toBe(true);
    expect(registryHost("library/qwen3")).toBe(false);
    expect(registryHost("qwen3:8b")).toBe(false);
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
