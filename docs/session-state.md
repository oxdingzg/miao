# Session state across miao and mtty

Execution ownership, task completion and attention are separate facts. A Runtime's
`idle` status means that no provider drain owns the Session; it does not mean the
user's task is finished.

The observing TUI client owns its pane's state report. Server plugins must not
report aggregated activity into the pane that happened to launch a shared Runtime.
The client combines execution status, permission/question requests, durable todo
items, the latest projected message, pending inputs and the live Session activity
snapshot. The sidebar and terminal report consume the same presentation state;
background timers consume the same activity snapshot. One polling lifecycle follows
the selected Session and aborts on navigation or disposal.

| State        | Evidence                                                                                  | mtty shape           |
| ------------ | ----------------------------------------------------------------------------------------- | -------------------- |
| `processing` | Active execution or provider retry                                                        | Busy circle          |
| `awaiting`   | Permission or question awaiting a user decision                                           | Amber waiting circle |
| `waiting`    | Pending input/notification, live background job or scheduled wakeup                       | Accent clock         |
| `incomplete` | Idle with unresolved todos or without a successful final response                         | Amber pause bars     |
| `completed`  | Idle, no outstanding waits/todos, latest assistant response completed with `finish: stop` | Green full circle    |
| `error`      | Session failure                                                                           | Red full circle      |
| `unknown`    | Missing hydration/activity, failed observation or untracked job                           | Muted question mark  |
| `idle`       | Hydrated Session without messages or outstanding work                                     | Empty ring           |

An interrupted provider turn carries the structured `interrupted` error marker. Once execution is idle it remains paused unfinished, rather than being mistaken for a failure or a successful final answer; pending work still reports waiting. Ordinary provider failures remain errors.

Cancellation is a resolved checklist item, not completed work. The sidebar keeps
the checklist visible after completion and shows completed/total counts plus the
number cancelled. It never rewrites todo statuses to match execution. A persisted
`in_progress` item in an idle Session means paused unfinished work, not a live
provider turn. Likewise, a successful response is only evidence of the last task
outcome, not a promise that the model's claims have been independently verified.

mtty accepts the explicit states without changing the MTP transport. Its queued
prompts can be delivered when an agent enters a ready state (`idle`, `completed`
or `incomplete`), but not during background waits, unknown status or decisions.
Moving between ready states does not deliver another prompt. Existing agents that
only report `processing` and `idle` retain their legacy completion attention;
miao uses explicit `completed`, never an inferred `processing → idle` success.
Client teardown clears the Runtime binding and retains the observed Session
identity. Confirmed completed, incomplete and failed outcomes remain visible;
live execution, waits and decisions become `unknown` because that observer can
no longer verify them. Closing a client never invents completion and never
erases completion that was already confirmed. While refreshing background
activity, a known active execution or pending decision still takes precedence
over the missing snapshot.

Badge preferences reuse existing groups: completed/incomplete use `idle`, waiting
uses `processing`, and unknown uses `error`. These changes require both updated
miao and mtty for the full visual vocabulary; MTP continues accepting arbitrary
state strings. No public HTTP schema or generated SDK changes are required.
