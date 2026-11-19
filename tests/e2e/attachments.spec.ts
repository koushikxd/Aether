import { expect, test, type AetherApp } from "./app";

const NOTE = "a/b/Note";
const PHOTO = "https://example.test/photo.svg";

async function openNote(app: AetherApp, markdown: string) {
  await app.page.emulateMedia({ colorScheme: "light" });
  await app.seed({ [`${NOTE}.md`]: markdown });
  await app.open(NOTE);
  await expect(app.editor.locator("h1")).toHaveText("Note");
}

test("dragging an image's resize handle saves its width as an img tag", async ({
  app,
}) => {
  await app.page.route(PHOTO, (route) =>
    route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><rect width="200" height="100" fill="#4a90d9"/></svg>',
    }),
  );
  await openNote(app, `# Note\n\n![a photo](${PHOTO})\n\nEnd`);
  const img = app.editor.locator('img[alt="a photo"]');
  await expect(img).toHaveJSProperty("naturalWidth", 200);
  await expect(img).toHaveCSS("width", "200px");

  await img.hover();
  const handle = app.editor.locator('[data-resize-handle="right"]');
  const box = await handle.boundingBox();
  if (!box) throw new Error("resize handle not rendered");
  const { mouse } = app.page;
  await mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await mouse.down();
  await mouse.move(box.x + box.width / 2 + 100, box.y + box.height / 2, {
    steps: 5,
  });
  await mouse.up();

  await expect(img).toHaveCSS("width", "300px");
  const expected = `# Note\n\n<img src="${PHOTO}" alt="a photo" width="300">\n\nEnd`;
  await expect.poll(() => app.savedMarkdown(NOTE)).toBe(expected);
  await app.screenshot("resized-image");

  await app.reload();
  await app.open(NOTE);
  await expect(img).toHaveCSS("width", "300px");
  await expect(img).toHaveCSS("height", "150px");
  await app.resave("End");
  await expect.poll(() => app.savedMarkdown(NOTE)).toBe(expected);
});

test("a file from the slash menu becomes a card that shows its size and opens the file", async ({
  app,
}) => {
  await openNote(app, "# Note\n\nBody\n\nEnd");
  await app.pickFile("/Users/me/Documents/Q3 report.pdf");
  await app.editor.getByText("Body", { exact: true }).click();
  await expect
    .poll(async () => (await app.editorSelection()).block)
    .toBe("Body");
  await app.page.keyboard.press("End");
  await app.page.keyboard.press("Enter");
  await app.page.keyboard.type("/file");
  await app.page.keyboard.press("Enter");

  const card = app.editor.locator("[data-file-card]");
  const size = `${(await app.files())["assets/Q3 report.pdf"]?.length} B`;
  await expect(card).toContainText("Q3 report.pdf");
  await expect(card).toContainText(size);
  const expected =
    "# Note\n\nBody\n\n[Q3 report.pdf](../../assets/Q3%20report.pdf)\n\nEnd";
  await expect.poll(() => app.savedMarkdown(NOTE)).toBe(expected);
  await app.screenshot("file-card");

  await app.reload();
  await app.open(NOTE);
  await expect(card).toContainText("Q3 report.pdf");
  await expect(card).toContainText(size);
  await card.getByRole("button", { name: /Q3 report\.pdf/ }).click();
  await expect
    .poll(async () => (await app.calls("open_asset"))[0]?.args)
    .toEqual({ path: "/fake/notes/assets/Q3 report.pdf" });
  await app.resave("End");
  await expect.poll(() => app.savedMarkdown(NOTE)).toBe(expected);
});

test("files dropped from the OS become images and file cards; dropped notes are left to the backend", async ({
  app,
}) => {
  await openNote(app, "# Note\n\nBody\n\nEnd");
  const box = await app.editor.getByText("Body").boundingBox();
  if (!box) throw new Error("paragraph not rendered");

  await app.emit("tauri://drag-drop", {
    paths: [
      "/Users/me/Desktop/diagram.png",
      "/Users/me/Desktop/manual.pdf",
      "/Users/me/Desktop/Other note.md",
    ],
    position: { x: box.x + box.width - 2, y: box.y + box.height / 2 },
  });

  await expect(app.editor.locator("[data-file-card]")).toContainText(
    "manual.pdf",
  );
  await expect
    .poll(() => app.savedMarkdown(NOTE))
    .toBe(
      "# Note\n\nBody\n\n![](../../assets/diagram.png)\n\n[manual.pdf](../../assets/manual.pdf)\n\nEnd",
    );
  expect(
    (await app.calls("copy_image_to_assets")).map((c) => c.args.sourcePath),
  ).toEqual(["/Users/me/Desktop/diagram.png"]);
  expect(
    (await app.calls("copy_file_to_assets")).map((c) => c.args.sourcePath),
  ).toEqual(["/Users/me/Desktop/manual.pdf"]);
  await app.screenshot("dropped-files");
});
