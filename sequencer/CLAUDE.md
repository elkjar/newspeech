# sequencer

Vite + React + Zustand sequencer for the newspeech site. See `../CLAUDE.md` for the broader site conventions and `memory/project_sequencer.md` for architecture / open follow-ups.

## Session-start check (do this before any edit)

The user keeps a dev server running with HMR against the main checkout. Edits land in the browser only when the dev server is rooted at this directory in main, not at a `.claude/worktrees/*/sequencer/` copy left behind by a prior worktree-isolated session.

Verify before editing:

```sh
lsof -p $(lsof -ti tcp:5173) 2>/dev/null | awk '$4=="cwd"{print $NF}'
```

Expected: `/Users/chriselkjar/Documents/Claude/Projects/newspeech/sequencer`.

If the path points anywhere under `.claude/worktrees/`:

1. `kill <pid>` (PID from `lsof -ti tcp:5173`).
2. `cd /Users/chriselkjar/Documents/Claude/Projects/newspeech/sequencer && npm run dev` (run in background).
3. Confirm the new dev server's cwd matches main with the same `lsof` check.

If port 5173 is unbound, the user just isn't running the server yet — start it from main as above.

## Don't start long-lived processes from worktrees

If a task is running inside `.claude/worktrees/<name>/`, do NOT start the dev server (or any other long-lived process) from there. The process will outlive the session, leave its `vite` rooted at the worktree path, and silently swallow future edits to main. Worktrees are for isolated *file changes* only — keep dev servers running from main.
