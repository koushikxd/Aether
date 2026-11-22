import type { Locator } from "@playwright/test";
import { expect, test, type AetherApp } from "./app";

const PLAN = "# Plan\n\nHello from the fake backend.\n";

async function openInfo(app: AetherApp) {
  await app.page.getByRole("button", { name: "Note info" }).click();
  return app.page.getByRole("menu");
}

function field(panel: Locator, label: string) {
  return panel.locator(`dt:text-is("${label}") + dd`);
}

test("info panel shows modified, created, counts, and the relative path", async ({
  app,
}) => {
  await app.seed({ "Projects/Plan.md": PLAN });
  await app.open("Projects/Plan");
  await expect(app.editor).toContainText("Hello from the fake backend.");

  const panel = await openInfo(app);
  await expect(field(panel, "Last modified")).toContainText("20");
  // The fake reports 2026-03-15 12:00 UTC.
  await expect(field(panel, "Created")).toContainText("Mar");
  await expect(field(panel, "Created")).toContainText("2026");
  // "Plan" + "Hello from the fake backend."
  await expect(field(panel, "Words")).toHaveText("6");
  await expect(field(panel, "Characters")).toHaveText("32");
  const path = panel.getByRole("menuitem", { name: "Projects/Plan.md" });
  await expect(path).toBeVisible();
  await app.screenshot("note-info-panel");

  await path.click();
  await expect(app.page.getByText("Copied file path")).toBeVisible();
  const copies = await app.calls("copy_to_clipboard");
  expect(copies[copies.length - 1]?.args).toEqual({ text: "Projects/Plan.md" });
  await expect(panel).toBeHidden();
});

test("word and character counts follow edits", async ({ app }) => {
  await app.seed({ "Projects/Plan.md": PLAN });
  await app.open("Projects/Plan");
  await app.editor.getByText("Hello from the fake backend.").click();
  await app.page.keyboard.press("End");
  await app.page.keyboard.type(" Two more");

  const panel = await openInfo(app);
  await expect(field(panel, "Words")).toHaveText("8");
  await expect(field(panel, "Characters")).toHaveText("41");
  await app.screenshot("note-info-counts-after-typing");
});

test("created row is hidden when the platform has no birth time", async ({
  app,
}) => {
  await app.seed({ "Projects/Plan.md": PLAN });
  await app.page.evaluate(() => {
    if (window.aetherFake) window.aetherFake.noteCreated = null;
  });
  await app.open("Projects/Plan");
  await expect(app.editor).toContainText("Hello from the fake backend.");

  const panel = await openInfo(app);
  await expect(field(panel, "Last modified")).toContainText("20");
  await expect(field(panel, "Words")).toHaveText("6");
  expect(await app.calls("get_note_info")).toHaveLength(1);
  await expect(panel.locator("dt")).toHaveText([
    "Last modified",
    "Words",
    "Characters",
  ]);
  await app.screenshot("note-info-no-created");
});
