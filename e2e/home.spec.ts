import { expect, test } from "@playwright/test";

test("home page renders", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "FewChat" })).toBeVisible();
  await expect(
    page.getByText("Less automation. Just what you need."),
  ).toBeVisible();
});
