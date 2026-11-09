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

async function answerLeaf(page, targetOrder) {
  const rows = page.locator('#rank-list li[data-dwa]');
  const codes = await rows.evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-dwa')));
  const position = new Map(targetOrder.map((code, index) => [code, index]));
  const desired = codes
    .slice()
    .sort((a, b) => (position.get(a) ?? Number.MAX_SAFE_INTEGER) - (position.get(b) ?? Number.MAX_SAFE_INTEGER));
  for (let target = 0; target < desired.length; target += 1) {
    let current = await rows.evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-dwa')));
    let index = current.indexOf(desired[target]);
    while (index > target) {
      await page.locator(`#rank-list li[data-dwa="${desired[target]}"] [data-move="up"]`).click();
      index -= 1;
    }
  }
  await page.locator('#rank-confirm').click();
}

async function answerAll(page, targetOrder) {
  for (let step = 0; step < 100; step += 1) {
    if (await page.locator('#screen-results').isVisible()) {
      return;
    }
    await expect(page.locator('#screen-rank')).toBeVisible();
    if (await page.locator('#rank-board').isVisible()) {
      await answerGroup(page, targetOrder);
    } else {
      await expect(page.locator('#rank-list')).toBeVisible();
      await answerLeaf(page, targetOrder);
    }
  }
  await expect(page.locator('#screen-results')).toBeVisible();
}

test('the deterministic group questionnaire recovers the target order', async ({ page }) => {
  const target = await establish(page, 10);
  expect(target.length).toBe(10);
  await expect(page.locator('#rank-board')).toBeVisible();
  await expect(page.locator('#rank-list')).toBeHidden();
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

test('the move arrows follow the layout', async ({ page }) => {
  await establish(page, 10);
  await expect(page.locator('#rank-board')).toBeVisible();
  const content = await page
    .locator('#rank-board [data-bucket-move="more"]')
    .first()
    .evaluate((node) => getComputedStyle(node, '::before').content);
  if (page.viewportSize().width >= 720) {
    expect(content).toContain('←');
  } else {
    expect(content).toContain('↑');
  }
});
