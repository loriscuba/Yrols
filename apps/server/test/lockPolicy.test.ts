import { test } from "node:test";
import assert from "node:assert/strict";
import { onResume, TRUST_MS } from "../../web/src/lockPolicy.ts";

const now = Date.UTC(2026, 10, 21, 18, 0);
const min = 60_000;

test("dispositivo non ricordato: esce dopo 30 minuti di inattività", () => {
  const dev = { trustedUntil: null, quickUnlock: false };
  assert.equal(onResume(now, now - 10 * min, dev), "continue");
  assert.equal(onResume(now, now - 31 * min, dev), "signout");
  assert.equal(onResume(now, null, dev), "continue");
});

test("dispositivo ricordato: resta dentro anche dopo giorni, fino alla scadenza", () => {
  const dev = { trustedUntil: now + TRUST_MS / 2, quickUnlock: false };
  assert.equal(onResume(now, now - 3 * 86_400_000, dev), "continue");
  assert.equal(onResume(now, now - min, { ...dev, trustedUntil: now - 1 }), "signout");
});

test("dispositivo ricordato con sblocco rapido: chiede viso/impronta solo dopo la pausa", () => {
  const dev = { trustedUntil: now + TRUST_MS, quickUnlock: true };
  assert.equal(onResume(now, now - 5 * min, dev), "continue");
  assert.equal(onResume(now, now - 2 * 3_600_000, dev), "unlock");
});
