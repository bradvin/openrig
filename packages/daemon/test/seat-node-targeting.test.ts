import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";
import { SeatLifecycleService } from "../src/domain/seat-lifecycle-service.js";
import type { SeatDeliveryGuard } from "../src/domain/seat-delivery-guard.js";

describe("node-addressed seat settings", () => {
  let db: Database.Database;
  let app: ReturnType<typeof createTestApp>;

  beforeEach(() => { db = createFullTestDb(); app = createTestApp(db); });
  afterEach(() => db.close());

  function add(rigName: string) {
    const rig = app.rigRepo.createRig(rigName);
    const node = app.rigRepo.addNode(rig.id, "worker", { runtime: "codex", model: "old" });
    return { rig, node };
  }
  async function post(verb: string, target: string, body: Record<string, unknown>) {
    return app.app.request(`/api/seat/${verb}/${target}`, { method: "POST",
      headers: { "content-type": "application/json", "x-openrig-session": "operator@control" },
      body: JSON.stringify({ ...body, reason: "Reviewed setting" }) });
  }
  const verbs = [
    { name: "set-permissions", body: { mode: "floor" }, event: "node.permissions_changed" },
    { name: "set-policy", body: { ref: "builtin:yolo" }, event: "node.policy_changed" },
    { name: "set-model", body: { model: "new" }, event: "node.model_changed" },
    { name: "set-effort", body: { effort: "high" }, event: "node.effort_changed" },
  ];

  it.each(verbs)("$name binds to the exact node amid ambiguous names and leaves history untouched", async ({ name, body, event }) => {
    const selected = add("one"), other = add("two");
    const otherBefore = db.prepare("SELECT model, effort_choice, permission_policy FROM nodes WHERE id=?").get(other.node.id);
    const session = app.sessionRegistry.registerSession(selected.node.id, "worker@one");
    app.sessionRegistry.updateBinding(selected.node.id, { attachmentType: "tmux", tmuxSession: "worker@one", tmuxPane: "%1" });
    const before = ["sessions", "bindings", "occupant_tenures"].map(t => db.prepare(`SELECT * FROM ${t}`).all());
    const ambiguous = await post(name, "worker", body);
    expect(ambiguous.status).toBe(409);
    expect(await ambiguous.json()).toMatchObject({ code: "seat_ambiguous" });

    const response = await post(name, `node/${selected.node.id}`, body);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, changed: true,
      seat: { nodeId: selected.node.id, rigId: selected.rig.id } });
    expect(["sessions", "bindings", "occupant_tenures"].map(t => db.prepare(`SELECT * FROM ${t}`).all())).toEqual(before);
    expect(db.prepare("SELECT id FROM sessions WHERE id=?").get(session.id)).toBeDefined();
    const events = db.prepare("SELECT payload FROM events WHERE type=?").all(event) as Array<{ payload: string }>;
    expect(events).toHaveLength(1);
    expect(JSON.parse(events[0]!.payload)).toMatchObject({ nodeId: selected.node.id, rigId: selected.rig.id,
      reason: "Reviewed setting", [name === "set-permissions" ? "actor" : "operator"]: "operator@control" });
    expect(db.prepare("SELECT model, effort_choice, permission_policy FROM nodes WHERE id=?").get(other.node.id)).toEqual(otherBefore);
    expect(db.prepare("SELECT COUNT(*) n FROM node_permission_selections WHERE node_id=?").get(other.node.id)).toEqual({ n: 0 });
  });

  it.each(verbs)("$name refuses deleted and archived IDs even with reusable names", async ({ name, body }) => {
    const selected = add("one");
    const replacement = add("two");
    app.rigRepo.deleteNode(selected.node.id);
    const missing = await post(name, `node/${selected.node.id}`, body);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ code: "seat_not_found" });
    expect(app.rigRepo.getRig(replacement.rig.id)!.nodes[0]!.id).toBe(replacement.node.id);
    app.rigRepo.archiveRig(replacement.rig.id);
    const archived = await post(name, `node/${replacement.node.id}`, body);
    expect(archived.status).toBe(404);
    expect(await archived.json()).toMatchObject({ code: "seat_not_found" });
    expect(db.prepare("SELECT COUNT(*) AS n FROM events WHERE node_id IN (?,?)").get(selected.node.id, replacement.node.id)).toEqual({ n: 0 });
  });

  it.each(verbs)("$name never retargets a deleted ID when the same rig reuses its name", async ({ name, body, event }) => {
    const original = add("one");
    app.rigRepo.deleteNode(original.node.id);
    const replacement = app.rigRepo.addNode(original.rig.id, "worker", { runtime: "codex", model: "old" });
    const oldId = await post(name, `node/${original.node.id}`, body);
    expect(oldId.status).toBe(404);
    expect(await oldId.json()).toMatchObject({ code: "seat_not_found" });
    expect(db.prepare("SELECT COUNT(*) n FROM events WHERE type=?").get(event)).toEqual({ n: 0 });
    const legacy = await post(name, "worker@one", body);
    expect(legacy.status).toBe(200);
    expect(await legacy.json()).toMatchObject({ ok: true, changed: true,
      seat: { nodeId: replacement.id, rigId: original.rig.id } });
    const rows = db.prepare("SELECT node_id FROM events WHERE type=?").all(event);
    expect(rows).toEqual([{ node_id: replacement.id }]);
  });

  it("reads the exact node status and advertises the additive contract", async () => {
    const chosen = add("one"); add("two");
    const exact = await app.app.request(`/api/seat/status/node/${chosen.node.id}`);
    expect(exact.status).toBe(200);
    expect(await exact.json()).toMatchObject({ node_id: chosen.node.id, rig_id: chosen.rig.id,
      contract: "seat-node.v1", supported_actions: verbs.map(v => v.name) });
    const legacy = await app.app.request("/api/seat/status/worker");
    expect(legacy.status).toBe(409);
    const named = await app.app.request("/api/seat/status/worker@one");
    expect(named.status).toBe(200);
    expect(await named.json()).not.toHaveProperty("contract");
    app.rigRepo.archiveRig(chosen.rig.id);
    expect((await app.app.request(`/api/seat/status/node/${chosen.node.id}`)).status).toBe(404);
  });

  it("normalizes an encoded padded ID in exact status and guard enrichment", async () => {
    const selected = add("one");
    db.exec("CREATE TABLE outbox_entries (delivery_state TEXT, guard_binding TEXT, ts_dispatched TEXT, outbox_id TEXT)");
    db.prepare("INSERT INTO outbox_entries (delivery_state, guard_binding, ts_dispatched, outbox_id) VALUES ('retained', ?, '', 'held')")
      .run(JSON.stringify({ nodeId: selected.node.id }));
    const preference = vi.fn((nodeId: string) => ({ nodeId, desired: false, effective: false, pending: false,
      desiredMode: "off", effectiveMode: "off" }));
    app.tmuxAdapter.deliveryGuard = { db, preference } as unknown as SeatDeliveryGuard;
    const response = await app.app.request(`/api/seat/status/node/${encodeURIComponent(` ${selected.node.id} `)}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ node_id: selected.node.id, rig_id: selected.rig.id,
      typingGuard: { nodeId: selected.node.id, heldCount: 1 } });
    expect(preference).toHaveBeenCalledExactlyOnceWith(selected.node.id);
  });

  it.each(verbs)("$name refuses a formerly valid node after archive, even for the same value", async ({ name, body, event }) => {
    const selected = add("one");
    expect((await post(name, `node/${selected.node.id}`, body)).status).toBe(200);
    const noOp = await post(name, `node/${selected.node.id}`, body);
    expect(noOp.status).toBe(200);
    expect(await noOp.json()).toMatchObject({ ok: true, changed: false, seat: { nodeId: selected.node.id } });
    const count = db.prepare("SELECT COUNT(*) n FROM events WHERE type=?").get(event);
    app.rigRepo.archiveRig(selected.rig.id);
    const refusal = await post(name, `node/${selected.node.id}`, body);
    expect(refusal.status).toBe(404);
    expect(await refusal.json()).toMatchObject({ code: "seat_not_found" });
    expect(db.prepare("SELECT COUNT(*) n FROM events WHERE type=?").get(event)).toEqual(count);
  });

  it.each(["delete", "archive", "runtime", "cwd", "new-session"] as const)(
    "rechecks node eligibility after awaited stub validation: %s", async change => {
      const rig = app.rigRepo.createRig("claude-rig");
      const node = app.rigRepo.addNode(rig.id, "worker", { runtime: "claude-code", cwd: "/old" });
      let enter!: () => void, release!: () => void;
      const entered = new Promise<void>(resolve => { enter = resolve; });
      const pending = new Promise<void>(resolve => { release = resolve; });
      const service = new SeatLifecycleService({ db, rigRepo: app.rigRepo, sessionRegistry: app.sessionRegistry,
        eventBus: app.eventBus, tmuxAdapter: app.tmuxAdapter,
        runtimeAdapters: { "claude-code": { claudeManagedLaunch: { prepare: async () => {
          enter(); await pending;
          // This no-op assertion isolates the added node eligibility check. S03 separately
          // verifies that real Claude preparation refuses generation changes during help.
          return { assertCurrent: () => {} };
        } } } as never } });
      const saving = service.setPermissions({ nodeId: node.id, mode: "acceptEdits", reason: "native choice", actor: "operator@control" });
      await entered;
      if (change === "delete") app.rigRepo.deleteNode(node.id);
      if (change === "archive") app.rigRepo.archiveRig(rig.id);
      if (change === "runtime") db.prepare("UPDATE nodes SET runtime='codex' WHERE id=?").run(node.id);
      if (change === "cwd") db.prepare("UPDATE nodes SET cwd='/new' WHERE id=?").run(node.id);
      if (change === "new-session") app.sessionRegistry.registerSession(node.id, "worker@claude-rig");
      release();
      const result = await saving;
      if (change === "new-session") {
        expect(result).toMatchObject({ ok: true, changed: true, seat: { nodeId: node.id } });
      } else {
        expect(result).toMatchObject({ ok: false, code: change === "delete" || change === "archive" ? "seat_not_found" : "selection_changed" });
      }
      expect(db.prepare("SELECT COUNT(*) n FROM events WHERE type='node.permissions_changed'").get())
        .toEqual({ n: change === "new-session" ? 1 : 0 });
      expect(db.prepare("SELECT COUNT(*) n FROM node_permission_selections WHERE node_id=?").get(node.id))
        .toEqual({ n: change === "new-session" ? 1 : 0 });
    });
});
