import { expect, test } from "./app";

// `Work/` has no `Work.md`, as a git clone or Finder can leave it.
test("a folder without its page file shows as a page that gets its file on the first edit", async ({
  app,
}) => {
  await app.seed({
    "Work/a.md": "# a\n\nInside work.",
  });

  await expect(app.row("Work")).toBeVisible();
  if (!(await app.row("a").isVisible())) {
    await app.row("Work").locator("[data-sub-pages-toggle]").click();
  }
  await expect(app.row("a")).toBeVisible();

  await app.open("Work");
  await expect(app.editor.locator("h1")).toHaveText("Work");
  await expect.poll(() => app.calls("read_note")).not.toHaveLength(0);
  await app.screenshot("bare-page-open");
  // Past the 500ms auto-save debounce, so a save on open would have happened
  await app.page.waitForTimeout(800);
  expect(await app.calls("save_note")).toEqual([]);
  expect(await app.file("Work.md")).toBeUndefined();

  await app.editor.locator("h1").click();
  await app.page.keyboard.press("End");
  await app.page.keyboard.press("Enter");
  await app.page.keyboard.type("Plans");
  await expect.poll(() => app.file("Work.md")).toMatch(/^# Work\n\nPlans\s*$/);
  expect(await app.file("Work/a.md")).toBe("# a\n\nInside work.");
  await app.screenshot("bare-page-saved");
});
