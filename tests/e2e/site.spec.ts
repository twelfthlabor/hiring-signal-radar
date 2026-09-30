import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Locator } from '@playwright/test';
import { companyPatterns, patterns } from '../../src/lib/insights';
import type { CompanyProfile, HistoryFile, NormalizedJob } from '../../src/lib/types';

type ChartPayload = { labels: string[]; datasets: Array<{ label: string; data: number[] }> };

const parseChartData = (wrapper: Locator): Promise<ChartPayload> =>
  wrapper.locator('.chart-data').evaluate<ChartPayload, HTMLElement>((element) => JSON.parse(element.textContent || '{}'));

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

type ExpectedPatterns = { day: string; feedCount: number; companyCount: number };
let expectedCache: ExpectedPatterns | undefined;

/**
 * Expected pattern counts from the same committed inputs the pages build from:
 * `data/history.json` plus `public/data/jobs.json`, scored by the real detector
 * module at the latest history date (see `patternDay` in src/pages/index.astro
 * and src/pages/companies/[slug].astro). Skips are gated on these counts, so a
 * missing feed attribute is a failure, never a silent skip.
 */
const expectedPatterns = (): ExpectedPatterns => {
  if (expectedCache) return expectedCache;
  const readJson = <T>(path: string): T => JSON.parse(readFileSync(resolve(repoRoot, path), 'utf8')) as T;
  const history = readJson<HistoryFile>('data/history.json');
  const profiles = readJson<CompanyProfile[]>('public/data/companies.json');
  const jobs = readJson<NormalizedJob[]>('public/data/jobs.json');
  const investorCompanyIds = new Set(profiles.filter((profile) => !profile.jobSeekerOnly).map((profile) => profile.id));
  const days: string[] = [];
  for (const points of Object.values(history.companies)) for (const point of points) days.push(point.date);
  days.sort();
  const day = days.at(-1) ?? '';
  expectedCache = {
    day,
    feedCount: day ? patterns(history, jobs.filter((job) => investorCompanyIds.has(job.companyId)), day).length : 0,
    companyCount: day ? companyPatterns('cloudflare', history, jobs, day).length : 0
  };
  return expectedCache;
};

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
  const { day, feedCount } = expectedPatterns();
  test.skip(feedCount === 0, `No patterns expected: patterns(history, jobs, ${day}) returned 0.`);
  await page.goto('/');
  const feed = page.locator('[data-pattern-feed]');
  await expect(feed).toBeVisible();
  await expect(feed.locator('li')).toHaveCount(feedCount);

  const entries = await feed.locator('li').evaluateAll((items) => items.map((item) => ({
    kind: item.querySelector('.pattern-kind')?.textContent?.trim() ?? '',
    headline: item.querySelector('h3')?.textContent?.trim() ?? '',
    detail: item.querySelector('p')?.textContent?.trim() ?? ''
  })));
  expect(entries.every((entry) => entry.kind && entry.headline && entry.detail)).toBe(true);
  expect(entries.some((entry) => /\d/.test(entry.detail))).toBe(true);

  // Market-wide-only feeds legitimately contain no company links.
  const companyLink = feed.locator('a.pattern-company').first();
  if ((await companyLink.count()) > 0) {
    await expect(companyLink).toHaveAttribute('href', /\/companies\/[^/]+\//);
    await companyLink.click();
    await expect(page).toHaveURL(/\/companies\/[^/]+\//);
  }
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
  const { day, companyCount } = expectedPatterns();
  test.skip(companyCount === 0, `No company patterns expected: companyPatterns('cloudflare', history, jobs, ${day}) returned 0.`);
  await page.goto('/companies/cloudflare/');
  const block = page.locator('[data-company-patterns]');
  await expect(block).toBeVisible();
  const rows = block.locator('[data-pattern-feed] > li');
  expect(await rows.count()).toBeGreaterThanOrEqual(companyCount);
});

test('mobile pages do not overflow horizontally', async ({ page }, testInfo) => {
  test.skip(!testInfo.project.name.includes('mobile'), 'Mobile-only layout assertion');
  for (const path of ['/', '/jobs/', '/status/', '/companies/cloudflare/']) {
    await page.goto(path);
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  }
});
