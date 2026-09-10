---
name: multi-repo-workspaces
description: Work safely inside a BB Workspaces multi-repository session. Use when the current working directory contains a Workspaces session.json or the user asks about the repositories available in a multi-repo workspace thread.
---

# Multi-repository workspace sessions

A Workspaces session has one common root and an isolated Git worktree for each selected repository.

## Discover the session

1. Read `session.json` at the session root. Treat its repository list as the authoritative scope for this task.
2. Read the root `AGENTS.md` for the repository map and shared workspace guidance.
3. Before modifying a repository, enter its `repos/<alias>` directory and read every applicable `AGENTS.md` in that repository.

Do not search for or modify sibling repositories that are absent from `session.json`.

## Work across repositories

- Run Git commands from the specific `repos/<alias>` checkout they apply to. The session root is not itself a Git repository.
- Keep changes separated by repository and report validation results for each repository.
- When an interface change spans repositories, update the producer and consumers coherently, then run the narrow tests in every affected checkout.
- Do not move files between repositories as a substitute for making the corresponding repository changes.
- Do not change the session manifest, or remove session worktrees yourself.

