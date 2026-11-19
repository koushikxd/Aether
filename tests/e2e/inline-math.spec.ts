import { expect, test, type AetherApp } from "./app";

const inlineMath = (app: AetherApp) =>
  app.editor.locator('[data-type="inline-math"]');

async function openNote(app: AetherApp, markdown: string) {
  await app.seed({ "Note.md": markdown });
  await app.open("Note");
  await expect(app.editor.locator("h1")).toHaveText("Note");
}

test("inline math renders with KaTeX and saves unchanged", async ({ app }) => {
  const markdown = "# Note\n\nBefore $a^2 + b^2 = c^2$ after\n\nEnd";
  await openNote(app, markdown);

  await expect(inlineMath(app)).toHaveAttribute(
    "data-latex",
    "a^2 + b^2 = c^2",
  );
  await expect(inlineMath(app).locator(".katex")).toBeVisible();
  await expect(app.editor.getByText("$")).toHaveCount(0);
  await app.screenshot("inline-math");

  await app.resave("End");
  await expect.poll(() => app.savedMarkdown("Note")).toBe(markdown);
});

test("dollar amounts, escaped dollars and code stay plain text", async ({
  app,
}) => {
  const markdown = [
    "# Note",
    "costs $5 and $10, or $5-$10",
    "literal \\$x\\$ and \\$5",
    "code `$x$` here",
    "```\n$x$\n```",
    "End",
  ].join("\n\n");
  await openNote(app, markdown);

  await expect(app.editor).toContainText("costs $5 and $10, or $5-$10");
  await expect(app.editor).toContainText("literal $x$ and $5");
  await expect(app.editor.locator("code").first()).toHaveText("$x$");
  await expect(inlineMath(app)).toHaveCount(0);

  await app.resave("End");
  await expect.poll(() => app.savedMarkdown("Note")).toBe(markdown);
});

test("the slash menu inserts inline math", async ({ app }) => {
  await openNote(app, "# Note\n\nBody\n");
  await app.editor.getByText("Body").click();
  await app.page.keyboard.press("End");
  await app.page.keyboard.press("Enter");
  await app.page.keyboard.type("/inline");
  await app.page.keyboard.press("Enter");
  await app.page.getByPlaceholder("Enter KaTeX expression...").fill("x^2");
  await app.page.keyboard.press("ControlOrMeta+Enter");

  await expect(inlineMath(app).locator(".katex")).toBeVisible();
  await expect
    .poll(() => app.savedMarkdown("Note"))
    .toMatch(/^# Note\n\nBody\n\n\$x\^2\$\n*$/);
  await app.screenshot("slash-inline-math");
});

test("clicking inline math edits its formula", async ({ app }) => {
  await openNote(app, "# Note\n\nBefore $a^2$ after\n\nEnd");

  // Playwright's own click point for KaTeX's inline wrapper falls above the
  // glyphs, onto the paragraph, so click the middle of its box like a user.
  const box = await inlineMath(app).boundingBox();
  if (!box) throw new Error("inline math is not visible");
  await app.page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  const input = app.page.getByPlaceholder("Enter KaTeX expression...");
  await expect(input).toHaveValue("a^2");
  await input.fill("b^3");
  await app.page.keyboard.press("ControlOrMeta+Enter");

  await expect(inlineMath(app)).toHaveAttribute("data-latex", "b^3");
  await expect
    .poll(() => app.savedMarkdown("Note"))
    .toBe("# Note\n\nBefore $b^3$ after\n\nEnd");
});
