import { test, expect } from "@playwright/test";

test("playwright runner is wired", async () => {
  expect(1 + 1).toBe(2);
});
