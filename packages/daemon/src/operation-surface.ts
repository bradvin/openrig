/** Public shape of a durable operation receipt. The implementation is not yet exposed by HTTP. */
export type OperationKind = "rig.create" | "rig.import" | "rig.materialize" | "member.add";
export type OperationState = "running" | "completed" | "interrupted";
export type OperationEffect = "none" | "committed" | "partial" | "rolled_back" | "unknown";
export type OperationExternal = "not_requested" | "not_started" | "completed" | "incomplete" | "indeterminate";
export type OperationStepState = "intent" | "committed" | "observed" | "compensated" | "indeterminate";

export interface OperationTarget {
  rigId?: string;
  podId?: string;
  nodeIds: string[];
}

export interface OperationStep {
  step: string;
  kind: string;
  targetId?: string;
  state: OperationStepState;
}

export interface OperationReceipt {
  contract: "operations.v1";
  operationId: string;
  kind: OperationKind;
  requestHash: string;
  state: OperationState;
  effect: OperationEffect;
  phase: string;
  target: OperationTarget;
  external: OperationExternal;
  originalHttpStatus?: number;
  result?: unknown;
  effects: OperationStep[];
  recovery?: { code: string; message: string };
  createdAt: string;
  updatedAt: string;
}
