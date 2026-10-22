import fs from "node:fs";
import { Hono } from "hono";
import type { Context } from "hono";
import type { RigSpecExporter } from "../domain/rigspec-exporter.js";
import type { RigInstantiator, PodRigInstantiator } from "../domain/rigspec-instantiator.js";
import type { RigSpecPreflight } from "../domain/rigspec-preflight.js";
import type { RigRepository } from "../domain/rig-repository.js";
import { LegacyRigSpecCodec } from "../domain/rigspec-codec.js";
import { RigSpecCodec } from "../domain/rigspec-codec.js";
import { LegacyRigSpecSchema } from "../domain/rigspec-schema.js";
import { RigSpecSchema } from "../domain/rigspec-schema.js";
import { rigPreflight } from "../domain/rigspec-preflight.js";
import { RigNotFoundError } from "../domain/errors.js";
import { runtimeVersionProbeCwd } from "../adapters/preflight-exec.js";
import { execRuntimeProbe } from "../adapters/runtime-probe-exec.js";
import { RigSpecParseError, validateRigSpecImport } from "../domain/spec-validation-service.js";
import { normalizedOperationRoot, parseOperationYaml } from "../domain/operation-service.js";
import { operationValidationFields } from "../domain/operation-public-result.js";
import { completeOperationHttp, operationFailureHttp, operationHttp, operationId, operationService, reservationHttp } from "./operations.js";
import { runOperationMutation } from "../domain/operation-mutation-lane.js";

export const rigspecImportRoutes = new Hono();

function getDeps(c: { get: (key: string) => unknown }) {
  return {
    exporter: c.get("rigSpecExporter" as never) as RigSpecExporter,
    instantiator: c.get("rigInstantiator" as never) as RigInstantiator,
    preflight: c.get("rigSpecPreflight" as never) as RigSpecPreflight,
    podInstantiator: c.get("podInstantiator" as never) as PodRigInstantiator,
    rigRepo: c.get("rigRepo" as never) as RigRepository,
  };
}

// GET /api/rigs/:rigId/spec -> YAML
export function handleExportYaml(c: Context): Response {
  const rigId = c.req.param("rigId")!;
  const { exporter, rigRepo } = getDeps(c);

  try {
    const spec = exporter.exportRig(rigId);
    // Detect format: pod-aware RigSpec has `pods`, legacy has `schemaVersion`
    const isPodAware = "pods" in spec;
    const serialized = isPodAware
      ? RigSpecCodec.serialize(spec as import("../domain/types.js").RigSpec)
      : LegacyRigSpecCodec.serialize(spec as import("../domain/types.js").LegacyRigSpec);
    // Seats whose launch additions this export doesn't carry are named at the top of the file.
    const notCarried = exporter.launchAdditionsNotCarried(rigId)
      .map((seat) => `# Not carried: ${seat}'s launch additions (agent_file, append_system_prompt_file, plugin_dirs); add them back by hand.\n`);
    const yaml = notCarried.join("") + serialized;
    const startupLayers = rigRepo.getRigStartupLayers(rigId);
    const headers: Record<string, string> = { "Content-Type": "text/yaml" };
    if (startupLayers?.root) {
      headers["X-Rig-Root"] = encodeURIComponent(startupLayers.root);
    }
    return new Response(yaml, {
      status: 200,
      headers,
    });
  } catch (err) {
    if (err instanceof RigNotFoundError) {
      return c.json({ error: err.message }, 404);
    }
    return c.json({ error: "Export failed" }, 500);
  }
}

// GET /api/rigs/:rigId/spec.json -> JSON
export function handleExportJson(c: Context): Response {
  const rigId = c.req.param("rigId")!;
  const { exporter } = getDeps(c);

  try {
    const spec = exporter.exportRig(rigId);
    return c.json(spec);
  } catch (err) {
    if (err instanceof RigNotFoundError) {
      return c.json({ error: err.message }, 404);
    }
    return c.json({ error: "Export failed" }, 500);
  }
}

// POST /api/rigs/import -> instantiate from YAML
rigspecImportRoutes.post("/", async (c) => {
  const { instantiator, podInstantiator } = getDeps(c);
  const body = await c.req.text();

  let raw: unknown;
  try {
    raw = RigSpecCodec.parse(body);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: message, errors: [message] }, 400);
  }

  const isPodAware = raw && typeof raw === "object" && Array.isArray((raw as Record<string, unknown>).pods);
  const requestedId = operationId(c);

  if (isPodAware) {
    const rigRoot = c.req.header("X-Rig-Root");
    if (!rigRoot) return c.json({ error: "X-Rig-Root header required for pod-aware specs", code: "missing_rig_root" }, 400);
    const cwdOverride = c.req.header("X-Cwd-Override") ?? undefined;

    const operations = requestedId === undefined ? undefined : operationService(c);
    if (operations && requestedId !== undefined) {
      let reservation;
      try {
        reservation = operations.reserve({ operationId: requestedId, kind: "rig.import",
          targetIds: {}, payload: parseOperationYaml(body),
          options: { rigRoot: normalizedOperationRoot(rigRoot),
            ...(cwdOverride === undefined ? {} : { cwdOverride: normalizedOperationRoot(cwdOverride) }) }, expectsExternal: true });
      } catch { return c.json({ error: "invalid_operation_request" }, 400); }
      const prior = reservationHttp(reservation);
      if (prior) return prior;
    }

    const importWork = () => podInstantiator.instantiate(body, rigRoot, { cwdOverride,
      ...(operations && requestedId !== undefined ? { operation: { service: operations, operationId: requestedId } } : {}) });
    let outcome;
    try { outcome = operations && requestedId !== undefined
      ? await runOperationMutation(operations.repository.db,
        `name:${typeof (raw as Record<string, unknown>).name === "string" ? (raw as Record<string, unknown>).name : requestedId}`,
        importWork) : await importWork(); }
    catch (error) {
      if (operations && requestedId !== undefined) return operationFailureHttp(operations, requestedId);
      throw error;
    }
    if (operations && requestedId !== undefined) {
      const status = outcome.ok ? 201 : outcome.code === "validation_failed" || outcome.code === "cycle_error" ? 400
        : outcome.code === "preflight_failed" || outcome.code === "rig_name_running"
          || outcome.code === "generation_unconfirmed" || outcome.code === "compose_project_conflict" ? 409 : 500;
      const result = outcome.ok
        ? { rigId: outcome.result.rigId, specName: outcome.result.specName,
          specVersion: outcome.result.specVersion,
          nodes: outcome.result.nodes.map((node) => ({ logicalId: node.logicalId, status: node.status })) }
        : { code: outcome.code, ...((outcome.code === "validation_failed" || outcome.code === "preflight_failed") && "errors" in outcome
          ? { errors: operationValidationFields(outcome.errors) } : {}) };
      return completeOperationHttp(operations, requestedId, status, result);
    }
    if (!outcome.ok) {
      const status = outcome.code === "validation_failed" ? 400
        : outcome.code === "preflight_failed" ? 409
        : outcome.code === "cycle_error" ? 400
        // S5b final-fix F1: the running-name guard refusal is a conflict on the
        // direct instantiation route too — never a 500 (map consistency).
        : outcome.code === "rig_name_running" ? 409
        // #141: an import refused because a same-name rig could not be confirmed stopped.
        : outcome.code === "generation_unconfirmed" ? 409
        // A Compose project conflict is an actionable request conflict, not a server failure.
        : outcome.code === "compose_project_conflict" ? 409
        : 500;
      const body = outcome.code === "rig_name_running" || outcome.code === "generation_unconfirmed" || outcome.code === "compose_project_conflict"
        ? { ...outcome, error: outcome.message }
        : outcome;
      return c.json(body, status);
    }
    return c.json(outcome.result, 201);
  }

  // Legacy path
  const operations = requestedId === undefined ? undefined : operationService(c);
  if (operations && requestedId !== undefined) {
    let reservation;
    try {
      reservation = operations.reserve({ operationId: requestedId, kind: "rig.import",
        targetIds: {}, payload: parseOperationYaml(body), options: {}, expectsExternal: true });
    } catch { return c.json({ error: "invalid_operation_request" }, 400); }
    const prior = reservationHttp(reservation);
    if (prior) return prior;
  }
  let spec;
  try {
    spec = LegacyRigSpecSchema.normalize(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (operations && requestedId !== undefined) {
      const receipt = operations.repository.db.transaction(() => {
        operations.completeWithinTransaction({ operationId: requestedId, phase: "completed",
          target: { nodeIds: [] }, effect: "none", external: "not_started",
          httpStatus: 400, result: { code: "validation_failed", errors: operationValidationFields([message]) } });
        return operations.read(requestedId)!;
      }).immediate();
      return operationHttp(receipt, 400);
    }
    return c.json({ error: message, errors: [message] }, 400);
  }

  const legacyWork = () => instantiator.instantiate(spec,
    operations && requestedId !== undefined ? { operation: { service: operations, operationId: requestedId } } : undefined);
  let outcome;
  try { outcome = operations && requestedId !== undefined
    ? await runOperationMutation(operations.repository.db, `name:${spec.name}`, legacyWork)
    : await legacyWork(); }
  catch (error) {
    if (operations && requestedId !== undefined) return operationFailureHttp(operations, requestedId);
    throw error;
  }
  if (operations && requestedId !== undefined) {
    const status = outcome.ok ? 201 : outcome.code === "validation_failed" ? 400
      : outcome.code === "preflight_failed" || outcome.code === "rig_name_running" ? 409 : 500;
    const result = outcome.ok
      ? { rigId: outcome.result.rigId, specName: outcome.result.specName,
        specVersion: outcome.result.specVersion,
        nodes: outcome.result.nodes.map((node) => ({ logicalId: node.logicalId, status: node.status })) }
      : { code: outcome.code, ...((outcome.code === "validation_failed" || outcome.code === "preflight_failed") && "errors" in outcome
        ? { errors: operationValidationFields(outcome.errors) } : {}) };
    return completeOperationHttp(operations, requestedId, status, result);
  }
  if (!outcome.ok) {
    const status = outcome.code === "validation_failed" ? 400
      : outcome.code === "preflight_failed" ? 409
      : outcome.code === "rig_name_running" ? 409
      : 500;
    const body = outcome.code === "rig_name_running"
      ? { ...outcome, error: outcome.message }
      : outcome;
    return c.json(body, status);
  }
  return c.json(outcome.result, 201);
});

// POST /api/rigs/import/workspace -> apply only a validated workspace declaration
rigspecImportRoutes.post("/workspace", async (c) => {
  const { rigRepo } = getDeps(c);
  const targetRigId = c.req.header("X-Target-Rig-Id");
  if (!targetRigId) {
    return c.json({ ok: false, code: "target_rig_required", error: "X-Target-Rig-Id header required for workspace-only apply" }, 400);
  }

  const body = await c.req.text();
  let raw: unknown;
  try {
    raw = RigSpecCodec.parse(body);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ ok: false, code: "validation_failed", errors: [message] }, 400);
  }

  const workspace = raw && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)["workspace"]
    : undefined;
  if (workspace === undefined || workspace === null) {
    return c.json({ ok: false, code: "workspace_required", errors: ["workspace: required for workspace-only apply"] }, 400);
  }

  const validation = RigSpecSchema.validateWorkspace(workspace);
  if (!validation.valid) {
    return c.json({ ok: false, code: "validation_failed", errors: validation.errors }, 400);
  }

  const normalizedWorkspace = RigSpecSchema.normalizeWorkspace(workspace)!;
  if (!rigRepo.getRig(targetRigId)) {
    return c.json({ ok: false, code: "target_rig_not_found", error: `Rig not found: ${targetRigId}` }, 404);
  }

  const current = rigRepo.getRigWorkspace(targetRigId);
  const changed = JSON.stringify(current) !== JSON.stringify(normalizedWorkspace);
  if (changed) rigRepo.setRigWorkspace(targetRigId, normalizedWorkspace);

  return c.json({ rigId: targetRigId, changed, workspace: normalizedWorkspace });
});

// POST /api/rigs/import/materialize -> create rig topology without launching
rigspecImportRoutes.post("/materialize", async (c) => {
  const { podInstantiator } = getDeps(c);
  const body = await c.req.text();

  let raw: unknown;
  try {
    raw = RigSpecCodec.parse(body);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: message, errors: [message] }, 400);
  }

  const isPodAware = raw && typeof raw === "object" && Array.isArray((raw as Record<string, unknown>).pods);
  if (!isPodAware) {
    return c.json({ error: "materialize-only requires a pod-aware RigSpec", code: "pod_aware_required" }, 400);
  }

  const rigRoot = c.req.header("X-Rig-Root");
  if (!rigRoot) return c.json({ error: "X-Rig-Root header required for pod-aware specs", code: "missing_rig_root" }, 400);

  const targetRigId = c.req.header("X-Target-Rig-Id") ?? undefined;
  const cwdOverride = c.req.header("X-Cwd-Override") ?? undefined;
  const requestedId = operationId(c);
  const operations = requestedId === undefined ? undefined : operationService(c);
  if (operations && requestedId !== undefined) {
    let reservation;
    try {
      reservation = operations.reserve({ operationId: requestedId, kind: "rig.materialize",
        targetIds: targetRigId === undefined ? {} : { rigId: targetRigId },
        payload: parseOperationYaml(body), options: { rigRoot: normalizedOperationRoot(rigRoot),
          ...(cwdOverride === undefined ? {} : { cwdOverride: normalizedOperationRoot(cwdOverride) }),
          ...(targetRigId === undefined ? {} : { targetRigId }) }, expectsExternal: true });
    } catch { return c.json({ error: "invalid_operation_request" }, 400); }
    const prior = reservationHttp(reservation);
    if (prior) return prior;
  }
  const materializeWork = () => podInstantiator.materialize(body, rigRoot, { targetRigId, cwdOverride,
    ...(operations && requestedId !== undefined ? { operation: { service: operations, operationId: requestedId } } : {}) });
  let outcome;
  try { outcome = operations && requestedId !== undefined
    ? await runOperationMutation(operations.repository.db,
      targetRigId ? `rig:${targetRigId}` : `name:${typeof (raw as Record<string, unknown>).name === "string" ? (raw as Record<string, unknown>).name : requestedId}`,
      materializeWork) : await materializeWork(); }
  catch (error) {
    if (operations && requestedId !== undefined) return operationFailureHttp(operations, requestedId);
    throw error;
  }
  const status = outcome.ok ? 201 : outcome.code === "validation_failed" ? 400
    : outcome.code === "preflight_failed" ? 409
    : outcome.code === "target_rig_not_found" ? 404
    : outcome.code === "materialize_conflict" || outcome.code === "rig_name_running" ? 409 : 500;
  if (operations && requestedId !== undefined) {
    const result = outcome.ok
      ? { rigId: outcome.result.rigId, specName: outcome.result.specName,
        specVersion: outcome.result.specVersion,
        nodes: outcome.result.nodes.map((node) => ({ logicalId: node.logicalId, status: "materialized" })) }
      : { code: outcome.code, ...((outcome.code === "validation_failed" || outcome.code === "preflight_failed") && "errors" in outcome
        ? { errors: operationValidationFields(outcome.errors) } : {}) };
    return completeOperationHttp(operations, requestedId, status, result);
  }
  if (!outcome.ok) {
    const body = outcome.code === "rig_name_running"
      ? { ...outcome, error: outcome.message }
      : outcome;
    return c.json(body, status);
  }
  return c.json(outcome.result, 201);
});

// POST /api/rigs/import/validate -> validate only (auto-detects format)
rigspecImportRoutes.post("/validate", async (c) => {
  const body = await c.req.text();
  try {
    return c.json(validateRigSpecImport(body));
  } catch (err) {
    if (!(err instanceof RigSpecParseError)) throw err;
    return c.json({ valid: false, errors: [err.message] }, 400);
  }
});

// POST /api/rigs/import/preflight -> validate + preflight (auto-detects format)
rigspecImportRoutes.post("/preflight", async (c) => {
  const { preflight, podInstantiator } = getDeps(c);
  const body = await c.req.text();

  let raw: unknown;
  try {
    raw = RigSpecCodec.parse(body);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ valid: false, errors: [message] }, 400);
  }

  const isPodAware = raw && typeof raw === "object" && Array.isArray((raw as Record<string, unknown>).pods);
  if (isPodAware) {
    const rigRoot = c.req.header("X-Rig-Root");
    if (!rigRoot) return c.json({ ready: false, errors: ["X-Rig-Root header required for pod-aware specs"], warnings: [] }, 400);
    const cwdOverride = c.req.header("X-Cwd-Override") ?? undefined;
    const fsOps = { readFile: (p: string) => fs.readFileSync(p, "utf-8"), exists: (p: string) => fs.existsSync(p) };
    const exec = (cmd: string) => execRuntimeProbe("rigspec.import.preflight", cmd, { cwd: runtimeVersionProbeCwd(cmd) });
    const result = await rigPreflight({
      rigSpecYaml: body,
      rigRoot,
      cwdOverride,
      fsOps,
      skillsRoot: podInstantiator.resolveSkillsRoot?.(),
      exec,
    });
    return c.json(result);
  }

  // Legacy
  let spec;
  try {
    spec = LegacyRigSpecSchema.normalize(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ valid: false, errors: [message] }, 400);
  }

  const result = await preflight.check(spec);
  return c.json(result);
});
