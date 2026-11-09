import { test, expect } from '@playwright/test';
import { startOccupations, selectOccupation, selectActivities } from './flow.js';

async function establish(page, count) {
  await startOccupations(page);
  await selectOccupation(page, 'chief');
  await page.locator('#occupations-continue').click();
  await expect(page.locator('#screen-activities')).toBeVisible();
  const codes = await page
    .locator('#activity-list li[data-dwa]')
    .evaluateAll((nodes, wanted) => nodes.slice(0, wanted).map((node) => node.getAttribute('data-dwa')), count);
  await selectActivities(page, count);
  await page.locator('#activities-continue').click();
  await expect(page.locator('#screen-rank')).toBeVisible();
  return codes;
}

async function moveToBucket(page, code, direction) {
  const button = page.locator(`#rank-board li[data-dwa="${code}"] [data-bucket-move="${direction}"]`);
  if (await button.isEnabled()) {
    await button.click();
  }
}

/* Split the current group by the target order, exactly as a user who knows
 * the target order would do. */
async function answerGroup(page, targetOrder) {
  const cards = await page
    .locator('#rank-board li[data-dwa]')
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-dwa')));
  const position = new Map(targetOrder.map((code, index) => [code, index]));
  const sorted = cards
    .slice()
    .sort((a, b) => (position.get(a) ?? Number.MAX_SAFE_INTEGER) - (position.get(b) ?? Number.MAX_SAFE_INTEGER));
  const total = sorted.length;
  const firstCut = Math.ceil(total / 3);
  const secondCut = Math.ceil((2 * total) / 3);
  const high = new Set(sorted.slice(0, firstCut));
  const low = new Set(sorted.slice(secondCut));
  for (const code of cards) {
    if (high.has(code)) {
      await moveToBucket(page, code, 'more');
    } else if (low.has(code)) {
      await moveToBucket(page, code, 'less');
    }
  }
  await expect(page.locator('#rank-confirm')).toBeEnabled();
  await page.locator('#rank-confirm').click();
}

async function answerAll(page, targetOrder) {
  for (let step = 0; step < 100; step += 1) {
    if (await page.locator('#screen-results').isVisible()) {
      return;
    }
    await expect(page.locator('#screen-rank')).toBeVisible();
    await expect(page.locator('#rank-board')).toBeVisible();
    await answerGroup(page, targetOrder);
  }
  await expect(page.locator('#screen-results')).toBeVisible();
}

test('the deterministic group questionnaire recovers the target order', async ({ page }) => {
  const target = await establish(page, 10);
  expect(target.length).toBe(10);
  await expect(page.locator('#rank-board')).toBeVisible();
  await expect(page.locator('#rank-confirm')).toBeDisabled();

  const small = await page.locator('#rank-board button').evaluateAll((nodes) =>
    nodes.filter((node) => {
      const box = node.getBoundingClientRect();
      return box.width < 44 || box.height < 44;
    }).length
  );
  expect(small, 'every bucket button should be at least 44 pixels').toBe(0);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow, 'the grouping board should not overflow horizontally').toBeLessThanOrEqual(1);

  await moveToBucket(page, target[0], 'more');
  await expect(page.locator('#rank-confirm')).toBeEnabled();
  await answerGroup(page, target);
  await answerAll(page, target);
  await expect(page.locator('#screen-results')).toBeVisible();

  const rankOrder = await page.evaluate(() => window.__AI_EXPOSURE_APP__.state.rankOrder.slice());
  expect(rankOrder.map(String)).toEqual(target);
});

test('a two-bucket split still finishes the questionnaire', async ({ page }) => {
  const target = await establish(page, 6);
  await expect(page.locator('#rank-board')).toBeVisible();
  for (const code of target.slice(0, 3)) {
    await moveToBucket(page, code, 'more');
  }
  await expect(page.locator('#rank-confirm')).toBeEnabled();
  await page.locator('#rank-confirm').click();
  await answerAll(page, target);
  await expect(page.locator('#screen-results')).toBeVisible();
  const rankOrder = await page.evaluate(() => window.__AI_EXPOSURE_APP__.state.rankOrder.slice());
  expect(rankOrder.map(String)).toEqual(target);
});

test('the title names the group from the second question', async ({ page }) => {
  const target = await establish(page, 20);
  await expect(page.locator('#rank-title')).toHaveText('Ordina le attività');
  await answerGroup(page, target);
  await expect(page.locator('#screen-rank')).toBeVisible();
  await expect(page.locator('#rank-title')).toHaveText(
    /Ordina le attività (più frequenti|normali|meno frequenti)/
  );
});

test('going back and continuing shows the saved questions', async ({ page }) => {
  const target = await establish(page, 20);
  await answerAll(page, target);
  await expect(page.locator('#screen-results')).toBeVisible();
  const firstOrder = await page.evaluate(() => window.__AI_EXPOSURE_APP__.state.rankOrder.slice());

  await page.locator('#results-back').click();
  await expect(page.locator('#screen-activities')).toBeVisible();
  await page.locator('#activities-continue').click();
  await expect(page.locator('#screen-rank')).toBeVisible();
  await expect(page.locator('#rank-status')).toContainText(/gruppi salvati/);
  const counts = await page.locator('#rank-board .bucket').evaluateAll((nodes) =>
    nodes.map((node) => node.querySelectorAll('.bucket-card').length)
  );
  expect(counts.reduce((sum, count) => sum + count, 0)).toBe(20);
  expect(counts.some((count) => count > 0)).toBe(true);

  await answerAll(page, target);
  await expect(page.locator('#screen-results')).toBeVisible();
  const secondOrder = await page.evaluate(() => window.__AI_EXPOSURE_APP__.state.rankOrder.slice());
  expect(secondOrder).toEqual(firstOrder);
});

test('changing a saved split rebuilds the subtree', async ({ page }) => {
  const target = await establish(page, 20);
  await answerAll(page, target);
  await expect(page.locator('#screen-results')).toBeVisible();
  const firstOrder = await page.evaluate(() => window.__AI_EXPOSURE_APP__.state.rankOrder.slice());

  await page.locator('#results-back').click();
  await expect(page.locator('#screen-activities')).toBeVisible();
  await page.locator('#activities-continue').click();
  await expect(page.locator('#screen-rank')).toBeVisible();
  await moveToBucket(page, target[0], 'less');
  await page.locator('#rank-confirm').click();
  await answerAll(page, target);
  await expect(page.locator('#screen-results')).toBeVisible();

  const secondOrder = await page.evaluate(() => window.__AI_EXPOSURE_APP__.state.rankOrder.slice());
  expect(secondOrder).not.toEqual(firstOrder);
  expect(new Set(secondOrder).size).toBe(20);
});

test('the high bucket is on the right in horizontal view and above in vertical view', async ({ page }) => {
  await establish(page, 10);
  const high = await page.locator('#rank-board .bucket[data-bucket="high"]').boundingBox();
  const low = await page.locator('#rank-board .bucket[data-bucket="low"]').boundingBox();
  if (page.viewportSize().width >= 720) {
    expect(high.x).toBeGreaterThan(low.x);
  } else {
    expect(high.y).toBeLessThan(low.y);
  }
});

test('the move arrows follow the layout', async ({ page }) => {
  await establish(page, 10);
  await expect(page.locator('#rank-board')).toBeVisible();
  const content = await page
    .locator('#rank-board [data-bucket-move="more"]')
    .first()
    .evaluate((node) => getComputedStyle(node, '::before').content);
  if (page.viewportSize().width >= 720) {
    expect(content).toContain('→');
  } else {
    expect(content).toContain('↑');
  }
});
