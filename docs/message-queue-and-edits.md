# Message queue and editing sent messages

Two related conversation features:

1. **Queue.** A message sent while the agent is running waits in a visible queue and runs automatically, in order, after the current turn completes. Waiting messages can be edited or removed, and "Send now" stops the current turn and runs the chosen message next. There is no mid-turn steering: a queued message is always a new turn.
2. **Edit.** Any earlier message the user sent can be edited. The edited turn and every later turn are replaced; the edited prompt runs as a new turn. Replaced turns keep their run journals for audit. There are no branches or forks. **Files are not reverted**: changes made by replaced turns stay in the project.

Status: implemented, including the interface described under "Interface". Checked end to end by `npm run test:message-queue`.

## Behavior

### Queue

- **Ownership.** The queue belongs to the session record on the host (`SessionRecord.queue`), not to a window. It survives a renderer reload and appears identically in every window and on remote controllers (web dashboard, phone), which refresh it on `sessions.changed`.
- **Settings.** Each item stores the run settings chosen when it was queued (provider, runtime, account, model, reasoning effort, speed, permission mode, plan mode, skills) and its attachments. Later composer changes do not affect waiting items. Plan-approval implementation turns cannot be queued.
- **Order.** First in, first out. Up to 20 items per session. Reordering is not supported in this version.
- **Advancing.** When a run of the session settles, the host applies `afterRunSettled` (`packages/core/src/sessions/queue-policy.ts`):
  - completed: the oldest item starts;
  - failed, interrupted (including Stop) or unknown: the queue **pauses** with the reason instead of building on a state the user has not reviewed;
  - a pending Send now: that item starts regardless of the outcome;
  - an already paused queue stays paused.
- **Pausing never drops items.** Reasons: `run_failed`, `run_interrupted`, `run_unknown`, `start_failed` (the item could not start, for example its account is gone; `pausedError` says why, and the item is back at the head) and `host_restarted` (the app restarted with items waiting; nothing starts by itself after a crash or quit).
- **Clearing a pause.** "Resume" (`queue.resume`), a manual send (`runs.start`), an edit (`runs.edit`) and "Send now" all count as the user acting and clear the pause.
- **Race with the run ending.** If the run settled just before `queue.add` arrived, the host starts the oldest item immediately and returns it as `started`.
- **Not available** in workflow-bound conversations (each message goes to Orchestration, which has its own step control) or in workflow agents' own conversations.

### Edit

- `runs.edit { runId, prompt }` reruns the edited turn with that turn's original model, reasoning effort, speed, permission mode, plan mode, skills and attachments. The account is chosen by normal selection, as for "Run again", so an unavailable account does not block the edit.
- Refused with `session_busy` while the session has an active run or workflow. Editing a turn that was already replaced, a plan-approval implementation turn, another conversation's turn, or a message in a workflow agent's conversation is refused with `invalid_input`.
- **Conversations that run a workflow** are refused with `invalid_input` too: a session bound to a workflow, or one where a workflow turn (not already replaced) was created at or after the edited turn. An edit resends a plain agent turn, which would skip the workflow and hide its turns. The host's check (`HostApi.runsWorkflow`) is shared with queuing; the renderer mirrors it in `canEditTurn`, so Edit is not offered there.
- The edited turn and every later turn are added to `SessionRecord.supersededRunIds`; clients hide them (`packages/ui/src/features/conversation-history.ts`). The new run carries `editOfRunId`.
- **Title.** Editing the first message re-derives the session title: when the cut removes the first user message and the title is still the one derived from it (`SessionsService.rewind`), it is cleared and the edited prompt sets a new one. A title given when the session was created is kept. The host emits `sessions.changed`, so the sidebar updates.
- A rejected edit changes nothing: every start check runs before history is cut.
- Timeline snapshots of replaced turns stay in the Timeline panel, consistent with files not being reverted.

### What the agent sees after an edit

The session's messages are cut at the first message of a replaced turn. A saved native thread (Codex or Claude conversation) is kept only if the last message it has seen is still in the kept history; any thread that saw a replaced turn is dropped. The next run therefore either resumes a thread that never saw the replaced turns, or starts a fresh thread seeded with the kept history through the existing handoff context (`packages/core/src/execution/handoff.ts`). That context is bounded to about 60,000 characters, so in long conversations older detail may be condensed.

## Interface

- **Composer** (`features/composer.ts`). Stop and Send are separate buttons. While the session has a turn running, Enter and Send queue the message, and the placeholder says so. Stop and Escape are the only ways to stop a turn. Send is hidden during a turn until something is typed. Nothing is queued while a workflow runs or in workflow-bound and workflow agents' conversations.
- **Queue stack** (`features/message-queue.ts`). It sits directly above the prompt, in the composer's overlay stack. It shows a heading ("2 queued messages"), a pause line with the reason and **Resume**, and one row per message with **Edit**, **Send now** and **Remove**. Row actions show on hover or keyboard focus and are always visible on touch screens. Edit opens an inline field: Enter saves, and Escape cancels without stopping the run. The stack renders `SessionView.queue` and holds no queue state of its own, only an unsaved inline draft.
- **Editing a sent message** (`features/message-editor.ts`, `features/session-view.ts`). **Edit** sits under the message bubble, shown on hover or focus. While a turn or workflow runs it is unavailable but stays in the tab order (`aria-disabled`, not `disabled`, which would remove it from the tab order): activating it does nothing, its reason ("Stop the current turn before editing an earlier message.") is its accessible description through `aria-describedby`, the pointer tooltip, and a muted hint beside it while it has keyboard focus. If it has focus when the turn ends, focus stays on the rebuilt, now available button. It is offered only where `canEditTurn` allows. The inline editor states the consequence before you save: "Resending replaces this turn and N later turns. Files they changed are not reverted." Pressing **Save and resend** (or Enter) confirms; Escape or Cancel returns focus to Edit. A resent turn shows an **Edited** label.
- **Transcript space.** Everything floating above the composer is reserved as transcript bottom padding, so the newest output stays readable above the queue.

## Commands

| Command | Params | Result |
| --- | --- | --- |
| `queue.add` | `sessionId`, `prompt`, `attachmentIds?`, `settings` | `{ item, started? }` |
| `queue.update` | `sessionId`, `itemId`, `prompt` | the updated item |
| `queue.remove` | `sessionId`, `itemId` | `null` |
| `queue.sendNow` | `sessionId`, `itemId` | `{ started? }` (absent when a run was active; the item starts when it settles and is announced by `run.started`) |
| `queue.resume` | `sessionId` | `{ started? }` |
| `runs.edit` | `runId`, `prompt` | `StartRunResult` |

All are serialized per session with run starts and removals. No new event type: queue and history changes are announced with `sessions.changed`, and runs started from the queue with `run.started`.

Renderer entry points (`packages/ui/src/controller.ts`): `queueMessage(params)` (takes the same `StartRunParams` the composer builds for `startRun`), `updateQueued`, `removeQueued`, `sendQueuedNow`, `resumeQueue`, `editMessage(run, prompt)`.

## Data

All fields are optional, so records saved before this change load unchanged.

- `SessionRecord.queue?: { items, pausedReason?, pausedError?, sendNowItemId? }`; absent when empty.
- `SessionRecord.supersededRunIds?: string[]` (execution run IDs and workflow run IDs).
- `RunRecord.editOfRunId?: string`.

## Known issues

- **Edit warning count.** "Resending replaces this turn and N later turns" (`turnsReplacedByEdit`) counts turns whose `createdAt` is at or after the edited turn's, while the host replaces turns by transcript order. When two turns were created in the same millisecond, the count can be off by one. Which turns are replaced is unaffected; only the warning text is.

## Follow-up (not implemented)

- **Native rewind.** Both providers can rewind a conversation natively, which would keep full detail instead of the bounded handoff context: the Claude Agent SDK (`resumeSessionAt`, `forkSession`) and the Codex app server bundled with Rack (`thread/fork`, `thread/revert`; request shapes not verified). Using them requires recording provider message or turn IDs per run and an optional `RuntimeAdapter.rewind`.
- Reordering queued items; queuing in workflow-bound conversations; editing messages in conversations that run a workflow, plan-approval implementation turns and imported history.
- **Enter right after the queue starts a message.** For the few milliseconds between the host starting a queued message and the window receiving `run.started`, the composer still shows "Run". Pressing Enter then sends `runs.start`, which the host rejects with `session_busy` ("This session is still running…"); the text stays in the prompt. A fix would have `controller.startRun` fall back to `queue.add` on `session_busy` when the window shows no active run. The native check waits for the turn to appear before typing, so it does not depend on this.
