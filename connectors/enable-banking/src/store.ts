import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Account, Connection } from "./types.js";

export interface PendingAuth {
  state: string;
  bankName: string;
  country: string;
  createdAt: string;
}

export interface StoredConnection extends Connection {
  accounts: Account[];
  createdAt: string;
}

export interface StoreData {
  pending: PendingAuth[];
  connections: StoredConnection[];
  lastSyncAt?: string;
}

/** Persistenza delle sessioni Enable Banking. Sostituibile (es. DB del cruscotto). */
export interface ConnectorStore {
  load(): Promise<StoreData>;
  save(data: StoreData): Promise<void>;
}

export class MemoryStore implements ConnectorStore {
  private data: StoreData = { pending: [], connections: [] };
  async load() {
    return structuredClone(this.data);
  }
  async save(data: StoreData) {
    this.data = structuredClone(data);
  }
}

/** File JSON locale, scritto in modo atomico. Contiene solo id di sessione e conti, nessuna credenziale bancaria. */
export class FileStore implements ConnectorStore {
  constructor(private readonly path: string) {}

  async load(): Promise<StoreData> {
    try {
      const data = JSON.parse(await readFile(this.path, "utf8")) as Partial<StoreData>;
      return { pending: data.pending ?? [], connections: data.connections ?? [], lastSyncAt: data.lastSyncAt };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return { pending: [], connections: [] };
      throw err;
    }
  }

  async save(data: StoreData): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    await writeFile(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    await rename(tmp, this.path);
  }
}

/**
 * Stato letto da una stringa JSON (es. secret EB_STATE in GitHub Actions).
 * Le modifiche restano in memoria per la durata del processo: per rinnovare un
 * consenso si collega la banca in locale e si aggiorna il secret con `cli state`.
 */
export class JsonStateStore implements ConnectorStore {
  private data: StoreData;
  constructor(json: string) {
    const parsed = JSON.parse(json) as Partial<StoreData>;
    this.data = { pending: [], connections: parsed.connections ?? [], lastSyncAt: parsed.lastSyncAt };
  }
  async load() {
    return structuredClone(this.data);
  }
  async save(data: StoreData) {
    this.data = structuredClone(data);
  }
}

/** Versione esportabile dello stato: solo le connessioni, senza consensi in sospeso. */
export function exportState(data: StoreData): string {
  return JSON.stringify({ connections: data.connections });
}
