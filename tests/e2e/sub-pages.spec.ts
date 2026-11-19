import { expect, test, type AetherApp } from "./app";

const SETTINGS = ".aether/settings.json";
const FOLDERS_ON = JSON.stringify({ foldersEnabled: true });

function toggle(app: AetherApp, name: string) {
  return app.row(name).locator("[data-sub-pages-toggle]");
}

async function left(app: AetherApp, name: string): Promise<number> {
  const box = await app
    .row(name)
    .getByText(name, { exact: true })
    .boundingBox();
  if (!box) throw new Error(`${name} is not visible`);
  return box.x;
}

async function fileList(app: AetherApp): Promise<string[]> {
  const paths = Object.keys(await app.files());
  paths.sort();
  return paths;
}

function pinnedIds(settings: string | undefined): unknown {
  return JSON.parse(settings ?? "{}").pinnedNoteIds;
}

test("a page and its folder show as one item that opens the page", async ({
  app,
}) => {
  await app.seed({
    [SETTINGS]: FOLDERS_ON,
    "Page.md": "# Page\n\nThe page body.\n",
    "Page/Child.md": "# Child\n",
    "Page/Nested.md": "# Nested\n",
    "Page/Nested/Deep.md": "# Deep\n",
    "Folder/Note.md": "# Note\n",
    "Lonely.md": "# Lonely\n",
  });

  await expect(app.row("Page")).toHaveCount(1);
  await expect(app.row("Page")).toHaveAttribute("aria-expanded", "true");
  await expect(app.row("Nested")).toHaveAttribute("aria-expanded", "true");
  expect(await left(app, "Child")).toBeGreaterThan(await left(app, "Page"));
  expect(await left(app, "Deep")).toBeGreaterThan(await left(app, "Nested"));
  await expect(app.row("Folder")).not.toHaveAttribute("aria-expanded");
  await expect(app.row("Lonely")).not.toHaveAttribute("aria-expanded");
  await expect(app.row("Note")).toBeVisible();

  await app.row("Page").click();
  await expect(app.editor).toContainText("The page body.");
  await app.screenshot("merged-page-node");

  await toggle(app, "Page").click();
  await expect(app.row("Page")).toHaveAttribute("aria-expanded", "false");
  await expect(app.row("Child")).toBeHidden();
  await expect(app.editor).toContainText("The page body.");
});

test("New sub-page in the context menu creates and opens a nested note", async ({
  app,
}) => {
  await app.seed({
    [SETTINGS]: FOLDERS_ON,
    "Page.md": "# Page\n",
    "Other.md": "# Other\n",
  });

  await app.row("Page").click({ button: "right" });
  await app.page.getByRole("menuitem", { name: "New sub-page" }).click();

  await expect.poll(() => app.file("Page/Untitled.md")).toBe("# Untitled\n\n");
  await expect(app.editor.locator("h1")).toHaveText("Untitled");
  await expect(app.row("Page")).toHaveCount(1);
  await expect(app.row("Page")).toHaveAttribute("aria-expanded", "true");
  expect(await left(app, "Untitled")).toBeGreaterThan(await left(app, "Page"));
  await app.screenshot("new-sub-page-from-context-menu");
});

test("New sub-page on a page named like a hidden folder explains why it can't", async ({
  app,
}) => {
  await app.seed({ [SETTINGS]: FOLDERS_ON, "build.md": "# build\n" });

  await app.row("build").click({ button: "right" });
  await app.page.getByRole("menuitem", { name: "New sub-page" }).click();

  await expect(
    app.page.getByText(
      'The sidebar hides notes in a folder named "build". Rename the page first.',
    ),
  ).toBeVisible();
  expect(await fileList(app)).not.toContain("build/Untitled.md");
  await app.screenshot("new-sub-page-under-hidden-folder-name");
});

test("the Sub-page slash command creates a sub-page and links to it", async ({
  app,
}) => {
  await app.seed({
    [SETTINGS]: FOLDERS_ON,
    "a/My Page.md": "# My Page\n\nIntro\n",
  });
  await app.open("a/My Page");
  await app.editor.getByText("Intro").click();
  await app.page.keyboard.press("End");
  await app.page.keyboard.press("Enter");
  await app.page.keyboard.type("/sub-page");
  await app.page.keyboard.press("Enter");

  await expect
    .poll(() => app.file("a/My Page/Untitled.md"))
    .toBe("# Untitled\n\n");
  await expect
    .poll(() => app.savedMarkdown("a/My Page"))
    .toBe("# My Page\n\nIntro\n\n[Untitled](My%20Page/Untitled.md)");
  await expect(app.row("My Page")).toHaveAttribute("aria-expanded", "true");
  await expect(app.row("Untitled")).toBeVisible();

  await app.editor.getByRole("link", { name: "Untitled" }).click();
  await expect(app.editor.locator("h1")).toHaveText("Untitled");
  await app.screenshot("sub-page-from-slash-command");
});

test("renaming a page through its title moves its sub-pages", async ({
  app,
}) => {
  await app.seed({
    [SETTINGS]: JSON.stringify({
      foldersEnabled: true,
      pinnedNoteIds: ["Page/Child"],
    }),
    "Page.md": "# Page\n\nBody\n",
    "Page/Child.md": "# Child\n\n[Up](../Page.md)\n",
    "Index.md": "# Index\n\n[Child](Page/Child.md)\n",
  });
  await app.row("Page").click();
  await app.editor.locator("h1").click();
  await app.page.keyboard.press("End");
  await app.page.keyboard.type(" Two");

  await expect
    .poll(() => app.file("Page Two/Child.md"))
    .toBe("# Child\n\n[Up](../Page%20Two.md)\n");
  expect(await fileList(app)).toEqual([
    SETTINGS,
    "Index.md",
    "Page Two.md",
    "Page Two/Child.md",
  ]);
  expect(await app.file("Index.md")).toBe(
    "# Index\n\n[Child](Page%20Two/Child.md)\n",
  );
  expect(pinnedIds(await app.file(SETTINGS))).toEqual(["Page Two/Child"]);

  await expect(app.row("Page Two")).toHaveAttribute("aria-expanded", "true");
  await app.row("Child").click();
  await app.editor.getByRole("link", { name: "Up" }).click();
  await expect(app.editor.locator("h1")).toHaveText("Page Two");
  await app.screenshot("renamed-page-with-sub-page");
});

test("opening a sub-page right after renaming its page follows the rename", async ({
  app,
}) => {
  await app.seed({
    [SETTINGS]: FOLDERS_ON,
    "Page.md": "# Page\n",
    "Page/Child.md": "# Child\n\nChild body\n",
  });
  await app.row("Page").click();
  await app.editor.locator("h1").click();
  await app.page.keyboard.press("End");
  await app.page.keyboard.press("Shift+Home");
  await app.page.keyboard.type("Renamed");
  // Before the autosave fires, so switching notes saves the rename
  await app.row("Child").click();
  await expect(app.row("Renamed")).toBeVisible();

  await app.editor.getByText("Child body").click();
  await app.page.keyboard.press("End");
  await app.page.keyboard.type(" edited");

  await expect
    .poll(() => app.file("Renamed/Child.md"))
    .toBe("# Child\n\nChild body edited");
  expect(await fileList(app)).toEqual([
    SETTINGS,
    "Renamed.md",
    "Renamed/Child.md",
  ]);
  await app.screenshot("sub-page-opened-during-rename");
});

test("deleting a page asks first, counting what goes, then deletes it all", async ({
  app,
}) => {
  await app.seed({
    [SETTINGS]: JSON.stringify({
      foldersEnabled: true,
      pinnedNoteIds: ["Page/A", "Keep"],
    }),
    "Page.md": "# Page\n",
    "Page/A.md": "# A\n\nInside A\n",
    "Page/B.md": "# B\n",
    "Page/B/C.md": "# C\n",
    "Page/spec.pdf": "pdf",
    "Keep.md": "# Keep\n",
  });
  await app.row("A").click();
  await expect(app.editor).toContainText("Inside A");

  await app.row("Page").click({ button: "right" });
  await app.page.getByRole("menuitem", { name: "Delete" }).click();
  const dialog = app.page.getByRole("alertdialog");
  await expect(dialog).toContainText(
    "This also deletes 3 sub-pages and 1 other file.",
  );
  await app.screenshot("delete-page-confirmation");

  await dialog.getByRole("button", { name: "Delete" }).click();
  await expect.poll(() => fileList(app)).toEqual([SETTINGS, "Keep.md"]);
  expect(pinnedIds(await app.file(SETTINGS))).toEqual(["Keep"]);
  await expect(app.row("Page")).toHaveCount(0);
  await expect(app.editor).toBeHidden();
});

test("Delete stays disabled until the sub-pages are counted", async ({
  app,
}) => {
  await app.seed({
    [SETTINGS]: FOLDERS_ON,
    "Page.md": "# Page\n",
    "Page/A.md": "# A\n",
  });
  await app.hold("sub_page_counts");

  await app.row("Page").click({ button: "right" });
  await app.page.getByRole("menuitem", { name: "Delete" }).click();
  const dialog = app.page.getByRole("alertdialog");
  const confirm = dialog.getByRole("button", { name: "Delete" });
  await expect(confirm).toBeDisabled();
  await app.screenshot("delete-page-counting");

  await app.release("sub_page_counts");
  await expect(dialog).toContainText("This also deletes 1 sub-page.");
  await expect(confirm).toBeEnabled();
});

test("dragging moves a page with its sub-pages, and dropping on a note nests it", async ({
  app,
}) => {
  await app.seed({
    [SETTINGS]: FOLDERS_ON,
    "Page.md": "# Page\n",
    "Page/Child.md": "# Child\n\n[Up](../Page.md)\n",
    "Archive/Old.md": "# Old\n",
    "Loose.md": "# Loose\n",
  });

  await app.drag("Page", "Archive");
  await expect
    .poll(() => fileList(app))
    .toEqual([
      SETTINGS,
      "Archive/Old.md",
      "Archive/Page.md",
      "Archive/Page/Child.md",
      "Loose.md",
    ]);
  expect(await app.file("Archive/Page/Child.md")).toBe(
    "# Child\n\n[Up](../Page.md)\n",
  );

  await app.drag("Loose", "Old");
  await expect.poll(() => app.file("Archive/Old/Loose.md")).toBe("# Loose\n");
  await expect(app.row("Old")).toHaveAttribute("aria-expanded", "true");
  await app.screenshot("page-dragged-into-archive");
});
