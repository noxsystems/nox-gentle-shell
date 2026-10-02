# Nox Card Information Cleanup

## Objective

Make the detailed Nox card complementary to Gentle Shell with grouped token/cache usage, process RSS and active tools, a conditional red high-context warning, and a separate Spotify section.

## Problem and rationale

The original screenshot repeated model/provider, context percentage and session cost already shown by the host header. The first readable-label cleanup was implemented and reviewed. The user then approved a more compact grouped preview: TOKENS (Input/Output), CACHE (Read/Write), SESSION (Pi RAM and active tools), conditional red context warning, and Spotify. RAM means the process RSS of the Pi host, not memory exclusively attributable to a conversation or a remote model. The context block is an intentional warning only at >=80%, not a permanent duplicate.

## Scope and constraints

- Detailed bordered card only: no model or cost rows; no permanent context metric.
- Group TOKENS Input/Output and CACHE Read/Write in two columns where width permits, falling back safely at narrow widths.
- SESSION displays Pi RAM in MiB (process RSS) and current active tools; replace message/assistant-count rows without changing their underlying collection.
- Sample RSS on existing telemetry refresh paths, with deterministic injection for tests and safe unavailable fallback; no memory timers/polling or fabricated per-session attribution.
- Show both context warning lines in red/error styling for valid finite context percentages >=80%; hide below80 or unavailable. RAM remains neutral because no limit is defined.
- Preserve separate Spotify playback states.
- Preserve compact telemetry, context alerts, host contract, widths, theme geometry and telemetry collection.
- Reconcile the old context-alert document only with proven local Nox history: `43449e6 feat(shell): add themed telemetry and context alerts`, merged by `efd7ada` (PR #7); initial `main` was clean.
- Do not infer historical authorization, LSP/review completion, Gentle Pi commit or updater completion from Nox history.
- No cross-repository changes, unrelated metrics, fetch, updater, push or PR. Process RSS is the only newly authorized measurement.
- User explicitly authorized local commits after accepting the result. Push/PR/merge remain unauthorized.

## Tasks

- [x] NCI-1 — Reconcile the historical Nox delivery log and implement readable complementary card content with observed RED/GREEN tests. Included in work-unit commit `f33a672`.
- [x] NCI-4 — Implement approved grouped card, event-driven process RSS, and conditional red context warning with observed RED/GREEN tests. Included in work-unit commit `f33a672`.
- [x] NCI-2 — Record diagnostics, focused/full tests, build, diff, independent verification and native review. Full150/150 passes; exact known focused refresh flake is documented, not falsely claimed green. Verified behavior/tests delivered together in `f33a672`.
- [x] NCI-3 — Record user acceptance, observed verification and remaining live limitations; obtain commit authorization and commit the coherent work unit. User accepted the result; `f33a672` created. Narrow live resize/palette were not independently observed and remain follow-up limitations.

## Acceptance criteria

- Detailed card does not show model, session cost, or permanent context capacity/percent.
- Grouped labels distinguish input, output, cache reads/writes, process RAM and active tools; no invented conversation-only RAM or message/tool/error semantics.
- Process RSS sampled on existing events, unavailable safely when sampling fails; telemetry modes retain no new recurring timers.
- High-context block appears in red/error role at valid >=80%, absent below80 or missing/invalid; existing warning notification hysteresis80/<75 stays unchanged.
- Spotify enabled/disabled, idle/playing/unavailable states remain supported.
- Card has no width overflow, including existing narrow-width tests and themed geometry.
- Compact telemetry and context-alert behavior remain unchanged.
- Historical document distinguishes verified Nox delivery from unknown host checks.
- Live reload/resize and any unavailable checks are explicitly reported, never inferred from unit tests.

## Checks

- NCI-4 test-first: `npx tsx --test test/presentation.test.ts test/runtime.test.ts` RED before renderer/runtime edits, then GREEN.
- RSS sampler injected into controller; finite nonnegative values only, catch failures, sample on existing refresh paths only, never in render callbacks.
- Wide paired versus narrow stacked rows; warning tests at79.9/80/84/100 and null/non-finite/out-of-range input; semantic error role on both warning lines.
- Compact telemetry, notification80/<75, Spotify and event-driven/no-new-timer behavior preserved.
- LSP diagnostics before build on changed TypeScript files.
- `npm test`, `npm run build`, `git diff --check`.
- Native review switch read: `gentle-ai review mode status`; inspect only when enabled.
- Render representative detailed cards at narrow and regular widths using existing test facilities; live host reload/resize remains manual if no interaction access exists.

## Progress and evidence

- Read-only exploration completed; user chose `detailed-cache-activity`.
- Created branch `fix/nox-card-information` from clean `main` at `d8cbb2f`.
- Worker updated presentation, focused tests, README and historical context-alert log; no commits.
- Focused RED: 19 tests, 13 passed / 6 failed before renderer edits. GREEN: 19 passed / 0 failed.
- Initial full suite: 140 passed / 6 failed on old detailed-card runtime expectations.
- Runtime assertion follow-up observed RED 17 passed / 6 failed, then GREEN 23 passed / 0 failed; presentation remains 19/19.
- Follow-up full-suite runs: 144/146 then 145/146. Spotify descriptor-lock reacquisition failed both; unexpected widget refresh failed only first run. Both failure signatures were subsequently reproduced on base; full suite is still not green.
- `npx tsc --noEmit`, `npm run build`, and `git diff --check` passed; generated `dist/` has no tracked diff.
- Parent runtime LSP reports 0 diagnostics; session `lens_diagnostics(mode=all)` reports no issues across 3 diagnosed files.
- Independent verifier comparison completed: candidate full 145/146 (Spotify descriptor assertion `1 !== 0`); base archive `d8cbb2f` full 145/146 (widget refresh `3 !== 2`), then 144/146 (same refresh plus identical Spotify assertion).
- Focused Spotify tests pass 4/4 and runtime 23/23 on both trees; independent candidate presentation spot check passes 19/19. Both full-suite failure signatures are known base/environment-dependent failures, not newly introduced signatures; root cause remains unproven. No Spotify fixes authorized.
- Verifier confirmed live tracked diff SHA256 and status unchanged. Evidence logs: `/tmp/nox-independent-verify.dN2Z1j/*.log`. Disposable base extraction remains there because safety tooling blocked cleanup; repository unaffected.
- Parent LSP diagnostics: `extensions/presentation.ts` and `test/presentation.test.ts`, 0 diagnostics.
- Worker `git diff --check` passed; initial build was not run because it emits to `dist/`, outside the original allowed surfaces.
- User selected `authorize-runtime-and-dist`: permit updates to `test/runtime.test.ts` and generated `dist/**` outputs for build validation. No product/source scope expansion.
- Native review switch on (global). Frozen work-unit candidate: 5 tracked files, 254 changed lines, medium risk; continuity-only untracked feature document excluded from the review candidate.
- Native lineage `review-aa8af902836056bf`, reliability lens, returned `approved`; exact acknowledgement completed with `authority: burned`, target `sha256:734511da32172d9ef61e21cdbe978b8dc5a2f1ca26795bc58613fd4dd776b9cc`, consumed revision `sha256:c26f38d6ee037a0670e26594a1a2636d99f3cc6ca749e968af878b988fbae5dc`. No STATUS after burn; no delivery authority inferred.
- ASSESS failed on undeclared untracked feature document, returning unassessable/high-equivalent with independent verifier required. Independent read-only candidate/base and presentation verification above already supplies that path; assessment is not claimed successful.
- At native-review time commit authorization was pending. User subsequently accepted the result and authorized local commits; source work unit `f33a672` now closes the grouped behavior with its tests and README. Earlier full-suite failures are historical evidence; newest NCI-4 full run passes150/150 while focused refresh flake still exists.
- First-cleanup plaintext cards rendered at widths24/47. User screenshot after `/reload` shows the first cleanup at normal width without obvious clipping; narrow live resize and measured contrast remain unverified.
- User explicitly approved the grouped RAM/red-context preview in the next iteration. Previous approved native target is historical evidence only; a new candidate review is required after source changes.
- Read-only explorer `murg1zry-1-6332` completed mapping: inject RSS sampler at runtime refreshSnapshot, pass optional presentation data without expanding session telemetry aggregation; use active theme error role, visibleWidth-based paired row helper with stacked fallback. Pi extension/TUI docs read by scout.
- Authorized NCI-4 surfaces: `extensions/presentation.ts`, `extensions/runtime.ts`, `test/presentation.test.ts`, `test/runtime.test.ts`, `README.md`; generated `dist/**` only via build. Parent owns this feature document; old context-alert document needs no new changes.
- NCI-4 writer `murg6xdb-2-or3b` completed: optional presentation RSS, injectable snapshot sampler with invalid/throw fallback, paired/stacked groups and both warning lines in semantic error role at valid80..100.
- Observed NCI-4 focused RED33/46 (13 failures including sampler0 calls before source edits), GREEN46/46. Later focused45/46 reproduced only exact known base widget refresh3!=2; lifecycle assertions retained.
- Writer full suite150/150, `npx tsc --noEmit`, `npm run build`, `git diff --check` pass. RDD remains on globally; generated dist has no tracked changes.
- Parent4 changed TypeScript files LSP0; `lens_diagnostics(mode=all)`0 across5 diagnosed files. Current cumulative tracked diff6 files428 additions/98 deletions, versus worker-reported299/98; current tree is verification/review source of truth, not prior line counts.
- Plaintext grouped samples at widths24/47 supplied; live grouped reload/resize and error-palette visibility remain unverified.
- Independent verifier `murgg0zi-3-xjpx` completed without tree mutation: focused45/46, only exact known refresh3!=2 at current runtime test:387; sole full run150/150; types/diff pass. No retries, no new failure signature. Runtime/Spotify environmental cause still unproven.
- Verifier confirmed cumulative428+/98- diff and SHA256 `b908d448e077dae54af1eb570f7fdc66c01410fad3396ba9a998e9a50adcfaef` unchanged; live terminal interaction unavailable.
- New native candidate review `review-cc3e1997476a3fb9` medium6 files526 changed lines, reliability lens, returned approved. Exact acknowledgement completed with authority burned for target `sha256:c7512a915ff21a5c89cddb608ace5284fd177c72058a352e9911349c27741442`, consumed revision `sha256:9b5435c1ce03c88bdb8d612a9dc60a7bfcb745d3b100213cbf70921e0d16c89b`; no STATUS after burn and no delivery authority inferred.
- Current ASSESS remains unavailable because untracked feature log requires a declaration unsupported in its facade input; conservative independent verifier path is satisfied by the exact current-tree verification above. Native approval is separately observed, not inferred from ASSESS.

## Work-unit commit

User explicitly authorized local commits: "ok me gusta realiza commit". Reviewed tracked-diff SHA256 matched `b908d448e077dae54af1eb570f7fdc66c01410fad3396ba9a998e9a50adcfaef` immediately before delivery; no content drift since review/verification.

- Source work unit: `f33a672db497cb8f2db97698cb5abc4ba31ae1db` — `fix(ui): group Nox card with RAM and context warning`.
- Six reviewed tracked files, 428 additions/98 deletions; code, tests, README and reconciled historical document committed together.
- This continuity document is a separate passive delivery record; not part of the frozen executable candidate.
- No push, PR or merge performed.

## Next step

Commit this passive continuity record, then clarify whether the next Spotify-open/Nox-card fix concerns slash-command aliases or keyboard combinations. No shortcut changes are included in this work unit. Narrow live resize, vertical clipping and measured palette contrast remain unverified follow-ups; known base test flakes and temporary archive cleanup are separate.
