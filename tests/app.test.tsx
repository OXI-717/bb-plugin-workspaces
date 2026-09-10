// @vitest-environment jsdom
import { fireEvent } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";

const project = {
  id: "proj_auth",
  name: "identity-service",
  gitRemoteUrl: "https://example.invalid/identity.git",
  sources: [{ id: "src_auth", hostId: "host_local", path: "/repos/identity", isDefault: true }],
};

const gatewayProject = {
  id: "proj_gateway",
  name: "api-gateway",
  gitRemoteUrl: "https://example.invalid/gateway.git",
  sources: [{ id: "src_gateway", hostId: "host_local", path: "/repos/gateway", isDefault: true }],
};

const workspace = {
  id: "ws_auth",
  name: "Authentication",
  description: "",
  instructions: "",
  revision: 1,
  pinned: false,
  archivedAt: null,
  createdAt: 1,
  updatedAt: 1,
  repositories: [
    { projectId: "proj_auth", alias: "identity", ordinal: 0 },
    { projectId: "proj_gateway", alias: "gateway", ordinal: 1 },
  ],
};

describe("Workspaces page", () => {
  beforeEach(() => globalThis.localStorage.clear());

  it("creates a workspace from selected BB projects", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const calls: unknown[] = [];
    const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, {
      rpc: {
        dashboard: () => ({ workspaces: [], sessions: [], projects: [project] }),
        workspace_create: (input: unknown) => {
          calls.push(input);
          return { id: "ws_auth", revision: 1 };
        },
      },
    });

    fireEvent.click(await slot.findByRole("button", { name: /new workspace/i }));
    expect(await slot.findByRole("dialog", { name: /create workspace/i })).toBeTruthy();
    fireEvent.change(slot.getByLabelText("Workspace name"), { target: { value: "Authentication" } });
    fireEvent.click(slot.getByRole("checkbox", { name: /identity-service/i }));
    fireEvent.click(slot.getByRole("button", { name: /create workspace/i }));

    await expect.poll(() => calls.length).toBe(1);
    expect(calls[0]).toEqual({
      name: "Authentication",
      description: "",
      instructions: "",
      repositories: [{ projectId: "proj_auth", alias: "identity-service" }],
    });
    slot.lifecycle.unmount();
  });

  it("selects every workspace repository initially and remembers a changed subset", async () => {
    const app = await loadPluginApp(() => import("../app"));
    const rpc = {
      dashboard: () => ({ workspaces: [workspace], sessions: [], projects: [project, gatewayProject] }),
    };
    const first = renderSlot(app.navPanels[0]!, { subPath: "" }, { rpc });

    const identity = await first.findByRole("checkbox", { name: "Use identity-service" });
    const gateway = first.getByRole("checkbox", { name: "Use api-gateway" });
    expect(identity.getAttribute("data-state")).toBe("checked");
    expect(gateway.getAttribute("data-state")).toBe("checked");
    expect(first.queryByText("Primary repository")).toBeNull();
    fireEvent.click(gateway);
    expect(gateway.getAttribute("data-state")).toBe("unchecked");
    first.lifecycle.unmount();

    const reopened = renderSlot(app.navPanels[0]!, { subPath: "" }, { rpc });
    expect((await reopened.findByRole("checkbox", { name: "Use identity-service" })).getAttribute("data-state")).toBe("checked");
    expect(reopened.getByRole("checkbox", { name: "Use api-gateway" }).getAttribute("data-state")).toBe("unchecked");
    reopened.lifecycle.unmount();
  });
});
