import { expect, test } from "./app";

const family = (el: Element) => getComputedStyle(el).fontFamily;

test("UI and editor text render in Geist, code in Geist Mono", async ({
  app,
}) => {
  await app.seed({
    "Welcome.md": "# Welcome\n\nReadable text with `some code`.\n",
  });
  await app.sidebar.getByText("Welcome").click();
  await expect(app.editor).toContainText("Readable text");

  expect(await app.sidebar.getByText("Welcome").evaluate(family)).toMatch(
    /^"Geist Variable"/,
  );
  expect(await app.editor.locator("p").evaluate(family)).toMatch(
    /^"Geist Variable"/,
  );
  expect(await app.editor.locator("code").evaluate(family)).toMatch(
    /^"Geist Mono Variable"/,
  );

  // A missing font file falls back to the next family without any error
  const loaded = await app.page.evaluate(async () => {
    await document.fonts.ready;
    return [...document.fonts]
      .filter((f) => f.status === "loaded")
      .map((f) => f.family);
  });
  expect(loaded).toEqual(
    expect.arrayContaining(["Geist Variable", "Geist Mono Variable"]),
  );

  await app.screenshot("fonts");
});
