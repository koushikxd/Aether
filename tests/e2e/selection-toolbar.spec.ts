import { expect, test, type AetherApp } from "./app";

async function openNote(app: AetherApp, body: string) {
  await app.page.emulateMedia({ colorScheme: "light" });
  await app.seed({ "Note.md": `# Note\n\n${body}\n` });
  await app.open("Note");
  await expect(app.editor.locator("h1")).toHaveText("Note");
}

test("selecting text shows the toolbar, and its marks save as markdown", async ({
  app,
}) => {
  await openNote(
    app,
    "alpha beta gamma delta epsilon zeta\n\n![](assets/x.png)\n\nafter\n\n```\ncode here\n```",
  );
  const toolbar = app.page.getByRole("toolbar", { name: "Formatting" });
  const button = (name: string) =>
    toolbar.getByRole("button", { name: new RegExp(`^${name}`) });
  await expect(toolbar).toBeHidden();

  await app.select("alpha");
  await expect(toolbar).toBeVisible();
  await button("Bold").click();
  await app.select("beta");
  await button("Italic").click();
  await app.select("gamma");
  await button("Strikethrough").click();
  await app.select("delta");
  await button("Inline code").click();
  await app.select("zeta");
  await button("Underline").click();
  await app.select("epsilon");
  await button("Link").click();
  await app.page.getByPlaceholder("Enter URL...").fill("example.com");
  await app.page.keyboard.press("Enter");

  await expect
    .poll(async () => (await app.savedMarkdown("Note"))?.trimEnd())
    .toBe(
      "# Note\n\n**alpha** *beta* ~~gamma~~ `delta` [epsilon](https://example.com) <u>zeta</u>\n\n![](assets/x.png)\n\nafter\n\n```\ncode here\n```",
    );

  await app.select("alpha");
  await expect(button("Bold")).toHaveAttribute("aria-pressed", "true");
  await expect(button("Italic")).toHaveAttribute("aria-pressed", "false");
  await expect(toolbar.getByRole("button", { name: "Turn into" })).toHaveText(
    "Text",
  );
  await app.screenshot("selection-toolbar");

  await app.select("here");
  await expect(toolbar).toBeHidden();

  // ArrowLeft from the start of "after" selects the image node.
  await app.editor.getByText("after").click({ position: { x: 0, y: 4 } });
  await expect
    .poll(async () => (await app.editorSelection()).block)
    .toBe("after");
  await app.page.keyboard.press("ArrowLeft");
  await expect(
    app.editor.locator('[data-node="image"].ProseMirror-selectednode'),
  ).toHaveCount(1);
  await expect(toolbar).toBeHidden();
});

test("Turn into in the toolbar changes the selected block's type", async ({
  app,
}) => {
  await openNote(app, "first\n\nsecond\n\nthird\n\nfourth\n\nfifth\n\nsixth");
  const toolbar = app.page.getByRole("toolbar", { name: "Formatting" });
  const turnInto = async (word: string, type: string) => {
    await app.select(word);
    await toolbar.getByRole("button", { name: "Turn into" }).click();
    await app.page.getByRole("menuitemradio", { name: type }).click();
  };

  await turnInto("first", "Heading 2");
  await turnInto("second", "Numbered list");
  await turnInto("third", "Quote");
  await turnInto("fourth", "Code");
  await turnInto("fifth", "Callout");
  await turnInto("sixth", "Toggle");

  await expect
    .poll(async () => (await app.savedMarkdown("Note"))?.trimEnd())
    .toBe(
      "# Note\n\n## first\n\n1. second\n\n> third\n\n```\nfourth\n```\n\n> [!note] 💡\n> fifth\n\n<details><summary>sixth</summary>\n\n</details>",
    );

  await app.select("first");
  const trigger = toolbar.getByRole("button", { name: "Turn into" });
  await expect(trigger).toHaveText("Heading 2");
  await trigger.click();
  await expect(
    app.page.getByRole("menuitemradio", { name: "Heading 2" }),
  ).toHaveAttribute("aria-checked", "true");
  await app.screenshot("selection-toolbar-turn-into");
});

test("submitting a relative note link unchanged keeps it relative", async ({
  app,
}) => {
  await app.seed({
    "a/Note.md": "# Note\n\nSee [Child](../Child.md) here\n\nEnd\n",
    "Child.md": "# Child\n",
  });
  await app.open("a/Note");
  await expect(app.editor.locator("h1")).toHaveText("Note");

  await app.select("Child");
  await app.page
    .getByRole("toolbar", { name: "Formatting" })
    .getByRole("button", { name: /^Link/ })
    .click();
  const url = app.page.getByPlaceholder("Enter URL...");
  await expect(url).toHaveValue("../Child.md");
  await url.press("Enter");
  await app.resave("End");

  await expect
    .poll(() => app.savedMarkdown("a/Note"))
    .toBe("# Note\n\nSee [Child](../Child.md) here\n\nEnd");
});
