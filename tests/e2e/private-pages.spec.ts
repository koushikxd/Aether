import { expect, test, type AetherApp } from "./app";
import type { FakeVaultSeed } from "./fake-vault";

const KEY = "aether-key-c2VjcmV0LWtleS1mb3ItdGVzdHMtb25seS0xMjM0NTY3";

/** Gives the fake notes folder a vault; call before `app.seed`. */
async function seedVault(app: AetherApp, vault: FakeVaultSeed) {
  await app.page.addInitScript((seed) => {
    window.aetherFakeVault = seed;
  }, vault);
}

function lockIcon(app: AetherApp, row: string) {
  return app.row(row).locator("[data-private-icon]");
}

async function openSettings(app: AetherApp) {
  await app.page.getByRole("button", { name: /^Settings/ }).click();
}

test("the Notion hint says which export to pick before the file picker opens", async ({
  app,
}) => {
  await app.seed({ "Plan.md": "# Plan\n" });
  await openSettings(app);

  await expect(app.page.getByText(/^In Notion, export as HTML/)).toHaveText(
    "In Notion, export as HTML with Include subpages and Create folders for subpages turned on. Then pick every .zip file it gives you.",
  );
  expect(await app.calls("plugin:dialog|open")).toEqual([]);
  await app.screenshot("notion-hint");
});

test("Select private pages: search, parent cascade, and Make private sends the top-most pages", async ({
  app,
}) => {
  await seedVault(app, { key: KEY, unlocked: true });
  await app.seed({ "Plan.md": "# Plan\n" });
  await openSettings(app);
  await app.pickFile(["/Users/me/Downloads/Export.zip"]);
  await app.page.getByRole("button", { name: "Import from Notion" }).click();
  const dialog = app.page.getByRole("alertdialog");
  await dialog.getByRole("button", { name: "Import", exact: true }).click();
  await expect.poll(() => app.calls("import_notion")).toHaveLength(1);
  await app.page.evaluate(() =>
    window.aetherFake?.finishNotionImport?.(
      {
        "Projects.md": "# Projects\n",
        "Projects/Alpha.md": "# Alpha\n",
        "Projects/Alpha/Specs.md": "# Specs\n",
        "Projects/Beta.md": "# Beta\n",
        "Journal.md": "# Journal\n",
        "Journal/Monday.md": "# Monday\n",
      },
      {
        ids: [
          "Projects",
          "Projects/Alpha",
          "Projects/Alpha/Specs",
          "Projects/Beta",
          "Journal",
          "Journal/Monday",
        ],
        pages: 6,
        images: 0,
        files: 0,
        skipped: [],
      },
    ),
  );
  await dialog.getByRole("button", { name: "Select private pages" }).click();

  const box = (name: string) => dialog.getByRole("checkbox", { name });
  await expect(box("Projects")).not.toBeChecked();
  await expect(box("Journal")).not.toBeChecked();
  await expect(box("Alpha")).toBeHidden();

  const search = dialog.getByPlaceholder("Search pages");
  await search.fill("spec");
  await expect(box("Specs")).toBeVisible();
  await expect(box("Alpha")).toBeVisible();
  await expect(box("Projects")).toBeVisible();
  await expect(box("Beta")).toBeHidden();
  await expect(box("Journal")).toBeHidden();
  await box("Specs").check();
  await search.fill("");

  await dialog.getByRole("button", { name: "Expand Projects" }).click();
  await dialog.getByRole("button", { name: "Expand Journal" }).click();
  await box("Monday").check();
  await box("Projects").check();
  for (const name of ["Alpha", "Beta"]) {
    await expect(box(name)).toBeChecked();
    await expect(box(name)).toBeDisabled();
  }
  await expect(box("Journal")).not.toBeChecked();
  await expect(box("Journal")).toBeEnabled();
  await app.screenshot("private-page-picker");

  await dialog.getByRole("button", { name: "Make 5 pages private" }).click();
  await expect.poll(() => app.calls("vault_set_private")).toHaveLength(1);
  const [{ args }] = await app.calls("vault_set_private");
  expect(args.isPrivate).toBe(true);
  expect(args.ids).toEqual(
    expect.arrayContaining(["Projects", "Journal/Monday"]),
  );
  expect(args.ids).toHaveLength(2);
  await expect(dialog).toBeHidden();
});

test("sidebar: lock icons, Make private, Make public only on roots with a confirmation", async ({
  app,
}) => {
  await seedVault(app, { key: KEY, unlocked: true, privateRoots: ["Finance"] });
  await app.seed({
    "Finance.md": "# Finance\n",
    "Finance/Bank.md": "# Bank\n",
    "Ideas.md": "# Ideas\n",
  });
  await expect(lockIcon(app, "Finance")).toBeVisible();
  await expect(lockIcon(app, "Bank")).toBeVisible();
  await expect(lockIcon(app, "Ideas")).toHaveCount(0);

  await app.row("Bank").click({ button: "right" });
  const inherited = app.page.getByRole("menuitem", { name: /Make public/ });
  await expect(inherited).toHaveAttribute("aria-disabled", "true");
  await expect(inherited).toContainText("Finance is private");
  await app.page.keyboard.press("Escape");

  await app.row("Ideas").click({ button: "right" });
  await app.page.getByRole("menuitem", { name: "Make private" }).click();
  await expect(lockIcon(app, "Ideas")).toBeVisible();

  await app.row("Finance").click({ button: "right" });
  await app.page.getByRole("menuitem", { name: "Make public" }).click();
  const confirm = app.page.getByRole("alertdialog");
  await expect(confirm).toContainText(
    "Its contents will be pushed to GitHub unencrypted on the next commit.",
  );
  await app.screenshot("make-public-confirm");
  await confirm.getByRole("button", { name: "Cancel" }).click();
  await expect(lockIcon(app, "Finance")).toBeVisible();

  await app.row("Finance").click({ button: "right" });
  await app.page.getByRole("menuitem", { name: "Make public" }).click();
  await confirm.getByRole("button", { name: "Make public" }).click();
  await expect(lockIcon(app, "Finance")).toHaveCount(0);
  await expect(lockIcon(app, "Bank")).toHaveCount(0);
  expect(
    (await app.calls("vault_set_private")).map((call) => call.args),
  ).toEqual([
    { ids: ["Ideas"], isPrivate: true },
    { ids: ["Finance"], isPrivate: false },
  ]);
});

test("Make private without a key generates one first, then marks the page", async ({
  app,
}) => {
  await app.seed({ "Ideas.md": "# Ideas\n" });
  const ideas = app.sidebar.getByText("Ideas", { exact: true });
  await ideas.click({ button: "right" });
  await app.page.getByRole("menuitem", { name: "Make private" }).click();

  const dialog = app.page.getByRole("alertdialog");
  await dialog.getByRole("button", { name: "Generate key" }).click();
  await expect(dialog.locator("[data-vault-key]")).toHaveText(/^aether-key-/);
  expect(await app.calls("vault_set_private")).toEqual([]);
  await dialog.getByLabel("I saved this key somewhere safe").check();
  await app.screenshot("inline-generate-key");
  await dialog.getByRole("button", { name: "Done" }).click();

  await expect.poll(() => app.calls("vault_set_private")).toHaveLength(1);
  expect((await app.calls("vault_set_private"))[0].args).toEqual({
    ids: ["Ideas"],
    isPrivate: true,
  });
  await expect(app.sidebar.locator("[data-private-icon]")).toHaveCount(1);
});

test("settings card: Done waits for the saved-key checkbox, then Show key shows it", async ({
  app,
}) => {
  await app.seed({ "Plan.md": "# Plan\n" });
  await openSettings(app);
  const card = app.page.locator("section", {
    has: app.page.getByRole("heading", { name: "Private Pages" }),
  });
  await card.getByRole("button", { name: "Generate key" }).click();

  const dialog = app.page.getByRole("alertdialog");
  const key = dialog.locator("[data-vault-key]");
  await expect(key).toHaveText(/^aether-key-/);
  const generated = (await key.textContent()) ?? "";
  await expect(dialog).toContainText(
    "Store this key somewhere safe, like a password manager. Without it, private pages cannot be opened on another device or recovered.",
  );
  await dialog.getByRole("button", { name: "Copy" }).click();
  await expect
    .poll(() => app.calls("copy_to_clipboard"))
    .toEqual([{ cmd: "copy_to_clipboard", args: { text: generated } }]);

  const done = dialog.getByRole("button", { name: "Done" });
  await expect(done).toBeDisabled();
  await app.screenshot("generate-key-unconfirmed");
  await dialog.getByLabel("I saved this key somewhere safe").check();
  await done.click();
  await expect(dialog).toBeHidden();

  await expect(card.getByRole("button", { name: "Generate key" })).toHaveCount(
    0,
  );
  await card.getByRole("button", { name: "Show key" }).click();
  await expect(dialog.locator("[data-vault-key]")).toHaveText(generated);
});

test("a sync that brings another device's private pages shows the locked banner", async ({
  app,
}) => {
  await seedVault(app, {
    key: KEY,
    unlocked: false,
    arrivesOnPull: true,
    lockedFiles: { "Finance.md": "# Finance\n" },
  });
  await app.seed({ "Ideas.md": "# Ideas\n" });

  const banner = app.sidebar
    .getByRole("status")
    .filter({ hasText: "Private pages locked" });
  const sync = app.page.getByRole("button", { name: "Sync" });
  await expect(sync).toBeVisible();
  await expect(banner).toHaveCount(0);
  await sync.click();
  await expect(banner).toBeVisible();
  await app.screenshot("locked-banner-after-sync");
});

test("a locked device shows one banner, and entering the key unlocks the pages", async ({
  app,
}) => {
  await seedVault(app, {
    key: KEY,
    unlocked: false,
    lockedFiles: {
      "Finance.md": "# Finance\n",
      "Finance/Bank.md": "# Bank\n",
    },
  });
  await app.seed({ "Ideas.md": "# Ideas\n" });

  const banner = app.sidebar
    .getByRole("status")
    .filter({ hasText: "Private pages locked" });
  await expect(banner).toBeVisible();
  await expect(app.row("Finance")).toHaveCount(0);
  await app.screenshot("locked-banner");
  await banner.getByRole("button", { name: "Enter key" }).click();

  const dialog = app.page.getByRole("alertdialog");
  await dialog.getByLabel("Key").fill("aether-key-wrong");
  await dialog.getByRole("button", { name: "Unlock" }).click();
  await expect(dialog.getByRole("alert")).toHaveText(
    "That key does not match this folder's private pages",
  );

  await dialog.getByLabel("Key").fill(KEY);
  await dialog.getByRole("button", { name: "Unlock" }).click();
  await expect(dialog).toBeHidden();
  await expect(banner).toHaveCount(0);
  await expect(app.row("Finance")).toBeVisible();
  await expect(app.row("Bank")).toBeVisible();
});

test("Export Workspace asks whether to include private pages, off by default", async ({
  app,
}) => {
  await seedVault(app, { key: KEY, unlocked: true, privateRoots: ["Finance"] });
  await app.seed({ "Finance.md": "# Finance\n", "Ideas.md": "# Ideas\n" });
  await openSettings(app);

  const exportButton = app.page.getByRole("button", {
    name: "Export Workspace",
  });
  const dialog = app.page.getByRole("alertdialog");
  const include = dialog.getByLabel("Include private pages (unencrypted)");

  await exportButton.click();
  await expect(include).not.toBeChecked();
  await app.screenshot("export-workspace-dialog");
  await dialog.getByRole("button", { name: "Export", exact: true }).click();
  await expect(dialog).toBeHidden();

  await exportButton.click();
  await include.check();
  await dialog.getByRole("button", { name: "Export", exact: true }).click();

  await expect.poll(() => app.calls("export_folder_zip")).toHaveLength(2);
  expect(
    (await app.calls("export_folder_zip")).map((call) => call.args),
  ).toEqual([
    { folder: "", includePrivate: false, dest: "/Users/me/Desktop/notes.zip" },
    { folder: "", includePrivate: true, dest: "/Users/me/Desktop/notes.zip" },
  ]);
});
