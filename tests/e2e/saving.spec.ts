import { expect, test, type AetherApp } from "./app";

const SETTINGS = ".aether/settings.json";
const FOLDERS_ON = JSON.stringify({ foldersEnabled: true });
const PAGE = "# Page\n\n[Child](Page/Child.md)\n\nBody\n";

async function fileList(app: AetherApp): Promise<string[]> {
  const paths = Object.keys(await app.files());
  paths.sort();
  return paths;
}

async function typeAtEnd(app: AetherApp, text: string, typed: string) {
  await app.editor.getByText(text, { exact: true }).click();
  await expect.poll(async () => (await app.editorSelection()).block).toBe(text);
  await app.page.keyboard.press("End");
  await app.page.keyboard.type(typed);
}

/** Opens Page, renames it to "Page Two", and puts the cursor after "Body" while the save is held. */
async function renameWhileSaveHeld(app: AetherApp) {
  await app.seed({
    [SETTINGS]: FOLDERS_ON,
    "Page.md": PAGE,
    "Page/Child.md": "# Child\n",
  });
  await app.row("Page").click();
  await expect(app.editor.locator("h1")).toHaveText("Page");
  await app.hold("save_note");
  await typeAtEnd(app, "Page", " Two");
  await app.editor.getByText("Body", { exact: true }).click();
  await app.page.keyboard.press("End");
  await expect.poll(() => app.calls("save_note")).toHaveLength(1);
}

test("a title rename that rewrites links keeps the cursor and what was typed during the save", async ({
  app,
}) => {
  await renameWhileSaveHeld(app);
  await app.page.keyboard.type(" more");
  await app.release("save_note");

  const saved = "# Page Two\n\n[Child](Page%20Two/Child.md)\n\nBody more";
  await expect.poll(() => app.file("Page Two.md")).toBe(saved);
  await expect(app.editor.getByRole("link", { name: "Child" })).toHaveAttribute(
    "href",
    "Page%20Two/Child.md",
  );
  await expect(app.editor).toBeFocused();
  await app.page.keyboard.type("!");
  await expect.poll(() => app.file("Page Two.md")).toBe(`${saved}!`);
  expect(await fileList(app)).toEqual([
    SETTINGS,
    "Page Two.md",
    "Page Two/Child.md",
  ]);
  await app.screenshot("renamed-while-typing");
});

test("a save waits for the one in flight and goes to the renamed note", async ({
  app,
}) => {
  await renameWhileSaveHeld(app);
  await app.page.keyboard.type(" more");
  // Longer than the 500ms save debounce: the next save is due but must wait
  await app.page.waitForTimeout(800);
  expect(await app.calls("save_note")).toHaveLength(1);

  await app.release("save_note");
  await expect
    .poll(() => app.file("Page Two.md"))
    .toBe("# Page Two\n\n[Child](Page%20Two/Child.md)\n\nBody more");
  const saves = await app.calls("save_note");
  expect(saves.map((c) => c.args.id)).toEqual(["Page", "Page Two"]);
  expect(await fileList(app)).toEqual([
    SETTINGS,
    "Page Two.md",
    "Page Two/Child.md",
  ]);
});

test("dragging the open note right after typing saves the typing to the moved note", async ({
  app,
}) => {
  await app.seed({
    [SETTINGS]: FOLDERS_ON,
    "Trip.md": "# Trip\n\nDay one\n",
    "a/b/Readme.md": "# Readme\n",
  });
  await app.row("Trip").click();
  await typeAtEnd(app, "Day one", " done");
  await app.drag("Trip", "b");

  await expect
    .poll(() => app.file("a/b/Trip.md"))
    .toBe("# Trip\n\nDay one done");
  await expect(app.editor).toContainText("Day one done");
  // Give a stale save time to recreate the old file
  await app.page.waitForTimeout(800);
  expect(await fileList(app)).toEqual([
    SETTINGS,
    "a/b/Readme.md",
    "a/b/Trip.md",
  ]);
});

test("dragging the page of the open sub-page right after typing saves the typing to the moved sub-page", async ({
  app,
}) => {
  await app.seed({
    [SETTINGS]: FOLDERS_ON,
    "Page.md": "# Page\n",
    "Page/Child.md": "# Child\n\nNotes\n",
    "a/b/Readme.md": "# Readme\n",
  });
  await app.row("Child").click();
  await typeAtEnd(app, "Notes", " kept");
  await app.drag("Page", "b");

  await expect
    .poll(() => app.file("a/b/Page/Child.md"))
    .toBe("# Child\n\nNotes kept");
  await app.page.waitForTimeout(800);
  expect(await fileList(app)).toEqual([
    SETTINGS,
    "a/b/Page.md",
    "a/b/Page/Child.md",
    "a/b/Readme.md",
  ]);
});

test("moving a folder that rewrites the open note's links keeps what was just typed", async ({
  app,
}) => {
  await app.seed({
    [SETTINGS]: FOLDERS_ON,
    "Index.md": "# Index\n\n[Trip](Plans/Trip.md)\n\nNotes\n",
    "Plans/Trip.md": "# Trip\n",
    "a/b/Readme.md": "# Readme\n",
  });
  await app.row("Index").click();
  await typeAtEnd(app, "Notes", " soon");
  await app.drag("Plans", "b");

  await expect(app.editor.getByRole("link", { name: "Trip" })).toHaveAttribute(
    "href",
    "a/b/Plans/Trip.md",
  );
  await expect(app.editor).toContainText("Notes soon");
  await expect
    .poll(() => app.file("Index.md"))
    .toBe("# Index\n\n[Trip](a/b/Plans/Trip.md)\n\nNotes soon");
  await app.screenshot("folder-moved-after-typing");
});
