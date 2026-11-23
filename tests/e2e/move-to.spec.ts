import { expect, test, type AetherApp } from "./app";

function picker(app: AetherApp) {
  return app.page.locator("[data-move-picker]");
}

function pickerInput(app: AetherApp) {
  return picker(app).getByRole("textbox");
}

async function left(app: AetherApp, name: string): Promise<number> {
  const box = await app
    .row(name)
    .getByText(name, { exact: true })
    .boundingBox();
  if (!box) throw new Error(`${name} is not visible`);
  return box.x;
}

async function moves(app: AetherApp) {
  return (await app.calls("move_note")).map((call) => call.args);
}

async function openPickerFromMenu(app: AetherApp) {
  await app.page.keyboard.press("ControlOrMeta+k");
  const menu = app.page.locator("[data-command-menu]");
  await menu.getByRole("textbox").fill("Move to");
  await app.page.keyboard.press("Enter");
  await expect(menu).toBeHidden();
  await expect(pickerInput(app)).toBeFocused();
}

test("the command menu moves the open page into another page and back to the top level", async ({
  app,
}) => {
  await app.seed({
    "Projects.md": "# Projects\n",
    "Trip.md": "# Trip\n\nDay one\n",
  });
  await app.row("Trip").click();
  await expect(app.editor).toContainText("Day one");

  await openPickerFromMenu(app);
  await app.page.keyboard.type("proj");
  await app.screenshot("picker-filtered");
  await app.page.keyboard.press("Enter");

  await expect
    .poll(() => moves(app))
    .toEqual([{ id: "Trip", targetFolder: "Projects" }]);
  await expect(picker(app)).toBeHidden();
  await expect.poll(() => app.file("Projects/Trip.md")).toBeDefined();
  await expect(app.row("Projects")).toHaveAttribute("aria-expanded", "true");
  expect(await left(app, "Trip")).toBeGreaterThan(await left(app, "Projects"));
  await expect(app.editor).toContainText("Day one");
  await app.screenshot("trip-under-projects");

  // Top level comes first, and the open page followed the move
  await openPickerFromMenu(app);
  await app.page.keyboard.press("Enter");

  await expect
    .poll(() => moves(app))
    .toEqual([
      { id: "Trip", targetFolder: "Projects" },
      { id: "Projects/Trip", targetFolder: "" },
    ]);
  await expect.poll(() => app.file("Trip.md")).toBeDefined();
  await expect(app.row("Trip")).toBeVisible();
  expect(await left(app, "Trip")).toBe(await left(app, "Projects"));
  await expect(app.editor).toContainText("Day one");
  await app.screenshot("trip-back-at-top-level");
});

test("the open-move-picker event moves a multi-selection into a page, one after another", async ({
  app,
}) => {
  await app.seed({
    "Projects.md": "# Projects\n",
    "Alpha.md": "# Alpha\n\nAlpha body\n",
    "Beta.md": "# Beta\n",
  });
  await app.row("Alpha").click();
  await expect(app.editor).toContainText("Alpha body");

  await app.page.evaluate(() =>
    window.dispatchEvent(
      new CustomEvent("open-move-picker", {
        detail: { ids: ["Alpha", "Beta"] },
      }),
    ),
  );
  await expect(pickerInput(app)).toBeFocused();
  await app.page.keyboard.type("Projects");
  await app.page.keyboard.press("Enter");

  await expect
    .poll(() => moves(app))
    .toEqual([
      { id: "Alpha", targetFolder: "Projects" },
      { id: "Beta", targetFolder: "Projects" },
    ]);
  await expect.poll(() => app.file("Projects/Beta.md")).toBeDefined();
  expect(await app.file("Projects/Alpha.md")).toBeDefined();
  const parent = await left(app, "Projects");
  expect(await left(app, "Alpha")).toBeGreaterThan(parent);
  expect(await left(app, "Beta")).toBeGreaterThan(parent);
  await expect(app.editor).toContainText("Alpha body");
  await app.screenshot("alpha-and-beta-under-projects");
});

test("the picker leaves out the page and its sub-pages, and Esc closes it", async ({
  app,
}) => {
  await app.seed({
    "Trip.md": "# Trip\n",
    "Trip/Day one.md": "# Day one\n",
    "Trip/Day one/Morning.md": "# Morning\n",
    "Tripod.md": "# Tripod\n",
    "Projects.md": "# Projects\n",
    "Projects/Ideas.md": "# Ideas\n",
  });
  await app.row("Trip").click();

  await openPickerFromMenu(app);
  const labels = (await picker(app).getByRole("button").allInnerTexts()).map(
    (text) => text.replace(/\s+/g, " ").trim(),
  );
  labels.sort();
  // The open page is top level, so moving it to the top level is a no-op
  expect(labels).toEqual(["Ideas Projects", "Projects", "Tripod"]);
  await app.screenshot("picker-without-trip");

  await app.page.keyboard.type("day");
  await expect(picker(app)).toContainText("No pages found");

  await app.page.keyboard.press("Escape");
  await expect(picker(app)).toBeHidden();
  expect(await moves(app)).toEqual([]);
});
