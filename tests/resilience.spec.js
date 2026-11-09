import { test, expect } from '@playwright/test';
import { reachActivities, selectActivities, reachResults } from './flow.js';

test('the score is the gap and the histogram marks one bin between the axes', async ({ page }) => {
  await reachResults(page);

  const text = (await page.locator('#score-value').textContent()).trim();
  expect(text).toMatch(/^\d+,\d\d$/);
  expect(Number.isNaN(Number(text.replace(',', '.')))).toBe(false);

  await expect(page.locator('#gap-histogram [data-bin]')).toHaveCount(100);
  await expect(page.locator('#gap-histogram [data-current="true"]')).toHaveCount(1);
  await expect(page.locator('#histogram-caption')).toContainText('bin');

  const axisLeft = (await page.locator('#histogram-axis-left').textContent()).trim();
  const axisRight = (await page.locator('#histogram-axis-right').textContent()).trim();
  expect(axisLeft).toMatch(/\d/);
  expect(axisRight).toMatch(/\d/);
  expect(Number.isNaN(Number(axisLeft.replace(',', '.')))).toBe(false);
  expect(Number.isNaN(Number(axisRight.replace(',', '.')))).toBe(false);

  await expect(page.locator('#histogram-left-occupation')).not.toBeEmpty();
  await expect(page.locator('#histogram-right-occupation')).not.toBeEmpty();
  await expect(page.locator('#histogram-label-left')).toContainText(/resilien/i);
  await expect(page.locator('#histogram-label-right')).toContainText(/resilien/i);

  const resilienceFilter = page.locator('label[for="filter-exposure"]');
  await expect(resilienceFilter).toContainText(/Capability GAP/i);
  await expect(resilienceFilter).toContainText(/resilienza/i);
});

test('the activity selection survives going back', async ({ page }) => {
  await reachActivities(page);
  const first = await page.locator('#activity-list li[data-dwa]').first().getAttribute('data-dwa');
  await page.locator(`#activity-list li[data-dwa="${first}"] input[data-enabled]`).check();
  await expect(page.locator(`#activity-list li[data-dwa="${first}"] input[data-enabled]`)).toBeChecked();

  await page.locator('#activities-back').click();
  await expect(page.locator('#screen-occupations')).toBeVisible();
  await page.locator('#occupations-continue').click();
  await expect(page.locator('#screen-activities')).toBeVisible();
  await expect(page.locator(`#activity-list li[data-dwa="${first}"] input[data-enabled]`)).toBeChecked();

  await selectActivities(page, 4);
  await page.locator('#activities-continue').click();
  await expect(page.locator('#screen-results')).toBeVisible();
  const rankOrder = await page.evaluate(() => window.__AI_EXPOSURE_APP__.state.rankOrder.slice());
  expect(rankOrder.length).toBe(4);
});
