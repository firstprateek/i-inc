# Sessions view, Phase 1: where the work stands

A working note for the session that finishes Phase 1. Remove it from the branch when the work is done.

## The goal

Make Conversations a workspace, not only a chat. Phase 1 is "review the work": a context meter, a git-based review
pane, line comments, then a file browser, content search and `@file`. Later phases (terminal, rewind and fork, agent
reach, app preview, session grid) are not part of this work.

## Branches

| Branch | State |
| --- | --- |
| `fix/edit-line-counts` | Done. Edit counts are the lines changed. |
| `feat/conv-context-meter` | Done. The Usage section shows how full the context is. |
| `feat/conv-review-pane` | Built on both of the above. The last commit, marked `wip`, is unfinished. |

`feat/conv-files` doesn't exist yet. Branch it from `feat/conv-review-pane`.

## The unfinished commit

The fix round stopped part-way. When it stopped, `pnpm check` and `pnpm typecheck` both failed (the type error is at
`apps/web/test/conversations/review.test.ts:914`), while the conversations web tests and `test/review.test.ts` passed.
The last report was that the daemon fixes were done and that the web model, composer and pane were in progress.

## Findings to confirm

Two reviews found these. Check each against the code: some are already fixed in the `wip` commit. Fix what remains,
with a test that fails without the fix, and say which you reject and why.

### Daemon (`apps/daemon/src/review.ts`, reported as done)

1. High: a failing `add -N` or `git diff` reports "Nothing has changed yet" on a copy that has changes.
2. Medium: stderr inside the numstat section drops a file and calls its name unsafe.
3. Medium: assume-unchanged, skip-worktree and `.git/info/exclude` hide changes from the pane.
4. Medium: served text misses credentials the ship scanner catches (npm `_authToken`, netrc logins).
5. Low: a multi-byte character split across chunks in `harness.ts` drops valid non-ASCII file names.
6. Low: with split index on, a list writes a `sharedindex` file into the real `.git`.
7. Low: a project copy with no commits gets a generic failure with a Try again that can't work.
8. Low: PEM redaction shortens a file, so later line numbers and `path:line` comments are wrong.

### Web (`conv-review.ts`, `conv-composer.ts`, `conversations/review.ts`)

9. High: selecting code on one line opens a comment box, because the selection check fails in a shadow root.
10. High: a half-written comment is lost when the owner clicks another line or file, or presses Escape or Cancel.
11. Medium: comments are appended to slash commands, so `/remember` swallows them as its note.
12. Medium: Escape on a list menu also closes the pane.
13. Medium: a comment is matched by line number only, so after a refresh it sits under the wrong code.
14. Medium: past the 20 KB draft cap, all comments stop saving with no warning.
15. Medium: removing a comment drops keyboard focus to the body.
16. Medium: Refresh, Try again and Show all lines lose keyboard focus.
17. Medium: while the agent waits on the owner, the pane says it is working and the permission card can't be reached.
18. Medium: a removed line and an added line with the same number have the same accessible name.
19. Medium: a comment's `path:line` link doesn't go to the line, and does nothing when no diff is showing.
20. Low: a composer switched to another conversation during a send doesn't clear the comments it sent.
21. Low: comments don't sync between tabs, so a second tab can send them again.
22. Low: Send comments also sends a composer draft that the pane hides.
23. Low: removing a queued comment message destroys the comments.
24. Low: a failed refresh hides the comments and Send comments.
25. Low: on a tablet, closing the pane returns focus to a button hidden under the context drawer.
26. Low: the UI checker reports a 2 px overflow on phone comment cards and warns on diff sign cells.

## Then: `feat/conv-files`

1. **Daemon:** read-only routes under `/api/conversations/:id/` to list the working copy's files
   (`git ls-files -co --exclude-standard` in a repo, a bounded `find` otherwise), read one file as text with a size cap
   and a clear answer for binary or too-large files, and search contents with a literal query (`git grep -F` plus
   untracked files, bounded results, a case option, a bounded `grep` otherwise).
2. **Web:** tabs in the review pane (Changes, Files, Search). Files is a collapsible tree with a filter box and a
   read-only viewer with line numbers and the existing highlighter. Search shows results by file and opens the viewer at
   the line. A long list must stay fast.
3. **`@file`:** typing `@` after a space or at the start opens a keyboard list of matching paths, built like the slash
   list with the same accessibility, and inserts the path as text. It must not disturb slash commands, IME composition
   or Enter to send. A New conversation draft has no working copy, so the list doesn't open there.
4. **Links:** a path in a Read tool card opens the viewer when the file exists.

Then review it adversarially, as the review pane was: one pass on safety and correctness, one on product and UI.

## Rules for reading a working copy

- Read-only: never change its files, index, HEAD or refs. Use `GIT_OPTIONAL_LOCKS=0` and a temporary index.
- Everything read from a sandbox is untrusted. Validate paths (no absolute paths, `..`, NUL or leading `-`, and symlinks
  stay inside), cap sizes, time out, quote shell input as `ship-git.ts` does, redact secrets, and render as text.
- Never boot a stopped machine just to read (T75). Say so in one plain sentence and offer a retry.
- Keep demo mode working (`demo-review.ts`) and give a no-project conversation a sensible answer.

## Checked in Claude's adapter (`claude-agent-acp` 0.81.2)

Read from the package, not run:

- Edits usually arrive as snippets, not whole files. A file edited several times can show different counts in Files
  changed and in its diff, and its merged diff can be wrong. The review pane reads git, so it doesn't have this problem.
- Subagent calls carry `parentToolUseId` in `_meta.claudeCode`, and `acp-mapper.ts` drops it.
- `AskUserQuestion` becomes a form elicitation if the client advertises `elicitation.form`.
- `/compact` is handled, but its place in the `/` menu isn't confirmed.

## Still unverified

- Nothing has run against a real sandbox. Check the image's git version: `GIT_NO_LAZY_FETCH` needs about 2.45.
- A read beside a real agent turn, and the queue-wait path to `busy`.
- Comments surviving a real browser reload, and the phone keyboard with the comment box.
- An edit that only changes the final newline shows `+0 −0`, and older conversations keep their stored counts.
