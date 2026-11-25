import type { Page } from "@playwright/test";
import { expect, test, type AetherApp } from "./app";
import type { FakeIntegrationsSeed } from "./fake-integrations";

async function openIntegrations(app: AetherApp, seed: FakeIntegrationsSeed) {
  await app.page.addInitScript((state) => {
    window.aetherFakeIntegrations = state;
  }, seed);
  await app.seed({ "Plan.md": "# Plan\n" });
  await app.page.getByRole("button", { name: /^Settings/ }).click();
  await app.page.getByRole("button", { name: /^Integrations/ }).click();
}

function section(page: Page, heading: string) {
  return page.locator("section").filter({
    has: page.getByRole("heading", { name: heading, exact: true }),
  });
}

test("Install CLI Tool and Install Agent Skill install both, then show them installed", async ({
  app,
}) => {
  await openIntegrations(app, {});
  const cli = section(app.page, "CLI Tool");
  const skill = section(app.page, "Agent Skill");
  await expect(skill).toContainText("Not installed");
  await app.screenshot("integrations-not-installed");

  await cli.getByRole("button", { name: "Install CLI Tool" }).click();
  await expect(
    cli.getByRole("button", { name: "Uninstall CLI Tool" }),
  ).toBeVisible();
  await expect(cli).toContainText("/opt/homebrew/bin/aether");

  await skill.getByRole("button", { name: "Install Agent Skill" }).click();
  await expect(skill).toContainText("Installed");
  await expect(skill.getByRole("button")).toHaveCount(0);

  expect((await app.calls()).map((c) => c.cmd)).toEqual(
    expect.arrayContaining(["install_cli", "install_skill"]),
  );
  await app.screenshot("integrations-installed");
});

test("an installed CLI and skill show as installed on open", async ({
  app,
}) => {
  await openIntegrations(app, { cli: true, skill: "installed" });
  const cli = section(app.page, "CLI Tool");
  const skill = section(app.page, "Agent Skill");
  await expect(
    cli.getByRole("button", { name: "Uninstall CLI Tool" }),
  ).toBeVisible();
  await expect(skill).toContainText("Installed");
  await expect(skill.getByRole("button")).toHaveCount(0);
});

test("a skill that differs from this version offers Update Agent Skill", async ({
  app,
}) => {
  await openIntegrations(app, { skill: "update_available" });
  const skill = section(app.page, "Agent Skill");
  await expect(skill).toContainText("Update available");
  await app.screenshot("integrations-skill-update-available");

  await skill.getByRole("button", { name: "Update Agent Skill" }).click();
  await expect(skill).toContainText("Installed");
  expect(await app.calls("install_skill")).toHaveLength(1);
});
