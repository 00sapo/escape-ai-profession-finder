import { test, expect } from '@playwright/test';

async function reachResults(page) {
  await page.goto('/index.html');
  await page.locator('#start-occupations').click();
  await page.locator('#occupation-search').fill('chief');
  await page.locator('#occupation-results button[data-select-occupation]').first().click();
  await page.locator('#occupations-continue').click();
  await page.locator('#activities-done').click();
  await expect(page.locator('#screen-results')).toBeVisible();
}

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

test('typing a rank moves the row and keeps its enabled state', async ({ page }) => {
  await page.goto('/index.html');
  await page.locator('#start-occupations').click();
  await page.locator('#occupation-search').fill('chief');
  await page.locator('#occupation-results button[data-select-occupation]').first().click();
  await page.locator('#occupations-continue').click();
  const rows = page.locator('#activity-list li[data-dwa]');
  const first = await rows.first().getAttribute('data-dwa');
  const second = await rows.nth(1).getAttribute('data-dwa');
  const rank = rows.first().locator('input[data-rank]');
  await rank.fill('2');
  await rank.blur();
  expect(await page.locator('#activity-list li[data-dwa]').nth(1).getAttribute('data-dwa')).toBe(first);
  expect(await page.locator('#activity-list li[data-dwa]').first().getAttribute('data-dwa')).toBe(second);
  const enabled = await page.locator(`#activity-list li[data-dwa="${first}"] input[data-enabled]`).isChecked();
  expect(enabled).toBe(true);
  await rows.nth(0).locator('input[data-rank]').fill('99');
  await rows.nth(0).locator('input[data-rank]').blur();
  await expect(page.locator('#activity-list li[data-dwa]').nth(1).locator('input[data-rank]')).toHaveValue('2');
});
