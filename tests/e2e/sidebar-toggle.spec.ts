import { expect, test, type AetherApp } from "./app";

// The default device is Windows, which has no window dots on the left
test.use({
  userAgent:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
});

// The macOS window dots end at about 68px, inside the 44px title bar row
const DOTS_RIGHT_PX = 68;
const TITLE_BAR_PX = 44;

async function expectBesideWindowDots(app: AetherApp, name: RegExp) {
  const toggles = app.page.getByRole("button", { name });
  await expect(toggles).toHaveCount(1);
  const box = await toggles.boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(DOTS_RIGHT_PX);
  expect(box!.x).toBeLessThan(DOTS_RIGHT_PX + 40);
  expect(box!.y + box!.height).toBeLessThanOrEqual(TITLE_BAR_PX);
  return box!;
}

test("the sidebar toggle sits beside the window dots, open or collapsed", async ({
  app,
}) => {
  await app.seed({ "Welcome.md": "# Welcome\n\nHello\n" });

  // No note open: the Home view has no header of its own
  await expectBesideWindowDots(app, /^Hide sidebar/);
  await app.page.getByRole("button", { name: /^Hide sidebar/ }).click();
  await expect(app.sidebar).toBeHidden();
  await expectBesideWindowDots(app, /^Show sidebar/);
  await app.page.getByRole("button", { name: /^Show sidebar/ }).click();
  await expect(app.sidebar).toBeVisible();

  // A note open: collapsed, the editor header starts after the toggle
  await app.sidebar.getByText("Welcome").click();
  await expect(app.editor).toContainText("Hello");
  await expectBesideWindowDots(app, /^Hide sidebar/);
  await app.screenshot("sidebar-toggle-open");

  await app.page.getByRole("button", { name: /^Hide sidebar/ }).click();
  await expect(app.sidebar).toBeHidden();
  const toggle = await expectBesideWindowDots(app, /^Show sidebar/);
  const headerText = await app.page
    .locator("[data-editor-header-start] > *")
    .first()
    .boundingBox();
  expect(headerText!.x).toBeGreaterThanOrEqual(toggle.x + toggle.width);
  await app.screenshot("sidebar-toggle-collapsed");
});
