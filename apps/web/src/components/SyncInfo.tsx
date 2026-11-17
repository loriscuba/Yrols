import { Clock } from "lucide-react";
import { useData } from "../hooks";
import { nextAutoSync, whenAt } from "../format";

export type LastSync = { receivedAt: string; source: string } | null;

/** Data e ora dell'ultimo aggiornamento delle banche e del prossimo automatico. */
export function SyncInfo({ last, compact }: { last: LastSync | undefined; compact?: boolean }) {
  if (!last) return null;
  const how = last.source === "app" ? "dall'app" : "automatico";
  const next = nextAutoSync().toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" });
  if (compact) return <>Aggiornato {whenAt(last.receivedAt)}</>;
  return (
    <span className="sync-info" title={new Date(last.receivedAt).toLocaleString("it-IT")}>
      <Clock size={14} aria-hidden />
      <span>Ultimo aggiornamento <strong>{whenAt(last.receivedAt)}</strong> ({how}) · prossimo automatico verso le {next}</span>
    </span>
  );
}

export const useLastSync = () => useData<LastSync>("/banks/last-sync");
