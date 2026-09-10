import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { definePluginApp, useBbNavigate, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import type { SessionSnapshot, Workspace, WorkspaceDraft } from "./src/contracts";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";

type Project = {
  id: string;
  name: string;
  gitRemoteUrl: string | null;
  sources: Array<{ id: string; hostId: string; path: string; isDefault: boolean }>;
};
type Dashboard = { workspaces: Workspace[]; sessions: SessionSnapshot[]; projects: Project[] };

const fieldClass = "w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring";

function Empty({ children }: { children: ReactNode }) {
  return <div className="rounded-lg border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">{children}</div>;
}

function useDashboard() {
  const rpc = useRpc<typeof rpcContract>();
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    rpc.call("dashboard").then((result) => { setDashboard(result as Dashboard); setError(null); }, (cause) => setError(cause instanceof Error ? cause.message : String(cause)));
  }, [rpc]);
  useEffect(load, [load]);
  useRealtime("workspaces-changed", load);
  return { rpc, dashboard, error, setError, load };
}

function aliasFor(name: string): string {
  const normalized = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
  return /^[a-z]/.test(normalized) ? normalized : `repo-${normalized || "project"}`.slice(0, 48);
}

function WorkspaceForm({ projects, initial, onCancel, onSave }: {
  projects: Project[];
  initial?: Workspace;
  onCancel: () => void;
  onSave: (draft: WorkspaceDraft) => Promise<void>;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [instructions, setInstructions] = useState(initial?.instructions ?? "");
  const [selected, setSelected] = useState(() => new Set(initial?.repositories.map((repo) => repo.projectId) ?? []));
  const [pending, setPending] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim() || selected.size === 0 || pending) return;
    setPending(true);
    try {
      const used = new Set<string>();
      const repositories = projects.filter((project) => selected.has(project.id)).map((project) => {
        const existing = initial?.repositories.find((repo) => repo.projectId === project.id)?.alias;
        const base = existing ?? aliasFor(project.name);
        let alias = base;
        let suffix = 2;
        while (used.has(alias)) alias = `${base.slice(0, 44)}-${suffix++}`;
        used.add(alias);
        return { projectId: project.id, alias };
      });
      await onSave({ name: name.trim(), description: description.trim(), instructions, repositories });
    } finally { setPending(false); }
  };
  return (
    <form onSubmit={submit} className="space-y-4 rounded-lg border border-border bg-card p-4">
      <div><label className="mb-1 block text-sm font-medium" htmlFor="workspace-name">Workspace name</label><Input id="workspace-name" aria-label="Workspace name" value={name} onChange={(event) => setName(event.target.value)} autoFocus /></div>
      <div><label className="mb-1 block text-sm font-medium" htmlFor="workspace-description">Description</label><Input id="workspace-description" value={description} onChange={(event) => setDescription(event.target.value)} /></div>
      <div><label className="mb-1 block text-sm font-medium" htmlFor="workspace-instructions">Shared instructions</label><textarea id="workspace-instructions" className={`${fieldClass} min-h-24 resize-y`} value={instructions} onChange={(event) => setInstructions(event.target.value)} placeholder="Context that applies whenever these repositories are used together" /></div>
      <fieldset><legend className="mb-2 text-sm font-medium">Repositories</legend><div className="max-h-64 space-y-1 overflow-y-auto rounded-md border border-border p-2">
        {projects.map((project) => <label key={project.id} className="flex cursor-pointer items-start gap-3 rounded px-2 py-2 hover:bg-muted/60">
          <Checkbox checked={selected.has(project.id)} onCheckedChange={(checked) => setSelected((current) => { const next = new Set(current); checked === true ? next.add(project.id) : next.delete(project.id); return next; })} aria-label={project.name} />
          <span className="min-w-0"><span className="block text-sm font-medium">{project.name}</span><span className="block truncate text-xs text-muted-foreground">{project.sources[0]?.path ?? "No source configured"}</span></span>
        </label>)}
      </div></fieldset>
      <div className="flex justify-end gap-2"><Button type="button" variant="ghost" onClick={onCancel}>Cancel</Button><Button type="submit" disabled={pending || !name.trim() || selected.size === 0}>{initial ? "Save workspace" : "Create workspace"}</Button></div>
    </form>
  );
}

function SessionLauncher({ workspace, projects, rpc, onError }: { workspace: Workspace; projects: Project[]; rpc: ReturnType<typeof useRpc<typeof rpcContract>>; onError: (message: string) => void }) {
  const navigate = useBbNavigate();
  const memberProjects = workspace.repositories.map((member) => projects.find((project) => project.id === member.projectId)).filter((project): project is Project => Boolean(project));
  const [selected, setSelected] = useState(() => new Set(memberProjects.slice(0, 1).map((project) => project.id)));
  const [primary, setPrimary] = useState(memberProjects[0]?.id ?? "");
  const [prompt, setPrompt] = useState("");
  const [pending, setPending] = useState(false);
  const [requestKey, setRequestKey] = useState(() => `launch-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const eligibleHosts = useMemo(() => {
    const chosen = memberProjects.filter((project) => selected.has(project.id));
    if (chosen.length === 0) return [];
    return [...new Set(chosen[0]!.sources.map((source) => source.hostId))].filter((hostId) => chosen.every((project) => project.sources.some((source) => source.hostId === hostId)));
  }, [memberProjects, selected]);
  const [hostId, setHostId] = useState(eligibleHosts[0] ?? "");
  useEffect(() => { if (!selected.has(primary)) setPrimary([...selected][0] ?? ""); }, [selected, primary]);
  useEffect(() => { if (!eligibleHosts.includes(hostId)) setHostId(eligibleHosts[0] ?? ""); }, [eligibleHosts, hostId]);
  const start = async (event: FormEvent) => {
    event.preventDefault();
    if (!prompt.trim() || !primary || !eligibleHosts.includes(hostId) || pending) return;
    setPending(true); onError("");
    try {
      const session = await rpc.call("session_start", { workspaceId: workspace.id, expectedRevision: workspace.revision, hostId, primaryProjectId: primary, projectIds: [...selected], prompt: prompt.trim(), requestKey });
      if (session.threadId) { setRequestKey(`launch-${Date.now()}-${Math.random().toString(36).slice(2)}`); navigate.toThread(session.threadId); }
    } catch (cause) { onError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setPending(false); }
  };
  return <form onSubmit={start} className="space-y-3 rounded-lg border border-border p-4">
    <div><h3 className="text-sm font-semibold">Start a task</h3><p className="text-xs text-muted-foreground">Each selected repository gets its own isolated worktree.</p></div>
    <div className="flex flex-wrap gap-2">{memberProjects.map((project) => <label key={project.id} className="flex items-center gap-2 rounded-md border border-border px-2 py-1.5 text-sm"><Checkbox checked={selected.has(project.id)} onCheckedChange={(checked) => setSelected((current) => { const next = new Set(current); checked === true ? next.add(project.id) : next.delete(project.id); return next; })} aria-label={`Use ${project.name}`} />{project.name}</label>)}</div>
    {selected.size > 1 ? <label className="block text-sm">Primary repository<select className={`${fieldClass} mt-1`} value={primary} onChange={(event) => setPrimary(event.target.value)}>{memberProjects.filter((project) => selected.has(project.id)).map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label> : null}
    {eligibleHosts.length > 1 ? <label className="block text-sm">Host<select className={`${fieldClass} mt-1`} value={hostId} onChange={(event) => setHostId(event.target.value)}>{eligibleHosts.map((candidate) => <option key={candidate} value={candidate}>{candidate}</option>)}</select></label> : null}
    {eligibleHosts.length === 0 && selected.size > 0 ? <p className="text-sm text-destructive">The selected repositories do not share a configured host.</p> : null}
    <textarea aria-label="Task prompt" className={`${fieldClass} min-h-28 resize-y`} value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="Describe the outcome across these repositories…" />
    <Button type="submit" disabled={pending || !prompt.trim() || selected.size === 0 || !eligibleHosts.includes(hostId)}><Icon name="Play" className="size-4" />{pending ? "Preparing worktrees…" : "Start thread"}</Button>
  </form>;
}

function SessionRow({ session, rpc, onChanged, onError }: {
  session: SessionSnapshot;
  rpc: ReturnType<typeof useRpc<typeof rpcContract>>;
  onChanged: () => void;
  onError: (message: string) => void;
}) {
  const navigate = useBbNavigate();
  const [pending, setPending] = useState(false);
  const archive = async () => {
    setPending(true);
    try { await rpc.call("session_archive", { id: session.id }); onChanged(); }
    catch (cause) { onError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setPending(false); }
  };
  const cleanup = async () => {
    if (!globalThis.confirm("Remove this session's clean worktrees? Repository branches will be preserved.")) return;
    setPending(true);
    try { await rpc.call("session_cleanup", { id: session.id }); onChanged(); }
    catch (cause) { onError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setPending(false); }
  };
  return <div className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2">
    <div className="min-w-0"><span className="text-sm font-medium">{session.state}</span><span className="ml-2 text-xs text-muted-foreground">{session.repositories.map((repo) => repo.alias).join(", ")}</span>{session.error ? <p className="text-xs text-destructive">{session.error}</p> : null}</div>
    <div className="flex shrink-0 gap-2">
      {session.threadId ? <Button variant="outline" size="sm" onClick={() => navigate.toThread(session.threadId!)}>Open thread</Button> : null}
      {session.state === "active" || session.state === "failed" ? <Button variant="ghost" size="sm" disabled={pending} onClick={archive}>Archive</Button> : null}
      {session.state === "archived" ? <Button variant="ghost" size="sm" disabled={pending} onClick={cleanup}>{pending ? "Checking…" : "Remove worktrees"}</Button> : null}
    </div>
  </div>;
}

function WorkspacesPage() {
  const { rpc, dashboard, error, setError, load } = useDashboard();
  const [editing, setEditing] = useState<Workspace | "new" | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const active = dashboard?.workspaces.filter((workspace) => workspace.archivedAt === null) ?? [];
  const archived = dashboard?.workspaces.filter((workspace) => workspace.archivedAt !== null) ?? [];
  const selected = dashboard?.workspaces.find((workspace) => workspace.id === selectedId) ?? active[0];
  return <div className="h-full min-h-0 flex-1 overflow-y-auto"><div className="mx-auto w-full max-w-5xl space-y-4 px-4 pb-8 pt-4">
    <div className="flex items-start justify-between gap-3"><div><h1 className="text-xl font-semibold">Workspaces</h1><p className="text-sm text-muted-foreground">Group related repositories and run one isolated task across the ones you choose.</p></div><Button onClick={() => setEditing("new")}><Icon name="Plus" className="size-4" />New workspace</Button></div>
    {error ? <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p> : null}
    {editing ? <WorkspaceForm projects={dashboard?.projects ?? []} initial={editing === "new" ? undefined : editing} onCancel={() => setEditing(null)} onSave={async (draft) => { try { editing === "new" ? await rpc.call("workspace_create", draft) : await rpc.call("workspace_update", { id: editing.id, expectedRevision: editing.revision, draft }); setEditing(null); load(); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } }} /> : null}
    {dashboard === null ? <Empty>Loading workspaces…</Empty> : active.length === 0 && !editing ? <Empty>No active workspaces. Create one or restore an archived workspace below.</Empty> : <div className="grid gap-4 md:grid-cols-[minmax(220px,0.7fr)_minmax(0,1.6fr)]">
      <aside className="space-y-2">{active.map((workspace) => <button key={workspace.id} onClick={() => setSelectedId(workspace.id)} className={`w-full rounded-lg border p-3 text-left ${selected?.id === workspace.id ? "border-foreground bg-muted" : "border-border bg-card hover:bg-muted/60"}`}><span className="block font-medium">{workspace.name}</span><span className="mt-1 block text-xs text-muted-foreground">{workspace.repositories.length} repositories</span></button>)}</aside>
      {selected ? <main className="space-y-4"><div className="rounded-lg border border-border bg-card p-4"><div className="flex items-start justify-between gap-2"><div><h2 className="text-lg font-semibold">{selected.name}</h2><p className="text-sm text-muted-foreground">{selected.description || "No description"}</p></div><div className="flex gap-1"><Button variant="ghost" size="sm" onClick={() => setEditing(selected)}>Edit</Button><Button variant="ghost" size="sm" onClick={async () => { await rpc.call("workspace_set_pinned", { id: selected.id, expectedRevision: selected.revision, pinned: !selected.pinned }); load(); }}>{selected.pinned ? "Unpin" : "Pin"}</Button><Button variant="ghost" size="sm" onClick={async () => { await rpc.call("workspace_set_archived", { id: selected.id, expectedRevision: selected.revision, archived: true }); setSelectedId(null); load(); }}>Archive</Button></div></div><div className="mt-3 flex flex-wrap gap-2">{selected.repositories.map((repository) => <span key={repository.projectId} className="rounded-full bg-muted px-2.5 py-1 text-xs">{repository.alias}</span>)}</div></div>
        <SessionLauncher workspace={selected} projects={dashboard.projects} rpc={rpc} onError={(message) => setError(message || null)} />
        <section><h3 className="mb-2 text-sm font-semibold">Sessions</h3>{dashboard.sessions.filter((session) => session.workspaceId === selected.id).length === 0 ? <Empty>No workspace sessions yet.</Empty> : <div className="space-y-2">{dashboard.sessions.filter((session) => session.workspaceId === selected.id).map((session) => <SessionRow key={session.id} session={session} rpc={rpc} onChanged={load} onError={(message) => setError(message)} />)}</div>}</section>
      </main> : null}
    </div>}
    {archived.length > 0 ? <section className="space-y-2"><h2 className="text-sm font-semibold">Archived workspaces</h2>{archived.map((workspace) => <div key={workspace.id} className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2"><div><p className="text-sm font-medium">{workspace.name}</p><p className="text-xs text-muted-foreground">{workspace.repositories.length} repositories</p></div><div className="flex gap-2"><Button variant="outline" size="sm" onClick={async () => { try { await rpc.call("workspace_set_archived", { id: workspace.id, expectedRevision: workspace.revision, archived: false }); load(); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } }}>Restore</Button><Button variant="ghost" size="sm" onClick={async () => { if (!globalThis.confirm(`Delete workspace “${workspace.name}”? Its session history will remain.`)) return; try { await rpc.call("workspace_remove", { id: workspace.id, expectedRevision: workspace.revision }); load(); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } }}>Delete</Button></div></div>)}</section> : null}
  </div></div>;
}

function RepositoriesPanel({ threadId }: { threadId: string }) {
  const { rpc, dashboard, error } = useDashboard();
  const session = dashboard?.sessions.find((candidate) => candidate.threadId === threadId);
  const [statuses, setStatuses] = useState<Record<string, { loading?: boolean; error?: string; clean?: boolean; aheadOfBase?: boolean; changedFiles?: Array<{ path: string; status: string }> }>>({});
  const refresh = async (projectId: string) => {
    setStatuses((current) => ({ ...current, [projectId]: { loading: true } }));
    try { const status = await rpc.call("session_repository_status", { sessionId: session!.id, projectId }); setStatuses((current) => ({ ...current, [projectId]: status })); }
    catch (cause) { setStatuses((current) => ({ ...current, [projectId]: { error: cause instanceof Error ? cause.message : String(cause) } })); }
  };
  if (error) return <p className="text-sm text-destructive">{error}</p>;
  if (!dashboard) return <p className="text-sm text-muted-foreground">Loading repositories…</p>;
  if (!session) return <Empty>This thread was not launched from a multi-repository workspace session.</Empty>;
  if (session.state === "cleaned") return <Empty>This session's worktrees were removed. Its repository branches are still available.</Empty>;
  return <div className="space-y-3">{session.repositories.map((repository) => { const status = statuses[repository.projectId]; return <section key={repository.projectId} className="rounded-lg border border-border p-3"><div className="flex items-center justify-between gap-2"><div><h3 className="font-medium">{repository.alias}</h3><p className="font-mono text-xs text-muted-foreground">{repository.branch ?? repository.worktreePath}</p></div><Button variant="outline" size="sm" onClick={() => refresh(repository.projectId)} disabled={status?.loading}>{status?.loading ? "Refreshing…" : "Refresh"}</Button></div>{status?.error ? <p className="mt-2 text-xs text-destructive">{status.error}</p> : status?.changedFiles ? <div className="mt-2"><p className="text-xs text-muted-foreground">{status.clean ? "Clean" : `${status.changedFiles.length} changed files${status.aheadOfBase ? ", commits ahead" : ""}`}</p><ul className="mt-1 space-y-1">{status.changedFiles.map((file) => <li key={`${file.status}:${file.path}`} className="flex gap-2 text-xs"><span className="w-16 text-muted-foreground">{file.status}</span><code className="min-w-0 break-all">{file.path}</code></li>)}</ul></div> : null}</section>; })}</div>;
}

export default definePluginApp((app) => {
  app.slots.navPanel({ id: "workspaces", title: "Workspaces", icon: "Layers", path: "workspaces", component: WorkspacesPage });
  app.slots.threadPanelAction({ id: "repositories", title: "Repositories", icon: "FolderGit", component: RepositoriesPanel });
});
