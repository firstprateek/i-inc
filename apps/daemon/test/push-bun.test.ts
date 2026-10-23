import { createECDH } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

// Bun's createCipheriv refuses an ArrayBuffer as the key or IV (Node accepts one), so every real
// notification failed on the mini while these tests, run on Node, passed. Check what reaches the cipher.
const seen = vi.hoisted(() => [] as unknown[]);
vi.mock("node:crypto", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:crypto")>();
  return {
    ...real,
    createCipheriv: (algorithm: string, key: unknown, iv: unknown) => {
      seen.push(key, iv);
      return real.createCipheriv(algorithm, key as Buffer, iv as Buffer);
    },
  };
});

const { encryptPayload } = await import("../src/push.ts");

describe("Web Push: encryption under Bun", () => {
  it("gives the cipher its key and nonce as Buffers, not ArrayBuffers", () => {
    const client = createECDH("prime256v1");
    client.generateKeys();
    encryptPayload(
      { title: "t", body: "b", url: "/" },
      {
        p256dh: client.getPublicKey().toString("base64url"),
        auth: Buffer.alloc(16, 1).toString("base64url"),
      },
    );
    expect(seen).toHaveLength(2);
    for (const v of seen) expect(Buffer.isBuffer(v)).toBe(true);
  });
});
