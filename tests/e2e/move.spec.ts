import { expect, test, type AetherApp } from "./app";

const SETTINGS = ".aether/settings.json";

function displayUrl(rootPath: string): string {
  return `asset://localhost/${encodeURIComponent(`/fake/notes/${rootPath}`)}`;
}

async function left(app: AetherApp, name: string): Promise<number> {
  const box = await app
    .row(name)
    .getByText(name, { exact: true })
    .boundingBox();
  if (!box) throw new Error(`${name} is not visible`);
  return box.x;
}

async function typeAtEnd(app: AetherApp, text: string, typed: string) {
  await app.editor.getByText(text).click();
  await app.page.keyboard.press("End");
  await app.page.keyboard.type(typed);
}

/** Drags a sidebar row onto the empty area below the tree. */
async function dragToTopLevel(app: AetherApp, source: string) {
  const from = await app.row(source).boundingBox();
  const area = await app.sidebar.locator("[data-note-list]").boundingBox();
  if (!from || !area) throw new Error("drag rows are not visible");
  const { mouse } = app.page;
  await mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await mouse.down();
  await mouse.move(from.x + from.width / 2, from.y + from.height / 2 + 10, {
    steps: 3,
  });
  await mouse.move(area.x + area.width / 2, area.y + area.height - 20, {
    steps: 10,
  });
  await mouse.up();
}

test("dropping a pinned page on a sub-page nests it, keeping its image, links and pin", async ({
  app,
}) => {
  await app.seed({
    [SETTINGS]: JSON.stringify({ pinnedNoteIds: ["Trip"] }),
    "Trip.md":
      "# Trip\n\n![](assets/beach.png)\n\n[Packing](Lists/Packing.md)\n\nDay one\n",
    "Lists.md": "# Lists\n",
    "Lists/Packing.md": "# Packing\n\n[Back to trip](../Trip.md)\n",
    "Plans.md": "# Plans\n",
    "Plans/Travel.md": "# Travel\n",
    "assets/beach.png": "png",
  });
  await app.row("Trip").click();
  await expect(app.editor.locator("img")).toHaveAttribute(
    "src",
    displayUrl("assets/beach.png"),
  );

  await app.drag("Trip", "Travel");

  await expect.poll(() => app.file("Plans/Travel/Trip.md")).toBeDefined();
  await expect(app.row("Travel")).toHaveAttribute("aria-expanded", "true");
  expect(await left(app, "Trip")).toBeGreaterThan(await left(app, "Travel"));
  await expect(app.editor.locator("img")).toHaveAttribute(
    "src",
    displayUrl("assets/beach.png"),
  );
  await typeAtEnd(app, "Day one", " done");
  await expect
    .poll(() => app.savedMarkdown("Plans/Travel/Trip"))
    .toBe(
      "# Trip\n\n![](../../assets/beach.png)\n\n[Packing](../../Lists/Packing.md)\n\nDay one done",
    );
  expect(await app.file("Lists/Packing.md")).toBe(
    "# Packing\n\n[Back to trip](../Plans/Travel/Trip.md)\n",
  );

  expect(JSON.parse((await app.file(SETTINGS)) ?? "{}").pinnedNoteIds).toEqual([
    "Plans/Travel/Trip",
  ]);
  await app.row("Trip").click({ button: "right" });
  await expect(app.page.getByRole("menuitem", { name: "Unpin" })).toBeVisible();
  await app.page.keyboard.press("Escape");

  // The link from Packing still leads to the moved page
  await app.row("Packing").click();
  await app.editor.getByRole("link", { name: "Back to trip" }).click();
  await expect(app.editor).toContainText("Day one done");
  await app.screenshot("pinned-page-nested-under-travel");
});

test("the open note reloads when a move rewrites its links", async ({
  app,
}) => {
  await app.seed({
    "Index.md": "# Index\n\n[Trip](Trip.md)\n\nPlans\n",
    "Trip.md": "# Trip\n\nTrip body\n",
    "Plans.md": "# Plans\n",
    "Plans/Travel.md": "# Travel\n",
  });
  await app.row("Index").click();
  await expect(app.editor).toContainText("Plans");

  await app.drag("Trip", "Travel");
  await expect(app.editor.getByRole("link", { name: "Trip" })).toHaveAttribute(
    "href",
    "Plans/Travel/Trip.md",
  );

  await typeAtEnd(app, "Plans", " soon");
  await expect
    .poll(() => app.savedMarkdown("Index"))
    .toBe("# Index\n\n[Trip](Plans/Travel/Trip.md)\n\nPlans soon");
  await app.editor.getByRole("link", { name: "Trip" }).click();
  await expect(app.editor).toContainText("Trip body");
  await app.screenshot("index-after-trip-moved");
});

test("dropping a sub-page below the tree moves it to the top level", async ({
  app,
}) => {
  await app.seed({
    "Index.md": "# Index\n\n[Trip](Plans/Travel/Trip.md)\n",
    "Plans.md": "# Plans\n",
    "Plans/Travel.md": "# Travel\n",
    "Plans/Travel/Trip.md": "# Trip\n\nTrip body\n",
  });

  await dragToTopLevel(app, "Trip");

  await expect.poll(() => app.file("Trip.md")).toBe("# Trip\n\nTrip body\n");
  expect(await app.file("Index.md")).toBe("# Index\n\n[Trip](Trip.md)\n");
  expect(await left(app, "Trip")).toBe(await left(app, "Plans"));
  await app.row("Index").click();
  await app.editor.getByRole("link", { name: "Trip" }).click();
  await expect(app.editor).toContainText("Trip body");
  await app.screenshot("sub-page-moved-to-top-level");
});

test("a page dropped on itself, its own sub-page, or its own parent stays put", async ({
  app,
}) => {
  await app.seed({
    "Plans.md": "# Plans\n",
    "Plans/Travel.md": "# Travel\n",
    "Plans/Travel/Trip.md": "# Trip\n",
    "Index.md": "# Index\n",
  });

  await app.drag("Plans", "Travel");
  await app.drag("Plans", "Trip");
  await app.drag("Trip", "Travel");
  await dragToTopLevel(app, "Index");
  // Give a move time to reach the backend
  await app.page.waitForTimeout(300);

  expect(await app.calls("move_note")).toEqual([]);
  await expect(app.row("Trip")).toBeVisible();
  expect(await left(app, "Trip")).toBeGreaterThan(await left(app, "Travel"));
  await app.screenshot("page-dropped-into-itself");
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
