# Git History Multi-Repository Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the Git History BB plugin so one thread environment can expose several independently selectable Git worktrees without changing its single-repository experience.

**Architecture:** The server continues to resolve the thread's host and environment, but the host becomes responsible for bounded repository discovery and safe resolution of an opaque relative repository key. The frontend first discovers repositories, hides selection for one result, and scopes every history/detail/patch request to the selected key while cancelling stale UI results.

**Tech Stack:** TypeScript, React 19, Zod 4, BB Plugin SDK 0.4.47, Node 22 host entry, Git CLI, Vitest, Testing Library.

**Spec:** `../bb-plugin-workspaces/docs/superpowers/specs/2026-09-10-live-expansion-and-multi-repo-history-design.md`

## Global Constraints

- Develop in a normal fork/clone at `../bb-plugin-git-history`; never edit BB's installed cache.
- Discover only the environment root or immediate directories below `<environment>/repos`; never recursively scan.
- Repository RPC inputs use a validated relative key; clients never select an arbitrary absolute path.
- Every candidate is canonicalized, confined to the environment root, and verified as a Git worktree root.
- Histories remain separate; never merge or interleave commits from different repositories.
- Hide the selector and preserve existing layout/behavior when exactly one repository is available.
- Use Git through argument arrays and keep the plugin read-only.
- Run shell commands through `rtk`.

## File Structure

- `contracts.ts` — shared repository descriptor schemas and repository-aware server/host RPC contracts.
- `repository-discovery.ts` — pure host-side discovery, confinement, and selected-key resolution.
- `repository-discovery.test.ts` — bounded scan, nested worktree, symlink, and invalid-key tests.
- `host.ts` — existing Git readers plus handlers that resolve a repository key before every Git operation.
- `host.test.ts` — preserves existing Git behavior through the revised host contract.
- `server.ts` — resolves thread environment metadata and forwards environment root plus repository key.
- `server.test.ts` — validates routing, unavailable responses, and safe keys across all RPCs.
- `app.tsx` — repository loading/selection shell and propagation into history, details, and diff views.
- `app.css` — compact selector styling using existing BB theme tokens.
- `app.test.tsx` — single-repository compatibility and multi-repository switching behavior.
- `README.md` / `CHANGELOG.md` — user documentation and an unreleased change note; upstream owns release versioning.

---

### Task 1: Create the Upstream Fork Checkout

**Files:**
- Create checkout: `../bb-plugin-git-history`
- Verify: `../bb-plugin-git-history/package.json`

**Interfaces:**
- Consumes: upstream `yusuf8834/bb-git-history` at release `v0.4.0` or its current default branch if newer.
- Produces: clean branch `feature/multi-repo-workspaces` with `origin` pointing to the user's fork and `upstream` pointing to `yusuf8834/bb-git-history`.

- [ ] **Step 1: Verify GitHub authentication and fork ownership**

Run:

```bash
rtk gh auth status
rtk gh repo view yusuf8834/bb-git-history --json defaultBranchRef,url
rtk gh repo fork yusuf8834/bb-git-history --clone=false
```

Expected: GitHub authentication succeeds and the fork command returns the user's fork URL (or reports that the fork already exists).

- [ ] **Step 2: Clone the fork without touching the installed cache**

Run from the shared environment root:

```bash
rtk git clone https://github.com/alexbart/bb-git-history.git bb-plugin-git-history
cd bb-plugin-git-history
rtk git remote add upstream https://github.com/yusuf8834/bb-git-history.git
rtk git fetch upstream
rtk git switch -c feature/multi-repo-workspaces upstream/main
```

Expected: `rtk git status --short --branch` shows a clean `feature/multi-repo-workspaces` branch.

- [ ] **Step 3: Pin the current BB SDK declarations and establish the baseline**

Run:

```bash
rtk npm install --include=dev
rtk bb plugin types --check
rtk npm test
rtk npm run typecheck
rtk npm run build
```

Expected: the existing suite, typecheck, and plugin build pass before changes. If upstream has advanced, record the exact starting commit in the implementation notes and adapt line locations without changing the contracts in this plan.

### Task 2: Add Safe Repository Discovery

**Files:**
- Create: `../bb-plugin-git-history/repository-discovery.ts`
- Create: `../bb-plugin-git-history/repository-discovery.test.ts`

**Interfaces:**
- Consumes: `runGit(cwd, args, signal)`-compatible Git executor and an absolute thread environment path.
- Produces: `RepositoryDescriptor`, `discoverRepositories(environmentPath, signal, run)`, and `resolveRepositorySelection(environmentPath, repositoryKey, signal, run)`.

- [ ] **Step 1: Write failing discovery and confinement tests**

Add fixtures that create two repositories under `root/repos/api` and `root/repos/web`, a plain child, a deeper `root/repos/group/nested` repository, and a symlink escaping `root`. Assert:

```ts
const signal = new AbortController().signal;
expect(await discoverRepositories(root, signal, runGit)).toEqual([
  { key: "repos/api", name: "api" },
  { key: "repos/web", name: "web" },
]);
await expect(resolveRepositorySelection(root, "../outside", signal, runGit))
  .rejects.toThrow(/repository selection/i);
await expect(resolveRepositorySelection(root, outsideAbsolutePath, signal, runGit))
  .rejects.toThrow(/repository selection/i);
```

Also assert that a root Git worktree returns only `{ key: ".", name: basename(root) }` and does not scan `repos/*`.

- [ ] **Step 2: Run the focused test and verify failure**

Run:

```bash
rtk npm test -- repository-discovery.test.ts
```

Expected: FAIL because `repository-discovery.ts` does not exist.

- [ ] **Step 3: Implement bounded discovery**

Implement these exported contracts:

```ts
export type RepositoryDescriptor = { key: string; name: string };
export type GitRunner = (
  cwd: string,
  args: string[],
  signal: AbortSignal,
) => Promise<string>;

export async function discoverRepositories(
  environmentPath: string,
  signal: AbortSignal,
  run: GitRunner,
): Promise<RepositoryDescriptor[]>;

export async function resolveRepositorySelection(
  environmentPath: string,
  repositoryKey: string | undefined,
  signal: AbortSignal,
  run: GitRunner,
): Promise<string>;
```

Use `realpath`, `readdir({ withFileTypes: true })`, `resolve`, `relative`, and `isAbsolute`. A candidate is accepted only when its canonical path is inside the canonical environment root and `git rev-parse --show-toplevel` canonicalizes to that exact candidate. `resolveRepositorySelection` rediscoveries the allowed set, chooses the sole result when the key is absent, and otherwise requires an exact key match.

- [ ] **Step 4: Run focused tests**

Run:

```bash
rtk npm test -- repository-discovery.test.ts
```

Expected: PASS for root, multi-repository, ignored nested/non-Git children, escaping symlink, traversal, absolute path, missing key, and stable sort cases.

- [ ] **Step 5: Commit discovery as an independent security boundary**

```bash
rtk git add repository-discovery.ts repository-discovery.test.ts
rtk git commit -m "feat: discover thread repositories safely"
```

### Task 3: Make Host RPCs Repository-Aware

**Files:**
- Modify: `../bb-plugin-git-history/contracts.ts`
- Modify: `../bb-plugin-git-history/host.ts`
- Modify: `../bb-plugin-git-history/host.test.ts`

**Interfaces:**
- Consumes: `resolveRepositorySelection()` from Task 2.
- Produces: host `repositories` RPC plus repository-key-aware `history`, `historyRevision`, `details`, `patch`, and `workingPatch` handlers.

- [ ] **Step 1: Write failing host contract tests**

Add a workspace-root fixture and assert:

```ts
const repositories = await harness.experimental_call("repositories", {
  environmentPath: workspaceRoot,
});
expect(repositories.repositories.map((repo) => repo.key)).toEqual([
  "repos/api",
  "repos/web",
]);

const history = await harness.experimental_call("history", {
  environmentPath: workspaceRoot,
  repositoryKey: "repos/web",
  offset: 0,
  limit: 20,
});
expect(history.repoName).toBe("web");
```

Update each existing host call to pass `environmentPath: repo` and omit `repositoryKey`, proving one-repository compatibility.

- [ ] **Step 2: Run host tests and verify contract failure**

```bash
rtk npm test -- host.test.ts
```

Expected: FAIL because the host contract still expects `repoPath` and has no `repositories` method.

- [ ] **Step 3: Define shared schemas**

In `contracts.ts`, add and export:

```ts
export const repositoryDescriptorSchema = z.object({
  key: z.string().min(1).max(16_384),
  name: z.string().min(1).max(512),
}).strict();

const repositorySelectionSchema = z.object({
  environmentPath: z.string().min(1).max(16_384),
  repositoryKey: z.string().min(1).max(16_384).optional(),
}).strict();
```

Add `repositories` output `{ repositories: RepositoryDescriptor[] }`. Replace `repoPath` in every existing host input with `environmentPath` and optional `repositoryKey`.

Replace the temporary structural `RepositoryDescriptor` declaration from Task 2 with `import type { RepositoryDescriptor } from "./contracts"`, so the host, server, and frontend share one name.

- [ ] **Step 4: Route every host handler through safe selection**

Export `runGit` from `host.ts` or move it into `repository-discovery.ts` without duplicating execution logic. At the start of each existing handler use:

```ts
const repoRoot = await resolveRepositorySelection(
  environmentPath,
  repositoryKey,
  context.signal,
  runGit,
);
```

Register `repositories` as:

```ts
repositories: async ({ environmentPath }, context) => ({
  repositories: await discoverRepositories(environmentPath, context.signal, runGit),
}),
```

Delete the old unrestricted `resolveRepository(repoPath)` path.

- [ ] **Step 5: Run host and contract tests**

```bash
rtk npm test -- repository-discovery.test.ts host.test.ts
rtk npm run typecheck
```

Expected: PASS; no handler accepts a client-selected absolute repository path.

- [ ] **Step 6: Commit the host contract**

```bash
rtk git add contracts.ts host.ts host.test.ts repository-discovery.ts
rtk git commit -m "feat: route git history by repository key"
```

### Task 4: Add Server Repository Routing

**Files:**
- Modify: `../bb-plugin-git-history/contracts.ts`
- Modify: `../bb-plugin-git-history/server.ts`
- Modify: `../bb-plugin-git-history/server.test.ts`

**Interfaces:**
- Consumes: Task 3 host contract.
- Produces: public `repositories({ threadId })` RPC and optional `repositoryKey` on every existing public RPC.

- [ ] **Step 1: Write failing server routing tests**

Use the fake plugin host to return two descriptors from host discovery. Assert that `repositories` routes by `environment.hostId`, and that all five data RPCs forward the same target:

```ts
expect(harness.inspection.experimental_hostRpcCalls).toContainEqual({
  method: "details",
  hostId: "host-1",
  input: {
    environmentPath: "/workspace/root",
    repositoryKey: "repos/api",
    hash,
  },
});
```

Also assert that `repositoryKey: "/tmp/other"` is rejected by the host boundary and that a missing/unready thread environment returns `unavailableReason` from `repositories`, `history`, and `historyRevision`.

- [ ] **Step 2: Run the server test and verify failure**

```bash
rtk npm test -- server.test.ts
```

Expected: FAIL because the public RPCs do not carry `repositoryKey` and `repositories` is unregistered.

- [ ] **Step 3: Extend the public contract**

Add:

```ts
const threadRepositorySchema = z.object({
  threadId: z.string().min(1),
  repositoryKey: z.string().min(1).max(16_384).optional(),
}).strict();

repositories: {
  input: z.object({ threadId: z.string().min(1) }).strict(),
  output: z.object({
    repositories: z.array(repositoryDescriptorSchema),
    unavailableReason: z.string().nullable(),
  }).strict(),
},
```

Build every existing input from `threadRepositorySchema`; keep `repositoryKey` optional for compatibility.

- [ ] **Step 4: Replace `RepositoryTarget.repoPath` with `environmentPath`**

Keep thread environment validation in `repositoryForThread`, but return:

```ts
interface RepositoryTarget {
  hostId: string;
  environmentPath: string;
}
```

Forward `{ environmentPath, repositoryKey, ...operationFields }` to the selected host for every RPC. The `repositories` handler calls the host discovery method. Only `RepositoryUnavailableError` becomes an unavailable payload; Git and validation errors continue to surface as RPC failures.

- [ ] **Step 5: Run server and full backend tests**

```bash
rtk npm test -- server.test.ts host.test.ts repository-discovery.test.ts
rtk npm run typecheck
```

Expected: PASS with identical host target fields for history, revision, details, commit patch, and working patch.

- [ ] **Step 6: Commit server routing**

```bash
rtk git add contracts.ts server.ts server.test.ts
rtk git commit -m "feat: expose repositories for thread history"
```

### Task 5: Add Repository Selection to the Panel

**Files:**
- Modify: `../bb-plugin-git-history/app.tsx`
- Modify: `../bb-plugin-git-history/app.css`
- Modify: `../bb-plugin-git-history/app.test.tsx`

**Interfaces:**
- Consumes: Task 4 public RPC contract.
- Produces: hidden single-repository behavior and an accessible selector that scopes all history UI RPCs.

- [ ] **Step 1: Write failing frontend tests**

Add one test where `repositories` returns one result and assert `queryByLabelText("Repository")` is null. Add another where it returns API and Web; switch the selector and assert:

```ts
expect(panel.inspection.rpcCalls).toContainEqual({
  method: "history",
  input: {
    threadId: "thread-1",
    repositoryKey: "repos/web",
    offset: 0,
    limit: 200,
  },
});
```

Expand a commit and open both commit and working-tree diffs, asserting `repositoryKey` is present in `details`, `patch`, and `workingPatch`. Use deferred promises to prove a late API response cannot overwrite Web after switching.

- [ ] **Step 2: Run the frontend test and verify failure**

```bash
rtk npm test -- app.test.tsx
```

Expected: FAIL because the repository discovery call and selector do not exist.

- [ ] **Step 3: Split selection ownership from repository history state**

Keep `GitHistoryPanel({ threadId })` as the discovery shell and move the current body to:

```ts
function RepositoryHistoryPanel({
  threadId,
  repositoryKey,
  repositories,
  onSelectRepository,
}: {
  threadId: string;
  repositoryKey: string;
  repositories: RepositoryDescriptor[];
  onSelectRepository: (key: string) => void;
})
```

The shell calls `repositories`, selects the first result initially, retains the current key when rediscovery still contains it, and renders a clear unavailable state when none exist. Key `RepositoryHistoryPanel` by `${threadId}:${repositoryKey}` so pagination, detail, search, diff, scroll, and polling state reset together.

- [ ] **Step 4: Propagate the repository key through every call**

Add `repositoryKey: string` to `CommitList`, `InlineCommitFiles`, and `FileDiffPanel`. Every call must use:

```ts
rpc.call("history", { threadId, repositoryKey, offset, limit });
rpc.call("historyRevision", { threadId, repositoryKey });
rpc.call("details", { threadId, repositoryKey, hash });
rpc.call("patch", { threadId, repositoryKey, hash, path });
rpc.call("workingPatch", { threadId, repositoryKey, path });
```

Include `repositoryKey` in effect dependencies and component keys. Continue using `requestSequence` and local `active` flags to ignore stale requests.

- [ ] **Step 5: Render and refresh the selector**

When `repositories.length > 1`, render a native select in the existing toolbar:

```tsx
<label className="git-repository-select">
  <span className="sr-only">Repository</span>
  <select
    aria-label="Repository"
    value={repositoryKey}
    onChange={(event) => onSelectRepository(event.target.value)}
  >
    {repositories.map((repository) => (
      <option key={repository.key} value={repository.key}>{repository.name}</option>
    ))}
  </select>
</label>
```

Use existing theme variables in `app.css`. Refresh repository discovery on panel refresh and during the existing 15-second polling tick so append-only session additions appear without coupling to Workspaces realtime.

- [ ] **Step 6: Run frontend and complete automated checks**

```bash
rtk npm test -- app.test.tsx history-refresh.test.ts graph.test.ts ref-layout.test.ts
rtk npm test
rtk npm run typecheck
rtk npm run build
```

Expected: all tests, typecheck, and plugin build pass. The app test proves single-repo compatibility, complete key propagation, switching, and stale-response suppression.

- [ ] **Step 7: Commit the frontend feature**

```bash
rtk git add app.tsx app.css app.test.tsx
rtk git commit -m "feat: select repository in git history"
```

### Task 6: Document, Install, and Submit Upstream

**Files:**
- Modify: `../bb-plugin-git-history/README.md`
- Modify: `../bb-plugin-git-history/CHANGELOG.md`

**Interfaces:**
- Consumes: verified implementation from Tasks 1–5.
- Produces: locally installed plugin and a reviewable upstream pull request.

- [ ] **Step 1: Document multi-repository behavior**

Add a README section explaining root-repository behavior, bounded `repos/*` discovery, selector visibility, and independent histories. Add an `Unreleased` changelog entry. Do not change `package.json`; the upstream maintainer owns release versioning.

- [ ] **Step 2: Run the final immutable verification set**

```bash
rtk bb plugin types --check
rtk npm test
rtk npm run typecheck
rtk npm run build
rtk git diff --check
rtk git status --short
```

Expected: every check passes and only the intended documentation files remain uncommitted.

- [ ] **Step 3: Commit release documentation**

```bash
rtk git add README.md CHANGELOG.md
rtk git commit -m "docs: describe multi-repository history"
```

- [ ] **Step 4: Switch the live BB installation to the verified local checkout**

Capture current settings and source first:

```bash
rtk bb plugin config git-history
rtk bb plugin list --json
rtk bb plugin install /Users/alexbart/.bb/personal-workspaces/env_82s8ksh6yi/bb-plugin-git-history --yes
rtk bb plugin reload git-history
rtk bb plugin config git-history
rtk bb plugin list --json
```

Expected: `git-history` is running from the local path, its two existing settings retain their values, and its bundle reports SDK 0.4.47 compatibility. Do not remove the plugin as part of the switch because removal may discard plugin-owned data.

- [ ] **Step 5: Exercise the live single- and multi-repository flows**

Open Git History on an ordinary thread and on a disposable Workspaces thread. Verify no selector on the ordinary thread; verify every `repos/*` worktree appears and switches cleanly on the workspace thread; verify commit details and both patch modes belong to the selected repository.

- [ ] **Step 6: Push and open the upstream pull request**

Create `/tmp/bb-git-history-pr.md` with `apply_patch` using this body:

```markdown
## Summary

- discover a thread environment's root repository or immediate `repos/*` worktrees
- select one repository and scope history, details, and patches to it
- reject absolute, traversing, nested, non-Git, and root-escaping repository targets
- preserve the existing single-repository panel without a selector

## Verification

- `npm test`
- `npm run typecheck`
- `npm run build`
```

Then run:

```bash
rtk git push -u origin feature/multi-repo-workspaces
rtk gh pr create --repo yusuf8834/bb-git-history --base main --head alexbart:feature/multi-repo-workspaces --title "feat: support multi-repository thread workspaces" --body-file /tmp/bb-git-history-pr.md
rtk gh pr checks --repo yusuf8834/bb-git-history
```

The PR body must summarize the generic discovery contract, confinement protections, single-repository compatibility, UI selector, and exact test/build commands. If GitHub refuses fork/push/PR creation, keep the local commits and provide `https://github.com/yusuf8834/bb-git-history/compare/main...alexbart:bb-git-history:feature/multi-repo-workspaces` plus the failure text.
