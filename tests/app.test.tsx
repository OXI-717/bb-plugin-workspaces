// @vitest-environment jsdom
import { fireEvent } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";

const project = {
  id: "proj_auth",
  name: "identity-service",
  gitRemoteUrl: "https://example.invalid/identity.git",
  sources: [{ id: "src_auth", hostId: "host_local", path: "/repos/identity", isDefault: true }],
};

describe("Workspaces page", () => {
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
});
