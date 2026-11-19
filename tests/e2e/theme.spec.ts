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
