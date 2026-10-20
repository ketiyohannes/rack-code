# Side chat and Explain with AI

Implemented 2026-10-19 on `feat/ui-overhaul`.

A side chat is a second, read-only conversation that sits beside the work it is about. It is available beside the main session and beside a pull request review. It never interrupts the main session and never changes files.

## Using it

- **Beside a session.** Choose the speech-bubble icon in the session header, or open **Side chat** from the right panel's tool launcher. The panel follows the selected session. Suggestions offer **Summarize progress** and **Explain the latest change**.
- **Beside a pull request.** In a PR review, **Explain with AI** docks the side chat beside the review and asks the selected model to explain the PR. Explanations cover what changed and why, how the pieces fit together, and what a reviewer should check. The speech-bubble icon in the review header shows or hides the panel without sending anything. The inbox and the repository page share the same side chat for a given PR. Opening a PR automatically shows its side chat when the saved conversation has messages. Empty or deleted chats stay closed. Closing the panel keeps it hidden during refreshes; revisiting that PR checks its history again. Automatic reopening does not focus the message box or send another explanation. While docked, the review fills all space to the left of the chat (its reading-width cap is lifted). The chat starts at 460 px; drag its left edge to resize it, or double-click the edge to reset. The width is saved per device and clamped so the review keeps at least 520 px.
- **Right-click actions.** Right-click readable main-chat or PR content to open **Open side chat**. Select text first to use **Ask about selection**: the excerpt (up to 12,000 characters, with a notice if shortened) is appended to an editable question, preserving any current draft. It does not send until you press Enter or Send. PR menus also include **Explain with AI**, **Open in Timeline**, **Open on code host**, and **Copy PR link**. Copy text/selection and Copy link appear where applicable. Inputs and buttons keep their normal behavior. Focus a reading region and press Shift+F10 (or the Context Menu key) to open the same menu; arrows, Home/End, Enter and Escape operate it.
- **Model.** The panel has its own model picker, using the same favorites as the composer. The account is the provider's selected account, with the usual fallback.
- **Controls.** Enter sends; Shift+Enter adds a line. The send button becomes Stop while a reply streams. Escape inside the panel stops only the side chat's reply, never the main run. **New side chat** starts a fresh conversation and removes the previous one.

## Behavior and boundaries

- **Storage.** Each side chat is an ordinary standalone chat session (no project), so it is saved, reloads after restart and counts in Usage. Standalone chats are not listed in the project navigator. The mapping from a context to its side-chat session is a per-device renderer preference (`localStorage` key `sideChat.sessions`). Removing the session elsewhere simply starts a new side chat.
- **Concurrency.** Each side chat has its own session and can run alongside the main conversation. Project sessions also run concurrently in shared folders or isolated worktrees; only one run per session is allowed.
- **Read-only.** Every side-chat run uses the `read_only` permission mode. Providers may read files, for example the project folder given in the context, but cannot write them.
- **Context.** Rack appends hidden context to each prompt after a marker line. The panel shows only the text you typed; the model receives both. Context is bounded to 60,000 characters and says so when shortened.
  - Session: the session title, the execution folder path (the isolated worktree when available), and the 16 most recent user/assistant messages (each up to 2,000 characters). Re-sent every turn, because the main conversation moves on.
  - Pull request: repository, number, title, state, author, branches, head commit, description, the changed-file list with counts, and as many complete per-file patches as fit. Files whose patch the host omitted are marked. The full context is sent on the first turn and whenever the PR head changes; otherwise a short reminder keeps prompts small.
- **Streaming.** Replies stream from the same run events as the main conversation. Tool activity is summarized as "Reading (N steps)" instead of full tool cards.

## Implementation

- `src/desktop/renderer/features/side-chat.ts`: the reusable panel (`createSideChat`). Owns its session ID, runs, messages and model picker. Watches `state.live` for its own runs and re-reads runs and messages from the host when one finishes, because the store keeps finished transcripts only for the selected main session.
- `components/context-menu.ts`: delegated reading-region actions, scoped selection capture, copy actions and keyboard controls, using the shared popover for cursor placement and dismissal.
- `side-chat-contexts.ts`: context builders for sessions and PRs, plus the Explain prompt.
- `side-chat-state.ts`: per-device session mappings and history-based PR dock visibility; stale replies and explicit user choices are guarded per visit.
- `side-chat-prompt.ts`: DOM-free prompt helpers (marker, bounding, visible text), unit tested in `side-chat-contexts.test.ts`.
- `surfaces.ts` registers the core **Side chat** tool. `Controller.openTool` and `AppState.toolRequest` let the session header reveal the right panel with that tool. `pull-requests.ts` and `repository-reviews.ts` dock the panel beside `review-detail.ts`.
- No host, contract or core changes. Side chats use the existing `sessions.create`, `runs.start`, `runs.list`, `sessions.get`, `sessions.remove` and `runs.cancel` commands.

## Not implemented

- Side chats do not answer approval or question requests. Read-only runs rarely raise them; if a provider asks, the request is not shown in the panel.
- There is no side-chat history browser; each context keeps one current side chat.
- Live provider runs were not exercised during implementation. See [changes](changes.md).
