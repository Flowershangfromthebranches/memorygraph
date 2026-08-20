// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import axe from "axe-core";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("sigma", () => ({
  default: class SigmaMock {
    on() {}
    kill() {}
    getNodeDisplayData() { return null; }
    getCamera() { return { animate: async () => {}, getState: () => ({ ratio: 1 }) }; }
  },
}));

vi.mock("../web/src/api", () => {
  const project = { projectId: "project-a11y", workspaceId: "workspace_default", name: "Accessible Project", slug: "accessible-project", primaryRoot: "/tmp/accessible-project", createdAt: "2026-08-20T00:00:00.000Z" };
  const graph = { nodes: [{ id: "project:project-a11y", projectId: project.projectId, type: "Project", label: project.name, status: "active", summary: "Accessible graph", attributes: {}, validFrom: project.createdAt, validTo: null, sourceEventId: null }], edges: [], totalNodes: 1, totalEdges: 0, truncated: false };
  return {
    api: {
      sync: async () => ({ projects: [] }),
      projects: async () => ({ projects: [project] }),
      graph: async () => graph,
      state: async () => ({ project, state: [], activeWork: [], facts: [], decisions: [] }),
      events: async () => ({ project, events: [] }),
      handoffs: async () => ({ project, handoffs: [] }),
      evidence: async () => ({ evidence: [] }),
      neighborhood: async () => graph,
      resume: async () => ({}),
      search: async () => ({ hits: [] }),
    },
  };
});

import App from "../web/src/App";

afterEach(() => cleanup());

describe("visual console accessibility", () => {
  it("has no serious or critical axe violations in the loaded Atlas shell", async () => {
    document.documentElement.lang = "en";
    render(<App />);
    await screen.findByRole("heading", { name: "My Workspace" });
    expect((await screen.findAllByRole("button", { name: /Accessible Project/u })).length).toBeGreaterThanOrEqual(2);
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    expect(screen.getByRole("dialog", { name: "Search project memory" })).toBeTruthy();
    const results = await axe.run(document.body, { rules: { "color-contrast": { enabled: false } } });
    const material = results.violations.filter((violation) => violation.impact === "serious" || violation.impact === "critical");
    expect(material, material.map((violation) => `${violation.id}: ${violation.help}`).join("\n")).toEqual([]);
  });
});
