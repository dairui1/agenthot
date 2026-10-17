import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";

export const DEFAULT_JOURNAL_DIR = path.resolve(import.meta.dirname, "../../.data/codex-receipts");
export const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
export const validDigest = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);

type RecordEntry = {
  version: 1; key: string; bodyHash: string; owner: string; createdAt: string;
  state: "reserved" | "unknown" | "completed";
  response?: Record<string, unknown>; responseHash?: string;
};
export type Reservation = { key: string; bodyHash: string; owner: string };
export class JournalBlocked extends Error {}

/** A reservation is durable before any CLI starts; an interrupted reservation never starts again. */
export class CompletionJournal {
  readonly directory: string;
  constructor(directory = DEFAULT_JOURNAL_DIR) { this.directory = directory; }

  private file(key: string) {
    if (!validDigest(key)) throw new JournalBlocked("Invalid request key");
    return path.join(this.directory, `${key}.json`);
  }

  private async syncDirectory(directory = this.directory) {
    const handle = await open(directory, "r");
    try { await handle.sync(); } finally { await handle.close(); }
  }

  private async read(key: string): Promise<RecordEntry> {
    const entry = JSON.parse(await readFile(this.file(key), "utf8")) as RecordEntry;
    if (entry.version !== 1 || entry.key !== key || !validDigest(entry.bodyHash)
      || typeof entry.owner !== "string" || !["reserved", "unknown", "completed"].includes(entry.state)) {
      throw new JournalBlocked("Unverifiable journal entry");
    }
    return entry;
  }

  async reserve(key: string, bodyHash: string): Promise<{ reservation: Reservation } | { response: Record<string, unknown> }> {
    if (!validDigest(bodyHash)) throw new JournalBlocked("Invalid body hash");
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await chmod(this.directory, 0o700);
    // Another process may have just created any ancestor without persisting its parent entry.
    // Every reservation waits for the full directory chain, not only directories mkdir created here.
    for (let directory = path.resolve(this.directory); ; directory = path.dirname(directory)) {
      await this.syncDirectory(directory);
      if (directory === path.dirname(directory)) break;
    }
    const entry: RecordEntry = { version: 1, key, bodyHash, owner: randomUUID(), createdAt: new Date().toISOString(), state: "reserved" };
    let handle;
    try { handle = await open(this.file(key), "wx", 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const saved = await this.read(key);
      if (saved.bodyHash !== bodyHash) throw new JournalBlocked("Request key body conflict");
      if (saved.state !== "completed") throw new JournalBlocked("Request outcome remains unknown");
      if (!saved.response || saved.responseHash !== digest(JSON.stringify(saved.response))) throw new JournalBlocked("Unverifiable completed response");
      return { response: saved.response };
    }
    try { await handle.writeFile(JSON.stringify(entry)); await handle.sync(); } finally { await handle.close(); }
    await this.syncDirectory();
    return { reservation: { key, bodyHash, owner: entry.owner } };
  }

  private async update(reservation: Reservation, response?: Record<string, unknown>) {
    const entry = await this.read(reservation.key);
    if (entry.owner !== reservation.owner || entry.bodyHash !== reservation.bodyHash) throw new JournalBlocked("Reservation changed");
    if (entry.state === "completed") return;
    const next: RecordEntry = response
      ? { ...entry, state: "completed", response, responseHash: digest(JSON.stringify(response)) }
      : { ...entry, state: "unknown" };
    const temporary = path.join(this.directory, `.${reservation.key}.${randomUUID()}.tmp`);
    try {
      const handle = await open(temporary, "wx", 0o600);
      try { await handle.writeFile(JSON.stringify(next)); await handle.sync(); } finally { await handle.close(); }
      await rename(temporary, this.file(reservation.key));
      await this.syncDirectory();
    } finally { await rm(temporary, { force: true }); }
  }

  complete(reservation: Reservation, response: Record<string, unknown>) { return this.update(reservation, response); }
  unknown(reservation: Reservation) { return this.update(reservation); }
}
