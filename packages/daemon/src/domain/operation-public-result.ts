import type { OperationKind } from "../operation-surface.js";

/**
 * Receipt results are explicit public projections. Callers must map legacy
 * responses into one of these shapes. It bounds and whitelists fields while
 * omitting arbitrary spec, environment, path, and preflight prose; allowed
 * identifiers and names remain caller-supplied and are not scanned for secrets.
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

const VALIDATION_FIELDS = new Set([
  "request", "spec", "schema_version", "name", "version", "nodes", "edges", "pods",
  "id", "label", "members", "member", "runtime", "agent_ref", "profile", "cwd",
  "from", "to", "kind", "workspace", "workspace_root", "repos", "path",
  "default_repo", "knowledge_root", "culture_file", "docs", "startup", "services",
  "env", "managed_blocks", "permission_policy", "restore_policy", "model", "effort",
  "role", "session_source", "non_interruptive", "continuity_policy",
]);

/** Keep structural field guidance, never variable values from a spec, path, env, or preflight error. */
export function operationValidationFields(value: unknown): string[] {
  if (!Array.isArray(value)) return ["request: invalid"];
  const fields: string[] = [];
  for (const raw of value.slice(0, 64)) {
    if (typeof raw !== "string") continue;
    const prefix = raw.match(/^([a-z][a-z0-9_]*(?:\[\d+\]|\.[a-z][a-z0-9_]*|\.\[\d+\])*)(?::|\s)/)?.[1];
    const segments = prefix?.replace(/\[\d+\]/g, "").split(".") ?? [];
    const field = prefix && Buffer.byteLength(prefix, "utf8") <= 96
      && segments.every((segment) => VALIDATION_FIELDS.has(segment)) ? prefix : "request";
    const item = `${field}: invalid`;
    if (!fields.includes(item)) fields.push(item);
  }
  return fields.length > 0 ? fields : ["request: invalid"];
}

function failure(value: Record<string, unknown>, kind: OperationKind): Record<string, unknown> {
  const row = object(value, kind === "member.add" ? ["ok", "code", "errors"] : ["code", "errors"]);
  const code = string(row.code, 64);
  if (!/^[a-z][a-z0-9_]*$/.test(code)) throw new Error("operation_result_invalid_code");
  if (row.errors !== undefined && code !== "validation_failed" && code !== "preflight_failed") {
    throw new Error("operation_result_invalid_shape");
  }
  const errors = row.errors === undefined ? undefined : array(row.errors, 64).map((item) => {
    const field = string(item, 112);
    if (!field.endsWith(": invalid")) throw new Error("operation_result_invalid_validation_field");
    const path = field.slice(0, -9);
    const segments = path.replace(/\[\d+\]/g, "").split(".");
    if (!segments.every((segment) => VALIDATION_FIELDS.has(segment))) throw new Error("operation_result_invalid_validation_field");
    return field;
  });
  if (kind === "member.add") {
    if (row.ok !== undefined && row.ok !== false) throw new Error("operation_result_invalid_shape");
    return { ok: false, code, ...(errors === undefined ? {} : { errors }) };
  }
  return { code, ...(errors === undefined ? {} : { errors }) };
}

/** Bound replayable result fields while leaving allowed names and IDs caller-supplied. */
export function validateOperationPublicResult(kind: OperationKind, value: unknown): unknown {
  const row = object(value, kind === "rig.create"
    ? ["id", "name", "createdAt", "updatedAt", "code", "errors"]
    : kind === "member.add"
      ? ["ok", "result", "code", "errors"]
      : ["rigId", "specName", "specVersion", "nodes", "code", "errors"]);
  if (row.code !== undefined) return failure(row, kind);

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

  if (row.ok !== true || row.result === undefined) throw new Error("operation_result_invalid_shape");
  const memberResult = object(row.result, ["podId", "podNamespace", "node", "edges"]);
  if (memberResult.podId === undefined || memberResult.podNamespace === undefined || memberResult.node === undefined) {
    throw new Error("operation_result_invalid_shape");
  }
  const member = node(memberResult.node, kind);
  if (!member.nodeId) throw new Error("operation_result_invalid_shape");
  const edges = memberResult.edges === undefined ? undefined : array(memberResult.edges, 512).map((item) => {
    const edge = object(item, ["from", "to", "kind"]);
    return { from: string(edge.from), to: string(edge.to), kind: string(edge.kind) };
  });
  return { ok: true, result: { podId: string(memberResult.podId),
    podNamespace: string(memberResult.podNamespace), node: member,
    ...(edges === undefined ? {} : { edges }) } };
}
