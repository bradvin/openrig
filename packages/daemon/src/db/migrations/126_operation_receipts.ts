import type { Migration } from "../migrate.js";

export const operationReceiptsSchema: Migration = {
  name: "126_operation_receipts.sql",
  sql: `
    CREATE TABLE operation_receipts (
      operation_id TEXT PRIMARY KEY,
      contract_version INTEGER NOT NULL CHECK(contract_version = 1),
      hash_version INTEGER NOT NULL CHECK(hash_version = 1),
      kind TEXT NOT NULL CHECK(kind IN ('rig.create','rig.import','rig.materialize','member.add')),
      request_hash TEXT NOT NULL,
      owner_boot_id TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('running','completed','interrupted')),
      effect TEXT NOT NULL CHECK(effect IN ('none','committed','partial','rolled_back','unknown')),
      phase TEXT NOT NULL,
      target_json TEXT NOT NULL,
      external_state TEXT NOT NULL CHECK(external_state IN ('not_requested','not_started','completed','incomplete','indeterminate')),
      result_json TEXT,
      result_http_status INTEGER,
      recovery_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE operation_effects (
      operation_id TEXT NOT NULL REFERENCES operation_receipts(operation_id),
      step TEXT NOT NULL,
      kind TEXT NOT NULL,
      target_id TEXT,
      state TEXT NOT NULL CHECK(state IN ('intent','committed','observed','compensated','indeterminate')),
      external_outcome TEXT CHECK(external_outcome IN ('completed','incomplete','indeterminate')),
      evidence_json TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CHECK (
        (state IN ('committed','compensated','intent') AND external_outcome IS NULL)
        OR (state = 'observed' AND external_outcome IN ('completed','incomplete'))
        OR (state = 'indeterminate' AND external_outcome = 'indeterminate')
      ),
      PRIMARY KEY(operation_id, step)
    );
    CREATE INDEX operation_effects_operation ON operation_effects(operation_id);
  `,
};
