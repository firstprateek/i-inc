// Adding an engine, account or team must never replace one that is there: `If-None-Match: *` on the PUT
// makes it create-only (412 when the id is taken). Without it the PUT still updates, as the cap editor needs.
import { describe, expect, it } from "vitest";
import { testApp } from "./setup.ts";

async function put(app: Awaited<ReturnType<typeof testApp>>, path: string, body: unknown, create: boolean) {
  const res = await app.handle(
    new Request(`http://i.inc${path}`, {
      method: "PUT",
      headers: { "content-type": "application/json", ...(create ? { "if-none-match": "*" } : {}) },
      body: JSON.stringify(body),
    }),
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe("create-only PUT (If-None-Match: *)", () => {
  it("refuses to replace an engine, and leaves it as it was", async () => {
    const app = await testApp();
    const before = app.deps.registry.engines().find((e) => e.id === "opus");
    expect(before).toBeTruthy();
    const r = await put(
      app,
      "/api/engines/opus",
      { harness: "antigravity", model: "oops-overwritten", accountId: before?.accountId, local: false },
      true,
    );
    expect(r.status).toBe(412);
    expect(r.body.code).toBe("exists");
    expect(String(r.body.error)).toContain(`${before?.model} on ${before?.harness}`);
    expect(app.deps.registry.engines().find((e) => e.id === "opus")).toEqual(before);
  });

  it("creates a new engine with it, and still updates without it", async () => {
    const app = await testApp();
    const accountId = app.deps.registry.engines()[0]?.accountId;
    const made = await put(
      app,
      "/api/engines/fresh",
      { harness: "claude-code", model: "Fresh", accountId },
      true,
    );
    expect(made.status).toBe(200);
    const again = await put(
      app,
      "/api/engines/fresh",
      { harness: "claude-code", model: "Fresh", accountId },
      true,
    );
    expect(again.status).toBe(412);
    const updated = await put(app, "/api/engines/fresh", { model: "Fresher" }, false);
    expect(updated.status).toBe(200);
    expect(app.deps.registry.engines().find((e) => e.id === "fresh")?.model).toBe("Fresher");
  });

  it("refuses to replace an account, but still lets a cap be set on it", async () => {
    const app = await testApp();
    const account = app.deps.registry.accounts()[0];
    expect(account).toBeTruthy();
    const refused = await put(app, `/api/accounts/${account?.id}`, { name: "Replaced" }, true);
    expect(refused.status).toBe(412);
    expect(app.deps.registry.accounts().find((a) => a.id === account?.id)?.name).toBe(account?.name);
    const capped = await put(
      app,
      `/api/accounts/${account?.id}`,
      { name: account?.name, monthlyCap: 75 },
      false,
    );
    expect(capped.status).toBe(200);
    const fresh = await put(app, "/api/accounts/brand-new", { name: "Brand new" }, true);
    expect(fresh.status).toBe(200);
  });

  it("refuses to replace a team", async () => {
    const app = await testApp();
    expect((await put(app, "/api/teams/crew", { name: "Crew", members: [] }, true)).status).toBe(200);
    const again = await put(app, "/api/teams/crew", { name: "Other", members: [] }, true);
    expect(again.status).toBe(412);
    expect(app.deps.registry.teams().find((t) => t.id === "crew")?.name).toBe("Crew");
    expect((await put(app, "/api/teams/crew", { name: "Renamed", members: [] }, false)).status).toBe(200);
  });
});
