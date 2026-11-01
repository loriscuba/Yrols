import { test } from "node:test";
import assert from "node:assert/strict";
import { verify } from "node:crypto";
import { createJwt, MAX_JWT_TTL_SECONDS } from "../src/jwt.js";
import { privateKey, publicKey } from "./helpers.js";

test("JWT RS256 con kid = application id e claims Enable Banking", () => {
  const now = Date.UTC(2026, 10, 1);
  const { token, expiresAt } = createJwt("app-123", privateKey, 3600, now);
  const [h, p, s] = token.split(".");
  const header = JSON.parse(Buffer.from(h!, "base64url").toString());
  const payload = JSON.parse(Buffer.from(p!, "base64url").toString());
  assert.deepEqual(header, { typ: "JWT", alg: "RS256", kid: "app-123" });
  assert.equal(payload.iss, "enablebanking.com");
  assert.equal(payload.aud, "api.enablebanking.com");
  assert.equal(payload.exp - payload.iat, 3600);
  assert.equal(expiresAt, payload.exp * 1000);
  assert.ok(verify("RSA-SHA256", Buffer.from(`${h}.${p}`), publicKey, Buffer.from(s!, "base64url")));
});

test("durata JWT limitata a 24 ore", () => {
  const { token } = createJwt("app", privateKey, 10 * 86400);
  const payload = JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString());
  assert.equal(payload.exp - payload.iat, MAX_JWT_TTL_SECONDS);
});
