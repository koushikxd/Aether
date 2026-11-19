import { expect, test, type AetherApp } from "./app";

// The Rust importer's output for tests/fixtures/notion/aether-import-fixture.zip;
// `cargo test notion_import` checks it byte for byte.
const EXPECTED = "/tests/fixtures/notion/expected/";
const IMPORTED = [
  "Notion Import/Aether Import Fixture",
  "Notion Import/Aether Import Fixture/Child Page",
  "Notion Import/Aether Import Fixture/Child Page/Grandchild Page",
  "Notion Import/Aether Import Fixture/Child Page-1",
  "Notion Import/Aether Import Fixture/Untitled",
  "Notion Import/Aether Import Fixture/Tasks DB",
  "Notion Import/Aether Import Fixture/Tasks DB/Draft outline",
  "Notion Import/Aether Import Fixture/Tasks DB/Check layout",
  "Notion Import/Aether Import Fixture/Tasks DB/Review export",
];

async function expectedNotes(app: AetherApp): Promise<Record<string, string>> {
  const notes: Record<string, string> = {};
  for (const id of IMPORTED) {
    const response = await app.page.request.get(
      `${EXPECTED}${encodeURI(id)}.md`,
    );
    expect(response.ok(), id).toBe(true);
    notes[`${id}.md`] = await response.text();
  }
  return notes;
}

test("imported Notion notes save back unchanged from the editor", async ({
  app,
}) => {
  const notes = await expectedNotes(app);
  await app.seed({
    ...notes,
    "assets/image.png": "png",
    "assets/image-1.png": "png",
    "assets/fixture-document.pdf": "%PDF-1.4",
  });

  for (const id of IMPORTED) {
    await app.open(id);
    const title = app.editor.locator("h1").first();
    const name = id.split("/").pop() ?? id;
    await expect(title).toHaveText(name.replace(/-1$/, ""));
    await app.resave(name.replace(/-1$/, ""));
    await expect
      .poll(() => app.savedMarkdown(id), { message: id })
      .toBe(notes[`${id}.md`]);
  }
  await app.open(IMPORTED[0]);
  await expect(app.editor.locator("[data-callout]")).toContainText(
    "First callout line.",
  );
  const equation = app.editor.locator('[data-type="inline-math"]');
  await expect(equation).toHaveAttribute("data-latex", "a^2 + b^2 = c^2");
  await expect(equation.locator(".katex")).toBeVisible();
  await app.screenshot("imported-parent-page");
});

test("Import from Notion shows progress and a summary with skipped items", async ({
  app,
}) => {
  await app.seed({
    ".aether/settings.json": JSON.stringify({ foldersEnabled: true }),
    "Work/Plan.md": "# Plan\n",
  });
  const zips = [
    "/Users/me/Downloads/Export-Part-1.zip",
    "/Users/me/Downloads/Export-Part-2.zip",
  ];
  await app.page.getByRole("button", { name: /^Settings/ }).click();
  await app.pickFile(zips);
  await app.page.getByRole("button", { name: "Import from Notion" }).click();

  const dialog = app.page.getByRole("alertdialog");
  await expect(dialog).toContainText("Export-Part-1.zip");
  await expect(dialog).toContainText("Export-Part-2.zip");
  const destination = dialog.getByLabel("Destination");
  await expect(destination).toHaveValue("");
  await expect(destination.locator("option", { hasText: "Work" })).toHaveCount(
    1,
  );
  await dialog.getByRole("button", { name: "Import", exact: true }).click();
  await expect
    .poll(() => app.calls("import_notion"))
    .toEqual([{ cmd: "import_notion", args: { paths: zips, folder: null } }]);

  await app.emit("notion-import-progress", { current: 4, total: 9 });
  await expect(dialog).toContainText("Imported 4 of 9 pages");

  await app.page.evaluate(() =>
    window.aetherFake?.finishNotionImport?.(
      { "Notion Import/Roadmap.md": "# Roadmap\n" },
      {
        folder: "Notion Import",
        pages: 9,
        images: 2,
        files: 1,
        skipped: [
          {
            page: "Notion Import/Roadmap",
            reason: "Unsupported block div.timeline, kept as plain text",
          },
        ],
      },
    ),
  );
  await expect(dialog).toContainText(
    'Imported 9 pages, 2 images and 1 file into "Notion Import"',
  );
  await expect(dialog).toContainText("Notion Import/Roadmap");
  await expect(dialog).toContainText(
    "Unsupported block div.timeline, kept as plain text",
  );
  await app.screenshot("notion-import-summary");

  await dialog.getByRole("button", { name: "Done" }).click();
  await expect(dialog).toBeHidden();
  await app.page.getByRole("button", { name: /^Back/ }).click();
  await expect(app.row("Notion Import")).toBeVisible();
});
