# Ticket 16 proof

Verified the built web app and daemon over HTTP at `127.0.0.1:57300`, using
Chromium at 390×844 and 1440×900. The isolated daemon used an in-memory database,
the demo registry, and scripted agents whose Build sessions wait for interruption.
The browser and HTTP assertions used the public API; the agent's received session
requests were recorded at the test adapter boundary to observe the next brief.
This proves application delivery with a scripted agent, not execution on a real
employee machine.

## Acceptance evidence

1. **Pick or paste images with the same checks and limits — pass.** Created a
   ticket via HTTP, waited for Ada's running Build session, selected a PNG with
   the browser file input, and dispatched a clipboard paste containing another
   PNG. Both previews appeared with the ticket number. An idle employee had no
   picker. HEIC, files over 10 MB and a seventh selection displayed the shared
   validation wording. HTTP uploads rejected SVG, false PNG bytes, seven images,
   oversized files, a missing upload header and a stale ticket ID without
   changing the stored attachment count. Filling the ticket to 24 images then
   sending a 25th returned 400 and left the count at 24.
2. **Stored on the ticket and delivered like Add images — pass.** Aborted the
   browser's first POST, observed two retained previews in the failed message,
   then clicked Retry. The request was multipart with `x-i-inc-upload: 1` and
   `message.ticket`. The returned owner entry identified ticket images 2 and 3;
   their download responses matched the submitted PNG bytes exactly. Public
   ticket events ended with `owner-attached`, then `owner-message`. The original
   Build session remained active. An urgent upload interrupted it; the next
   agent brief contained the note and `.inc/attachments/2-picked.png`,
   `3-pasted.png`, and `4-urgent.png`. Added image 5 through the existing
   attachments endpoint, then image 6 through urgent chat: both appeared in the
   following Build brief under `.inc/attachments/`.
3. **Tests cover a running ticket — pass.** The daemon's chat-image group passed
   all 10 cases, including ordinary and urgent messages during an active Build
   session, image-only messages, rejection cases and unchanged JSON behavior.
   The web chat-image suite passed all 8 cases, including multipart, Retry,
   paste, stale-ticket responses and JSON compatibility. The independent live
   browser/HTTP assertions also passed; see [observations.json](observations.json).

## Checks

`pnpm install --frozen-lockfile`, `pnpm check`, `pnpm typecheck` and `pnpm test`
all passed. The full suite passed 122 core, 289 daemon and 354 web tests
(765 total), plus the Codex host helper regressions. The production web build
also passed.

## UI review

Applied `.claude/skills/ui-review/SKILL.md`, its ten tells and repository lessons.
Ran `tools/ui-check/check.mjs` with six image previews and a typed message in
light and dark at both viewport sizes. All four audits exited 0; all screenshots
were inspected. The white thumbnails are the submitted 1×1 PNG fixture.

- [Light desktop](light-desktop.png) and [dark desktop](dark-desktop.png): no
  errors; warnings for the textarea's 2 px top-edge offset relative to the
  centered buttons and the declared Arial fallback. The intended Figtree and
  Bricolage fonts loaded.
- [Light mobile](light-mobile.png) and [dark mobile](dark-mobile.png): no errors;
  warnings for the intentionally horizontally clipped employee-tab strip and
  the same declared Arial fallback. Image removal and Send remain visible above
  the bottom navigation.

No feature changes were needed during proof.
