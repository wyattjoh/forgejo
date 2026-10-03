import { Database } from "bun:sqlite";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

export const hash = (value: string) => createHash("sha256").update(value).digest("hex");
export const randomToken = () => randomBytes(32).toString("base64url");

/** All OAuth state is encrypted, including pending login details and upstream credentials. */
export class OAuthStore {
  private readonly db: Database;
  private readonly key: Buffer;
  constructor(path: string, encryptionKey: string) {
    this.key = Buffer.from(encryptionKey, "base64");
    if (this.key.length !== 32)
      throw new Error("MCP_ENCRYPTION_KEY must encode exactly 32 bytes in base64");
    this.db = new Database(path, { create: true, strict: true });
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS oauth_state (kind TEXT NOT NULL, id TEXT NOT NULL, value TEXT NOT NULL, expires INTEGER NOT NULL, PRIMARY KEY(kind, id))",
    );
    // Fail early on a lost/changed encryption key, before issuing new state into the same database.
    try {
      const marker = this.get<{ ok: boolean }>("metadata", "key-check");
      if (!marker) this.put("metadata", "key-check", { ok: true }, Number.MAX_SAFE_INTEGER);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }
  put(kind: string, id: string, value: unknown, expires: number): void {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(Buffer.from(`${kind}:${id}`));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
    const encrypted = Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64");
    this.db
      .query("INSERT OR REPLACE INTO oauth_state VALUES (?, ?, ?, ?)")
      .run(kind, id, encrypted, expires);
  }
  get<T>(kind: string, id: string): T | undefined {
    const row = this.db
      .query<{ value: string; expires: number }, [string, string]>(
        "SELECT value, expires FROM oauth_state WHERE kind = ? AND id = ?",
      )
      .get(kind, id);
    if (!row || row.expires <= Date.now()) return undefined;
    const bytes = Buffer.from(row.value, "base64");
    const decipher = createDecipheriv("aes-256-gcm", this.key, bytes.subarray(0, 12));
    decipher.setAAD(Buffer.from(`${kind}:${id}`));
    decipher.setAuthTag(bytes.subarray(12, 28));
    return JSON.parse(
      Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString(),
    ) as T;
  }
  /** Atomically consume codes/refresh tokens so concurrent requests cannot replay them. */
  take<T>(kind: string, id: string): T | undefined {
    return this.db
      .transaction(() => {
        const value = this.get<T>(kind, id);
        if (value) this.remove(kind, id);
        return value;
      })
      .immediate();
  }
  remove(kind: string, id: string): void {
    this.db.query("DELETE FROM oauth_state WHERE kind = ? AND id = ?").run(kind, id);
  }
  prune(): void {
    this.db.query("DELETE FROM oauth_state WHERE expires <= ?").run(Date.now());
  }
  close(): void {
    this.db.close();
  }
}
