import fs from 'node:fs/promises';
import path from 'node:path';
import { companies } from '../src/data/companies';
import type { CollectionStatus, CollectorState, CompanyConfig, HistoryFile, NormalizedJob, PublicationHistoryFile } from '../src/lib/types';
import { buildPublicationSeries } from '../src/lib/publication-history';
import { profileFor } from './lib/metrics';
import { buildMarketFile } from './lib/market';
import { classifyJobCategory, classifyLevel, inferCountry } from './lib/classification';
import { deduplicateJobs, normalizeAshby, normalizeGreenhouse, normalizeLever, normalizeRecruitee, normalizeSmartRecruiters, normalizeWorkable, normalizeWorkday, normalizeSourceUrl, parseWorkdayToken, type AshbyJob, type GreenhouseJob, type LeverJob, type RecruiteeJob, type SmartRecruitersJob, type WorkableJob, type WorkdayJob } from './lib/normalize';
import { emptyCompanyState, emptyState, mergeFailedSnapshot, mergeSuccessfulSnapshot, pruneExpiredJobs, updateHistory } from './lib/state';

const root = process.cwd();
const statePath = path.join(root, 'data', 'state.json');
const historyPath = path.join(root, 'data', 'history.json');
const fixtureMode = process.argv.includes('--fixtures');
const materializeOnly = process.argv.includes('--materialize');
const now = process.env.COLLECTOR_NOW ? new Date(process.env.COLLECTOR_NOW) : new Date();
const timestamp = now.toISOString();
const day = timestamp.slice(0, 10);

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback;
    throw error;
  }
}

const FETCH_TIMEOUT_MS = 30_000;
const FETCH_MAX_ATTEMPTS = 2;
const FETCH_RETRY_AFTER_CAP_MS = 10_000;

// Worst-case budget: 30s timeout x 2 attempts + 0.5s backoff ~= 60.5s per
// board. A fast 429/5xx + capped Retry-After wait is strictly cheaper
// (~1s + <=10s + 30s ~= 41s) since one attempt cannot both time out fully
// and carry a Retry-After wait. Boards are collected in sequential batches
// of 8 over 153 companies (20 batches) => pathological all-timeout wall
// clock ~= 20 x 60.5s ~= 20.2 min, leaving ~10 min of the 30-minute job
// timeout for install/test/commit/build/deploy. Keep attempts/timeout small:
// every extra attempt adds ~20 x timeout to the pathological total.

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableFetchError(error: unknown): boolean {
  const name = error instanceof Error ? error.name : '';
  const message = error instanceof Error ? error.message : String(error);
  return name === 'AbortError' || name === 'TimeoutError'
    || /abort|timeout|timed out|ECONN|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|fetch failed|network/i.test(message);
}

function retryDelayMs(response: Response): number {
  if (response.status === 429) {
    const header = response.headers.get('retry-after');
    if (header) {
      const seconds = Number(header);
      const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - Date.now();
      if (Number.isFinite(ms) && ms > 0) return Math.min(ms, FETCH_RETRY_AFTER_CAP_MS);
    }
  }
  return 500;
}

async function fetchJson(url: string, init?: RequestInit, attempt = 1): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      headers: {
        'user-agent': `HiringSignalRadar/1.0 (+${process.env.PUBLIC_REPOSITORY_URL || 'https://github.com'})`,
        ...(init?.method === 'POST' ? { 'content-type': 'application/json' } : {}),
        ...init?.headers
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    });
  } catch (error) {
    if (attempt < FETCH_MAX_ATTEMPTS && isRetryableFetchError(error)) {
      await sleep(500);
      return fetchJson(url, init, attempt + 1);
    }
    throw error;
  }
  if (!response.ok) {
    if (attempt < FETCH_MAX_ATTEMPTS && (response.status === 429 || response.status >= 500)) {
      await sleep(retryDelayMs(response));
      return fetchJson(url, init, attempt + 1);
    }
    throw new Error(`HTTP ${response.status} from ${new URL(url).hostname}`);
  }
  return response.json();
}

const WORKDAY_PAGE_SIZE = 20;
const WORKDAY_PAGE_LIMIT = 500;

// NOTE: each Workday page goes through fetchJson with its own retry budget
// and pages are fetched sequentially, so worst-case per-company cost scales
// with page count. With a single Workday company this is tolerable and the
// workflow's 30-minute job timeout is the backstop; do not add per-page
// parallelism without revisiting the budget documented on fetchJson.
async function fetchWorkdayBoard(host: string, tenant: string, site: string): Promise<WorkdayJob[]> {
  const url = `https://${tenant}.${host}.myworkdayjobs.com/wday/cxs/${tenant}/${site}/jobs`;
  const postings: WorkdayJob[] = [];
  for (let offset = 0; offset < WORKDAY_PAGE_LIMIT * WORKDAY_PAGE_SIZE; offset += WORKDAY_PAGE_SIZE) {
    const payload = await fetchJson(url, { method: 'POST', body: JSON.stringify({ appliedFacets: {}, limit: WORKDAY_PAGE_SIZE, offset }) }) as { total?: number; jobPostings?: WorkdayJob[] };
    const page = payload.jobPostings;
    if (!Array.isArray(page)) throw new Error('Invalid Workday response');
    postings.push(...page);
    if (page.length === 0 || (typeof payload.total === 'number' && postings.length >= payload.total)) break;
  }
  return postings;
}

function boardTokensFor(company: CompanyConfig): string[] {
  return Array.isArray(company.boardToken) ? company.boardToken : [company.boardToken];
}

async function collectBoard(company: CompanyConfig, token: string): Promise<NormalizedJob[]> {
  const board = { ...company, boardToken: token } as const;
  if (fixtureMode) {
    const fixture = path.join(root, 'tests', 'fixtures', `${company.provider}.json`);
    const payload = await readJson<unknown>(fixture, emptyPayloadFor(company.provider));
    return normalizePayload(board, payload);
  }
  if (company.provider === 'greenhouse') {
    return normalizePayload(board, await fetchJson(`https://boards-api.greenhouse.io/v1/boards/${token}/jobs`));
  }
  if (company.provider === 'lever') {
    return normalizePayload(board, await fetchJson(`https://api.lever.co/v0/postings/${token}?mode=json`));
  }
  if (company.provider === 'ashby') {
    return normalizePayload(board, await fetchJson(`https://api.ashbyhq.com/posting-api/job-board/${token}`));
  }
  if (company.provider === 'smartrecruiters') {
    return normalizePayload(board, await fetchJson(`https://api.smartrecruiters.com/v1/companies/${token}/postings?limit=100`));
  }
  if (company.provider === 'workable') {
    return normalizePayload(board, await fetchJson(`https://apply.workable.com/api/v1/widget/accounts/${token}?details=true`));
  }
  if (company.provider === 'recruitee') {
    return normalizePayload(board, await fetchJson(`https://${token}.recruitee.com/api/offers/`));
  }
  const { host, tenant, site } = parseWorkdayToken(token);
  return normalizePayload(board, await fetchWorkdayBoard(host, tenant, site));
}

function emptyPayloadFor(provider: CompanyConfig['provider']): unknown {
  switch (provider) {
    case 'greenhouse': return { jobs: [] };
    case 'lever': return [];
    case 'ashby': return { jobs: [] };
    case 'smartrecruiters': return { content: [] };
    case 'workable': return { jobs: [] };
    case 'recruitee': return { offers: [] };
    case 'workday': return [];
  }
}

async function collectCompany(company: CompanyConfig): Promise<NormalizedJob[]> {
  const boards = await Promise.all(boardTokensFor(company).map((token) => collectBoard(company, token)));
  return deduplicateJobs(boards.flat());
}

function normalizePayload(company: CompanyConfig & { boardToken: string }, payload: unknown): NormalizedJob[] {
  if (company.provider === 'greenhouse') {
    const jobs = (payload as { jobs?: GreenhouseJob[] }).jobs;
    if (!Array.isArray(jobs)) throw new Error('Invalid Greenhouse response');
    return deduplicateJobs(jobs.map((job) => normalizeGreenhouse(job, company, day)));
  }
  if (company.provider === 'ashby') {
    const jobs = (payload as { jobs?: AshbyJob[] }).jobs;
    if (!Array.isArray(jobs)) throw new Error('Invalid Ashby response');
    return deduplicateJobs(jobs.filter((job) => job.isListed !== false).map((job) => normalizeAshby(job, company, day)));
  }
  if (company.provider === 'smartrecruiters') {
    const jobs = (payload as { content?: SmartRecruitersJob[] }).content;
    if (!Array.isArray(jobs)) throw new Error('Invalid SmartRecruiters response');
    return deduplicateJobs(jobs.map((job) => normalizeSmartRecruiters(job, company, day)));
  }
  if (company.provider === 'workable') {
    const jobs = (payload as { jobs?: WorkableJob[] }).jobs;
    if (!Array.isArray(jobs)) throw new Error('Invalid Workable response');
    return deduplicateJobs(jobs.map((job) => normalizeWorkable(job, company, day)));
  }
  if (company.provider === 'recruitee') {
    const jobs = (payload as { offers?: RecruiteeJob[] }).offers;
    if (!Array.isArray(jobs)) throw new Error('Invalid Recruitee response');
    return deduplicateJobs(jobs.map((job) => normalizeRecruitee(job, company, day)));
  }
  if (company.provider === 'workday') {
    if (!Array.isArray(payload)) throw new Error('Invalid Workday response');
    return deduplicateJobs((payload as WorkdayJob[]).map((job) => normalizeWorkday(job, company, day)));
  }
  if (!Array.isArray(payload)) throw new Error('Invalid Lever response');
  return deduplicateJobs((payload as LeverJob[]).map((job) => normalizeLever(job, company, day)));
}

function xml(value: string): string {
  return value.replace(/[<>&'\"]/g, (character) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[character]!);
}

function rssFor(company: CompanyConfig, jobs: NormalizedJob[], siteUrl: string, buildDate: Date): string {
  const items = jobs.filter((job) => job.current).sort((a, b) => b.firstSeen.localeCompare(a.firstSeen)).slice(0, 50).map((job) => `
    <item>
      <title>${xml(job.title)} — ${xml(job.location)}</title>
      <link>${xml(job.sourceUrl)}</link>
      <guid isPermaLink="false">${xml(job.id)}:${job.firstSeen}</guid>
      <pubDate>${new Date(`${job.firstSeen}T12:00:00Z`).toUTCString()}</pubDate>
      <description>${xml(`${job.function} role at ${company.name}. First seen by Hiring Signal Radar on ${job.firstSeen}.`)}</description>
    </item>`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
  <title>${xml(company.name)} hiring signals</title>
  <link>${xml(`${siteUrl}/companies/${company.id}/`)}</link>
  <description>Newly observed public job postings from ${xml(company.name)}.</description>
  <lastBuildDate>${buildDate.toUTCString()}</lastBuildDate>${items}
</channel></rss>`;
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(value)}\n`);
}

async function clearGeneratedFiles(directory: string, extension: string): Promise<void> {
  await fs.mkdir(directory, { recursive: true });
  const entries = await fs.readdir(directory, { withFileTypes: true });
  await Promise.all(entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(extension))
    .map((entry) => fs.unlink(path.join(directory, entry.name))));
}

async function main(): Promise<void> {
  const state = await readJson<CollectorState>(statePath, emptyState(day));
  for (const companyState of Object.values(state.companies)) {
    for (const job of Object.values(companyState.jobs)) {
      job.level ??= classifyLevel(job.title);
      job.category ??= classifyJobCategory(job.title);
      job.country ??= inferCountry(job.location);
      job.sourceUrl = normalizeSourceUrl(job.sourceUrl);
    }
  }
  const history = await readJson<HistoryFile>(historyPath, { trackingSince: state.trackingSince, companies: {} });
  const results: PromiseSettledResult<{ company: CompanyConfig; jobs: NormalizedJob[] }>[] = [];
  if (!materializeOnly) {
    state.lastRun = timestamp;
    const batchSize = 8;
    for (let index = 0; index < companies.length; index += batchSize) {
      const batch = companies.slice(index, index + batchSize);
      results.push(...await Promise.allSettled(batch.map(async (company) => ({ company, jobs: await collectCompany(company) }))));
    }
    results.forEach((result, index) => {
      const company = companies[index];
      if (result.status === 'fulfilled') {
        state.companies[company.id] = mergeSuccessfulSnapshot(state.companies[company.id], result.value.jobs, timestamp, day);
      } else {
        state.companies[company.id] = mergeFailedSnapshot(state.companies[company.id], timestamp, result.reason);
      }
      updateHistory(history, company, state.companies[company.id] ?? emptyCompanyState(), day);
    });
    const pruned = pruneExpiredJobs(state, day);
    if (pruned) console.log(`Pruned ${pruned} job records outside the five-year retention window.`);
    await writeJson(statePath, state);
    await writeJson(historyPath, history);
  }

  const generatedAt = state.lastRun || Object.values(state.companies).map((entry) => entry.lastSuccess).filter((value): value is string => Boolean(value)).sort().at(-1) || timestamp;
  const generatedDay = generatedAt.slice(0, 10);
  const allJobs = companies.flatMap((company) => Object.values(state.companies[company.id]?.jobs ?? {}));
  const status: CollectionStatus = {
    trackingSince: state.trackingSince,
    generatedAt,
    lastSuccessfulRefresh: Object.values(state.companies).map((entry) => entry.lastSuccess).filter(Boolean).sort().at(-1),
    totalSources: companies.length,
    healthySources: companies.filter((company) => !state.companies[company.id]?.stale).length,
    staleSources: companies.filter((company) => state.companies[company.id]?.stale).length,
    companies: Object.fromEntries(companies.map((company) => {
      const entry = state.companies[company.id] ?? emptyCompanyState();
      return [company.id, { stale: entry.stale, lastAttempt: entry.lastAttempt, lastSuccess: entry.lastSuccess, consecutiveFailures: entry.consecutiveFailures, error: entry.error }];
    }))
  };

  const profiles = companies.map((company) => profileFor(company, state.companies[company.id] ?? emptyCompanyState(), history.companies[company.id] ?? [], generatedDay));
  const publicJobs = allJobs.map(({ missingCount: _missingCount, ...job }) => job).sort((a, b) => b.firstSeen.localeCompare(a.firstSeen) || a.company.localeCompare(b.company));
  const publicationHistory: PublicationHistoryFile = {
    generatedAt,
    basis: 'official-publication-timestamps',
    limitation: 'Backfilled from publication timestamps on roles observed by the collector. Roles removed before tracking began are not represented.',
    companies: Object.fromEntries(companies.map((company) => [company.id, buildPublicationSeries(allJobs.filter((job) => job.companyId === company.id), generatedDay)]))
  };

  await writeJson(path.join(root, 'public', 'data', 'status.json'), status);
  await writeJson(path.join(root, 'public', 'data', 'companies.json'), profiles);
  await writeJson(path.join(root, 'public', 'data', 'jobs.json'), publicJobs);
  await writeJson(path.join(root, 'public', 'data', 'publication-history.json'), publicationHistory);
  await writeJson(path.join(root, 'public', 'data', 'market.json'), buildMarketFile(profiles, allJobs, generatedDay, generatedAt));

  const companyDataDirectory = path.join(root, 'public', 'data', 'companies');
  const rssDirectory = path.join(root, 'public', 'rss');
  await Promise.all([
    clearGeneratedFiles(companyDataDirectory, '.json'),
    clearGeneratedFiles(rssDirectory, '.xml')
  ]);

  const siteUrl = (process.env.PUBLIC_SITE_URL || process.env.SITE_URL || 'http://localhost:4321').replace(/\/$/, '');
  const buildDate = new Date(generatedAt);
  await Promise.all(companies.map(async (company) => {
    const companyJobs = allJobs.filter((job) => job.companyId === company.id);
    await writeJson(path.join(companyDataDirectory, `${company.id}.json`), {
      profile: profiles.find((profile) => profile.id === company.id),
      status: status.companies[company.id],
      history: history.companies[company.id] ?? [],
      publicationHistory: publicationHistory.companies[company.id] ?? [],
      jobs: companyJobs.map(({ missingCount: _missingCount, ...job }) => job)
    });
    await fs.writeFile(path.join(rssDirectory, `${company.id}.xml`), rssFor(company, companyJobs, siteUrl, buildDate));
  }));

  if (!materializeOnly) {
    for (const [index, result] of results.entries()) {
      const company = companies[index];
      console.log(`${result.status === 'fulfilled' ? '✓' : '×'} ${company.name}: ${result.status === 'fulfilled' ? `${result.value.jobs.length} roles` : String(result.reason)}`);
    }
  }
  console.log(`Generated ${publicJobs.filter((job) => job.current).length} current roles across ${companies.length} employer-direct boards.`);
}

await main();
