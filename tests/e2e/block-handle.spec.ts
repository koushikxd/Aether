import { expect, test, type AetherApp } from "./app";
import type { Editor } from "@tiptap/core";

const IMAGE = "https://example.com/x.svg";

async function openNote(app: AetherApp, body: string) {
  await app.page.emulateMedia({ colorScheme: "light" });
  await app.page.route(IMAGE, (route) =>
    route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="80"><rect width="240" height="80" fill="#a8a29e"/></svg>',
    }),
  );
  await app.seed({ "Note.md": `# Note\n\n${body}\n` });
  await app.open("Note");
  await expect(app.editor.locator("h1")).toHaveText("Note");
}

function block(app: AetherApp, text: string) {
  return app.editor.getByText(text, { exact: true });
}

function grip(app: AetherApp) {
  return app.page.getByRole("button", { name: "Block actions" });
}

/** Opens the grip menu of the block holding `text` and picks `item`. */
async function blockMenu(app: AetherApp, text: string, ...items: string[]) {
  await block(app, text).hover();
  await grip(app).click();
  for (const name of items) {
    await app.page
      .getByRole("menuitem", { name: label(name) })
      .or(app.page.getByRole("menuitemradio", { name: label(name) }))
      .click();
  }
}

/** Matches a menu item named `name`, followed by its shortcut if it has one. */
function label(name: string) {
  return new RegExp(`^${name}( |$)`);
}

// TipTap's trailing node and table renderer add blank lines; these tests
// check block order, not spacing.
async function expectSaved(app: AetherApp, body: string) {
  await expect
    .poll(async () =>
      (await app.savedMarkdown("Note"))?.replace(/\n{3,}/g, "\n\n").trimEnd(),
    )
    .toBe(`# Note\n\n${body}`);
}

/** Drags the grip of `source` onto the top edge of `target` with the mouse. */
async function dragAbove(
  app: AetherApp,
  source: string,
  target: string,
  screenshot?: string,
) {
  await block(app, source).hover();
  const from = await grip(app).boundingBox();
  const to = await block(app, target).boundingBox();
  if (!from || !to) throw new Error("drag source or target not visible");
  const { mouse } = app.page;
  await mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await mouse.down();
  await mouse.move(from.x + from.width / 2, from.y + from.height / 2 + 8, {
    steps: 2,
  });
  await mouse.move(to.x + to.width / 2, to.y + 2, { steps: 10 });
  await expect(app.page.locator("[data-drop-indicator]")).toBeVisible();
  if (screenshot) await app.screenshot(screenshot);
  await mouse.up();
}

test("+ adds a block below and opens the slash menu there", async ({ app }) => {
  await openNote(app, "first\n\nsecond");
  await block(app, "first").hover();
  await app.page.getByRole("button", { name: "Insert block below" }).click();

  await expect(
    app.page.getByRole("button", { name: "Heading 2" }),
  ).toBeVisible();
  await app.screenshot("plus-opens-slash-menu");
  await app.page.keyboard.type("h2");
  await app.page.keyboard.press("Enter");
  await app.page.keyboard.type("new");

  await expectSaved(app, "first\n\n## new\n\nsecond");
});

test("the grip menu duplicates, moves and deletes blocks", async ({ app }) => {
  await openNote(app, "one\n\ntwo\n\nthree");

  await block(app, "three").hover();
  await grip(app).click();
  await expect(app.page.getByRole("menu")).toBeVisible();
  await app.screenshot("grip-menu");
  await app.page.getByRole("menuitem", { name: "Move up" }).click();
  await expectSaved(app, "one\n\nthree\n\ntwo");

  await blockMenu(app, "one", "Move down");
  await expectSaved(app, "three\n\none\n\ntwo");

  await blockMenu(app, "two", "Delete");
  await expectSaved(app, "three\n\none");

  await blockMenu(app, "one", "Duplicate");
  await expectSaved(app, "three\n\none\n\none");

  await block(app, "three").click();
  await expect
    .poll(async () => (await app.editorSelection()).block)
    .toBe("three");
  await app.page.keyboard.press("ControlOrMeta+d");
  await expectSaved(app, "three\n\nthree\n\none\n\none");
});

test("Turn into in the grip menu changes the block's type", async ({ app }) => {
  await openNote(
    app,
    "alpha\n\nbeta\n\n## gamma\n\ndelta\n\n- epsilon\n\nzeta\n\neta\n\ntheta",
  );

  await blockMenu(app, "alpha", "Turn into", "Heading 3");
  await blockMenu(app, "beta", "Turn into", "Bullet list");
  await blockMenu(app, "gamma", "Turn into", "Text");
  await blockMenu(app, "delta", "Turn into", "To-do list");
  await blockMenu(app, "epsilon", "Turn into", "Numbered list");
  await blockMenu(app, "zeta", "Turn into", "Heading 1");
  await blockMenu(app, "eta", "Turn into", "Callout");
  await blockMenu(app, "theta", "Turn into", "Toggle");

  await expectSaved(
    app,
    "### alpha\n\n- beta\n\ngamma\n\n- [ ] delta\n\n1. epsilon\n\n# zeta\n\n> [!note] 💡\n> eta\n\n<details><summary>theta</summary>\n\n</details>",
  );
});

test("Turn into Toggle keeps a block with inline math whole, in the body", async ({
  app,
}) => {
  await openNote(app, "Formula $x^2$\n\nafter");

  await app.editor.locator("p", { hasText: "Formula" }).hover();
  await grip(app).click();
  await app.page.getByRole("menuitem", { name: label("Turn into") }).click();
  await app.page.getByRole("menuitemradio", { name: label("Toggle") }).click();

  await expectSaved(
    app,
    "<details><summary></summary>\n\nFormula $x^2$\n\n</details>\n\nafter",
  );
  await app.screenshot("toggle-from-inline-math");
});

test("list items get their own handle", async ({ app }) => {
  await openNote(app, "- apple\n- banana\n- cherry\n\nafter");

  await blockMenu(app, "banana", "Move up");
  await expectSaved(app, "- banana\n- apple\n- cherry\n\nafter");

  await blockMenu(app, "cherry", "Duplicate");
  await expectSaved(app, "- banana\n- apple\n- cherry\n- cherry\n\nafter");

  await blockMenu(app, "apple", "Delete");
  await expectSaved(app, "- banana\n- cherry\n- cherry\n\nafter");
});

test("dragging the grip moves blocks and list items", async ({ app }) => {
  await openNote(app, "one\n\ntwo\n\nthree\n\n- apple\n- banana");

  await dragAbove(app, "three", "one", "drag-drop-indicator");
  await expectSaved(app, "three\n\none\n\ntwo\n\n- apple\n- banana");

  await dragAbove(app, "banana", "apple");
  await expectSaved(app, "three\n\none\n\ntwo\n\n- banana\n- apple");
});

/** Blocks of a note body that ends with "end". */
function blocks(...parts: string[]) {
  return [...parts, "end"].join("\n\n");
}

test("the handle works on tables, code blocks, math and images", async ({
  app,
}) => {
  const table = "| A   | B   |\n| --- | --- |\n| 1   | 2   |";
  const code = "```\ncode\n```";
  const math = "$$\nx^2\n$$";
  const image = `![](${IMAGE})`;
  await openNote(app, blocks(table, code, math, image));

  await app.editor.locator("table").hover();
  await grip(app).click();
  await app.page.getByRole("menuitem", { name: "Move down" }).click();
  await expectSaved(app, blocks(code, table, math, image));

  await app.editor.locator("pre").hover();
  await grip(app).click();
  await app.page.getByRole("menuitem", { name: "Delete" }).click();
  await expectSaved(app, blocks(table, math, image));

  await app.editor.locator(".katex").hover();
  await grip(app).click();
  await app.page.getByRole("menuitem", { name: "Duplicate" }).click();
  await expectSaved(app, blocks(table, math, math, image));

  await app.editor.locator("img").hover();
  await grip(app).click();
  await expect(
    app.page.getByRole("menuitem", { name: "Turn into" }),
  ).toHaveCount(0);
  await app.page.getByRole("menuitem", { name: "Move up" }).click();
  await expectSaved(app, blocks(table, math, image, math));
  await app.screenshot("handle-on-atoms");
});

test("the grip menu closes when the note changes under it", async ({ app }) => {
  await openNote(app, "one\n\ntwo");
  await block(app, "two").hover();
  await grip(app).click();
  await expect(app.page.getByRole("menu")).toBeVisible();

  // Stands in for a reload from disk: the block positions move
  await app.editor.evaluate((root: HTMLElement & { editor?: Editor }) => {
    const editor = root.editor;
    if (!editor) throw new Error("No editor on the page");
    const at = editor.state.doc.child(0).nodeSize;
    editor.commands.insertContentAt(at, "<p>zero</p>");
  });

  await expect(app.page.getByRole("menu")).toBeHidden();
  await expectSaved(app, "zero\n\none\n\ntwo");
});
