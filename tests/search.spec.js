import { test, expect } from '@playwright/test';

/*
 * Fuzzy search over occupation titles on #screen-occupations. The search must
 * tolerate a partial or misspelled query and show a visible empty state when
 * nothing matches.
 */

async function openSearch(page) {
  await page.goto('/index.html');
  await page.locator('#start-occupations').click();
  await expect(page.locator('#screen-occupations')).toBeVisible();
}

function resultRows(page) {
  return page.locator('#occupation-results li[data-occupation]');
}

async function resultCodes(page) {
  return resultRows(page).evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-occupation')));
}

async function resultText(page) {
  return (await resultRows(page).allTextContents()).join(' ');
}

/* Type a query and wait for the rendered result set to actually change, so a
 * stale default list can never satisfy the assertions below. */
async function applyQuery(page, query) {
  const before = await resultCodes(page);
  await page.locator('#occupation-search').fill(query);
  await expect
    .poll(async () => {
      const now = await resultCodes(page);
      return now.length === before.length && now.every((code, index) => code === before[index]);
    }, { message: `the result list should change for the query "${query}"` })
    .toBe(false);
}

test('fuzzy search finds Manager occupations for a misspelled query', async ({ page }) => {
  await openSearch(page);

  await applyQuery(page, 'managr');
  await expect
    .poll(async () => (await resultText(page)).slice(0, 2000), {
      message: 'a Manager occupation should appear for the query "managr"'
    })
    .toMatch(/manager/i);
});

test('fuzzy search finds financial occupations for a prefix', async ({ page }) => {
  await openSearch(page);

  await applyQuery(page, 'financ');
  await expect
    .poll(async () => (await resultText(page)).slice(0, 2000), {
      message: 'a financial occupation should appear for the query "financ"'
    })
    .toMatch(/financ|budget|account|audit|credit|loan|tax|treasur|bank|investment|insurance|revenue/i);
});

test('fuzzy search shows an empty state for a query with no match', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  await openSearch(page);

  await applyQuery(page, 'zzzzqqq');
  await expect(resultRows(page)).toHaveCount(0);

  const empty = await page.evaluate(() => {
    const results = document.querySelector('#occupation-results');
    const count = document.querySelector('#occupation-count');
    return {
      resultsText: results ? results.textContent.trim() : '',
      countText: count ? count.textContent.trim() : ''
    };
  });
  expect(
    empty.resultsText.length > 0 || /\b0\b/.test(empty.countText),
    `no empty state was rendered: ${JSON.stringify(empty)}`
  ).toBe(true);
  await expect(page.locator('#occupation-count')).toBeVisible();
  await expect(page.locator('#occupation-count')).toContainText('0');
  expect(errors).toEqual([]);
});
