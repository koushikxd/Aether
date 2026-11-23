import { expect, test, type AetherApp } from "./app";
import type { FakeVaultSeed } from "./fake-vault";

const NOTE = "Work/Projects/Plan";
// An 8x8 red PNG, stored the way the fake keeps files: one char per byte.
const PNG = atob(
  "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEUlEQVR4nGN4YGeHFTEMLQkAJ0ZXAYV2vaYAAAAASUVORK5CYII=",
);
const SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="80"><rect width="160" height="80" fill="#4f7cff"/><circle cx="40" cy="40" r="24" fill="#ffd166"/></svg>';
const DOT_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="#e03e3e"/></svg>';

const PLAN = `# Plan

> [!note] 🚀
> Ship the <mark>export</mark> in <span style="color: #e03e3e">red</span> and <u>underlined</u>.

<details><summary>Details</summary>

Inside the toggle

</details>

![Chart](../../assets/chart.svg)

<img src="../../assets/dot.png" width="40">

[spec.pdf](../../assets/spec.pdf)

$$
E = mc^2
$$

Inline $a^2$ math

| Name | Value |
| --- | --- |
| a | \`1\` |

\`\`\`js
const answer = 42;
\`\`\`
`;

async function openPlan(app: AetherApp, dot = { name: "dot.png", data: PNG }) {
  await app.seed({
    [`${NOTE}.md`]: PLAN.replace("dot.png", dot.name),
    "assets/chart.svg": SVG,
    [`assets/${dot.name}`]: dot.data,
    "assets/spec.pdf": "%PDF-1.7",
  });
  await app.open(NOTE);
  await expect(app.editor).toContainText("Inside the toggle");
}

/** The HTML the export wrote with `write_file`. */
async function writtenHtml(app: AetherApp): Promise<string> {
  await expect.poll(() => app.calls("write_file")).toHaveLength(1);
  const [{ args }] = await app.calls("write_file");
  expect(args.path).toBe("/Users/me/Desktop/Plan.html");
  const contents = args.contents;
  if (!Array.isArray(contents)) throw new Error("write_file without bytes");
  return new TextDecoder().decode(new Uint8Array(contents.map(Number)));
}

function imgSrcs(html: string): string[] {
  return [...html.matchAll(/<img\b[^>]*\bsrc="([^"]*)"/g)].map((m) => m[1]);
}

async function exportMenu(app: AetherApp, item: string) {
  await app.page.getByRole("button", { name: "Export", exact: true }).click();
  await app.page.getByRole("menuitem", { name: item, exact: true }).click();
}

test("note menu exports a markdown zip of the note through the backend", async ({
  app,
}) => {
  await openPlan(app);

  await exportMenu(app, "Export Zip");

  await expect.poll(() => app.calls("export_note_zip")).toHaveLength(1);
  const [{ args }] = await app.calls("export_note_zip");
  expect(args.id).toBe(NOTE);
  expect(args.dest).toBe("/Users/me/Desktop/Plan.zip");
  expect(args.includePrivate).toBe(false);
  expect(args.markdown).toContain("![Chart](../../assets/chart.svg)");
  expect(args.markdown).toContain("[spec.pdf](../../assets/spec.pdf)");
  expect(args.markdown).not.toContain("asset://");

  await exportMenu(app, "Copy Markdown");
  await expect
    .poll(async () => (await app.calls("copy_to_clipboard")).pop()?.args.text)
    .toContain('<img src="../../assets/dot.png" width="40">');
});

test("self-contained HTML embeds every image and opens on its own", async ({
  app,
  browser,
}) => {
  await openPlan(app);

  await exportMenu(app, "Export HTML");

  const html = await writtenHtml(app);
  const srcs = imgSrcs(html);
  expect(srcs).toHaveLength(2);
  expect(srcs[0]).toBe(`data:image/svg+xml;base64,${btoa(SVG)}`);
  expect(srcs[1]).toBe(`data:image/png;base64,${btoa(PNG)}`);
  expect(html).not.toMatch(/asset:\/\/|asset\.localhost|src="\.\.?\//);
  expect(html).toContain('<a href="../../assets/spec.pdf">spec.pdf</a>');
  expect(html.match(/<math\b[^>]*>/g)).toEqual([
    '<math xmlns="http://www.w3.org/1998/Math/MathML" display="block">',
    '<math xmlns="http://www.w3.org/1998/Math/MathML">',
  ]);
  expect(html).toContain("<title>Plan</title>");

  const page = await browser.newPage();
  await page.setContent(html);
  await expect
    .poll(() =>
      page
        .locator("img")
        .evaluateAll((imgs) =>
          imgs.map((img) =>
            img instanceof HTMLImageElement ? img.naturalWidth : 0,
          ),
        ),
    )
    .toEqual([160, 8]);
  await page.locator("summary").click();
  await expect(page.getByText("Inside the toggle")).toBeVisible();
  const path = test.info().outputPath("exported-html.png");
  await page.screenshot({ path, fullPage: true });
  await test.info().attach("exported-html", { path, contentType: "image/png" });
  await page.close();
});

test("HTML export keeps going when an image is missing, and says how many", async ({
  app,
}) => {
  await app.seed({
    [`${NOTE}.md`]:
      "# Plan\n\n![Chart](../../assets/chart.svg)\n\n![Gone](../../assets/gone.png)\n",
    "assets/chart.svg": SVG,
  });
  await app.open(NOTE);
  await expect(app.editor.locator("img")).toHaveCount(2);

  await exportMenu(app, "Export HTML");

  const html = await writtenHtml(app);
  expect(imgSrcs(html)).toEqual([
    `data:image/svg+xml;base64,${btoa(SVG)}`,
    "../../assets/gone.png",
  ]);
  expect(html).toContain('alt="Gone"');
  await expect(
    app.page.getByText("1 image could not be embedded"),
  ).toBeVisible();
  await app.screenshot("html-export-missing-image");
});

test("HTML export counts a web image as not embedded", async ({ app }) => {
  await app.page.route("https://example.com/**", (route) =>
    route.fulfill({ body: SVG, contentType: "image/svg+xml" }),
  );
  await app.seed({
    [`${NOTE}.md`]:
      "# Plan\n\n![Chart](../../assets/chart.svg)\n\n![Web](https://example.com/web.svg)\n",
    "assets/chart.svg": SVG,
  });
  await app.open(NOTE);
  await expect(app.editor.locator("img")).toHaveCount(2);

  await exportMenu(app, "Export HTML");

  const html = await writtenHtml(app);
  expect(imgSrcs(html)).toEqual([
    `data:image/svg+xml;base64,${btoa(SVG)}`,
    "https://example.com/web.svg",
  ]);
  await expect(
    app.page.getByText("1 image could not be embedded"),
  ).toBeVisible();
  await app.screenshot("html-export-web-image");
});

test("Copy HTML embeds images as data URLs", async ({ app }) => {
  await openPlan(app);

  await exportMenu(app, "Copy HTML");

  await expect.poll(() => app.calls("copy_to_clipboard")).toHaveLength(1);
  const [{ args }] = await app.calls("copy_to_clipboard");
  if (typeof args.text !== "string") throw new Error("copied no text");
  expect(imgSrcs(args.text)).toEqual([
    `data:image/svg+xml;base64,${btoa(SVG)}`,
    `data:image/png;base64,${btoa(PNG)}`,
  ]);
  expect(args.text).not.toMatch(/asset:\/\/|asset\.localhost/);
  expect(args.text).toContain("Inside the toggle");
});

test("print shows relative images and the new blocks", async ({ app }) => {
  // Windows-style display URLs are http, so the test can serve the images.
  await app.page.addInitScript(() => {
    window.aetherFakeWindowsUrls = true;
    window.print = () => {
      document.body.dataset.printed = "yes";
    };
  });
  // Text bodies only, so both images are SVG here.
  await app.page.route("http://asset.localhost/**", async (route) => {
    const { pathname } = new URL(route.request().url());
    const path = decodeURIComponent(pathname.slice(1));
    await route.fulfill({
      body: await app.file(path.replace("/fake/notes/", "")),
      contentType: "image/svg+xml",
    });
  });
  await openPlan(app, { name: "dot.svg", data: DOT_SVG });

  await exportMenu(app, "Print as PDF");

  await expect(app.page.locator("body")).toHaveAttribute("data-printed", "yes");
  await app.page.emulateMedia({ media: "print" });
  await expect
    .poll(() =>
      app.editor
        .locator("img")
        .evaluateAll((imgs) =>
          imgs.map((img) =>
            img instanceof HTMLImageElement ? img.naturalWidth : 0,
          ),
        ),
    )
    .toEqual([160, 8]);
  await expect(app.editor.getByText("🚀")).toBeVisible();
  await expect(app.editor.getByText("Inside the toggle")).toBeVisible();
  await expect(
    app.editor.locator('[data-type="inline-math"] .katex'),
  ).toBeVisible();
  await expect(app.editor.locator("mark")).not.toHaveCSS(
    "background-color",
    "rgb(255, 255, 255)",
  );
  await expect(app.editor.getByText("red", { exact: true })).toHaveCSS(
    "color",
    "rgb(224, 62, 62)",
  );
  await expect(app.page.locator("[data-sidebar]")).toBeHidden();
  await app.screenshot("print-media");
});

test("page Export Zip asks about private pages only when the page or a sub-page is private", async ({
  app,
}) => {
  const vault: FakeVaultSeed = {
    key: "aether-key-c2VjcmV0LWtleS1mb3ItdGVzdHMtb25seS0xMjM0NTY3",
    unlocked: true,
    privateRoots: ["Plan/Bank"],
  };
  await app.page.addInitScript((seed) => {
    window.aetherFakeVault = seed;
  }, vault);
  await app.seed({
    "Plan.md": "# Plan\n\nPlan body.",
    "Plan/Bank.md": "# Bank\n",
    "Ideas.md": "# Ideas\n\nIdeas body.",
  });
  const dialog = app.page.getByRole("alertdialog");
  const include = dialog.getByLabel("Include private pages (unencrypted)");

  await app.open("Ideas");
  await expect(app.editor).toContainText("Ideas body.");
  await exportMenu(app, "Export Zip");
  await expect.poll(() => app.calls("export_note_zip")).toHaveLength(1);
  await expect(dialog).toHaveCount(0);

  await app.open("Plan");
  await expect(app.editor).toContainText("Plan body.");
  await exportMenu(app, "Export Zip");
  await expect(dialog).toContainText("Export Plan");
  await expect(include).not.toBeChecked();
  await app.screenshot("export-page-dialog");
  await dialog.getByRole("button", { name: "Export", exact: true }).click();
  await expect(dialog).toBeHidden();

  await exportMenu(app, "Export Zip");
  await include.check();
  await dialog.getByRole("button", { name: "Export", exact: true }).click();

  await expect.poll(() => app.calls("export_note_zip")).toHaveLength(3);
  expect(
    (await app.calls("export_note_zip")).map(({ args }) => [
      args.id,
      args.includePrivate,
      args.dest,
    ]),
  ).toEqual([
    ["Ideas", false, "/Users/me/Desktop/Ideas.zip"],
    ["Plan", false, "/Users/me/Desktop/Plan.zip"],
    ["Plan", true, "/Users/me/Desktop/Plan.zip"],
  ]);
});

test("settings export the workspace zip and import one", async ({ app }) => {
  await app.seed({ "Home.md": "# Home\n" });

  await app.page.getByRole("button", { name: /^Settings/ }).click();
  await app.page.getByRole("button", { name: "Export Workspace" }).click();
  await expect.poll(() => app.calls("export_folder_zip")).toHaveLength(1);
  expect((await app.calls("export_folder_zip"))[0].args).toEqual({
    folder: "",
    includePrivate: false,
    dest: "/Users/me/Desktop/notes.zip",
  });

  await app.pickFile("/Users/me/Desktop/notes.zip");
  await app.page.getByRole("button", { name: "Import Zip" }).click();
  await expect
    .poll(() => app.calls("import_zip"))
    .toEqual([
      { cmd: "import_zip", args: { path: "/Users/me/Desktop/notes.zip" } },
    ]);
  await expect(app.page.getByText("Imported 3 files")).toBeVisible();
  await app.screenshot("settings-export-import");
});

test("page Export Zip of a private page warns, then exports it with its sub-pages", async ({
  app,
}) => {
  const vault: FakeVaultSeed = {
    key: "aether-key-c2VjcmV0LWtleS1mb3ItdGVzdHMtb25seS0xMjM0NTY3",
    unlocked: true,
    privateRoots: ["Bank"],
  };
  await app.page.addInitScript((seed) => {
    window.aetherFakeVault = seed;
  }, vault);
  await app.seed({
    "Bank.md": "# Bank\n\nBank body.",
    "Bank/Loans.md": "# Loans\n",
  });
  const dialog = app.page.getByRole("alertdialog");

  await app.open("Bank");
  await expect(app.editor).toContainText("Bank body.");
  await exportMenu(app, "Export Zip");
  await expect(dialog).toContainText("This is a private page.");
  await expect(
    dialog.getByLabel("Include private pages (unencrypted)"),
  ).toHaveCount(0);
  await app.screenshot("export-private-page-warning");
  await dialog.getByRole("button", { name: "Export", exact: true }).click();

  await expect.poll(() => app.calls("export_note_zip")).toHaveLength(1);
  const [{ args }] = await app.calls("export_note_zip");
  expect([args.id, args.includePrivate]).toEqual(["Bank", true]);
});

test("page Export Zip of a bare page inside a private page warns too", async ({
  app,
}) => {
  const vault: FakeVaultSeed = {
    key: "aether-key-c2VjcmV0LWtleS1mb3ItdGVzdHMtb25seS0xMjM0NTY3",
    unlocked: true,
    privateRoots: ["Bank"],
  };
  await app.page.addInitScript((seed) => {
    window.aetherFakeVault = seed;
  }, vault);
  await app.seed({
    "Bank.md": "# Bank\n",
    "Bank/Old/Statement.md": "# Statement\n",
  });
  const dialog = app.page.getByRole("alertdialog");

  await app.open("Bank/Old");
  await expect(app.editor).toContainText("Old");
  await exportMenu(app, "Export Zip");
  await expect(dialog).toContainText("This is a private page.");
  await app.screenshot("export-private-bare-page-warning");
  await dialog.getByRole("button", { name: "Export", exact: true }).click();

  await expect.poll(() => app.calls("export_note_zip")).toHaveLength(1);
  const [{ args }] = await app.calls("export_note_zip");
  expect([args.id, args.includePrivate]).toEqual(["Bank/Old", true]);
});
