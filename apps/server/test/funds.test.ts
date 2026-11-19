import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ftUrl, mergeNavs, parseFamNav, parseFtNav } from "../src/funds.ts";

const fixture = (f: string) => readFileSync(new URL(`./fixtures/${f}`, import.meta.url), "utf8");
const ISIN = "IE00BFXY6B66"; // Fidelity Focus Equity FAM Fund, dato pubblico

test("NAV dalla pagina di Fineco Asset Management", () => {
  assert.deepEqual(parseFamNav(fixture("fam-nav.html"), ISIN), { isin: ISIN, date: "2026-11-17", nav: 193.824, source: "fam" });
  assert.equal(parseFamNav(fixture("fam-nav.html"), "IE0000000001"), null, "ISIN diverso: pagina sbagliata");
  assert.equal(parseFamNav("<html>Pagina cambiata</html>", ISIN), null);
});

test("NAV dalla scheda FT Markets", () => {
  assert.deepEqual(parseFtNav(fixture("ft-nav.html"), ISIN), { isin: ISIN, date: "2026-11-18", nav: 193.55, source: "ft" });
  assert.equal(parseFtNav("<p>Price (EUR)</p>", ISIN), null);
  assert.equal(ftUrl(ISIN), "https://markets.ft.com/data/funds/tearsheet/summary?s=IE00BFXY6B66:EUR");
});

test("un NAV per data, il gestore vince a parità", () => {
  const out = mergeNavs([
    { isin: ISIN, date: "2026-11-18", nav: 193.55, source: "ft" },
    { isin: ISIN, date: "2026-11-17", nav: 193.82, source: "ft" },
    { isin: ISIN, date: "2026-11-17", nav: 193.824, source: "fam" },
    null,
  ]);
  assert.deepEqual(out.map((n) => [n.date, n.nav]), [["2026-11-17", 193.824], ["2026-11-18", 193.55]]);
});
