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

/** An older daemon can ignore the header, so verify the exact contract before any opted-in write. */
export async function requireOperationCapability(client: DaemonClient,
  kind: "rig.create" | "rig.import" | "rig.materialize" | "member.add"): Promise<boolean> {
  try {
    const response = await client.get<{ contract?: string; kinds?: string[] }>("/api/operations/capabilities");
    if (response.status === 200 && response.data.contract === "operations.v1"
      && Array.isArray(response.data.kinds) && response.data.kinds.includes(kind)) return true;
  } catch { /* absence and an unreadable capability response both refuse the opted-in write */ }
  console.error(`The selected daemon does not advertise operations.v1 for ${kind}; no mutation was sent.`);
  process.exitCode = 1;
  return false;
}

export function operationResult<T>(data: T | OperationEnvelope<T>, status: number,
  operationId?: string, json = false): { value: T; status: number } | undefined {
  if (operationId === undefined) return { value: data as T, status };
  const envelope = data as OperationEnvelope<T>;
  if (!envelope.operation || envelope.operation.operationId !== operationId) {
    throw new Error("The daemon did not return a matching operation receipt.");
  }
  if (envelope.result === undefined) {
    if (json) console.log(JSON.stringify({ ok: false, operation: envelope.operation,
      detail: `Operation ${operationId} has no completed result. Inspect with: rig operation get ${operationId} --json` }, null, 2));
    else {
      console.error(`Operation ${operationId}: ${envelope.operation.state}, effect ${envelope.operation.effect}.`);
      if (envelope.operation.recovery) console.error(envelope.operation.recovery.message);
      console.error(`Inspect with: rig operation get ${operationId} --json`);
    }
    process.exitCode = 1;
    return undefined;
  }
  return { value: envelope.result, status: envelope.operation.originalHttpStatus ?? status };
}

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
