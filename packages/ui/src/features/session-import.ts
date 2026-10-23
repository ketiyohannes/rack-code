/** Local history picker: checkbox selection is independent from preview focus. */
import type { DiscoveredSession, ProjectView } from "@rack/contracts";
import { createCheckbox, type Checkbox } from "../components/checkbox.js";
import { openModal } from "../components/modal.js";
import type { Controller } from "../controller.js";
import { h, replace, relativeTime } from "../dom.js";
import { icon } from "../icons.js";
import { importKey, pendingImports, selectionState } from "./import-selection.js";

export function openSessionImport(project: ProjectView, controller: Controller): void {
  let closed = false;
  let sessions: readonly DiscoveredSession[] = [];
  const selected = new Set<string>();
  const failures = new Set<string>();
  const checkboxes = new Map<string, Checkbox>();
  let discoveryVersion = 0;
  let previewVersion = 0;
  let importing = false;
  let loading = true;
  let previewed: DiscoveredSession | undefined;
  const list = h("div", { class: "import-list", aria: { label: "Local sessions" } });
  const preview = h("div", { class: "import-preview", aria: { live: "polite" } },
    h("p", { class: "empty" }, "Choose a session to preview its conversation."));
  const status = h("p", { class: "form-note", aria: { live: "polite" } }, "Looking for local sessions…");
  const selectAll = createCheckbox({ label: "Select all sessions", onToggle: (checked) => {
    selected.clear();
    if (checked) for (const session of pendingImports(sessions)) selected.add(importKey(session));
    renderList();
  } });
  const count = h("span", { class: "form-note" }, "0 selected");
  const selection = h("div", { class: "import-selection" },
    h("span", { class: "import-select-all" }, selectAll.element, "Select all"), count);
  const refresh = h("button", { class: "button", type: "button", onClick: () => void discover() }, icon("arrow-clockwise"), "Refresh");
  const submit = h("button", { class: "button button-primary", type: "button", disabled: true,
    onClick: () => void importSelected() }, "Import selected");
  const content = h("div", { class: "modal-body" },
    h("p", { class: "form-note import-folder", title: project.path }, project.path),
    h("p", { class: "form-note" }, "Select the conversations to import. Continuing uses recent conversation in a new session; originals stay unchanged."),
    status, selection, h("div", { class: "import-columns" }, list, preview),
    h("div", { class: "modal-actions" }, refresh, submit),
  );
  const modal = openModal({ title: "Import local sessions", className: "import-modal", content,
    onClose: () => { closed = true; discoveryVersion += 1; previewVersion += 1; } });

  function renderList(focusKey?: string): void {
    const state = selectionState(sessions, selected);
    selectAll.set(state.indeterminate ? "mixed" : state.checked);
    selectAll.setDisabled(loading || importing || state.total === 0);
    count.textContent = `${state.count} selected`;
    submit.disabled = loading || importing || state.count === 0;
    submit.textContent = importing ? "Importing…" : state.count === 0 ? "Import selected" : `Import ${state.count} ${state.count === 1 ? "session" : "sessions"}`;
    refresh.disabled = importing || loading;
    checkboxes.clear();
    replace(list, ...sessions.map((candidate) => {
      const key = importKey(candidate);
      const checkbox = createCheckbox({ label: `Select ${candidate.title}`, checked: selected.has(key), onToggle: (checked) => {
        if (checked) selected.add(key); else selected.delete(key);
        renderList(key);
      } });
      checkbox.setDisabled(importing || candidate.importedSessionId !== undefined);
      checkboxes.set(key, checkbox);
      return h("div", { class: `import-session-row${selected.has(key) ? " checked" : ""}` },
        h("span", { class: "import-session-check", title: candidate.importedSessionId === undefined ? "Select session" : "Already imported" }, checkbox.element),
        h("button", { class: `import-session${previewed !== undefined && importKey(previewed) === key ? " selected" : ""}`,
          type: "button", disabled: importing, aria: { pressed: String(previewed !== undefined && importKey(previewed) === key) },
          onClick: () => void showPreview(candidate) },
          h("span", { class: "import-session-title" }, candidate.title),
          h("span", { class: "form-note" }, `${candidate.providerName} · ${relativeTime(candidate.updatedAt)}${candidate.importedSessionId === undefined ? "" : " · Imported"}`),
          failures.has(key) ? h("span", { class: "import-session-error" }, "Could not import. Select to retry.") : null,
        ));
    }));
    if (focusKey !== undefined) checkboxes.get(focusKey)?.element.focus();
    if (!loading && sessions.length === 0) list.append(h("p", { class: "empty" }, "No sessions found for this folder."));
  }

  async function discover(): Promise<void> {
    if (importing) return;
    const request = ++discoveryVersion;
    loading = true;
    status.textContent = "Looking for local sessions…";
    renderList();
    try {
      const result = await controller.discoverSessions(project.id);
      if (closed || request !== discoveryVersion) return;
      sessions = result.sessions;
      const pending = new Set(pendingImports(sessions).map(importKey));
      for (const key of selected) if (!pending.has(key)) selected.delete(key);
      status.textContent = result.failures.length > 0 ? result.failures.map((failure) => failure.message).join(" ")
        : `${sessions.length} local ${sessions.length === 1 ? "session" : "sessions"} found.`;
    } catch {
      if (!closed && request === discoveryVersion) status.textContent = "Could not discover local sessions. Try Refresh.";
    } finally {
      if (!closed && request === discoveryVersion) { loading = false; renderList(); }
    }
  }

  async function showPreview(candidate: DiscoveredSession): Promise<void> {
    const request = ++previewVersion;
    previewed = candidate;
    renderList();
    replace(preview, h("p", { class: "empty" }, "Loading preview…"));
    try {
      const snapshot = await controller.previewImport(project.id, candidate.sourceId, candidate.nativeSessionId);
      if (closed || request !== previewVersion) return;
      replace(preview, h("p", { class: "form-note" }, "Recent messages · preview may be shortened"),
        ...snapshot.messages.map((message) => h("div", { class: "import-preview-message" },
          h("span", { class: "import-preview-role" }, message.role), h("p", {}, message.content))),
        candidate.importedSessionId === undefined ? null : h("button", { class: "button", type: "button", onClick: () => {
          void controller.selectSession(candidate.importedSessionId!); modal.close();
        } }, "Open imported session"),
      );
      if (snapshot.messages.length === 0) preview.append(h("p", { class: "empty" }, "No readable conversation is available."));
    } catch {
      if (!closed && request === previewVersion) replace(preview, h("p", { class: "empty" }, "This session's history could not be read. It may still be active or unavailable."));
    }
  }

  async function importSelected(): Promise<void> {
    const candidates = pendingImports(sessions).filter((session) => selected.has(importKey(session)));
    if (candidates.length === 0 || importing || loading) return;
    importing = true;
    renderList();
    const result = await controller.importSessions(project.id, candidates.map(({ sourceId, nativeSessionId }) => ({ sourceId, nativeSessionId })));
    importing = false;
    if (closed) return;
    const imported = new Map(result.imported.map((session) => [importKey(session), session.sessionId]));
    failures.clear();
    for (const session of result.failed) failures.add(importKey(session));
    sessions = sessions.map((session) => {
      const sessionId = imported.get(importKey(session));
      if (sessionId === undefined) return session;
      selected.delete(importKey(session));
      return { ...session, importedSessionId: sessionId };
    });
    if (result.failed.length === 0) modal.close();
    else {
      status.textContent = `${result.imported.length} imported. ${result.failed.length} could not be imported; successful imports are saved. Retry the remaining selection or refresh.`;
      renderList();
    }
  }
  void discover();
}
