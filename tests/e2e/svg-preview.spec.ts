import { expect, test, type AetherApp } from "./app";

const NOTE = "a/b/Note";

const RED_SQUARE =
  '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120"><rect width="120" height="120" fill="red"/></svg>';

function noteWith(svg: string) {
  return `# Note\n\nBody\n\n\`\`\`svg\n${svg}\n\`\`\`\n\nEnd`;
}

async function openNote(app: AetherApp, markdown: string) {
  await app.page.emulateMedia({ colorScheme: "light" });
  await app.seed({ [`${NOTE}.md`]: markdown });
  await app.open(NOTE);
  await expect(app.editor.locator("h1")).toHaveText("Note");
}

function preview(app: AetherApp) {
  return app.editor.getByRole("img", { name: "SVG preview" });
}

// In preview mode the source stays in the DOM for TipTap, but inside a hidden
// wrapper, so a <pre> directly under the block means the source is showing.
function source(app: AetherApp) {
  return app.editor.locator(".code-block-wrapper > pre");
}

async function expectLoaded(app: AetherApp) {
  await expect(preview(app)).toBeVisible();
  await expect
    .poll(() =>
      preview(app).evaluate((img: HTMLImageElement) => img.naturalWidth),
    )
    .toBeGreaterThan(0);
}

test("svg block shows an image preview instead of its source", async ({
  app,
}) => {
  await openNote(app, noteWith(RED_SQUARE));
  await expectLoaded(app);
  await expect(source(app)).toHaveCount(0);
  await app.screenshot("svg-preview");
});

test("Edit shows the source and Preview shows the edited image", async ({
  app,
}) => {
  await openNote(app, noteWith(RED_SQUARE));
  await expectLoaded(app);

  await app.editor.getByRole("button", { name: "Edit" }).click();
  await expect(preview(app)).toHaveCount(0);
  await expect(source(app)).toBeVisible();

  await app.select("red");
  await app.page.keyboard.type("blue");
  await app.editor.getByRole("button", { name: "Preview" }).click();

  await expectLoaded(app);
  const src = await preview(app).getAttribute("src");
  expect(decodeURIComponent(src ?? "")).toContain('fill="blue"');
  await expect
    .poll(() => app.savedMarkdown(NOTE))
    .toBe(noteWith(RED_SQUARE.replace("red", "blue")));
});

test("scripts and event handlers in an svg do not run", async ({ app }) => {
  const hostile =
    '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" onload="window.svgRan = true"><script>window.svgRan = true</script><image href="missing.png" onerror="window.svgRan = true"/><circle cx="20" cy="20" r="20"/></svg>';
  await openNote(app, noteWith(hostile));
  await expectLoaded(app);
  expect(
    await app.page.evaluate(
      () => (window as Window & { svgRan?: boolean }).svgRan,
    ),
  ).toBeUndefined();
});

test("invalid svg shows an error in place of the image", async ({ app }) => {
  await openNote(app, noteWith("<svg><rect"));
  await expect(app.editor.getByText("Invalid SVG")).toBeVisible();
  await expect(preview(app)).toHaveCount(0);
});

test("previewing leaves the saved markdown unchanged", async ({ app }) => {
  const markdown = noteWith(RED_SQUARE);
  await openNote(app, markdown);
  await expectLoaded(app);
  await app.resave("End");
  await expect.poll(() => app.savedMarkdown(NOTE)).toBe(markdown);
});

test("an empty svg block opens in source mode", async ({ app }) => {
  await openNote(app, "# Note\n\nBody\n\n```svg\n```\n\nEnd");
  await expect(source(app)).toBeVisible();
  await expect(preview(app)).toHaveCount(0);
  await expect(
    app.editor.getByRole("button", { name: "Preview" }),
  ).toBeVisible();
});

test("switching notes opens each svg block in its own default mode", async ({
  app,
}) => {
  await app.seed({
    "Filled.md": `# Filled\n\n\`\`\`svg\n${RED_SQUARE}\n\`\`\`\n`,
    "Empty.md": "# Empty\n\n```svg\n```\n",
  });
  await app.open("Filled");
  await expectLoaded(app);

  await app.open("Empty");
  await expect(app.editor.locator("h1")).toHaveText("Empty");
  await expect(source(app)).toBeVisible();
  await expect(preview(app)).toHaveCount(0);

  await app.open("Filled");
  await expect(app.editor.locator("h1")).toHaveText("Filled");
  await expectLoaded(app);
  await expect(source(app)).toHaveCount(0);
});
