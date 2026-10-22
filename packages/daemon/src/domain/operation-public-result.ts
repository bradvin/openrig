import type { OperationKind } from "../operation-surface.js";

/**
 * Receipt results are explicit public projections. Callers must map legacy
 * responses into one of these shapes; this validator never stores an unknown
 * field or tries to recognize secrets in arbitrary prose.
 */
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) throw new Error("operation_result_invalid_shape");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !keys.includes(key))) throw new Error("operation_result_unrecognized_field");
  return record;
}

function string(value: unknown, max = 256): string {
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value, "utf8") > max
    || /[\r\n\0]/.test(value)) throw new Error("operation_result_invalid_string");
  return value;
}

function optionalString(value: unknown, max = 256): string | undefined {
  return value === undefined ? undefined : string(value, max);
}

function array(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) throw new Error("operation_result_invalid_array");
  return value;
}

function node(value: unknown, kind: OperationKind): Record<string, string> {
  const row = object(value, ["logicalId", "nodeId", "status"]);
  const status = string(row.status, 32);
  const valid = kind === "rig.materialize" ? ["materialized"] : ["launched", "failed", "attention_required"];
  if (!valid.includes(status)) throw new Error("operation_result_invalid_status");
  return { logicalId: string(row.logicalId),
    ...(row.nodeId === undefined ? {} : { nodeId: string(row.nodeId) }), status };
}

function failure(value: Record<string, unknown>): Record<string, string> {
  const row = object(value, ["code"]);
  const code = string(row.code, 64);
  if (!/^[a-z][a-z0-9_]*$/.test(code)) throw new Error("operation_result_invalid_code");
  return { code };
}

export function validateOperationPublicResult(kind: OperationKind, value: unknown): unknown {
  const row = object(value, kind === "rig.create"
    ? ["id", "name", "createdAt", "updatedAt", "code"]
    : kind === "member.add"
      ? ["podId", "podNamespace", "node", "edges", "code"]
      : ["rigId", "specName", "specVersion", "nodes", "code"]);
  if (row.code !== undefined) return failure(row);

  if (kind === "rig.create") {
    if (row.id === undefined || row.name === undefined) throw new Error("operation_result_invalid_shape");
    return { id: string(row.id), name: string(row.name),
      ...(row.createdAt === undefined ? {} : { createdAt: string(row.createdAt, 64) }),
      ...(row.updatedAt === undefined ? {} : { updatedAt: string(row.updatedAt, 64) }) };
  }
  if (kind === "rig.import" || kind === "rig.materialize") {
    if (row.rigId === undefined) throw new Error("operation_result_invalid_shape");
    return { rigId: string(row.rigId),
      ...(optionalString(row.specName) === undefined ? {} : { specName: string(row.specName) }),
      ...(optionalString(row.specVersion, 64) === undefined ? {} : { specVersion: string(row.specVersion, 64) }),
      ...(row.nodes === undefined ? {} : { nodes: array(row.nodes, 256).map((item) => node(item, kind)) }) };
  }

  if (row.podId === undefined || row.podNamespace === undefined || row.node === undefined) {
    throw new Error("operation_result_invalid_shape");
  }
  const member = node(row.node, kind);
  if (!member.nodeId) throw new Error("operation_result_invalid_shape");
  const edges = row.edges === undefined ? undefined : array(row.edges, 512).map((item) => {
    const edge = object(item, ["from", "to", "kind"]);
    return { from: string(edge.from), to: string(edge.to), kind: string(edge.kind) };
  });
  return { podId: string(row.podId), podNamespace: string(row.podNamespace), node: member,
    ...(edges === undefined ? {} : { edges }) };
}
