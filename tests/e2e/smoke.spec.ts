import { expect, test } from "./app";

test("boots, opens a note, and saves edits as markdown", async ({ app }) => {
  await app.seed({
    "Welcome.md": "# Welcome\n\nHello from the fake backend.\n",
    "Projects/Roadmap/Plan.md": "# Plan\n\nShip it.\n",
    "assets/logo.png": "fake-png-bytes",
  });

  await expect(app.sidebar.getByText("Welcome")).toBeVisible();
  await app.sidebar.getByText("Welcome").click();
  await expect(app.editor).toContainText("Hello from the fake backend.");

  await app.editor.getByText("Hello from the fake backend.").click();
  await app.page.keyboard.press("End");
  await app.page.keyboard.type(" Edited in a test.");

  await expect
    .poll(() => app.savedMarkdown("Welcome"))
    .toBe("# Welcome\n\nHello from the fake backend. Edited in a test.");
  expect(await app.file("Welcome.md")).toBe(await app.savedMarkdown("Welcome"));

  await app.reload();
  await app.sidebar.getByText("Welcome").click();
  await expect(app.editor).toContainText("Edited in a test.");

  await app.open("Projects/Roadmap/Plan");
  await expect(app.editor).toContainText("Ship it.");
  await app.screenshot("nested-note-open");
});
