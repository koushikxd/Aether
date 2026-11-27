import { expect, test, type AetherApp } from "./app";

function title(app: AetherApp) {
  return app.editor.locator("> h1").first();
}

/** The "Untitled" placeholder the empty title draws in CSS. */
async function placeholder(app: AetherApp) {
  return title(app).evaluate((h1) =>
    getComputedStyle(h1, "::before").content.replace(/"/g, ""),
  );
}

test("a new page starts with an empty title showing Untitled", async ({
  app,
}) => {
  await app.seed({ "Welcome.md": "# Welcome\n" });
  await app.page.keyboard.press("ControlOrMeta+n");
  await expect.poll(() => app.file("Untitled.md")).toBe("");

  await expect(title(app)).toHaveText("");
  expect(await placeholder(app)).toBe("Untitled");
  await app.screenshot("new-page");

  // The cursor is in the title: typing names the page
  await app.page.keyboard.type("Groceries");
  await app.page.keyboard.press("Enter");
  await app.page.keyboard.type("Milk");
  await expect
    .poll(() => app.savedMarkdown("Untitled"))
    .toBe("# Groceries\n\nMilk\n\n");
});

test("Backspace in the title keeps it a title", async ({ app }) => {
  await app.seed({ "Welcome.md": "# Welcome\n" });
  await app.page.keyboard.press("ControlOrMeta+n");
  await expect.poll(() => app.file("Untitled.md")).toBe("");
  await app.page.keyboard.type("ab");
  await expect(title(app)).toHaveText("ab");
  // At the start of a named title, Backspace does nothing
  for (let i = 0; i < 2; i++) await app.page.keyboard.press("ArrowLeft");
  await app.page.keyboard.press("Backspace");
  await expect(app.editor.locator("> :first-child")).toHaveText("ab");
  await expect(title(app)).toHaveText("ab");

  for (let i = 0; i < 2; i++) await app.page.keyboard.press("ArrowRight");
  for (let i = 0; i < 4; i++) await app.page.keyboard.press("Backspace");

  await expect(app.editor.locator("> :first-child")).toHaveJSProperty(
    "tagName",
    "H1",
  );
  await expect(title(app)).toHaveText("");
  expect(await placeholder(app)).toBe("Untitled");
});

test("deleting everything leaves an empty title", async ({ app }) => {
  await app.seed({ "Note.md": "# Note\n\nBody.\n" });
  await app.row("Note").click();
  await app.editor.click();
  await app.page.keyboard.press("ControlOrMeta+a");
  await app.page.keyboard.press("Backspace");

  await expect(app.editor.locator("> :first-child")).toHaveJSProperty(
    "tagName",
    "H1",
  );
  await expect(title(app)).toHaveText("");
  expect(await placeholder(app)).toBe("Untitled");
  await expect.poll(() => app.savedMarkdown("Note")).toBe("");
});

test("a page without a heading shows an empty title and saves without one", async ({
  app,
}) => {
  await app.seed({ "Plain.md": "Just a line.\n" });
  await app.open("Plain");
  await expect(title(app)).toHaveText("");
  await expect(app.editor.locator("> p")).toHaveText("Just a line.");
  expect(await app.calls("save_note")).toHaveLength(0);
  await app.screenshot("headingless-page");

  await app.editor.locator("> p").click();
  await app.page.keyboard.press("End");
  await app.page.keyboard.type(" More.");
  await expect
    .poll(() => app.savedMarkdown("Plain"))
    .toBe("Just a line. More.");
});
