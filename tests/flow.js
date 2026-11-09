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

export async function selectActivities(page, count = 4) {
  const boxes = page.locator('#activity-list input[data-enabled]');
  const total = await boxes.count();
  const wanted = Math.min(count, total);
  for (let index = 0; index < wanted; index += 1) {
    if (!(await boxes.nth(index).isChecked())) {
      await boxes.nth(index).check();
    }
  }
  await expect(page.locator('#activities-continue')).toBeEnabled();
}

/* Four or fewer selected activities need no questionnaire: the grouping tree
 * resolves them immediately. */
export async function reachResults(page) {
  await reachActivities(page);
  await selectActivities(page, 4);
  await page.locator('#activities-continue').click();
  await expect(page.locator('#screen-results')).toBeVisible();
}

/* Ten activities produce a group question, so the bucket board is visible. */
export async function reachGroup(page, count = 10) {
  await reachActivities(page);
  await selectActivities(page, count);
  await page.locator('#activities-continue').click();
  await expect(page.locator('#screen-rank')).toBeVisible();
  await expect(page.locator('#rank-board')).toBeVisible();
}
