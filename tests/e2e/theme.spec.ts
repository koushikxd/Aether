import { expect, test } from "./app";

const palettes = {
  light: {
    surface: "rgb(248, 248, 248)",
    sidebar: "rgb(255, 255, 255)",
    text: "rgb(10, 10, 10)",
  },
  dark: {
    surface: "rgb(20, 20, 20)",
    sidebar: "rgb(16, 16, 16)",
    text: "rgb(244, 244, 244)",
  },
} as const;

for (const scheme of ["light", "dark"] as const) {
  const colors = palettes[scheme];
  test(`applies the neutral ${scheme} palette`, async ({ app }) => {
    await app.page.emulateMedia({ colorScheme: scheme });
    await app.seed({ "Welcome.md": "# Welcome\n\nReadable text.\n" });
    await app.sidebar.getByText("Welcome").click();
    await expect(app.editor).toContainText("Readable text.");

    const shell = app.page.locator("[data-sidebar]").locator("..");
    const sidebarPanel = app.sidebar.locator("> div").first();
    await expect(shell).toHaveCSS("background-color", colors.surface);
    await expect(shell).toHaveCSS("color", colors.text);
    await expect(sidebarPanel).toHaveCSS("background-color", colors.sidebar);

    await app.screenshot(`theme-${scheme}`);
  });
}

test("the page has no drag grips at its edges", async ({ app }) => {
  await app.page.setViewportSize({ width: 1600, height: 900 });
  await app.seed({ "Welcome.md": "# Welcome\n\nReadable text.\n" });
  await app.sidebar.getByText("Welcome").click();
  await expect(app.editor).toContainText("Readable text.");

  await expect(
    app.page.getByRole("separator", { name: /resize editor width/i }),
  ).toHaveCount(0);

  await app.screenshot("page-no-width-grips");
});

test("the editor body text defaults to 16px", async ({ app }) => {
  await app.seed({ "Welcome.md": "# Welcome\n\nBody text.\n" });
  await app.open("Welcome");
  await expect(app.editor.getByText("Body text.")).toHaveCSS(
    "font-size",
    "16px",
  );
});
