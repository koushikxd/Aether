import { expect, test, type AetherApp } from "./app";

const NOTES = {
  "Alpha.md": "# Alpha\n\nFirst line.\n",
  "Beta.md": "# Beta\n\nThe quarterly Budget review.\n",
};

function menu(app: AetherApp) {
  return app.page.locator("[data-command-menu]");
}

function searchInput(app: AetherApp) {
  return menu(app).getByPlaceholder("Search note contents...");
}

function linkEditor(app: AetherApp) {
  return app.page.getByPlaceholder("Enter URL...");
}

/** Opens Alpha and puts the cursor in its body. */
async function focusEditor(app: AetherApp) {
  await app.open("Alpha");
  await app.editor.getByText("First line.", { exact: true }).click();
  await expect(app.editor).toBeFocused();
}

test("Cmd+Shift+F opens Search Notes, and Enter on a body match opens the note", async ({
  app,
}) => {
  await app.seed(NOTES);
  await expect(app.sidebar.getByLabel(/^Search Notes/)).toHaveCount(0);

  await app.page.keyboard.press("ControlOrMeta+Shift+f");
  await expect(searchInput(app)).toBeFocused();

  // From the menu's root, Cmd+Shift+F also lands in Search Notes
  await app.page.keyboard.press("Escape");
  await expect(menu(app).getByPlaceholder(/type a command/)).toBeVisible();
  await app.page.keyboard.press("ControlOrMeta+Shift+f");
  await expect(searchInput(app)).toBeFocused();

  await app.page.keyboard.type("budget");
  const rows = menu(app).getByRole("button");
  await expect(rows.filter({ hasText: "Alpha" })).toBeHidden();
  await expect(rows.filter({ hasText: "Beta" })).toContainText("Budget");
  await app.screenshot("search-notes");

  await app.page.keyboard.press("Enter");
  await expect(menu(app)).toBeHidden();
  await expect(app.editor).toContainText("The quarterly Budget review.");
});

test("Cmd+Shift+L in the editor opens the link editor", async ({ app }) => {
  await app.seed(NOTES);
  await focusEditor(app);

  await app.page.keyboard.press("ControlOrMeta+Shift+l");
  await expect(linkEditor(app)).toBeVisible();
  await expect(menu(app)).toBeHidden();
  await app.screenshot("link-editor");
});

test("Cmd+K in the editor opens the command menu, not the link editor", async ({
  app,
}) => {
  await app.seed(NOTES);
  await focusEditor(app);

  await app.page.keyboard.press("ControlOrMeta+k");
  await expect(menu(app).getByRole("textbox")).toBeFocused();
  await expect(linkEditor(app)).toHaveCount(0);
  await app.screenshot("command-menu-from-editor");
});
