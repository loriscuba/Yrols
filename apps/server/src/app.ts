import express, { type NextFunction, type Request, type Response } from "express";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { timingSafeEqual } from "node:crypto";
import type { DB } from "./db.ts";
import { banksRouter } from "./banks.ts";
import { householdRouter, matchBillsWithTransactions, BadInput } from "./household.ts";
import { overview } from "./overview.ts";
import { emailRouter, type ImapConfig } from "./email.ts";

export interface AppOptions {
  ingestToken?: string;
  basicAuth?: { user: string; password: string };
  imap?: ImapConfig | null;
  webDist?: string;
}

const eq = (a: string, b: string) => {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

export function createApp(db: DB, opts: AppOptions = {}) {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "10mb" }));

  // L'endpoint di sync ha il suo token: la Basic auth protegge tutto il resto.
  if (opts.basicAuth) {
    const { user, password } = opts.basicAuth;
    app.use((req, res, next) => {
      if (req.path === "/api/banks/sync" || req.path === "/api/health") return next();
      const [scheme, value] = (req.headers.authorization ?? "").split(" ");
      if (scheme === "Basic" && value) {
        const [u, ...p] = Buffer.from(value, "base64").toString().split(":");
        if (eq(u, user) && eq(p.join(":"), password)) return next();
      }
      res.set("WWW-Authenticate", `Basic realm="Yrols"`).status(401).json({ error: "autenticazione richiesta" });
    });
  }

  app.get("/api/health", (_req, res) => { res.json({ ok: true }); });
  app.use("/api/banks", banksRouter(db, opts.ingestToken, () => matchBillsWithTransactions(db)));
  app.use("/api", householdRouter(db));
  app.use("/api/email", emailRouter(db, opts.imap ?? null));
  app.get("/api/overview", (_req, res) => { res.json(overview(db)); });
  app.use("/api", (_req, res) => { res.status(404).json({ error: "endpoint inesistente" }); });

  if (opts.webDist && existsSync(opts.webDist)) {
    const dist = resolve(opts.webDist);
    app.use(express.static(dist));
    app.get("*", (_req, res) => res.sendFile(resolve(dist, "index.html")));
  }

  app.use((err: Error & { type?: string }, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof BadInput) return res.status(400).json({ error: err.message });
    if (err.type === "entity.parse.failed") return res.status(400).json({ error: "JSON non valido" });
    console.error(err);
    res.status(500).json({ error: "errore interno" });
  });

  return app;
}
