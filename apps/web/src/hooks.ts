import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import { DATA_CHANGED } from "./bankRefresh";

export function useData<T>(path: string) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const reload = useCallback(() => {
    setLoading(true);
    return api.get<T>(path).then(
      (d) => { setData(d); setError(null); },
      (e: Error) => setError(e.message),
    ).finally(() => setLoading(false));
  }, [path]);
  useEffect(() => { reload(); }, [reload]);
  // Dopo un aggiornamento dei movimenti ricarica in silenzio (senza stato di caricamento).
  useEffect(() => {
    const quiet = () => { api.get<T>(path).then((d) => { setData(d); setError(null); }, () => { /* resta il dato precedente */ }); };
    addEventListener(DATA_CHANGED, quiet);
    return () => removeEventListener(DATA_CHANGED, quiet);
  }, [path]);
  return { data, error, loading, reload, setData };
}
