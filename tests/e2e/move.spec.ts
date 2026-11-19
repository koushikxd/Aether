import { expect, test, type AetherApp } from "./app";

const SETTINGS = ".aether/settings.json";

function displayUrl(rootPath: string): string {
  return `asset://localhost/${encodeURIComponent(`/fake/notes/${rootPath}`)}`;
}

async function typeAtEnd(app: AetherApp, text: string, typed: string) {
  await app.editor.getByText(text).click();
  await app.page.keyboard.press("End");
  await app.page.keyboard.type(typed);
}

test("dragging a pinned note to a nested folder keeps its image, links and pin", async ({
  app,
}) => {
  await app.seed({
    [SETTINGS]: JSON.stringify({
      foldersEnabled: true,
      pinnedNoteIds: ["Trip"],
    }),
    "Trip.md":
      "# Trip\n\n![](assets/beach.png)\n\n[Packing](Lists/Packing.md)\n\nDay one\n",
    "Lists/Packing.md": "# Packing\n\n[Back to trip](../Trip.md)\n",
    "a/b/Readme.md": "# Readme\n",
    "assets/beach.png": "png",
  });
  await app.row("Trip").click();
  await expect(app.editor.locator("img")).toHaveAttribute(
    "src",
    displayUrl("assets/beach.png"),
  );

  await app.drag("Trip", "b");

  await expect.poll(() => app.file("a/b/Trip.md")).toBeDefined();
  await expect(app.editor.locator("img")).toHaveAttribute(
    "src",
    displayUrl("assets/beach.png"),
  );
  await typeAtEnd(app, "Day one", " done");
  await expect
    .poll(() => app.savedMarkdown("a/b/Trip"))
    .toBe(
      "# Trip\n\n![](../../assets/beach.png)\n\n[Packing](../../Lists/Packing.md)\n\nDay one done",
    );
  expect(await app.file("Lists/Packing.md")).toBe(
    "# Packing\n\n[Back to trip](../a/b/Trip.md)\n",
  );

  expect(JSON.parse((await app.file(SETTINGS)) ?? "{}").pinnedNoteIds).toEqual([
    "a/b/Trip",
  ]);
  await app.row("Trip").click({ button: "right" });
  await expect(app.page.getByRole("menuitem", { name: "Unpin" })).toBeVisible();
  await app.screenshot("pinned-note-moved-into-a-b");
});

test("the open note reloads when a move rewrites its links", async ({
  app,
}) => {
  await app.seed({
    [SETTINGS]: JSON.stringify({ foldersEnabled: true }),
    "Index.md": "# Index\n\n[Trip](Trip.md)\n\nPlans\n",
    "Trip.md": "# Trip\n",
    "a/b/Readme.md": "# Readme\n",
  });
  await app.row("Index").click();
  await expect(app.editor).toContainText("Plans");

  await app.drag("Trip", "b");
  await expect(app.editor.getByRole("link", { name: "Trip" })).toHaveAttribute(
    "href",
    "a/b/Trip.md",
  );

  await typeAtEnd(app, "Plans", " soon");
  await expect
    .poll(() => app.savedMarkdown("Index"))
    .toBe("# Index\n\n[Trip](a/b/Trip.md)\n\nPlans soon");
  await app.screenshot("index-after-trip-moved");
});

test("clicking a relative link to a note opens that note", async ({ app }) => {
  await app.seed({
    "a/Note.md":
      "# Note\n\n[Other note](../Other%20Note.md#part) and [Gone](Gone.md)\n",
    "Other Note.md": "# Other Note\n\nThe other body.\n",
  });
  await app.open("a/Note");
  const popups: string[] = [];
  app.page.on("popup", (popup) => popups.push(popup.url()));

  await app.editor.getByRole("link", { name: "Gone" }).click();
  await expect(
    app.page.getByText('Note "a/Gone" does not exist'),
  ).toBeVisible();

  await app.editor.getByRole("link", { name: "Other note" }).click();
  await expect(app.editor).toContainText("The other body.");
  expect(popups, "clicking a note link must not open a window").toEqual([]);
  expect(app.page.context().pages()).toHaveLength(1);
  await app.screenshot("internal-link-opened");
});
