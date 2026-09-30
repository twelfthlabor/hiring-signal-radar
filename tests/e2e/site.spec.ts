import { expect, test, type Locator } from '@playwright/test';

type ChartPayload = { labels: string[]; datasets: Array<{ label: string; data: number[] }> };

const parseChartData = (wrapper: Locator): Promise<ChartPayload> =>
  wrapper.locator('.chart-data').evaluate<ChartPayload, HTMLElement>((element) => JSON.parse(element.textContent || '{}'));

test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  (page as typeof page & { qaErrors?: string[] }).qaErrors = errors;
});

test.afterEach(async ({ page }) => {
  expect((page as typeof page & { qaErrors?: string[] }).qaErrors ?? []).toEqual([]);
});

test('home exposes trust, navigation, and metadata', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('h1')).toContainText('companies are');
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', /^https?:\/\/[^/]+\/$/);
  await expect(page.locator('meta[property="og:title"]')).toHaveAttribute('content', /Hiring Signal Radar/);
  await expect(page.getByRole('link', { name: 'Skip to content' })).toHaveAttribute('href', '#main');
  const warning = page.locator('[data-dataset-warning]');
  const generatedAt = await warning.getAttribute('data-generated-at');
  const overdue = !generatedAt || Date.now() - Date.parse(generatedAt) > 48 * 60 * 60 * 1000;
  if (overdue) await expect(warning).toBeVisible();
  else await expect(warning).toBeHidden();
});

test('job index loads lazily and filters roles', async ({ page }) => {
  await page.goto('/jobs/');
  const list = page.locator('[data-job-list]');
  await expect(list).toHaveAttribute('aria-busy', 'false', { timeout: 60_000 });
  await expect(list.locator('.job-card')).toHaveCount(25);
  await page.locator('#title-filter').fill('machine learning');
  await expect(page.locator('[data-result-count]')).not.toHaveText('0');
  await expect(list.locator('.job-card').first()).toContainText(/machine learning/i);
});

test('status page lists every configured source', async ({ page }) => {
  await page.goto('/status/');
  await expect(page.getByRole('heading', { name: 'Trust the timestamp.' })).toBeVisible();
  const sourceCount = await page.evaluate(async () => {
    const status = await fetch('/data/status.json').then((response) => response.json());
    return Object.keys(status.companies).length;
  });
  await expect(page.locator('tbody tr')).toHaveCount(sourceCount);
});

test('home inventory chart renders with a multi-series payload and working range controls', async ({ page }) => {
  await page.goto('/');
  const wrapper = page.locator('[data-inventory-chart]');
  await expect(wrapper).toBeVisible();
  await expect(page.locator('#inventory-title')).toBeVisible();

  const payload = await parseChartData(wrapper);
  expect(payload.labels.length).toBeGreaterThanOrEqual(10);
  expect(payload.labels.every((label) => typeof label === 'string' && /\d/.test(label))).toBe(true);
  expect(payload.datasets.length).toBeGreaterThanOrEqual(3);
  expect(payload.datasets.every((dataset) => dataset.label.length > 0 && dataset.data.length === payload.labels.length)).toBe(true);

  const canvas = wrapper.locator('canvas');
  await expect(canvas).toBeVisible();
  await wrapper.locator('[data-range="30"]').click();
  await expect(wrapper.locator('[data-range="30"]')).toHaveClass(/active/);
  await expect(wrapper.locator('[data-range="90"]')).not.toHaveClass(/active/);
  await expect(canvas).toBeVisible();
});

test('home pattern feed lists entries with numeric evidence and company links', async ({ page }) => {
  await page.goto('/');
  const feed = page.locator('[data-pattern-feed]');
  if ((await feed.count()) === 0) test.skip(true, 'Pattern feed absent: current history data yields no patterns.');
  await expect(feed).toBeVisible();

  const entries = await feed.locator('li').evaluateAll((items) => items.map((item) => ({
    kind: item.querySelector('.pattern-kind')?.textContent?.trim() ?? '',
    headline: item.querySelector('h3')?.textContent?.trim() ?? '',
    detail: item.querySelector('p')?.textContent?.trim() ?? ''
  })));
  expect(entries.length).toBeGreaterThanOrEqual(1);
  expect(entries.every((entry) => entry.kind && entry.headline && entry.detail)).toBe(true);
  expect(entries.some((entry) => /\d/.test(entry.detail))).toBe(true);

  const companyLink = feed.locator('a.pattern-company').first();
  await expect(companyLink).toHaveAttribute('href', /\/companies\/[^/]+\//);
  await companyLink.click();
  await expect(page).toHaveURL(/\/companies\/[^/]+\//);
});

test('company page renders its inventory chart', async ({ page }) => {
  await page.goto('/companies/cloudflare/');
  const wrapper = page.locator('[data-company-inventory-chart]');
  await expect(wrapper).toBeVisible();
  await expect(wrapper.locator('canvas')).toBeVisible();

  const payload = await parseChartData(wrapper);
  expect(payload.labels.length).toBeGreaterThanOrEqual(1);
  expect(payload.datasets.length).toBeGreaterThanOrEqual(1);
  expect(payload.datasets.every((dataset) => dataset.label.length > 0 && dataset.data.length === payload.labels.length)).toBe(true);
});

test('company page lists pattern signals', async ({ page }) => {
  await page.goto('/companies/cloudflare/');
  const block = page.locator('[data-company-patterns]');
  if ((await block.count()) === 0) test.skip(true, 'Company pattern block absent: current history data yields no company patterns.');
  await expect(block).toBeVisible();
  const rows = block.locator('[data-pattern-feed] > li');
  expect(await rows.count()).toBeGreaterThanOrEqual(1);
});

test('mobile pages do not overflow horizontally', async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.includes('mobile'), 'Mobile-only layout assertion');
  for (const path of ['/', '/jobs/', '/status/', '/companies/cloudflare/']) {
    await page.goto(path);
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  }
});
