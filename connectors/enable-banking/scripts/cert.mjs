// Genera un certificato self-signed per https://localhost in keys/ (richiede openssl).
// In alternativa usa mkcert: mkcert -key-file keys/localhost-key.pem -cert-file keys/localhost-cert.pem localhost
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";

mkdirSync("keys", { recursive: true });
if (existsSync("keys/localhost-cert.pem")) {
  console.log("keys/localhost-cert.pem esiste già, non lo sovrascrivo.");
  process.exit(0);
}
try {
  execFileSync(
    "openssl",
    ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-sha256", "-days", "825",
     "-keyout", "keys/localhost-key.pem", "-out", "keys/localhost-cert.pem",
     "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1"],
    { stdio: "inherit" },
  );
  console.log("Creati keys/localhost-cert.pem e keys/localhost-key.pem");
} catch {
  console.error("openssl non trovato. Installa mkcert oppure usa il comando 'callback' della CLI (vedi README).");
  process.exit(1);
}
