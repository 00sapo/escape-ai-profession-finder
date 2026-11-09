import { expect } from '@playwright/test';

/* The page opens on the onboarding slides. Most flow tests only need the
 * occupations screen, so they take the skip shortcut. The dedicated slides
 * test walks the six slides instead. */
export async function skipSlides(page) {
  await expect(page.locator('#screen-slides')).toBeVisible();
  await page.locator('#slide-skip').click();
  await expect(page.locator('#screen-occupations')).toBeVisible();
}

export async function enterOccupations(page) {
  await skipSlides(page);
}

export async function startOccupations(page) {
  await page.goto('/index.html');
  await skipSlides(page);
}

export async function selectOccupation(page, query = 'chief') {
  await page.locator('#occupation-search').fill(query);
  const add = page.locator('#occupation-results button[data-select-occupation]').first();
  await expect(add).toBeVisible();
  await add.click();
}

export async function reachActivities(page) {
  await startOccupations(page);
  await selectOccupation(page);
  await page.locator('#occupations-continue').click();
  await expect(page.locator('#screen-activities')).toBeVisible();
  await expect(page.locator('#activity-list li[data-dwa]').first()).toBeVisible();
}

export async function reachResults(page) {
  await reachActivities(page);
  await page.locator('#activities-done').click();
  await expect(page.locator('#screen-results')).toBeVisible();
}
