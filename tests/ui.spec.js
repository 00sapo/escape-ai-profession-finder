import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.join(path.dirname(HERE), 'web');

async function startOccupations(page) {
  await page.goto('/index.html');
  await page.locator('#start-occupations').click();
  await expect(page.locator('#screen-occupations')).toBeVisible();
}

async function selectOccupation(page, query = 'chief') {
  await page.locator('#occupation-search').fill(query);
  const add = page.locator('#occupation-results button[data-select-occupation]').first();
  await expect(add).toBeVisible();
  await add.click();
}

async function reachActivities(page) {
  await startOccupations(page);
  await selectOccupation(page);
  await page.locator('#occupations-continue').click();
  await expect(page.locator('#screen-activities')).toBeVisible();
  await expect(page.locator('#activity-list li[data-dwa]').first()).toBeVisible();
}

async function reachResults(page) {
  await reachActivities(page);
  await page.locator('#activities-done').click();
  await expect(page.locator('#screen-results')).toBeVisible();
}

async function horizontalOverflow(page) {
  return page.evaluate(() => {
    const viewport = window.innerWidth;
    const wide = [];
    document.querySelectorAll('body *').forEach((node) => {
      if (!node.getClientRects().length) {
        return;
      }
      const box = node.getBoundingClientRect();
      if (box.right < 0) {
        return;
      }
      if (box.width > viewport + 1 || box.right > viewport + 1) {
        wide.push({
          node: `${node.tagName.toLowerCase()}.${String(node.className || '')}`,
          width: Math.round(box.width),
          right: Math.round(box.right)
        });
      }
    });
    return { scrollWidth: document.documentElement.scrollWidth, viewport, wide: wide.slice(0, 8) };
  });
}

async function smallTargets(page) {
  return page.evaluate(() => {
    const limit = 43.5;
    const bad = [];
    document.querySelectorAll('button, a[href], summary, input').forEach((node) => {
      if (!node.getClientRects().length) {
        return;
      }
      const box = node.getBoundingClientRect();
      if (box.right < 0) {
        return;
      }
      let target = node;
      if (node.tagName === 'INPUT' && node.type === 'checkbox' && node.id) {
        const label = document.querySelector(`label[for="${node.id}"]`);
        if (label) {
          target = label;
        }
      }
      const rect = target.getBoundingClientRect();
      if (rect.height < limit || rect.width < limit) {
        bad.push({
          node: `${node.tagName.toLowerCase()}${node.id ? '#' + node.id : ''}`,
          width: Math.round(rect.width),
          height: Math.round(rect.height)
        });
      }
    });
    return bad;
  });
}

async function contrastFailures(page) {
  return page.evaluate(() => {
    function parse(value) {
      const match = /rgba?\(([^)]+)\)/.exec(value);
      if (!match) {
        return null;
      }
      const parts = match[1].split(/[ ,/]+/).filter(Boolean).map(Number);
      return { r: parts[0], g: parts[1], b: parts[2], a: parts[3] === undefined ? 1 : parts[3] };
    }
    function luminance(color) {
      const channel = (raw) => {
        const value = raw / 255;
        return value <= 0.03928 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4);
      };
      return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b);
    }
    function ratio(a, b) {
      const first = luminance(a);
      const second = luminance(b);
      const high = Math.max(first, second);
      const low = Math.min(first, second);
      return (high + 0.05) / (low + 0.05);
    }
    function backgroundOf(node) {
      let current = node;
      while (current && current.nodeType === 1) {
        const color = parse(getComputedStyle(current).backgroundColor);
        if (color && color.a > 0.9) {
          return color;
        }
        current = current.parentElement;
      }
      return { r: 255, g: 255, b: 255, a: 1 };
    }
    const failures = [];
    document.querySelectorAll('body *').forEach((node) => {
      if (!node.getClientRects().length) {
        return;
      }
      const ownText = Array.from(node.childNodes)
        .filter((child) => child.nodeType === 3)
        .map((child) => child.textContent.trim())
        .join('');
      if (!ownText) {
        return;
      }
      const style = getComputedStyle(node);
      if (style.visibility === 'hidden' || style.opacity === '0') {
        return;
      }
      const foreground = parse(style.color);
      if (!foreground) {
        return;
      }
      const size = parseFloat(style.fontSize);
      const weight = Number(style.fontWeight) || 400;
      const large = size >= 24 || (size >= 18.66 && weight >= 700);
      const required = large ? 3 : 4.5;
      const value = ratio(foreground, backgroundOf(node));
      if (value < required) {
        failures.push({
          node: `${node.tagName.toLowerCase()}.${String(node.className || '')}`,
          text: ownText.slice(0, 40),
          ratio: Math.round(value * 100) / 100,
          required
        });
      }
    });
    return failures;
  });
}

async function axeSerious(page) {
  const report = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  return report.violations
    .filter((violation) => violation.impact === 'serious' || violation.impact === 'critical')
    .map((violation) => ({ id: violation.id, nodes: violation.nodes.length, help: violation.help }));
}

async function assertLayoutIsSound(page) {
  const overflow = await horizontalOverflow(page);
  expect(overflow.wide, JSON.stringify(overflow.wide)).toEqual([]);
  expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.viewport + 1);

  const targets = await smallTargets(page);
  expect(targets, JSON.stringify(targets)).toEqual([]);

  const contrast = await contrastFailures(page);
  expect(contrast, JSON.stringify(contrast)).toEqual([]);
}

/* A missing i18n key renders as its dotted key, for example "pick.back". */
async function rawTranslationKeys(page) {
  return page.evaluate(() => {
    const pattern = /^[a-z][a-zA-Z]*\.[a-zA-Z][a-zA-Z.]*$/;
    const matches = [];
    document.querySelectorAll('body *').forEach((node) => {
      if (!node.getClientRects().length) {
        return;
      }
      const style = getComputedStyle(node);
      if (style.visibility === 'hidden' || style.opacity === '0') {
        return;
      }
      if (pattern.test(node.textContent.trim())) {
        matches.push(node);
      }
    });
    return matches
      .filter((node) => !matches.some((other) => other !== node && node.contains(other)))
      .map((node) => ({
        tag: node.tagName.toLowerCase(),
        id: node.id || null,
        text: node.textContent.trim()
      }));
  });
}

async function assertNoRawTranslationKeys(page) {
  const raw = await rawTranslationKeys(page);
  expect(raw, JSON.stringify(raw)).toEqual([]);
}

/* Every text element inside a ranking card must reach 4.5 to 1 against the
 * card background (the cards have their own tinted background). */
async function rankingCardContrastFailures(page) {
  return page.evaluate(() => {
    function parse(value) {
      const match = /rgba?\(([^)]+)\)/.exec(value);
      if (!match) {
        return null;
      }
      const parts = match[1].split(/[ ,/]+/).filter(Boolean).map(Number);
      return { r: parts[0], g: parts[1], b: parts[2], a: parts[3] === undefined ? 1 : parts[3] };
    }
    function luminance(color) {
      const channel = (raw) => {
        const value = raw / 255;
        return value <= 0.03928 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4);
      };
      return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b);
    }
    function ratio(a, b) {
      const first = luminance(a);
      const second = luminance(b);
      const high = Math.max(first, second);
      const low = Math.min(first, second);
      return (high + 0.05) / (low + 0.05);
    }
    function backgroundOf(node) {
      let current = node;
      while (current && current.nodeType === 1) {
        const color = parse(getComputedStyle(current).backgroundColor);
        if (color && color.a > 0.9) {
          return color;
        }
        current = current.parentElement;
      }
      return { r: 255, g: 255, b: 255, a: 1 };
    }
    const failures = [];
    document.querySelectorAll('#ranking details.ranking-card').forEach((card) => {
      card.querySelectorAll('*').forEach((node) => {
        if (!node.getClientRects().length) {
          return;
        }
        const ownText = Array.from(node.childNodes)
          .filter((child) => child.nodeType === 3)
          .map((child) => child.textContent.trim())
          .join('');
        if (!ownText) {
          return;
        }
        const style = getComputedStyle(node);
        if (style.visibility === 'hidden' || style.opacity === '0') {
          return;
        }
        const foreground = parse(style.color);
        if (!foreground) {
          return;
        }
        const value = ratio(foreground, backgroundOf(node));
        if (value < 4.5) {
          failures.push({
            band: card.getAttribute('data-gap-band'),
            text: ownText.slice(0, 40),
            ratio: Math.round(value * 100) / 100
          });
        }
      });
    });
    return failures;
  });
}

test('occupation flow is usable with clicks only and the layout holds', async ({ page }) => {
  await startOccupations(page);
  await assertLayoutIsSound(page);
  expect(await axeSerious(page)).toEqual([]);

  await selectOccupation(page);
  await expect(page.locator('#selected-occupations li')).toHaveCount(1);
  await page.locator('#occupations-continue').click();
  await expect(page.locator('#screen-activities')).toBeVisible();
  await expect(page.locator('#activity-list li[data-dwa]').first()).toBeVisible();
  await assertLayoutIsSound(page);

  await page.locator('#activities-done').click();
  await expect(page.locator('#screen-results')).toBeVisible();
  await assertLayoutIsSound(page);
  expect(await axeSerious(page)).toEqual([]);
});

test('removing the selected occupation disables continuing', async ({ page }) => {
  await startOccupations(page);
  await selectOccupation(page);
  const remove = page.locator('#selected-occupations button[data-remove-occupation]').first();
  await expect(remove).toBeVisible();
  const code = await remove.getAttribute('data-remove-occupation');
  expect(code).toBeTruthy();
  await remove.click();
  await expect(page.locator(`#selected-occupations button[data-remove-occupation="${code}"]`)).toHaveCount(0);
  await expect(page.locator('#occupations-continue')).toBeDisabled();
});

test('results show the user score, the direction legend and five neighbours', async ({ page }) => {
  await reachResults(page);

  await expect(page.locator('#score-value')).toBeVisible();
  await expect(page.locator('#score-value')).toHaveText(/\d,\d\d/);
  await expect(page.locator('#score-scale')).toContainText(/resilien/i);

  const legend = page.locator('#results-legend');
  await expect(legend).toBeVisible();
  await expect(legend).toContainText('più basso');

  const rows = page.locator('#ranking > li');
  await expect(rows).toHaveCount(50);
  for (let i = 0; i < 5; i += 1) {
    const summary = rows.nth(i).locator('summary');
    await expect(summary).toBeVisible();
    await expect(summary.locator('.rank-title')).toContainText('.');
    const clipped = await summary.evaluate((node) => node.scrollWidth > node.clientWidth + 1);
    expect(clipped).toBe(false);
  }

  await assertLayoutIsSound(page);
  expect(await axeSerious(page)).toEqual([]);
});

test('ranking cards carry a gap band, a red-to-green ramp and readable text', async ({ page }) => {
  await reachResults(page);

  const cards = page.locator('#ranking details.ranking-card');
  const total = await cards.count();
  expect(total).toBeGreaterThan(0);

  const styles = await cards.evaluateAll((nodes) =>
    nodes.map((node) => ({
      raw: node.getAttribute('data-gap-band'),
      border: getComputedStyle(node).borderLeftColor
    }))
  );
  for (const card of styles) {
    expect(card.raw).not.toBeNull();
    const band = Number(card.raw);
    expect(Number.isFinite(band)).toBe(true);
    expect(band).toBeGreaterThanOrEqual(0);
    expect(band).toBeLessThanOrEqual(100);
  }

  const low = styles.reduce((first, next) => (Number(next.raw) < Number(first.raw) ? next : first));
  const high = styles.reduce((first, next) => (Number(next.raw) > Number(first.raw) ? next : first));
  expect(Number(high.raw)).toBeGreaterThan(Number(low.raw));

  const green = (color) => {
    const match = /rgba?\(([^)]+)\)/.exec(color);
    if (!match) {
      return NaN;
    }
    const parts = match[1].split(/[ ,/]+/).filter(Boolean).map(Number);
    return parts[1];
  };
  expect(green(high.border)).toBeGreaterThan(green(low.border));

  const failures = await rankingCardContrastFailures(page);
  expect(failures, JSON.stringify(failures)).toEqual([]);
});

test('the occupation detail lists the nine domains', async ({ page }) => {
  await reachResults(page);

  const card = page.locator('#ranking details.ranking-card').first();
  await expect(card).toBeVisible();
  await card.focus();
  const cardFocused = await card.evaluate((node) => node === document.activeElement);
  if (!cardFocused) {
    await card.locator('summary').focus();
  }
  await page.keyboard.press('Enter');

  const dialog = page.locator('#occupation-detail');
  await expect(dialog).toBeVisible();
  await expect(page.locator('#occupation-detail-title')).not.toBeEmpty();
  await expect(page.locator('#occupation-detail-total')).toBeVisible();

  const rows = page.locator('#domain-list li[data-domain]');
  await expect(rows).toHaveCount(9);
  const domains = await rows.evaluateAll((nodes) =>
    nodes.map((node) => ({
      key: node.getAttribute('data-domain'),
      text: node.textContent.trim(),
      numbers: (node.textContent.match(/-?\d+(?:[.,]\d+)?/g) || []).map((value) =>
        Number(value.replace(',', '.'))
      ),
      hasBar: Boolean(node.querySelector('[class*="bar"], [role="progressbar"], progress, meter'))
    }))
  );
  for (const domain of domains) {
    expect(domain.key, 'each domain row needs a data-domain key').toBeTruthy();
    expect(domain.text.length, `domain ${domain.key} should render text`).toBeGreaterThan(0);
    expect(domain.numbers.length, `domain ${domain.key} should render a level and a gap`).toBeGreaterThanOrEqual(2);
    expect(
      domain.numbers.some((value) => Number.isInteger(value) && value >= 1 && value <= 5),
      `domain ${domain.key} should render a level between 1 and 5: ${JSON.stringify(domain.numbers)}`
    ).toBe(true);
    expect(
      domain.numbers.some((value) => Number.isFinite(value)),
      `domain ${domain.key} should render a numeric gap`
    ).toBe(true);
    expect(domain.hasBar, `domain ${domain.key} should render a bar`).toBe(true);
  }

  await assertLayoutIsSound(page);
  expect(await axeSerious(page)).toEqual([]);

  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
});

test('filters and CSV export work', async ({ page }) => {
  await reachResults(page);

  const resilienceFilter = page.locator('label[for="filter-exposure"]');
  await expect(resilienceFilter).toContainText(/Capability GAP/i);
  await expect(resilienceFilter).toContainText(/resilienza/i);

  await page.locator('#filter-similarity').fill('0.9');
  await expect(page.locator('#filter-similarity-value')).toHaveText(/\d+%/);
  await expect(page.locator('#ranking-count')).toContainText('professioni corrispondono ai filtri');

  await page.locator('#filter-similarity').fill('0');
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Esporta CSV' }).click()
  ]);
  const target = await download.path();
  const text = fs.readFileSync(target, 'utf8').replace(/^\ufeff/, '');
  const lines = text.trim().split('\n');
  expect(lines[0]).toContain('code;title;similarity');
  expect(lines.length).toBe(880);
});

test('the page runs from disk with no network request', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'phone-360', 'runs once');
  const requests = [];
  page.on('request', (request) => {
    if (/^https?:/i.test(request.url())) {
      requests.push(request.url());
    }
  });
  await page.goto(`file://${path.join(WEB_ROOT, 'index.html')}`);
  await page.locator('#start-occupations').click();
  await page.locator('#occupation-search').fill('chief');
  await page.locator('#occupation-results button[data-select-occupation]').first().click();
  await page.locator('#occupations-continue').click();
  await page.locator('#activities-done').click();
  await expect(page.locator('#screen-results')).toBeVisible();
  await expect(page.locator('#score-value')).toBeVisible();
  expect(requests).toEqual([]);
});

test('the intro names and links both sources', async ({ page }) => {
  const external = [];
  page.on('request', (request) => {
    const url = request.url();
    if (/^https?:/i.test(url) && /onetcenter\.org|aicapabilityindicators\.oecd\.org|doi\.org/i.test(url)) {
      external.push(url);
    }
  });

  await page.goto('/index.html');
  await expect(page.locator('#screen-intro')).toBeVisible();

  const onet = page.locator('#screen-intro a[href*="onetcenter.org"]');
  const oecd = page.locator('#screen-intro a[href*="aicapabilityindicators.oecd.org"]');
  const doi = page.locator('#screen-intro a[href*="doi.org/10.1787/f3da0f0a-en"]');
  await expect(onet).toHaveCount(1);
  await expect(oecd).toHaveCount(1);
  await expect(doi).toHaveCount(1);

  const container = await page.evaluate(() => {
    const needles = [
      'onetcenter.org',
      'aicapabilityindicators.oecd.org',
      'doi.org/10.1787/f3da0f0a-en'
    ];
    const intro = document.querySelector('#screen-intro');
    const links = needles.map((needle) =>
      Array.from(intro.querySelectorAll('a[href]')).find((link) => link.href.includes(needle))
    );
    if (links.some((link) => !link)) {
      return null;
    }
    let node = links[0];
    while (node && !links.every((link) => node.contains(link))) {
      node = node.parentElement;
    }
    if (!node || node === intro || node === document.body || node === document.documentElement) {
      return null;
    }
    return { tag: node.tagName.toLowerCase(), id: node.id || null, className: node.className || null };
  });
  expect(container, 'a dedicated sources container should wrap the three links').not.toBeNull();

  for (const link of [onet, oecd, doi]) {
    await expect(link).toBeVisible();
    await expect(link).toHaveAccessibleName(/\S/);
    await expect(link).toHaveAttribute('target', '_blank');
    await expect(link).toHaveAttribute('rel', /noopener/);
    const box = await link.boundingBox();
    expect(box, 'the source link should have a layout box').not.toBeNull();
    expect(box.height).toBeGreaterThanOrEqual(44);
  }

  expect(external).toEqual([]);
});

test('switches language without losing the flow', async ({ page }) => {
  await page.goto('/index.html');
  await expect(page.locator('html')).toHaveAttribute('lang', 'it');
  await expect(page).toHaveTitle('Escape AI - Profession Finder');
  await expect(page.locator('.brand')).toHaveText('Escape AI - Profession Finder');

  await page.selectOption('#locale', 'en');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page).toHaveTitle('Escape AI - Profession Finder');
  await expect(page.locator('.brand')).toHaveText('Escape AI - Profession Finder');
  await expect(page.locator('#start-occupations')).toHaveText('Choose occupations');
  await assertLayoutIsSound(page);
  expect(await axeSerious(page)).toEqual([]);

  await page.locator('#start-occupations').click();
  await page.locator('#occupation-search').fill('chief');
  await page.locator('#occupation-results button[data-select-occupation]').first().click();
  await page.locator('#occupations-continue').click();
  await page.locator('#activities-done').click();
  await expect(page.locator('#screen-results')).toBeVisible();
  await expect(page.locator('#score-scale')).toContainText(/less resilient/i);
  await expect(page.locator('#results-legend')).toContainText('lower');
  await expect(page.locator('#score-value')).toHaveText(/\d\.\d\d/);
  await assertLayoutIsSound(page);
  expect(await axeSerious(page)).toEqual([]);

  await page.selectOption('#locale', 'it');
  await expect(page.locator('html')).toHaveAttribute('lang', 'it');
  await expect(page.locator('#score-scale')).toContainText(/meno resilienza/i);
  await expect(page.locator('#score-value')).toHaveText(/\d,\d\d/);
});

test('no screen renders a raw translation key', async ({ page }) => {
  await page.goto('/index.html');
  await expect(page.locator('#screen-intro')).toBeVisible();
  await assertNoRawTranslationKeys(page);

  await page.locator('#start-occupations').click();
  await expect(page.locator('#screen-occupations')).toBeVisible();
  await assertNoRawTranslationKeys(page);

  await page.locator('#occupation-search').fill('chief');
  await page.locator('#occupation-results button[data-select-occupation]').first().click();
  await page.locator('#occupations-continue').click();
  await expect(page.locator('#screen-activities')).toBeVisible();
  await assertNoRawTranslationKeys(page);

  await page.locator('#activities-done').click();
  await expect(page.locator('#screen-results')).toBeVisible();
  await assertNoRawTranslationKeys(page);

  await page.selectOption('#locale', 'en');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await assertNoRawTranslationKeys(page);
});

test('every language renders and holds the layout', async ({ page }) => {
  await page.goto('/index.html');
  for (const locale of ['it', 'en', 'es', 'fr', 'zh', 'ar', 'hi']) {
    await page.selectOption('#locale', locale);
    await expect(page.locator('html')).toHaveAttribute('lang', locale);
    await expect(page.locator('html')).toHaveAttribute('dir', locale === 'ar' ? 'rtl' : 'ltr');
    await expect(page).toHaveTitle('Escape AI - Profession Finder');
    await expect(page.locator('.brand')).toHaveText('Escape AI - Profession Finder');
    await assertLayoutIsSound(page);
    expect(await axeSerious(page), locale).toEqual([]);
  }
  await page.selectOption('#locale', 'ar');
  await expect(page.locator('#intro-title')).toContainText('الاصطناعي');
  await page.selectOption('#locale', 'it');
  await expect(page.locator('#intro-title')).toContainText('Quanto');
});
