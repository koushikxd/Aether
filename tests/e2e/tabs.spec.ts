import { expect, test, type AetherApp } from "./app";

const NOTES = {
  "Alpha.md": "# Alpha\n\nAlpha body.\n",
  "Beta.md": "# Beta\n\nBeta body.\n",
  "Gamma.md": "# Gamma\n\nGamma body.\n",
};

function strip(app: AetherApp) {
  return app.page.getByRole("tablist", { name: "Open notes" });
}

function tab(app: AetherApp, name: string) {
  return strip(app).getByRole("tab", { name, exact: true });
}

function menu(app: AetherApp) {
  return app.page.locator("[data-command-menu]");
}

/** Tab titles in strip order, and which one is active. */
async function expectTabs(app: AetherApp, names: string[], active: string) {
  await expect(strip(app).getByRole("tab")).toHaveText(names);
  await expect(tab(app, active)).toHaveAttribute("aria-selected", "true");
  await expect(app.editor).toContainText(`${active} body.`);
}

async function openFromSidebar(app: AetherApp, name: string) {
  await app.row(name).click();
  await expect(app.editor).toContainText(`${name} body.`);
}

async function newTabFromSidebar(app: AetherApp, name: string) {
  await app.row(name).click({ modifiers: ["ControlOrMeta"] });
  await expect(app.editor).toContainText(`${name} body.`);
}

/** Cmd+T, then pick a note from the Search Notes list by typing its title. */
async function newTabFromPalette(app: AetherApp, name: string) {
  await app.page.keyboard.press("ControlOrMeta+t");
  const input = menu(app).getByRole("textbox");
  await expect(input).toBeFocused();
  await input.fill(name);
  await expect(menu(app).getByRole("button").first()).toContainText(name);
  await app.page.keyboard.press("Enter");
  await expect(menu(app)).toBeHidden();
  await expect(app.editor).toContainText(`${name} body.`);
}

test.describe("tab state", () => {
  test("a plain open replaces the note in the active tab", async ({ app }) => {
    await app.seed(NOTES);
    await openFromSidebar(app, "Alpha");
    await expectTabs(app, ["Alpha"], "Alpha");
    await openFromSidebar(app, "Beta");
    await expectTabs(app, ["Beta"], "Beta");
  });

  test("Cmd+T lists recent notes and opens the pick in a new tab; Esc opens nothing", async ({
    app,
  }) => {
    await app.seed(NOTES);
    await openFromSidebar(app, "Alpha");
    await openFromSidebar(app, "Beta");

    await app.page.keyboard.press("ControlOrMeta+t");
    await expect(menu(app).getByRole("textbox")).toBeFocused();
    await expect(menu(app).getByRole("button")).toHaveText([/Beta/, /Alpha/]);
    await app.screenshot("cmd-t-recent-notes");
    await app.page.keyboard.press("Escape");
    await expect(menu(app)).toBeHidden();
    await expectTabs(app, ["Beta"], "Beta");

    await newTabFromPalette(app, "Gamma");
    await expectTabs(app, ["Beta", "Gamma"], "Gamma");
  });

  test("opening a note that has a tab focuses that tab", async ({ app }) => {
    await app.seed(NOTES);
    await openFromSidebar(app, "Alpha");
    await newTabFromPalette(app, "Beta");
    await openFromSidebar(app, "Alpha");
    await expectTabs(app, ["Alpha", "Beta"], "Alpha");
    await newTabFromPalette(app, "Beta");
    await expectTabs(app, ["Alpha", "Beta"], "Beta");
  });

  test("back and forward follow the active tab's own history", async ({
    app,
  }) => {
    await app.seed(NOTES);
    await openFromSidebar(app, "Alpha");
    await openFromSidebar(app, "Beta");
    await newTabFromPalette(app, "Gamma");

    // The new tab has nowhere to go back to
    await app.page.keyboard.press("ControlOrMeta+BracketLeft");
    await expectTabs(app, ["Beta", "Gamma"], "Gamma");

    await tab(app, "Beta").click();
    await app.page.keyboard.press("ControlOrMeta+BracketLeft");
    await expectTabs(app, ["Alpha", "Gamma"], "Alpha");
    await app.page.keyboard.press("ControlOrMeta+BracketRight");
    await expectTabs(app, ["Beta", "Gamma"], "Beta");
  });

  test("tabs and the active tab survive a reload", async ({ app }) => {
    await app.seed(NOTES);
    await openFromSidebar(app, "Alpha");
    await newTabFromPalette(app, "Beta");
    await newTabFromPalette(app, "Gamma");
    await tab(app, "Beta").click();
    await expect(app.editor).toContainText("Beta body.");

    await app.reload();
    await expectTabs(app, ["Alpha", "Beta", "Gamma"], "Beta");
  });

  test("a deleted note closes its tab and a renamed note keeps its tab", async ({
    app,
  }) => {
    await app.seed(NOTES);
    await openFromSidebar(app, "Alpha");
    await newTabFromPalette(app, "Beta");
    await newTabFromPalette(app, "Gamma");

    await app.row("Beta").click({ button: "right" });
    await app.page.getByRole("menuitem", { name: "Delete" }).click();
    await app.page
      .getByRole("alertdialog")
      .getByRole("button", { name: "Delete" })
      .click();
    await expectTabs(app, ["Alpha", "Gamma"], "Gamma");

    await app.editor.locator("h1").click();
    await app.page.keyboard.press("End");
    await app.page.keyboard.type(" Two");
    await expect.poll(() => app.file("Gamma Two.md")).toContain("Gamma body.");
    await expect(strip(app).getByRole("tab")).toHaveText([
      "Alpha",
      "Gamma Two",
    ]);
    await tab(app, "Alpha").click();
    await tab(app, "Gamma Two").click();
    await expect(app.editor).toContainText("Gamma body.");
    await app.screenshot("tabs-after-delete-and-rename");
  });

  test("a moved page's tab follows it", async ({ app }) => {
    await app.seed({
      ...NOTES,
      "Box.md": "# Box\n",
      "Box/Inside.md": "# Inside\n\nInside body.\n",
    });
    await openFromSidebar(app, "Alpha");
    await newTabFromPalette(app, "Beta");
    // The list refresh the watcher starts must not drop the inactive tab
    await app.page.evaluate(() => {
      if (window.aetherFake) window.aetherFake.moveLag = 200;
    });
    await app.drag("Alpha", "Box");
    await expect.poll(() => app.file("Box/Alpha.md")).toBeDefined();
    // A key, not a click: dnd-kit swallows clicks for 50ms after a drag
    await app.page.keyboard.press("ControlOrMeta+1");
    await expectTabs(app, ["Alpha", "Beta"], "Alpha");
  });

  test("switching tabs restores the scroll position", async ({ app }) => {
    const long = Array.from({ length: 150 }, (_, i) => `Line ${i}`).join(
      "\n\n",
    );
    await app.seed({
      ...NOTES,
      "Long.md": `# Long\n\nLong body.\n\n${long}\n`,
    });
    await openFromSidebar(app, "Long");
    const scroller = app.page.locator("[data-editor-scroll]");
    await expect(app.editor).toContainText("Line 149");
    await scroller.evaluate((el) => el.scrollTo(0, 1500));
    await newTabFromPalette(app, "Alpha");
    await tab(app, "Long").click();
    await expect(app.editor).toContainText("Long body.");
    await expect
      .poll(() => scroller.evaluate((el) => Math.round(el.scrollTop)))
      .toBe(1500);
  });

  test("leaving a tab before its note loads keeps its saved scroll", async ({
    app,
  }) => {
    const long = Array.from({ length: 150 }, (_, i) => `Line ${i}`).join(
      "\n\n",
    );
    await app.seed({
      ...NOTES,
      "Long.md": `# Long\n\nLong body.\n\n${long}\n`,
    });
    await openFromSidebar(app, "Long");
    const scroller = app.page.locator("[data-editor-scroll]");
    await expect(app.editor).toContainText("Line 149");
    await scroller.evaluate((el) => el.scrollTo(0, 1500));
    await newTabFromPalette(app, "Alpha");
    await newTabFromPalette(app, "Beta");
    await tab(app, "Alpha").click();
    await expect(app.editor).toContainText("Alpha body.");

    // Long's note is still loading when Beta takes over
    await app.hold("read_note");
    await tab(app, "Long").click();
    await tab(app, "Beta").click();
    await app.release("read_note");
    await expect(app.editor).toContainText("Beta body.");

    await tab(app, "Long").click();
    await expect(app.editor).toContainText("Long body.");
    await expect
      .poll(() => scroller.evaluate((el) => Math.round(el.scrollTop)))
      .toBe(1500);
  });

  test("opening a tab's note from the sidebar restores its scroll", async ({
    app,
  }) => {
    const long = Array.from({ length: 150 }, (_, i) => `Line ${i}`).join(
      "\n\n",
    );
    await app.seed({
      ...NOTES,
      "Long.md": `# Long\n\nLong body.\n\n${long}\n`,
    });
    await openFromSidebar(app, "Long");
    const scroller = app.page.locator("[data-editor-scroll]");
    await expect(app.editor).toContainText("Line 149");
    await scroller.evaluate((el) => el.scrollTo(0, 1500));
    await newTabFromPalette(app, "Alpha");
    await openFromSidebar(app, "Long");
    await expectTabs(app, ["Long", "Alpha"], "Long");
    await expect(app.editor).toContainText("Long body.");
    await expect
      .poll(() => scroller.evaluate((el) => Math.round(el.scrollTop)))
      .toBe(1500);
  });
});

test.describe("tab strip", () => {
  test("close activates the right neighbor, then the left; the last tab has no close button", async ({
    app,
  }) => {
    await app.seed(NOTES);
    await openFromSidebar(app, "Alpha");
    await newTabFromPalette(app, "Beta");
    await newTabFromPalette(app, "Gamma");
    await tab(app, "Beta").click();

    await strip(app).getByRole("button", { name: "Close Beta" }).click();
    await expectTabs(app, ["Alpha", "Gamma"], "Gamma");
    await strip(app).getByRole("button", { name: "Close Gamma" }).click();
    await expectTabs(app, ["Alpha"], "Alpha");
    await expect(
      strip(app).getByRole("button", { name: /^Close/ }),
    ).toHaveCount(0);
  });

  test("tabs reorder by drag", async ({ app }) => {
    await app.seed(NOTES);
    await openFromSidebar(app, "Alpha");
    await newTabFromPalette(app, "Beta");
    await newTabFromPalette(app, "Gamma");

    const from = await tab(app, "Gamma").boundingBox();
    const to = await tab(app, "Alpha").boundingBox();
    if (!from || !to) throw new Error("tabs are not visible");
    const { mouse } = app.page;
    await mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await mouse.down();
    await mouse.move(from.x + from.width / 2 - 10, from.y + from.height / 2, {
      steps: 3,
    });
    await mouse.move(to.x + 5, to.y + to.height / 2, { steps: 10 });
    await mouse.up();
    await expect(strip(app).getByRole("tab")).toHaveText([
      "Gamma",
      "Alpha",
      "Beta",
    ]);
    await app.reload();
    await expect(strip(app).getByRole("tab")).toHaveText([
      "Gamma",
      "Alpha",
      "Beta",
    ]);
  });

  test("many tabs shrink, then scroll, with the sidebar open and closed", async ({
    app,
  }) => {
    const names = Array.from({ length: 12 }, (_, i) => `Note ${i + 1}`);
    await app.seed(
      Object.fromEntries(
        names.map((n) => [`${n}.md`, `# ${n}\n\n${n} body.\n`]),
      ),
    );
    await openFromSidebar(app, names[0]);
    for (const name of names.slice(1)) await newTabFromPalette(app, name);
    await expect(strip(app).getByRole("tab")).toHaveCount(12);
    await expect(tab(app, "Note 12")).toBeInViewport();
    await app.screenshot("many-tabs-sidebar-open");
    await app.page.keyboard.press("ControlOrMeta+Backslash");
    await expect(app.sidebar).toHaveCSS("opacity", "0");
    await app.screenshot("many-tabs-sidebar-closed");
    const box = await tab(app, "Note 1").boundingBox();
    expect(box?.width).toBeGreaterThanOrEqual(99);
  });
});

test.describe("tab shortcuts", () => {
  test("Cmd+1..8 go to that tab and Cmd+9 to the last", async ({ app }) => {
    await app.seed(NOTES);
    await openFromSidebar(app, "Alpha");
    await newTabFromPalette(app, "Beta");
    await newTabFromPalette(app, "Gamma");

    await app.page.keyboard.press("ControlOrMeta+1");
    await expectTabs(app, ["Alpha", "Beta", "Gamma"], "Alpha");
    await app.page.keyboard.press("ControlOrMeta+2");
    await expectTabs(app, ["Alpha", "Beta", "Gamma"], "Beta");
    await app.page.keyboard.press("ControlOrMeta+9");
    await expectTabs(app, ["Alpha", "Beta", "Gamma"], "Gamma");
    // No fifth tab: nothing happens
    await app.page.keyboard.press("ControlOrMeta+5");
    await expectTabs(app, ["Alpha", "Beta", "Gamma"], "Gamma");
  });

  test("with the command menu open, Cmd+1 runs its row instead", async ({
    app,
  }) => {
    await app.seed(NOTES);
    await openFromSidebar(app, "Alpha");
    await newTabFromPalette(app, "Beta");
    await app.page.keyboard.press("ControlOrMeta+Shift+o");
    await expect(menu(app).getByRole("textbox")).toBeFocused();
    await app.page.keyboard.press("ControlOrMeta+1");
    await expect(menu(app)).toBeHidden();
    await expectTabs(app, ["Alpha", "Beta"], "Beta");
  });

  test("Ctrl+Tab and Ctrl+Shift+Tab cycle tabs, wrapping", async ({ app }) => {
    await app.seed(NOTES);
    await openFromSidebar(app, "Alpha");
    await newTabFromPalette(app, "Beta");
    await newTabFromPalette(app, "Gamma");

    await app.page.keyboard.press("Control+Tab");
    await expectTabs(app, ["Alpha", "Beta", "Gamma"], "Alpha");
    await app.page.keyboard.press("Control+Shift+Tab");
    await expectTabs(app, ["Alpha", "Beta", "Gamma"], "Gamma");
    await app.page.keyboard.press("Control+Shift+Tab");
    await expectTabs(app, ["Alpha", "Beta", "Gamma"], "Beta");
  });

  test("Cmd+W closes the tab, Cmd+Shift+T reopens it, and the last Cmd+W closes the window", async ({
    app,
  }) => {
    await app.seed(NOTES);
    await openFromSidebar(app, "Alpha");
    await newTabFromPalette(app, "Beta");
    await newTabFromPalette(app, "Gamma");
    await tab(app, "Beta").click();

    await app.page.keyboard.press("ControlOrMeta+w");
    await expectTabs(app, ["Alpha", "Gamma"], "Gamma");
    await app.page.keyboard.press("ControlOrMeta+Shift+t");
    await expectTabs(app, ["Alpha", "Beta", "Gamma"], "Beta");
    expect(await app.calls("plugin:window|close")).toHaveLength(0);

    await app.page.keyboard.press("ControlOrMeta+w");
    await app.page.keyboard.press("ControlOrMeta+w");
    await expectTabs(app, ["Alpha"], "Alpha");
    expect(await app.calls("plugin:window|close")).toHaveLength(0);
    await app.page.keyboard.press("ControlOrMeta+w");
    await expect.poll(() => app.calls("plugin:window|close")).toHaveLength(1);
    await expectTabs(app, ["Alpha"], "Alpha");
  });
});

test.describe("opening in a new tab", () => {
  test("Cmd+Enter on a command menu note opens it in a new tab", async ({
    app,
  }) => {
    await app.seed(NOTES);
    await openFromSidebar(app, "Alpha");
    await app.page.keyboard.press("ControlOrMeta+k");
    await menu(app).getByRole("textbox").fill("Gamma");
    await expect(menu(app).getByRole("button").first()).toContainText("Gamma");
    await app.page.keyboard.press("ControlOrMeta+Enter");
    await expectTabs(app, ["Alpha", "Gamma"], "Gamma");
  });

  test("Cmd+click on a sidebar row opens it in a new tab", async ({ app }) => {
    await app.seed(NOTES);
    await openFromSidebar(app, "Alpha");
    await newTabFromSidebar(app, "Beta");
    await expectTabs(app, ["Alpha", "Beta"], "Beta");
  });

  test("Cmd+click on a note link or wikilink opens it in a new tab", async ({
    app,
  }) => {
    await app.seed({
      ...NOTES,
      "Index.md": "# Index\n\nIndex body. [To Beta](Beta.md) and [[Gamma]]\n",
    });
    await openFromSidebar(app, "Index");
    await app.editor
      .getByRole("link", { name: "To Beta" })
      .click({ modifiers: ["ControlOrMeta"] });
    await expectTabs(app, ["Index", "Beta"], "Beta");
    await tab(app, "Index").click();
    await app.editor
      .locator("[data-wikilink]")
      .click({ modifiers: ["ControlOrMeta"] });
    await expectTabs(app, ["Index", "Gamma", "Beta"], "Gamma");
    // A plain click on a link to a note with a tab focuses that tab
    await tab(app, "Index").click();
    await app.editor.getByRole("link", { name: "To Beta" }).click();
    await expectTabs(app, ["Index", "Gamma", "Beta"], "Beta");
  });

  test("Duplicate in the command menu shows the copy during a move", async ({
    app,
  }) => {
    await app.seed({
      ...NOTES,
      "Box.md": "# Box\n",
      "Box/Inside.md": "# Inside\n\nInside body.\n",
    });
    await openFromSidebar(app, "Alpha");
    await app.hold("move_note");
    await app.drag("Gamma", "Box");
    await app.page.keyboard.press("ControlOrMeta+k");
    await menu(app).getByRole("textbox").fill("Duplicate Current Note");
    await app.page.keyboard.press("Enter");
    await expect(strip(app).getByRole("tab")).toHaveCount(2);
    await expect(strip(app).getByRole("tab").nth(1)).toHaveAttribute(
      "aria-selected",
      "true",
    );
    // The copy's title, not the original's
    await expect(app.editor.locator("h1")).not.toHaveText("Alpha");
    await app.release("move_note");
  });

  test("Cmd+N, Cmd+Shift+N, and Duplicate open their note in a new tab", async ({
    app,
  }) => {
    await app.seed(NOTES);
    await openFromSidebar(app, "Alpha");

    await app.page.keyboard.press("ControlOrMeta+n");
    await expect(strip(app).getByRole("tab")).toHaveText(["Alpha", "Untitled"]);
    await tab(app, "Alpha").click();
    await expect(app.editor).toContainText("Alpha body.");

    await app.page.keyboard.press("ControlOrMeta+Shift+n");
    await expect.poll(() => app.file("Alpha/Untitled.md")).toBeDefined();
    await expect(strip(app).getByRole("tab")).toHaveCount(3);
    await expect(strip(app).getByRole("tab").nth(1)).toHaveAttribute(
      "aria-selected",
      "true",
    );

    await tab(app, "Alpha").click();
    await expect(app.editor).toContainText("Alpha body.");
    await app.row("Alpha").focus();
    await app.page.keyboard.press("ControlOrMeta+d");
    await expect(strip(app).getByRole("tab")).toHaveCount(4);
    await expect(strip(app).getByRole("tab").nth(1)).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(app.editor).toContainText("Alpha body.");
    await app.screenshot("created-notes-in-new-tabs");
  });

  test("the /Sub-page command links the sub-page and opens it in a new tab", async ({
    app,
  }) => {
    await app.seed(NOTES);
    await openFromSidebar(app, "Alpha");
    await app.editor.getByText("Alpha body.").click();
    await app.page.keyboard.press("End");
    await app.page.keyboard.press("Enter");
    await app.page.keyboard.type("/sub-page");
    await app.page.keyboard.press("Enter");
    await expect.poll(() => app.file("Alpha/Untitled.md")).toBeDefined();
    await expect(strip(app).getByRole("tab")).toHaveText(["Alpha", "Untitled"]);
    await expect(tab(app, "Untitled")).toHaveAttribute("aria-selected", "true");
    await tab(app, "Alpha").click();
    await expect(
      app.editor.getByRole("link", { name: "Untitled" }),
    ).toBeVisible();
  });
});
