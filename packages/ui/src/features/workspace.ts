/**
 * Session workspace presentation: choosing Shared or Isolated before a
 * session's first message, and showing where an existing session runs.
 *
 * Behavior is host-owned (`ProjectsService`, `sessions.*` commands); this
 * module only renders state and calls the controller.
 *
 * - The composer pill offers "Shared folder" and "Isolated worktree" while
 *   the selected session has no messages and no active run. Afterwards it is
 *   disabled with an explanation, because providers tie a conversation to
 *   the directory it started in (T3 Code locks the choice the same way).
 * - The header chip for an isolated session shows its branch and offers
 *   Reveal folder, Copy branch name, and Remove worktree (the branch is
 *   kept; the next run recreates the worktree). A shared session shows a
 *   warning chip while other shared sessions of the project are running,
 *   since their edits are not isolated from each other.
 */
import type { ProjectView, SessionView, SessionWorkspaceView, WorkspaceMode } from "@rack/contracts";
import { createDropdown } from "../components/dropdown.js";
import { openModal } from "../components/modal.js";
import { openPopover } from "../components/popover.js";
import type { Controller } from "../controller.js";
import { h } from "../dom.js";
import { icon } from "../icons.js";
import type { AppState } from "../store.js";

const MODE_LABEL: Readonly<Record<WorkspaceMode, string>> = { shared: "Shared folder", isolated: "Isolated worktree" };

export interface WorkspacePill {
  readonly element: HTMLButtonElement;
  refresh(state: AppState): void;
}

/** Composer control for the selected session's workspace mode. */
export function createWorkspacePill(controller: Controller): WorkspacePill {
  let sessionId: string | undefined;
  const dropdown = createDropdown<WorkspaceMode>({
    ariaLabel: "Workspace", variant: "pill", icon: "git-branch", iconOnly: true, menuWidth: 280,
    onChange: (mode) => {
      if (sessionId !== undefined) void controller.setSessionWorkspaceMode(sessionId, mode);
    },
  });
  return {
    element: dropdown.element,
    refresh(state) {
      const session = state.session?.id === state.selection.sessionId ? state.session : undefined;
      sessionId = session?.id;
      dropdown.element.hidden = session?.projectId === undefined;
      const mode = session?.workspaceMode ?? "shared";
      const running = session !== undefined && Object.values(state.live).some((live) => live.run.sessionId === session.id);
      const locked = session === undefined || session.messages.length > 0 || running;
      dropdown.setOptions([
        { value: "shared", label: MODE_LABEL.shared, icon: "folder-simple", description: "Runs in the project folder. Other shared sessions may edit the same files at the same time." },
        { value: "isolated", label: MODE_LABEL.isolated, icon: "git-branch", description: "Runs in its own Git worktree and branch, created on the first message. Merge the branch when you are done." },
      ], mode);
      dropdown.element.disabled = locked;
      dropdown.element.classList.add("workspace-mode-button");
      dropdown.element.setAttribute("aria-label", `Workspace: ${MODE_LABEL[mode]}`);
      dropdown.element.title = session === undefined ? "Open a session"
        : locked ? `${MODE_LABEL[mode]}. The workspace is fixed after the session's first message.`
          : "Choose where this session runs";
    },
  };
}

/** Header chip describing where the selected session runs. */
export function renderWorkspaceChip(
  session: SessionView,
  workspace: SessionWorkspaceView | undefined,
  project: ProjectView | undefined,
  controller: Controller,
): HTMLElement | null {
  if (session.projectId === undefined) return null;
  const mode = session.workspaceMode ?? "shared";
  if (mode === "shared") {
    const others = (project?.activeWriters ?? []).filter((writer) => writer.mode === "shared" && writer.sessionId !== session.id).length;
    if (others === 0) return null;
    const label = `${others} other ${others === 1 ? "session" : "sessions"} editing this folder`;
    const warning = h("span", {
      class: "chip workspace-chip warning",
      title: `${label}. Shared sessions edit the same files; their changes are not isolated.`,
      aria: { label },
    }, icon("warning-circle"), String(others));
    warning.tabIndex = 0;
    return warning;
  }
  const record = workspace?.workspace;
  const label = record === undefined ? "Isolated · created on first message"
    : `Isolated · ${record.branch}${workspace?.exists === false ? " (worktree removed)" : ""}`;
  const chip = h("button", {
    class: "chip workspace-chip isolated", type: "button",
    disabled: record === undefined,
    title: record === undefined ? "This session will run in its own Git worktree." : `${record.path}\nFrom ${record.baseRef} at ${record.baseCommit.slice(0, 7)}`,
    aria: { haspopup: "menu", label: `Workspace: ${label}` },
    onClick: () => {
      if (record === undefined) return;
      const menu = h("div", { class: "menu", role: "menu" });
      const popover = openPopover({ anchor: chip, content: menu, minWidth: 220, align: "end" });
      const item = (text: string, action: () => void, disabled = false) => h("button", {
        class: "menu-item", type: "button", role: "menuitem", disabled,
        onClick: () => { popover.close(); action(); },
      }, text);
      menu.append(
        h("div", { class: "menu-note" },
          workspace?.exists === false ? "The worktree was removed. The next message recreates it from the branch."
            : `${workspace?.dirty ? "Uncommitted changes" : "No uncommitted changes"} · ${workspace?.commitsAhead ?? 0} ${workspace?.commitsAhead === 1 ? "commit" : "commits"} on branch`),
        item("Reveal worktree folder", () => void controller.openPath(record.worktreePath, record.worktreePath), workspace?.exists === false),
        item("Copy branch name", () => void navigator.clipboard?.writeText(record.branch)),
        item("Remove worktree", () => void removeWorktree(session.id, controller), workspace?.exists === false),
      );
      popover.reposition();
      menu.querySelector<HTMLButtonElement>(".menu-item:not(:disabled)")?.focus();
    },
  }, icon("git-branch"), h("span", { class: "workspace-chip-label" }, record?.branch ?? "Isolated"));
  return chip;
}

/** Removes the worktree, asking before discarding uncommitted changes. */
async function removeWorktree(sessionId: string, controller: Controller): Promise<void> {
  const result = await controller.removeSessionWorkspace(sessionId, false);
  if (result !== "dirty") return;
  const confirm = h("button", { class: "button button-primary", type: "button" }, "Remove and discard changes");
  const cancel = h("button", { class: "button", type: "button" }, "Keep worktree");
  const modal = openModal({
    title: "Remove worktree?",
    content: h("div", { class: "modal-body" },
      h("p", {}, "This worktree has uncommitted changes. Removing it discards them. Committed work stays on the session's branch."),
      h("div", { class: "form-actions" }, cancel, confirm)),
  });
  cancel.addEventListener("click", () => modal.close());
  confirm.addEventListener("click", () => {
    modal.close();
    void controller.removeSessionWorkspace(sessionId, true);
  });
}
