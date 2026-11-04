// Credentials to seed at the sinks (r131): one of each kind the redactors know, and the shapes main's transcript
// redactors (`redactText`, `redactProse`, `redactTokens`) let through and only `redactLast` takes. Each carries a
// `secret`: the part that must never show where the sink has run.

export interface Canary {
  name: string;
  /** The text an agent (or a tool) writes. */
  text: string;
  /** What shows if it leaked. */
  secret: string;
  /** One of the shapes only `redactLast` catches. */
  shape?: boolean;
}

const run = (c: string, n: number) => c.repeat(n);

export const CANARIES: Canary[] = [
  {
    name: "github token",
    text: "use ghp_CnryGhpTokn0aBcDeFgHiJkLmNoPqRsTuVwXyZ12 now",
    secret: "CnryGhpTokn0",
  },
  {
    name: "anthropic key",
    text: "key sk-ant-api03-CnryAnthr0pic1aBcDeFgHiJkLmNoPqRsTuVwXyZ0123 here",
    secret: "CnryAnthr0pic1",
  },
  { name: "aws key id", text: "id AKIACNRYAWSKEY000001 set", secret: "CNRYAWSKEY000001" },
  { name: "keyed password", text: "password: CnryPassw0rdKeyed2", secret: "CnryPassw0rdKeyed2" },
  { name: "env api key", text: "API_KEY=CnryEnvApiKey3abcdef", secret: "CnryEnvApiKey3abcdef" },
  {
    name: "bearer header",
    text: "Authorization: Bearer CnryBearer4aBcDeFgHiJkLmNoP",
    secret: "CnryBearer4aBcDeFgHiJkLmNoP",
  },
  {
    name: "private key",
    text: "-----BEGIN PRIVATE KEY-----\nMIIEvQCnryPemBody5AAAAbbbbccccdddd\n-----END PRIVATE KEY-----",
    secret: "CnryPemBody5",
  },
  {
    name: "jwt",
    text: "jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJDbnJ5In0.CnryJwtSig6abcdefghij end",
    secret: "CnryJwtSig6",
  },
  { name: "slack token", text: "xoxb-1234567890-CnrySlack7abc", secret: "CnrySlack7abc" },
  { name: "google key", text: "AIzaCnryGoogle8aBcDeFgHiJkLmNoPqRsTuVwXy ok", secret: "CnryGoogle8" },
  { name: "npm token", text: "npm_CnryNpmTokn9aBcDeFgHiJkLmNoPqRsTuVwXy ok", secret: "CnryNpmTokn9" },
  // Put together here, so GitHub's push protection doesn't take a made-up key for a real one.
  {
    name: "stripe key",
    text: `${["sk", "live", "CnryStripe10aBcDeFgHiJkLmNo"].join("_")} ok`,
    secret: "CnryStripe10",
  },
  { name: "webhook secret", text: "whsec_CnryWebhook11aBcDeFgHiJkLmNoPq ok", secret: "CnryWebhook11" },
  // The shapes only `redactLast` takes (r130).
  {
    name: "password with a slash",
    text: "db postgres://app:ab/CnrySlashPw12@db.example/app ok",
    secret: "CnrySlashPw12",
    shape: true,
  },
  {
    name: "userinfo over 400 characters",
    text: `at https://u:${run("x", 420)}CnryLongUser13@host.example/p ok`,
    secret: "CnryLongUser13",
    shape: true,
  },
  {
    name: "query token over 2,000 characters",
    text: `q https://h.example/x?token=${run("A", 2000)}CnryLongQuery14 ok`,
    secret: "CnryLongQuery14",
    shape: true,
  },
  {
    name: "sk- key glued after a digit",
    text: "k build9sk-CnryGluedSk15aBcDeFgHiJk ok",
    secret: "CnryGluedSk15",
    shape: true,
  },
  {
    name: "ghp_ token glued after an underscore",
    text: "g foo_ghp_CnryGluedGhp16aBcDeFgHiJkLmNoPqRsTuVw ok",
    secret: "CnryGluedGhp16",
    shape: true,
  },
];

export const SHAPES = CANARIES.filter((c) => c.shape);

/** One text holding every canary, a line each. */
export const ALL = CANARIES.map((c) => c.text).join("\n");

/** The canaries whose secret shows anywhere in `text`. */
export const visible = (text: string, list: Canary[] = CANARIES): string[] =>
  list.filter((c) => text.includes(c.secret)).map((c) => c.name);
