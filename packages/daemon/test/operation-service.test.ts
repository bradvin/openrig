import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { operationReceiptsSchema } from "../src/db/migrations/126_operation_receipts.js";
import { OperationRepository } from "../src/domain/operation-repository.js";
import { OperationService, normalizedOperationRoot, operationRequestHash, parseOperationYaml } from "../src/domain/operation-service.js";
import { validateOperationPublicResult } from "../src/domain/operation-public-result.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function database(): { db: Database.Database; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "openrig-operation-test-"));
  dirs.push(dir);
  const path = join(dir, "test.sqlite");
  const db = new Database(path);
  db.pragma("foreign_keys = ON");
  migrate(db, [operationReceiptsSchema]);
  db.exec("CREATE TABLE owned_effects (id TEXT PRIMARY KEY)");
  return { db, path };
}

function service(db: Database.Database, bootId = randomUUID()): OperationService {
  return new OperationService(new OperationRepository(db), bootId);
}

function request(operationId = randomUUID(), extras: Record<string, unknown> = {}) {
  return { operationId, kind: "rig.import" as const, targetIds: {},
    payload: { rig: { name: "A", members: ["lead", "ui"] } },
    options: { root: normalizedOperationRoot("/tmp/a"), edges: ["lead->ui"] },
    expectsExternal: true, ...extras };
}

describe("operation receipt foundation", () => {
  it("accepts only bounded, kind-specific public result fields", () => {
    expect(validateOperationPublicResult("rig.create", { id: "rig-1", name: "A" }))
      .toEqual({ id: "rig-1", name: "A" });
    expect(validateOperationPublicResult("rig.materialize", { rigId: "rig-1",
      nodes: [{ logicalId: "lead", status: "materialized" }] })).toMatchObject({ rigId: "rig-1" });
    expect(validateOperationPublicResult("member.add", { podId: "pod-1", podNamespace: "desk",
      node: { logicalId: "ui", nodeId: "node-1", status: "launched" }, edges: [] })).toMatchObject({ podId: "pod-1" });
    for (const unsafe of [{ token: "raw-native-token" }, { env: { API_KEY: "x" } },
      { rigId: "rig-1", transcript: "private" }, { rigId: "rig-1", rawSpec: "name: A" }]) {
      expect(() => validateOperationPublicResult("rig.import", unsafe)).toThrow("unrecognized");
    }
    expect(() => validateOperationPublicResult("rig.import", { rigId: "rig-1",
      nodes: [{ logicalId: "lead", status: "launched", resumeToken: "raw-native-token" }] })).toThrow("unrecognized");
    expect(() => validateOperationPublicResult("rig.materialize", { rigId: "rig-1",
      nodes: [{ logicalId: "lead", status: "launched" }] })).toThrow("status");
    expect(() => validateOperationPublicResult("rig.import", { rigId: "rig-1", nodes: Array(257).fill({
      logicalId: "lead", status: "launched" }) })).toThrow("array");
  });
  it("hashes parsed YAML by stable keys, preserving arrays and behavior options", () => {
    const a = { kind: "rig.import" as const, targetIds: {},
      payload: parseOperationYaml("rig:\n  name: A\n  members: [lead, ui]\n"),
      options: { root: normalizedOperationRoot("/tmp/a/../a"), edges: ["lead->ui"] } };
    const b = { ...a, payload: parseOperationYaml("rig:\n  members: [lead, ui]\n  name: A\n") };
    expect(operationRequestHash(a)).toBe(operationRequestHash(b));
    expect(operationRequestHash({ ...a, payload: parseOperationYaml("rig:\n  name: A\n  members: [ui, lead]\n") })).not.toBe(operationRequestHash(a));
    expect(operationRequestHash({ ...a, options: { ...a.options, root: "/tmp/b" } })).not.toBe(operationRequestHash(a));
    expect(operationRequestHash({ ...a, options: { ...a.options, edges: ["ui->lead"] } })).not.toBe(operationRequestHash(a));
    expect(operationRequestHash({ ...a, targetIds: { rigId: "other" } })).not.toBe(operationRequestHash(a));
    expect(() => parseOperationYaml("a: 1\na: 2\n")).toThrow();
    expect(() => operationRequestHash({ ...a, payload: { bad: undefined } })).toThrow();
  });

  it("uses one durable reservation across database connections and never executes a replay", () => {
    const { db, path } = database();
    const other = new Database(path);
    try {
      const first = service(db);
      const second = service(other);
      const input = request();
      expect(first.reserve(input).kind).toBe("reserved");
      expect(second.reserve(input).kind).toBe("in_flight");
      for (const changed of [
        { ...input, kind: "rig.materialize" as const },
        { ...input, payload: { rig: { name: "B" } } },
        { ...input, options: { root: "/tmp/other", edges: ["lead->ui"] } },
      ]) expect(second.reserve(changed).kind).toBe("conflict");
      db.transaction(() => {
        db.prepare("INSERT INTO owned_effects VALUES ('rig-1')").run();
        first.commitEffectWithinTransaction({ operationId: input.operationId, step: "rig", kind: "rig",
          targetId: "rig-1", target: { rigId: "rig-1", nodeIds: [] }, effect: "committed", phase: "materialized" });
        first.completeWithinTransaction({ operationId: input.operationId, phase: "completed",
          target: { rigId: "rig-1", nodeIds: [] }, effect: "committed", external: "not_started",
          httpStatus: 201, result: { rigId: "rig-1" } });
      })();
      expect(second.reserve(input)).toMatchObject({ kind: "replayed", receipt: {
        state: "completed", originalHttpStatus: 201, result: { rigId: "rig-1" } } });
      expect(db.prepare("SELECT COUNT(*) AS n FROM owned_effects").get()).toEqual({ n: 1 });
    } finally { other.close(); db.close(); }
  });

  it("recovers zero-effect reservations as terminal and requires a new ID for execution", () => {
    const { db, path } = database();
    const input = request();
    service(db).reserve(input);
    db.close();
    const reopened = new Database(path);
    try {
      const next = service(reopened);
      expect(next.recoverInterrupted()).toBe(1);
      expect(next.reserve(input)).toMatchObject({ kind: "replayed", receipt: {
        state: "interrupted", effect: "none", external: "not_started",
        recovery: { code: "new_operation_required" } } });
      expect(next.reserve(request(randomUUID())).kind).toBe("reserved");
      expect(next.recoverInterrupted()).toBe(0);
    } finally { reopened.close(); }
  });

  it("rolls back its owning effect if evidence persistence fails", () => {
    const { db } = database();
    try {
      const ops = service(db);
      const input = request();
      ops.reserve(input);
      db.exec(`CREATE TRIGGER reject_operation_evidence BEFORE INSERT ON operation_effects
        BEGIN SELECT RAISE(FAIL, 'injected receipt failure'); END`);
      expect(() => db.transaction(() => {
        db.prepare("INSERT INTO owned_effects VALUES ('rig-1')").run();
        ops.commitEffectWithinTransaction({ operationId: input.operationId, step: "rig", kind: "rig",
          targetId: "rig-1", target: { rigId: "rig-1", nodeIds: [] }, effect: "committed", phase: "materialized" });
      })()).toThrow("injected receipt failure");
      expect(db.prepare("SELECT COUNT(*) AS n FROM owned_effects").get()).toEqual({ n: 0 });
      expect(ops.read(input.operationId)).toMatchObject({ state: "running", effect: "none", effects: [] });
    } finally { db.close(); }
  });

  it("retains committed identities, partial compensation, and uncertain external intent across boot", () => {
    const { db, path } = database();
    const ops = service(db);
    const input = request();
    ops.reserve(input);
    db.transaction(() => {
      db.prepare("INSERT INTO owned_effects VALUES ('rig-1')").run();
      ops.commitEffectWithinTransaction({ operationId: input.operationId, step: "rig", kind: "rig",
        targetId: "rig-1", evidence: { ids: ["rig-1"] }, target: { rigId: "rig-1", nodeIds: [] },
        effect: "partial", phase: "rig-created" });
      ops.commitEffectWithinTransaction({ operationId: input.operationId, step: "old-generation",
        kind: "archive", targetId: "rig-old",
        target: { rigId: "rig-1", nodeIds: [] }, effect: "partial", phase: "archived" });
      ops.commitEffectWithinTransaction({ operationId: input.operationId, step: "old-generation",
        kind: "archive", targetId: "rig-old", state: "compensated",
        target: { rigId: "rig-1", nodeIds: [] }, effect: "partial", phase: "compensating" });
    })();
    ops.beginExternalStep({ operationId: input.operationId, step: "launch:lead", kind: "external.launch",
      targetId: "node-lead", phase: "launching" });
    db.close();
    const reopened = new Database(path);
    try {
      const next = service(reopened);
      expect(next.recoverInterrupted()).toBe(1);
      expect(next.read(input.operationId)).toMatchObject({ state: "interrupted", effect: "partial",
        external: "indeterminate", target: { rigId: "rig-1", nodeIds: [] },
        recovery: { code: "inspect_external_uncertainty" },
        effects: [{ step: "rig", state: "committed" }, { step: "old-generation", state: "compensated" },
          { step: "launch:lead", state: "intent" }] });
      reopened.prepare("DELETE FROM owned_effects WHERE id = 'rig-1'").run();
      expect(next.read(input.operationId)?.target.rigId).toBe("rig-1");
      expect(next.reserve(input).kind).toBe("replayed");
    } finally { reopened.close(); }
  });

  it("rejects unsafe evidence and private result fields before terminal write", () => {
    const { db } = database();
    try {
      const ops = service(db);
      const input = request();
      ops.reserve(input);
      expect(() => ops.beginExternalStep({ operationId: input.operationId, step: "launch", kind: "external.launch",
        evidence: { ids: ["secret value with spaces"] }, phase: "launching" })).toThrow();
      expect(() => db.transaction(() => ops.completeWithinTransaction({ operationId: input.operationId,
        phase: "complete", target: { nodeIds: [] }, effect: "none", external: "not_requested",
        httpStatus: 400, result: { token: "raw-native-token" } }))()).toThrow("unrecognized");
      expect(() => db.transaction(() => ops.completeWithinTransaction({ operationId: input.operationId,
        phase: "complete", target: { nodeIds: [] }, effect: "none", external: "not_requested",
        httpStatus: 400, result: { rigId: "rig-1", unexpected: { data: "value" } } }))()).toThrow("unrecognized");
      expect(ops.read(input.operationId)?.state).toBe("running");
    } finally { db.close(); }
  });

  it("records observed external outcomes without claiming an unresolved sibling succeeded", () => {
    const { db } = database();
    try {
      const ops = service(db);
      const input = request();
      ops.reserve(input);
      ops.beginExternalStep({ operationId: input.operationId, step: "launch:lead", kind: "external.launch",
        targetId: "node-lead", phase: "launching" });
      ops.finishExternalStep({ operationId: input.operationId, step: "launch:lead", state: "observed",
        external: "completed", evidence: { ids: ["session-lead"] }, phase: "lead-launched" });
      expect(ops.read(input.operationId)).toMatchObject({ external: "completed",
        effects: [{ step: "launch:lead", state: "observed" }] });
      ops.beginExternalStep({ operationId: input.operationId, step: "launch:ui", kind: "external.launch",
        targetId: "node-ui", phase: "launching" });
      expect(() => db.transaction(() => ops.completeWithinTransaction({ operationId: input.operationId,
        phase: "complete", target: { nodeIds: [] }, effect: "none", external: "completed",
        httpStatus: 200, result: { code: "launch_uncertain" } }))()).toThrow("mismatch");
      db.transaction(() => ops.completeWithinTransaction({ operationId: input.operationId,
        phase: "complete", target: { nodeIds: [] }, effect: "none", external: "indeterminate",
        httpStatus: 207, result: { code: "launch_uncertain" } }))();
      expect(ops.read(input.operationId)).toMatchObject({ state: "completed", external: "indeterminate",
        originalHttpStatus: 207 });
    } finally { db.close(); }
  });

  it("rolls back topology when terminal receipt persistence fails in the same transaction", () => {
    const { db } = database();
    try {
      const ops = service(db);
      const input = request();
      ops.reserve(input);
      db.exec(`CREATE TRIGGER reject_operation_completion BEFORE UPDATE OF result_json ON operation_receipts
        BEGIN SELECT RAISE(FAIL, 'injected completion failure'); END`);
      expect(() => db.transaction(() => {
        db.prepare("INSERT INTO owned_effects VALUES ('rig-1')").run();
        ops.commitEffectWithinTransaction({ operationId: input.operationId, step: "rig", kind: "rig",
          targetId: "rig-1", target: { rigId: "rig-1", nodeIds: [] }, effect: "committed", phase: "materialized" });
        ops.completeWithinTransaction({ operationId: input.operationId, phase: "complete",
          target: { rigId: "rig-1", nodeIds: [] }, effect: "committed", external: "not_started",
          httpStatus: 201, result: { rigId: "rig-1" } });
      })()).toThrow("injected completion failure");
      expect(db.prepare("SELECT COUNT(*) AS n FROM owned_effects").get()).toEqual({ n: 0 });
      expect(ops.read(input.operationId)).toMatchObject({ state: "running", effect: "none", effects: [] });
    } finally { db.close(); }
  });

  it("keeps a prior incomplete external unit after a later unit completes and across restart", () => {
    const { db, path } = database();
    const ops = service(db);
    const input = request();
    ops.reserve(input);
    ops.beginExternalStep({ operationId: input.operationId, step: "launch:a", kind: "external.launch", phase: "launching" });
    ops.finishExternalStep({ operationId: input.operationId, step: "launch:a", state: "observed",
      external: "incomplete", phase: "launch-failed" });
    ops.beginExternalStep({ operationId: input.operationId, step: "launch:b", kind: "external.launch", phase: "launching" });
    ops.finishExternalStep({ operationId: input.operationId, step: "launch:b", state: "observed",
      external: "completed", phase: "launch-completed" });
    expect(ops.read(input.operationId)?.external).toBe("incomplete");
      expect(db.prepare("SELECT step, external_outcome FROM operation_effects ORDER BY step").all())
        .toEqual([{ step: "launch:a", external_outcome: "incomplete" },
          { step: "launch:b", external_outcome: "completed" }]);
    expect(() => db.transaction(() => ops.completeWithinTransaction({ operationId: input.operationId,
      phase: "complete", target: { nodeIds: [] }, effect: "none", external: "completed",
      httpStatus: 207, result: { code: "partial_launch" } }))()).toThrow("mismatch");
    db.close();
    const reopened = new Database(path);
    try {
      const next = service(reopened);
      next.recoverInterrupted();
      expect(next.read(input.operationId)).toMatchObject({ state: "interrupted", external: "incomplete" });
      expect(next.reserve(input).kind).toBe("replayed");
    } finally { reopened.close(); }
  });

  it("refuses nested external intent/outcome transactions so outer rollback cannot erase them", () => {
    const { db } = database();
    try {
      const ops = service(db);
      const input = request();
      ops.reserve(input);
      expect(() => db.transaction(() => ops.beginExternalStep({ operationId: input.operationId,
        step: "launch:a", kind: "external.launch", phase: "launching" }))()).toThrow("own_transaction");
      expect(ops.read(input.operationId)).toMatchObject({ external: "not_started", effects: [] });
      ops.beginExternalStep({ operationId: input.operationId, step: "launch:a",
        kind: "external.launch", phase: "launching" });
      expect(() => db.transaction(() => ops.finishExternalStep({ operationId: input.operationId,
        step: "launch:a", state: "observed", external: "completed", phase: "launched" }))()).toThrow("own_transaction");
      expect(ops.read(input.operationId)).toMatchObject({ external: "indeterminate",
        effects: [{ step: "launch:a", state: "intent" }] });
      ops.finishExternalStep({ operationId: input.operationId, step: "launch:a", state: "observed",
        external: "completed", phase: "launched" });
      expect(ops.read(input.operationId)?.external).toBe("completed");
    } finally { db.close(); }
  });

  it("preserves explicitly unknown topology effect with no durable topology step", () => {
    const { db, path } = database();
    const input = request();
    service(db).reserve(input);
    db.prepare("UPDATE operation_receipts SET effect = 'unknown' WHERE operation_id = ?").run(input.operationId);
    db.close();
    const reopened = new Database(path);
    try {
      const next = service(reopened);
      next.recoverInterrupted();
      expect(next.read(input.operationId)).toMatchObject({ state: "interrupted", effect: "unknown" });
    } finally { reopened.close(); }
  });

  it("adds empty receipt tables to a populated previous schema without changing owner rows", () => {
    const dir = mkdtempSync(join(tmpdir(), "openrig-operation-upgrade-"));
    dirs.push(dir);
    const path = join(dir, "upgrade.sqlite");
    const db = new Database(path);
    try {
      db.pragma("foreign_keys = ON");
      migrate(db, ALL_MIGRATIONS.filter((item) => item.name !== operationReceiptsSchema.name));
      db.prepare("INSERT INTO rigs (id, name) VALUES ('rig-before', 'Before')").run();
      db.prepare(`INSERT INTO nodes
        (id, rig_id, logical_id, codex_config_profile, permission_policy, policy_origin, policy_launch_posture)
        VALUES ('node-before', 'rig-before', 'lead', 'named', 'builtin:safe', 'builtin', 'floor')`).run();
      db.prepare(`INSERT INTO sessions
        (id, node_id, session_name, status, resume_type, resume_token, restore_policy)
        VALUES ('session-before', 'node-before', 'lead@Before', 'stopped', 'codex', 'native-token-before', 'resume_if_possible')`).run();
      const snapshotJson = JSON.stringify({ version: 1, sessions: [{ id: "session-before", resumeToken: "native-token-before" }] });
      db.prepare("INSERT INTO snapshots (id, rig_id, kind, data) VALUES (?, ?, ?, ?)")
        .run("snapshot-before", "rig-before", "manual", snapshotJson);
      db.prepare(`INSERT INTO node_permission_selections
        (node_id, runtime, mode, actor, reason) VALUES ('node-before', 'codex', 'default', 'fixture', 'prior choice')`).run();
      migrate(db, ALL_MIGRATIONS);
      expect(db.prepare("SELECT COUNT(*) AS n FROM operation_receipts").get()).toEqual({ n: 0 });
      expect(db.prepare("SELECT id, name FROM rigs WHERE id = 'rig-before'").get()).toEqual({ id: "rig-before", name: "Before" });
      expect(db.prepare("SELECT codex_config_profile FROM nodes WHERE id = 'node-before'").get())
        .toEqual({ codex_config_profile: "named" });
      expect(db.prepare("SELECT permission_policy, policy_origin, policy_launch_posture FROM nodes WHERE id = 'node-before'").get())
        .toEqual({ permission_policy: "builtin:safe", policy_origin: "builtin", policy_launch_posture: "floor" });
      expect(db.prepare("SELECT resume_type, resume_token FROM sessions WHERE id = 'session-before'").get())
        .toEqual({ resume_type: "codex", resume_token: "native-token-before" });
      expect(db.prepare("SELECT data FROM snapshots WHERE id = 'snapshot-before'").get())
        .toEqual({ data: snapshotJson });
      expect(db.prepare("SELECT mode FROM node_permission_selections WHERE node_id = 'node-before'").get())
        .toEqual({ mode: "default" });
    } finally { db.close(); }
    const reopened = new Database(path);
    try {
      expect(reopened.prepare("SELECT name FROM rigs WHERE id = 'rig-before'").get()).toEqual({ name: "Before" });
      expect(reopened.prepare("SELECT COUNT(*) AS n FROM operation_effects").get()).toEqual({ n: 0 });
      expect(reopened.prepare("SELECT resume_token FROM sessions WHERE id = 'session-before'").get())
        .toEqual({ resume_token: "native-token-before" });
      expect(reopened.prepare("SELECT data FROM snapshots WHERE id = 'snapshot-before'").get())
        .toEqual({ data: JSON.stringify({ version: 1, sessions: [{ id: "session-before", resumeToken: "native-token-before" }] }) });
      expect(reopened.prepare("SELECT permission_policy FROM nodes WHERE id = 'node-before'").get())
        .toEqual({ permission_policy: "builtin:safe" });
      expect(reopened.prepare("SELECT mode FROM node_permission_selections WHERE node_id = 'node-before'").get())
        .toEqual({ mode: "default" });
    } finally { reopened.close(); }
  });
});
