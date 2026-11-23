import { expect, test, type AetherApp } from "./app";

// The Rust importer's output for tests/fixtures/notion/aether-import-fixture.zip;
// `cargo test notion_import` checks it byte for byte.
const EXPECTED = "/tests/fixtures/notion/expected/";
const IMPORTED = [
  "Aether Import Fixture",
  "Aether Import Fixture/Child Page",
  "Aether Import Fixture/Child Page/Grandchild Page",
  "Aether Import Fixture/Child Page-1",
  "Aether Import Fixture/Untitled",
  "Aether Import Fixture/Tasks DB",
  "Aether Import Fixture/Tasks DB/Draft outline",
  "Aether Import Fixture/Tasks DB/Check layout",
  "Aether Import Fixture/Tasks DB/Review export",
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

test("Import from Notion imports at the root, shows progress, a summary with skipped items, and offers only the imported pages as private", async ({
  app,
}) => {
  await app.seed({ "Plan.md": "# Plan\n" });
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
  await expect(dialog.getByRole("combobox")).toHaveCount(0);
  await dialog.getByRole("button", { name: "Import", exact: true }).click();
  await expect
    .poll(() => app.calls("import_notion"))
    .toEqual([{ cmd: "import_notion", args: { paths: zips } }]);

  await app.emit("notion-import-progress", { current: 4, total: 9 });
  await expect(dialog).toContainText("Imported 4 of 9 pages");

  await app.page.evaluate(() =>
    window.aetherFake?.finishNotionImport?.(
      {
        "Roadmap.md": "# Roadmap\n",
        "Roadmap/Q1.md": "# Q1\n",
      },
      {
        ids: ["Roadmap", "Roadmap/Q1"],
        pages: 9,
        images: 2,
        files: 1,
        skipped: [
          {
            page: "Roadmap",
            reason: "Unsupported block div.timeline, kept as plain text",
          },
        ],
      },
    ),
  );
  await expect(dialog).toContainText("Imported 9 pages, 2 images and 1 file");
  await expect(dialog).not.toContainText(" into ");
  await expect(dialog).toContainText(
    "Unsupported block div.timeline, kept as plain text",
  );
  await app.screenshot("notion-import-summary");

  await dialog.getByRole("button", { name: "Select private pages" }).click();
  await expect(dialog.getByRole("checkbox", { name: "Roadmap" })).toBeVisible();
  await expect(dialog.getByRole("checkbox", { name: "Plan" })).toHaveCount(0);
  await dialog.getByRole("button", { name: "Back" }).click();

  await dialog.getByRole("button", { name: "Done" }).click();
  await expect(dialog).toBeHidden();
  await app.page.getByRole("button", { name: /^Back/ }).click();
  await expect(app.sidebar.getByText("Roadmap", { exact: true })).toBeVisible();
});
