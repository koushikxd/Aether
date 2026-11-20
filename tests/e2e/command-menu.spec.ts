import { expect, test, type AetherApp } from "./app";

const NOTES = {
  "Alpha.md": "# Alpha\n\nFirst line.\n\nThe quarterly Budget review.\n",
  "Beta.md": "# Beta\n\nSecond body.\n",
};

function menu(app: AetherApp) {
  return app.page.locator("[data-command-menu]");
}

function input(app: AetherApp) {
  return menu(app).getByRole("textbox");
}

function row(app: AetherApp, label: string) {
  return menu(app).getByRole("button").filter({ hasText: label });
}

async function openMenu(app: AetherApp) {
  await app.page.keyboard.press("ControlOrMeta+k");
  await expect(input(app)).toBeFocused();
}

/** Root filter, then Enter on the first row: opens the sub-view whose row is `label`. */
async function openSubView(app: AetherApp, label: string) {
  await input(app).fill(label);
  await app.page.keyboard.press("Enter");
  await expect(input(app)).toHaveValue("");
}

async function themeMode(app: AetherApp): Promise<unknown> {
  const raw = await app.file(".aether/settings.json");
  return raw ? JSON.parse(raw).theme?.mode : undefined;
}

test("Cmd+K opens the menu from the notes view and from Settings, Esc closes it", async ({
  app,
}) => {
  await app.seed(NOTES);
  // Root lists recently opened notes
  await app.open("Alpha");
  await expect(app.editor).toContainText("First line.");

  await openMenu(app);
  await expect(row(app, "Search Notes")).toContainText("F");
  await expect(row(app, "Theme...")).toBeVisible();
  await expect(row(app, "Settings")).toContainText(",");
  await expect(row(app, "Alpha")).toBeVisible();
  await expect(menu(app)).toContainText("Navigate");
  await expect(menu(app)).toContainText("Close");
  await app.screenshot("root");

  await app.page.keyboard.press("Escape");
  await expect(menu(app)).toBeHidden();

  await app.page.keyboard.press("ControlOrMeta+Comma");
  await expect(app.page.getByText("Folder Location")).toBeVisible();
  await openMenu(app);
  await app.page.keyboard.press("Escape");
  await expect(menu(app)).toBeHidden();
});

test("Esc and Backspace in an empty input go back from a sub-view to root", async ({
  app,
}) => {
  await app.seed(NOTES);
  await openMenu(app);

  await openSubView(app, "Theme...");
  await expect(menu(app).getByText("Theme", { exact: true })).toBeVisible();
  await expect(row(app, "Light")).toBeVisible();
  await expect(menu(app)).toContainText("Back");
  await app.screenshot("theme-sub-view");

  await app.page.keyboard.press("Escape");
  await expect(menu(app)).toBeVisible();
  await expect(row(app, "Search Notes")).toBeVisible();
  await expect(row(app, "Light")).toBeHidden();

  await openSubView(app, "Theme...");
  await app.page.keyboard.type("li");
  await app.page.keyboard.press("Backspace");
  await app.page.keyboard.press("Backspace");
  await expect(row(app, "Light")).toBeVisible();
  await app.page.keyboard.press("Backspace");
  await expect(row(app, "Search Notes")).toBeVisible();
  await expect(row(app, "Light")).toBeHidden();
});

test("Cmd+1 runs the first visible row of a sub-view, before and after filtering", async ({
  app,
}) => {
  await app.page.emulateMedia({ colorScheme: "dark" });
  await app.seed(NOTES);
  const html = app.page.locator("html");

  // In Settings, where Cmd+1 also switches tabs: the menu must take the key
  await app.page.keyboard.press("ControlOrMeta+Comma");
  await app.page.keyboard.press("ControlOrMeta+4");
  await expect(app.page.getByText("Folder Location")).toBeHidden();

  await openMenu(app);
  await openSubView(app, "Theme...");
  await expect(row(app, "Light")).toContainText("1");
  await app.page.keyboard.press("ControlOrMeta+1");
  await expect(menu(app)).toBeHidden();
  await expect.poll(() => themeMode(app)).toBe("light");
  await expect(html).not.toHaveClass(/dark/);
  await expect(app.page.getByText("Folder Location")).toBeHidden();

  await openMenu(app);
  await openSubView(app, "Theme...");
  await app.page.keyboard.type("dar");
  await expect(row(app, "Light")).toBeHidden();
  await expect(row(app, "Dark")).toContainText("1");
  await app.screenshot("theme-filtered");
  await app.page.keyboard.press("ControlOrMeta+1");
  await expect(menu(app)).toBeHidden();
  await expect.poll(() => themeMode(app)).toBe("dark");
  await expect(html).toHaveClass(/dark/);
});

test("note commands show only while a note is open", async ({ app }) => {
  await app.seed(NOTES);
  const noteCommands = [
    "Copy / Export...",
    "Pin Current Note",
    "Duplicate Current Note",
    "Delete Current Note",
  ];

  await openMenu(app);
  await expect(row(app, "New Note")).toBeVisible();
  for (const label of noteCommands) {
    await expect(row(app, label)).toBeHidden();
  }
  await app.page.keyboard.press("Escape");

  await app.open("Alpha");
  await expect(app.editor).toContainText("First line.");
  await openMenu(app);
  for (const label of noteCommands) {
    await expect(row(app, label)).toBeVisible();
  }

  await openSubView(app, "Copy / Export...");
  for (const label of [
    "Copy Markdown",
    "Copy Plain Text",
    "Copy HTML",
    "Print as PDF",
    "Export Markdown",
  ]) {
    await expect(row(app, label)).toBeVisible();
  }
  await app.screenshot("copy-export-sub-view");
});

test("Search Notes finds a body word, highlights it, and Cmd+1 opens the note", async ({
  app,
}) => {
  await app.seed(NOTES);
  // Before typing, Search Notes lists recently opened notes
  await app.open("Alpha");
  await expect(app.editor).toContainText("First line.");
  await app.open("Beta");
  await expect(app.editor).toContainText("Second body.");
  await openMenu(app);
  await openSubView(app, "Search Notes");
  await expect(row(app, "Alpha")).toBeVisible();
  await expect(row(app, "Beta")).toBeVisible();

  await app.page.keyboard.type("budget");
  await expect(row(app, "Beta")).toBeHidden();
  const hit = row(app, "Alpha");
  await expect(hit).toContainText("The quarterly Budget review.");
  await expect(hit.locator("mark")).toHaveText("Budget");
  await app.screenshot("search-results");

  await app.page.keyboard.press("ControlOrMeta+1");
  await expect(menu(app)).toBeHidden();
  await expect(app.editor).toContainText("The quarterly Budget review.");
});

test("Down then Enter on an empty result list does nothing", async ({
  app,
}) => {
  const errors: Error[] = [];
  app.page.on("pageerror", (err) => errors.push(err));
  await app.seed(NOTES);
  await openMenu(app);
  await openSubView(app, "Search Notes");
  await app.page.keyboard.type("zzzz");
  await expect(menu(app)).toContainText("No results found");

  await app.page.keyboard.press("ArrowDown");
  await app.page.keyboard.press("Enter");
  await expect(menu(app)).toBeVisible();
  await app.screenshot("no-results");
  expect(errors).toEqual([]);
});

test("opening a note from the menu in Settings leaves Settings", async ({
  app,
}) => {
  const settings = app.page.getByText("Folder Location");
  async function runFromSettings(filter: string) {
    await app.page.keyboard.press("ControlOrMeta+Comma");
    await expect(settings).toBeVisible();
    await openMenu(app);
    await input(app).fill(filter);
    await app.page.keyboard.press("Enter");
    await expect(menu(app)).toBeHidden();
    await expect(settings).toBeHidden();
  }
  await app.seed(NOTES);

  await runFromSettings("Beta");
  await expect(app.editor).toContainText("Second body.");
  await app.screenshot("note-from-settings");

  // The note that is already open
  await runFromSettings("Beta");
  await expect(app.editor).toContainText("Second body.");

  await runFromSettings("New Note");
  await expect(app.editor).not.toContainText("Second body.");
});
