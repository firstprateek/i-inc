// What the host keeps from an agent: secrets out wherever they fall, and no input that stalls it.
import { describe, expect, it } from "vitest";
import { redactText, sanitizeAction } from "../../src/ahp/sanitize.ts";

const secrets = [
  "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
  "Bearer eyJhbGciOiJIUzI1NiJ9abcdefghijklmnop",
  "Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345",
  "password: hunter2hunter2",
  "api_key=sk-abcdefghijklmnopqrstuvwx",
  "AKIAABCDEFGHIJKLMNOP",
  "https://user:s3cretpass@example.com/x",
  '{"token": "abcd1234efgh5678"}',
];
const tails: Record<string, string> = {
  ghp_abcdefghijklmnopqrstuvwxyz0123456789: "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
  "Bearer eyJhbGciOiJIUzI1NiJ9abcdefghijklmnop": "eyJhbGciOiJIUzI1NiJ9abcdefghijklmnop",
  "Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345": "abcdefghijklmnopqrstuvwxyz012345",
  "password: hunter2hunter2": "hunter2hunter2",
  "api_key=sk-abcdefghijklmnopqrstuvwx": "sk-abcdefghijklmnopqrstuvwx",
  AKIAABCDEFGHIJKLMNOP: "AKIAABCDEFGHIJKLMNOP",
  "https://user:s3cretpass@example.com/x": "s3cretpass",
  '{"token": "abcd1234efgh5678"}': "abcd1234efgh5678",
};

describe("redaction leaves no secret at any position", () => {
  for (const secret of secrets) {
    it(`slides ${secret.slice(0, 22)}… across every offset around 2048, 4096 and 64 KB`, () => {
      const value = tails[secret] as string;
      const leaks: number[] = [];
      for (const edge of [2048, 4096, 65_536 - 1024]) {
        for (let off = edge - secret.length - 40; off <= edge + 40; off++) {
          // ordinary words, so the text has the spaces a log has
          const pad = "lorem ipsum ".repeat(Math.ceil(off / 12)).slice(0, off);
          const out = redactText(`${pad} ${secret} and the rest of the line\n`);
          if (out.includes(value)) leaks.push(off);
        }
      }
      expect(leaks).toEqual([]);
    });
  }

  it("also holds through sanitizeAction, on a tool result bigger than any window", () => {
    const body = "line of output\n".repeat(3000);
    const out = sanitizeAction(
      {
        result: {
          content: [
            { type: "text", text: `${body}token=${"ghp_abcdefghijklmnopqrstuvwxyz0123456789"}\n${body}` },
          ],
        },
      },
      { maxString: 200_000, maxAction: 1_000_000 },
    );
    expect(JSON.stringify(out)).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
  });
});

describe("hostile input costs milliseconds", () => {
  const time = (f: () => unknown) => {
    const t = performance.now();
    f();
    return performance.now() - t;
  };
  it("takes 60 KB of one letter, of hex, of base64 and of dotted words without stalling", () => {
    for (const text of [
      "z".repeat(65_536),
      "a1".repeat(32_768),
      "QUJD".repeat(16_384),
      "a.".repeat(32_768),
      `${"key-".repeat(13_000)}=`,
      `${"https:".repeat(10_000)}`,
    ]) {
      expect(time(() => redactText(text))).toBeLessThan(400);
    }
  });
  it("drops a long unbroken run, with its length, and keeps ordinary lines whole", () => {
    expect(redactText(`before ${"x".repeat(5000)} after`)).toBe(
      "before [5000 characters in one unbroken run, not kept] after",
    );
    const line = `${"a".repeat(150)} ok`;
    expect(redactText(line)).toBe(line);
    // a token that is part of a long run goes with it
    expect(redactText(`${"y".repeat(300)}ghp_abcdefghijklmnopqrstuvwxyz0123456789`)).not.toContain("ghp_");
  });
});
