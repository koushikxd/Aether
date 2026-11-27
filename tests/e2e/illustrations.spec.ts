import type { Locator } from "@playwright/test";
import { expect, test } from "./app";

// The illustrations are CSS masks: a wrong path draws nothing and logs no error.
async function expectSvgMask(illustration: Locator) {
  await expect(illustration).toBeVisible();
  const mask = await illustration.evaluate(
    (el) => getComputedStyle(el).maskImage,
  );
  const url = /url\("(.+)"\)/.exec(mask)?.[1];
  if (!url) throw new Error(`no mask image on the illustration: ${mask}`);
  const response = await illustration.page().request.get(url);
  expect(response.ok()).toBe(true);
  expect(response.headers()["content-type"]).toContain("image/svg+xml");
}

for (const scheme of ["light", "dark"] as const) {
  test(`welcome screen shows a stack of books (${scheme})`, async ({ app }) => {
    await app.page.emulateMedia({ colorScheme: scheme });
    await app.bootWithoutFolder();
    await expectSvgMask(app.page.getByRole("img", { name: "Stack of books" }));
    // The welcome screen fades in
    await app.page.evaluate(() =>
      Promise.all(document.getAnimations().map((a) => a.finished)),
    );
    await app.screenshot(`welcome-${scheme}`);
  });
}
