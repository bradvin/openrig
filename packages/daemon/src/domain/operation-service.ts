import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import YAML from "yaml";
import type { OperationEffect, OperationExternal, OperationKind, OperationReceipt, OperationStepState, OperationTarget } from "../operation-surface.js";
import { OperationRepository, aggregateExternalState, type OperationEvidence } from "./operation-repository.js";
import { validateOperationPublicResult } from "./operation-public-result.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STEP = /^[A-Za-z0-9][A-Za-z0-9:._/-]{0,191}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,255}$/;

export interface OperationRequest {
  operationId: string;
  kind: OperationKind;
  /** Immutable IDs named by the request, not resolved by name on retry. */
  targetIds: unknown;
  /** Validated bare-create data or a parsed JSON/YAML data tree. */
  payload: unknown;
  /** Include all behavior-changing headers, resolution root, and edge choices. */
  options: unknown;
  expectsExternal?: boolean;
}

/** Passed only by operation-bearing callers to the actual mutation owner. */
export interface OperationContext {
  service: OperationService;
  operationId: string;
}

export type Reservation =
  | { kind: "reserved"; receipt: OperationReceipt }
  | { kind: "in_flight" | "replayed" | "conflict"; receipt: OperationReceipt };

/** Canonicalize request data and reject unsupported values before hashing retry identity. */
function stableValue(value: unknown, depth = 0): unknown {
  if (depth > 32) throw new Error("operation_request_too_deep");
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map((item) => stableValue(item, depth + 1));
  if (typeof value === "object" && value !== null && Object.getPrototypeOf(value) === Object.prototype) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      if (key === "__proto__" || key === "constructor" || key === "prototype") throw new Error("unsupported_operation_key");
      out[key] = stableValue((value as Record<string, unknown>)[key], depth + 1);
    }
    return out;
  }
  throw new Error("unsupported_operation_value");
}

/** Parse YAML once with unique keys so equivalent retry requests hash alike. */
export function parseOperationYaml(source: string): unknown {
  const value = YAML.parse(source, { uniqueKeys: true });
  return stableValue(value);
}

/** Resolve the behavior-changing root before it enters the request hash. */
export function normalizedOperationRoot(root: string): string {
  if (!root.trim()) throw new Error("operation_root_required");
  return resolve(root);
}

/** Bind an ID to the full mutation request, including options that change effects. */
export function operationRequestHash(request: Pick<OperationRequest, "kind" | "targetIds" | "payload" | "options">): string {
  const canonical = JSON.stringify(stableValue({ contractVersion: 1, kind: request.kind,
    targetIds: request.targetIds, payload: request.payload, options: request.options }));
  if (Buffer.byteLength(canonical, "utf8") > 1024 * 1024) throw new Error("operation_request_too_large");
  return createHash("sha256").update(canonical).digest("hex");
}

function safeId(value: string, label: string): void {
  if (!ID.test(value)) throw new Error(`invalid_${label}`);
}

function safeStep(value: string): void {
  if (!STEP.test(value)) throw new Error("invalid_operation_step");
}

/** Limit receipts to opaque IDs and references; arbitrary payloads cannot enter durable evidence. */
function safeEvidence(evidence: OperationEvidence): OperationEvidence {
  if (Object.keys(evidence).some((key) => key !== "ids" && key !== "referenceIds")) {
    throw new Error("operation_evidence_not_allowed");
  }
  const out: OperationEvidence = {};
  for (const key of ["ids", "referenceIds"] as const) {
    const values = evidence[key];
    if (values === undefined) continue;
    if (!Array.isArray(values) || values.length > 64) throw new Error("operation_evidence_too_large");
    for (const value of values) safeId(value, "operation_evidence_id");
    out[key] = [...values];
  }
  return out;
}

/** Bound receipt targets to stable resource IDs for later inspection. */
function safeTarget(target: OperationTarget): OperationTarget {
  if (target.rigId !== undefined) safeId(target.rigId, "operation_rig_id");
  if (target.podId !== undefined) safeId(target.podId, "operation_pod_id");
  if (!Array.isArray(target.nodeIds) || target.nodeIds.length > 256) throw new Error("invalid_operation_node_ids");
  for (const id of target.nodeIds) safeId(id, "operation_node_id");
  return { ...(target.rigId === undefined ? {} : { rigId: target.rigId }),
    ...(target.podId === undefined ? {} : { podId: target.podId }), nodeIds: [...target.nodeIds] };
}

export class OperationService {
  readonly bootId: string;
  constructor(readonly repository: OperationRepository, bootId = randomUUID(),
    private readonly now: () => string = () => new Date().toISOString()) {
    if (!UUID.test(bootId)) throw new Error("invalid_operation_boot_id");
    this.bootId = bootId;
  }

  /** Atomically claim a new ID or classify a same-ID retry without repeating effects. */
  reserve(request: OperationRequest): Reservation {
    if (!UUID.test(request.operationId)) throw new Error("invalid_operation_id");
    if (!["rig.create", "rig.import", "rig.materialize", "member.add"].includes(request.kind)) {
      throw new Error("invalid_operation_kind");
    }
    const hash = operationRequestHash(request);
    const tx = this.repository.db.transaction(() => {
      const inserted = this.repository.insertRunning({ operationId: request.operationId,
        kind: request.kind, requestHash: hash, bootId: this.bootId,
        external: request.expectsExternal ? "not_started" : "not_requested", now: this.now() });
      const receipt = this.repository.read(request.operationId);
      if (!receipt) throw new Error("operation_reservation_missing");
      if (inserted) return { kind: "reserved", receipt } as Reservation;
      if (receipt.kind !== request.kind || receipt.requestHash !== hash) return { kind: "conflict", receipt } as Reservation;
      return { kind: receipt.state === "running" ? "in_flight" : "replayed", receipt } as Reservation;
    });
    return tx.immediate();
  }

  /** Read one validated ID without changing its state or re-running its work. */
  read(operationId: string): OperationReceipt | null {
    if (!UUID.test(operationId)) throw new Error("invalid_operation_id");
    return this.repository.read(operationId);
  }

  /** Call inside the same synchronous SQLite transaction as the owning topology change. */
  commitEffectWithinTransaction(input: {
    operationId: string; step: string; kind: string; targetId?: string;
    state?: "committed" | "compensated"; evidence?: OperationEvidence;
    target: OperationTarget; effect: OperationEffect; phase: string;
  }): void {
    if (!this.repository.db.inTransaction) throw new Error("operation_effect_requires_transaction");
    safeStep(input.step); safeStep(input.kind); safeStep(input.phase);
    if (input.targetId !== undefined) safeId(input.targetId, "operation_target_id");
    const target = safeTarget(input.target);
    const current = this.repository.read(input.operationId);
    this.repository.assertRunning(input.operationId, this.bootId);
    if (!current) throw new Error("operation_missing");
    const priorStep = this.repository.readSteps(input.operationId).find((step) => step.step === input.step);
    if (priorStep && (input.state !== "compensated" || priorStep.state !== "committed"
      || priorStep.kind !== input.kind || priorStep.targetId !== input.targetId)) {
      throw new Error("operation_step_already_recorded");
    }
    if (!priorStep && input.state === "compensated") throw new Error("operation_compensation_without_effect");
    const evidence = safeEvidence(input.evidence ?? priorStep?.evidence ?? {});
    const now = this.now();
    this.repository.putStep(input.operationId, { step: input.step, kind: input.kind,
      targetId: input.targetId, state: input.state ?? "committed", evidence }, now);
    this.repository.updateProgress({ operationId: input.operationId, bootId: this.bootId,
      phase: input.phase, target, effect: input.effect, external: current.external, now });
  }

  /** Durable intent must commit before the external call starts. */
  beginExternalStep(input: { operationId: string; step: string; kind: string;
    targetId?: string; evidence?: OperationEvidence; phase: string }): void {
    if (this.repository.db.inTransaction) throw new Error("operation_external_step_requires_own_transaction");
    safeStep(input.step); safeStep(input.kind); safeStep(input.phase);
    if (input.targetId !== undefined) safeId(input.targetId, "operation_target_id");
    const evidence = safeEvidence(input.evidence ?? {});
    this.repository.db.transaction(() => {
      this.repository.assertRunning(input.operationId, this.bootId);
      if (this.repository.readSteps(input.operationId).some((step) => step.step === input.step)) {
        throw new Error("operation_step_already_recorded");
      }
      const receipt = this.repository.read(input.operationId)!;
      const now = this.now();
      this.repository.putStep(input.operationId, { step: input.step, kind: input.kind,
        targetId: input.targetId, state: "intent", evidence }, now);
      this.repository.updateProgress({ operationId: input.operationId, bootId: this.bootId,
        phase: input.phase, target: receipt.target, effect: receipt.effect,
        external: "indeterminate", now });
    }).immediate();
  }

  /** Record only the unit's observed result; indeterminate never means proven success. */
  finishExternalStep(input: { operationId: string; step: string;
    state: "observed" | "indeterminate"; external: "completed" | "incomplete" | "indeterminate";
    evidence?: OperationEvidence; phase: string }): void {
    if (this.repository.db.inTransaction) throw new Error("operation_external_step_requires_own_transaction");
    safeStep(input.step); safeStep(input.phase);
    if (!["completed", "incomplete", "indeterminate"].includes(input.external)) {
      throw new Error("invalid_operation_external_outcome");
    }
    if ((input.state === "indeterminate") !== (input.external === "indeterminate")) {
      throw new Error("operation_external_outcome_state_mismatch");
    }
    const evidence = safeEvidence(input.evidence ?? {});
    this.repository.db.transaction(() => {
      this.repository.assertRunning(input.operationId, this.bootId);
      const step = this.repository.readSteps(input.operationId).find((item) => item.step === input.step);
      if (!step || step.state !== "intent") throw new Error("operation_external_intent_missing");
      const receipt = this.repository.read(input.operationId)!;
      const now = this.now();
      this.repository.putStep(input.operationId, { ...step, state: input.state,
        externalOutcome: input.external, evidence }, now);
      const aggregate = aggregateExternalState(this.repository.readSteps(input.operationId), receipt.external);
      this.repository.updateProgress({ operationId: input.operationId, bootId: this.bootId,
        phase: input.phase, target: receipt.target, effect: receipt.effect,
        external: aggregate, now });
    }).immediate();
  }

  /** Save original public response in the same transaction when the effect is transactional. */
  completeWithinTransaction(input: { operationId: string; phase: string;
    target: OperationTarget; effect: OperationEffect; external: OperationExternal;
    httpStatus: number; result: unknown }): void {
    if (!this.repository.db.inTransaction) throw new Error("operation_completion_requires_transaction");
    if (!Number.isInteger(input.httpStatus) || input.httpStatus < 100 || input.httpStatus > 599) {
      throw new Error("invalid_operation_http_status");
    }
    safeStep(input.phase);
    const target = safeTarget(input.target);
    const current = this.repository.read(input.operationId);
    if (!current) throw new Error("operation_missing");
    const result = validateOperationPublicResult(current.kind, input.result);
    const aggregate = aggregateExternalState(this.repository.readSteps(input.operationId), current.external);
    if (input.external !== aggregate) throw new Error("operation_external_outcome_mismatch");
    this.repository.complete({ ...input, target, result, bootId: this.bootId, now: this.now() });
  }

  /** Convert stranded prior-boot work to inspectable, non-retryable receipts. */
  recoverInterrupted(): number {
    return this.repository.recoverPriorBoot(this.bootId, this.now());
  }
}
