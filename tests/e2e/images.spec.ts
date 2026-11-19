import { expect, test, type AetherApp } from "./app";

const NOTE = "a/b/Note";

/** What mockConvertFileSrc("macos") gives for a file in the fake notes folder. */
function displayUrl(rootPath: string): string {
  return `asset://localhost/${encodeURIComponent(`/fake/notes/${rootPath}`)}`;
}

async function openNestedNote(app: AetherApp, body = "Body") {
  await app.seed({ [`${NOTE}.md`]: `# Note\n\n${body}\n` });
  await app.open(NOTE);
  await expect(app.editor).toContainText("Body");
}

async function placeCursorAfter(app: AetherApp, text: string) {
  await app.editor.getByText(text).click();
  await app.page.keyboard.press("End");
}

test("file picker image in a nested note saves a path relative to the note", async ({
  app,
}) => {
  await openNestedNote(app);
  await app.pickFile("/Users/me/Pictures/holiday photo.jpg");

  await placeCursorAfter(app, "Body");
  await app.page.keyboard.press("Enter");
  await app.page.keyboard.type("/image");
  await app.page.keyboard.press("Enter");

  const img = app.editor.locator("img");
  await expect(img).toHaveAttribute(
    "src",
    displayUrl("assets/holiday photo.jpg"),
  );
  const stored = "# Note\n\nBody\n\n![](../../assets/holiday%20photo.jpg)";
  await expect.poll(() => app.savedMarkdown(NOTE)).toContain(stored);
  expect(await app.file("assets/holiday photo.jpg")).toBe(
    "copied from /Users/me/Pictures/holiday photo.jpg",
  );

  await app.page.keyboard.press("ControlOrMeta+Shift+C");
  await app.page.getByRole("menuitem", { name: "Copy Markdown" }).click();
  await expect
    .poll(async () => (await app.calls("copy_to_clipboard")).pop()?.args.text)
    .toContain(stored);

  await app.reload();
  await app.open(NOTE);
  await expect(app.editor.locator("img")).toHaveAttribute(
    "src",
    displayUrl("assets/holiday photo.jpg"),
  );
  await app.screenshot("picked-image-after-reload");
});

test("pasted image keeps its type and saves a relative path", async ({
  app,
}) => {
  await openNestedNote(app);
  await placeCursorAfter(app, "Body");

  await app.editor.evaluate((editor) => {
    const jpeg = new Uint8Array([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46,
    ]);
    const data = new DataTransfer();
    data.items.add(new File([jpeg], "image.jpg", { type: "image/jpeg" }));
    editor.dispatchEvent(
      new ClipboardEvent("paste", {
        clipboardData: data,
        bubbles: true,
        cancelable: true,
      }),
    );
  });

  await expect.poll(() => app.calls("save_clipboard_image")).toHaveLength(1);
  const assets = Object.keys(await app.files()).filter((p) =>
    p.startsWith("assets/"),
  );
  expect(assets).toEqual([
    expect.stringMatching(/^assets\/screenshot-\d+\.jpg$/),
  ]);
  await expect(app.editor.locator("img")).toHaveAttribute(
    "src",
    displayUrl(assets[0]),
  );
  await expect
    .poll(() => app.savedMarkdown(NOTE))
    .toContain(`![](../../${assets[0]})`);
  await app.screenshot("pasted-image");
});

test("legacy asset URLs inside the notes folder are rewritten as relative paths on the next save", async ({
  app,
}) => {
  const legacy = displayUrl("assets/old shot.png");
  const outside = `asset://localhost/${encodeURIComponent("/Users/other/pic.png")}`;
  const remote = "https://example.com/remote.png";
  await app.page.route(remote, (route) => route.abort());
  await openNestedNote(
    app,
    `![](${legacy})\n\n![](${outside})\n\n![](${remote})\n\nBody`,
  );
  const images = app.editor.locator("img");
  await expect(images.first()).toHaveAttribute("src", legacy);
  // Let every image finish (or fail) loading so the click below lands on text.
  for (const img of await images.all()) {
    await expect(img).toHaveJSProperty("complete", true);
  }

  await placeCursorAfter(app, "Body");
  await app.page.keyboard.type(" edited");

  await expect
    .poll(() => app.savedMarkdown(NOTE))
    .toBe(
      `# Note\n\n![](../../assets/old%20shot.png)\n\n![](${outside})\n\n![](${remote})\n\nBody edited`,
    );
  const saved = await app.savedMarkdown(NOTE);

  await app.page.keyboard.press("ControlOrMeta+p");
  await app.page
    .getByPlaceholder("Search notes or type a command")
    .fill("Export Markdown");
  await app.page.keyboard.press("Enter");
  await expect.poll(() => app.calls("write_file")).toHaveLength(1);
  const [exported] = await app.calls("write_file");
  const bytes = exported.args.contents;
  if (!Array.isArray(bytes)) throw new Error("write_file contents not bytes");
  expect(new TextDecoder().decode(new Uint8Array(bytes))).toBe(saved);
  await app.screenshot("legacy-urls-rewritten");
});

test("an <img> inside a line of text survives load and save with the text around it", async ({
  app,
}) => {
  const line = 'Before <img src="../../assets/x.png" width="40"> after';
  await app.seed({
    [`${NOTE}.md`]: `# Note\n\n${line}\n\nEnd\n`,
    "assets/x.png": "png",
  });
  await app.open(NOTE);
  await expect(app.editor.locator("img")).toHaveAttribute(
    "src",
    displayUrl("assets/x.png"),
  );
  await expect(app.editor.locator("p").first()).toContainText("Before");
  await expect(app.editor.locator("p").first()).toContainText("after");
  await app.screenshot("inline-img");

  await app.resave("End");
  await expect
    .poll(() => app.savedMarkdown(NOTE))
    .toBe(`# Note\n\n${line}\n\nEnd`);
});
