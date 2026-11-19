import { expect, test, type AetherApp } from "./app";

// Image insert through the slash menu is covered in images.spec.ts.

async function openNote(app: AetherApp) {
  await app.seed({ "Note.md": "# Note\n\nBody\n" });
  await app.open("Note");
  await expect(app.editor).toContainText("Body");
}

async function slash(app: AetherApp, query: string) {
  await app.editor.getByText("Body").click();
  await app.page.keyboard.press("End");
  await app.page.keyboard.press("Enter");
  await app.page.keyboard.type(`/${query}`);
  await app.page.keyboard.press("Enter");
}

test("the editor has no format bar above the note", async ({ app }) => {
  await openNote(app);
  await expect(app.page.locator("[data-format-bar]")).toHaveCount(0);
  for (const name of [/^Bold/, /^Heading 1/, /^Insert Table/, /^Add Image/]) {
    await expect(app.page.getByRole("button", { name })).toHaveCount(0);
  }
  await app.screenshot("no-format-bar");
});

test("the slash menu inserts a table", async ({ app }) => {
  await openNote(app);
  await slash(app, "table");
  await expect(app.editor.locator("table tr")).toHaveCount(3);
  await app.page.keyboard.type("A");
  await app.page.keyboard.press("Tab");
  await app.page.keyboard.type("B");

  await expect
    .poll(() => app.savedMarkdown("Note"))
    .toContain(
      "| A   | B   |     |\n| --- | --- | --- |\n|     |     |     |\n|     |     |     |",
    );
  await app.screenshot("slash-table");
});

test("the slash menu inserts block math", async ({ app }) => {
  await openNote(app);
  await slash(app, "math");
  await app.page.getByPlaceholder("Enter KaTeX expression...").fill("x^2");
  await app.page.keyboard.press("ControlOrMeta+Enter");

  await expect(app.editor.locator(".katex")).toBeVisible();
  await expect
    .poll(() => app.savedMarkdown("Note"))
    .toMatch(/^# Note\n\nBody\n\n\$\$\nx\^2\n\$\$\n*$/);
  await app.screenshot("slash-block-math");
});
