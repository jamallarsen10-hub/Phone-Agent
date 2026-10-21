import { mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * One writer at a time for data/store.json, across processes.
 *
 * Three things save the store: the auto sender, the Command Center, and the
 * phone (`pipe`). Each does load -> change -> save. Without a lock, two of them
 * overlapping means the second save silently drops the first one's change
 * (a Sold tap vanishing, or worse, a "sent" mark lost so a text goes twice).
 *
 * The lock is a directory (mkdir is atomic on every filesystem we run on).
 * A lock older than STALE_MS is treated as left behind by a crash and taken over.
 */
export const STALE_MS = 5 * 60 * 1000;

export async function withStoreLock(dataDir, fn, { waitMs = 90000, stepMs = 100, staleMs = STALE_MS, clock = Date.now, sleep } = {}) {
  const dir = join(dataDir, "store.lock");
  const pause = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  mkdirSync(dataDir, { recursive: true });
  const started = clock();
  for (;;) {
    try {
      mkdirSync(dir);
      break;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      let age = 0;
      try {
        age = clock() - statSync(dir).mtimeMs;
      } catch {
        continue; // released between our mkdir and stat; try again now
      }
      if (age > staleMs) {
        try {
          rmSync(dir, { recursive: true, force: true });
        } catch {}
        continue;
      }
      if (clock() - started > waitMs) {
        const err = new Error("another part of Phone Agent is busy saving; try again in a minute");
        err.code = "STORE_BUSY";
        throw err;
      }
      await pause(stepMs);
    }
  }
  try {
    try {
      writeFileSync(join(dir, "owner"), `${process.pid} ${new Date(clock()).toISOString()}\n`);
    } catch {}
    return await fn();
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
}
