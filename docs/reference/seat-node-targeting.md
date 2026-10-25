# Seat settings by node ID

Clients that present a specific seat can save its later-launch settings using its durable `nodeId`. The node ID is distinct from the current session and native conversation. These routes never launch, stop, or resume the seat.

| Read or save | Node-addressed route |
| --- | --- |
| Status | `GET /api/seat/status/node/:nodeId` |
| Native permissions | `POST /api/seat/set-permissions/node/:nodeId` |
| Permission policy | `POST /api/seat/set-policy/node/:nodeId` |
| Model | `POST /api/seat/set-model/node/:nodeId` |
| Effort | `POST /api/seat/set-effort/node/:nodeId` |

The POST bodies and responses follow the corresponding name-addressed routes. A successful save's `seat.nodeId` and `seat.rigId` identify the node actually updated. The exact status response adds `node_id`, `contract: "seat-node.v1"`, and `supported_actions` listing the four setters. Existing name status responses retain their shape.

An unknown, deleted, or archived node returns `seat_not_found` (HTTP 404) when checked by node resolution or the write transaction. The daemon rechecks that node inside the transaction, including when the requested value is unchanged. A runtime or launch-directory change caught by that check returns `selection_changed` (HTTP 409). An asynchronous native validation may refuse first under its existing error code; for example, Claude's managed context guard reports `permission_selection_refused` if the occupant generation changes while it checks a permission mode. No setting is saved after either refusal. The daemon never resolves a node ID through a reusable seat name. Setting writes have no general session precondition: a changed occupant on the same eligible node can receive a later save, while a native validation in progress can require a fresh request against the new context.

For example, `POST /api/seat/set-model/node/<nodeId>` accepts the existing `{ "model": "...", "reason": "...", "operator": "..." }` body. The existing audit actor, reason, native validation, permission precedence, and terminal policy rules still apply. The older `/:seatRef` routes remain available, including their name ambiguity behavior.
