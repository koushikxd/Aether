import { expect, test, type AetherApp } from "./app";
import type { FakeFiles } from "./fake-backend";

const SETTINGS = ".aether/settings.json";
const FOLDERS_ON = JSON.stringify({ foldersEnabled: true });

const NOTES: FakeFiles = {
  "Alpha.md": "# Alpha\n\nAlpha body.\n",
  "Beta.md": "# Beta\n\nBeta body.\n",
  "Gamma.md": "# Gamma\n\nGamma body.\n",
  "Delta.md": "# Delta\n\nDelta body.\n",
};

const VIEWS = {
  "flat list": {
    seed: (files: FakeFiles) => files,
    // Flat list rows are labelled by title, date and preview
    row: (app: AetherApp, name: string) =>
      app.sidebar.getByRole("button", { name: new RegExp(`^${name}\\b`) }),
  },
  "folder tree": {
    seed: (files: FakeFiles) => ({ [SETTINGS]: FOLDERS_ON, ...files }),
    row: (app: AetherApp, name: string) => app.row(name),
  },
};

function noteRows(app: AetherApp) {
  return app.sidebar.locator("[data-note-list]").getByRole("button");
}

function bar(app: AetherApp) {
  return app.sidebar.locator("[data-selection-bar]");
}

async function selectMultiple(
  app: AetherApp,
  row: ReturnType<AetherApp["row"]>,
) {
  await row.click({ button: "right" });
  await app.page.getByRole("menuitem", { name: "Select Multiple" }).click();
}

for (const [view, { seed, row }] of Object.entries(VIEWS)) {
  test(`${view}: Select Multiple enters selection mode, clicks toggle, Done exits`, async ({
    app,
  }) => {
    await app.seed(seed(NOTES));
    await row(app, "Alpha").click();
    await expect(app.editor).toContainText("Alpha body.");

    await selectMultiple(app, row(app, "Beta"));
    await expect(bar(app)).toContainText("1 selected");
    await expect(row(app, "Beta")).toHaveAttribute("aria-pressed", "true");

    await row(app, "Gamma").click();
    await expect(bar(app)).toContainText("2 selected");
    await expect(row(app, "Gamma")).toHaveAttribute("aria-pressed", "true");
    await expect(app.editor).toContainText("Alpha body.");

    await row(app, "Beta").click();
    await expect(bar(app)).toContainText("1 selected");
    await expect(row(app, "Beta")).toHaveAttribute("aria-pressed", "false");
    await app.screenshot(`${view}-selection-mode`);

    await bar(app).getByRole("button", { name: "Done" }).click();
    await expect(bar(app)).toBeHidden();
    await expect(row(app, "Gamma")).not.toHaveAttribute("aria-pressed");

    await row(app, "Gamma").click();
    await expect(app.editor).toContainText("Gamma body.");
    await expect(bar(app)).toBeHidden();
  });

  test(`${view}: Esc exits selection mode`, async ({ app }) => {
    await app.seed(seed(NOTES));
    await selectMultiple(app, row(app, "Beta"));
    await row(app, "Gamma").click();
    await expect(bar(app)).toContainText("2 selected");

    await app.page.keyboard.press("Escape");
    await expect(bar(app)).toBeHidden();
    await expect(row(app, "Beta")).not.toHaveAttribute("aria-pressed");
  });

  test(`${view}: Shift+click selects the range from the open note`, async ({
    app,
  }) => {
    await app.seed(seed(NOTES));
    const rows = noteRows(app);
    await expect(rows).toHaveCount(4);
    await rows.nth(0).click();
    const openBody = await app.editor.textContent();

    await rows.nth(2).click({ modifiers: ["Shift"] });
    await expect(bar(app)).toContainText("3 selected");
    for (const i of [0, 1, 2]) {
      await expect(rows.nth(i)).toHaveAttribute("aria-pressed", "true");
    }
    await expect(rows.nth(3)).toHaveAttribute("aria-pressed", "false");
    // Rows fade their background in, so wait for the selected ones to settle
    const bg = (i: number) =>
      rows.nth(i).evaluate((el) => getComputedStyle(el).backgroundColor);
    await expect
      .poll(async () => {
        const [a, b, c, unselected] = await Promise.all([0, 1, 2, 3].map(bg));
        return a === b && b === c && c !== unselected;
      })
      .toBe(true);
    expect(await app.editor.textContent()).toBe(openBody);
    await app.screenshot(`${view}-shift-click-range`);
  });

  test(`${view}: Cmd+click opens the note and selects nothing`, async ({
    app,
  }) => {
    await app.seed(seed(NOTES));
    await row(app, "Alpha").click();
    await row(app, "Beta").click({ modifiers: ["ControlOrMeta"] });
    await expect(app.editor).toContainText("Beta body.");
    await expect(bar(app)).toBeHidden();
    await expect(row(app, "Beta")).not.toHaveAttribute("aria-pressed");
  });

  test(`${view}: bulk delete counts each sub-page once`, async ({ app }) => {
    await app.seed(
      seed({
        ...NOTES,
        "Page.md": "# Page\n",
        "Page/Child.md": "# Child\n",
        "Page/Child/Grand.md": "# Grand\n",
      }),
    );
    await selectMultiple(app, row(app, "Page"));
    await row(app, "Child").click();
    await row(app, "Alpha").click();
    await expect(bar(app)).toContainText("3 selected");

    await bar(app).getByRole("button", { name: "Delete" }).click();
    const dialog = app.page.getByRole("alertdialog");
    // Alpha, Page, and Page's two sub-pages; Child is not counted twice
    await expect(dialog).toContainText("permanently delete 4 pages");
    await app.screenshot(`${view}-bulk-delete-dialog`);
    await dialog.getByRole("button", { name: "Delete" }).click();

    await expect(dialog).toBeHidden();
    await expect(bar(app)).toBeHidden();
    await expect
      .poll(async () =>
        Object.keys(await app.files()).filter((path) => path.endsWith(".md")),
      )
      .toEqual(["Beta.md", "Gamma.md", "Delta.md"]);
    // In selection order, skipping Child, which goes with Page
    expect((await app.calls("delete_note")).map((c) => c.args.id)).toEqual([
      "Page",
      "Alpha",
    ]);
  });
}

test("folder tree: dragging a selection moves every selected note", async ({
  app,
}) => {
  await app.seed({
    [SETTINGS]: FOLDERS_ON,
    ...NOTES,
    "Box/Readme.md": "# Readme\n",
  });
  await selectMultiple(app, app.row("Alpha"));
  await app.row("Beta").click();
  await expect(bar(app)).toContainText("2 selected");

  await app.drag("Alpha", "Box");

  await expect.poll(() => app.file("Box/Alpha.md")).toBeDefined();
  await expect.poll(() => app.file("Box/Beta.md")).toBeDefined();
  expect(await app.file("Gamma.md")).toBeDefined();
  await expect(bar(app)).toBeHidden();
  await app.screenshot("selection-dragged-into-box");
});
