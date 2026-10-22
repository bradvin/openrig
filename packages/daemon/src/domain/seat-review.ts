import { createHash } from "node:crypto";
import type Database from "better-sqlite3";

export interface SeatReview {
  contract: "seat-review.v1";
  rigId: string;
  nodeId: string;
  revision: string;
  latestSessionId: string | null;
  history: { sessionId: string; resumeType: string; tokenHash: string } | null;
}

export interface SeatReviewDescriptor {
  review: SeatReview;
  seat: Record<string, unknown>;
  latestHistory: SeatReview["history"];
  configuration: {
    nativePermission: Record<string, unknown> | null;
    policy: Record<string, unknown>;
    codexConfigProfile: string | null;
    model: string | null;
    effort: string | null;
  };
  liveState: { sessionStatus: string | null; observation: "persisted_only" | "present" | "absent" | "transport_unavailable" | "unverified"; detail?: string };
}

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");
const tokenHash = (value: unknown): string | null => typeof value === "string" && value.trim() ? sha256(value) : null;

/** Sort object keys recursively so equivalent JSON objects produce the same revision input. */
function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value !== null && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(object).sort().map(key => [key, canonicalJson(object[key])]));
  }
  return value;
}

/** Normalize persisted startup JSON for hashing without including transient formatting. */
function startupJsonProjection(value: unknown): unknown {
  if (typeof value !== "string") return { state: "non_text", value: value ?? null };
  try { return { state: "json", value: canonicalJson(JSON.parse(value)) }; }
  catch { return { state: "malformed", rawHash: sha256(value) }; }
}

/**
 * Read the review descriptor and its revision inputs from one SQLite snapshot.
 * The versioned revision excludes polling timestamps and hashes native tokens rather
 * than returning their values, so callers can compare state without exposing secrets.
 */
export function readSeatReview(db: Database.Database, nodeId: string): SeatReviewDescriptor | null {
  return db.transaction(() => {
    const row = db.prepare(`SELECT n.*, r.name AS rig_name, r.archived_at AS rig_archived_at,
      r.permission_policy AS rig_permission_policy, r.rig_policy_origin,
      r.rig_policy_resolved_target, r.rig_policy_declaring_dir, r.rig_policy_launch_posture
      FROM nodes n JOIN rigs r ON r.id = n.rig_id WHERE n.id = ?`).get(nodeId) as Record<string, unknown> | undefined;
    if (!row) return null;
    const sessions = db.prepare(`SELECT id, session_name, status, origin, resume_type, resume_token,
      resume_provenance, resume_launch_token, resume_rotated_from, resume_rotated_process,
      resume_launch_process, intentionally_stopped FROM sessions WHERE node_id = ? ORDER BY id`)
      .all(nodeId) as Array<Record<string, unknown>>;
    const binding = db.prepare(`SELECT id, node_id, tmux_session, tmux_window, tmux_pane,
      cmux_workspace, cmux_surface, attachment_type, external_session_name FROM bindings WHERE node_id = ?`)
      .get(nodeId) as Record<string, unknown> | undefined;
    const tenure = db.prepare(`SELECT generation_uuid FROM occupant_tenures WHERE node_id = ? ORDER BY generation_ordinal DESC LIMIT 1`)
      .get(nodeId) as { generation_uuid: string } | undefined;
    const permission = db.prepare(`SELECT runtime, mode, actor, reason FROM node_permission_selections WHERE node_id = ?`)
      .get(nodeId) as Record<string, unknown> | undefined;
    const startup = db.prepare(`SELECT runtime, projection_entries_json, resolved_files_json, startup_actions_json
      FROM node_startup_context WHERE node_id = ?`).get(nodeId) as Record<string, unknown> | undefined;
    const latest = sessions.at(-1);
    const history = latest && typeof latest.resume_type === "string" && tokenHash(latest.resume_token)
      ? { sessionId: String(latest.id), resumeType: latest.resume_type, tokenHash: tokenHash(latest.resume_token)! }
      : null;
    const rig = { id: row.rig_id, name: row.rig_name, archivedAt: row.rig_archived_at,
      permissionPolicy: row.rig_permission_policy, policyOrigin: row.rig_policy_origin,
      policyTarget: row.rig_policy_resolved_target, policyDir: row.rig_policy_declaring_dir,
      launchPosture: row.rig_policy_launch_posture };
    const node = { id: row.id, logicalId: row.logical_id, podId: row.pod_id, runtime: row.runtime,
      cwd: row.cwd, model: row.model, effort: row.effort, effortChoice: row.effort_choice,
      advisor: row.advisor, codexConfigProfile: row.codex_config_profile,
      permissionPolicy: row.permission_policy, policyOrigin: row.policy_origin,
      policyTarget: row.policy_resolved_target, policyDir: row.policy_declaring_dir,
      launchPosture: row.policy_launch_posture };
    const historyRows = sessions.map(s => ({ id: s.id, name: s.session_name, status: s.status,
      origin: s.origin, resumeType: s.resume_type, tokenHash: tokenHash(s.resume_token),
      provenance: s.resume_provenance, launchTokenHash: tokenHash(s.resume_launch_token),
      rotatedFromHash: tokenHash(s.resume_rotated_from), rotatedProcess: s.resume_rotated_process,
      launchProcess: s.resume_launch_process, intentionallyStopped: s.intentionally_stopped }));
    const startupProjection = startup ? {
      runtime: startup.runtime,
      projectionEntries: startupJsonProjection(startup.projection_entries_json),
      resolvedFiles: startupJsonProjection(startup.resolved_files_json),
      startupActions: startupJsonProjection(startup.startup_actions_json),
    } : null;
    const revision = sha256(JSON.stringify({ version: 1, rig, node, permission: permission ?? null,
      history: historyRows, binding: binding ?? null, occupantGeneration: tenure?.generation_uuid ?? null,
      startup: startupProjection }));
    const review: SeatReview = { contract: "seat-review.v1", rigId: String(row.rig_id),
      nodeId: String(row.id), revision, latestSessionId: latest ? String(latest.id) : null, history };
    return { review, seat: { rigId: row.rig_id, rigName: row.rig_name, nodeId: row.id,
      logicalId: row.logical_id, podId: row.pod_id, runtime: row.runtime, cwd: row.cwd,
      occupantGeneration: tenure?.generation_uuid ?? null },
      latestHistory: history,
      configuration: { nativePermission: permission ?? null,
        policy: { ref: row.permission_policy, origin: row.policy_origin,
          resolvedTarget: row.policy_resolved_target, declaringDir: row.policy_declaring_dir,
          launchPosture: row.policy_launch_posture }, codexConfigProfile: (row.codex_config_profile as string | null) ?? null,
        model: (row.model as string | null) ?? null, effort: (row.effort as string | null) ?? null },
      liveState: { sessionStatus: (latest?.status as string | null) ?? null, observation: "persisted_only" as const } };
  })();
}

/** Validate the external review-token shape before a checked mutation reaches service logic. */
export function validSeatReview(value: unknown): value is SeatReview {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  if (v.contract !== "seat-review.v1" || typeof v.rigId !== "string" || !v.rigId
    || typeof v.nodeId !== "string" || !v.nodeId || typeof v.revision !== "string" || !/^[a-f0-9]{64}$/.test(v.revision)
    || !(v.latestSessionId === null || typeof v.latestSessionId === "string")) return false;
  if (v.history === null) return true;
  if (!v.history || typeof v.history !== "object" || Array.isArray(v.history)) return false;
  const h = v.history as Record<string, unknown>;
  return typeof h.sessionId === "string" && typeof h.resumeType === "string"
    && typeof h.tokenHash === "string" && /^[a-f0-9]{64}$/.test(h.tokenHash)
    && h.sessionId === v.latestSessionId;
}

/** Compare token identity and revision, including the latest history identity when present. */
export function sameSeatReview(expected: SeatReview, current: SeatReview): boolean {
  return expected.contract === current.contract && expected.rigId === current.rigId
    && expected.nodeId === current.nodeId && expected.revision === current.revision
    && expected.latestSessionId === current.latestSessionId
    && (expected.history === null ? current.history === null
      : current.history !== null && expected.history.sessionId === current.history.sessionId
        && expected.history.resumeType === current.history.resumeType
        && expected.history.tokenHash === current.history.tokenHash);
}
