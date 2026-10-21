// Setup > Sandboxes shows each machine's disk and last cleanup, and what the Mac mini keeps (C23).
import { afterEach, describe, expect, it, vi } from "vitest";
import "../src/components/setup-sandboxes.ts";
import { agoText, sizeText } from "../src/components/setup-sandboxes.ts";

const GB = 1024 ** 3;
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const sandboxes = [
  {
    team: "engineering",
    machine: "inc-engineering",
    state: "running",
    cpus: 6,
    memory: "12G",
    signedIn: { claude: true, antigravity: false, github: true },
  },
  {
    team: "home",
    machine: "inc-home",
    state: "stopped",
    cpus: 6,
    memory: "12G",
    signedIn: { claude: false, antigravity: false, github: false },
  },
];

const storage = (over: Record<string, unknown> = {}) => ({
  settings: {
    sandboxCleanupDays: 3,
    transcriptCompactDays: 30,
    transcriptKeepItems: 50,
    backupMaxAgeDays: 30,
    logMaxMb: 20,
    logKeep: 5,
    diskWarnPct: 80,
  },
  machines: [
    {
      team: "engineering",
      machine: "inc-engineering",
      diskBytes: 20.4 * GB,
      fs: { totalBytes: 40 * GB, usedBytes: 12 * GB, percent: 30, measuredAt: Date.now() - 3 * 3_600_000 },
      lastCleanup: {
        at: Date.now() - 2 * 3_600_000,
        status: "cleaned",
        tickets: 4,
        freedBytes: 2.1 * GB,
        kept: [{ ticket: "9", reason: "unpushed" }],
      },
      freedBytesTotal: 6 * GB,
    },
    {
      team: "home",
      machine: "inc-home",
      diskBytes: 1.2 * GB,
      fs: null,
      lastCleanup: null,
      freedBytesTotal: 0,
    },
  ],
  host: {
    db: { bytes: 80 * 1024 ** 2, walBytes: 4 * 1024 ** 2 },
    knowledgeBytes: 5 * 1024 ** 2,
    logs: { bytes: 30 * 1024 ** 2 },
    containerData: { bytes: 68 * GB },
    rows: { images: { count: 3, bytes: 2 * 1024 ** 2 } },
  },
  memory: { rssBytes: 300 * 1024 ** 2, heapUsedBytes: 90 * 1024 ** 2 },
  ...over,
});

function serve(opts: { storage?: unknown | "404" | "fail" } = {}) {
  vi.stubGlobal("fetch", async (url: string) => {
    if (url === "/api/sandboxes") return json({ sandboxes });
    if (url === "/api/storage") {
      if (opts.storage === "404") return json({ error: "not found" }, 404);
      if (opts.storage === "fail") return new Response("<html>nope</html>", { status: 500 });
      return json(opts.storage ?? storage());
    }
    return json({ ok: true });
  });
}

async function mount(): Promise<ShadowRoot> {
  const el = document.createElement("inc-setup-sandboxes");
  document.body.append(el);
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
  await (el as unknown as { updateComplete: Promise<unknown> }).updateComplete;
  return el.shadowRoot as ShadowRoot;
}

afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe("sandbox disk and cleanup", () => {
  it("shows a machine's disk, its disk file on the Mac mini and what the last cleanup freed", async () => {
    serve();
    const root = await mount();
    const eng = root.querySelector('section[aria-label="inc-engineering"]');
    const text = eng?.querySelector(".disk")?.textContent?.replace(/\s+/g, " ") ?? "";
    expect(text).toContain("Disk 30% full: 12.0 GB of 40.0 GB, measured 3 hours ago.");
    expect(text).toContain("disk file on the Mac mini: 20.4 GB");
    expect(text).toContain(
      "Last cleanup 2 hours ago: freed 2.1 GB from 4 closed tickets, kept 1 with unpushed work. 6.0 GB freed in all.",
    );
    expect(eng?.querySelector(".disk .bad")).toBeNull();
  });

  it("says so when a machine hasn't been measured or cleaned", async () => {
    serve();
    const root = await mount();
    const home =
      root.querySelector('section[aria-label="inc-home"] .disk')?.textContent?.replace(/\s+/g, " ") ?? "";
    expect(home).toContain("Disk use is measured while the machine is up and idle.");
    expect(home).toContain("1.2 GB");
    expect(home).toContain("No cleanup has run yet.");
  });

  it("raises an alert once the disk passes the warning level", async () => {
    const s = storage();
    (s.machines[0] as { fs: { percent: number } }).fs.percent = 86;
    serve({ storage: s });
    const root = await mount();
    const alert = root.querySelector('section[aria-label="inc-engineering"] .disk [role="alert"]');
    expect(alert?.textContent).toContain("Disk 86% full");
    expect(alert?.classList.contains("bad")).toBe(true);
  });

  it("says when a cleanup failed", async () => {
    const s = storage();
    (s.machines[0] as { lastCleanup: unknown }).lastCleanup = {
      at: Date.now() - 60_000,
      status: "failed",
      reason: "the machine is in use",
      tickets: 0,
      freedBytes: 0,
      kept: [],
    };
    serve({ storage: s });
    const root = await mount();
    expect(root.querySelector('section[aria-label="inc-engineering"] .disk')?.textContent).toContain(
      "didn't finish: the machine is in use",
    );
  });

  it("lists what the Mac mini keeps, and for how long", async () => {
    serve();
    const root = await mount();
    const card = root.querySelector('section[aria-label="Mac mini storage"]');
    const dts = [...(card?.querySelectorAll(".facts dt") ?? [])].map((d) => d.textContent);
    const dds = [...(card?.querySelectorAll(".facts dd") ?? [])].map((d) => d.textContent);
    const facts = Object.fromEntries(dts.map((k, n) => [k, dds[n]]));
    expect(facts).toEqual({
      Database: "84 MB",
      "Brains and handbook": "5 MB",
      Logs: "30 MB",
      "Your uploaded images": "3 (2 MB), kept",
      "Container data": "68.0 GB",
      "Daemon memory": "300 MB",
    });
    const keeps = [...(card?.querySelectorAll(".keeps li") ?? [])].map((l) => l.textContent);
    expect(keeps).toEqual([
      "A closed ticket's copies in a sandbox go 3 days after it ends. The branch stays on GitHub.",
      "Transcripts of tickets closed over 30 days ago keep their last 50 items per session.",
      "Logs rotate at 20 MB, keeping 5.",
      "Database backups older than 30 days are deleted, except the newest.",
      "You get a push when a sandbox's disk passes 80% full.",
    ]);
  });

  it("says when cleanup is off", async () => {
    const s = storage();
    Object.assign(s.settings, { sandboxCleanupDays: 0, transcriptCompactDays: 0, backupMaxAgeDays: 0 });
    serve({ storage: s });
    const root = await mount();
    const keeps = root.querySelector('section[aria-label="Mac mini storage"] .keeps')?.textContent ?? "";
    expect(keeps).toContain("never (cleanup is off)");
    expect(keeps).toContain("Transcripts are kept whole.");
    expect(keeps).toContain("Database backups are kept.");
  });

  it("still shows the sandboxes when the daemon has no storage report", async () => {
    for (const storageResponse of ["404", "fail", { ok: true }] as const) {
      document.body.replaceChildren();
      serve({ storage: storageResponse });
      const root = await mount();
      expect(root.querySelectorAll("section.card")).toHaveLength(2);
      expect(root.querySelector(".disk")).toBeNull();
      expect(root.querySelector('section[aria-label="Mac mini storage"]')).toBeNull();
    }
  });
});

describe("sizes and times", () => {
  it("writes sizes the way the owner reads them", () => {
    expect(sizeText(20.4 * GB)).toBe("20.4 GB");
    expect(sizeText(812 * 1024 ** 2)).toBe("812 MB");
    expect(sizeText(0)).toBe("0 MB");
  });

  it("writes how long ago", () => {
    const now = 10_000_000_000;
    expect(agoText(now - 30_000, now)).toBe("just now");
    expect(agoText(now - 10 * 60_000, now)).toBe("10 minutes ago");
    expect(agoText(now - 5 * 3_600_000, now)).toBe("5 hours ago");
    expect(agoText(now - 4 * 86_400_000, now)).toBe("4 days ago");
  });
});
