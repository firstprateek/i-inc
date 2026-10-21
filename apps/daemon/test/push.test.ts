import { createDecipheriv, createECDH, hkdfSync } from "node:crypto";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { openDb } from "../src/db.ts";
import {
  createVapidAuthHeader,
  encryptPayload,
  generateVapidKeys,
  type NotificationPayload,
  vapidKeys,
  WebPushSender,
} from "../src/push.ts";
import { Registry } from "../src/registry.ts";
import { migrate } from "../src/schema.ts";

describe("Web Push: VAPID keys", () => {
  it("generates a 65-byte uncompressed P-256 public key and saves to vapid.json with mode 0600", () => {
    const dir = mkdtempSync(join(tmpdir(), "i-inc-push-test-"));
    try {
      const keys = vapidKeys(dir);
      expect(keys.publicKey).toBeDefined();
      expect(keys.privateJwk).toBeDefined();
      expect(keys.privateJwk.kty).toBe("EC");
      expect(keys.privateJwk.crv).toBe("P-256");

      const pubBuf = Buffer.from(keys.publicKey, "base64url");
      expect(pubBuf.length).toBe(65);
      expect(pubBuf[0]).toBe(0x04);

      const filePath = join(dir, "vapid.json");
      const stat = statSync(filePath);
      expect(stat.mode & 0o077).toBe(0);

      // Re-read returns identical keys
      const keys2 = vapidKeys(dir);
      expect(keys2.publicKey).toBe(keys.publicKey);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("Web Push: RFC 8292 VAPID Authorization", () => {
  it("generates Authorization header with ES256 JWT containing aud, exp, and sub", () => {
    const dir = mkdtempSync(join(tmpdir(), "i-inc-push-test-"));
    try {
      const keys = vapidKeys(dir);
      const endpoint = "https://fcm.googleapis.com/fcm/send/fake-token";
      const now = 1700000000000;
      const header = createVapidAuthHeader(endpoint, keys, now);

      expect(header.startsWith("vapid t=")).toBe(true);
      expect(header.includes(`, k=${keys.publicKey}`)).toBe(true);

      const match = /^vapid t=([^,]+), k=(.+)$/.exec(header);
      expect(match).not.toBeNull();
      const jwt = match?.[1] ?? "";
      const [headerB64, payloadB64, sigB64] = jwt.split(".");
      expect(headerB64).toBeDefined();
      expect(payloadB64).toBeDefined();
      expect(sigB64).toBeDefined();

      const decodedHeader = JSON.parse(Buffer.from(headerB64 ?? "", "base64url").toString("utf8"));
      expect(decodedHeader).toEqual({ typ: "JWT", alg: "ES256" });

      const decodedPayload = JSON.parse(Buffer.from(payloadB64 ?? "", "base64url").toString("utf8"));
      expect(decodedPayload.aud).toBe("https://fcm.googleapis.com");
      expect(decodedPayload.sub).toBe("mailto:owner@i.inc");
      expect(decodedPayload.exp).toBe(Math.floor(now / 1000) + 12 * 3600);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("Web Push: RFC 8291 payload encryption", () => {
  it("encrypts payload using aes128gcm and client can decrypt it", () => {
    const client = createECDH("prime256v1");
    client.generateKeys();
    const clientPub = client.getPublicKey();
    const authSecret = Buffer.from("16bytesauthsec!!");

    const payload: NotificationPayload = {
      title: "Needs you · #1",
      body: "Refunds are counted as spending",
      url: "#/ticket/1",
    };

    const encrypted = encryptPayload(payload, {
      p256dh: clientPub.toString("base64url"),
      auth: authSecret.toString("base64url"),
    });

    expect(encrypted.headers).toEqual({
      "content-encoding": "aes128gcm",
      "content-type": "application/octet-stream",
    });

    // Decrypt using client's keys
    const raw = encrypted.body;
    const salt = raw.subarray(0, 16);
    const keyIdLen = raw[20] ?? 0;
    const serverPub = raw.subarray(21, 21 + keyIdLen);
    const ciphertext = raw.subarray(21 + keyIdLen);

    const clientShared = client.computeSecret(serverPub);
    const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0", "utf8"), clientPub, serverPub]);
    const ikm = hkdfSync("sha256", clientShared, authSecret, keyInfo, 32);
    const cek = hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0", "utf8"), 16);
    const nonce = hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0", "utf8"), 12);

    const authTag = ciphertext.subarray(ciphertext.length - 16);
    const encData = ciphertext.subarray(0, ciphertext.length - 16);

    const decipher = createDecipheriv("aes-128-gcm", cek, nonce);
    decipher.setAuthTag(authTag);
    const decryptedPadded = Buffer.concat([decipher.update(encData), decipher.final()]);
    const decryptedJson = decryptedPadded.subarray(0, decryptedPadded.length - 1).toString("utf8");

    expect(JSON.parse(decryptedJson)).toEqual(payload);
  });

  it("falls back to plaintext JSON when keys are missing", () => {
    const payload: NotificationPayload = {
      title: "Title",
      body: "Body",
      url: "#/ticket/2",
    };
    const res = encryptPayload(payload);
    expect(res.headers).toEqual({ "content-type": "application/json" });
    expect(JSON.parse(res.body.toString("utf8"))).toEqual(payload);
  });
});

describe("WebPushSender", () => {
  it("sends push notification with VAPID header and removes 410 Gone subscriptions", async () => {
    const db = await openDb(":memory:");
    migrate(db);
    const registry = new Registry(db);

    const dir = mkdtempSync(join(tmpdir(), "i-inc-push-test-"));
    try {
      const keys = vapidKeys(dir);

      registry.addPushSubscription({
        endpoint: "https://push.example.com/sub/active",
      });
      registry.addPushSubscription({
        endpoint: "https://push.example.com/sub/stale",
      });

      // biome-ignore lint/suspicious/noExplicitAny: test records request
      const calls: { url: string; headers: Record<string, string>; body: any }[] = [];
      const mockFetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        calls.push({
          url,
          headers: (init?.headers as Record<string, string>) ?? {},
          body: init?.body,
        });
        if (url.includes("/stale")) {
          return new Response("Gone", { status: 410 });
        }
        return new Response("OK", { status: 201 });
      }) as unknown as typeof fetch;

      const sender = new WebPushSender(registry, {
        vapid: keys,
        fetchImpl: mockFetch,
      });

      await sender.send({
        title: "Report ready · #1",
        body: "Summary",
        url: "#/ticket/1",
      });

      expect(calls).toHaveLength(2);
      expect(calls[0]?.headers.authorization).toContain(`k=${keys.publicKey}`);
      expect(calls[0]?.headers.ttl).toBe("86400");

      // Stale subscription is removed
      const remaining = registry.pushSubscriptions();
      expect(remaining).toHaveLength(1);
      expect(remaining[0]?.endpoint).toBe("https://push.example.com/sub/active");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("handles non-410 delivery failure and fetch rejection without throwing", async () => {
    const db = await openDb(":memory:");
    migrate(db);
    const registry = new Registry(db);
    registry.addPushSubscription({
      endpoint: "https://push.example.com/sub/500",
    });
    registry.addPushSubscription({
      endpoint: "https://push.example.com/sub/network-error",
    });

    const mockFetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/network-error")) throw new Error("ECONNRESET");
      return new Response("Internal Server Error", { status: 500 });
    }) as unknown as typeof fetch;

    const sender = new WebPushSender(registry, {
      vapid: { publicKey: "fake", privateJwk: {} },
      fetchImpl: mockFetch,
    });

    // Does not throw
    await expect(
      sender.send({
        title: "Test",
        body: "Body",
        url: "#/ticket/1",
      }),
    ).resolves.not.toThrow();

    // 500 is not removed from registry
    expect(registry.pushSubscriptions()).toHaveLength(2);
  });

  it("does not log a subscription's endpoint when delivery fails", async () => {
    const db = await openDb(":memory:");
    migrate(db);
    const registry = new Registry(db);
    registry.addPushSubscription({ endpoint: "https://push.example.com/secret-endpoint-token" });
    registry.addPushSubscription({ endpoint: "https://push2.example.com/other-secret-token" });
    const logged: string[] = [];
    const warn = vi.spyOn(console, "warn").mockImplementation((...a: unknown[]) => {
      logged.push(a.map(String).join(" "));
    });
    try {
      const sender = new WebPushSender(registry, {
        vapid: generateVapidKeys(),
        fetchImpl: (async (input: string | URL | Request) => {
          if (String(input).includes("push2")) throw new Error(`failed for ${String(input)}`);
          return new Response("no", { status: 500 });
        }) as unknown as typeof fetch,
      });
      await sender.send({ title: "t", body: "b", url: "#/ticket/1" });
    } finally {
      warn.mockRestore();
    }
    expect(logged.length).toBeGreaterThan(0);
    expect(logged.join("\n")).not.toMatch(/secret|push\.example/);
  });
});
