// M1 step 3: let the machines reach Ollama while Ollama itself stays on loopback.
//
// It listens on the machines' gateway only (192.168.64.1, which exists while a machine runs), so
// nothing on the LAN or the tailnet can reach it, and pipes each connection to Ollama on
// 127.0.0.1. It logs one line per connection: which machine, and how many bytes each way.
// Run it on the host: node tools/m1/ollama-forward.mjs, or as a LaunchAgent (tools/host/).
import net from "node:net";

const listen = {
  host: process.env.LISTEN_HOST ?? "192.168.64.1",
  port: Number(process.env.LISTEN_PORT ?? 11434),
};
const ollama = { host: "127.0.0.1", port: Number(process.env.OLLAMA_PORT ?? 11434) };

const log = (line) => console.log(`${new Date().toISOString()} ${line}`);

const server = net.createServer((machine) => {
  const from = `${machine.remoteAddress}:${machine.remotePort}`;
  const upstream = net.connect(ollama);
  let sent = 0;
  let received = 0;
  machine.on("data", (chunk) => {
    sent += chunk.length;
  });
  upstream.on("data", (chunk) => {
    received += chunk.length;
  });
  machine.pipe(upstream).pipe(machine);
  const close = () => {
    machine.destroy();
    upstream.destroy();
  };
  machine.on("error", close);
  upstream.on("error", close);
  machine.on("close", () => {
    upstream.end();
    log(`${from} closed: ${sent} B to Ollama, ${received} B back`);
  });
  log(`${from} connected`);
});

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
  log(`forwarding ${listen.host}:${listen.port} to Ollama on ${ollama.host}:${ollama.port}`);
});
server.listen(listen);
