# Context Usage Alert and Delivery

## Objective

Track the context-usage alert and historical delivery evidence. Nox delivery is verified; historical authorization, host delivery, review, and updater completion remain unverified.

## Background

The original work covered rail telemetry/card and Gentle Prompt lunar changes in two repositories. Nox was subsequently committed and merged; the Gentle Pi state has not been verified in this reconciliation:

- Nox: `/home/jesus/Freelance/nox-gentle-shell`
- Gentle Pi local host: `/home/jesus/code/gentle-pi`

The user elected to defer the final post-theme live reload/resize inspection. The screenshot discussion proposed a context warning because Nox already receives `ctx.getContextUsage()` and stores `telemetry.context.percent`.

## Confirmed Alert Policy — CUA-2

- Emit one warning when valid context usage crosses upward to `80%` or higher.
- Rearm only after valid usage falls strictly below `75%`.
- Do not repeat notifications while usage remains at or above the warning threshold.
- Missing or unavailable context never alerts or rearms. After compaction, wait for valid usage; a normal below-75% reading may rearm.
- Keep detection event-driven; add no timer or polling.
- Use an extension-owned public Pi UI notification with warning severity in compact, detailed, and off modes while UI exists.
- Exact copy: `Context usage reached {percent}%. Start a new session soon to avoid automatic compaction.`

Non-goals: no critical threshold, metric recoloring, telemetry/card/prompt/fullscreen changes, or Gentle Pi changes.

## Constraints

- Strict TDD remains enabled.
- Nox alert implementation uses public Pi APIs only.
- Preserve compact/detailed/off telemetry behavior and the fullscreen contribution contract.
- Preserve Gentle Pi's local lunar prompt and updater-managed local commit stack.
- Do not fetch manually; `gentle-dev-update` owns all update fetch/rebase operations.
- Do not run the updater while Gentle Pi has uncommitted tracked changes.
- No commit, push, PR, or upstream publication without explicit user authorization in the active session.
- Gentle Pi changes remain local-only unless the user later changes that decision.

## Delivery

- Route: delegated direct implementation for the multi-file Nox alert change.
- Authorized implementation surfaces: `extensions/runtime.ts`, `test/runtime.test.ts`, `README.md`, and this task document.
- Delivery order is mandatory: reconcile → decide policy → implement/verify → live check → commit Nox → commit local Gentle Pi → run updater.
- The updater requires a clean tracked Gentle Pi worktree and will preserve/rebase the local commit stack; it stops safely on conflicts.

## Tasks

### CUA-1 — Reconcile deferred visual work

- [ ] Resume from Engram topic `odd/context-usage-alert-and-delivery/tasks` and read both task documents.
- [ ] Inspect both worktree statuses without fetching or modifying state.
- [ ] Reconcile the current diffs with `odd/tasks/rail-telemetry-card.md`.
- [ ] Run the deferred `/reload` visual check for themed card geometry, host lunar prompt, static `Nox 🌑`, activity row, and resize behavior.

### CUA-2 — Confirm alert semantics

- [x] Confirm warning threshold and hysteresis reset threshold: `80%` / strictly below `75%`.
- [x] Confirm one warning level only; an additional critical threshold is out of scope.
- [x] Confirm session-safety behavior across compact, detailed, and off modes while UI exists.
- [x] Record explicit non-goals and the exact notification copy before implementation.

### CUA-3 — Implement the context threshold alert

- [x] Add RED tests for upward crossing, deduplication above threshold, rearm below reset threshold, unavailable context, compaction, session cleanup, and all telemetry modes.
- [x] Implement event-driven crossing state without timers or polling.
- [x] Emit one extension-owned warning notification per armed crossing.
- [x] Preserve existing telemetry/card/prompt/fullscreen behavior in focused runtime tests.
- [x] Keep context metric styling unchanged; semantic-status recoloring remains out of scope.
- [x] Update README configuration/semantics.
- [x] Run focused tests, full Nox tests, build, and diff check.
- [ ] Run LSP diagnostics, independent verification, and native review (parent-owned).

### CUA-4 — Create work-unit commits

- [ ] Obtain explicit commit authorization.
- [x] Create one Conventional Commit for the complete Nox visual/context-alert work unit: `43449e6 feat(shell): add themed telemetry and context alerts`.
- [ ] Create one separate local-only Conventional Commit for the Gentle Pi width-contract/lunar-prompt host work.
- [ ] Record both commit hashes and verify both worktrees contain only intentional untracked files.
- [ ] Do not push or create PRs unless separately authorized.

### CUA-5 — Exercise the development updater

- [ ] Confirm Gentle Pi tracked state is clean and local commits are present before invoking the updater.
- [ ] Use `gentle-dev-update` as the sole fetch/update owner; do not fetch manually or through subagents.
- [ ] Prefer `gentle-dev-update --full` for the planned end-to-end validation unless the user selects routine mode.
- [ ] Preserve all intentional untracked files and recovery data.
- [ ] If rebase conflicts occur, stop for deliberate manual resolution; never auto-resolve, reset, stash, or clean.
- [ ] Verify final divergence, rebuilt local Gentle AI binary, focused/full checks, and no push.

## Acceptance Criteria

- Deferred final visual behavior is observed or explicitly skipped again and recorded.
- Context warning fires once on an upward threshold crossing and never spams repeated refreshes.
- Warning rearms only after usage falls below the confirmed reset threshold.
- Missing context never produces a false warning.
- All existing Nox visual and telemetry checks remain green.
- Nox and Gentle Pi changes are committed separately only after explicit authorization.
- `gentle-dev-update` completes from a clean tracked Gentle Pi state or stops safely with documented recovery state.
- No remote repository is modified without separate authorization.

## Progress

- CUA-2 policy is confirmed: one warning at valid `>=80%`, rearmed only by valid `<75%`; missing context never alerts or rearms.
- CUA-3 RED was observed for the new behavior tests before runtime implementation. Focused GREEN and refactor validation passed after implementation.
- Verified Nox delivery: `43449e6 feat(shell): add themed telemetry and context alerts`, merged via `efd7ada` (PR #7). The initial `main` for the card cleanup was clean at `d8cbb2f`.
- Historical explicit commit authorization, LSP/independent/native review, Gentle Pi worktree/commit state, and updater completion are unknown; their unchecked items remain unresolved.
- Focused runtime tests passed 23/23; the full Nox suite passed 72/72; `npm run build` and `git diff --check` passed. LSP, independent verification, and native review remain parent-owned and incomplete.

## Next Step

Nox commit creation is complete. Leave unverified historical review, authorization, Gentle Pi delivery, and updater items unchecked; no cross-repository inspection was performed. Current card-cleanup review and any new commit authorization belong to the parent.
