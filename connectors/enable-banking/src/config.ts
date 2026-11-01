import { readFileSync } from "node:fs";
import type { PushOptions } from "./push.js";

export interface ConnectorConfig {
  applicationId: string;
  privateKey: string;
  baseUrl: string;
  redirectUrl: string;
  consentDays: number;
  initialHistoryDays: number;
  host: string;
  port: number;
  dataFile: string;
  apiToken?: string;
  corsOrigin?: string;
  dashboardUrl?: string;
  push?: PushOptions;
  /** 0 = disattivata. Default 360 (4 volte al giorno, limite PSD2 per accessi non presidiati). */
  syncIntervalMinutes: number;
}

const num = (v: string | undefined, def: number) => (v && Number.isFinite(Number(v)) ? Number(v) : def);

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ConnectorConfig {
  const applicationId = env.ENABLE_BANKING_APP_ID ?? "";
  let privateKey = env.ENABLE_BANKING_PRIVATE_KEY ?? "";
  if (!privateKey && env.ENABLE_BANKING_PRIVATE_KEY_PATH) {
    privateKey = readFileSync(env.ENABLE_BANKING_PRIVATE_KEY_PATH, "utf8");
  }
  const missing = [
    !applicationId && "ENABLE_BANKING_APP_ID",
    !privateKey && "ENABLE_BANKING_PRIVATE_KEY_PATH (o ENABLE_BANKING_PRIVATE_KEY)",
  ].filter(Boolean);
  if (missing.length) {
    throw new Error(`Configurazione mancante: ${missing.join(", ")}. Copia .env.example in .env e compilalo.`);
  }
  const port = num(env.PORT, 8787);
  const yrolsUrl = env.YROLS_URL;
  const ingestToken = env.YROLS_INGEST_TOKEN;
  return {
    applicationId,
    privateKey,
    baseUrl: env.ENABLE_BANKING_BASE_URL || "https://api.enablebanking.com",
    redirectUrl: env.ENABLE_BANKING_REDIRECT_URL || `http://localhost:${port}/api/banks/callback`,
    consentDays: num(env.ENABLE_BANKING_CONSENT_DAYS, 90),
    initialHistoryDays: num(env.INITIAL_HISTORY_DAYS, 90),
    host: env.HOST || "127.0.0.1",
    port,
    dataFile: env.DATA_FILE || "./data/enable-banking.json",
    apiToken: env.CONNECTOR_API_TOKEN || undefined,
    corsOrigin: env.CORS_ORIGIN || undefined,
    dashboardUrl: env.DASHBOARD_URL || undefined,
    push: yrolsUrl && ingestToken ? { yrolsUrl, ingestToken } : undefined,
    syncIntervalMinutes: num(env.SYNC_INTERVAL_MINUTES, 360),
  };
}
