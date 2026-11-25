import { expect, test, type AetherApp } from "./app";

const PAGE = "# Page\n\nBody\n";
const FROM_CLI = "# Page\n\nBody\n\nAdded by the CLI\n";

async function openPage(app: AetherApp) {
  await app.seed({ "Page.md": PAGE });
  await app.row("Page").click();
  await expect(app.editor.locator("h1")).toHaveText("Page");
}

/** Types at the end of Body and lets the CLI write the page before the autosave fires. */
async function typeThenWriteExternally(app: AetherApp) {
  await app.editor.getByText("Body", { exact: true }).click();
  await expect
    .poll(async () => (await app.editorSelection()).block)
    .toBe("Body");
  await app.page.keyboard.press("End");
  await app.page.keyboard.type(" mine");
  await app.writeExternally("Page.md", FROM_CLI);
  await expect(app.page.getByRole("button", { name: "Refresh" })).toBeVisible();
}

test("an external change to the open note with no pending edits reloads it in place", async ({
  app,
}) => {
  await openPage(app);
  await app.editor.getByText("Body", { exact: true }).click();
  await expect
    .poll(async () => (await app.editorSelection()).block)
    .toBe("Body");

  await app.writeExternally("Page.md", FROM_CLI);

  await expect(app.editor).toContainText("Added by the CLI");
  await expect(app.page.getByRole("button", { name: "Refresh" })).toHaveCount(
    0,
  );
  expect((await app.editorSelection()).block).toBe("Body");
  expect(await app.calls("save_note")).toEqual([]);
  await app.screenshot("external-change-reloaded");
});

test("with pending edits, Refresh shows and autosave does not overwrite the external change", async ({
  app,
}) => {
  await openPage(app);
  await typeThenWriteExternally(app);
  await app.screenshot("external-change-pending-edits");

  // Longer than the 500 ms autosave
  await app.page.waitForTimeout(1000);
  expect(await app.calls("save_note")).toEqual([]);
  expect(await app.file("Page.md")).toBe(FROM_CLI);

  await app.page.getByRole("button", { name: "Refresh" }).click();
  await expect(app.editor).toContainText("Added by the CLI");
  await expect(app.editor).not.toContainText("mine");
  await app.page.waitForTimeout(1000);
  expect(await app.calls("save_note")).toEqual([]);
});

test("with pending edits, Overwrite saves the editor over the external change", async ({
  app,
}) => {
  await openPage(app);
  await typeThenWriteExternally(app);

  await app.page.getByRole("button", { name: "Overwrite" }).click();

  await expect.poll(() => app.file("Page.md")).toBe("# Page\n\nBody mine");
  await expect(app.page.getByRole("button", { name: "Refresh" })).toHaveCount(
    0,
  );
  await expect(app.editor).not.toContainText("Added by the CLI");
});

test("in source mode, an external change with no pending edits reloads the source text", async ({
  app,
}) => {
  await openPage(app);
  await app.page.evaluate(() =>
    window.dispatchEvent(new Event("toggle-source-mode")),
  );
  const source = app.page.locator("textarea");
  await expect(source).toHaveValue(/Body/);

  await app.writeExternally("Page.md", FROM_CLI);

  await expect(source).toHaveValue(/Added by the CLI/);
  await expect(app.page.getByRole("button", { name: "Refresh" })).toHaveCount(
    0,
  );
});

test("in source mode, Refresh right after typing drops the draft instead of saving it later", async ({
  app,
}) => {
  await app.page.clock.install();
  await openPage(app);
  await app.page.evaluate(() =>
    window.dispatchEvent(new Event("toggle-source-mode")),
  );
  const source = app.page.locator("textarea");
  await expect(source).toHaveValue(/Body/);

  // Freeze time so the 300 ms source autosave is still pending at Refresh
  await app.page.clock.pauseAt(
    await app.page.evaluate(() => Date.now() + 1000),
  );
  await source.press("End");
  await source.pressSequentially(" mine");
  await app.writeExternally("Page.md", FROM_CLI);
  await app.page.getByRole("button", { name: "Refresh" }).click();
  await expect(source).toHaveValue(/Added by the CLI/);

  await app.page.clock.runFor(1000);
  expect(await app.calls("save_note")).toEqual([]);
  expect(await app.file("Page.md")).toBe(FROM_CLI);
  await app.screenshot("external-change-source-refresh");
});

test("pins the CLI writes to the settings file show in the sidebar", async ({
  app,
}) => {
  const settings = ".aether/settings.json";
  await app.seed({
    "A.md": "# A\n",
    "B.md": "# B\n",
    [settings]: JSON.stringify({ pinnedNoteIds: ["A"] }),
  });
  const pinned = app.sidebar.getByRole("region", { name: "Pinned" });
  await expect(
    pinned.getByRole("button", { name: "A", exact: true }),
  ).toBeVisible();

  // The backend reports a settings file another program wrote
  await app.page.evaluate(async (path) => {
    const fake = window.aetherFake;
    if (!fake) throw new Error("Fake backend missing");
    fake.files[path] = JSON.stringify({ pinnedNoteIds: ["B"] });
    await fake.emit("settings-changed", null);
  }, settings);

  await expect(
    pinned.getByRole("button", { name: "B", exact: true }),
  ).toBeVisible();
  await expect(
    pinned.getByRole("button", { name: "A", exact: true }),
  ).toHaveCount(0);
});
