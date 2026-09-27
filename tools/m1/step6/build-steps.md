This session does the Build and Checks stages, then opens a draft PR:

1. In ~/work/duet, on the branch inc/1-readme-dev-commands, make the change as planned.
2. Check that only README.md changed, and that the commands you list exist in package.json.
3. Commit with a conventional message (docs: …).
4. Push the branch: `git push -u origin inc/1-readme-dev-commands`. Git is already signed in
   through gh.
5. Open a draft PR with `gh pr create --draft`. In its body, say it's an i.inc M1 test: one
   engine planned it, then another built it after an engine switch, from a resume brief.
6. Add what you did to ~/work/inc-1/notes.md, and finish with the PR's link.
