import { useEffect, useRef, useState } from "react";
import { KeyRound, ShieldCheck } from "lucide-react";
import { supabase } from "../cloud";
import { cleanCode, dropUnverified, mfaError } from "../security";
import { ErrorBanner } from "./ui";

function CodeInput({ value, onChange, autoFocus }: { value: string; onChange: (v: string) => void; autoFocus?: boolean }) {
  return (
    <label className="field">
      <span>Codice a 6 cifre</span>
      <input className="otp-input" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required
        autoFocus={autoFocus} value={value} onChange={(e) => onChange(cleanCode(e.target.value))} placeholder="123456" />
    </label>
  );
}

/** Inserimento del codice dopo la password. */
export function VerifyCode({ onCancel }: { onCancel: () => void }) {
  const [code, setCode] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setErr(null);
    const { data: f, error: fe } = await supabase!.auth.mfa.listFactors();
    const factor = f?.totp[0];
    if (fe || !factor) { setErr(mfaError(fe)); setBusy(false); return; }
    const { error } = await supabase!.auth.mfa.challengeAndVerify({ factorId: factor.id, code });
    if (error) { setErr(mfaError(error)); setCode(""); }
    setBusy(false);
  };

  return (
    <form className="login-card" onSubmit={submit}>
      <div className="brand"><span className="brand-mark" aria-hidden>Y</span><span>Yrols</span></div>
      <h1>Codice di sicurezza</h1>
      <p className="sub">Apri l'app di autenticazione sul telefono e scrivi il codice di Yrols.</p>
      <ErrorBanner message={err} />
      <CodeInput value={code} onChange={setCode} autoFocus />
      <button className="btn primary" disabled={busy || code.length !== 6}><ShieldCheck size={16} />Verifica</button>
      <button type="button" className="link-btn" onClick={onCancel}>Esci</button>
    </form>
  );
}

type Enrollment = { id: string; qr: string; secret: string; uri: string };

/**
 * Configurazione guidata del codice: QR da inquadrare (o link da toccare sul telefono), poi prova del primo codice.
 * Serve anche dalla pagina Sicurezza per aggiungere un secondo telefono di riserva.
 */
export function EnrollCode({ onDone, onCancel, first }: { onDone: () => void; onCancel: () => void; first?: boolean }) {
  const [enr, setEnr] = useState<Enrollment | null>(null);
  const [code, setCode] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    (async () => {
      await dropUnverified();
      const stamp = new Date().toLocaleString("it-IT", { dateStyle: "short", timeStyle: "short" });
      const { data, error } = await supabase!.auth.mfa.enroll({ factorType: "totp", issuer: "Yrols", friendlyName: `Telefono ${stamp}` });
      if (error || !data) return setErr(mfaError(error));
      setEnr({ id: data.id, qr: data.totp.qr_code, secret: data.totp.secret, uri: data.totp.uri });
    })();
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!enr) return;
    setBusy(true); setErr(null);
    const { error } = await supabase!.auth.mfa.challengeAndVerify({ factorId: enr.id, code });
    setBusy(false);
    if (error) { setErr(mfaError(error)); setCode(""); return; }
    onDone();
  };
  const cancel = async () => {
    if (enr) await supabase!.auth.mfa.unenroll({ factorId: enr.id }).catch(() => undefined);
    onCancel();
  };

  return (
    <form className="login-card wide" onSubmit={submit}>
      {first && <div className="brand"><span className="brand-mark" aria-hidden>Y</span><span>Yrols</span></div>}
      <h1>{first ? "Proteggi l'accesso" : "Aggiungi un dispositivo"}</h1>
      <p className="sub">
        {first
          ? "Da ora, oltre alla password, serve un codice a 6 cifre che cambia ogni 30 secondi. Chi ruba la password da sola non entra."
          : "Usa un secondo telefono o un'altra app: se perdi il primo, entri con questo."}
      </p>
      <ol className="steps">
        <li>Sul telefono apri un'app di autenticazione: <b>Password</b> di iPhone, Google Authenticator o Microsoft Authenticator.</li>
        <li>Inquadra il QR qui sotto. Se stai già usando il telefono, tocca <b>Aggiungi all'app</b>.</li>
        <li>Scrivi il codice a 6 cifre che compare per Yrols.</li>
      </ol>
      <ErrorBanner message={err} />
      {enr ? (
        <>
          <img className="otp-qr" src={enr.qr} alt="Codice QR per l'app di autenticazione" width={180} height={180} />
          <a className="btn" href={enr.uri}><KeyRound size={16} />Aggiungi all'app</a>
          <details className="otp-secret">
            <summary>Non riesci a inquadrare? Inserisci la chiave a mano</summary>
            <code>{enr.secret.replace(/(.{4})/g, "$1 ").trim()}</code>
          </details>
          <CodeInput value={code} onChange={setCode} />
          <button className="btn primary" disabled={busy || code.length !== 6}><ShieldCheck size={16} />Attiva</button>
        </>
      ) : !err && <p className="sub">Preparo il codice QR…</p>}
      <button type="button" className="link-btn" onClick={cancel}>{first ? "Esci" : "Annulla"}</button>
    </form>
  );
}
