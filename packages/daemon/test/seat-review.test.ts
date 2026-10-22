import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { createFullTestDb } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { SeatLifecycleService } from "../src/domain/seat-lifecycle-service.js";
import { readSeatReview, sameSeatReview } from "../src/domain/seat-review.js";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import { Hono } from "hono";
import { seatRoutes } from "../src/routes/seat.js";
import { SeatDeliveryGuard, resolveGuardTarget } from "../src/domain/seat-delivery-guard.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";

describe("checked seat selection", () => {
  let db: Database.Database;
  let repo: RigRepository;
  let sessions: SessionRegistry;
  let service: SeatLifecycleService;
  let tmux: TmuxAdapter;
  let killed: string[];
  let beforeKill: ((afterDetach: boolean) => void) | undefined;
  let onProbe: (() => void) | undefined;
  let custody = false;
  let lifecycle = false;

  beforeEach(() => {
    db = createFullTestDb();
    repo = new RigRepository(db);
    sessions = new SessionRegistry(db);
    killed = [];
    const guard = {
      ownsCustody: () => custody,
      custody: async (_ids: string[], fn: () => Promise<unknown>) => { custody = true; try { return await fn(); } finally { custody = false; } },
      ownsLifecycle: () => lifecycle,
      lifecycle: async (_ids: string[], fn: () => Promise<unknown>) => { lifecycle = true; try { return await fn(); } finally { lifecycle = false; } },
      rebindLifecycle: () => {},
    };
    tmux = {
      deliveryGuard: guard,
      probeSession: async () => { onProbe?.(); return { state: "present" as const }; },
      killSession: async (name: string, assert?: (afterDetach: boolean) => void) => {
        beforeKill?.(false);
        assert?.(false);
        beforeKill?.(true);
        assert?.(true);
        killed.push(name);
        return { ok: true as const };
      },
    } as unknown as TmuxAdapter;
    service = new SeatLifecycleService({ db, rigRepo: repo, sessionRegistry: sessions, eventBus: new EventBus(db), tmuxAdapter: tmux });
  });
  afterEach(() => { db.close(); custody = false; lifecycle = false; onProbe = undefined; beforeKill = undefined; });

  /** Create a persisted seat with a native history token and its initial review. */
  function seat(name = "review") {
    const rig = repo.createRig(name);
    const node = repo.addNode(rig.id, "dev", { runtime: "codex", cwd: "/tmp", model: "m" });
    const session = sessions.registerSession(node.id, `dev@${name}`);
    sessions.updateStatus(session.id, "running");
    sessions.updateResumeToken(session.id, "codex_thread_id", "secret-token", "hook");
    sessions.updateBinding(node.id, { attachmentType: "tmux", tmuxSession: `dev@${name}`, tmuxPane: "%1" });
    const descriptor = readSeatReview(db, node.id)!;
    return { rig, node, session, descriptor, ref: `dev@${name}` };
  }

  it("hashes native tokens and changes revision for native selection and history", () => {
    const s = seat();
    const h = s.descriptor.review.history!;
    expect(sameSeatReview({ ...s.descriptor.review, history: { tokenHash: h.tokenHash, sessionId: h.sessionId, resumeType: h.resumeType } }, s.descriptor.review)).toBe(true);
    expect(JSON.stringify(s.descriptor)).not.toContain("secret-token");
    db.prepare("INSERT INTO node_permission_selections(node_id,runtime,mode,actor,reason) VALUES (?, 'codex', 'floor', 'op', 'reason')").run(s.node.id);
    const changed = readSeatReview(db, s.node.id)!;
    expect(changed.review.revision).not.toBe(s.descriptor.review.revision);
    sessions.updateResumeToken(s.session.id, "codex_thread_id", "another-token", "hook");
    const rotated = readSeatReview(db, s.node.id)!;
    expect(rotated.review.revision).not.toBe(changed.review.revision);
    expect(rotated.review.history?.tokenHash).not.toBe(changed.review.history?.tokenHash);
  });

  it("compares persisted startup JSON by content while retaining malformed bytes in the revision", async () => {
    const s = seat();
    db.prepare(`INSERT INTO node_startup_context
      (node_id, runtime, projection_entries_json, resolved_files_json, startup_actions_json)
      VALUES (?, 'codex', ?, '[]', '{}')`).run(s.node.id, '[{"z":{"b":2,"a":1},"a":[1,2]}]');
    const first = readSeatReview(db, s.node.id)!.review;
    db.prepare("UPDATE node_startup_context SET projection_entries_json = ? WHERE node_id = ?")
      .run('[{"a":[1,2],"z":{"a":1,"b":2}}]', s.node.id);
    const reordered = readSeatReview(db, s.node.id)!.review;
    expect(reordered).toEqual(first);
    const accepted = await service.setPolicy({ seatRef: s.ref, ref: "none", reason: "test", actor: "op", expected: first });
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) return;
    db.prepare("UPDATE node_startup_context SET projection_entries_json = ? WHERE node_id = ?")
      .run('[{"a":[2,1],"z":{"a":1,"b":2}}]', s.node.id);
    const changed = readSeatReview(db, s.node.id)!.review;
    expect(changed.revision).not.toBe(accepted.review.revision);
    const before = db.prepare("SELECT * FROM node_permission_selections WHERE node_id = ?").all(s.node.id);
    const stale = await service.setPermissions({ seatRef: s.ref, mode: "floor", reason: "test", actor: "op", expected: accepted.review });
    expect(stale.ok ? "ok" : stale.code).toBe("selection_changed");
    expect(db.prepare("SELECT * FROM node_permission_selections WHERE node_id = ?").all(s.node.id)).toEqual(before);
    db.prepare("UPDATE node_startup_context SET projection_entries_json = ? WHERE node_id = ?")
      .run("{broken", s.node.id);
    const malformed = readSeatReview(db, s.node.id)!.review;
    db.prepare("UPDATE node_startup_context SET projection_entries_json = ? WHERE node_id = ?")
      .run("{different", s.node.id);
    expect(readSeatReview(db, s.node.id)!.review.revision).not.toBe(malformed.revision);
  });

  /** Exercise checked stops through the real custody guard and an observable tmux stub. */
  function guardedTmux(onCommand?: (argv: string[]) => void) {
    db.close();
    db = new Database(":memory:");
    migrate(db, ALL_MIGRATIONS);
    repo = new RigRepository(db);
    sessions = new SessionRegistry(db);
    const s = seat("guarded");
    const calls: string[][] = [];
    const adapter = new TmuxAdapter(async () => { throw new Error("shell path unused"); }, undefined, async argv => {
      calls.push(argv);
      onCommand?.(argv);
      if (argv[1] === "display-message") return "$7\n";
      if (argv[1] === "detach-client" || argv[1] === "kill-session") return "";
      throw new Error(`unexpected tmux command ${argv[1]}`);
    });
    vi.spyOn(adapter, "listPanes").mockResolvedValue([{ id: "%1" } as never]);
    vi.spyOn(adapter, "probeSession").mockResolvedValue({ state: "present" });
    const guard = new SeatDeliveryGuard(db, name => resolveGuardTarget(db, name));
    adapter.deliveryGuard = guard;
    const guardedService = new SeatLifecycleService({ db, rigRepo: repo, sessionRegistry: sessions,
      eventBus: new EventBus(db), tmuxAdapter: adapter });
    return { s, calls, adapter, guard, guardedService };
  }

  it("checks the public guarded tmux kill before detach and kill using its immutable session id", async () => {
    const { s, calls, adapter, guard } = guardedTmux();
    const stages: string[] = [];
    const result = await guard.lifecycle([s.node.id], () => adapter.killSession(s.ref, afterDetach => {
      stages.push(afterDetach ? "after-detach" : "before-detach");
      expect(calls.some(argv => argv[1] === "detach-client")).toBe(afterDetach);
      expect(calls.some(argv => argv[1] === "kill-session")).toBe(false);
    }));
    expect(result.ok).toBe(true);
    expect(stages).toEqual(["before-detach", "after-detach"]);
    expect(calls.filter(argv => argv[1] === "detach-client" || argv[1] === "kill-session"))
      .toEqual([["tmux", "detach-client", "-s", "$7"], ["tmux", "kill-session", "-t", "$7"]]);
    expect(calls.find(argv => argv[1] === "display-message")).toEqual(["tmux", "display-message", "-p", "-t", "%1", "#{session_id}"]);
  });

  it("propagates guarded review changes before detach without issuing a stop effect", async () => {
    let change: (() => void) | undefined;
    const { s, calls, guardedService } = guardedTmux(argv => { if (argv[1] === "display-message") change?.(); });
    change = () => sessions.updateResumeToken(s.session.id, "codex_thread_id", "changed-before-detach", "hook");
    const outcome = await guardedService.stopSeat({ seatRef: s.ref, reason: "test", expected: s.descriptor.review });
    expect(outcome.ok ? "ok" : outcome.code).toBe("selection_changed");
    if (!outcome.ok) expect(outcome.partialStopEffect).toBeUndefined();
    expect(calls.some(argv => argv[1] === "detach-client" || argv[1] === "kill-session")).toBe(false);
  });

  it("propagates guarded review changes after detach as partial and never kills", async () => {
    let change: (() => void) | undefined;
    const { s, calls, guardedService } = guardedTmux(argv => { if (argv[1] === "detach-client") change?.(); });
    change = () => sessions.updateResumeToken(s.session.id, "codex_thread_id", "changed-after-detach", "hook");
    const outcome = await guardedService.stopSeat({ seatRef: s.ref, reason: "test", expected: s.descriptor.review });
    expect(outcome.ok ? "ok" : outcome.code).toBe("selection_changed");
    if (!outcome.ok) expect(outcome.partialStopEffect).toBe(true);
    expect(calls.find(argv => argv[1] === "detach-client")).toEqual(["tmux", "detach-client", "-s", "$7"]);
    expect(calls.some(argv => argv[1] === "kill-session")).toBe(false);
    expect(db.prepare("SELECT intentionally_stopped FROM sessions WHERE id = ?").get(s.session.id))
      .toEqual({ intentionally_stopped: 0 });
  });

  it("refuses stale checked setters and stop with zero writes or process calls", async () => {
    const s = seat();
    sessions.updateResumeToken(s.session.id, "codex_thread_id", "new-token", "hook");
    const expected = s.descriptor.review;
    const before = db.prepare("SELECT * FROM sessions WHERE node_id = ?").all(s.node.id);
    const permission = await service.setPermissions({ seatRef: s.ref, mode: "floor", reason: "test", actor: "op", expected });
    const policy = await service.setPolicy({ seatRef: s.ref, ref: "none", reason: "test", actor: "op", expected });
    const stopped = await service.stopSeat({ seatRef: s.ref, reason: "test", expected });
    expect([permission, policy, stopped].map(r => r.ok ? "ok" : r.code)).toEqual(["selection_changed", "selection_changed", "selection_changed"]);
    expect(db.prepare("SELECT * FROM sessions WHERE node_id = ?").all(s.node.id)).toEqual(before);
    expect(db.prepare("SELECT * FROM node_permission_selections WHERE node_id = ?").all(s.node.id)).toEqual([]);
    expect(killed).toEqual([]);
  });

  it("audits a checked Codex policy reaffirmation once and rejects a stale one without effects", async () => {
    const s = seat();
    const first = await service.setPolicy({ seatRef: s.ref, ref: "none", reason: "initial choice", actor: "op", expected: s.descriptor.review });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const policyWrites = vi.spyOn(repo, "setNodePermissionPolicy");
    const provenanceWrites = vi.spyOn(repo, "setNodePolicyProvenance");

    const reaffirmed = await service.setPolicy({ seatRef: s.ref, ref: "none", reason: "use this on rebuild", actor: "op", expected: first.review });
    expect(reaffirmed.ok).toBe(true);
    if (!reaffirmed.ok) return;
    expect(reaffirmed).toMatchObject({ changed: false, from: "none", to: "none" });
    expect(reaffirmed.review).toEqual(readSeatReview(db, s.node.id)!.review);
    expect(policyWrites).toHaveBeenCalledTimes(1);
    expect(provenanceWrites).toHaveBeenCalledTimes(1);
    const events = db.prepare("SELECT payload FROM events WHERE type = 'node.policy_changed' ORDER BY seq").all() as { payload: string }[];
    expect(events).toHaveLength(2);
    expect(JSON.parse(events[1]!.payload)).toMatchObject({ nodeId: s.node.id, from: "none", to: "none", reason: "use this on rebuild", operator: "op" });

    sessions.updateResumeToken(s.session.id, "codex_thread_id", "changed-after-review", "hook");
    const before = db.prepare("SELECT permission_policy, policy_origin, policy_launch_posture FROM nodes WHERE id = ?").get(s.node.id);
    const stale = await service.setPolicy({ seatRef: s.ref, ref: "none", reason: "stale reaffirmation", actor: "op", expected: reaffirmed.review });
    expect(stale.ok ? "ok" : stale.code).toBe("selection_changed");
    expect(db.prepare("SELECT permission_policy, policy_origin, policy_launch_posture FROM nodes WHERE id = ?").get(s.node.id)).toEqual(before);
    expect(db.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'node.policy_changed'").get()).toEqual({ n: 2 });
    expect(policyWrites).toHaveBeenCalledTimes(1);
    expect(provenanceWrites).toHaveBeenCalledTimes(1);
  });

  it("does not let a recycled human seat reference select a replacement node", async () => {
    const s = seat();
    db.prepare("DELETE FROM nodes WHERE id = ?").run(s.node.id);
    const replacement = repo.addNode(s.rig.id, "dev", { runtime: "codex", cwd: "/tmp", model: "m" });
    const newer = sessions.registerSession(replacement.id, s.ref);
    sessions.updateStatus(newer.id, "running");
    const outcome = await service.setPolicy({ seatRef: s.ref, ref: "none", reason: "test", actor: "op", expected: s.descriptor.review });
    expect(outcome.ok ? "ok" : outcome.code).toBe("selection_changed");
    expect(db.prepare("SELECT permission_policy FROM nodes WHERE id = ?").get(replacement.id)).toEqual({ permission_policy: null });
    expect(killed).toEqual([]);
  });

  it("rechecks after an async stop probe and immediately before its kill", async () => {
    const s = seat();
    onProbe = () => { sessions.updateResumeToken(s.session.id, "codex_thread_id", "probe-change", "hook"); };
    const duringProbe = await service.stopSeat({ seatRef: s.ref, reason: "test", expected: s.descriptor.review });
    expect(duringProbe.ok ? "ok" : duringProbe.code).toBe("selection_changed");
    expect(killed).toEqual([]);
    onProbe = undefined;
    const current = readSeatReview(db, s.node.id)!.review;
    beforeKill = () => { sessions.updateResumeToken(s.session.id, "codex_thread_id", "effect-change", "hook"); };
    const beforeEffect = await service.stopSeat({ seatRef: s.ref, reason: "test", expected: current });
    expect(beforeEffect.ok ? "ok" : beforeEffect.code).toBe("selection_changed");
    expect(killed).toEqual([]);
  });

  it("reports a partial stop boundary when history changes after detach", async () => {
    const s = seat();
    beforeKill = afterDetach => { if (afterDetach) sessions.updateResumeToken(s.session.id, "codex_thread_id", "after-detach", "hook"); };
    const outcome = await service.stopSeat({ seatRef: s.ref, reason: "test", expected: s.descriptor.review });
    expect(outcome.ok ? "ok" : outcome.code).toBe("selection_changed");
    if (!outcome.ok) expect(outcome.partialStopEffect).toBe(true);
    expect(killed).toEqual([]);
  });

  it("reports uncertainty when tmux stopped but the final database write fails", async () => {
    const s = seat();
    const bus = new EventBus(db);
    vi.spyOn(bus, "persistWithinTransaction").mockImplementation(() => { throw new Error("audit unavailable"); });
    const failing = new SeatLifecycleService({ db, rigRepo: repo, sessionRegistry: sessions, eventBus: bus, tmuxAdapter: tmux });
    const before = db.prepare("SELECT * FROM sessions WHERE id = ?").get(s.session.id);
    const outcome = await failing.stopSeat({ seatRef: s.ref, reason: "test", expected: s.descriptor.review });
    expect(outcome.ok ? "ok" : outcome.code).toBe("stop_outcome_uncertain");
    expect(killed).toEqual([s.ref]);
    expect(db.prepare("SELECT * FROM sessions WHERE id = ?").get(s.session.id)).toEqual(before);
  });

  it("rechecks a native permission selection after asynchronous mode preparation", async () => {
    const s = seat();
    db.prepare("UPDATE nodes SET runtime = 'claude-code' WHERE id = ?").run(s.node.id);
    const expected = readSeatReview(db, s.node.id)!.review;
    const racing = new SeatLifecycleService({ db, rigRepo: repo, sessionRegistry: sessions,
      eventBus: new EventBus(db), tmuxAdapter: tmux,
      runtimeAdapters: { "claude-code": { claudeManagedLaunch: { prepare: async () => {
        sessions.updateResumeToken(s.session.id, "claude_id", "changed-during-probe", "hook");
        return { assertCurrent: () => {} };
      } } } as never } });
    const outcome = await racing.setPermissions({ seatRef: s.ref, mode: "bypassPermissions", reason: "test", actor: "op", expected });
    expect(outcome.ok ? "ok" : outcome.code).toBe("selection_changed");
    expect(db.prepare("SELECT * FROM node_permission_selections WHERE node_id = ?").all(s.node.id)).toEqual([]);
  });

  it("fails closed when checked mutations have no delivery guard", async () => {
    const s = seat();
    const unguarded = new SeatLifecycleService({ db, rigRepo: repo, sessionRegistry: sessions,
      eventBus: new EventBus(db), tmuxAdapter: { ...tmux, deliveryGuard: undefined } as TmuxAdapter });
    const outcome = await unguarded.setPermissions({ seatRef: s.ref, mode: "floor", reason: "test", actor: "op", expected: s.descriptor.review });
    expect(outcome.ok ? "ok" : outcome.code).toBe("checked_contract_unavailable");
  });

  it("returns a committed review after a checked no-op and change", async () => {
    const s = seat();
    const one = await service.setPermissions({ seatRef: s.ref, mode: "floor", reason: "test", actor: "op", expected: s.descriptor.review });
    expect(one.ok).toBe(true);
    if (!one.ok) return;
    expect(one.review).toEqual(readSeatReview(db, s.node.id)!.review);
    const two = await service.setPermissions({ seatRef: s.ref, mode: "floor", reason: "test", actor: "op", expected: one.review });
    expect(two.ok).toBe(true);
    if (!two.ok) return;
    expect(two.changed).toBe(false);
    expect(two.review).toEqual(one.review);
  });

  it("changes metadata under a real custody lane while typing is held", async () => {
    db.close();
    db = new Database(":memory:");
    migrate(db, ALL_MIGRATIONS);
    repo = new RigRepository(db);
    sessions = new SessionRegistry(db);
    const s = seat();
    const guard = new SeatDeliveryGuard(db, name => resolveGuardTarget(db, name));
    tmux.deliveryGuard = guard;
    await guard.set(s.node.id, true, "op", "protect typing");
    const protectedService = new SeatLifecycleService({ db, rigRepo: repo, sessionRegistry: sessions,
      eventBus: new EventBus(db), tmuxAdapter: tmux });
    const first = await protectedService.setPolicy({ seatRef: s.ref, ref: "none", reason: "test", actor: "op", expected: s.descriptor.review });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = await protectedService.setPermissions({ seatRef: s.ref, mode: "floor", reason: "test", actor: "op", expected: first.review });
    expect(second.ok).toBe(true);
    expect(guard.preference(s.node.id).desired).toBe(true);
  });

  it("exposes only the supported seat capability and rejects malformed expected state publicly", async () => {
    const s = seat();
    const app = new Hono();
    app.use("*", async (c, next) => {
      c.set("rigRepo" as never, repo);
      c.set("sessionRegistry" as never, sessions);
      c.set("eventBus" as never, new EventBus(db));
      c.set("tmuxAdapter" as never, tmux);
      await next();
    });
    app.route("/api/seat", seatRoutes);
    const capabilities = await app.request("/api/seat/capabilities");
    expect(await capabilities.json()).toMatchObject({ features: ["seat-review.v1"], checkedActions: ["stop", "set-permissions", "set-policy"] });
    const response = await app.request(`/api/seat/review/${encodeURIComponent(s.ref)}`);
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toContain("secret-token");
    expect(JSON.parse(text).review).toEqual(s.descriptor.review);
    const invalid = await app.request(`/api/seat/set-permissions/${encodeURIComponent(s.ref)}`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "floor", reason: "test", operator: "op", expected: null }),
    });
    expect(invalid.status).toBe(400);
    sessions.updateResumeToken(s.session.id, "codex_thread_id", "changed-after-review", "hook");
    const stale = await app.request(`/api/seat/set-policy/${encodeURIComponent(s.ref)}`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ ref: "none", reason: "test", operator: "op", expected: s.descriptor.review }),
    });
    expect(stale.status).toBe(409);
    expect((await stale.json()).code).toBe("selection_changed");
    expect(killed).toEqual([]);
  });
});
