// The launcher: find the daemon, then hand the window to it. An address given at launch (I_INC_URL in the
// environment) is the only one tried when there is one. Otherwise it tries, in order and until one answers, the
// one kept in localStorage, the daemon on this machine (the Mac mini, which cannot reach its own Tailscale
// Service address), and the address this build was made for (I_INC_URL at build time); if none answers, it asks.
// Before leaving it tells the app which daemon it chose: the window shows only that daemon's pages.
const KEY = "i-inc-daemon";
const LOCAL = "http://127.0.0.1:7420";

const form = document.getElementById("connect");
const input = document.getElementById("addr");
const statusLine = document.getElementById("status");
const waiting = document.getElementById("waiting");

function saved() {
  try {
    return localStorage.getItem(KEY) || undefined;
  } catch {
    return undefined;
  }
}

function save(origin) {
  try {
    localStorage.setItem(KEY, origin);
  } catch {
    // Not remembering the address only means asking again next time.
  }
}

async function command(name) {
  try {
    return (await window.__TAURI__?.core.invoke(name)) ?? undefined;
  } catch {
    return undefined;
  }
}

function origin(raw) {
  const text = raw.trim();
  return new URL(text.includes("://") ? text : `https://${text}`).origin;
}

/** True when something answers at the address. The answer itself is opaque; reaching it is enough. */
async function reachable(base, ms = 4000) {
  const stop = new AbortController();
  const timer = setTimeout(() => stop.abort(), ms);
  try {
    await fetch(`${base}/api/auth`, { mode: "no-cors", cache: "no-store", signal: stop.signal });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function ask(message) {
  waiting.hidden = true;
  form.hidden = false;
  statusLine.textContent = message ?? "";
  input.focus();
  input.select();
}

/** `keep` remembers the address for next time; an address given at launch is not kept. */
async function connect(raw, keep = true) {
  let base;
  try {
    base = origin(raw);
  } catch {
    ask("That is not an address.");
    return false;
  }
  statusLine.textContent = "Connecting…";
  if (!(await reachable(base))) {
    ask(`Can't reach ${base}. Is the daemon running, and is this Mac on the tailnet?`);
    return false;
  }
  await go(base, keep);
  return true;
}

async function go(base, keep) {
  if (keep) save(base);
  try {
    await window.__TAURI__?.core.invoke("use_daemon", { origin: base });
  } catch {
    // An app build without the command shows any address; nothing to tell it.
  }
  location.replace(`${base}/`);
}

async function start() {
  const given = await command("daemon_override");
  const fallback = await command("default_daemon");
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    void connect(input.value);
  });
  const remembered = saved();
  input.value = remembered ?? fallback ?? LOCAL;
  if (new URLSearchParams(location.search).has("change")) {
    ask();
    return;
  }
  if (given) {
    input.value = given;
    await connect(given, false);
    return;
  }
  const tried = [];
  for (const [raw, ms] of [
    [remembered, 4000],
    [LOCAL, 1500],
    [fallback, 4000],
  ]) {
    if (!raw) continue;
    let base;
    try {
      base = origin(raw);
    } catch {
      continue;
    }
    if (tried.includes(base)) continue;
    tried.push(base);
    input.value = base;
    if (await reachable(base, ms)) {
      await go(base, true);
      return;
    }
  }
  input.value = remembered ?? fallback ?? LOCAL;
  ask(tried.length ? `Can't reach ${tried.join(" or ")}. Is this Mac on the tailnet?` : undefined);
}

void start();
