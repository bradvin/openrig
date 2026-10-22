import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { migrate } from "../src/db/migrate.js";
import { migrationsForFullTestDb } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { PodRepository } from "../src/domain/pod-repository.js";
import { OperationRepository } from "../src/domain/operation-repository.js";
import { OperationService } from "../src/domain/operation-service.js";

const SPEC = `version: "0.2"
name: receipt-consumer
pods:
  - id: desk
    label: Desk
    members:
      - id: lead
        agent_ref: "builtin:terminal"
        profile: none
        runtime: terminal
        cwd: /tmp
    edges: []
edges: []
`;

describe("operation receipt real consumer crash boundaries", () => {
  it.each(["reservation", "archive_create", "member_commit", "add_member_commit", "legacy_commit", "materialize_commit", "target_settings_commit", "external_outcome", "compensation", "terminal_result"] as const)(
    "recovers the %s boundary around consumer execution after SIGKILL", (boundary) => {
      const dir = mkdtempSync(join(tmpdir(), `openrig-consumer-${boundary}-`));
      try {
        const path = join(dir, "topology.sqlite");
        const initial = new Database(path);
        migrate(initial, migrationsForFullTestDb);
        const rigs = new RigRepository(initial);
        let priorId = "", targetId = "";
        if (boundary === "archive_create" || boundary === "compensation") {
          priorId = rigs.createRig("receipt-consumer").id;
        }
        if (boundary === "add_member_commit" || boundary === "target_settings_commit") {
          targetId = rigs.createRig("receipt-consumer").id;
          if (boundary === "add_member_commit") new PodRepository(initial).createPod(targetId, "desk", "Desk");
        }
        initial.close();
        const id = randomUUID();
        const kind = boundary === "add_member_commit" ? "member.add"
          : boundary === "materialize_commit" || boundary === "target_settings_commit" ? "rig.materialize" : "rig.import";
        const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
          import Database from "better-sqlite3";
          import { RigRepository } from "./packages/daemon/src/domain/rig-repository.ts";
          import { PodRepository } from "./packages/daemon/src/domain/pod-repository.ts";
          import { SessionRegistry } from "./packages/daemon/src/domain/session-registry.ts";
          import { EventBus } from "./packages/daemon/src/domain/event-bus.ts";
          import { NodeLauncher } from "./packages/daemon/src/domain/node-launcher.ts";
          import { StartupOrchestrator } from "./packages/daemon/src/domain/startup-orchestrator.ts";
          import { PodRigInstantiator, RigInstantiator } from "./packages/daemon/src/domain/rigspec-instantiator.ts";
          import { RigSpecPreflight } from "./packages/daemon/src/domain/rigspec-preflight.ts";
          import { OperationRepository } from "./packages/daemon/src/domain/operation-repository.ts";
          import { OperationService } from "./packages/daemon/src/domain/operation-service.ts";
          const [path, id, boundary, targetId, root, spec] = process.argv.slice(1);
          const db = new Database(path); db.pragma("foreign_keys = ON");
          const rigRepo = new RigRepository(db), podRepo = new PodRepository(db);
          const sessionRegistry = new SessionRegistry(db), eventBus = new EventBus(db);
          const tmux = {
            createSession: async () => ({ ok: true }), killSession: async () => ({ ok: true }),
            sendText: async () => ({ ok: true }), sendKeys: async () => ({ ok: true }),
            hasSession: async () => false, probeSession: async () => ({ state: "absent" }),
            listSessions: async () => [], listWindows: async () => [], listPanes: async () => [],
          };
          const nodeLauncher = new NodeLauncher({ db, rigRepo, sessionRegistry, eventBus, tmuxAdapter: tmux });
          const startupOrchestrator = new StartupOrchestrator({ db, sessionRegistry, eventBus, tmuxAdapter: tmux });
          const adapter = { runtime: "terminal", listInstalled: async () => [],
            project: async () => ({ projected: [], skipped: [], failed: [] }),
            deliverStartup: async () => ({ delivered: 0, failed: [] }),
            checkReady: async () => ({ ready: true }), launchHarness: async () => ({ ok: true }) };
          const inst = new PodRigInstantiator({ db, rigRepo, podRepo, sessionRegistry, eventBus,
            nodeLauncher, startupOrchestrator, tmuxAdapter: tmux,
            fsOps: { readFile: () => "", exists: () => false }, adapters: { terminal: adapter } });
          const legacy = new RigInstantiator({ db, rigRepo, sessionRegistry, eventBus, nodeLauncher,
            preflight: new RigSpecPreflight({ rigRepo, tmuxAdapter: tmux,
              exec: async () => "", cmuxExec: async () => "" }) });
          const ops = new OperationService(new OperationRepository(db));
          const payload = boundary === "add_member_commit" ? { member: { id: "lead" } } : { name: "receipt-consumer" };
          const targetIds = boundary === "add_member_commit" ? { rigId: targetId, podNamespace: "desk" }
            : boundary === "target_settings_commit" ? { rigId: targetId } : {};
          ops.reserve({ operationId: id, kind: boundary === "add_member_commit" ? "member.add"
              : boundary === "materialize_commit" || boundary === "target_settings_commit" ? "rig.materialize" : "rig.import",
            targetIds, payload, options: { root }, expectsExternal: true });
          const operation = { service: ops, operationId: id };
          const kill = () => process.kill(process.pid, "SIGKILL");
          if (boundary === "reservation") kill();
          if (boundary === "archive_create") {
            const original = podRepo.createPod.bind(podRepo);
            podRepo.createPod = (...args) => { kill(); return original(...args); };
          }
          if (boundary === "member_commit" || boundary === "add_member_commit" || boundary === "legacy_commit") {
            const original = ops.beginExternalStep.bind(ops);
            ops.beginExternalStep = (input) => {
              if (input.step === (boundary === "legacy_commit" ? "launch:worker" : "launch:desk.lead")) kill();
              return original(input);
            };
          }
          if (boundary === "external_outcome") {
            const original = ops.finishExternalStep.bind(ops);
            ops.finishExternalStep = (input) => { original(input); if (input.step === "launch:desk.lead") kill(); };
          }
          let outcome;
          if (boundary === "add_member_commit") {
            outcome = await inst.addMemberToPod(targetId, "desk", { id: "lead", agent_ref: "builtin:terminal",
              profile: "none", runtime: "terminal", cwd: "/tmp" }, root, { operation });
          } else if (boundary === "legacy_commit") {
            outcome = await legacy.instantiate({ schemaVersion: 1, name: "receipt-consumer", version: "1.0.0",
              nodes: [{ id: "worker", runtime: "claude-code", role: "worker", cwd: "/tmp" }], edges: [] },
              { operation });
          } else if (boundary === "materialize_commit" || boundary === "target_settings_commit") {
            outcome = await inst.materialize(boundary === "target_settings_commit"
              ? spec.replace("pods:\\n", "permission_policy: builtin:locked\\npods:\\n") : spec,
              root, { operation, ...(boundary === "target_settings_commit" ? { targetRigId: targetId } : {}) });
          } else {
            outcome = await inst.instantiate(spec, root, { operation,
              ...(boundary === "compensation" ? { prelaunchHook: async () => ({ ok: false,
                code: "service_boot_failed", message: "fixture refusal" }) } : {}) });
          }
          if (boundary === "terminal_result") {
            if (!outcome.ok) throw new Error(JSON.stringify(outcome));
            db.transaction(() => {
              const current = ops.read(id);
              ops.completeWithinTransaction({ operationId: id, phase: "completed", target: current.target,
                effect: current.effect, external: current.external, httpStatus: 201,
                result: { rigId: outcome.result.rigId, specName: "receipt-consumer", nodes: [] } });
            }).immediate();
          }
          kill();
        `, path, id, boundary, targetId, dir, SPEC], { cwd: process.cwd(),
          env: { ...process.env, HOME: dir, OPENRIG_HOME: dir, CODEX_HOME: join(dir, ".codex") },
          encoding: "utf8", timeout: 20_000 });
        expect(child.signal, child.stderr || child.stdout).toBe("SIGKILL");
        const reopened = new Database(path);
        try {
          const next = new OperationService(new OperationRepository(reopened));
          expect(next.recoverInterrupted()).toBe(boundary === "terminal_result" ? 0 : 1);
          const receipt = next.read(id)!;
          expect(receipt.state).toBe(boundary === "terminal_result" ? "completed" : "interrupted");
          expect(next.reserve({ operationId: id, kind, targetIds: boundary === "add_member_commit"
            ? { rigId: targetId, podNamespace: "desk" }
            : boundary === "target_settings_commit" ? { rigId: targetId } : {}, payload: boundary === "add_member_commit"
              ? { member: { id: "lead" } } : { name: "receipt-consumer" }, options: { root: dir },
          expectsExternal: true }).kind).toBe("replayed");
          const rows = reopened.prepare("SELECT id, archived_at FROM rigs WHERE name = ?")
            .all("receipt-consumer") as Array<{ id: string; archived_at: string | null }>;
          if (boundary === "archive_create") {
            expect(rows).toHaveLength(2);
            expect(rows.find((row) => row.id === priorId)?.archived_at).not.toBeNull();
            expect(receipt.effects.map((effect) => effect.step)).toEqual(expect.arrayContaining(["rig", `archive:${priorId}`]));
          } else if (boundary === "compensation") {
            expect(rows).toEqual([{ id: priorId, archived_at: null }]);
            expect(receipt.effect).toBe("rolled_back");
          } else if (boundary === "reservation") {
            expect(rows).toHaveLength(0);
            expect(receipt.effect).toBe("none");
          } else {
            expect(rows).toHaveLength(1);
          }
          if (boundary === "member_commit" || boundary === "add_member_commit" || boundary === "external_outcome"
            || boundary === "legacy_commit" || boundary === "materialize_commit") {
            expect(reopened.prepare("SELECT COUNT(*) AS n FROM nodes WHERE logical_id = ?")
              .get(boundary === "legacy_commit" ? "worker" : "desk.lead"))
              .toEqual({ n: 1 });
            expect(receipt.target.nodeIds).toHaveLength(1);
          }
          if (boundary === "external_outcome") {
            expect(receipt.effects.find((effect) => effect.step === "launch:desk.lead"))
              .toMatchObject({ state: "observed", externalOutcome: "completed" });
          }
          if (boundary === "target_settings_commit") {
            expect(receipt.effects).toEqual(expect.arrayContaining([expect.objectContaining({
              step: "config:target_rig", kind: "config.rig", targetId, state: "committed" })]));
            expect(new RigRepository(reopened).getRigPermissionPolicy(targetId)).toBe("builtin:locked");
          }
          if (boundary === "terminal_result") expect(receipt.originalHttpStatus).toBe(201);
        } finally { reopened.close(); }
      } finally { rmSync(dir, { recursive: true, force: true }); }
    },
  );
});
