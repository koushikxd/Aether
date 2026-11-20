import { expect, test, type AetherApp } from "./app";

const SETTINGS = ".aether/settings.json";
// The folder tree labels each sidebar row with just its title
const FOLDERS_ON = JSON.stringify({ foldersEnabled: true });

const NOTES = {
  [SETTINGS]: FOLDERS_ON,
  "Alpha.md": "# Alpha\n\nAlpha body.\n",
  "Beta.md": "# Beta\n\nBeta body.\n",
  "Gamma.md": "# Gamma\n\nGamma body.\n",
};

function menu(app: AetherApp) {
  return app.page.locator("[data-command-menu]");
}

function menuRow(app: AetherApp, label: string) {
  return menu(app).getByRole("button").filter({ hasText: label });
}

function shortcutOf(app: AetherApp, label: string) {
  return menuRow(app, label).locator("kbd");
}

async function openMenu(app: AetherApp) {
  await app.page.keyboard.press("ControlOrMeta+k");
  await expect(menu(app).getByRole("textbox")).toBeFocused();
}

async function closeMenu(app: AetherApp) {
  await app.page.keyboard.press("Escape");
  await expect(menu(app)).toBeHidden();
}

/** Opens a note from the sidebar and waits for its body. */
async function openFromSidebar(app: AetherApp, name: string) {
  await app.row(name).click();
  await expect(app.editor).toContainText(`${name} body.`);
}

test("Cmd+Shift+O preselects the previous note, so Enter switches back to it", async ({
  app,
}) => {
  await app.seed(NOTES);
  await openFromSidebar(app, "Alpha");
  await openFromSidebar(app, "Beta");

  await app.page.keyboard.press("ControlOrMeta+Shift+o");
  await expect(
    menu(app).getByText("Recent Notes", { exact: true }),
  ).toBeVisible();
  await app.screenshot("recent-notes-previous-selected");
  await app.page.keyboard.press("Enter");
  await expect(menu(app)).toBeHidden();
  await expect(app.editor).toContainText("Alpha body.");

  // And back again
  await app.page.keyboard.press("ControlOrMeta+Shift+o");
  await expect(menu(app).getByRole("textbox")).toBeFocused();
  await app.page.keyboard.press("Enter");
  await expect(app.editor).toContainText("Beta body.");

  await openMenu(app);
  await expect(shortcutOf(app, "Recent Notes")).toHaveText(/O$/);
});

test("recent notes are listed newest first and survive a reload", async ({
  app,
}) => {
  await app.seed(NOTES);
  // An open order that differs from the sidebar's (seed) order
  await openFromSidebar(app, "Alpha");
  await openFromSidebar(app, "Gamma");
  await openFromSidebar(app, "Alpha");

  await app.reload();
  await openMenu(app);
  await menu(app).getByRole("textbox").fill("Recent Notes");
  await app.page.keyboard.press("Enter");
  // Notes never opened are not recent
  await expect(menu(app).getByRole("button")).toHaveText([/Alpha/, /Gamma/]);
  await app.screenshot("recent-notes-after-reload");
});

test("Cmd+[ and Cmd+] move back and forward through opened notes", async ({
  app,
}) => {
  await app.seed(NOTES);
  await openFromSidebar(app, "Alpha");

  // Nothing to go back or forward to yet
  await openMenu(app);
  await expect(menuRow(app, "Go Back")).toBeHidden();
  await expect(menuRow(app, "Go Forward")).toBeHidden();
  await closeMenu(app);

  await openFromSidebar(app, "Beta");
  await openFromSidebar(app, "Gamma");

  await app.page.keyboard.press("ControlOrMeta+BracketLeft");
  await expect(app.editor).toContainText("Beta body.");
  await app.page.keyboard.press("ControlOrMeta+BracketLeft");
  await expect(app.editor).toContainText("Alpha body.");
  await app.page.keyboard.press("ControlOrMeta+BracketRight");
  await expect(app.editor).toContainText("Beta body.");

  await openMenu(app);
  await expect(shortcutOf(app, "Go Back")).toHaveText(/\[$/);
  await expect(shortcutOf(app, "Go Forward")).toHaveText(/]$/);
  await app.screenshot("back-forward-commands");
  await menuRow(app, "Go Back").click();
  await expect(app.editor).toContainText("Alpha body.");

  // Opening a note from Alpha drops the forward entries (Beta, Gamma)
  await openFromSidebar(app, "Gamma");
  await app.page.keyboard.press("ControlOrMeta+BracketLeft");
  await expect(app.editor).toContainText("Alpha body.");
  await app.page.keyboard.press("ControlOrMeta+BracketRight");
  await expect(app.editor).toContainText("Gamma body.");
});

test("Cmd+Shift+N creates and opens a sub-page of the open note", async ({
  app,
}) => {
  await app.seed({
    [SETTINGS]: FOLDERS_ON,
    "Page.md": "# Page\n\nPage body.\n",
  });

  // No note open: no command, and the key does nothing
  await openMenu(app);
  await expect(menuRow(app, "New Sub-page")).toBeHidden();
  await closeMenu(app);
  await app.page.keyboard.press("ControlOrMeta+Shift+n");

  await openFromSidebar(app, "Page");
  await app.page.keyboard.press("ControlOrMeta+Shift+n");
  await expect.poll(() => app.file("Page/Untitled.md")).toBe("# Untitled\n\n");
  await expect(app.editor.locator("h1")).toHaveText("Untitled");
  await expect(app.row("Page")).toHaveAttribute("aria-expanded", "true");
  const notePaths = Object.keys(await app.files()).filter((p) =>
    p.endsWith(".md"),
  );
  notePaths.sort();
  expect(notePaths).toEqual(["Page.md", "Page/Untitled.md"]);
  await app.screenshot("new-sub-page-shortcut");

  await openMenu(app);
  await expect(shortcutOf(app, "New Sub-page")).toHaveText(/N$/);
});

test("Cmd+Alt+Up opens the parent page", async ({ app }) => {
  // Seeded files share a modified time, so the sidebar keeps this order:
  // Sibling sits between Page and Child
  await app.seed({
    [SETTINGS]: FOLDERS_ON,
    "Page.md": "# Page\n\nPage body.\n",
    "Page/Sibling.md": "# Sibling\n\nSibling body.\n",
    "Page/Child.md": "# Child\n\nChild body.\n",
  });

  await openFromSidebar(app, "Page");
  await openMenu(app);
  await expect(menuRow(app, "Go to Parent Page")).toBeHidden();
  await closeMenu(app);

  // From the sidebar, where plain arrows move between rows
  await openFromSidebar(app, "Child");
  await app.page.keyboard.press("ControlOrMeta+Alt+ArrowUp");
  await expect(app.editor).toContainText("Page body.");
  await app.screenshot("parent-page");

  // From the editor, and from the menu command
  await openFromSidebar(app, "Sibling");
  await app.editor.getByText("Sibling body.", { exact: true }).click();
  await app.page.keyboard.press("ControlOrMeta+Alt+ArrowUp");
  await expect(app.editor).toContainText("Page body.");

  await openFromSidebar(app, "Child");
  await openMenu(app);
  await expect(shortcutOf(app, "Go to Parent Page")).toHaveText(/↑$/);
  await menuRow(app, "Go to Parent Page").click();
  await expect(app.editor).toContainText("Page body.");
});
