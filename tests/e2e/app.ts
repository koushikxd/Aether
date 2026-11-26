import {
  expect,
  test as base,
  type Locator,
  type Page,
  type Route,
  type TestInfo,
} from "@playwright/test";
import type { Editor } from "@tiptap/core";
import type { FakeBackend, FakeCall, FakeFiles } from "./fake-backend";

// A dev server that reloaded after an edit adds `?t=<time>` to the src
const APP_ENTRY = /<script type="module" src="\/src\/main\.tsx(?:\?t=\d+)?">/;
const FAKE_BACKEND =
  '<script type="module" src="/tests/e2e/fake-backend.ts"></script>';

type FakeState = Pick<FakeBackend, "files" | "calls" | "unhandled">;

// Module scripts run in document order, so the fake is installed before the
// app's first invoke(). Nothing in src/ references the fake.
async function injectFakeBackend(route: Route) {
  const response = await route.fetch();
  const html = await response.text();
  if (!APP_ENTRY.test(html)) {
    throw new Error(`index.html no longer matches ${APP_ENTRY}`);
  }
  await route.fulfill({
    response,
    body: html.replace(APP_ENTRY, (entry) => `${FAKE_BACKEND}\n${entry}`),
  });
}

function setSeed(files: FakeFiles) {
  window.aetherFakeSeed = files;
}

export class AetherApp {
  readonly editor: Locator;
  readonly sidebar: Locator;
  private booted = false;

  constructor(
    readonly page: Page,
    private readonly testInfo: TestInfo,
  ) {
    this.editor = page.locator(".ProseMirror");
    this.sidebar = page.locator("[data-sidebar]");
  }

  /** Fills the fake notes folder (keys like `a/b/Note.md`) and boots the app. */
  async seed(files: FakeFiles) {
    await this.page.route((url) => url.pathname === "/", injectFakeBackend);
    await this.page.addInitScript(setSeed, files);
    await this.page.goto("/");
    this.booted = true;
    await expect(this.sidebar).toBeVisible();
  }

  /** Boots with no notes folder chosen, on the welcome screen. */
  async bootWithoutFolder() {
    await this.page.route((url) => url.pathname === "/", injectFakeBackend);
    await this.page.addInitScript(() => {
      window.aetherFakeNoFolder = true;
    });
    await this.page.goto("/");
    this.booted = true;
  }

  /** Reloads the page; the fake folder keeps its current files. */
  async reload() {
    await this.page.addInitScript(setSeed, await this.files());
    await this.page.reload();
    await expect(this.sidebar).toBeVisible();
  }

  /** A page's row in the sidebar tree (not its Pinned copy) by its exact label. */
  row(name: string): Locator {
    return this.sidebar
      .locator("[data-page-tree]")
      .getByRole("button", { name, exact: true });
  }

  /** Drags a sidebar row onto another with the pointer, as dnd-kit expects. */
  async drag(source: string, target: string) {
    const from = await this.row(source).boundingBox();
    const to = await this.row(target).boundingBox();
    if (!from || !to) throw new Error("drag rows are not visible");
    const { mouse } = this.page;
    await mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await mouse.down();
    await mouse.move(from.x + from.width / 2, from.y + from.height / 2 + 10, {
      steps: 3,
    });
    await mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 10 });
    await mouse.up();
  }

  /** Opens a note by id, the way the backend does for CLI and drag-drop. */
  async open(id: string) {
    await this.emit("select-note", id);
  }

  async emit(event: string, payload: unknown) {
    await this.page.evaluate(
      ([name, data]) => window.aetherFake?.emit(name, data),
      [event, payload] as const,
    );
  }

  /** Writes a note's file as another program (the CLI) would, and reports it like the watcher. */
  async writeExternally(path: string, content: string) {
    await this.page.evaluate(
      ([file, text]) => window.aetherFake?.writeExternally(file, text),
      [path, content] as const,
    );
  }

  /** Makes the next file-picker dialog return this path (or paths). */
  async pickFile(path: string | string[]) {
    await this.page.evaluate((picked) => {
      if (window.aetherFake) window.aetherFake.pickedFile = picked;
    }, path);
  }

  /** Makes calls to `cmd` wait, like a slow backend, until `release(cmd)`. */
  async hold(cmd: string) {
    await this.page.evaluate((name) => window.aetherFake?.hold(name), cmd);
  }

  /** Runs the held calls to `cmd` in order and stops holding it. */
  async release(cmd: string) {
    await this.page.evaluate((name) => window.aetherFake?.release(name), cmd);
  }

  /** Answers the latest held call to `cmd` while the earlier ones keep waiting. */
  async releaseLatest(cmd: string) {
    await this.page.evaluate(
      (name) => window.aetherFake?.releaseLatest(name),
      cmd,
    );
  }

  /** Every backend call so far, optionally filtered by command name. */
  async calls(cmd?: string): Promise<FakeCall[]> {
    const { calls } = await this.state();
    return cmd ? calls.filter((c) => c.cmd === cmd) : calls;
  }

  /** Markdown of the latest `save_note` call for this note id. */
  async savedMarkdown(id: string): Promise<string | undefined> {
    const saves = await this.calls("save_note");
    const content = saves.filter((c) => c.args.id === id).pop()?.args.content;
    return typeof content === "string" ? content : undefined;
  }

  /**
   * The selection as the editor sees it: the selected text and the text of the
   * block it starts in. The editor takes in page selection changes
   * asynchronously, so wait for this before acting on a new selection.
   */
  async editorSelection(): Promise<{ text: string; block: string }> {
    return this.page.evaluate(() => {
      // TipTap keeps the editor on its editable element
      const editor = document.querySelector<HTMLElement & { editor?: Editor }>(
        ".ProseMirror",
      )?.editor;
      if (!editor) throw new Error("No editor on the page");
      const { doc, selection } = editor.state;
      return {
        text: doc.textBetween(selection.from, selection.to),
        block: selection.$from.parent.textContent,
      };
    });
  }

  /** Selects `text` the way a drag over it would, and waits for the editor to take it in. */
  async select(text: string) {
    await this.editor.evaluate((root, target) => {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const at = node.textContent?.indexOf(target) ?? -1;
        if (at >= 0) {
          getSelection()?.setBaseAndExtent(node, at, node, at + target.length);
          return;
        }
      }
      throw new Error(`"${target}" is not in the editor`);
    }, text);
    await expect
      .poll(async () => (await this.editorSelection()).text)
      .toBe(text);
  }

  /**
   * Types a character at the end of the block whose text is `block` and
   * deletes it again, so the editor saves the note without changing it.
   */
  async resave(block: string) {
    await this.editor.getByText(block, { exact: true }).click();
    await expect
      .poll(async () => (await this.editorSelection()).block)
      .toBe(block);
    await this.page.keyboard.press("End");
    await this.page.keyboard.type("x");
    await this.page.keyboard.press("Backspace");
  }

  async file(path: string): Promise<string | undefined> {
    return (await this.files())[path];
  }

  async files(): Promise<FakeFiles> {
    return (await this.state()).files;
  }

  async screenshot(name: string) {
    const path = this.testInfo.outputPath(`${name}.png`);
    await this.page.screenshot({ path, fullPage: true });
    await this.testInfo.attach(name, { path, contentType: "image/png" });
  }

  async unhandledCommands(): Promise<string[]> {
    return this.booted ? (await this.state()).unhandled : [];
  }

  private state(): Promise<FakeState> {
    return this.page.evaluate(() => {
      const fake = window.aetherFake;
      if (!fake) throw new Error("Fake backend missing: call app.seed() first");
      return {
        files: fake.files,
        calls: fake.calls,
        unhandled: fake.unhandled,
      };
    });
  }
}

export const test = base.extend<{ app: AetherApp }>({
  app: async ({ page }, use, testInfo) => {
    const app = new AetherApp(page, testInfo);
    await use(app);
    expect(
      await app.unhandledCommands(),
      "commands missing from tests/e2e/fake-backend.ts",
    ).toEqual([]);
  },
});

export { expect };
