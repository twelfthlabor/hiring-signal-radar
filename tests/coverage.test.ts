import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { companies } from '../src/data/companies';
import type { CollectionStatus, CompanyProfile, MarketFile, NormalizedJob } from '../src/lib/types';
import { SECTORS } from '../src/lib/types';

test('expanded coverage has unique identities and generated outputs', () => {
  assert.equal(companies.length, 153);
  assert.equal(companies.filter((company) => !company.jobSeekerOnly).length, 130);
  assert.equal(companies.filter((company) => company.jobSeekerOnly).length, 23);
  assert.equal(new Set(companies.map((company) => company.id)).size, companies.length);
  const investorCompanies = companies.filter((company) => !company.jobSeekerOnly);
  assert.equal(new Set(investorCompanies.map((company) => company.ticker)).size, investorCompanies.length);
  assert.equal(companies.filter((company) => company.jobSeekerOnly && company.ticker).length, 0);

  const profiles = JSON.parse(fs.readFileSync('public/data/companies.json', 'utf8')) as CompanyProfile[];
  const jobs = JSON.parse(fs.readFileSync('public/data/jobs.json', 'utf8')) as NormalizedJob[];
  const status = JSON.parse(fs.readFileSync('public/data/status.json', 'utf8')) as CollectionStatus;
  const publicationHistory = JSON.parse(fs.readFileSync('public/data/publication-history.json', 'utf8')) as { basis: string; companies: Record<string, unknown[]> };
  const market = JSON.parse(fs.readFileSync('public/data/market.json', 'utf8')) as MarketFile;
  assert.equal(profiles.length, companies.length);
  assert.equal(profiles.filter((profile) => !Number.isInteger(profile.published7d) || !Number.isInteger(profile.publicationDelta7d) || !Number.isInteger(profile.published30d) || !Number.isFinite(profile.publicationIntensity7d)).length, 0);
  assert.equal(status.totalSources, companies.length);
  assert.equal(status.healthySources + status.staleSources, status.totalSources);
  assert.equal(status.healthySources + status.staleSources, companies.length);
  // Transient board outages are expected: a source goes stale only after 2
  // consecutive failures, and a few simultaneous transient outages must not
  // fail the pipeline. Cap stale sources at 5 (~3% of 153) so a genuinely
  // broken collection (provider-wide outage, parser regression) still fails.
  assert.ok(status.staleSources <= 5, `expected at most 5 stale sources, got ${status.staleSources}`);
  assert.ok(jobs.filter((job) => job.current).length > 15_000);
  assert.equal(jobs.filter((job) => !job.level).length, 0);
  assert.equal(jobs.filter((job) => !job.category).length, 0);
  assert.equal(jobs.filter((job) => !job.country).length, 0);
  assert.ok(jobs.filter((job) => job.current && job.country === 'Canada' && job.level === 'Entry level').length > 10);
  assert.equal(jobs.filter((job) => !job.sourceUrl.startsWith('https://')).length, 0);
  assert.equal(jobs.filter((job) => !['greenhouse', 'lever', 'ashby', 'workday', 'smartrecruiters', 'workable', 'recruitee'].includes(job.provider)).length, 0);
  assert.ok(jobs.filter((job) => !job.sourcePublishedAt).length < 5);
  assert.equal(jobs.filter((job) => /[?&](utm_|tracking=|indeed-apply-token=)/i.test(job.sourceUrl)).length, 0);
  assert.equal(profiles.filter((profile) => {
    const keys = Object.keys(profile.locationCounts).map((location) => location.toLocaleLowerCase('en-CA'));
    return new Set(keys).size !== keys.length;
  }).length, 0);
  assert.equal(publicationHistory.basis, 'official-publication-timestamps');
  assert.equal(Object.keys(publicationHistory.companies).length, companies.length);
  assert.equal(profiles.filter((profile) => !SECTORS.includes(profile.sector)).length, 0);
  assert.equal(new Set(SECTORS.map((sector) => market.sectors.find((entry) => entry.name === sector)?.name)).size, SECTORS.length);
  assert.equal(market.aggregates.currentOpenings, profiles.reduce((total, profile) => total + profile.currentOpenings, 0));
  assert.ok(Object.values(market.aggregates.levelCounts).some((count) => count > 0));

  for (const company of companies) {
    assert.equal(fs.existsSync(`public/data/companies/${company.id}.json`), true);
    assert.equal(fs.existsSync(`public/rss/${company.id}.xml`), true);
  }
});
