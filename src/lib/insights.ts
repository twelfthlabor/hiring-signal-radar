/**
 * Pure, dependency-free pattern analysis over collected hiring snapshots.
 *
 * Inputs are the daily snapshot history (`HistoryFile`) and observed job records
 * (`NormalizedJob[]`); outputs are ranked, evidence-backed findings. No I/O.
 *
 * Conventions:
 * - Dates are ISO `YYYY-MM-DD`; lexicographic order equals chronological order
 *   and all date math happens in UTC.
 * - The first collection day is an incomplete baseline: aggregate dates below
 *   `minCoverage` are dropped and the earliest observed point never counts
 *   toward churn.
 * - Insufficient history disables a detector instead of throwing; no output
 *   contains NaN.
 *
 * Detector thresholds (repeated at each implementation):
 * - expansion / contraction: mean `current` of the last 7 observations vs the
 *   prior 7; steady when |delta| < max(3, 10% of the prior mean).
 * - burst: trailing-7-day `opened` >= max(5, 2 x median weekly `opened` of the
 *   prior three weeks), with at least 21 days of points before the window.
 * - churn: trailing-7-day gross (opened + removed) >= 10 and
 *   |opened - removed| <= 25% of gross; the earliest point must precede the
 *   window. Evaluated per company: a market-wide gross would fire every period.
 * - function-shift: |delta| >= 3 roles or >= 25% relative (only when prior > 0).
 *
 * Ranking heuristic (`score`, 0..100, higher = more notable):
 * - expansion / contraction: |delta| + min(50, relative %).
 * - burst: 2 x trailing opened + 10 x spike ratio (opened / prior median opened).
 * - churn: 2 x trailing gross.
 * - function-shift: |delta| + min(50, relative %).
 */
import type { DailyCompanyPoint, HistoryFile, NormalizedJob, RoleFunction } from './types';

const DAY_MS = 86_400_000;
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** Trailing window used by every detector. */
const DETECTOR_DAYS = 7;
/** Ranked findings returned by `patterns` / `companyPatterns`. */
const MAX_PATTERNS = 12;
/** burst: minimum trailing-7d opened. */
const BURST_MIN_OPENED = 5;
/** burst: days of history required before the trailing window. */
const BURST_MIN_HISTORY_DAYS = 21;
/** churn: minimum trailing-7d opened + removed. */
const CHURN_MIN_GROSS = 10;
/** churn: allowed |opened - removed| share of gross. */
const CHURN_BALANCE = 0.25;
/** function-shift: absolute role delta. */
const SHIFT_MIN_DELTA = 3;
/** function-shift: relative role delta (when the prior count is positive). */
const SHIFT_MIN_RELATIVE = 0.25;

/**
 * Canonical role-function order. Typing this as `Record<RoleFunction, true>`
 * makes compilation fail if `types.ts` gains a function, so the list cannot
 * drift from the declared union.
 */
const ROLE_FUNCTION_FLAGS: Record<RoleFunction, true> = {
  Engineering: true,
  'AI / Data': true,
  Product: true,
  'Sales / Marketing': true,
  Customer: true,
  Operations: true,
  'Hardware / Field': true,
  'Clinical / Science': true,
  Corporate: true,
  Other: true
};
const ROLE_ORDER = Object.keys(ROLE_FUNCTION_FLAGS) as RoleFunction[];

export interface InventoryPoint {
  date: string;
  current: number;
  opened: number;
  removed: number;
}

export interface Direction {
  state: 'expanding' | 'contracting' | 'steady';
  delta: number;
  recentAvg: number;
  priorAvg: number;
  days: number;
}

export interface FunctionMomentum {
  function: RoleFunction;
  current: number;
  prior: number;
  delta: number;
}

export interface Pattern {
  kind: 'expansion' | 'contraction' | 'burst' | 'churn' | 'function-shift';
  companyId: string | null;
  function?: RoleFunction;
  headline: string;
  detail: string;
  score: number;
}

function isoDay(value: string | undefined | null): string | null {
  if (typeof value !== 'string') return null;
  const day = value.slice(0, 10);
  if (!DAY_PATTERN.test(day)) return null;
  return Number.isFinite(Date.parse(`${day}T00:00:00Z`)) ? day : null;
}

function shiftDay(day: string, offset: number): string | null {
  const timestamp = Date.parse(`${day}T00:00:00Z`);
  if (!Number.isFinite(timestamp)) return null;
  return new Date(timestamp + offset * DAY_MS).toISOString().slice(0, 10);
}

/** Coerces missing / non-finite counts to 0 so no output can contain NaN. */
function count(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function mean(values: number[]): number {
  let total = 0;
  for (const value of values) total += value;
  return total / values.length;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return round1(sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2);
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Date-sorted copy of a company's snapshot series with only the inventory
 * fields. Points with an invalid date are dropped; non-finite counts become 0.
 * The `stale` flag is intentionally not carried over (see `aggregateInventory`).
 */
export function inventorySeries(points: DailyCompanyPoint[]): InventoryPoint[] {
  const series: InventoryPoint[] = [];
  for (const point of Array.isArray(points) ? points : []) {
    const date = isoDay(point?.date);
    if (!date) continue;
    series.push({ date, current: count(point.current), opened: count(point.opened), removed: count(point.removed) });
  }
  return series.sort((a, b) => compareStrings(a.date, b.date));
}

/**
 * Market-wide sums per observed date. A date is included only when the share of
 * companies in `history` with a (fresh) point that date is >= `minCoverage`;
 * this drops partial snapshots such as the incomplete first tracking day.
 * Stale points are frozen last-known counts and are excluded from both the sums
 * and the coverage count; dates never observed are never synthesized.
 */
export function aggregateInventory(history: HistoryFile, minCoverage = 0.9): InventoryPoint[] {
  const companies = Object.values(history?.companies ?? {});
  const total = companies.length;
  if (!total) return [];
  const coverage = typeof minCoverage === 'number' && Number.isFinite(minCoverage) ? minCoverage : 0.9;
  const byDate = new Map<string, { companies: number; current: number; opened: number; removed: number }>();

  for (const points of companies) {
    const perCompany = new Map<string, { current: number; opened: number; removed: number }>();
    for (const point of Array.isArray(points) ? points : []) {
      if (point?.stale) continue;
      const date = isoDay(point?.date);
      if (!date) continue;
      const bucket = perCompany.get(date) ?? { current: 0, opened: 0, removed: 0 };
      bucket.current += count(point.current);
      bucket.opened += count(point.opened);
      bucket.removed += count(point.removed);
      perCompany.set(date, bucket);
    }
    for (const [date, bucket] of perCompany) {
      const target = byDate.get(date) ?? { companies: 0, current: 0, opened: 0, removed: 0 };
      target.companies += 1;
      target.current += bucket.current;
      target.opened += bucket.opened;
      target.removed += bucket.removed;
      byDate.set(date, target);
    }
  }

  return [...byDate.entries()]
    .filter(([, bucket]) => bucket.companies / total >= coverage)
    .sort(([a], [b]) => compareStrings(a, b))
    .map(([date, bucket]) => ({ date, current: bucket.current, opened: bucket.opened, removed: bucket.removed }));
}

/**
 * Direction of the `current` inventory at `day`.
 *
 * Exact rule: take the observations at or before `day` (point-count windows, so
 * sparse collection dates cannot fabricate a null). `recentAvg` is the mean of
 * the last `days` observations, `priorAvg` the mean of the `days` before those;
 * fewer than `days * 2` usable observations returns null. `delta` is
 * recentAvg - priorAvg and the steady band is |delta| < max(3, 10% of
 * priorAvg); positive deltas at or above the band expand, negative ones contract.
 * Averages and delta are reported to 1 decimal; classification uses raw values.
 */
export function directionOf(points: InventoryPoint[], day: string, days = 7): Direction | null {
  const target = isoDay(day);
  const window = Math.floor(days);
  if (!target || !Number.isFinite(days) || window < 1) return null;

  const usable: InventoryPoint[] = [];
  for (const point of Array.isArray(points) ? points : []) {
    const date = isoDay(point?.date);
    if (!date || date > target) continue;
    usable.push({ date, current: count(point.current), opened: count(point.opened), removed: count(point.removed) });
  }
  usable.sort((a, b) => compareStrings(a.date, b.date));
  if (usable.length < window * 2) return null;

  const recentAvg = mean(usable.slice(-window).map((point) => point.current));
  const priorAvg = mean(usable.slice(-window * 2, -window).map((point) => point.current));
  const delta = recentAvg - priorAvg;
  const band = Math.max(3, 0.1 * priorAvg);
  const state = delta >= band ? 'expanding' : delta <= -band ? 'contracting' : 'steady';
  return { state, delta: round1(delta), recentAvg: round1(recentAvg), priorAvg: round1(priorAvg), days: window };
}

/**
 * Count of jobs open at `day`, by role function: `firstSeen <= day` and either
 * no `removedAt` or `removedAt > day`. Counts of zero are omitted; an
 * unparseable `removedAt` is treated as absent (still open).
 */
export function derivedFunctionInventory(jobs: NormalizedJob[], day: string): Partial<Record<RoleFunction, number>> {
  const target = isoDay(day);
  if (!target) return {};
  const counts: Partial<Record<RoleFunction, number>> = {};
  for (const job of Array.isArray(jobs) ? jobs : []) {
    if (!job) continue;
    const firstSeen = isoDay(job.firstSeen);
    if (!firstSeen || firstSeen > target) continue;
    const removedAt = isoDay(job.removedAt);
    if (removedAt && removedAt <= target) continue;
    counts[job.function] = (counts[job.function] ?? 0) + 1;
  }
  return counts;
}

/**
 * Per-function derived inventory at `day` versus `day - days`, for all ten role
 * functions, sorted by |delta| descending (ties keep canonical function order).
 *
 * Ramp guard: returns [] unless both snapshot days are at least `days` after
 * the earliest `firstSeen` in the input, so the incomplete first tracked days
 * cannot look like real role movement.
 */
export function functionMomentum(jobs: NormalizedJob[], day: string, days = 7): FunctionMomentum[] {
  const target = isoDay(day);
  const window = Math.floor(days);
  if (!target || !Number.isFinite(days) || window < 1) return [];

  const priorDay = shiftDay(target, -window);
  if (!priorDay) return [];

  let earliest: string | null = null;
  for (const job of Array.isArray(jobs) ? jobs : []) {
    const firstSeen = isoDay(job?.firstSeen);
    if (firstSeen && (!earliest || firstSeen < earliest)) earliest = firstSeen;
  }
  if (!earliest) return [];
  const floor = shiftDay(earliest, window);
  if (!floor || priorDay < floor || target < floor) return [];

  const current = derivedFunctionInventory(jobs, target);
  const prior = derivedFunctionInventory(jobs, priorDay);
  return ROLE_ORDER.map((fn) => {
    const now = current[fn] ?? 0;
    const before = prior[fn] ?? 0;
    return { function: fn, current: now, prior: before, delta: now - before };
  }).sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta) || ROLE_ORDER.indexOf(a.function) - ROLE_ORDER.indexOf(b.function));
}

/** expansion / contraction pattern for a `directionOf` result. */
function directionPattern(direction: Direction, companyId: string | null): Pattern {
  const expanding = direction.state === 'expanding';
  const magnitude = Math.abs(direction.delta);
  const relative = Math.min(50, (magnitude / Math.max(1, direction.priorAvg)) * 100);
  const sign = direction.delta > 0 ? '+' : '';
  return {
    kind: expanding ? 'expansion' : 'contraction',
    companyId,
    headline: `${companyId ? '' : 'Market '}open roles ${expanding ? 'expanding' : 'contracting'}`,
    detail: `${sign}${direction.delta} open roles in ${direction.days} days (${direction.priorAvg} → ${direction.recentAvg}).`,
    score: Math.min(100, Math.round(magnitude + relative))
  };
}

/**
 * burst: trailing-7-day `opened` >= max(5, 2 x median weekly `opened` over the
 * prior three weeks). Requires at least 21 days of points before the window and
 * at least two of the three prior weeks observed.
 */
function burstPattern(series: InventoryPoint[], day: string, companyId: string): Pattern | null {
  const windowStart = shiftDay(day, -(DETECTOR_DAYS - 1));
  if (!windowStart) return null;
  const floor = shiftDay(windowStart, -BURST_MIN_HISTORY_DAYS);
  const first = series[0];
  if (!floor || !first || first.date > floor) return null;

  const weekly: number[] = [];
  for (let week = 1; week <= 3; week += 1) {
    const end = shiftDay(day, -DETECTOR_DAYS * week);
    const start = end ? shiftDay(end, -(DETECTOR_DAYS - 1)) : null;
    if (!start || !end) continue;
    const observed = series.filter((point) => point.date >= start && point.date <= end);
    if (observed.length) weekly.push(observed.reduce((sum, point) => sum + point.opened, 0));
  }
  if (weekly.length < 2) return null;

  const medianOpened = median(weekly);
  const trailingOpened = series
    .filter((point) => point.date >= windowStart && point.date <= day)
    .reduce((sum, point) => sum + point.opened, 0);
  if (trailingOpened < Math.max(BURST_MIN_OPENED, 2 * medianOpened)) return null;

  const ratio = trailingOpened / Math.max(1, medianOpened);
  return {
    kind: 'burst',
    companyId,
    headline: 'New-posting burst',
    detail: `Opened ${trailingOpened} postings in the last 7 days vs a prior weekly median of ${medianOpened}.`,
    score: Math.min(100, Math.round(trailingOpened * 2 + ratio * 10))
  };
}

/**
 * churn: trailing-7-day gross (opened + removed) >= 10 and
 * |opened - removed| <= 25% of gross. The earliest observed point must fall
 * before the window so the incomplete baseline day cannot fake churn.
 */
function churnPattern(series: InventoryPoint[], day: string, companyId: string): Pattern | null {
  const windowStart = shiftDay(day, -(DETECTOR_DAYS - 1));
  const first = series[0];
  if (!windowStart || !first || first.date >= windowStart) return null;

  const window = series.filter((point) => point.date >= windowStart && point.date <= day);
  if (!window.length) return null;
  const opened = window.reduce((sum, point) => sum + point.opened, 0);
  const removed = window.reduce((sum, point) => sum + point.removed, 0);
  const gross = opened + removed;
  if (gross < CHURN_MIN_GROSS || Math.abs(opened - removed) > CHURN_BALANCE * gross) return null;

  return {
    kind: 'churn',
    companyId,
    headline: 'Posting churn',
    detail: `Opened ${opened} and removed ${removed} postings in the last 7 days (gross ${gross}).`,
    score: Math.min(100, gross * 2)
  };
}

/**
 * function-shift: |delta| >= 3 roles or >= 25% relative (relative only when the
 * prior count is positive; a zero prior needs the absolute threshold).
 */
function functionShiftPatterns(momentum: FunctionMomentum[], companyId: string | null): Pattern[] {
  const found: Pattern[] = [];
  for (const entry of momentum) {
    const magnitude = Math.abs(entry.delta);
    const relative = entry.prior > 0 ? magnitude / entry.prior : 0;
    if (magnitude < SHIFT_MIN_DELTA && relative < SHIFT_MIN_RELATIVE) continue;
    const sign = entry.delta > 0 ? '+' : '';
    found.push({
      kind: 'function-shift',
      companyId,
      function: entry.function,
      headline: `${companyId ? '' : 'Market '}role-mix shift`,
      detail: `${entry.function} open roles ${sign}${entry.delta} in ${DETECTOR_DAYS} days (${entry.prior} → ${entry.current}).`,
      score: Math.min(100, Math.round(magnitude + Math.min(50, relative * 100)))
    });
  }
  return found;
}

function rank(found: Pattern[]): Pattern[] {
  return found
    .sort(
      (a, b) =>
        b.score - a.score ||
        compareStrings(a.companyId ?? '', b.companyId ?? '') ||
        compareStrings(a.function ?? '', b.function ?? '') ||
        compareStrings(a.kind, b.kind)
    )
    .slice(0, MAX_PATTERNS);
}

/** Same detectors as `patterns`, restricted to one company. */
export function companyPatterns(companyId: string, history: HistoryFile, jobs: NormalizedJob[], day: string): Pattern[] {
  const target = isoDay(day);
  if (!target) return [];
  const series = inventorySeries(history?.companies?.[companyId] ?? []);
  const found: Pattern[] = [];

  const direction = directionOf(series, target, DETECTOR_DAYS);
  if (direction && direction.state !== 'steady') found.push(directionPattern(direction, companyId));
  const burst = burstPattern(series, target, companyId);
  if (burst) found.push(burst);
  const churn = churnPattern(series, target, companyId);
  if (churn) found.push(churn);

  const companyJobs = Array.isArray(jobs) ? jobs.filter((job) => job?.companyId === companyId) : [];
  if (companyJobs.length) found.push(...functionShiftPatterns(functionMomentum(companyJobs, target, DETECTOR_DAYS), companyId));

  return rank(found);
}

/**
 * Ranked notable findings for every company in `history` plus market-wide
 * entries (`companyId: null`): expansion / contraction from `directionOf`,
 * burst and churn per company, and function-shift market-wide and per company.
 * Sorted by `score` descending, capped at 12; insufficient history means a
 * detector simply does not fire.
 */
export function patterns(history: HistoryFile, jobs: NormalizedJob[], day: string): Pattern[] {
  const target = isoDay(day);
  if (!target) return [];
  const found: Pattern[] = [];

  const marketDirection = directionOf(aggregateInventory(history), target, DETECTOR_DAYS);
  if (marketDirection && marketDirection.state !== 'steady') found.push(directionPattern(marketDirection, null));
  found.push(...functionShiftPatterns(functionMomentum(jobs, target, DETECTOR_DAYS), null));

  for (const companyId of Object.keys(history?.companies ?? {})) {
    found.push(...companyPatterns(companyId, history, jobs, target));
  }

  return rank(found);
}
