import type { ConflictFile } from "../../src/services/git";
import { expect, test, type AetherApp } from "./app";
import type { FakeConflicts } from "./fake-merge";

const CONTEXT = Array.from({ length: 12 }, (_, i) => `Step ${i + 1}\n`).join(
  "",
);

const PLAN: ConflictFile = {
  path: "Work/Plan.md",
  isPrivate: false,
  pickOnly: false,
  oursDeleted: false,
  theirsDeleted: false,
  chunks: [
    { kind: "same", text: "# Plan\n\n" },
    {
      kind: "conflict",
      ours: "Ship on Monday.\n",
      theirs: "Ship on Friday.\n",
    },
    { kind: "same", text: `\n${CONTEXT}\n` },
    { kind: "conflict", ours: "- Owner: me\n", theirs: "- Owner: Sam\n" },
  ],
};

const BANK: ConflictFile = {
  path: "Finance/Bank.md",
  isPrivate: true,
  pickOnly: false,
  oursDeleted: false,
  theirsDeleted: false,
  chunks: [
    { kind: "same", text: "# Bank\n\n" },
    { kind: "conflict", ours: "Balance: 100\n", theirs: "Balance: 120\n" },
  ],
};

const PHOTO: ConflictFile = {
  path: "assets/photo.png",
  isPrivate: false,
  pickOnly: true,
  oursDeleted: false,
  theirsDeleted: false,
  chunks: [],
};

const OLD_IDEA: ConflictFile = {
  path: "Old idea.md",
  isPrivate: false,
  pickOnly: true,
  oursDeleted: true,
  theirsDeleted: false,
  chunks: [],
};

async function seedConflicts(app: AetherApp, conflicts: FakeConflicts) {
  await app.page.addInitScript((seed) => {
    window.aetherFakeConflicts = seed;
  }, conflicts);
  await app.seed({ "Work/Plan.md": "# Plan\n", "Finance/Bank.md": "# Bank\n" });
}

async function syncIntoEditor(app: AetherApp) {
  await app.page.getByRole("button", { name: "Sync" }).click();
  const editor = mergeEditor(app);
  await expect(editor).toBeVisible();
  return editor;
}

function mergeEditor(app: AetherApp) {
  return app.page.getByRole("alertdialog", { name: "Resolve conflicts" });
}

/** The git commands that change the repo, in call order. */
async function mergeSteps(app: AetherApp): Promise<string[]> {
  const steps = new Set([
    "git_pull",
    "git_resolve_conflict",
    "git_finish_merge",
    "git_abort_merge",
    "git_push",
  ]);
  return (await app.calls()).map((c) => c.cmd).filter((cmd) => steps.has(cmd));
}

test("a sync whose pull conflicts opens the merge editor with every conflicting note", async ({
  app,
}) => {
  await seedConflicts(app, { files: [PLAN, BANK] });
  const editor = await syncIntoEditor(app);

  const list = editor.getByRole("list", { name: "Conflicting notes" });
  const items = list.getByRole("button");
  await expect(items).toHaveCount(2);
  await expect(items.nth(0)).toContainText("Plan");
  await expect(items.nth(0)).not.toContainText("Private");
  await expect(items.nth(1)).toContainText("Bank");
  await expect(items.nth(1)).toContainText("Private");

  const first = editor.getByRole("group", { name: "Conflict 1" });
  await expect(first).toContainText("This device");
  await expect(first).toContainText("Ship on Monday.");
  await expect(first).toContainText("Other device");
  await expect(first).toContainText("Ship on Friday.");
  // The 14-line context between the conflicts is collapsed to its ends
  const changes = editor.getByRole("region", { name: "Changes" });
  await expect(changes).toContainText("Step 2");
  await expect(changes).toContainText("Step 11");
  await expect(changes).not.toContainText("Step 6");
  await changes.getByRole("button", { name: "Show 8 more lines" }).click();
  await expect(changes).toContainText("Step 6");

  // The conflict is not also reported as a sync error
  await expect(app.page.getByText(/Merge conflict/)).toHaveCount(0);
  await expect(app.page.getByText("An error occurred")).toHaveCount(0);
  await app.screenshot("merge-editor-open");
});

test("picks fill the result, an edit is kept, and Finish merge resolves, commits and pushes", async ({
  app,
}) => {
  await seedConflicts(app, { files: [PLAN, BANK] });
  const editor = await syncIntoEditor(app);
  const finish = editor.getByRole("button", { name: "Finish merge" });
  const save = editor.getByRole("button", { name: "Save" });
  const result = editor.getByLabel("Result");
  await expect(finish).toBeDisabled();
  await expect(save).toBeDisabled();
  await expect(result).toHaveValue(`# Plan\n\n\n${CONTEXT}\n`);

  const conflict = (n: number) =>
    editor.getByRole("group", { name: `Conflict ${n}` });
  await conflict(1).getByRole("button", { name: "This device" }).click();
  await conflict(2).getByRole("button", { name: "Both" }).click();
  const plan = `# Plan\n\nShip on Monday.\n\n${CONTEXT}\n- Owner: me\n- Owner: Sam\n`;
  await expect(result).toHaveValue(plan);
  await conflict(1).getByRole("button", { name: "Other device" }).click();
  const planTheirs = plan.replace("Monday", "Friday");
  await expect(result).toHaveValue(planTheirs);
  await save.click();

  // Saving moves on to the next note
  const items = editor
    .getByRole("list", { name: "Conflicting notes" })
    .getByRole("button");
  await expect(items.nth(0)).toContainText("Resolved");
  await expect(result).toHaveValue("# Bank\n\n");
  await conflict(1).getByRole("button", { name: "Other device" }).click();
  await expect(result).toHaveValue("# Bank\n\nBalance: 120\n");
  await result.fill("# Bank\n\nBalance: 125\n");

  // Changing a pick after an edit asks first
  await conflict(1).getByRole("button", { name: "This device" }).click();
  const confirm = app.page.getByRole("alertdialog", {
    name: "Replace your edits?",
  });
  await confirm.getByRole("button", { name: "Keep my edits" }).click();
  await expect(confirm).toBeHidden();
  await expect(result).toHaveValue("# Bank\n\nBalance: 125\n");
  await save.click();
  await expect(items.nth(1)).toContainText("Resolved");
  await expect(finish).toBeEnabled();

  await items.nth(0).click();
  await expect(result).toHaveValue(planTheirs);
  await app.screenshot("merge-editor-resolved");

  await finish.click();
  await expect(mergeEditor(app)).toBeHidden();
  await expect
    .poll(() => mergeSteps(app))
    .toEqual([
      "git_pull",
      "git_resolve_conflict",
      "git_resolve_conflict",
      "git_finish_merge",
      "git_push",
    ]);
  expect((await app.calls("git_resolve_conflict")).map((c) => c.args)).toEqual([
    {
      path: "Work/Plan.md",
      resolution: { kind: "text", content: planTheirs },
    },
    {
      path: "Finance/Bank.md",
      resolution: { kind: "text", content: "# Bank\n\nBalance: 125\n" },
    },
  ]);
  await expect(app.page.getByText("Merged and pushed")).toBeVisible();
});

test("a file that can only keep one side offers both versions, deleted or not", async ({
  app,
}) => {
  await seedConflicts(app, { files: [PHOTO, OLD_IDEA] });
  const editor = await syncIntoEditor(app);
  const items = editor
    .getByRole("list", { name: "Conflicting notes" })
    .getByRole("button");

  await expect(editor).toContainText("Changed on this device");
  await expect(editor).toContainText("Changed on the other device");
  await expect(editor.getByLabel("Result")).toHaveCount(0);
  await editor
    .getByRole("button", { name: /Keep other device's version/ })
    .click();
  await expect(items.nth(0)).toContainText("Resolved");

  await items.nth(1).click();
  await expect(editor).toContainText("Deleted on this device");
  await expect(editor).toContainText("Changed on the other device");
  await editor
    .getByRole("button", { name: /Keep this device's version/ })
    .click();
  await expect(items.nth(1)).toContainText("Resolved");
  await app.screenshot("merge-editor-pick-only");

  await editor.getByRole("button", { name: "Finish merge" }).click();
  await expect(mergeEditor(app)).toBeHidden();
  await expect
    .poll(() => mergeSteps(app))
    .toEqual([
      "git_pull",
      "git_resolve_conflict",
      "git_resolve_conflict",
      "git_finish_merge",
      "git_push",
    ]);
  expect((await app.calls("git_resolve_conflict")).map((c) => c.args)).toEqual([
    { path: "assets/photo.png", resolution: { kind: "theirs" } },
    { path: "Old idea.md", resolution: { kind: "ours" } },
  ]);
});

test("Cancel sync aborts the merge and closes the editor", async ({ app }) => {
  await seedConflicts(app, { files: [PLAN, BANK] });
  const editor = await syncIntoEditor(app);
  await editor
    .getByRole("group", { name: "Conflict 1" })
    .getByRole("button", { name: "This device" })
    .click();

  await editor.getByRole("button", { name: "Cancel sync" }).click();
  const confirm = app.page.getByRole("alertdialog", { name: "Cancel sync?" });
  await expect(confirm).toBeVisible();
  await app.screenshot("merge-editor-cancel");
  await confirm.getByRole("button", { name: "Cancel sync" }).click();

  await expect(mergeEditor(app)).toBeHidden();
  await expect
    .poll(() => mergeSteps(app))
    .toEqual(["git_pull", "git_abort_merge"]);
});

test("a folder that opens mid-merge shows the merge editor", async ({
  app,
}) => {
  await seedConflicts(app, { files: [BANK], midMerge: true });

  const editor = mergeEditor(app);
  await expect(editor).toBeVisible();
  await expect(editor).toContainText("Balance: 100");
  expect(await app.calls("git_pull")).toEqual([]);
  await app.screenshot("merge-editor-on-open");
});

test("an agent sync that stops on conflicts refreshes git and opens the merge editor", async ({
  app,
}) => {
  await seedConflicts(app, { files: [BANK] });
  await expect(app.page.getByRole("button", { name: "Sync" })).toBeVisible();
  await expect(mergeEditor(app)).toHaveCount(0);
  const statusCalls = (await app.calls("git_get_status")).length;

  // The backend ran the agent's sync and tells the frontend
  await app.page.evaluate(async () => {
    const fake = window.aetherFake;
    const seed = window.aetherFakeConflicts;
    if (!fake || !seed) throw new Error("Fake backend missing");
    seed.midMerge = true;
    await fake.emit("git-state-changed", null);
  });

  const editor = mergeEditor(app);
  await expect(editor).toBeVisible();
  const items = editor
    .getByRole("list", { name: "Conflicting notes" })
    .getByRole("button");
  await expect(items).toHaveCount(1);
  await expect(items.nth(0)).toContainText("Bank");
  await expect(items.nth(0)).toContainText("Private");
  await expect
    .poll(async () => (await app.calls("git_get_status")).length)
    .toBeGreaterThan(statusCalls);
  await app.screenshot("merge-editor-after-agent-sync");
});
