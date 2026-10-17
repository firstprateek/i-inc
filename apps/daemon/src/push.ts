// Web Push notification sender (RFC 8291 aes128gcm encryption & RFC 8292 VAPID).
import {
  createCipheriv,
  createECDH,
  createPrivateKey,
  createSign,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
} from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { configDir, readOwnerOnly } from "./config.ts";
import type { Registry } from "./registry.ts";

export interface VapidKeys {
  /** 65-byte uncompressed P-256 EC public point encoded in base64url. */
  publicKey: string;
  privateJwk: JsonWebKey;
}

export interface PushSubscriptionKeys {
  p256dh?: string;
  auth?: string;
}

export interface PushSubscription {
  endpoint: string;
  keys?: PushSubscriptionKeys;
  expirationTime?: number | null;
}

export interface NotificationPayload {
  title: string;
  body: string;
  url: string;
}

export interface PushService {
  publicKey(): string;
  send(notification: NotificationPayload): Promise<void>;
  subscribe(sub: PushSubscription): Promise<void>;
  unsubscribe(endpoint: string): Promise<void>;
}

/** Generates a fresh P-256 VAPID keypair in memory. */
export function generateVapidKeys(): VapidKeys {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = privateKey.export({ format: "jwk" });
  const rawPub = Buffer.concat([
    Buffer.from([0x04]),
    Buffer.from(jwk.x ?? "", "base64url"),
    Buffer.from(jwk.y ?? "", "base64url"),
  ]);
  return {
    publicKey: rawPub.toString("base64url"),
    privateJwk: jwk,
  };
}

/** Reads or generates the VAPID keys in ~/.config/i-inc/vapid.json (mode 0600). */
export function vapidKeys(dir = configDir()): VapidKeys {
  const path = join(dir, "vapid.json");
  if (existsSync(path)) {
    const raw = JSON.parse(readOwnerOnly(path)) as VapidKeys;
    if (raw.publicKey && raw.privateJwk) return raw;
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const keys = generateVapidKeys();
  writeFileSync(path, `${JSON.stringify(keys, null, 2)}\n`, { mode: 0o600 });
  return keys;
}

/** Generates RFC 8292 VAPID Authorization header `vapid t=<jwt>, k=<publicKey>`. */
export function createVapidAuthHeader(endpoint: string, keys: VapidKeys, now = Date.now()): string {
  const aud = new URL(endpoint).origin;
  const header = Buffer.from(JSON.stringify({ typ: "JWT", alg: "ES256" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      aud,
      exp: Math.floor(now / 1000) + 12 * 3600,
      sub: "mailto:owner@i.inc",
    }),
  ).toString("base64url");

  const privKeyObj = createPrivateKey({ key: keys.privateJwk, format: "jwk" });
  const sign = createSign("SHA256");
  sign.update(`${header}.${payload}`);
  const signature = sign.sign({ key: privKeyObj, dsaEncoding: "ieee-p1363" }).toString("base64url");
  const token = `${header}.${payload}.${signature}`;
  return `vapid t=${token}, k=${keys.publicKey}`;
}

/** Encrypts payload following RFC 8291 (aes128gcm), or returns plain JSON if keys are absent. */
export function encryptPayload(
  payload: NotificationPayload,
  keys?: PushSubscriptionKeys,
): { body: Buffer; headers: Record<string, string> } {
  if (!keys?.p256dh || !keys?.auth) {
    const raw = Buffer.from(JSON.stringify(payload), "utf8");
    return {
      body: raw,
      headers: { "content-type": "application/json" },
    };
  }

  const clientPub = Buffer.from(keys.p256dh, "base64url");
  const authSecret = Buffer.from(keys.auth, "base64url");

  const server = createECDH("prime256v1");
  server.generateKeys();
  const serverPub = server.getPublicKey();

  const sharedSecret = server.computeSecret(clientPub);

  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0", "utf8"), clientPub, serverPub]);
  const ikm = hkdfSync("sha256", sharedSecret, authSecret, keyInfo, 32);

  const salt = randomBytes(16);
  const cekInfo = Buffer.from("Content-Encoding: aes128gcm\0", "utf8");
  const nonceInfo = Buffer.from("Content-Encoding: nonce\0", "utf8");
  const cek = hkdfSync("sha256", ikm, salt, cekInfo, 16);
  const nonce = hkdfSync("sha256", ikm, salt, nonceInfo, 12);

  const recordSize = 4096;
  const header = Buffer.concat([
    salt,
    Buffer.from([
      (recordSize >> 24) & 0xff,
      (recordSize >> 16) & 0xff,
      (recordSize >> 8) & 0xff,
      recordSize & 0xff,
    ]),
    Buffer.from([serverPub.length]),
    serverPub,
  ]);

  const plaintext = Buffer.concat([Buffer.from(JSON.stringify(payload), "utf8"), Buffer.from([0x02])]);

  const cipher = createCipheriv("aes-128-gcm", cek, nonce);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);

  const body = Buffer.concat([header, ciphertext]);
  return {
    body,
    headers: {
      "content-encoding": "aes128gcm",
      "content-type": "application/octet-stream",
    },
  };
}

export interface WebPushSenderOptions {
  vapid?: VapidKeys;
  configDir?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export class WebPushSender implements PushService {
  readonly vapid: VapidKeys;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(
    private readonly registry: Registry,
    opts: WebPushSenderOptions = {},
  ) {
    this.vapid = opts.vapid ?? (opts.configDir ? vapidKeys(opts.configDir) : generateVapidKeys());
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? Date.now;
  }

  publicKey(): string {
    return this.vapid.publicKey;
  }

  async subscribe(sub: PushSubscription): Promise<void> {
    this.registry.addPushSubscription(sub);
  }

  async unsubscribe(endpoint: string): Promise<void> {
    this.registry.removePushSubscription(endpoint);
  }

  async send(notification: NotificationPayload): Promise<void> {
    const subs = this.registry.pushSubscriptions();
    await Promise.allSettled(subs.map((sub) => this.sendToSubscription(sub, notification)));
  }

  private async sendToSubscription(sub: PushSubscription, notification: NotificationPayload): Promise<void> {
    const authHeader = createVapidAuthHeader(sub.endpoint, this.vapid, this.now());
    let body: string | Uint8Array;
    let headers: Record<string, string> = {
      authorization: authHeader,
      ttl: "86400",
    };

    if (sub.keys?.p256dh && sub.keys?.auth) {
      const encrypted = encryptPayload(notification, sub.keys);
      body = new Uint8Array(encrypted.body);
      headers = { ...headers, ...encrypted.headers };
    } else {
      body = JSON.stringify(notification);
      headers["content-type"] = "application/json";
    }

    try {
      const res = await this.fetchImpl(sub.endpoint, {
        method: "POST",
        headers,
        signal: AbortSignal.timeout(5000),
        // biome-ignore lint/suspicious/noExplicitAny: BodyInit compatibility between Node and Bun types
        body: body as any,
      });

      if (res.status === 404 || res.status === 410) {
        this.registry.removePushSubscription(sub.endpoint);
      } else if (!res.ok) {
        console.warn(`[push] delivery failed (${res.status}) for ${sub.endpoint}`);
      }
    } catch (err) {
      console.warn(`[push] delivery error for ${sub.endpoint}:`, err);
    }
  }
}

export class FakePushService implements PushService {
  readonly sent: NotificationPayload[] = [];

  constructor(
    private readonly registry: Registry,
    public key = "fake-vapid-public-key",
  ) {}

  publicKey(): string {
    return this.key;
  }

  async subscribe(sub: PushSubscription): Promise<void> {
    this.registry.addPushSubscription(sub);
  }

  async unsubscribe(endpoint: string): Promise<void> {
    this.registry.removePushSubscription(endpoint);
  }

  async send(notification: NotificationPayload): Promise<void> {
    this.sent.push(notification);
  }
}
