import { useCallback, useEffect, useState, type ReactNode } from "react";
import type { Session } from "@supabase/supabase-js";
import { Lock } from "lucide-react";
import { cloudEnabled, supabase } from "../cloud";
import { gateFor, idleExpired, markActive, mfaError, signOut } from "../security";
import { EnrollCode, VerifyCode } from "./TwoFactor";
import { ErrorBanner } from "./ui";

type State = "loading" | "out" | "enroll" | "verify" | "denied" | "in";

/**
 * In modalità online servono password + codice a 6 cifre (secondo fattore), poi il database conferma che
 * l'account è il proprietario. Dopo 30 minuti senza usare l'app si esce da soli.
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<State>(cloudEnabled ? "loading" : "in");
  const [err, setErr] = useState<string | null>(null);

  const check = useCallback(async (s: Session | null) => {
    try {
      const g = await gateFor(!!s);
      if (g !== "ok") return setState(g);
      const { data, error } = await supabase!.rpc("yrols_claim");
      if (!error && data === true) { markActive(); setState("in"); } else setState("denied");
    } catch (e) {
      setErr(mfaError(e as Error));
      setState("out");
    }
  }, []);

  useEffect(() => {
    if (!supabase) return;
    (async () => {
      // App riaperta dopo tanto tempo: la sessione salvata non basta, si rientra.
      if (idleExpired()) await signOut();
      const { data } = await supabase!.auth.getSession();
      check(data.session);
    })();
    const { data } = supabase.auth.onAuthStateChange((event, s) => {
      if (event === "SIGNED_IN" || event === "SIGNED_OUT" || event === "MFA_CHALLENGE_VERIFIED") setTimeout(() => check(s), 0);
    });
    return () => data.subscription.unsubscribe();
  }, [check]);

  useIdleLock(state === "in");

  if (state === "in") return <>{children}</>;
  const wrap = (c: ReactNode) => <div className="login-wrap">{c}</div>;
  if (state === "loading") return wrap(<div className="login-card">Caricamento…</div>);
  if (state === "enroll") return wrap(<EnrollCode first onDone={() => supabase!.auth.getSession().then(({ data }) => check(data.session))} onCancel={() => signOut()} />);
  if (state === "verify") return wrap(<VerifyCode onCancel={() => signOut()} />);
  if (state === "denied") {
    return wrap(
      <div className="login-card">
        <h1>Accesso non autorizzato</h1>
        <p className="sub">Questo account non è il proprietario del cruscotto.</p>
        <button className="btn" onClick={() => signOut()}>Esci</button>
      </div>,
    );
  }
  return wrap(<Login initialError={err} />);
}

/** Registra l'attività e chiude la sessione dopo il tempo di inattività (anche se l'app resta aperta). */
function useIdleLock(active: boolean) {
  useEffect(() => {
    if (!active) return;
    let last = 0;
    const touch = () => { const now = Date.now(); if (now - last > 15_000) { last = now; markActive(now); } };
    const verify = () => { if (idleExpired()) signOut(); };
    const onVisible = () => { if (document.visibilityState === "visible") verify(); else markActive(); };
    const events = ["pointerdown", "keydown", "scroll", "touchstart"] as const;
    events.forEach((e) => addEventListener(e, touch, { passive: true }));
    document.addEventListener("visibilitychange", onVisible);
    const t = setInterval(verify, 30_000);
    return () => {
      events.forEach((e) => removeEventListener(e, touch));
      document.removeEventListener("visibilitychange", onVisible);
      clearInterval(t);
    };
  }, [active]);
}

function Login({ initialError }: { initialError: string | null }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState<string | null>(initialError);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setErr(null);
    const { error } = await supabase!.auth.signInWithPassword({ email, password });
    if (error) {
      setErr(error.message === "Invalid login credentials" ? "Email o password errati"
        : /rate limit|too many/i.test(error.message) ? "Troppi tentativi: aspetta qualche minuto e riprova." : error.message);
    }
    setBusy(false);
  };

  // Niente "Crea account": il cruscotto ha un solo proprietario e le iscrizioni sono chiuse.
  return (
    <form className="login-card" onSubmit={submit}>
      <div className="brand"><span className="brand-mark" aria-hidden>Y</span><span>Yrols</span></div>
      <h1>Accedi</h1>
      <p className="sub">Il tuo cruscotto di casa</p>
      <ErrorBanner message={err} />
      <label className="field"><span>Email</span><input type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} /></label>
      <label className="field"><span>Password</span><input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} /></label>
      <button className="btn primary" disabled={busy}><Lock size={16} />Accedi</button>
    </form>
  );
}
