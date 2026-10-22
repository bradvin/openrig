import { describe, expect, it, vi } from "vitest";
import type { DaemonClient } from "../src/client.js";
import { STATE_FILE, type LifecycleDeps, type DaemonState } from "../src/daemon-lifecycle.js";
import { operationCommand, operationResult } from "../src/commands/operation.js";

function lifecycleDeps(): LifecycleDeps {
  const state: DaemonState = { pid: 123, port: 7433, db: "test.sqlite", startedAt: "2026-10-22T00:00:00Z" };
  return { spawn: vi.fn(() => ({ pid: 1, unref: vi.fn() }) as never),
    fetch: vi.fn(async () => ({ ok: true })), kill: vi.fn(() => true),
    readFile: vi.fn((path: string) => path === STATE_FILE ? JSON.stringify(state) : null),
    writeFile: vi.fn(), removeFile: vi.fn(), exists: vi.fn((path: string) => path === STATE_FILE),
    mkdirp: vi.fn(), openForAppend: vi.fn(() => 3), isProcessAlive: vi.fn(() => true) };
}

describe("rig operation get", () => {
  it("reads a receipt without posting a retry", async () => {
    const id = "ea7e6a21-b25b-41e2-947e-8554d086ef2a";
    const client = { get: vi.fn(async () => ({ status: 200, data: {
      operation: { operationId: id, state: "interrupted", effect: "partial",
        recovery: { code: "inspect_committed_effects", message: "Inspect the recorded IDs." } },
    } })), post: vi.fn() };
    const command = operationCommand({ lifecycleDeps: lifecycleDeps(), clientFactory: () => client as unknown as DaemonClient });
    command.exitOverride();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await command.parseAsync(["node", "operation", "get", id, "--json"]);
      expect(client.get).toHaveBeenCalledWith(`/api/operations/${id}`);
      expect(client.post).not.toHaveBeenCalled();
      expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({ operation: {
        state: "interrupted", effect: "partial" } });
    } finally { log.mockRestore(); }
  });
});

describe("opted-in operation response", () => {
  const id = "ea7e6a21-b25b-41e2-947e-8554d086ef2a";
  const receipt = { operationId: id, state: "completed", effect: "none", originalHttpStatus: 409 };

  function capture(data: unknown, status: number, json: boolean) {
    const prior = process.exitCode;
    process.exitCode = undefined;
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const value = operationResult(data, status, id, json);
      return { value, exitCode: process.exitCode,
        output: [...log.mock.calls, ...error.mock.calls].map((call) => String(call[0])).join("\n") };
    } finally {
      log.mockRestore(); error.mockRestore(); process.exitCode = prior;
    }
  }

  it.each([false, true])("reports receipt-free HTTP 400 without throwing (json=%s)", (json) => {
    const result = capture({ error: "invalid_operation_id" }, 400, json);
    expect(result.value).toBeUndefined();
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("invalid_operation_id");
    if (json) expect(JSON.parse(result.output)).toMatchObject({ ok: false, error: "invalid_operation_id" });
  });

  it.each([false, true])("labels HTTP 409 as a conflict with the original receipt (json=%s)", (json) => {
    const result = capture({ error: "operation_id_conflict", operation: receipt }, 409, json);
    expect(result.value).toBeUndefined();
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain(json ? "operation_id_conflict" : "different request");
    if (json) expect(JSON.parse(result.output)).toMatchObject({ ok: false, error: "operation_id_conflict",
      operation: { operationId: id } });
  });

  it.each([false, true])("reports a server error even when its body includes a matching receipt and result (json=%s)", (json) => {
    const result = capture({ error: "service_unavailable", operation: receipt,
      result: { rigId: "original-rig" } }, 500, json);
    expect(result.value).toBeUndefined();
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("service_unavailable");
    if (json) expect(JSON.parse(result.output)).toMatchObject({ ok: false,
      error: "service_unavailable", operation: { operationId: id } });
  });

  it.each([null, {}, { operation: { operationId: "other", state: "completed", effect: "none" }, result: {} },
    { operation: receipt, result: "wrong" }])("refuses malformed or mismatched envelopes", (body) => {
    const result = capture(body, 200, true);
    expect(result.value).toBeUndefined();
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.output)).toMatchObject({ ok: false, error: "invalid_operation_receipt" });
  });

  it("keeps the original status for a completed failed replay", () => {
    const result = capture({ operation: receipt, result: { code: "preflight_failed" }, replayed: true }, 200, true);
    expect(result.value).toEqual({ value: { code: "preflight_failed" }, status: 409 });
    expect(result.exitCode).toBeUndefined();
  });

  it("refuses a 202 even if an erroneous response includes a result", () => {
    const result = capture({ operation: { ...receipt, state: "running" }, result: { rigId: "unexpected" } }, 202, true);
    expect(result.value).toBeUndefined();
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.output)).toMatchObject({ ok: false, operation: { state: "running" } });
  });
});
