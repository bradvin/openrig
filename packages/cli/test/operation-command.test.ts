import { describe, expect, it, vi } from "vitest";
import type { DaemonClient } from "../src/client.js";
import { STATE_FILE, type LifecycleDeps, type DaemonState } from "../src/daemon-lifecycle.js";
import { operationCommand } from "../src/commands/operation.js";

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
