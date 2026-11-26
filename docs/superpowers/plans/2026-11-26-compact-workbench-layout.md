# Compact workbench layout implementation plan

**Goal:** Implement the conversation-first layout approved in the 2026-11-26 design review, starting from `main` commit `28981393991d2e34edaae725e06d19123b568b61`.

**Architecture:** Keep the existing two-pane shell, routing, TanStack Query/Redux ownership and trusted workspace panels. Recompose existing shadcn/Radix controls and Lucide icons; do not add dependencies or alter runtime, permission, persistence or model behavior.

**Spec:** The user-approved mockup in this conversation: a single 48px sidebar toolbar, immediately visible project/session groups, a bottom icon toolbar, one conversation title, compact successful-run receipts and an icon-led composer. Content names, model names and permission modes retain text. Every icon has a localized accessible name and a discoverable description.

## Constraints and review focus

- Keep project binding, all-session navigation, theme selection (under Settings → Layout), archived sessions, tree pagination and active/unread outcomes reachable.
- Inline search must not consume another row; Escape clears it and restores focus. A collapsed sidebar must not retain an invisible search filter.
- Preserve tab keyboard navigation and panel trigger refs. Worktree recovery, agent upgrades, fork ancestry, failures and approvals remain visible when relevant.
- Keep Chinese and English catalogs paired; use existing design tokens and controls. Do not introduce schema or API changes.
- Validate narrow panes, long titles, keyboard focus, active/unread states and all successful/error transcript paths. Reuse behavior tests rather than asserting component implementation details.

## Task 1 — Sidebar

Owner: main agent.

- [x] Recompose `frontend/src/app/sidebar.tsx` and `sidebar.css`: header with project/session menu, search/new/collapse; project tree starts immediately below it; bottom deliverables/history/extensions/agents/settings toolbar.
- [x] Remove idle dots; retain meaningful running, approval and unseen-result indications. Reveal row actions on hover/focus without reserving permanent title width.
- [x] Update `shared/i18n/catalogs/navigation.ts` and the existing `scripts/sidebar-smoke.mts` for search open/close/focus, compact geometry, navigation and state preservation.

## Task 2 — Workspace and conversation

Owner: main agent for shell, delegated chat implementer for chat-only files.

- [x] In `workspace-toolbar.tsx` and `workspace.tsx`, move existing session tabs into the 48px toolbar; preserve selected tab, counts, roles and keyboard navigation. Convert panel actions to icons, preserve history navigation in a menu, and make the project breadcrumb the directory-management entry.
- [x] Remove the duplicate normal-session heading and static metadata. Keep conditional worktree/agent/fork context and recovery controls. Update `workspace.css` to maintain the remaining grid rows and usable reading width.
- [x] Compact `composer.tsx`, chat result/attachment presentation and associated styles. Only affected callers opt into compact shared controls. Preserve existing keyboard, queue, permissions and model behavior.

## Task 3 — Verification and delivery

Owner: main agent, with independent review.

- [x] Run repository check/test/build commands, using equivalent `node --import tsx` invocations if the environment blocks tsx CLI IPC; record exact deviations.
- [x] Exercise UI at 1280×800, 1440×900 and 1920×1080, plus a narrow pane, in Chinese and English. Preserve a reproducible fixture and screenshots.
- [x] Review the complete diff, record execution evidence and development-process review in the desktop task log, run the required one-batch file-header review and `check:headers`.
- [x] Commit and push `feat/compact-workbench-layout`; leave `main` unchanged.

## Initial environment evidence

The copied dependency versions match the existing validated terminal checkout. Markdown Vite build and TypeScript compilation succeeded, but the `tsx` CLI failed to create its `/tmp/tsx-1000` IPC pipe. Direct `node --import tsx` works; local HTTP listen works. No system Chromium or Xvfb is present; the bundled Electron 45.4.1 executable is available. Validation will distinguish environment limitations from product failures.

## Outcome

The renderer layout and six bilingual/size acceptance cases passed. Evidence and environment limits are in [`docs/evidence/compact-workbench-layout/2026-11-26.md`](../../evidence/compact-workbench-layout/2026-11-26.md). The runtime suite remains unverified: the unchanged detached-process cleanup test fails in this host and keeps its worker alive. Equivalent checks/build commands and the focused failure reproduction are recorded; production-main/PTY/model acceptance is not claimed.
