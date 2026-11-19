import { expect, test, type AetherApp } from "./app";

const NOTE = "a/b/Note";

async function openNote(app: AetherApp, markdown: string) {
  await app.page.emulateMedia({ colorScheme: "light" });
  await app.seed({ [`${NOTE}.md`]: markdown });
  await app.open(NOTE);
  await expect(app.editor.locator("h1")).toHaveText("Note");
}

/** Opens a new block under "Body" with the slash menu entry `query`. */
async function slash(app: AetherApp, query: string) {
  await app.editor.getByText("Body", { exact: true }).click();
  await expect
    .poll(async () => (await app.editorSelection()).block)
    .toBe("Body");
  await app.page.keyboard.press("End");
  await app.page.keyboard.press("Enter");
  await app.page.keyboard.type(`/${query}`);
  await app.page.keyboard.press("Enter");
}

/** Reloads the app on the saved files and opens the note again. */
async function reopen(app: AetherApp) {
  await app.reload();
  await app.open(NOTE);
  await expect(app.editor.locator("h1")).toHaveText("Note");
}

test("callout from the slash menu holds blocks, changes its icon, and round-trips", async ({
  app,
}) => {
  await openNote(app, "# Note\n\nBody\n\nEnd");
  await slash(app, "callout");
  await app.page.keyboard.type("Inside callout");
  await app.page.keyboard.press("Enter");
  await app.page.keyboard.type("- item");

  const expected =
    "# Note\n\nBody\n\n> [!note] 💡\n> Inside callout\n>\n> - item\n\nEnd";
  await expect.poll(() => app.savedMarkdown(NOTE)).toBe(expected);

  const callout = app.editor.locator("[data-callout]");
  await callout.getByRole("button", { name: "Change icon" }).click();
  await app.page.getByRole("menuitem", { name: "⚠️" }).click();
  const withIcon = expected.replace("💡", "⚠️");
  await expect.poll(() => app.savedMarkdown(NOTE)).toBe(withIcon);
  await app.screenshot("callout");

  await reopen(app);
  await expect(callout.getByRole("button", { name: "Change icon" })).toHaveText(
    "⚠️",
  );
  await expect(callout.locator("p").first()).toHaveText("Inside callout");
  await expect(callout.locator("li")).toHaveText("item");
  await app.resave("End");
  await expect.poll(() => app.savedMarkdown(NOTE)).toBe(withIcon);
});

test("toggle from the slash menu opens, closes, and round-trips", async ({
  app,
}) => {
  await openNote(app, "# Note\n\nBody\n\nEnd");
  await slash(app, "toggle");
  await app.page.keyboard.type("Title");

  const toggle = app.editor.locator('[data-type="details"]');
  const body = toggle.locator('[data-type="detailsContent"]');
  await expect(body).toBeHidden();
  await toggle.getByRole("button", { name: "Expand details content" }).click();
  await expect(body).toBeVisible();
  await body.locator("p").click();
  await app.page.keyboard.type("Hidden body");

  const expected =
    "# Note\n\nBody\n\n<details><summary>Title</summary>\n\nHidden body\n\n</details>\n\nEnd";
  await expect.poll(() => app.savedMarkdown(NOTE)).toBe(expected);
  await app.screenshot("toggle-open");

  await reopen(app);
  await expect(toggle.locator("summary")).toHaveText("Title");
  await expect(body).toBeHidden();
  await app.screenshot("toggle-closed");
  await toggle.getByRole("button", { name: "Expand details content" }).click();
  await expect(body).toHaveText("Hidden body");
  await app.resave("End");
  await expect.poll(() => app.savedMarkdown(NOTE)).toBe(expected);
});

test("hand-written callouts, quotes, toggles, marks, images and files save unchanged", async ({
  app,
}) => {
  const markdown = [
    "# Note",
    "> [!note] 💡\n> Callout with **bold**\n>\n> <details><summary>Inner toggle</summary>\n>\n> Toggle body\n>\n> </details>",
    "> Plain quote",
    "> [!warning]\n> Careful",
    "> [!tip]- Folded title\n> Tip body",
    "<details><summary>Outer</summary>\n\n<details><summary>Nested &lt;b&gt;</summary>\n\nDeep body\n\n</details>\n\n</details>",
    '<mark>marked</mark> <u>under</u> <span style="color: #448361">green</span>',
    '<img src="../../assets/x.png" alt="pic" width="320">',
    "![plain](../../assets/y.png)",
    "[report.pdf](../../assets/report.pdf)",
    "[inline link](../../assets/report.pdf) in a sentence",
    "End",
  ].join("\n\n");
  await openNote(app, markdown);

  const callouts = app.editor.locator("[data-callout]");
  await expect(callouts).toHaveCount(3);
  await expect(callouts.nth(0).locator('[data-type="details"]')).toHaveCount(1);
  await expect(app.editor.locator("blockquote")).toHaveText("Plain quote");
  await expect(app.editor.locator("summary")).toHaveText([
    "Inner toggle",
    "Outer",
    "Nested <b>",
  ]);
  await expect(app.editor.locator("mark")).toHaveText("marked");
  await expect(app.editor.locator("u")).toHaveText("under");
  await expect(app.editor.locator('span[style*="color"]')).toHaveText("green");
  await expect(app.editor.locator('img[alt="pic"]')).toHaveCSS(
    "width",
    "320px",
  );
  await expect(app.editor.locator("[data-file-card]")).toHaveCount(1);
  await expect(
    app.editor.getByRole("link", { name: "inline link" }),
  ).toHaveCount(1);
  await app.screenshot("hand-written-blocks");

  await app.page.emulateMedia({ media: "print" });
  await expect(
    callouts.first().getByRole("button", { name: "Change icon" }),
  ).toBeVisible();
  await expect(app.editor.locator("[data-file-card] button")).toBeVisible();
  await app.screenshot("hand-written-blocks-print");
  await app.page.emulateMedia({ media: "screen" });

  await app.resave("End");
  await expect.poll(() => app.savedMarkdown(NOTE)).toBe(markdown);
});

test("hand-written toggles keep their summary HTML, open attribute and entities", async ({
  app,
}) => {
  const markdown = [
    "# Note",
    "<details><summary><b>Click</b> me</summary>\n\nFirst body\n\n</details>",
    "<details open><summary>Open one</summary>\n\nSecond body\n\n</details>",
    "<details><summary>Fish&nbsp;&amp;&nbsp;chips</summary>\n\nThird body\n\n</details>",
    "End",
  ].join("\n\n");
  await openNote(app, markdown);
  const summaries = app.editor.locator("summary");
  await expect(summaries).toHaveText(["Click me", "Open one", "Fish & chips"]);
  await app.screenshot("hand-written-toggles");

  await app.resave("End");
  await expect.poll(() => app.savedMarkdown(NOTE)).toBe(markdown);

  await summaries.first().click();
  await app.page.keyboard.press("End");
  await app.page.keyboard.type("!");
  await expect
    .poll(() => app.savedMarkdown(NOTE))
    .toBe(markdown.replace("<b>Click</b> me", "Click me!"));
});

test("hand-written Obsidian callouts keep their titles, and a picked icon goes before the title", async ({
  app,
}) => {
  const markdown = [
    "# Note",
    "> [!warning] Read before deploying\n> Check the config",
    "> [!tip]- 🔥 Hot take\n> Tip body",
    "> [!info] ℹ️\n> Info body",
    "> [!note]\n> No title",
    "End",
  ].join("\n\n");
  await openNote(app, markdown);
  const callouts = app.editor.locator("[data-callout]");
  const icon = (n: number) =>
    callouts.nth(n).getByRole("button", { name: "Change icon" });
  await expect(callouts.nth(0)).toContainText("Read before deploying");
  await expect(icon(0)).not.toContainText("Read before deploying");
  await expect(icon(1)).toHaveText("🔥");
  await expect(callouts.nth(1)).toContainText("Hot take");
  await expect(icon(2)).toHaveText("ℹ️");
  await app.screenshot("hand-written-callouts");

  await app.resave("End");
  await expect.poll(() => app.savedMarkdown(NOTE)).toBe(markdown);

  await icon(0).click();
  await app.page.getByRole("menuitem", { name: "⚠️" }).click();
  await expect(callouts.nth(0)).toContainText("Read before deploying");
  await expect
    .poll(() => app.savedMarkdown(NOTE))
    .toBe(markdown.replace("[!warning] Read", "[!warning] ⚠️ Read"));
});

test("a callout keeps lazy continuation lines in its paragraph, as a quote does", async ({
  app,
}) => {
  await openNote(
    app,
    "# Note\n\n> Quote\nlazy quote\n\n> [!note] 💡\n> Callout\nlazy callout\n\nEnd",
  );
  await expect(app.editor.locator("blockquote p")).toHaveText(
    "Quote lazy quote",
  );
  await expect(app.editor.locator("[data-callout] p")).toHaveText(
    "Callout lazy callout",
  );

  await app.resave("End");
  await expect
    .poll(() => app.savedMarkdown(NOTE))
    .toBe(
      "# Note\n\n> Quote\n> lazy quote\n\n> [!note] 💡\n> Callout\n> lazy callout\n\nEnd",
    );
});

test("raw HTML in a note cannot make a file card", async ({ app }) => {
  await openNote(
    app,
    '# Note\n\n<div data-file-card data-href="asset://localhost/%2FApplications%2FCalculator.app" data-name="Calculator"></div>\n\n[report.pdf](../../assets/report.pdf)\n\nEnd',
  );
  const cards = app.editor.locator("[data-file-card]");
  await expect(cards).toHaveCount(1);
  await expect(cards).toHaveText("report.pdf");
  await app.screenshot("raw-html-file-card");
});

test("a code block holding a fence keeps its longer fence on save", async ({
  app,
}) => {
  const markdown = "# Note\n\n````md\n```js\nconst a = 1;\n```\n````\n\nEnd";
  await openNote(app, markdown);
  await expect(app.editor.locator("pre")).toHaveCount(1);

  await app.resave("End");
  await expect.poll(() => app.savedMarkdown(NOTE)).toBe(markdown);

  await reopen(app);
  await expect(app.editor.locator("pre")).toHaveCount(1);
  await expect(app.editor.locator("pre")).toHaveText(
    "```js\nconst a = 1;\n```",
  );
  await app.screenshot("code-block-with-fence");
});
