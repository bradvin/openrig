import type Database from "better-sqlite3";

// Only operation-bearing calls enter this lane. It serializes async preflight
// and subsequent writes for one rig identity on this daemon; SQLite CAS and
// transactional identity checks remain the cross-process authority.
const lanes = new WeakMap<Database.Database, Map<string, Promise<void>>>();

export async function runOperationMutation<T>(db: Database.Database, key: string,
  work: () => Promise<T>): Promise<T> {
  let byKey = lanes.get(db);
  if (!byKey) lanes.set(db, (byKey = new Map()));
  const prior = byKey.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  byKey.set(key, current);
  try {
    await prior;
    return await work();
  } finally {
    release();
    if (byKey.get(key) === current) byKey.delete(key);
  }
}
