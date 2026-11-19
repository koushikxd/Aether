import { expect, test } from "./app";

test("highlight, underline and text color from the toolbar save as inline HTML and round-trip", async ({
  app,
}) => {
  await app.page.emulateMedia({ colorScheme: "light" });
  await app.seed({ "Note.md": "# Note\n\nalpha beta gamma delta" });
  await app.open("Note");
  await expect(app.editor.locator("h1")).toHaveText("Note");
  const toolbar = app.page.getByRole("toolbar", { name: "Formatting" });
  const color = async (name: string) => {
    await toolbar.getByRole("button", { name: "Text color" }).click();
    await app.page.getByRole("menuitem", { name }).click();
  };

  await app.select("alpha");
  await toolbar.getByRole("button", { name: /^Highlight/ }).click();
  await app.select("beta");
  await color("Red");
  await app.select("gamma");
  await toolbar.getByRole("button", { name: /^Underline/ }).click();
  await app.select("delta");
  await color("Blue");
  await app.select("delta");
  await color("Default");

  const expected =
    '# Note\n\n<mark>alpha</mark> <span style="color: #d44c47">beta</span> <u>gamma</u> delta';
  await expect.poll(() => app.savedMarkdown("Note")).toBe(expected);
  await app.select("beta");
  await app.screenshot("marks");

  await app.reload();
  await app.open("Note");
  await expect(app.editor.locator("mark")).toHaveText("alpha");
  await expect(app.editor.locator("span[style]")).toHaveText("beta");
  await expect(app.editor.locator("span[style]")).toHaveCSS(
    "color",
    "rgb(212, 76, 71)",
  );
  await expect(app.editor.locator("u")).toHaveText("gamma");
  await app.resave("alpha beta gamma delta");
  await expect.poll(() => app.savedMarkdown("Note")).toBe(expected);
});

test("marks nest with other inline formatting and parse back unchanged", async ({
  app,
}) => {
  const markdown =
    '# Note\n\n**<mark>bold mark</mark>** <span style="color: #337ea9">*blue italic*</span> <mark>with <u>under</u></mark>\n\nEnd';
  await app.seed({ "Note.md": markdown });
  await app.open("Note");
  await expect(app.editor.locator("strong mark, mark strong")).toHaveText(
    "bold mark",
  );
  await expect(app.editor.locator("span[style] em, em span[style]")).toHaveText(
    "blue italic",
  );
  await expect(app.editor.locator("mark u, u mark")).toHaveText("under");

  await app.resave("End");
  await expect.poll(() => app.savedMarkdown("Note")).toBe(markdown);
});
