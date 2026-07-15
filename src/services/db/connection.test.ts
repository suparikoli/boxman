import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock Database before importing module under test
const mockExecute = vi.fn();
const mockSelect = vi.fn();
const mockDb = { execute: mockExecute, select: mockSelect };

vi.mock("@tauri-apps/plugin-sql", () => ({
  default: {
    load: vi.fn(() => Promise.resolve(mockDb)),
  },
}));

// Use dynamic import so mocks are in place
const { withTransaction, getDb } = await import("./connection");

describe("withTransaction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExecute.mockResolvedValue(undefined);
  });

  it("runs the callback without issuing BEGIN/COMMIT/ROLLBACK", async () => {
    // Interactive transactions are unsafe over tauri-plugin-sql's connection
    // pool, so withTransaction must NOT emit BEGIN/COMMIT/ROLLBACK — it only
    // serialises the callback's own writes.
    const executed: string[] = [];
    mockExecute.mockImplementation(async (sql: string) => {
      executed.push(sql);
    });

    let ran = false;
    await withTransaction(async (db) => {
      ran = true;
      await db.execute("INSERT INTO t VALUES (1)");
    });

    expect(ran).toBe(true);
    expect(executed).toEqual(["INSERT INTO t VALUES (1)"]);
    expect(executed).not.toContain("BEGIN TRANSACTION");
    expect(executed).not.toContain("COMMIT");
    expect(executed).not.toContain("ROLLBACK");
  });

  it("propagates callback errors without attempting a ROLLBACK", async () => {
    const executed: string[] = [];
    mockExecute.mockImplementation(async (sql: string) => {
      executed.push(sql);
    });

    await expect(
      withTransaction(async () => {
        throw new Error("callback failed");
      }),
    ).rejects.toThrow("callback failed");

    expect(executed).not.toContain("ROLLBACK");
  });

  it("serialises concurrent groups via the mutex", async () => {
    const executionLog: string[] = [];

    // Launch two groups concurrently; the first does async work.
    const tx1 = withTransaction(async () => {
      executionLog.push("tx1-start");
      await new Promise((r) => setTimeout(r, 10));
      executionLog.push("tx1-end");
    });

    const tx2 = withTransaction(async () => {
      executionLog.push("tx2-start");
      executionLog.push("tx2-end");
    });

    await Promise.all([tx1, tx2]);

    // tx1 must fully complete before tx2 starts (no interleaving).
    expect(executionLog).toEqual([
      "tx1-start",
      "tx1-end",
      "tx2-start",
      "tx2-end",
    ]);
  });

  it("unblocks the next group even if the current one fails", async () => {
    // First group fails
    const tx1 = withTransaction(async () => {
      throw new Error("tx1 failed");
    }).catch(() => {
      /* expected */
    });

    // Second group should still run
    let tx2Ran = false;
    const tx2 = withTransaction(async () => {
      tx2Ran = true;
    });

    await Promise.all([tx1, tx2]);

    expect(tx2Ran).toBe(true);
  });
});

describe("getDb", () => {
  it("returns the same instance on repeated calls", async () => {
    const db1 = await getDb();
    const db2 = await getDb();
    expect(db1).toBe(db2);
  });
});
