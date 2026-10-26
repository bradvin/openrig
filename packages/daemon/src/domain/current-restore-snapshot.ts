import type Database from "better-sqlite3";
import type { RigWithRelations, Snapshot } from "./types.js";
import type { SnapshotRepository } from "./snapshot-repository.js";
import { snapshotMatchesCurrentOccupants } from "./rehydrate-eligibility.js";

/** The startup route's current, policy-ranked, structurally usable source.
 * History inspection may narrow occupant compatibility to its exact node;
 * ordinary startup keeps the original whole-rig check. */
export function currentRestoreSnapshot(db: Database.Database, snapshots: SnapshotRepository, rig: RigWithRelations, nodeId?: string): Snapshot | null {
  const snapshot = snapshots.findLatestRestoreUsable(rig.rig.id);
  const checkedRig = nodeId ? { ...rig, nodes: rig.nodes.filter((node) => node.id === nodeId) } : rig;
  return snapshot && (!nodeId || checkedRig.nodes.length > 0) && snapshotMatchesCurrentOccupants(db, checkedRig, snapshot) ? snapshot : null;
}
