// M1 step 3: let the machines reach Ollama while Ollama itself stays on loopback.
//
// It listens on the machines' gateway only (192.168.64.1, which exists while a machine runs), so
// nothing on the LAN or the tailnet can reach it, and forwards what a machine may ask to Ollama on
// 127.0.0.1. It is an HTTP proxy with an allowlist, not a pipe, because Ollama's API can do more
// than answer: `/api/pull` with a model called `evil.example/<data>/x` makes the host contact that
// registry, and `:cloud` models send the prompt to Ollama's servers. So a request is forwarded only if
//   - it is one of the calls below, with the method it needs, on exactly that path (no pull, push,
//     create, copy, delete or blobs, no other path, no encoded or dotted path);
//   - its JSON body names a model that is installed on this host (from /api/tags, kept for 30 s) and
//     is not a cloud model (`:cloud`, `-cloud`, or listed by Ollama as served remotely). A name that
//     isn't installed is refused, which includes any name with a registry host in it;
//   - its JSON object has exactly one `model` (and `name`) key, spelt that way: Ollama matches keys
//     without regard to case and the last one wins, so `{"model":"ok","MODEL":"x:cloud"}` would
//     otherwise get past the check. What is forwarded is the object as parsed and re-serialised, never
//     the bytes as received, so what was checked is what Ollama reads;
//   - it fits the limits: few connections, few from one machine, a body of 4 MB at most that arrives
//     within 15 s. A generation itself may run for minutes, with its answer streaming.
// It logs one line per request: which machine, the call, the model and the answer.
// Run it on the host: node tools/m1/ollama-forward.mjs, or as a LaunchAgent (tools/host/).
import http from "node:http";
import { pathToFileURL } from "node:url";

/** The calls a machine may make: "METHOD path" -> the body fields that name a model (none: no body is read). */
export const ALLOWED = new Map([
  ["POST /api/chat", ["model"]],
  ["POST /api/generate", ["model"]],
  ["POST /api/embed", ["model"]],
  ["POST /api/embeddings", ["model"]],
  ["POST /api/show", ["model", "name"]],
  ["GET /api/tags", null],
  ["GET /api/ps", null],
  ["POST /v1/chat/completions", ["model"]],
  ["POST /v1/completions", ["model"]],
  ["POST /v1/embeddings", ["model"]],
  ["GET /v1/models", null],
]);

/** The limits, each of which a test can lower through createRelay's `limits`. */
export const LIMITS = {
  maxBody: 4 * 1024 * 1024,
  maxConnections: 32,
  perAddress: 4,
  /** Time to send the headers and then the whole body; an idle connection is dropped after the same. */
  receiveMs: 15_000,
  /** Time a call may go without a byte either way once it was received (a model loading, a long answer). */
  idleMs: 10 * 60_000,
};
const TAGS_TTL_MS = 30_000;

/** `qwen3` is `qwen3:latest`. */
const withTag = (name) => (name.includes(":") ? name : `${name}:latest`);

/** Why a model name may not be used, or null when it may (installed or not: see `registryHost`). */
export function modelProblem(name) {
  if (typeof name !== "string" || name.length === 0 || name.length > 200) return "a model name is needed";
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$/.test(name)) return "that is not a model name";
  if (/(^|[:\-_/])cloud$/i.test(name) || /:cloud\b/i.test(name)) return "cloud models are not served";
  return null;
}

/** Whether a name carries a registry host (`evil.example/x`): such a name is only served if it is already installed. */
export function registryHost(name) {
  const slash = name.indexOf("/");
  return slash > 0 && /[.:]/.test(name.slice(0, slash));
}

/** Keys of the JSON object that Ollama would read as `model` or `name` but that are not spelt that way, or are doubled. */
export function oddModelKeys(object) {
  return Object.keys(object).filter((k) => {
    const lower = k.toLowerCase();
    return (lower === "model" || lower === "name") && k !== lower;
  });
}

/**
 * The relay's server. `ollama` is where Ollama listens; `now` is for the tags cache (a test can pass its
 * own); `log` gets one line per request.
 */
export function createRelay({
  ollama = { host: "127.0.0.1", port: Number(process.env.OLLAMA_PORT ?? 11434) },
  now = Date.now,
  log = () => {},
  limits = {},
} = {}) {
  const lim = { ...LIMITS, ...limits };
  /** Open connections by remote address. */
  const open = new Map();
  let tags = { at: -Infinity, names: new Set() };

  /** The names Ollama has installed here, cached. Cloud entries are not counted. */
  async function installed() {
    if (now() - tags.at < TAGS_TTL_MS) return tags.names;
    const body = await upstreamJson(ollama, "/api/tags");
    const names = new Set();
    for (const m of body?.models ?? []) {
      if (m.remote_host || m.remote_model) continue;
      for (const n of [m.name, m.model]) if (typeof n === "string") names.add(withTag(n));
    }
    tags = { at: now(), names };
    return names;
  }

  const server = http.createServer(async (req, res) => {
    const from = req.socket.remoteAddress ?? "?";
    const refuse = (status, why, model) => {
      log(
        `${from} ${req.method} ${req.url?.slice(0, 80)} refused (${status}): ${why}${model ? ` [${model}]` : ""}`,
      );
      res.writeHead(status, { "content-type": "application/json", connection: "close" });
      res.end(JSON.stringify({ error: `i.inc's relay: ${why}` }));
    };
    try {
      // The path exactly as sent: nothing is decoded or normalised, so nothing can be dressed up as an allowed one.
      const raw = req.url ?? "";
      const q = raw.indexOf("?");
      const path = q < 0 ? raw : raw.slice(0, q);
      const key = `${req.method} ${path}`;
      if (!ALLOWED.has(key)) return refuse(403, "that call is not allowed");
      const fields = ALLOWED.get(key);

      let body = Buffer.alloc(0);
      let model;
      if (fields) {
        const declared = Number(req.headers["content-length"]);
        if (Number.isFinite(declared) && declared > lim.maxBody)
          return refuse(413, "the request is too large");
        const chunks = [];
        let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          if (size > lim.maxBody) return refuse(413, "the request is too large");
          chunks.push(chunk);
        }
        let json;
        try {
          json = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          return refuse(400, "the body is not JSON");
        }
        if (json === null || typeof json !== "object" || Array.isArray(json)) {
          return refuse(400, "the body is not a JSON object");
        }
        // Any key that is not plain ASCII, or that reads as model/name without being spelt so, is refused.
        if (Object.keys(json).some((k) => !/^[A-Za-z0-9_.-]{1,64}$/.test(k))) {
          return refuse(400, "the body has a key that is not a plain name");
        }
        const odd = oddModelKeys(json);
        if (odd.length) return refuse(400, "a model is named by `model` (or `name`), spelt that way", odd[0]);
        const named = fields.map((f) => json[f]).filter((v) => v !== undefined);
        if (named.length === 0) return refuse(400, "a model is needed");
        const names = await installed();
        for (const n of named) {
          const problem = modelProblem(n);
          if (problem) return refuse(403, problem, String(n).slice(0, 60));
          if (!names.has(withTag(n))) {
            return refuse(
              403,
              registryHost(n)
                ? "models from a registry host are not served unless installed"
                : "that model is not installed on this host",
              n,
            );
          }
        }
        model = named[0];
        // What was checked is what is sent: the parsed object, written out again (a doubled key keeps the
        // value that was checked, the last one, which is the one Ollama reads too).
        body = Buffer.from(JSON.stringify(json));
      } else {
        req.resume();
      }
      // The call is in: from here it may take as long as the model needs, as long as bytes keep moving.
      req.socket.setTimeout(lim.idleMs);

      const upstream = http.request(
        {
          host: ollama.host,
          port: ollama.port,
          method: req.method,
          path,
          headers: {
            ...(fields ? { "content-type": "application/json", "content-length": body.length } : {}),
            accept: req.headers.accept ?? "*/*",
            connection: "close",
          },
        },
        (answer) => {
          const headers = {};
          for (const h of ["content-type", "content-length", "transfer-encoding"]) {
            if (answer.headers[h] !== undefined) headers[h] = answer.headers[h];
          }
          res.writeHead(answer.statusCode ?? 502, headers);
          answer.pipe(res);
          log(`${from} ${key}${model ? ` [${model}]` : ""} -> ${answer.statusCode}`);
        },
      );
      upstream.on("error", (err) => {
        if (!res.headersSent) refuse(502, `Ollama didn't answer (${err.code ?? err.message})`);
        else res.destroy();
      });
      res.on("close", () => upstream.destroy());
      // Once the answer is out, a connection kept alive is idle again.
      res.on("finish", () => req.socket.setTimeout(lim.receiveMs));
      upstream.end(body);
    } catch (err) {
      if (!res.headersSent) refuse(502, `the relay failed (${err.message})`);
      else res.destroy();
    }
  });
  // Hold-ups: the headers and the body must arrive within receiveMs; a quiet connection is dropped after
  // that too, and a call that is in progress is dropped after idleMs without a byte (set per call above).
  server.headersTimeout = lim.receiveMs;
  server.requestTimeout = lim.receiveMs;
  server.keepAliveTimeout = lim.receiveMs;
  server.maxConnections = lim.maxConnections;
  server.on("connection", (socket) => {
    const from = socket.remoteAddress ?? "?";
    const n = (open.get(from) ?? 0) + 1;
    if (n > lim.perAddress) {
      log(`${from} refused: more than ${lim.perAddress} connections open`);
      socket.destroy();
      return;
    }
    open.set(from, n);
    socket.setTimeout(lim.receiveMs);
    socket.on("timeout", () => socket.destroy());
    socket.on("close", () => {
      const left = (open.get(from) ?? 1) - 1;
      if (left <= 0) open.delete(from);
      else open.set(from, left);
    });
  });
  return server;
}

/** GET a JSON answer from Ollama. */
function upstreamJson(ollama, path) {
  return new Promise((resolve, reject) => {
    const r = http.get(
      { host: ollama.host, port: ollama.port, path, headers: { connection: "close" } },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          } catch (err) {
            reject(err);
          }
        });
      },
    );
    r.on("error", reject);
  });
}

// Run as a script (not when a test imports it).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const listen = {
    host: process.env.LISTEN_HOST ?? "192.168.64.1",
    port: Number(process.env.LISTEN_PORT ?? 11434),
  };
  const log = (line) => console.log(`${new Date().toISOString()} ${line}`);
  const server = createRelay({ log });
  // The gateway address exists only while a machine runs, so at boot the relay waits for it. It
  // runs as a LaunchAgent (tools/host/install-relay.sh), which starts it again if it exits.
  let waiting = false;
  server.on("error", (error) => {
    if (error.code !== "EADDRNOTAVAIL") {
      log(`can't listen on ${listen.host}:${listen.port}: ${error.message}`);
      process.exit(1);
    }
    if (!waiting) log(`${listen.host} isn't up yet; waiting for a machine to start`);
    waiting = true;
    setTimeout(() => server.listen(listen), 5000);
  });
  server.on("listening", () => {
    waiting = false;
    log(`forwarding ${listen.host}:${listen.port} to Ollama (allowlisted calls, installed models only)`);
  });
  server.listen(listen);
}
