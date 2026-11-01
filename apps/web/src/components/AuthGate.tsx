import { useEffect, useState, type ReactNode } from "react";
import type { Session } from "@supabase/supabase-js";
import { Lock } from "lucide-react";
import { cloudEnabled, supabase } from "../cloud";
import { ErrorBanner } from "./ui";

type State = "loading" | "out" | "denied" | "in";

/** In modalità online richiede l'accesso; il primo account che entra diventa il proprietario del cruscotto. */
export function AuthGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<State>(cloudEnabled ? "loading" : "in");

  useEffect(() => {
    if (!supabase) return;
    const check = async (s: Session | null) => {
      if (!s) return setState("out");
      const { data, error } = await supabase!.rpc("yrols_claim");
      setState(!error && data === true ? "in" : "denied");
    };
    supabase.auth.getSession().then(({ data }) => check(data.session));
    const { data } = supabase.auth.onAuthStateChange((event, s) => {
      if (event === "SIGNED_IN" || event === "SIGNED_OUT") check(s);
    });
    return () => data.subscription.unsubscribe();
  }, []);

  if (state === "in") return <>{children}</>;
  if (state === "loading") return <div className="login-wrap"><div className="login-card">Caricamento…</div></div>;
  if (state === "denied") {
    return (
      <div className="login-wrap"><div className="login-card">
        <h1>Accesso non autorizzato</h1>
        <p className="sub">Questo account non è il proprietario del cruscotto.</p>
        <button className="btn" onClick={() => supabase!.auth.signOut()}>Esci</button>
      </div></div>
    );
  }
  return <Login />;
}

function Login() {
  const [mode, setMode] = useState<"in" | "up">("in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setErr(null); setInfo(null);
    if (mode === "in") {
      const { error } = await supabase!.auth.signInWithPassword({ email, password });
      if (error) setErr(error.message === "Invalid login credentials" ? "Email o password errati" : error.message);
    } else {
      const { data, error } = await supabase!.auth.signUp({ email, password, options: { emailRedirectTo: location.origin + import.meta.env.BASE_URL } });
      if (error) setErr(error.message);
      else if (!data.session) setInfo("Ti ho mandato un'email: apri il link di conferma, poi accedi da qui.");
    }
    setBusy(false);
  };

  return (
    <div className="login-wrap">
      <form className="login-card" onSubmit={submit}>
        <div className="brand"><span className="brand-mark" aria-hidden>Y</span><span>Yrols</span></div>
        <h1>{mode === "in" ? "Accedi" : "Crea il tuo account"}</h1>
        <p className="sub">{mode === "in" ? "Il tuo cruscotto di casa" : "Il primo account creato diventa l'unico proprietario"}</p>
        <ErrorBanner message={err} />
        {info && <div className="banner info">{info}</div>}
        <label className="field"><span>Email</span><input type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></label>
        <label className="field"><span>Password</span><input type="password" autoComplete={mode === "in" ? "current-password" : "new-password"} minLength={8} required value={password} onChange={(e) => setPassword(e.target.value)} /></label>
        <button className="btn primary" disabled={busy}><Lock size={16} />{mode === "in" ? "Accedi" : "Crea account"}</button>
        <button type="button" className="link-btn" onClick={() => setMode(mode === "in" ? "up" : "in")}>
          {mode === "in" ? "Prima volta? Crea l'account" : "Hai già un account? Accedi"}
        </button>
      </form>
    </div>
  );
}
