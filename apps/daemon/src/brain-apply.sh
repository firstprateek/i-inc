apply() {
  export LC_ALL=C
  # What copying needs from the machine; anything missing is a clear "no copy", never a broken session.
  for t in git tar base64 comm sort find cp mv rm sed awk grep cut wc tr mkdir dirname chmod; do
    command -v "$t" >/dev/null 2>&1 || { echo "@@fail the sandbox has no $t, which copying the brain needs"; return 1; }
  done
  [ "${B64:-}" = 1 ] || { echo "@@fail base64 -d failed in the sandbox"; return 1; }
  tar --no-same-owner --no-same-permissions -tf "$tmp/in.tar" >/dev/null 2>&1 || { echo "@@fail the sandbox's tar lacks --no-same-owner/--no-same-permissions (GNU tar is needed)"; return 1; }
  git init -q -b main "$tmp/probe" >/dev/null 2>&1 || { echo "@@fail the sandbox's git is older than 2.28 (git init -b is needed)"; return 1; }
  rm -rf "$tmp/probe"
  have=""; [ -f "$R/.snapshot.id" ] && have=$(cat "$R/.snapshot.id")
  if [ "$MODE" = delta ] && [ "$have" != "$BASE" ]; then echo "@@need-full"; return 0; fi
  # Only plain files with plain names come out of the archive.
  if tar -tvf "$tmp/in.tar" | awk 'substr($1,1,1)!="-"{bad=1} END{exit !bad}'; then echo "@@fail the archive holds more than plain files"; return 1; fi
  if tar -tf "$tmp/in.tar" | grep -Eq '^/|(^|/)\.\.(/|$)|\\'; then echo "@@fail an unsafe path in the archive"; return 1; fi
  mkdir -p "$R" && cd "$R" || { echo "@@fail can't enter $R"; return 1; }
  if [ ! -d .git ]; then
    git init -q -b main . || { echo "@@fail git init"; return 1; }
    printf '.bin/\n.snapshot*\n.inc-stage/\n' > .git/info/exclude
  fi
  grep -qxF '.inc-stage/' .git/info/exclude 2>/dev/null || echo '.inc-stage/' >> .git/info/exclude
  rm -rf .inc-stage
  BR=refs/inc/baseline
  # A copy holds no symlinks: nothing it writes can lead out of it. A link that stood where a page or
  # folder of the baseline is goes, and what it hid is put back from the baseline.
  find . -path ./.git -prune -o -type l -print0 | while IFS= read -r -d '' l; do
    l=${l#./}; rm -f -- "$l"; echo "@@unlinked $l"
    git rev-parse -q --verify "$BR" >/dev/null && git checkout -q "$BR" -- "$l" 2>/dev/null
  done
  old=$(git rev-parse -q --verify "$BR" || true)
  head=$(git rev-parse -q --verify HEAD || true)

  # Local edits: tracked files that differ from the baseline (or are gone) and files the agent made.
  { if [ -n "$old" ]; then git diff --name-only -z "$BR" 2>/dev/null | tr '\0' '\n'; fi
    git ls-files -o --exclude-standard -z | tr '\0' '\n'; } | sort -u > "$tmp/dirty"
  cut -f1 "$tmp/manifest" | sort -u > "$tmp/want"
  mkdir -p "$tmp/new" && tar -xf "$tmp/in.tar" -C "$tmp/new" --no-same-owner --no-same-permissions || { echo "@@fail tar"; return 1; }
  (cd "$tmp/new" && find . -type f | sed 's|^\./||' | sort) > "$tmp/sent"

  grep -vFx '.bin/brain' "$tmp/sent" > "$tmp/sent.pages" || true
  comm -12 "$tmp/sent.pages" "$tmp/dirty" > "$tmp/kept"
  comm -23 "$tmp/sent.pages" "$tmp/dirty" > "$tmp/apply"

  : > "$tmp/applied"; : > "$tmp/removed"
  # The new files are first made ready next to their places (same file system), then each is moved in
  # with one rename, after a second look at the local edits: the agent is working in the copy while this
  # runs, and an edit made since the first look must not be overwritten. (A file is renamed over its place
  # only if it is still unedited; if a file stands where a folder should, that file is kept as it is.)
  stage=.inc-stage
  mkdir -p "$stage" && cp -R "$tmp/new/." "$stage/" || { echo "@@fail copying into the staging folder"; rm -rf "$stage"; return 1; }
  { if [ -n "$old" ]; then git diff --name-only -z "$BR" 2>/dev/null | tr '\0' '\n'; fi
    git ls-files -o --exclude-standard -z | tr '\0' '\n'; } | sort -u > "$tmp/dirty2"
  comm -12 "$tmp/apply" "$tmp/dirty2" > "$tmp/late"
  comm -23 "$tmp/apply" "$tmp/dirty2" > "$tmp/apply2"
  cat "$tmp/late" >> "$tmp/kept"
  if [ -f "$stage/.bin/brain" ]; then
    mkdir -p .bin && mv -f "$stage/.bin/brain" .bin/brain && chmod 755 .bin/brain
  fi
  # A big batch (a first copy, where nothing is edited yet) goes in with one copy; a small one file by file.
  while IFS= read -r p; do rm -f "$stage/$p"; done < "$tmp/late"
  if [ "$(wc -l < "$tmp/apply2" | tr -d ' ')" -gt 100 ] && cp -R "$stage/." . 2>/dev/null; then
    cp "$tmp/apply2" "$tmp/applied"
  else
    while IFS= read -r p; do
      if mkdir -p "$(dirname "$p")" 2>/dev/null && mv -f "$stage/$p" "$p" 2>/dev/null; then echo "$p" >> "$tmp/applied"
      else echo "$p" >> "$tmp/kept"; fi
    done < "$tmp/apply2"
  fi
  rm -rf "$stage"

  if [ -n "$old" ]; then
    git ls-tree -r -z --name-only "$BR" | tr '\0' '\n' | sort > "$tmp/tracked"
    comm -23 "$tmp/tracked" "$tmp/want" > "$tmp/gone"
    while IFS= read -r p; do
      if grep -qFx -- "$p" "$tmp/dirty" && [ -e "$p" ]; then echo "$p" >> "$tmp/kept"
      else rm -f -- "$p"; echo "$p" >> "$tmp/removed"; fi
    done < "$tmp/gone"
  fi

  # The new baseline: the old one with the upstream changes that were applied, and no local edit.
  export GIT_INDEX_FILE="$tmp/index"
  if [ -n "$old" ]; then git read-tree "$BR"; else git read-tree --empty; fi
  if [ -s "$tmp/applied" ]; then tr '\n' '\0' < "$tmp/applied" | git update-index --add -z --stdin; fi
  if [ -s "$tmp/removed" ]; then tr '\n' '\0' < "$tmp/removed" | git update-index --force-remove -z --stdin; fi
  tree=$(git write-tree)
  unset GIT_INDEX_FILE
  if [ -z "$old" ] || [ "$tree" != "$(git rev-parse "$old^{tree}")" ]; then
    ci=$(git -c user.name=i.inc -c user.email=daemon@i-inc.local -c commit.gpgsign=false commit-tree "$tree" ${old:+-p "$old"} -m "snapshot $NEW")
    git update-ref "$BR" "$ci"
    if [ -z "$head" ] || [ "$head" = "$old" ]; then git update-ref HEAD "$ci"; git reset -q; fi
  fi
  node -e 'const {DatabaseSync}=require("node:sqlite");const d=new DatabaseSync(":memory:");d.exec("create virtual table t using fts5(x)")' >/dev/null 2>&1 || echo "@@warn no-search"
  cp "$tmp/meta.json" .snapshot.json
  printf '%s' "$NEW" > .snapshot.id
  sort -u "$tmp/kept" | sed 's/^/@@kept /'
  echo "@@synced $NEW applied=$(wc -l < "$tmp/applied" | tr -d ' ') removed=$(wc -l < "$tmp/removed" | tr -d ' ') kept=$(sort -u "$tmp/kept" | wc -l | tr -d ' ')"
}
