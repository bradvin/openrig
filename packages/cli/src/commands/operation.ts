import { Command } from "commander";
import { DaemonClient } from "../client.js";
import { getDaemonStatus, getDaemonUrl, daemonStatusGuard } from "../daemon-lifecycle.js";
import { realDeps } from "./daemon.js";
import type { StatusDeps } from "./status.js";

export interface OperationEnvelope<T> {
  operation: { operationId: string; state: string; effect: string; originalHttpStatus?: number;
    recovery?: { code: string; message: string } };
  result?: T;
  replayed?: boolean;
}

// Match OperationService's accepted ID format before contacting the daemon for an opted-in write.
const OPERATION_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Refuse an invalid retry identity locally so it cannot reach capability or mutation routes. */
export function validOperationId(operationId: string | undefined, json = false): boolean {
  if (operationId === undefined || OPERATION_UUID.test(operationId)) return true;
  const detail = "--operation-id must be a UUID (version 1–8); no mutation was sent.";
  if (json) console.log(JSON.stringify({ ok: false, error: "invalid_operation_id", detail }, null, 2));
  else console.error(detail);
  process.exitCode = 1;
  return false;
}

/** Report a completed receipt whose result cannot be consumed safely by its command. */
export function malformedOperationResult(operationId: string, json = false): void {
  const detail = `Operation ${operationId} returned a malformed result; inspect with: rig operation get ${operationId} --json`;
  if (json) console.log(JSON.stringify({ ok: false, error: "invalid_operation_receipt", detail }, null, 2));
  else console.error(detail);
  process.exitCode = 1;
}

/** An older daemon can ignore the header, so verify the exact contract before any opted-in write. */
export async function requireOperationCapability(client: DaemonClient,
  kind: "rig.create" | "rig.import" | "rig.materialize" | "member.add"): Promise<boolean> {
  try {
    const response = await client.get<{ contract?: string; kinds?: string[] }>("/api/operations/capabilities");
    if (response.status === 200 && response.data?.contract === "operations.v1"
      && Array.isArray(response.data.kinds) && response.data.kinds.includes(kind)) return true;
  } catch { /* absence and an unreadable capability response both refuse the opted-in write */ }
  console.error(`The selected daemon does not advertise operations.v1 for ${kind}; no mutation was sent.`);
  process.exitCode = 1;
  return false;
}

/** Unwrap only a matching completed receipt; error and uncertain outcomes remain failures. */
export function operationResult<T>(data: T | OperationEnvelope<T>, status: number,
  operationId?: string, json = false): { value: T; status: number } | undefined {
  if (operationId === undefined) return { value: data as T, status };
  const body = data && typeof data === "object" && !Array.isArray(data)
    ? data as Record<string, unknown> : {};
  const receipt = body.operation && typeof body.operation === "object" && !Array.isArray(body.operation)
    ? body.operation as Record<string, unknown> : undefined;
  const failure = (error: string, detail: string, operation?: Record<string, unknown>): undefined => {
    if (json) console.log(JSON.stringify({ ok: false, error, detail,
      ...(operation ? { operation } : {}) }, null, 2));
    else console.error(detail);
    process.exitCode = 1;
    return undefined;
  };
  if (status === 409 && body.error === "operation_id_conflict") {
    return failure("operation_id_conflict",
      `Operation ID ${operationId} belongs to a different request; nothing was retried. Inspect the original receipt with: rig operation get ${operationId} --json`, receipt);
  }
  if (status >= 400 && typeof body.error === "string") {
    return failure(body.error,
      `Operation ${operationId} failed (HTTP ${status}): ${body.error}. Inspect with: rig operation get ${operationId} --json`, receipt);
  }
  if (!receipt || receipt.operationId !== operationId || typeof receipt.state !== "string"
    || typeof receipt.effect !== "string") {
    return failure("invalid_operation_receipt",
      `The daemon did not return a matching operation receipt for ${operationId} (HTTP ${status}); inspect the operation before retrying.`);
  }
  if (status === 202 || receipt.state !== "completed" || body.result === undefined) {
    if (json) console.log(JSON.stringify({ ok: false, operation: receipt,
      detail: `Operation ${operationId} has no completed result. Inspect with: rig operation get ${operationId} --json` }, null, 2));
    else {
      console.error(`Operation ${operationId}: ${receipt.state}, effect ${receipt.effect}.`);
      if (receipt.recovery && typeof receipt.recovery === "object" && "message" in receipt.recovery)
        console.error(String(receipt.recovery.message));
      console.error(`Inspect with: rig operation get ${operationId} --json`);
    }
    process.exitCode = 1;
    return undefined;
  }
  if (!body.result || typeof body.result !== "object" || Array.isArray(body.result)) {
    return failure("invalid_operation_receipt",
      `Operation ${operationId} returned a malformed result; inspect the receipt before retrying.`);
  }
  return { value: body.result as T,
    status: typeof receipt.originalHttpStatus === "number" ? receipt.originalHttpStatus : status };
}

/** Read a persisted receipt without triggering a second mutation attempt. */
export function operationCommand(depsOverride?: StatusDeps): Command {
  const cmd = new Command("operation").description("Inspect durable create, import, materialize, and add-member receipts");
  const getDeps = () => depsOverride ?? { lifecycleDeps: realDeps(), clientFactory: (url: string) => new DaemonClient(url) };
  cmd.command("get <operation-id>")
    .description("Read one operation receipt without retrying its effects")
    .option("--json", "JSON output")
    .action(async (operationId: string, opts: { json?: boolean }) => {
      const deps = getDeps();
      const status = await getDaemonStatus(deps.lifecycleDeps);
      if (!daemonStatusGuard(status)) return;
      const client = deps.clientFactory(getDaemonUrl(status));
      const response = await client.get<OperationEnvelope<unknown> & { error?: string }>(
        `/api/operations/${encodeURIComponent(operationId)}`);
      if (opts.json) {
        console.log(JSON.stringify(response.data, null, 2));
        if (response.status >= 400) process.exitCode = 1;
        return;
      }
      if (response.status >= 400 || !response.data.operation) {
        console.error(response.data.error ?? `Operation lookup failed (HTTP ${response.status}).`);
        process.exitCode = 1;
        return;
      }
      const receipt = response.data.operation;
      console.log(`Operation ${receipt.operationId}: ${receipt.state}, effect ${receipt.effect}.`);
      if (receipt.recovery) console.log(receipt.recovery.message);
      if (response.data.result !== undefined) console.log(JSON.stringify(response.data.result, null, 2));
    });
  return cmd;
}
