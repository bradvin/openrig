# Durable create and import receipts

The daemon accepts an optional `X-OpenRig-Operation-Id` UUID on `POST /api/rigs`,
`POST /api/rigs/import`, `POST /api/rigs/import/materialize`, and
`POST /api/rigs/:rigId/pods/:podNamespace/members`. A call without the header uses
its existing response and execution path. An operation-bearing call returns
`{operation, result?}` and stores its outcome before responding. The saved
`result` is a bounded public projection of the original outcome; use the normal
rig and node reads for detailed current state. The ID belongs to one parsed
request, including its target and resolution options.
Validation and preflight refusals retain their HTTP status, code, and structural error fields
in the receipt. The stored field summaries omit values from a spec, environment,
path, or preflight message; an unrecognized field is reported as `request: invalid`.
Detect support with `GET /api/operations/capabilities`, which returns the
`operations.v1` contract and its four supported mutation kinds. CLI commands
using `--operation-id` check this response before sending a write, since an
older daemon may ignore an unknown operation header.

Use `GET /api/operations/:operationId` or `rig operation get <uuid> --json` after
a lost response. The lookup only reads the receipt. An identical completed
request replays with HTTP 200 and `replayed: true`; an identical request still
running returns HTTP 202 and a `Location` header. Reusing an ID with a changed
request returns HTTP 409 `operation_id_conflict`. Unknown IDs return HTTP 404.
An interrupted ID is terminal even if no effect was recorded: inspect its
receipt and use a new UUID for any separate recovery action.
`rig operation get` exits successfully when it finds a receipt, even if the
original mutation failed. Mutation commands using `--operation-id` exit nonzero
for a failed replay or a running/interrupted receipt without a completed result.

The receipt's `effect` describes saved topology changes, while `external`
describes recorded launch, projection, and cleanup units. `indeterminate` means
the daemon saved intent before the external call but cannot prove the call's
outcome. It never automatically repeats such a unit. A receipt remains readable
after its rig or member is deliberately removed; it does not claim the resource
still exists or the agent is currently healthy.

The CLI accepts `--operation-id <uuid>` on `rig create`, `rig import
--instantiate`, `rig import --materialize-only`, and `rig add`. Persist that UUID
alongside the selected daemon/database identity. The daemon computes the request
hash; the caller does not provide one. For YAML, object key order is irrelevant,
but array order, scalar values, target IDs, and behavior-changing resolution
options are significant. A changed referenced file does not make a saved ID
execute again. Submit a new request and UUID when intentionally using changed
source material.
