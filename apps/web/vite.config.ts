import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

/**
 * Regole di sicurezza della pagina (Content-Security-Policy), solo nella versione pubblicata.
 * GitHub Pages non permette intestazioni HTTP, quindi vanno in un <meta>: il browser esegue solo gli script
 * del sito e parla solo con Supabase. Così uno script iniettato non può spedire altrove la sessione.
 */
export function csp(supabaseUrl: string | undefined): string {
  const sb = supabaseUrl ? new URL(supabaseUrl).origin : "";
  const ws = sb.replace(/^http/, "ws");
  return [
    "default-src 'self'",
    "script-src 'self' 'wasm-unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    `connect-src 'self' ${sb} ${ws}`.trim(),
    "worker-src 'self' blob:",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join("; ");
}

function securityMeta(supabaseUrl: string | undefined): Plugin {
  return {
    name: "yrols-security-meta",
    apply: "build",
    transformIndexHtml: () => [
      { tag: "meta", attrs: { "http-equiv": "Content-Security-Policy", content: csp(supabaseUrl) }, injectTo: "head-prepend" },
      { tag: "meta", attrs: { name: "referrer", content: "strict-origin-when-cross-origin" }, injectTo: "head-prepend" },
    ],
  };
}

export default defineConfig(({ mode }) => {
  const env = { ...loadEnv(mode, process.cwd(), "VITE_"), ...process.env };
  return {
    plugins: [react(), securityMeta(env.VITE_SUPABASE_URL)],
    base: process.env.VITE_BASE ?? "/",
    server: { port: 5173, proxy: { "/api": "http://localhost:3001" } },
  };
});
