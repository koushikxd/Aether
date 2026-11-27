import { expect, test } from "./app";

const NOTES = {
  "Welcome.md": "# Welcome\n\nHello",
  "Ideas.md": "# Ideas\n",
  "Work.md": "# Work\n",
  "Work/Plan.md": "# Plan\n",
};

test("sidebar has no title or count, only new note and search in the title bar", async ({
  app,
}) => {
  await app.seed(NOTES);
  await expect(app.sidebar.getByText("Notes", { exact: true })).toHaveCount(0);
  await expect(app.sidebar.getByText("4", { exact: true })).toHaveCount(0);

  const newNote = app.sidebar.getByRole("button", { name: /^New Note/ });
  const search = app.sidebar.getByRole("button", { name: /^Search/ });
  // Both sit in the title bar row, above the first page
  const firstRow = await app.row("Welcome").boundingBox();
  for (const button of [newNote, search]) {
    const box = await button.boundingBox();
    expect(box!.y + box!.height).toBeLessThanOrEqual(firstRow!.y);
  }
  await app.screenshot("sidebar");

  await search.click();
  await expect(
    app.page.locator("[data-command-menu]").getByRole("textbox"),
  ).toHaveAttribute("placeholder", "Search note contents...");
});

test("home lists recent pages and opens one on click", async ({ app }) => {
  await app.seed(NOTES);
  const home = app.page.locator("[data-home]");
  await expect(home.getByRole("button", { name: /^New note/ })).toBeVisible();
  await expect(home.getByRole("button", { name: /^Search/ })).toBeVisible();
  const recent = home.getByRole("list", { name: "Recent pages" });
  await expect(recent.getByRole("listitem")).toHaveCount(4);
  await app.screenshot("home-light");
  await app.page.emulateMedia({ colorScheme: "dark" });
  // Colors transition on a theme change
  await expect
    .poll(() => app.page.evaluate(() => document.getAnimations().length))
    .toBe(0);
  await app.screenshot("home-dark");

  await recent.getByRole("button", { name: /^Plan/ }).click();
  await expect(home).toHaveCount(0);
  await expect(app.page.getByRole("heading", { name: "Plan" })).toBeVisible();
});

test("home new note button creates a page", async ({ app }) => {
  await app.seed(NOTES);
  await app.page
    .locator("[data-home]")
    .getByRole("button", { name: /^New note/ })
    .click();
  await expect
    .poll(async () => (await app.calls("create_note")).length)
    .toBe(1);
});
