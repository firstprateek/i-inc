# Brain (V1 design): an indexed LLM wiki

Status: approved 2026-10-20. Built: the page format, index and maps (T56, #78); the snapshot into sandboxes, automatic retrieval into briefs and turns, and pages-used visibility (T57). Not yet: writing by diff harvest, the Brain changes feed and the tidy-up (T58, T58+).

## Goal

Every employee and the company as a whole get better with each ticket and conversation: what they
learn is written down once, kept tidy, and **found again automatically** when it matters. V1 is a
linked markdown wiki with a SQLite search index, in the spirit of
[Karpathy's LLM wiki](https://venturebeat.com/data/karpathy-shares-llm-knowledge-base-architecture-that-bypasses-rag-with-an)
and the owner's own `~/llm-wiki`. Vector RAG can come later as a boost, not the foundation.

## What is wrong today

- Pages live as git repos on the mini (`~/.i-inc/knowledge/handbook` and `brains/<employee>`), and
  retros append at most two lessons per ticket.
- **Nothing ever reads them back.** No brief, prompt or sandbox gets the handbook or a brain; only
  the employee's system prompt reaches an agent. `docs/spec.md` and `docs/architecture.md` claim
  otherwise and need correcting.
- Pages have no frontmatter, edits only append (so pages rot), and there is no index or map.
- Company policies wait for the owner's approval.

## Principles

- **Markdown in git is the truth; SQLite is a disposable index** rebuilt from git at any time.
- **One page per stable topic.** Edits rewrite pages rather than append; duplicates are how a wiki
  rots, so the system checks for an existing page before creating one.
- **Write bar:** durable (true in a month), non-obvious (not in the code, `--help` or a README),
  reusable (changes a future task). Most tickets write nothing.
- **The map loads always; pages load when relevant.** One line per page, written as a retrieval
  cue.
- **The brain tends itself** (owner's decision): no approval step, but every change is visible and
  revertible.

## Scopes

| Scope | Who reads it | What goes in it |
| --- | --- | --- |
| Company handbook | every employee | facts, policies, one page per project (`projects/<repo>`) |
| Team section | the team's members | the team's conventions and tools |
| Personal brain | that employee only | working style, duty lessons, personality |

A personal assistant's home data never leaves its own brain (the existing errand rule). A repo's
own `CLAUDE.md` stays the repo's business; agents already read it because they work in the repo.

## Page format

```markdown
---
title: Duet release process
description: How Duet cuts a release with Release Please, and the signing step only the owner can do
tags: [duet, releases]
updated: 2026-10-20
sources: [ticket-14, conversation-3f2a]
---
Body in prose or bullets. Link related pages as [[slug]].
```

`description` is the one line that goes into the map, so it is written as "what would make me open
this page?".

## The index

A SQLite database next to the daemon's, rebuilt incrementally on every brain commit:
- `pages(scope, slug, title, description, tags, updated, words, last_used_at, use_count)`
- `pages_fts` (FTS5 over title, description, tags and body; BM25 weighted title > description >
  tags > body)
- `links(from_page, to_page)` from `[[slug]]`, resolved through the reader's scopes

FTS5 works in both Node's and Bun's SQLite (checked on the dev Mac; to confirm on the mini). Embeddings (`sqlite-vec`) can be
added later for fuzzy matches, combined with BM25.

## Reading (V1: yes, automatic, plus on demand)

The sandboxes cannot reach the mini (the walls), so the brain is **copied in**, never served:

1. **Snapshot.** Before a session starts, the daemon copies the employee's readable scopes into
   the sandbox as files (`~/brain/<employee>/<folder>/…`, folders `company`, `team-<id>`,
   `personal`, with an `INDEX.md` map each) plus a tiny `brain search "<query>"` command. *As
   built:* a team shares one sandbox, so the copy is per employee (`~/brain/<employee>/`), a git
   repository whose baseline (`refs/inc/baseline`) is the snapshot; the command builds its in-memory
   index from the files as they are, instead of shipping a filtered copy of the index, so an agent's
   own edits are searchable and nothing binary travels; the copy is sent as a tar stream, only what
   changed, and a refresh keeps the agent's local edits. Long-lived conversations refresh the
   snapshot at each turn boundary.
2. **Always in the prompt:** the maps of the employee's scopes, about 150 lines each at most
   (beyond that a map splits into sections).
3. **Retrieved automatically:** the daemon builds a query from the task (the ticket's title and
   body, or your latest message plus the conversation's topic, the project, file names and error
   text), takes the top 5 pages by BM25 with a boost for the closest scope (own brain > team >
   company), adds pages one link away from the best two, and fits them into a token budget
   (about 3,000 tokens). Each page goes in with its scope, slug and date. Within one conversation,
   pages already in context are not sent again.
4. **On demand:** the agent searches or reads more with its normal tools (`brain search`, `rg`,
   reading the files).
5. **Visible:** the conversation's context panel and each ticket show which pages were used.
   Page reads show up in ACP tool calls (their file locations), which feeds `use_count` and
   `last_used_at`.

Why both automatic and on demand: automatic retrieval makes a lesson apply even when the agent
would not think to look; the on-demand path keeps the prompt small and lets it dig deeper.

## Writing (no approval, owner's decision)

1. **When:** at the end of a ticket (the retro), when a conversation goes idle or ends, and
   whenever you say "remember this".
2. **How:** the agent edits its snapshot files directly, like a person editing a wiki: create,
   update, merge or delete pages, with frontmatter. The daemon collects the diff after the
   session, checks it (allowed scopes, frontmatter, size cap, secret redaction, no home data in
   shared scopes), rejects new pages that duplicate an existing one (it asks the agent to merge
   instead), and commits to git with the ticket or conversation as provenance. Concurrent edits
   merge through git; a conflict keeps both versions for the tidy-up to resolve.
3. **Policies too.** Company policies update without approval (owner's decision); a change to a
   policy page sends you a notification, so you know.
4. **Safety net instead of approvals:** a **Brain changes** feed in the app shows every change
   with its source and a one-click revert. Pages built from untrusted content (web pages, issues,
   other people's repos) are tagged with that source, so a prompt-injected "lesson" is easy to
   spot and revert.

## Tending (the lint pass)

A daily **Tend the brain** ticket, assigned to an employee with a new `librarian` duty: merge
duplicates, resolve contradictions, fix broken links, prune pages that are stale (unused for 60
days and not linked from anywhere), and keep each map under its size limit. It is an ordinary
ticket, so it shows on the board and in the Brain changes feed.

## Migration

One ticket converts the existing pages: add frontmatter and descriptions, merge the appended
fragments into topic pages, build the maps and the index. Then fix the false claims in
`docs/spec.md` and `docs/architecture.md`.

## Build order

1. Page format, index, maps and the migration.
2. Snapshot into sandboxes plus automatic retrieval into ticket briefs (tickets first: they run
   today, so the brain helps immediately).
3. The same for conversations, with the context panel.
4. Writing by diff harvest, the Brain changes feed and revert.
5. The daily tidy-up ticket.

## Later

- Embeddings as a boost; a "Sources" inbox where you drop links or documents and an agent compiles
  them into pages (Karpathy's raw-to-wiki step).
- The brain as an MCP server, once MCP tools arrive.
