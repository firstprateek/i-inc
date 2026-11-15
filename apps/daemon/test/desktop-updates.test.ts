// The desktop app's updates (desktop-updates.ts): the updater's answer names the build on the host the request
// came to, and nothing in the folder but the current build and its zip is ever served.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { originOf, parseRelease, serveDesktopUpdates, updaterManifest } from "../src/desktop-updates.ts";
import { httpFetch } from "../src/http.ts";

const RELEASE = {
  version: "0.3.202611150200",
  notes: "updates itself",
  pub_date: "2026-11-15T02:00:00Z",
  file: "i.inc_0.3.202611150200.app.tar.gz",
  signature: "c2lnbmF0dXJl",
};

function folder(release: unknown = RELEASE) {
  const dir = mkdtempSync(join(tmpdir(), "i-inc-desktop-"));
  if (release !== null) writeFileSync(join(dir, "release.json"), JSON.stringify(release));
  writeFileSync(join(dir, RELEASE.file), "tarball");
  writeFileSync(join(dir, "i.inc.zip"), "zip");
  writeFileSync(join(dir, "secret.key"), "nope");
  writeFileSync(join(dir, "i.inc_0.2.1.app.tar.gz"), "old build");
  return dir;
}

const get = (serve: ReturnType<typeof serveDesktopUpdates>, path: string, host = "iinc.example.ts.net") =>
  serve(new Request(`http://127.0.0.1:7420${path}`, { headers: { host } }));

describe("release.json", () => {
  it("is read only when every field is there and the file name has the build's shape", () => {
    expect(parseRelease(JSON.stringify(RELEASE))).toEqual(RELEASE);
    expect(parseRelease(JSON.stringify({ ...RELEASE, file: "../secret.key" }))).toBeNull();
    expect(parseRelease(JSON.stringify({ ...RELEASE, version: "latest" }))).toBeNull();
    expect(parseRelease(JSON.stringify({ ...RELEASE, signature: "" }))).toBeNull();
    expect(parseRelease("not json")).toBeNull();
  });
});

describe("the download address", () => {
  it("is plain http on loopback and https on the tailnet name, and refuses an odd Host", () => {
    expect(originOf("127.0.0.1:7420")).toBe("http://127.0.0.1:7420");
    expect(originOf("localhost:7420")).toBe("http://localhost:7420");
    expect(originOf("iinc.example.ts.net")).toBe("https://iinc.example.ts.net");
    expect(originOf("evil.com/@x")).toBeNull();
    expect(originOf(null)).toBeNull();
  });

  it("is listed for both slices of the universal build", () => {
    const m = updaterManifest(RELEASE, "https://iinc.example.ts.net");
    expect(m.version).toBe(RELEASE.version);
    expect(Object.keys(m.platforms).sort()).toEqual(["darwin-aarch64", "darwin-x86_64"]);
    expect(m.platforms["darwin-aarch64"]).toEqual({
      signature: RELEASE.signature,
      url: `https://iinc.example.ts.net/desktop/${RELEASE.file}`,
    });
  });
});

describe("GET /desktop/…", () => {
  it("answers latest.json for the host asked, without caching", async () => {
    const serve = serveDesktopUpdates(folder());
    const res = await get(serve, "/desktop/latest.json", "127.0.0.1:7420");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as { platforms: Record<string, { url: string }> };
    expect(body.platforms["darwin-x86_64"]?.url).toBe(`http://127.0.0.1:7420/desktop/${RELEASE.file}`);
  });

  it("says there is no update (204) when nothing has been released", async () => {
    const serve = serveDesktopUpdates(folder(null));
    expect((await get(serve, "/desktop/latest.json")).status).toBe(204);
    expect((await get(serve, "/desktop/i.inc.zip")).status).toBe(404);
  });

  it("serves the current build and the zip, and nothing else in the folder", async () => {
    const serve = serveDesktopUpdates(folder());
    const build = await get(serve, `/desktop/${RELEASE.file}`);
    expect(build.status).toBe(200);
    expect(await build.text()).toBe("tarball");
    expect(build.headers.get("content-type")).toBe("application/gzip");
    const zip = await get(serve, "/desktop/i.inc.zip");
    expect(zip.status).toBe(200);
    expect(zip.headers.get("content-disposition")).toContain("i.inc.zip");
    for (const path of [
      "/desktop/secret.key",
      "/desktop/release.json",
      "/desktop/i.inc_0.2.1.app.tar.gz",
      "/desktop/../i-inc.db",
      "/desktop/%2e%2e/i-inc.db",
    ]) {
      expect((await get(serve, path)).status, path).toBe(404);
    }
  });

  it("only reads", async () => {
    const serve = serveDesktopUpdates(folder());
    const res = await serve(new Request("http://127.0.0.1:7420/desktop/latest.json", { method: "POST" }));
    expect(res.status).toBe(405);
  });

  it("is routed before the web app and the API, with no login", async () => {
    const seen: string[] = [];
    const fetch = httpFetch<null>({
      ahp: { matches: () => false, guard: () => ({ data: null }) },
      api: () => {
        seen.push("api");
        return new Response("{}", { status: 401 });
      },
      desktop: (req) => {
        seen.push(`desktop ${new URL(req.url).pathname}`);
        return new Response("{}");
      },
      web: () => () => {
        seen.push("web");
        return new Response("<html>");
      },
    });
    const server = { upgrade: () => false, timeout: () => {}, requestIP: () => null };
    await fetch(new Request("http://127.0.0.1:7420/desktop/latest.json"), server);
    await fetch(new Request("http://127.0.0.1:7420/desktopish"), server);
    expect(seen).toEqual(["desktop /desktop/latest.json", "web"]);
  });
});
