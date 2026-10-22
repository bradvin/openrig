import type Database from "better-sqlite3";
import type {
  OperationEffect, OperationExternal, OperationKind, OperationReceipt,
  OperationStepState, OperationTarget,
} from "../operation-surface.js";

export interface OperationEvidence {
  /** Opaque, durable resource or existing evidence-reference IDs only. */
  ids?: string[];
  referenceIds?: string[];
}

export interface StoredOperationStep {
  step: string;
  kind: string;
  targetId?: string;
  state: OperationStepState;
  externalOutcome?: "completed" | "incomplete" | "indeterminate";
  evidence: OperationEvidence;
}

/** Pending or indeterminate external work dominates observed outcomes during recovery. */
export function aggregateExternalState(steps: StoredOperationStep[], fallback: OperationExternal): OperationExternal {
  const external = steps.filter((step) => step.state === "intent" || step.state === "indeterminate"
    || step.externalOutcome !== undefined);
  if (external.length === 0) return fallback;
  if (external.some((step) => step.state === "intent" || step.state === "indeterminate"
    || step.externalOutcome === "indeterminate" || step.externalOutcome === undefined)) return "indeterminate";
  if (external.some((step) => step.externalOutcome === "incomplete")) return "incomplete";
  return "completed";
}

interface ReceiptRow {
  operation_id: string;
  kind: OperationKind;
  request_hash: string;
  owner_boot_id: string;
  state: OperationReceipt["state"];
  effect: OperationEffect;
  phase: string;
  target_json: string;
  external_state: OperationExternal;
  result_json: string | null;
  result_http_status: number | null;
  recovery_json: string | null;
  created_at: string;
  updated_at: string;
}

interface EffectRow {
  step: string;
  kind: string;
  target_id: string | null;
  state: OperationStepState;
  external_outcome: "completed" | "incomplete" | "indeterminate" | null;
  evidence_json: string;
}

/** Serialize a present receipt value as JSON for SQLite text columns. */
function encode(value: unknown): string { return JSON.stringify(value); }

export class OperationRepository {
  constructor(readonly db: Database.Database) {}

  /** The primary key is the compare-and-set authority, including across processes. */
  insertRunning(input: {
    operationId: string; kind: OperationKind; requestHash: string;
    bootId: string; external: OperationExternal; now: string;
  }): boolean {
    const inserted = this.db.prepare(`
      INSERT INTO operation_receipts
      (operation_id, contract_version, hash_version, kind, request_hash, owner_boot_id,
       state, effect, phase, target_json, external_state, created_at, updated_at)
      VALUES (?, 1, 1, ?, ?, ?, 'running', 'none', 'reserved', ?, ?, ?, ?)
      ON CONFLICT(operation_id) DO NOTHING
    `).run(input.operationId, input.kind, input.requestHash, input.bootId,
      encode({ nodeIds: [] }), input.external, input.now, input.now).changes;
    return inserted === 1;
  }

  /** Reconstruct the public receipt and ordered evidence from their durable rows. */
  read(operationId: string): OperationReceipt | null {
    const row = this.db.prepare("SELECT * FROM operation_receipts WHERE operation_id = ?")
      .get(operationId) as ReceiptRow | undefined;
    if (!row) return null;
    const effects = this.db.prepare(`
      SELECT step, kind, target_id, state, external_outcome, evidence_json FROM operation_effects
      WHERE operation_id = ? ORDER BY rowid
    `).all(operationId) as EffectRow[];
    return {
      contract: "operations.v1", operationId: row.operation_id, kind: row.kind,
      requestHash: row.request_hash, state: row.state, effect: row.effect,
      phase: row.phase, target: JSON.parse(row.target_json) as OperationTarget,
      external: row.external_state,
      ...(row.result_http_status === null ? {} : { originalHttpStatus: row.result_http_status }),
      ...(row.result_json === null ? {} : { result: JSON.parse(row.result_json) as unknown }),
      effects: effects.map((effect) => ({ step: effect.step, kind: effect.kind,
        ...(effect.target_id === null ? {} : { targetId: effect.target_id }), state: effect.state,
        ...(effect.external_outcome === null ? {} : { externalOutcome: effect.external_outcome }),
        evidence: JSON.parse(effect.evidence_json) as OperationEvidence })),
      ...(row.recovery_json === null ? {} : { recovery: JSON.parse(row.recovery_json) as { code: string; message: string } }),
      createdAt: row.created_at, updatedAt: row.updated_at,
    };
  }

  /** Return recorded steps in execution order for custody and recovery decisions. */
  readSteps(operationId: string): StoredOperationStep[] {
    const rows = this.db.prepare(`SELECT step, kind, target_id, state, external_outcome, evidence_json
      FROM operation_effects WHERE operation_id = ? ORDER BY rowid`).all(operationId) as EffectRow[];
    return rows.map((row) => ({ step: row.step, kind: row.kind,
      ...(row.target_id === null ? {} : { targetId: row.target_id }),
      state: row.state,
      ...(row.external_outcome === null ? {} : { externalOutcome: row.external_outcome }),
      evidence: JSON.parse(row.evidence_json) as OperationEvidence }));
  }

  /** Guard every mutation against an interrupted or differently owned operation. */
  assertRunning(operationId: string, bootId: string): void {
    const row = this.db.prepare("SELECT state, owner_boot_id FROM operation_receipts WHERE operation_id = ?")
      .get(operationId) as { state: string; owner_boot_id: string } | undefined;
    if (!row || row.state !== "running" || row.owner_boot_id !== bootId) {
      throw new Error("operation_not_owned_or_running");
    }
  }

  /** Persist one committed topology effect or external intent/outcome within its caller's transaction. */
  putStep(operationId: string, step: StoredOperationStep, now: string): void {
    this.db.prepare(`
      INSERT INTO operation_effects (operation_id, step, kind, target_id, state, external_outcome, evidence_json, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(operation_id, step) DO UPDATE SET
        kind = excluded.kind, target_id = excluded.target_id, state = excluded.state,
        external_outcome = excluded.external_outcome, evidence_json = excluded.evidence_json,
        updated_at = excluded.updated_at
    `).run(operationId, step.step, step.kind, step.targetId ?? null,
      step.state, step.externalOutcome ?? null, encode(step.evidence), now);
  }

  /** Advance a running receipt only while the current boot still owns it. */
  updateProgress(input: {
    operationId: string; bootId: string; phase: string; target: OperationTarget;
    effect: OperationEffect; external: OperationExternal; now: string;
  }): void {
    const changed = this.db.prepare(`
      UPDATE operation_receipts SET phase = ?, target_json = ?, effect = ?, external_state = ?, updated_at = ?
      WHERE operation_id = ? AND owner_boot_id = ? AND state = 'running'
    `).run(input.phase, encode(input.target), input.effect, input.external,
      input.now, input.operationId, input.bootId).changes;
    if (changed !== 1) throw new Error("operation_not_owned_or_running");
  }

  /** Atomically seal the original result and HTTP status for replay. */
  complete(input: {
    operationId: string; bootId: string; phase: string; target: OperationTarget;
    effect: OperationEffect; external: OperationExternal; result: unknown;
    httpStatus: number; now: string;
  }): void {
    const changed = this.db.prepare(`
      UPDATE operation_receipts SET state = 'completed', phase = ?, target_json = ?, effect = ?,
        external_state = ?, result_json = ?, result_http_status = ?, updated_at = ?
      WHERE operation_id = ? AND owner_boot_id = ? AND state = 'running'
    `).run(input.phase, encode(input.target), input.effect, input.external,
      encode(input.result), input.httpStatus, input.now, input.operationId, input.bootId).changes;
    if (changed !== 1) throw new Error("operation_not_owned_or_running");
  }

  /** Seal prior-boot running IDs as interrupted without executing their effects again. */
  recoverPriorBoot(bootId: string, now: string): number {
    const tx = this.db.transaction(() => {
      const rows = this.db.prepare(`SELECT * FROM operation_receipts
        WHERE state = 'running' AND owner_boot_id <> ?`).all(bootId) as ReceiptRow[];
      for (const row of rows) {
        const steps = this.readSteps(row.operation_id);
        const topology = steps.filter((s) => s.state === "committed" || s.state === "compensated");
        const active = topology.filter((s) => s.state === "committed");
        const compensated = topology.filter((s) => s.state === "compensated");
        let effect: OperationEffect = row.effect;
        if (topology.length === 0 && effect !== "unknown") effect = "none";
        else if (topology.length > 0 && active.length === 0) effect = "rolled_back";
        else if (active.length > 0 && compensated.length > 0) effect = "partial";
        else if (active.length > 0 && effect === "none") effect = "committed";
        const external = aggregateExternalState(steps, row.external_state);
        const recovery = external === "indeterminate"
          ? { code: "inspect_external_uncertainty", message: "An external unit may have run. Inspect its recorded target and current state before a separate recovery action; this ID cannot execute again." }
          : effect === "none"
            ? { code: "new_operation_required", message: "This interrupted ID cannot execute again. Submit a current request with a new operation ID." }
            : { code: "inspect_committed_effects", message: "Inspect the recorded resource IDs and current state before a separate recovery action." };
        this.db.prepare(`UPDATE operation_receipts SET state = 'interrupted', effect = ?,
          external_state = ?, recovery_json = ?, updated_at = ?
          WHERE operation_id = ? AND state = 'running' AND owner_boot_id <> ?`)
          .run(effect, external, encode(recovery), now, row.operation_id, bootId);
      }
      return rows.length;
    });
    return tx.immediate();
  }
}
