import { useCallback, useEffect, useState } from "react";
import type { Factor } from "@supabase/supabase-js";
import { KeyRound, LogOut, Plus, ShieldCheck, Smartphone, Trash2 } from "lucide-react";
import { supabase } from "../cloud";
import { IDLE_MINUTES, mfaError, signOut } from "../security";
import { EnrollCode } from "../components/TwoFactor";
import { Card, ErrorBanner, Modal } from "../components/ui";

const fmt = (d: string) => new Date(d).toLocaleDateString("it-IT", { day: "numeric", month: "long", year: "numeric" });

/** Pagina Sicurezza: dispositivi con il codice, cambio password, uscita da tutti i dispositivi. */
export function SecurityPage() {
  const [factors, setFactors] = useState<Factor[]>([]);
  const [email, setEmail] = useState<string>("");
  const [adding, setAdding] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { data, error } = await supabase!.auth.mfa.listFactors();
    if (error) return setErr(mfaError(error));
    setFactors(data.totp);
    const { data: u } = await supabase!.auth.getUser();
    setEmail(u.user?.email ?? "");
  }, []);
  useEffect(() => { load(); }, [load]);

  const remove = async (f: Factor) => {
    if (factors.length < 2) return;
    if (!confirm(`Togliere "${f.friendly_name ?? "dispositivo"}"? Da lì non potrai più generare il codice.`)) return;
    const { error } = await supabase!.auth.mfa.unenroll({ factorId: f.id });
    if (error) setErr(mfaError(error)); else { setInfo("Dispositivo tolto."); load(); }
  };

  const everywhere = async () => {
    if (!confirm("Esco da Yrols su tutti i dispositivi (questo compreso)?")) return;
    await signOut("global");
  };

  return (
    <div className="page">
      <header className="page-head">
        <div><h1>Sicurezza</h1><p className="sub">Come è protetto l'accesso al cruscotto</p></div>
      </header>
      <ErrorBanner message={err} />
      {info && <div className="banner info">{info}</div>}

      <Card title="Come entri">
        <ul className="security-list">
          <li><ShieldCheck size={16} aria-hidden /><span>Password <b>e</b> codice a 6 cifre dall'app di autenticazione: la sola password non basta.</span></li>
          <li><ShieldCheck size={16} aria-hidden /><span>Un solo proprietario ({email || "il tuo account"}): non si possono creare altri account.</span></li>
          <li><ShieldCheck size={16} aria-hidden /><span>Dopo {IDLE_MINUTES} minuti senza usare l'app esci da solo.</span></li>
          <li><ShieldCheck size={16} aria-hidden /><span>I dati sono protetti nel database: senza codice non si legge nulla, nemmeno chiamando Supabase direttamente.</span></li>
        </ul>
      </Card>

      <Card title="Dispositivi con il codice" action={<button className="btn" onClick={() => setAdding(true)}><Plus size={16} />Aggiungi</button>}>
        {factors.length < 2 && (
          <div className="banner warn">Consiglio: aggiungi un secondo dispositivo (per esempio il computer o un altro telefono). Se perdi il telefono, entri con quello.</div>
        )}
        <ul className="list">
          {factors.map((f) => (
            <li key={f.id} className="row">
              <span className="row-icon"><Smartphone size={16} aria-hidden /></span>
              <span className="row-main"><span className="row-title">{f.friendly_name ?? "Dispositivo"}</span><span className="row-sub">Aggiunto il {fmt(f.created_at)}</span></span>
              {factors.length > 1 && <button className="icon-btn" onClick={() => remove(f)} aria-label="Togli dispositivo"><Trash2 size={16} /></button>}
            </li>
          ))}
        </ul>
      </Card>

      <ChangePassword />

      <Card title="Esci ovunque">
        <p className="sub">Se hai perso un telefono o temi che qualcuno sia entrato, chiudi tutte le sessioni aperte. Poi cambia la password.</p>
        <button className="btn danger" onClick={everywhere}><LogOut size={16} />Esci da tutti i dispositivi</button>
      </Card>

      {adding && (
        <Modal title="Aggiungi un dispositivo" onClose={() => setAdding(false)}>
          <EnrollCode onDone={() => { setAdding(false); setInfo("Dispositivo aggiunto."); load(); }} onCancel={() => setAdding(false)} />
        </Modal>
      )}
    </div>
  );
}

function ChangePassword() {
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState(false);
  const [busy, setBusy] = useState(false);
  const weak = pw.length > 0 && (pw.length < 12 || !/[a-z]/i.test(pw) || !/\d/.test(pw));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(null); setOk(false);
    if (weak) return setErr("Usa almeno 12 caratteri, con lettere e numeri.");
    if (pw !== pw2) return setErr("Le due password non coincidono.");
    setBusy(true);
    const { error } = await supabase!.auth.updateUser({ password: pw });
    setBusy(false);
    if (error) {
      setErr(/same/i.test(error.message) ? "È uguale a quella attuale." : /weak|short|characters/i.test(error.message) ? "Password troppo debole." : mfaError(error));
      return;
    }
    setPw(""); setPw2(""); setOk(true);
  };

  return (
    <Card title="Cambia password">
      <form className="stack" onSubmit={submit}>
        <ErrorBanner message={err} />
        {ok && <div className="banner info">Password cambiata.</div>}
        <label className="field"><span>Nuova password</span><input type="password" autoComplete="new-password" required minLength={12} value={pw} onChange={(e) => setPw(e.target.value)} /></label>
        <label className="field"><span>Ripeti la nuova password</span><input type="password" autoComplete="new-password" required value={pw2} onChange={(e) => setPw2(e.target.value)} /></label>
        {weak && <p className="sub">Almeno 12 caratteri, con lettere e numeri. Meglio ancora una frase lunga.</p>}
        <button className="btn primary" disabled={busy}><KeyRound size={16} />Cambia password</button>
      </form>
    </Card>
  );
}
