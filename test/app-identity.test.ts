/**
 * The App's half of authentication.
 *
 * Three things here are security-relevant rather than merely correct: the JWT is
 * backdated (GitHub rejects one issued in its future, and a fast server would
 * fail every request with what looks like a bad key), tokens are cached but
 * renewed before expiry, and a webhook signature is compared in constant time.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac, createVerify, generateKeyPairSync } from "node:crypto";
import { InstallationTokens, appJwt, verifySignature, type Fetch } from "../src/app/identity.js";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const creds = {
  appId: "12345",
  privateKey: privateKey.export({ type: "pkcs1", format: "pem" }).toString(),
};

const decode = (part: string): Record<string, unknown> =>
  JSON.parse(Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString());

/** The digest GitHub sends, computed independently of the implementation. */
const digest = (secret: string, body: string): string =>
  createHmac("sha256", secret).update(body).digest("hex");

test("app jwt: signed by the private key, backdated, and inside GitHub's 10-minute limit", () => {
  const now = 1_700_000_000_000;
  const [header, payload, signature] = appJwt(creds, now).split(".");

  assert.deepEqual(decode(header), { alg: "RS256", typ: "JWT" });
  const claims = decode(payload) as { iat: number; exp: number; iss: string };
  assert.equal(claims.iss, "12345");
  assert.equal(claims.iat, now / 1000 - 60, "backdated a minute against clock skew");
  assert.ok(claims.exp - claims.iat <= 600, "GitHub rejects a JWT valid for more than ten minutes");

  const verifier = createVerify("RSA-SHA256");
  verifier.update(`${header}.${payload}`);
  assert.ok(
    verifier.verify(publicKey, Buffer.from(signature.replace(/-/g, "+").replace(/_/g, "/"), "base64")),
    "the signature must verify against the app's public key",
  );
});

function fakeFetch(responses: Array<{ ok: boolean; status: number; body: string }>): { fetch: Fetch; calls: string[] } {
  const calls: string[] = [];
  const fetch: Fetch = async (url) => {
    calls.push(url);
    const next = responses.shift();
    if (!next) throw new Error("unexpected extra fetch");
    return { ok: next.ok, status: next.status, text: async () => next.body };
  };
  return { fetch, calls };
}

test("installation tokens: fetched once, reused, and renewed before they expire", async () => {
  let now = 1_700_000_000_000;
  const { fetch, calls } = fakeFetch([
    { ok: true, status: 201, body: JSON.stringify({ token: "ghs_first", expires_at: new Date(now + 3_600_000).toISOString() }) },
    { ok: true, status: 201, body: JSON.stringify({ token: "ghs_second", expires_at: new Date(now + 7_200_000).toISOString() }) },
  ]);
  const tokens = new InstallationTokens(creds, fetch, () => now);

  assert.equal(await tokens.get(42), "ghs_first");
  assert.equal(await tokens.get(42), "ghs_first", "a second call must not spend a round trip");
  assert.equal(calls.length, 1);
  assert.match(calls[0], /\/app\/installations\/42\/access_tokens$/);

  // Inside the renewal margin the cached token is technically still valid, and
  // using it would hand GitHub one that expires mid-review.
  now += 3_600_000 - 30_000;
  assert.equal(await tokens.get(42), "ghs_second");
  assert.equal(calls.length, 2);
});

test("installation tokens: a rejected key reports GitHub's reason, not just 401", async () => {
  const { fetch } = fakeFetch([{ ok: false, status: 401, body: '{"message":"integration not found"}' }]);
  const tokens = new InstallationTokens(creds, fetch);

  await assert.rejects(() => tokens.get(7), /401.*integration not found/s);
});

test("webhook signature: a forgery, a missing header and a wrong length are all rejected", () => {
  const secret = "s3cret";
  const body = '{"action":"opened"}';

  assert.ok(verifySignature(secret, body, `sha256=${digest(secret, body)}`), "the real digest passes");
  assert.ok(!verifySignature(secret, body, undefined), "a missing header is not a pass");
  // Length is checked before the comparison: timingSafeEqual THROWS on a length
  // mismatch, so a short digest would crash the endpoint rather than reject.
  assert.ok(!verifySignature(secret, body, "sha256=deadbeef"), "a short digest must reject, not throw");
  assert.ok(!verifySignature("other-secret", body, `sha256=${digest(secret, body)}`), "another secret's digest");
  assert.ok(
    !verifySignature(secret, '{"action":"closed"}', `sha256=${digest(secret, body)}`),
    "the signature must cover the body that was delivered",
  );
});
