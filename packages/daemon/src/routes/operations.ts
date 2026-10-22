import { Hono } from "hono";
import type { Context } from "hono";
import type { OperationReceipt } from "../operation-surface.js";
import type { OperationService, Reservation } from "../domain/operation-service.js";

export const operationRoutes = new Hono();

export function operationService(c: Context): OperationService {
  return c.get("operationService" as never) as OperationService;
}

export function operationId(c: Context): string | undefined {
  const value = c.req.header("X-OpenRig-Operation-Id");
  return value === undefined ? undefined : value;
}

export function operationHttp(receipt: OperationReceipt, status: number, replayed = false): Response {
  return new Response(JSON.stringify({ operation: receipt,
    ...(receipt.result === undefined ? {} : { result: receipt.result }),
    ...(replayed ? { replayed: true } : {}) }), {
    status, headers: { "content-type": "application/json; charset=UTF-8",
      location: `/api/operations/${encodeURIComponent(receipt.operationId)}` },
  });
}

export function reservationHttp(reservation: Reservation): Response | null {
  if (reservation.kind === "reserved") return null;
  if (reservation.kind === "conflict") return new Response(JSON.stringify({
    error: "operation_id_conflict", operation: reservation.receipt,
  }), { status: 409, headers: { "content-type": "application/json; charset=UTF-8" } });
  return operationHttp(reservation.receipt, reservation.kind === "in_flight" ? 202 : 200,
    reservation.kind === "replayed");
}

export function operationFailureHttp(service: OperationService, operationId: string,
  status = 500): Response {
  const receipt = service.repository.db.transaction(() => {
    const current = service.read(operationId)!;
    service.completeWithinTransaction({ operationId, phase: "failed", target: current.target,
      effect: current.effect, external: current.external, httpStatus: status,
      result: { code: "operation_failed" } });
    return service.read(operationId)!;
  }).immediate();
  return operationHttp(receipt, status);
}

/** Complete after a multi-transaction mutation; a result-write fault must not strand this boot's ID. */
export function completeOperationHttp(service: OperationService, operationId: string,
  status: number, result: unknown): Response {
  let receipt: OperationReceipt;
  try {
    receipt = service.repository.db.transaction(() => {
      const current = service.read(operationId)!;
      service.completeWithinTransaction({ operationId, phase: "completed", target: current.target,
        effect: current.effect, external: current.external, httpStatus: status, result });
      return service.read(operationId)!;
    }).immediate();
  } catch {
    return operationFailureHttp(service, operationId);
  }
  return operationHttp(receipt, status);
}

operationRoutes.get("/capabilities", (c) => c.json({ contract: "operations.v1",
  kinds: ["rig.create", "rig.import", "rig.materialize", "member.add"] }));

operationRoutes.get("/:operationId", (c) => {
  let receipt: OperationReceipt | null;
  try { receipt = operationService(c).read(c.req.param("operationId")); }
  catch { return c.json({ error: "invalid_operation_id" }, 400); }
  if (!receipt) return c.json({ error: "operation_not_found" }, 404);
  return c.json({ operation: receipt,
    ...(receipt.result === undefined ? {} : { result: receipt.result }) });
});
