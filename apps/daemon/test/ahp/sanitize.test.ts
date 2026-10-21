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

/**
 * The best of three runs, in ms: a machine busy with other test files can slow one run by a factor
 * of two, but not all three, and a pattern that backtracks costs seconds, not milliseconds.
 */
const fastest = <T>(fn: () => T, runs = 3): { ms: number; value: T } => {
  let best = Number.POSITIVE_INFINITY;
  let value = undefined as T;
  for (let i = 0; i < runs; i++) {
    const t = performance.now();
    value = fn();
    best = Math.min(best, performance.now() - t);
  }
  return { ms: best, value };
};

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

describe("hostile input costs milliseconds, of every class", () => {
  const N = 65_536;
  const rep = (x: string) => x.repeat(Math.ceil(N / x.length)).slice(0, N);
  const lcg = (alphabet: string) => {
    let seed = 12345;
    let out = "";
    for (let i = 0; i < N; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      out += alphabet[seed % alphabet.length];
    }
    return out;
  };
  const classes: Record<string, string> = {
    spaces: " ".repeat(N),
    newlines: "\n".repeat(N),
    tabs: "\t".repeat(N),
    crlf: "\r\n".repeat(N / 2),
    mixedBlanks: rep(" \n\t"),
    equals: "=".repeat(N),
    dashes: "-".repeat(N),
    slashes: "/".repeat(N),
    pluses: "+".repeat(N),
    dots: ".".repeat(N),
    underscores: "_".repeat(N),
    colons: ":".repeat(N),
    doubleQuotes: '"'.repeat(N),
    singleQuotes: "'".repeat(N),
    backslashes: "\\".repeat(N),
    base64: lcg("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"),
    hex: lcg("0123456789abcdef"),
    oneLetter: "z".repeat(N),
    keyColon: rep("key: "),
    tokenEquals: rep("token="),
    passwordColon: rep("password: "),
    bearers: rep("Bearer "),
    authorizations: rep("authorization: "),
    schemes: rep("https://"),
    userinfo: rep("https://u:"),
    cliFlags: rep("--password "),
    prefixes: rep("sk-ghp_xoxeyJAKIAAIza"),
    jsonKeys: rep('"token": "'),
    jsonKeys2: rep('"a_key":'),
    keyEqQuote: rep('key="'),
    dotted: rep("a."),
    dashed: rep("a-"),
    slashed: rep("a/"),
    equalsPairs: rep("a="),
    queryPairs: rep("k=v&"),
    queries: rep("?token="),
    keyWords: rep("key-"),
    secretWords: rep("secret-"),
    tokenWords: rep("mytoken"),
    apiKeys: rep("api_key"),
    pem: rep("-----BEGIN PRIVATE KEY-----"),
    dataUris: rep("data:image/png;base64,"),
    runsJustUnderTheCap: rep(`${"a".repeat(499)} `),
    runsOfTwoHundred: rep(`${"b".repeat(199)} `),
    keyedRuns: rep(`${"c".repeat(60)}key=`),
    emptyValues: rep("password: ''"),
  };
  for (const [name, text] of Object.entries(classes)) {
    it(`redacts 64 KB of ${name} in under 50 ms`, () => {
      redactText(text.slice(0, 1024)); // warm up the regex engine
      const { ms, value: out } = fastest(() => redactText(text));
      expect(ms).toBeLessThan(50);
      expect(out.length).toBeLessThanOrEqual(text.length * 2);
    });
  }

  it("keeps a whole maximum-size action, sixteen such strings, under 200 ms", () => {
    const names = Object.keys(classes);
    const content = Array.from({ length: 16 }, (_, i) => ({
      type: "text",
      text: classes[names[(i * 3) % names.length] as string],
    }));
    const { ms, value: out } = fastest(() =>
      sanitizeAction({ result: { content } }, { maxString: 64 * 1024, maxAction: 1024 * 1024 }),
    );
    expect(ms).toBeLessThan(200);
    expect(JSON.stringify(out).length).toBeLessThanOrEqual(1024 * 1024 + 1000);
    // and 64 KB blocks of blanks, the worst class for the old redactor, sixteen at a time
    const blanks = Array.from({ length: 16 }, (_, i) => ({
      type: "text",
      text: [" ", "\n", "\t", "\r\n"][i % 4]?.repeat(N / 2),
    }));
    expect(fastest(() => sanitizeAction({ result: { content: blanks } })).ms).toBeLessThan(200);
  });
});

describe("what redaction keeps and what it takes", () => {
  it("collapses a block of blanks to one, keeping a newline when there was one", () => {
    expect(redactText(`a${" ".repeat(5000)}b`)).toBe("a b");
    expect(redactText(`a${"\n".repeat(5000)}b`)).toBe("a\nb");
    expect(redactText(`a${" \n ".repeat(500)}b`)).toBe("a\nb");
    expect(redactText(`a${" ".repeat(150)}b`)).toBe(`a${" ".repeat(150)}b`);
  });

  it("names a data: URI for what it is instead of dropping it", () => {
    const png = `data:image/png;base64,${"iVBORw0KGgo".repeat(5000)}`;
    expect(redactText(`<img src="${png}">`)).toBe('<img src="[image/png data, 54 KB]">');
    expect(redactText("data:text/plain,short")).toBe("data:text/plain,short");
  });

  it("keeps long URLs, paths and identifiers up to 500 characters, drops past that", () => {
    const url = `https://example.com/${"segment/".repeat(40)}file.txt`; // about 330
    expect(redactText(url)).toBe(url);
    const id = `${"Identifier".repeat(21)}`; // 210
    expect(redactText(`see ${id} here`)).toBe(`see ${id} here`);
    expect(redactText(`see ${"x".repeat(499)} here`)).toBe(`see ${"x".repeat(499)} here`);
    expect(redactText(`see ${"x".repeat(500)} here`)).toBe(
      "see [500 characters in one unbroken run, not kept] here",
    );
  });

  it("keeps a URL but takes its userinfo and the values of secret-looking parameters", () => {
    const out = redactText(
      "GET https://deploy@example.com/x?id=7&token=abc123&sig=deadbeef&X-Amz-Signature=0123abcd&code=9&page=2&access_token=zzz#frag and https://u:pw@h.io/",
    );
    expect(out).toContain(
      "https://[redacted]@example.com/x?id=7&token=[redacted]&sig=[redacted]&X-Amz-Signature=[redacted]&code=[redacted]&page=2&access_token=[redacted]",
    );
    expect(out).toContain("https://u:[redacted]@h.io/");
    expect(out).not.toMatch(/abc123|deadbeef|0123abcd|zzz|deploy@|:pw@/);
  });

  const long = {
    jwt: `eyJ${"hGciOiJIUzI1NiJ9".repeat(30)}.eyJ${"c3ViIjoiMTIzIn0".repeat(30)}.${"SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV".repeat(10)}`,
    pem: `-----BEGIN RSA PRIVATE KEY-----\n${("MIIEpAIBAAKCAQEA3Tz2mr7SZiAMfQyuvBjM9Oi".repeat(2) + "\n").repeat(20)}-----END RSA PRIVATE KEY-----`,
    pemNoEnd: `-----BEGIN PRIVATE KEY-----\n${("MIIEvQIBADANBgkqhkiG9w0BAQEFAASC".repeat(2) + "\n").repeat(30)}`,
    anthropic: `sk-ant-api03-${"AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-".repeat(6)}`,
    github: `github_pat_${"11ABCDEFG0".repeat(20)}`,
    awsSecret: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    awsKeyed: "aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    slack: `xoxb-${"1234567890-".repeat(15)}abcdefABCDEF`,
  };
  const marks: Record<string, string> = {
    jwt: "hGciOiJIUzI1NiJ9hGciOiJIUzI1NiJ9",
    pem: "MIIEpAIBAAKCAQEA3Tz2mr7SZiAMfQyuvBjM9Oi",
    pemNoEnd: "MIIEvQIBADANBgkqhkiG9w0BAQEFAASC",
    anthropic: "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-AbCdEf",
    github: "11ABCDEFG011ABCDEFG0",
    awsSecret: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    awsKeyed: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    slack: "1234567890-1234567890-",
  };
  for (const [name, secret] of Object.entries(long)) {
    it(`still catches a long ${name}, at every offset around 2048 and 65536`, () => {
      const leaks: number[] = [];
      for (const edge of [2048, 65_536]) {
        for (let off = edge - 60; off <= edge + 20; off += 1) {
          const pad = "lorem ipsum ".repeat(Math.ceil(off / 12)).slice(0, off);
          const out = sanitizeAction(
            { text: `${pad} ${secret} and then some\n` },
            { maxString: 65_536, maxAction: 1_000_000 },
          ) as { text: string };
          if (out.text.includes(marks[name] as string)) leaks.push(off);
        }
      }
      expect(leaks).toEqual([]);
    });
  }
});

describe("redaction comes before the cut", () => {
  it("never leaves half a URL password at the end of a 64 KB string", () => {
    const leaks: number[] = [];
    const pw = "hunter2hunter2hunter2";
    for (let off = 65_536 - 80; off <= 65_536 + 80; off++) {
      const pad = "x ".repeat(Math.ceil(off / 2)).slice(0, off);
      const text = `${pad}https://user:${pw}@example.com/path tail ${"y ".repeat(2000)}`;
      const out = (sanitizeAction({ text }, { maxString: 65_536, maxAction: 1_000_000 }) as { text: string })
        .text;
      for (let n = 4; n <= pw.length; n++)
        if (out.includes(`:${pw.slice(0, n)}`) || out.includes(pw.slice(0, n) + "@")) leaks.push(off);
    }
    expect(leaks).toEqual([]);
  });

  it("cuts at a boundary and says how much was cut", () => {
    const text = `${"word ".repeat(30_000)}`;
    const out = (sanitizeAction({ text }, { maxString: 65_536, maxAction: 1_000_000 }) as { text: string })
      .text;
    expect(out.length).toBeLessThanOrEqual(65_536 + 64);
    expect(out).toMatch(/word\n\[…\d+ more characters not kept\]$/);
  });
});
