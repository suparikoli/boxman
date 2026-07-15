import Database from "@tauri-apps/plugin-sql";

let db: Database | null = null;

export async function getDb(): Promise<Database> {
  if (!db) {
    db = await Database.load("sqlite:velo.db");
  }
  return db;
}

/**
 * Build a dynamic SQL UPDATE statement from a set of field updates.
 * Returns null if no fields to update.
 */
export function buildDynamicUpdate(
  table: string,
  idColumn: string,
  id: unknown,
  fields: [string, unknown][],
): { sql: string; params: unknown[] } | null {
  if (fields.length === 0) return null;

  const sets: string[] = [];
  const params: unknown[] = [];
  let idx = 1;

  for (const [column, value] of fields) {
    sets.push(`${column} = $${idx++}`);
    params.push(value);
  }

  params.push(id);
  return {
    sql: `UPDATE ${table} SET ${sets.join(", ")} WHERE ${idColumn} = $${idx}`,
    params,
  };
}

/**
 * Serialises a group of write statements against every other `withTransaction`
 * group, so two groups can never interleave their writes.
 *
 * IMPORTANT — why this deliberately does NOT issue `BEGIN`/`COMMIT`:
 * tauri-plugin-sql runs every `execute()`/`select()` on a *pooled* sqlx
 * connection (the sqlx default pool is up to 10 connections) and returns that
 * connection to the pool after each call. The separate `BEGIN`, write and
 * `COMMIT` statements of an interactive transaction can therefore land on
 * *different* physical connections whenever another query interleaves. Under
 * concurrency that:
 *   1. breaks atomicity — each write auto-commits on whichever connection it
 *      happens to acquire (observed: a thread row persisted without its
 *      message); and
 *   2. can strand a `BEGIN` on one pooled connection, holding the SQLite write
 *      lock until every *other* write times out against sqlx's 5s busy-timeout
 *      (observed: uniform ~5s "slow statement" warnings on trivial writes).
 * The plugin exposes no real transaction API, so the only reliably-atomic unit
 * is a single statement.
 *
 * This helper instead runs the callback's writes as a *serialised* sequence of
 * individually-committed statements: correct and free of lock contention, at
 * the cost of all-or-nothing rollback. Its only callers (IMAP sync, snooze)
 * issue idempotent, re-derivable writes, so a partially-applied group is safe —
 * the next sync/checker pass reconciles any gap.
 */
let txQueue: Promise<void> = Promise.resolve();

export async function withTransaction(fn: (db: Database) => Promise<void>): Promise<void> {
  // Queue this group behind any currently-running one. This serialises write
  // groups without blocking non-transactional reads.
  const prev = txQueue;
  let resolve!: () => void;
  txQueue = new Promise<void>((r) => {
    resolve = r;
  });

  try {
    await prev; // wait for the previous group to finish
  } catch {
    // previous group errored — that's fine, we can still proceed
  }

  try {
    const database = await getDb();
    await fn(database);
  } finally {
    resolve(); // always unblock the next queued group
  }
}

/**
 * Execute a SELECT query and return the first result or null.
 */
export async function selectFirstBy<T>(
  query: string,
  params: unknown[] = [],
): Promise<T | null> {
  const db = await getDb();
  const rows = await db.select<T[]>(query, params);
  return rows[0] ?? null;
}

/**
 * Execute a COUNT(*) query and return whether any rows exist.
 */
export async function existsBy(
  query: string,
  params: unknown[] = [],
): Promise<boolean> {
  const db = await getDb();
  const rows = await db.select<{ count: number }[]>(query, params);
  return (rows[0]?.count ?? 0) > 0;
}

/**
 * Convert a boolean to SQLite integer (0 or 1).
 */
export function boolToInt(value: boolean | undefined | null): number {
  return value ? 1 : 0;
}
