# i.inc

A personal company of AI engineers.

You hire agent employees. Each has a brain that grows, and works in its team's sandbox (a walled Linux
machine; a personal assistant gets one of its own). You hand them
tickets on a board and get back pull requests that are already checked, reviewed and proven. You
decide what gets built and what ships. They do the work, even while your laptop is closed.

A Personal Assistant can join the team too. It is designed to triage your mail, draft replies and
propose calendar changes on local models only, with nothing leaving until you approve it.

Employees can use Claude, Codex, Gemini (through Antigravity) or local models, all driven through the
[Agent Client Protocol](https://agentclientprotocol.com). An employee's identity lives in its
memory, so its model can be swapped when it gets stuck or runs out of tokens.

**Status:** built and in daily use on a Mac mini, driven from a laptop and a phone. The app has three
areas: **Conversations** (live sessions with an employee's agent), **Work** (the board and releases;
what needs you is its own page) and **Company** (team, brain, projects, usage, settings). Tickets run
the checked, reviewed and proven pipeline; the brain is an indexed wiki that feeds every brief and
turn; deploys to the mini are automatic, behind a guard that only ships code you approved or merged.
The personal assistant's walls and errand loop are built, but its mail, calendar and web-errand tools
are not connected yet. Agents asking you questions in the middle of a conversation, agent teams that
talk to each other, and MCP tools and skills are future work.

The spec ([docs/spec.md](docs/spec.md)) is the design and the source of truth for behavior, words and
safety. [docs/architecture.md](docs/architecture.md) is what is built, and wins where it differs.
[docs/audit/T63-report.md](docs/audit/T63-report.md) is the last full audit.
