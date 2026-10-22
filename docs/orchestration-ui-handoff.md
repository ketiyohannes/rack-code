# UI/UX delivery (2026-10-22)

## Review remediation UI pass

Reviewed the functional fixes for all three delivery findings. Drafting now has
a separate progress/input notice outside the collapsible description settings,
with Answer designer and Cancel generation. Answer focuses the shared broker
form without rebuilding it. Focus moves to cancellation when generation starts
and returns to Generate after completion/cancellation; the settings disclosure
reopens if needed. Neutral lifecycle outcomes use a polite status region;
unchanged streamed states do not repeat announcements. Failures retain alerts.
Draft controls remain locked during generation and the previous draft survives
both explicit cancellation and Escape.

The drafting model/Generate row wraps at small widths and truncates long model
labels. Designer recovery in the owning conversation explains answer/cancel
options and wraps the cancel action. Late catalog discovery and unavailable
selection behavior remain supplied by the functional implementation. No host,
scheduler, routing or permission behavior changed in this UI pass.

Validation: 73 focused tests, typecheck, Node build and desktop bundling passed.
Both native Electron fixtures passed, including designer questions/cancellation
with collapsed settings, keyboard focus restoration, draft retention, delayed
and changed catalogs, startup/session model behavior, reload recovery, 260/320 px
sidebars and 980×600 authoring. Small-window designer/recovery screenshots were
reviewed. The screenshot helper now ignores infinite activity animations; its
earlier wait for every animation caused a fixture watchdog timeout. Electron
requires local desktop access and aborted inside the sandbox. Live providers,
the full repository suite and packaged distribution were not tested. Existing
work is preserved and all changes remain uncommitted.

---

The accepted UI pass is implemented in `orchestra-panel.ts`, `orchestra-editor.ts`
and the existing stylesheet. Session overview, separate library and inline agent
details consume the functional projections below. Required-action links focus
exact broker forms via renderer-only `data-pending-request` / `data-execution-id`
anchors in composer approvals and question cards. No IPC/schema/scheduler change
was needed for this pass.

View/run/worker selection, overview scroll, Task/previous-attempt disclosures
and open tools are remembered per session within the window. Details preserve
live tool nodes through settlement while saved journals load. Apply/delete show
pending/error feedback; edits remain future-run scoped. Builder adds a Blank
manual path, clear inheritance/generation copy, selected-card semantics and
retained keyboard reorder focus.

Validation: 75 focused tests, typecheck, Node/desktop builds and both native
Electron fixtures passed. The orchestra fixture now verifies workflow gates,
worker tool/question links, pause/resume/stop, historical-run navigation,
live/completion focus/disclosure/scroll retention, 260/320 px panel widths, 980×600 editor, dirty/invalid drafts, reload
and session model/prompt restoration. Native screenshots were reviewed and an
isolated agent-browser visual pass checked the library/editor. Live providers,
packaged distribution and the full repository suite were not run in this pass.
The historical standalone-navigation finding below remains outside this bounded
orchestration layout pass; the fixture explicitly expands its temporary project
for deterministic session navigation.

---

# Historical functional handoff (before the UI pass)

The functional pass preserves the existing working tree and scheduler. It does
not introduce visual styling or implement the proposed overview/library/inline
inspection layouts. The next pass owns those surfaces.

## Interfaces ready to consume

- `features/orchestra-state.ts`: `workflowStages(run)` returns stage lifecycle,
  waiting reason, all retained `attempts` and revision-specific `currentWorkers`.
  `workflowProgress(run)` adds current/next and aggregate counts.
  `resolveWorkflowModel(run, binding?)` resolves immutable run assignments.
- `workflowRequiredActions(state, run)` returns distinct `workflow_approval`,
  `tool_approval` and `question` items with the owning session/run/worker target,
  execution ID and request ID. Only live brokers establish pending input.
  Workflow gates use `controlWorkflow(..., "approve")`; worker actions retain
  the existing approval/question forms above the owning session's composer.
- `orchestra-worker-state.ts`: `workerSummary(worker, live?)` separates lifecycle,
  resolved model, activity and bounded current command/path. `workerDetail`
  correlates readable tools and response through `foldEvents`/`presentTool`.
  `WorkerJournalReader.select(runId, publish)` supplies loading/ready/error
  states, deduplicates reads and rejects late selection updates. Cache only
  settled executions; live workers consume the live store. Call
  `clearSelection()` when leaving a detail view.
- `Controller.openOrchestra({ sessionId, workflowRunId, workerId? })` and
  `AppState.orchestraTarget` carry exact execution navigation. Timeline and
  transcript workflow links now use this route. Honor its sequence only once.
- Optional `AppState.workflowControls[runId]` supplies action/pending/error.
  Disable duplicate controls while pending; a pending Stop means Stopping even
  if the persisted run already says Stopped. Failed controls retain an error
  and can be retried through the same command.
- `ModelPicker.selection`, `setSelection(...)` and `unavailable` support explicit
  routing restoration. Composer choices are retained per root session during
  navigation; concrete unavailable model/account choices do not substitute.
  Symbolic provider defaults resolve when late discovery arrives. Unsent
  settings are window memory, not a new persistence schema.
- `workflowDraftIssue` locates the first invalid field/step/agent. The editor
  retains failed saves, focuses validation errors and guards dirty replacement
  or closure. `ModalOptions.beforeClose` covers Cancel, Escape, backdrop and X.

## Preserve in the UI pass

The current worker modal demonstrates readable correlated tools, retained tool
nodes/keyboard focus/disclosures, text-selection protection, scroll retention,
lazy saved-journal loading, failure/retry and explicit cancellation consequences.
Move this behavior into inline details when implementing Back navigation.

The overview still rebuilds its DOM on meaningful worker changes. The redesign
must retain overview scroll/focus and session/run/worker view memory. Keep the
compact signature independent of streamed response text.

Required-action queries are ready for prominent worker-specific links. The
existing broker-owned forms remain in the composer; do not infer pending input
from old journal events. Saved-definition edits still affect future runs only.

Implement the accepted session overview, separate library and inline agent view;
retain the wide authoring editor. Finish resolved-model inheritance copy,
accessible status transitions, narrow-sidebar layout and keyboard navigation.
No CSS was changed by the functional pass.

## Findings and boundaries

The current navigator renders project sessions but omits standalone chats when
there are no projects. Consider this when making required actions reachable in
standalone sessions. The native session-switch check attaches its completed
standalone fixture to a temporary project before navigating between two roots.

No activity-time/cost dashboard, provider change, automatic permission change,
parallel editing/merge policy, running-definition edit or new schema was added.
The transcript changed-files cards and requested icon/availability removals are
preserved. Live provider behavior remains unverified.

## Validation

Typecheck, Node build, desktop bundle and 79 focused tests passed. The tests
cover review returns/parallel states, broker attribution, control settlement,
exact navigation, selection initialization/default discovery, retained journal
loading/races, readable tools, editor diagnostics and transcript regressions.
Both native Electron orchestra and run-changes fixtures passed on the final
build. An earlier orchestra repeat failed its worker-count assertion (0 versus
1); the final rerun passed. The fixture now explicitly asserts saved step order
before execution. Keep this intermittent result visible during verification;
its cause is not established. Details are recorded in `changes.md`. The full repository test suite was not rerun for this bounded pass.

# Functional review remediation (2026-10-22)

All three review findings have functional fixes. Keep these interfaces in the
next UI/UX review:

- `orchestra.generate` now requires a renderer-created `generationId`.
  `orchestra.cancelGeneration({ generationId })` is idempotent and waits for
  startup and execution settlement. `OrchestraSnapshot.generations` contains
  transient root/designer associations and stopping state; it is not persisted.
- The studio reuses `createQuestionRequestsView(..., visibleRun)` and disposes
  its watch on close. Questions remain broker-owned; no journal inference or
  duplicate execution stream reader was added. A Cancel generation button stays
  enabled during generation. Escape, backdrop and X request cancellation and
  keep the existing draft/editor open. Saving retains its existing close lock.
  The root composer exposes recovery questions/cancellation after reload, and
  navigator input indicators attribute designer questions to their root session.
- Startup includes the local orchestra snapshot in the initial discovery join
  before sessions are published. Composer initialization therefore sees complete
  routing history in either response order. Provider catalog discovery stays
  independent, and unsent choices retain their existing per-session behavior.
- The drafting picker watches model/loading/favorite changes. Late discovery
  makes generation usable, missing selections remain visible/unavailable, and
  catalog updates preserve the draft and selected routing. An open picker closes
  when its catalog changes so old menu entries cannot submit stale choices.

UI/UX follow-up: review placement of the studio's shared question region,
Cancel generation control and catalog status, plus the composer's designer
recovery notice. They use existing controls/classes; this pass adds no styling.
Closing while generation is busy cancels and retains the editor; close again
after settlement to use the existing dirty-draft guard. Unsaved drafts do not
survive renderer reload. Existing standalone-session navigation limitations
remain outside these review findings.

Validation: 115 focused tests, typecheck, Node build, desktop bundling and both
native Electron fixtures passed. The extended orchestra fixture exercises
designer question submission, explicit cancellation and Escape with retained
drafts, delayed/changed catalogs, and input/cancellation recovery after renderer
reload. Both startup response orders are covered by controller tests with
different models/accounts/permissions. Live providers and the full suite remain
untested. Details, including fixture corrections, are in `changes.md`. The notes
above describe the earlier implementation and validation.

