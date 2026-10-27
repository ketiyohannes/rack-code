# Agent orchestra

Status: implemented 2026-10-21; supervision UI refined 2026-10-22. Rack owns the workflow definition and scheduler;
workers use the existing execution service and runtime adapters. This does not
invoke Claude's native Workflow tool or Codex's native subagent machinery.

## Create and apply

Open **Orchestration** from the right workbench launcher or **+** menu. While
no workflow runs, the sidebar lists only the saved workflow titles. Select a
title to apply it to the open conversation's next message (a check marks the
applied one; select it again to remove it). Edit and Delete appear when a row is
hovered or focused. **+** opens the wide Workflow studio with ordered cards and a
step inspector. A failed apply or delete shows an error and can be retried.

- Choose Blank to add steps manually, or start with Feature development, Parallel review, or Research & compare, then
  change the title, description and steps. Templates are editable drafts, saved
  only when you choose Save workflow.
- Select a card to edit its name, agent instructions, model and reasoning effort.
  Coordinator defaults to the session model; workers default to the coordinator.
  Any available model in the connected runtime catalogs can be assigned.
- Drag a step by its handle to reorder, or use its Up/Down buttons. Reordering
  changes execution order. Approval cards wait for explicit approval.
- Add individual agents, approval points, or Run together groups of two to four
  read-only agents. Editing work is sequential in this version; no automatic
  branch integration is implied.
- A review can return to an earlier work step, with one to five revision rounds.
  Review agents must end with a `VERDICT: APPROVED` or
  `VERDICT: CHANGES_REQUESTED` line. The scheduler reads the last five non-empty
  lines and tolerates Markdown emphasis, backticks, case, trailing punctuation
  and a closing sentence after the verdict; the last verdict line wins. Missing
  verdicts and exhausted limits stop the workflow for the user to inspect.
- Generate from a description makes a real read-only model request using the visible
  Workflow drafting model picker. It initially selects the coordinator, a
  favorite model, or the first discovered model. It requires an
  open conversation and connected model. Its returned JSON is validated as data;
  no generated code is executed. Drafting consumes provider usage.
  Models discovered while the studio is open become available immediately. A
  selected model that disappears stays selected with an unavailable explanation;
  choose its replacement explicitly. Discovery never replaces your workflow draft.
- Designer questions appear inside the studio using the ordinary question form.
  A separate drafting notice names progress or required input and stays visible
  when the description settings are collapsed. **Answer designer** moves keyboard
  focus to the question form. The model and Generate controls wrap at small widths.
  **Cancel generation** stops the designer, waits for cancellation to settle and
  retains the previous draft. Closing/Escape during generation requests the same
  cancellation and leaves the editor open for review; close again afterward to
  use the normal unsaved-changes guard. Saving still waits for its request to finish.
  Completion and cancellation return keyboard focus to Generate and announce the
  outcome beside the drafting settings. Cancellation is a status, not an error.
  If the renderer reloads during generation, the owning conversation exposes the
  question and a cancellation control. Unsaved editor drafts remain window memory
  and do not survive a renderer reload. Host shutdown also cancels designers.

Saved workflows are available across projects. Apply one to a conversation by
selecting its title. A label above the composer shows which workflow will handle
the next message, and its close button removes the binding. Applying does not
start execution; sending the next message does. Hiding/disabling the surface does not cancel an active workflow.

Plan mode and manually selected session skills are not combined with orchestra
runs: workers follow their saved instructions. The composer sends workflow tasks
in normal mode without the session's skill chips, so a skill selected for earlier
ordinary turns no longer blocks starting a workflow in an existing conversation.
Pressing Enter while a workflow runs does nothing; stop it with the Stop button
or Escape. Session attachments are resolved by the host and their quoted file
references are passed to workers with the task. Session permission mode bounds
workers; read-only workers and the final coordinator use read-only execution.

## Supervise a run

While no workflow is active in the open conversation, the sidebar shows only the
saved workflow titles (see Create and apply). When one runs, it switches to a
live view of that run:

- A header with the workflow title, its status (an animated spinner while
  working; "Your approval" breathes while a gate waits), and Pause/Resume and
  Stop icon buttons.
- Required actions: the workflow approval gate (**Approve & continue**) and
  per-worker tool approvals and questions (**Review**/**Answer** focus the exact
  broker-owned form above the composer). Only live broker snapshots establish
  pending input.
- Every agent execution in order, as a collapsible card showing its status,
  name, the model it uses (with reasoning effort when set) and its tool-call
  count. Inside, its tool calls form a waterfall along a rail: each row shows a
  status mark (spinner, check, warning or stop), a readable title and its
  command/path target. Rows that arrive together drop in staggered. While the
  agent works without a tool in flight, a shimmering "Working…" row shows.
  At most the newest 60 rows are shown per agent, with a count of older ones.

Running agents start open. When an agent settles it collapses with an animated
height transition, unless the user opened or closed it explicitly; that choice
is kept for the window session. When the workflow ends the sidebar returns to
the titles. The transcript's workflow turn and Timeline's Agent activity links
open a finished run in the same view through `Controller.openOrchestra`; Back
returns to the titles. Tool rows of settled agents come from the activity the
panel observed, or are loaded lazily from saved run journals.

Rendering is keyed and incremental. Agent cards and tool rows persist across
updates, so entry animations play once, disclosures keep their state, and
spinners keep turning; spinner phase is also locked to the clock, so a rebuilt
mark continues smoothly. Previously the panel rebuilt its whole DOM and its
status icons lacked the spinning class, which made workflows look frozen.
Ordinary response text never updates the sidebar; only tool activity and
lifecycle changes do. Reduced-motion preferences slow the spinner and disable
the drop, shimmer, breathing and collapse animations.

Pause lets current workers finish and prevents new stages from starting. Resume
continues scheduling. Stop requests cancellation of active workers and prevents
further scheduling. Controls suppress duplicate commands while a command is
pending; failed controls show their error. A failed parallel worker cancels its
siblings. A stopped or failed worker does not count as a successful stage.
Workers release native process resources on settlement; their execution
journals and results remain.

The main chat shows a workflow turn exactly like an ordinary turn (updated
2026-10-27): the same prompt bubble, then every worker's activity in start order
(thinking, tool group cards with timing, worker text), then the coordinator's
answer. The only addition is an indicator under the prompt naming the workflow;
selecting it opens the run in Orchestration. Worker tool approvals are answered
inline on the worker's tool row like a normal turn's (the panel's **Review** and
the composer's pointer focus that row); workflow approval gates stay on the
composer and in this panel. Worker activity streams live from the host and, for
settled workers, is loaded from their journals, so a reload or another device
shows the same turn. Workers stay attributed for assistive technology through a
labelled group with no visual box. Timeline also has an Agent activity section
linking to workflow supervision. This section is independent of Git snapshot capture and works in
standalone chats. Existing Git history and recording behavior remain separate.

The panel fits the 260 px minimum sidebar: titles, models and targets truncate
with full text in tooltips. Status uses text and icons alongside color, and a
polite status region announces lifecycle changes without streamed tokens.

## Renderer state and interfaces

The renderer owns the titles/run view switch, exact-navigation targets and agent
disclosure choices; this state is transient.
`orchestra-state.ts` exposes `workflowStages`, `workflowProgress`,
`resolveWorkflowModel` and `workflowRequiredActions`; lifecycle status remains
separate from current activity. Required actions distinguish workflow gates,
worker tool approvals and questions and include exact session/run/worker targets.
Only live broker snapshots establish pending requests.

`orchestra-worker-state.ts` exposes `workerSummary` (bounded command/path target),
`workerDetail` (folded readable tools/response), and `WorkerJournalReader`
(selection-safe lazy retained history, with a 32-execution cache).
`Controller.openOrchestra({ sessionId, workflowRunId, workerId? })` preserves
historical run/attempt identity. Timeline and transcript workflow links use it.
`AppState.workflowControls` holds per-run pending commands/errors; interface
state is transient and does not change workflow persistence or IPC schemas.

Composer routing, explicit account, effort, speed and permissions are retained
per root conversation while navigating. First visits restore the latest root
execution or workflow defaults. An unavailable/unstarred model or disconnected
explicit account remains selected, blocks submission and explains the needed
replacement. Unsupported approval modes explain why Run is disabled and offer
explicit compatible choices; permissions never change automatically.

## Ownership and persistence

`packages/features/src/orchestration/` owns definitions, validation, bindings, scheduling,
run snapshots and worker attribution. `types.ts` is the portable public contract;
`index.ts` is the server entry point. `activity.ts` exposes the pure
`projectWorkerActivity(worker, execution?)` projection and its `WorkerActivity`
and `WorkerExecutionActivity` interfaces to browser clients. It accepts normalized
execution/broker snapshots, performs no I/O, and does not depend on renderer state
or provider SDKs. The renderer uses its kind/label/count for row content and update
signatures. Composition optionally assembles the service
(default on; `orchestra: false` omits it). Core does not import this feature.

`orchestra.json` in Rack's data directory stores the workflow library, session
bindings and run snapshots through the atomic JSON document adapter. A run copies
the definition at start, so editing/deleting the library entry cannot change its
execution or erase its history. Revision checks reject stale library edits.

Workers are internal child session contexts. Sessions owns `parentSessionId`,
validates that the parent is a root conversation in the same project, and hides
workers from session navigation. Execution uses the parent's workspace (including
its existing isolated worktree) and shared app tools, while storing provider
continuation state separately for each worker. Workers are briefed with the
parent conversation as rendered by `ExecutionService.conversationContext`: the
same attributed, budgeted history (with summarized tool activity and changed
files) a fresh native thread receives, captured before the workflow's task
message. Handoffs also carry completed worker results, never opaque provider
state. The workflow's task, approvals and final reply are ordinary messages of
the parent conversation, so the next normal turn on any runtime receives them
through the cross-runtime handoff (see [architecture](architecture.md)).

Claude read-only workers run in Claude's native plan mode as their sandbox. The
adapter denies `ExitPlanMode` for every read-only run with guidance to put the
result in the response; previously only Plan-mode turns received that guidance,
and workers could stall retrying the tool. Read-only shell commands remain
denied for Claude read-only workers.

The host validates all model assignments before launching a workflow, against
the last successful model catalog for each account (refreshed in the background)
rather than a fresh discovery. Fresh discovery can take seconds per account and
ran inside the session's command lane, so starting a workflow appeared frozen.
A `default` assignment is checked against the provider's default model among
entries available on the chosen account. It owns and
drains each execution handle exactly once through ActiveRuns, preserving normal
approvals, questions, journals, account selection and cancellation. Explicit
session accounts apply to workers using that provider; other providers use normal
account selection. No silent model substitutions are made.

On host restart, active workflow records become Interrupted. They are not replayed:
a worker may have completed a file or external operation before the crash. Review
the retained activity and send a new task when ready. There is no automatic retry,
crash-resume, arbitrary JavaScript authoring, parallel editing/merging, or general
conditional graph editor in this version. Internal worker history is retained
with execution history; automatic retention/garbage collection is not implemented.

## Verification

Run the scheduler suite with:

```sh
node --import tsx --test packages/features/src/orchestration/service.test.ts packages/features/src/orchestration/activity.test.ts
```

The native smoke test uses only a fixture runtime and a temporary application data
directory. It exercises the real renderer, preload, HostApi and execution service;
it never logs into a provider, calls a live model, or modifies project files:

```sh
node --import tsx apps/desktop/scripts/build-desktop.ts
(cd apps/desktop && npx tsx scripts/bundle-fixture.ts verify-orchestra)
node_modules/.bin/electron apps/desktop/dist/verify-orchestra.mjs --user-data-dir=/tmp/rack-orchestra-smoke-profile
```

The smoke check also holds fixture activity at approval, consecutive tool
requests, overlapping tool completion and idle boundaries until the actual
sidebar displays the expected summary. It checks the settled summary and reload.
It also checks the title-only idle sidebar and apply-by-title, agent model
labels, the tool waterfall (row count, statuses, persistent row and spinner
nodes across updates, the Working row), automatic collapse of settled agents,
return to the titles on completion, worker-specific tool/question form
navigation, pause/resume/stop, Timeline navigation to a finished run with tools
loaded from saved journals, 260/320 px sidebar overflow, the 980×600 editor,
validation/dirty draft guards and session model/prompt restoration. It captures
the editor, titles, approval, working, agent and narrow views under `/tmp`.
Live-provider behavior and packaged application distribution remain unverified.
