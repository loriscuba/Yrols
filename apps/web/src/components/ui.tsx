import { useEffect, useRef, type ReactNode } from "react";
import { AlertTriangle, CheckCircle2, Clock, X, AlertOctagon } from "lucide-react";
import { daysUntil, relDays } from "../format";

export function Card({ title, action, children, className = "" }: { title?: ReactNode; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`card ${className}`}>
      {(title || action) && (
        <header className="card-head">
          {title && <h2>{title}</h2>}
          {action}
        </header>
      )}
      {children}
    </section>
  );
}

export function Stat({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: ReactNode; tone?: "critical" | "good" }) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className={`stat-value ${tone ? "tone-" + tone : ""}`}>{value}</div>
      {hint && <div className="stat-hint">{hint}</div>}
    </div>
  );
}

/** Stato di una data di scadenza: sempre icona + testo, mai solo colore. */
export function DueBadge({ date, done }: { date: string; done?: boolean }) {
  if (done) return <span className="badge good"><CheckCircle2 size={14} aria-hidden />Fatto</span>;
  const n = daysUntil(date);
  if (n < 0) return <span className="badge critical"><AlertOctagon size={14} aria-hidden />Scaduta {relDays(date)}</span>;
  if (n <= 7) return <span className="badge warning"><AlertTriangle size={14} aria-hidden />{relDays(date)[0].toUpperCase() + relDays(date).slice(1)}</span>;
  return <span className="badge neutral"><Clock size={14} aria-hidden />{relDays(date)[0].toUpperCase() + relDays(date).slice(1)}</span>;
}

export function Empty({ icon, title, children }: { icon: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <div className="empty-icon">{icon}</div>
      <div className="empty-title">{title}</div>
      {children && <div className="empty-body">{children}</div>}
    </div>
  );
}

export function ErrorBanner({ message }: { message: string | null }) {
  if (!message) return null;
  return <div className="banner critical" role="alert"><AlertOctagon size={16} aria-hidden />{message}</div>;
}

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current!;
    d.showModal();
    return () => d.close();
  }, []);
  return (
    <dialog ref={ref} className="modal" onCancel={(e) => { e.preventDefault(); onClose(); }}
      onClick={(e) => { if (e.target === ref.current) onClose(); }}>
      <div className="modal-inner">
        <header className="modal-head">
          <h2>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Chiudi"><X size={18} /></button>
        </header>
        {children}
      </div>
    </dialog>
  );
}

export function Field({ label, children, wide }: { label: string; children: ReactNode; wide?: boolean }) {
  return <label className={`field ${wide ? "wide" : ""}`}><span>{label}</span>{children}</label>;
}

export function Segmented<T extends string>({ value, options, onChange }: { value: T; options: [T, string][]; onChange: (v: T) => void }) {
  return (
    <div className="segmented" role="tablist">
      {options.map(([v, l]) => (
        <button key={v} role="tab" aria-selected={v === value} className={v === value ? "on" : ""} onClick={() => onChange(v)}>{l}</button>
      ))}
    </div>
  );
}
