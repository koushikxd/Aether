import { expect, test, type AetherApp } from "./app";

const SETTINGS = ".aether/settings.json";

type MovePickerWindow = Window & { movePicks?: unknown[] };

function tree(app: AetherApp) {
  return app.sidebar.locator("[data-page-tree]");
}

function pinned(app: AetherApp) {
  return app.sidebar.getByRole("region", { name: "Pinned" });
}

function toggle(app: AetherApp, name: string) {
  return app.row(name).locator("[data-sub-pages-toggle]");
}

function menuItem(app: AetherApp, name: string) {
  return app.page.getByRole("menuitem", { name, exact: true });
}

async function left(app: AetherApp, name: string): Promise<number> {
  const box = await app
    .row(name)
    .getByText(name, { exact: true })
    .boundingBox();
  if (!box) throw new Error(`${name} is not visible`);
  return box.x;
}

/** Edits the page at `id` (titled after its last part) so it becomes the newest. */
async function touch(app: AetherApp, id: string) {
  const name = id.split("/").pop() ?? id;
  await app.row(name).click();
  await app.editor.getByText(`${name} body.`).click();
  await app.page.keyboard.press("End");
  await app.page.keyboard.type("!");
  await expect
    .poll(() => app.file(`${id}.md`))
    .toBe(`# ${name}\n\n${name} body.!`);
}

/** Records every `open-move-picker` event the sidebar dispatches. */
async function recordMovePicks(app: AetherApp) {
  await app.page.evaluate(() => {
    const win: MovePickerWindow = window;
    win.movePicks = [];
    window.addEventListener("open-move-picker", (event) => {
      if (event instanceof CustomEvent) win.movePicks?.push(event.detail);
    });
  });
}

function movePicks(app: AetherApp): Promise<unknown[]> {
  return app.page.evaluate(() => {
    const win: MovePickerWindow = window;
    return win.movePicks ?? [];
  });
}

test("pages nest under their parent, newest first at every level, and collapse", async ({
  app,
}) => {
  await app.seed({
    [SETTINGS]: JSON.stringify({ pinnedNoteIds: ["Gamma"] }),
    "Alpha.md": "# Alpha\n\nAlpha body.\n",
    "Beta.md": "# Beta\n\nBeta body.\n",
    "Gamma.md": "# Gamma\n\nGamma body.\n",
    "Beta/One.md": "# One\n\nOne body.\n",
    "Beta/Two.md": "# Two\n\nTwo body.\n",
    "Beta/Two/Deep.md": "# Deep\n\nDeep body.\n",
  });

  await expect(app.row("Beta")).toHaveAttribute("aria-expanded", "true");
  await expect(app.row("Two")).toHaveAttribute("aria-expanded", "true");
  expect(await left(app, "One")).toBeGreaterThan(await left(app, "Beta"));
  expect(await left(app, "Deep")).toBeGreaterThan(await left(app, "Two"));
  await expect(app.row("Alpha")).not.toHaveAttribute("aria-expanded");

  // Each edit makes a page the newest. The fake gives unedited files the
  // latest time, so every page is edited to make the order unambiguous.
  const oldestFirst = [
    "Gamma",
    "Beta/One",
    "Beta/Two/Deep",
    "Beta/Two",
    "Beta",
    "Alpha",
  ];
  for (const id of oldestFirst) await touch(app, id);
  // The pinned Gamma is the oldest and stays last in the tree
  await expect(tree(app).getByRole("button")).toHaveText([
    "Alpha",
    "Beta",
    "Two",
    "Deep",
    "One",
    "Gamma",
  ]);
  await app.screenshot("page-tree");

  await toggle(app, "Beta").click();
  await expect(app.row("Beta")).toHaveAttribute("aria-expanded", "false");
  await expect(app.row("One")).toBeHidden();
  await expect(app.row("Deep")).toBeHidden();

  await app.reload();
  await expect(app.row("Beta")).toHaveAttribute("aria-expanded", "false");
  await expect(app.row("One")).toBeHidden();
  await toggle(app, "Beta").click();
  await expect(app.row("Deep")).toBeVisible();
  await app.screenshot("page-tree-expanded-again");
});

test("the row menu, the header, and Settings offer no folder actions", async ({
  app,
}) => {
  await app.seed({
    "Page.md": "# Page\n",
    "Page/Child.md": "# Child\n",
  });

  await app.row("Child").click({ button: "right" });
  await expect(app.page.getByRole("menuitem")).toHaveText([
    "New sub-page",
    "Pin",
    "Duplicate",
    "Copy Filepath",
    "Select Multiple",
    "Make private",
    "Move to...",
    "Move to Parent Page",
    "Delete",
  ]);
  await app.screenshot("row-menu");
  await app.page.keyboard.press("Escape");

  await app.sidebar.getByRole("button", { name: /^New Note/ }).click();
  await expect(app.page.getByRole("menu")).toHaveCount(0);

  await app.page.getByRole("button", { name: /^Settings/ }).click();
  await expect(app.page.getByText("Ignored Folders")).toBeVisible();
  await expect(app.page.getByText("Enable Folders")).toHaveCount(0);
});

test("a pinned sub-page shows in Pinned and still under its page", async ({
  app,
}) => {
  await app.seed({
    "Page.md": "# Page\n",
    "Page/Child.md": "# Child\n\nChild body.\n",
    "Other.md": "# Other\n",
  });
  await expect(pinned(app)).toHaveCount(0);

  await app.row("Child").click({ button: "right" });
  await menuItem(app, "Pin").click();

  const pinnedChild = pinned(app).getByRole("button", {
    name: "Child",
    exact: true,
  });
  await expect(pinnedChild).toBeVisible();
  await expect(pinned(app).getByRole("button")).toHaveCount(1);
  await expect(app.row("Child")).toBeVisible();
  expect(await left(app, "Child")).toBeGreaterThan(await left(app, "Page"));
  await app.screenshot("pinned-sub-page");

  await pinnedChild.click();
  await expect(app.editor).toContainText("Child body.");

  await pinnedChild.click({ button: "right" });
  await menuItem(app, "Unpin").click();
  await expect(pinned(app)).toHaveCount(0);
  await expect(app.row("Child")).toBeVisible();
});

test("the + on a row creates a sub-page of that page, expanding it", async ({
  app,
}) => {
  await app.seed({
    "Page.md": "# Page\n",
    "Page/Old.md": "# Old\n",
    "Other.md": "# Other\n\nOther body.\n",
  });
  await app.row("Other").click();
  await toggle(app, "Page").click();
  await expect(app.row("Old")).toBeHidden();

  await app.row("Page").hover();
  await app.row("Page").locator("[data-new-sub-page]").click();

  await expect.poll(() => app.file("Page/Untitled.md")).toBe("");
  await expect(app.editor.locator("h1")).toHaveText("");
  await expect(app.row("Page")).toHaveAttribute("aria-expanded", "true");
  await expect(app.row("Untitled")).toBeVisible();
  expect(await left(app, "Untitled")).toBeGreaterThan(await left(app, "Page"));
  await app.screenshot("new-sub-page-from-row-plus");
});

test("Cmd+N and the header + create a top-level page while a sub-page is open", async ({
  app,
}) => {
  await app.seed({
    "Page.md": "# Page\n",
    "Page/Child.md": "# Child\n\nChild body.\n",
  });

  await app.row("Child").click();
  await expect(app.editor).toContainText("Child body.");
  await app.page.keyboard.press("ControlOrMeta+n");
  await expect.poll(() => app.file("Untitled.md")).toBe("");
  await expect(app.editor.locator("h1")).toHaveText("");

  await app.row("Child").click();
  await expect(app.editor).toContainText("Child body.");
  await app.sidebar.getByRole("button", { name: /^New Note/ }).click();
  await expect.poll(() => app.file("Untitled-1.md")).toBe("");

  const notePaths = Object.keys(await app.files()).filter((p) =>
    p.endsWith(".md"),
  );
  notePaths.sort();
  expect(notePaths).toEqual([
    "Page.md",
    "Page/Child.md",
    "Untitled-1.md",
    "Untitled.md",
  ]);
  await app.screenshot("top-level-pages-created");
});

test("Move to... in the row menu and the selection bar opens the picker", async ({
  app,
}) => {
  await app.seed({
    "Page.md": "# Page\n",
    "Page/Child.md": "# Child\n",
    "Other.md": "# Other\n",
  });
  await recordMovePicks(app);

  await app.row("Child").click({ button: "right" });
  await menuItem(app, "Move to...").click();
  await expect.poll(() => movePicks(app)).toEqual([{ ids: ["Page/Child"] }]);
  await app.page.keyboard.press("Escape");

  await app.row("Page").click({ button: "right" });
  await menuItem(app, "Select Multiple").click();
  await app.row("Child").click();
  await app.row("Other").click();
  const bar = app.sidebar.locator("[data-selection-bar]");
  await expect(bar).toContainText("3 selected");
  await app.screenshot("selection-bar-move");
  await bar.getByRole("button", { name: "Move to..." }).click();

  // Child moves with Page, so only the outermost pages go to the picker
  await expect
    .poll(() => movePicks(app))
    .toEqual([{ ids: ["Page/Child"] }, { ids: ["Page", "Other"] }]);
});

test("arrow keys outside the tree follow the tree order", async ({ app }) => {
  await app.seed({
    "Alpha.md": "# Alpha\n\nAlpha body.",
    "Alpha/Child.md": "# Child\n\nChild body.",
    "Zed.md": "# Zed\n\nZed body.",
  });
  // Newest first: Alpha, then Zed. Child sits under Alpha in the tree.
  await touch(app, "Zed");
  await touch(app, "Alpha");
  await expect(app.row("Child")).toBeVisible();

  await app.page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
  });
  await app.page.keyboard.press("ArrowDown");

  await expect(app.editor).toContainText("Child body.");
  await app.screenshot("arrow-down-follows-tree");
});

test("the ... on a row opens the row menu below it", async ({ app }) => {
  await app.seed({
    "Page.md": "# Page\n",
    "Page/Child.md": "# Child\n",
  });

  await app.row("Child").hover();
  const more = app.row("Child").locator("[data-row-menu]");
  const button = await more.boundingBox();
  await more.click();
  await expect(app.page.getByRole("menuitem")).toHaveText([
    "New sub-page",
    "Pin",
    "Duplicate",
    "Copy Filepath",
    "Select Multiple",
    "Make private",
    "Move to...",
    "Move to Parent Page",
    "Delete",
  ]);
  const menu = await app.page.getByRole("menu").boundingBox();
  expect(menu!.y).toBeGreaterThanOrEqual(button!.y + button!.height);
  await app.screenshot("row-more-menu");

  // The ... opens the menu without opening the page
  await app.page.keyboard.press("Escape");
  await expect(app.editor).toBeHidden();
});

test("sidebar rows use 15px text and roomy rows", async ({ app }) => {
  await app.seed({ "Page.md": "# Page\n" });
  const title = app.row("Page").getByText("Page", { exact: true });
  await expect(title).toHaveCSS("font-size", "15px");
  const row = await app.row("Page").boundingBox();
  expect(row!.height).toBeGreaterThanOrEqual(34);
  await app.screenshot("sidebar-row-size");
});
