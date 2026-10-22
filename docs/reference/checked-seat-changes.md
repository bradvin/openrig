# Checked seat changes

`rig seat review` reads the current seat and native-history selection before a
stop or permission change. The review is a snapshot for comparison, not a lock.
Its `seat-review.v1` token identifies the rig and node,
the latest session, a revision of relevant persisted state, and—when available—a
hash of the native resume token. It never returns a raw native token.
The revision covers relevant rig and seat settings, native permission selection,
session history, binding and persisted startup context; it excludes volatile
polling state. Identical relevant state can produce the same revision again.
Live-state observations do not prevent change.

Save the complete JSON response so the CLI can pass its nested `review` token:

```sh
rig seat review <seat> --json > seat-review.json
```

Use that file on the action you intend to take:

```sh
rig seat stop <seat> --reason <text> --expected-file seat-review.json
rig seat set-permissions <seat> --mode <mode> --reason <text> --expected-file seat-review.json
rig policy apply <policy> --seat <seat> --reason <text> --expected-file seat-review.json
```

`--expected-file` also accepts a file containing just the `review` token. Stop
and permission selection require a nonempty `--reason`. Permission `--mode` is
`floor`, `full_bypass`, or `inherit`, or a mode supported by the seat's managed
Claude launch context. Policy names are `locked`, `standard`, `open`, `yolo`,
`auto`, or `none`. For `set-permissions` and `policy apply`, supply
`--operator <address>` when there is no managed sender identity; otherwise the
daemon records the sender.
`stop` accepts the same optional flag. This identifies the audit actor.

`GET /api/seat/capabilities` advertises `seat-review.v1` and its checked
actions. `GET /api/seat/review/:seatRef` returns the descriptor. The review
token is optional in the existing
`POST /api/seat/stop/:seatRef`, `/set-permissions/:seatRef`, and
`/set-policy/:seatRef` request bodies as `expected`. Without it, existing
callers keep their legacy behavior. With it, malformed tokens return HTTP 400
(`invalid_review`); a changed selection returns HTTP 409 (`selection_changed`)
with its current descriptor when available. A mismatch found before stop begins detaching has
no stop effect. If the selection changes after detach, the response marks
`partialStopEffect`. A checked stop reports `stop_outcome_uncertain` if kill
fails after detach, the session disappears during stop, or the terminal stop
may have completed but its database status could not be saved. A kill failure
before detach returns `tmux_probe_failed`. Terminal stop and the database update
cannot be atomic. Checked mutations require the existing delivery guard in production;
if it is unavailable, the daemon returns `checked_contract_unavailable` before
acting. Existing unqualified callers keep their legacy behavior.

After a successful action, use its returned `review` for a following checked
change or fetch a new one. A stop changes the session state, so its earlier
review is stale. Permission and policy changes save choices for future launches
that read the seat's stored state; they do not start a process, replace native
history, or restart the current process. Existing typing-guard and stop checks
still apply to stop, and this contract does not grant fresh-launch consent.
