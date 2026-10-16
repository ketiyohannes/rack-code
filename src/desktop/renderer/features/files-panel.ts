/** Folder browsing and a persistent plain-text editor. Drafts belong to a
 * project/path, never to whichever session is selected when a read settles.
 * Saving is explicit and version checked by the host.
 */
import type { FileDocument, FileListing } from "../../../features/files/index.js";
import type { Controller } from "../controller.js";
import type { Store } from "../store.js";
import { h, replace } from "../dom.js";
import { icon } from "../icons.js";
import { openModal } from "../components/modal.js";

interface Draft { document: FileDocument; text: string }
export function createFilesPanel(store: Store, controller: Controller, isVisible: () => boolean) {
  let active = false;
  let projectId: string | undefined;
  let path = "";
  let listing: FileListing | undefined;
  let selected: string | undefined;
  let generation = 0;
  let fileGeneration = 0;
  let loading = false;
  let saving = false;
  let readingKey: string | undefined;
  const folders = new Map<string, string>();
  const selectedFiles = new Map<string, string>();
  const drafts = new Map<string, Draft>();
  const error = h("p", { class: "panel-error", role: "alert" });
  const folderName = h("span", { class: "files-folder-name" });
  const up = h("button", { class: "icon-button", type: "button", aria: { label: "Parent folder" }, onClick: () => navigate(path.split("/").slice(0, -1).join("/")) }, icon("arrow-left"));
  const refresh = h("button", { class: "icon-button", type: "button", aria: { label: "Refresh files" }, onClick: () => void load() }, icon("arrow-clockwise"));
  const filter = h("input", { class: "files-filter", type: "search", placeholder: "Filter this folder", aria: { label: "Filter files in this folder" }, onInput: () => renderList() });
  const list = h("div", { class: "files-list", role: "list", aria: { label: "Project files" } });
  const filename = h("span", { class: "files-editor-name" });
  const dirty = h("span", { class: "files-dirty", aria: { live: "polite" } });
  const reload = h("button", { class: "button button-small", type: "button", onClick: () => void selectFile(selected!, true) }, "Reload");
  const save = h("button", { class: "button button-primary button-small", type: "button", onClick: () => void saveCurrent() }, "Save");
  const external = h("button", { class: "icon-button", type: "button", aria: { label: "Open file externally" }, onClick: () => {
    const project = store.get().projects.find((project) => project.id === projectId);
    if (projectId?.startsWith("chat:")) { void controller.openSessionPath(projectId.slice(5), selected ?? ""); return; }
    if (selected !== undefined && project !== undefined) void controller.openPath(selected, project.path);
  } }, icon("arrows-out-simple"));
  const editor = h("textarea", { class: "files-editor", aria: { label: "File contents" }, onInput: () => {
    const draft = current(); if (draft !== undefined) draft.text = draft.document.text.includes("\r\n") ? editor.value.replace(/\r?\n/g, "\r\n") : editor.value; renderEditorStatus();
  }, onKeydown: (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") { event.preventDefault(); event.stopPropagation(); void saveCurrent(); }
    if (event.key === "Tab" && !event.shiftKey) {
      event.preventDefault();
      editor.setRangeText("  ", editor.selectionStart, editor.selectionEnd, "end");
      editor.dispatchEvent(new Event("input", { bubbles: true }));
    }
    if (event.key === "Escape") event.stopPropagation();
  } });
  editor.spellcheck = false;
  const notice = h("p", { class: "note" });
  const editorRegion = h("section", { class: "files-editor-region", aria: { label: "File editor" } },
    h("div", { class: "files-editor-heading" }, filename, dirty, external), notice, editor,
    h("div", { class: "files-editor-actions" }, reload, save));
  const element = h("div", { class: "files-panel" }, h("div", { class: "files-toolbar" }, up, folderName, refresh), filter, error, list, editorRegion);
  const key = (file: string) => `${projectId}:${file}`;
  const current = () => selected === undefined ? undefined : drafts.get(key(selected));

  function navigate(next: string): void {
    path = next; if (projectId !== undefined) folders.set(projectId, path);
    generation++; listing = undefined; filter.value = ""; renderList(); void load();
  }
  async function load(): Promise<void> {
    if (!active || !isVisible() || projectId === undefined || store.get().host.status !== "ready") return;
    const version = generation; const target = projectId; const folder = path;
    loading = true; renderList();
    try {
      const result = await controller.listFiles(target, folder);
      if (version !== generation) return;
      listing = result; error.textContent = "";
    } catch (failure) { if (version === generation) error.textContent = message(failure); }
    finally { if (version === generation) { loading = false; renderList(); } }
  }
  function renderList(): void {
    const project = store.get().projects.find((project) => project.id === projectId);
    folderName.textContent = path || project?.path.split(/[\\/]/).at(-1) || (projectId?.startsWith("chat:") ? "Chat files" : "Select a project");
    folderName.title = path || project?.path || "";
    up.disabled = path === ""; refresh.disabled = loading || projectId === undefined;
    filter.disabled = projectId === undefined;
    const entries = listing?.entries.filter((entry) => entry.name.toLowerCase().includes(filter.value.toLowerCase())) ?? [];
    replace(list, ...entries.map((entry) => h("div", { role: "listitem" }, h("button", {
      class: `files-row${entry.path === selected ? " selected" : ""}`, type: "button", title: entry.path,
      disabled: entry.kind === "symlink" || entry.kind === "other",
      onClick: () => entry.kind === "directory" ? navigate(entry.path) : void selectFile(entry.path),
    }, icon(entry.kind === "directory" ? "folder-simple" : "file-text"), h("span", { class: "files-row-name" }, entry.name),
    entry.kind === "symlink" ? h("span", { class: "files-kind" }, "link") : null))),
    listing === undefined ? h("p", { class: "note" }, projectId === undefined ? "Open a project to browse files." : loading ? "Loading files…" : "Files could not be loaded. Try Refresh.")
      : entries.length === 0 ? h("p", { class: "note" }, "No matching files.") : null,
    listing?.truncated ? h("p", { class: "note" }, "Showing the first 1,000 entries in this folder.") : null);
  }
  async function selectFile(file: string, force = false): Promise<void> {
    if (projectId === undefined) return;
    const target = projectId; const draftKey = key(file); const version = ++fileGeneration;
    readingKey = undefined;
    selected = file; selectedFiles.set(target, file); showEditor(); renderList();
    if (!force && drafts.has(draftKey)) { showEditor(); return; }
    const previous = drafts.get(draftKey);
    if (force && previous !== undefined && previous.text !== previous.document.text) {
      if (!await confirmDiscard(file)) return;
      if (version !== fileGeneration || projectId !== target) return;
    }
    // A pending reload disables edits to this draft so a late read cannot
    // discard text typed after the user approved replacing it.
    readingKey = draftKey; renderEditorStatus();
    try {
      const document = await controller.readFile(target, file);
      if (version !== fileGeneration || projectId !== target) return;
      if (drafts.size >= 24 && !drafts.has(draftKey)) {
        const clean = [...drafts].find((entry) => entry[1].text === entry[1].document.text);
        if (clean !== undefined) drafts.delete(clean[0]); else throw new Error("Save a draft before opening more files (24 maximum).");
      }
      drafts.set(draftKey, { document, text: document.text }); error.textContent = ""; showEditor();
    } catch (failure) { if (version === fileGeneration) error.textContent = message(failure); }
    finally {
      if (version === fileGeneration) { readingKey = undefined; renderEditorStatus(); }
    }
  }
  function showEditor(): void {
    const draft = current(); editorRegion.hidden = draft === undefined;
    if (draft !== undefined) { editor.value = draft.text; filename.textContent = draft.document.path; filename.title = draft.document.path; notice.textContent = draft.document.notice ?? ""; notice.hidden = !draft.document.notice; editor.hidden = !draft.document.editable; }
    renderEditorStatus();
  }
  function renderEditorStatus(): void {
    const draft = current(); const changed = draft !== undefined && draft.text !== draft.document.text;
    dirty.textContent = changed ? "Unsaved" : "";
    const reading = selected !== undefined && readingKey === key(selected);
    save.disabled = saving || reading || !changed || !draft?.document.editable;
    reload.disabled = saving || reading || draft === undefined;
    reload.textContent = changed ? "Discard & reload" : "Reload";
    editor.disabled = saving || reading;
  }
  async function saveCurrent(): Promise<void> {
    const draft = current(); if (draft === undefined || projectId === undefined || selected === undefined || saving || !draft.document.editable || draft.text === draft.document.text) return;
    const target = projectId; const file = selected; const text = draft.text;
    saving = true; renderEditorStatus();
    try { const document = await controller.saveFile(target, file, text, draft.document.version); draft.document = document; if (target === projectId && file === selected) error.textContent = ""; }
    catch (failure) { if (target === projectId && file === selected) error.textContent = message(failure); }
    finally { saving = false; renderEditorStatus(); }
  }
  store.watch((state) => [state.selection.projectId, state.selection.sessionId, state.host.status], () => {
    const state = store.get();
    const next = state.selection.projectId ?? (state.selection.sessionId === undefined ? undefined : `chat:${state.selection.sessionId}`);
    if (next !== projectId) { projectId = next; generation++; fileGeneration++; readingKey = undefined; loading = false; path = next === undefined ? "" : folders.get(next) ?? ""; selected = next === undefined ? undefined : selectedFiles.get(next); listing = undefined; filter.value = ""; error.textContent = ""; showEditor(); renderList(); }
    if (active) void load();
  });
  showEditor(); renderList();
  return { element, setActive(next: boolean) { const opening = next && !active; active = next; if (opening) void load(); } };
}

/** Discard is the only destructive editor action; Cancel receives initial
 * focus and closing the dialog preserves the unsaved text.
 */
function confirmDiscard(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const cancel = h("button", { class: "button button-small", type: "button", onClick: () => modal.close() }, "Cancel");
    const discard = h("button", { class: "button button-primary button-small", type: "button", onClick: () => { resolve(true); modal.close(); } }, "Discard & reload");
    const modal = openModal({ title: "Discard unsaved changes?", onClose: () => resolve(false), content: h("div", { class: "modal-body" },
      h("p", {}, `Replace the unsaved draft for “${path}” with the version on disk?`),
      h("div", { class: "modal-actions" }, cancel, discard)),
    });
  });
}
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
