import type { CSSProperties } from "react";
import { Landmark } from "lucide-react";

/**
 * Colori di marca delle banche, presi dalle app ufficiali:
 * - Fineco: blu istituzionale #00539F con la "F" gialla del marchio.
 * - Revolut: Deep Blue #1326FD e Light Blue #C6D9FD (linee guida Open Banking di Revolut),
 *   su fondo scuro come l'icona dell'app.
 * Le altre banche ricevono un colore neutro.
 */
export interface BankBrand { key: string; color: string; ink: string; badge: string; mark: string }

const BRANDS: (BankBrand & { match: RegExp })[] = [
  { key: "fineco", match: /fineco/i, color: "#00539F", ink: "#FFC20E", badge: "#00539F", mark: "F" },
  { key: "revolut", match: /revolut/i, color: "#1326FD", ink: "#FFFFFF", badge: "#191C1F", mark: "R" },
];

export function bankBrand(name: string | null | undefined): BankBrand | null {
  if (!name) return null;
  const b = BRANDS.find((x) => x.match.test(name));
  return b ? { key: b.key, color: b.color, ink: b.ink, badge: b.badge, mark: b.mark } : null;
}

/** Variabili CSS da mettere su un elemento per colorarlo con la banca (vedi .bank-tinted in styles.css). */
export function bankStyle(name: string | null | undefined): CSSProperties | undefined {
  const b = bankBrand(name);
  return b ? ({ "--bank": b.color, "--bank-ink": b.ink, "--bank-badge": b.badge } as CSSProperties) : undefined;
}

/** Piccolo marchio quadrato con l'iniziale della banca nei suoi colori. */
export function BankBadge({ name, size = 32 }: { name: string | null | undefined; size?: number }) {
  const b = bankBrand(name);
  const style = { width: size, height: size, fontSize: Math.round(size * 0.5), borderRadius: Math.round(size * 0.28) } as CSSProperties;
  if (!b) {
    return <span className="bank-badge generic" style={style} aria-hidden><Landmark size={Math.round(size * 0.5)} /></span>;
  }
  return (
    <span className={`bank-badge ${b.key}`} style={{ ...style, background: b.badge, color: b.ink }} aria-hidden>
      {b.mark}
      {b.key === "revolut" && <span className="bank-badge-dot" style={{ background: b.color }} />}
    </span>
  );
}

/** Pallino colorato della banca, per elenchi compatti. */
export function BankDot({ name }: { name: string | null | undefined }) {
  const b = bankBrand(name);
  return <span className="bank-dot" style={{ background: b?.color ?? "var(--text-muted)" }} aria-hidden />;
}
