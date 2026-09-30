/**
 * Pure, dependency-free pattern analysis over collected hiring snapshots.
 *
 * Inputs are the daily snapshot history (`HistoryFile`) and observed job records
 * (`NormalizedJob[]`); outputs are ranked, evidence-backed findings. No I/O.
 *
 * Conventions:
 * - Dates are ISO `YYYY-MM-DD`; lexicographic order equals chronological order
 *   and all date math happens in UTC.
 * - A snapshot date is aggregated only when it covers at least `minCoverage` of
 *   the companies tracked by that date (companies whose first point is later do
 *   not count against it), so late config additions cannot drop old dates. The
 *   first tracking day passes that rule and is charted; calling out its
 *   incompleteness is a provenance/UI concern.
 * - `opened` / `removed` are day flow. A collection gap makes the next snapshot
 *   lump all accumulated flow, so flow detectors (burst, churn, function
 *   momentum) require gap-free observation across the window they claim.
 * - Insufficient history or collection gaps disable a detector instead of
 *   throwing; no output contains NaN.
 *
 * Detector thresholds (repeated at each implementation):
 * - expansion / contraction: mean `current` of the last 7 calendar days vs the
 *   prior 7; requires all 14 days ending at `day` to be observed. Steady when
 *   |delta| < max(3, 10% of the prior mean).
 * - burst: trailing-7-day `opened` >= max(5, 2 x median weekly `opened` of the
 *   prior three weeks), with at least 21 days of points before the window.
 * - churn: trailing-7-day gross (opened + removed) >= 10 and
 *   |opened - removed| <= 25% of gross. Company-only: a market-wide gross would
 *   fire every period.
 * - function-shift: per company |delta| >= 3 roles or >= 25% relative;
 *   market-wide (25k+ open roles) |delta| >= 25 roles or >= 2% relative, so
 *   ordinary drift does not headline. Relative checks need prior > 0.
 * - burst / churn require 8 consecutive observed snapshot dates ending at `day`
 *   (the 7-day window plus the day before it), so the first resumed collection
 *   after a gap cannot present its accumulated lump as a 7-day flow; function
 *   momentum requires every calendar day between its two snapshots observed.
 *
 * Ranking heuristic (`score`, higher = more notable; churn is intentionally
 * unclamped so the largest gross activity cannot flatten into a tie):
 * - expansion / contraction: |delta| + min(50, relative %).
 * - burst: 2 x trailing opened + 10 x spike ratio (opened / prior median opened).
 * - churn: 2 x trailing gross.
 * - function-shift: |delta| + min(50, relative %).
 * Ties break on the raw metric (|delta| / opened / gross) and then on
 * companyId, function and kind so ordering is deterministic. `patterns` also
 * caps each kind at 4 entries before the remaining feed slots are filled by
 * score.
 */
import type { DailyCompanyPoint, HistoryFile, NormalizedJob, RoleFunction } from './types';

const DAY_MS = 86_400_000;
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** Trailing window used by every detector. */
const DETECTOR_DAYS = 7;
/** Ranked findings returned by `patterns` / `companyPatterns`. */
const MAX_PATTERNS = 12;
/** `patterns` feed diversity: max entries of one kind before other kinds fill slots. */
const MAX_PER_KIND = 4;
/** burst: minimum trailing-7d opened. */
const BURST_MIN_OPENED = 5;
/** burst: days of history required before the trailing window. */
const BURST_MIN_HISTORY_DAYS = 21;
/** churn: minimum trailing-7d opened + removed. */
const CHURN_MIN_GROSS = 10;
/** churn: allowed |opened - removed| share of gross. */
const CHURN_BALANCE = 0.25;
/** function-shift: absolute role delta per company. */
const SHIFT_MIN_DELTA = 3;
/** function-shift: relative role delta per company (when the prior count is positive). */
const SHIFT_MIN_RELATIVE = 0.25;
/** function-shift: absolute role delta market-wide. */
const MARKET_SHIFT_MIN_DELTA = 25;
/** function-shift: relative role delta market-wide (when the prior count is positive). */
const MARKET_SHIFT_MIN_RELATIVE = 0.02;

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

/** Internal pattern plus the raw metric used to break score ties. */
interface Candidate {
  pattern: Pattern;
  magnitude: number;
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

/** True when every calendar day in the inclusive [from, to] span was observed. */
function denseEveryDay(observed: readonly string[] | undefined, from: string, to: string): boolean {
  if (!observed || !observed.length) return false;
  const unique = new Set<string>();
  for (const value of observed) {
    const date = isoDay(value);
    if (date && date >= from && date <= to) unique.add(date);
  }
  const span = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS) + 1;
  return Number.isFinite(span) && unique.size >= span;
}

/**
 * True when the 8 calendar dates ending at `day` are all observed: the trailing
 * `DETECTOR_DAYS`-day window plus the day immediately before it. Day flow
 * (`opened` / `removed`) accumulated during a collection gap lands on the first
 * resumed snapshot, so a window that starts on that snapshot must not be
 * presented as 7 days of flow; requiring the observed predecessor keeps the
 * claim honest.
 */
function denseTrailingWindow(series: InventoryPoint[], day: string): boolean {
  const windowStart = shiftDay(day, -(DETECTOR_DAYS - 1));
  const predecessor = windowStart ? shiftDay(windowStart, -1) : null;
  if (!windowStart || !predecessor) return false;
  const unique = new Set<string>();
  for (const point of series) {
    if (point.date >= predecessor && point.date <= day) unique.add(point.date);
  }
  return unique.size >= DETECTOR_DAYS + 1;
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
 * Market-wide sums per observed date, matching the chart policy: stale points
 * are included (the collector keeps those jobs current) and duplicates never
 * double count a company.
 *
 * Coverage: a date is included only when the companies with a point that date
 * are at least `minCoverage` of the companies that were already tracked then
 * (first point <= date). Late additions to the config therefore cannot
 * retroactively drop older dates. Dates never observed are never synthesized.
 */
export function aggregateInventory(history: HistoryFile, minCoverage = 0.9): InventoryPoint[] {
  const companies = Object.values(history?.companies ?? {});
  if (!companies.length) return [];
  const coverage = typeof minCoverage === 'number' && Number.isFinite(minCoverage) ? minCoverage : 0.9;
  const byDate = new Map<string, { companies: number; current: number; opened: number; removed: number }>();
  const firstDates: string[] = [];

  for (const points of companies) {
    const perCompany = new Map<string, { current: number; opened: number; removed: number }>();
    let first: string | null = null;
    for (const point of Array.isArray(points) ? points : []) {
      const date = isoDay(point?.date);
      if (!date) continue;
      if (!first || date < first) first = date;
      const bucket = perCompany.get(date) ?? { current: 0, opened: 0, removed: 0 };
      bucket.current += count(point.current);
      bucket.opened += count(point.opened);
      bucket.removed += count(point.removed);
      perCompany.set(date, bucket);
    }
    if (!first) continue;
    firstDates.push(first);
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
    .filter(([date, bucket]) => {
      const tracked = firstDates.filter((first) => first <= date).length;
      return tracked > 0 && bucket.companies / tracked >= coverage;
    })
    .sort(([a], [b]) => compareStrings(a, b))
    .map(([date, bucket]) => ({ date, current: bucket.current, opened: bucket.opened, removed: bucket.removed }));
}

/**
 * Direction of the `current` inventory at `day`.
 *
 * Exact rule: only the `days * 2` calendar days ending at `day` are used
 * (e.g. day-13..day for days=7) and each of them must be an observed snapshot
 * date, otherwise null. That density requirement keeps the reported `days`
 * honest: after a collection gap the last 14 observations could span a much
 * longer period, so a point-count window would mislabel the span.
 * `recentAvg` is the mean of the last `days` days, `priorAvg` the mean of the
 * `days` before those. `delta` is recentAvg - priorAvg and the steady band is
 * |delta| < max(3, 10% of priorAvg); positive deltas at or above the band
 * expand, negative ones contract. Averages and delta are reported to 1 decimal;
 * classification uses raw values.
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
  const required = window * 2;
  if (usable.length < required) return null;

  const spanStart = shiftDay(target, -(required - 1));
  const recent = usable.slice(-required);
  if (!spanStart) return null;
  for (let index = 0; index < required; index += 1) {
    if (recent[index]?.date !== shiftDay(spanStart, index)) return null;
  }

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
 *
 * Gap guard: `observedDays` must list the snapshot dates available to the
 * caller (e.g. the aggregate or company series dates). The comparison only runs
 * when every calendar day in the inclusive [day - days, day] span is observed;
 * otherwise the resumed snapshot lumps a gap of firstSeen/removedAt transitions
 * into one fake move. Without `observedDays` density cannot be certified and []
 * is returned, so pass the history dates whenever they exist.
 */
export function functionMomentum(
  jobs: NormalizedJob[],
  day: string,
  days = 7,
  observedDays?: readonly string[]
): FunctionMomentum[] {
  const target = isoDay(day);
  const window = Math.floor(days);
  if (!target || !Number.isFinite(days) || window < 1) return [];

  const priorDay = shiftDay(target, -window);
  if (!priorDay || !denseEveryDay(observedDays, priorDay, target)) return [];

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
function directionPattern(direction: Direction, companyId: string | null): Candidate {
  const expanding = direction.state === 'expanding';
  const magnitude = Math.abs(direction.delta);
  const relative = Math.min(50, (magnitude / Math.max(1, direction.priorAvg)) * 100);
  const sign = direction.delta > 0 ? '+' : '';
  return {
    pattern: {
      kind: expanding ? 'expansion' : 'contraction',
      companyId,
      headline: `${companyId ? '' : 'Market '}open roles ${expanding ? 'expanding' : 'contracting'}`,
      detail: `${sign}${direction.delta} open roles in ${direction.days} days (${direction.priorAvg} → ${direction.recentAvg}).`,
      score: Math.min(100, Math.round(magnitude + relative))
    },
    magnitude
  };
}

/**
 * burst: trailing-7-day `opened` >= max(5, 2 x median weekly `opened` over the
 * prior three weeks). Requires at least 21 days of points before the window,
 * at least two of the three prior weeks fully observed (all 7 calendar days
 * each), and 8 consecutive observed dates ending at `day` (the trailing window
 * plus its predecessor).
 */
function burstPattern(series: InventoryPoint[], day: string, companyId: string): Candidate | null {
  const windowStart = shiftDay(day, -(DETECTOR_DAYS - 1));
  if (!windowStart || !denseTrailingWindow(series, day)) return null;
  const floor = shiftDay(windowStart, -BURST_MIN_HISTORY_DAYS);
  const first = series[0];
  if (!floor || !first || first.date > floor) return null;

  const weekly: number[] = [];
  for (let week = 1; week <= 3; week += 1) {
    const end = shiftDay(day, -DETECTOR_DAYS * week);
    const start = end ? shiftDay(end, -(DETECTOR_DAYS - 1)) : null;
    if (!start || !end) continue;
    const observed = series.filter((point) => point.date >= start && point.date <= end);
    // only a fully observed week is a usable baseline; a week seen on one day
    // would deflate the median and manufacture a spike ratio
    if (new Set(observed.map((point) => point.date)).size === DETECTOR_DAYS) {
      weekly.push(observed.reduce((sum, point) => sum + point.opened, 0));
    }
  }
  if (weekly.length < 2) return null;

  const medianOpened = median(weekly);
  const trailingOpened = series
    .filter((point) => point.date >= windowStart && point.date <= day)
    .reduce((sum, point) => sum + point.opened, 0);
  if (trailingOpened < Math.max(BURST_MIN_OPENED, 2 * medianOpened)) return null;

  const ratio = trailingOpened / Math.max(1, medianOpened);
  return {
    pattern: {
      kind: 'burst',
      companyId,
      headline: 'New-posting burst',
      detail: `Opened ${trailingOpened} postings in the last 7 days vs a prior weekly median of ${medianOpened}.`,
      score: Math.min(100, Math.round(trailingOpened * 2 + ratio * 10))
    },
    magnitude: trailingOpened
  };
}

/**
 * churn: trailing-7-day gross (opened + removed) >= 10 and
 * |opened - removed| <= 25% of gross. The earliest observed point must fall
 * before the window so the incomplete baseline day cannot fake churn, and all
 * 8 dates ending at `day` must be observed (the window plus its predecessor):
 * a window starting on the first resumed snapshot after a gap would otherwise
 * count the accumulated lump as 7 days of flow.
 */
function churnPattern(series: InventoryPoint[], day: string, companyId: string): Candidate | null {
  const windowStart = shiftDay(day, -(DETECTOR_DAYS - 1));
  const first = series[0];
  if (!windowStart || !first || first.date >= windowStart || !denseTrailingWindow(series, day)) return null;

  const window = series.filter((point) => point.date >= windowStart && point.date <= day);
  if (!window.length) return null;
  const opened = window.reduce((sum, point) => sum + point.opened, 0);
  const removed = window.reduce((sum, point) => sum + point.removed, 0);
  const gross = opened + removed;
  if (gross < CHURN_MIN_GROSS || Math.abs(opened - removed) > CHURN_BALANCE * gross) return null;

  return {
    pattern: {
      kind: 'churn',
      companyId,
      headline: 'Posting churn',
      detail: `Opened ${opened} and removed ${removed} postings in the last 7 days (gross ${gross}).`,
      score: gross * 2
    },
    magnitude: gross
  };
}

/**
 * function-shift: per company |delta| >= 3 roles or >= 25% relative;
 * market-wide |delta| >= 25 roles or >= 2% relative. Relative checks only apply
 * when the prior count is positive; a zero prior needs the absolute threshold.
 */
function functionShiftPatterns(momentum: FunctionMomentum[], companyId: string | null): Candidate[] {
  const minDelta = companyId === null ? MARKET_SHIFT_MIN_DELTA : SHIFT_MIN_DELTA;
  const minRelative = companyId === null ? MARKET_SHIFT_MIN_RELATIVE : SHIFT_MIN_RELATIVE;
  const found: Candidate[] = [];
  for (const entry of momentum) {
    const magnitude = Math.abs(entry.delta);
    const relative = entry.prior > 0 ? magnitude / entry.prior : 0;
    if (magnitude < minDelta && relative < minRelative) continue;
    const sign = entry.delta > 0 ? '+' : '';
    found.push({
      pattern: {
        kind: 'function-shift',
        companyId,
        function: entry.function,
        headline: `${companyId ? '' : 'Market '}role-mix shift`,
        detail: `${entry.function} open roles ${sign}${entry.delta} in ${DETECTOR_DAYS} days (${entry.prior} → ${entry.current}).`,
        score: Math.min(100, Math.round(magnitude + Math.min(50, relative * 100)))
      },
      magnitude
    });
  }
  return found;
}

/**
 * Rank candidates by score (then raw metric, companyId, function, kind) and
 * optionally cap each kind. Keeps the result in score order and deterministic.
 */
function rank(candidates: Candidate[], maxPerKind: number | null): Pattern[] {
  const ordered = [...candidates].sort(
    (a, b) =>
      b.pattern.score - a.pattern.score ||
      b.magnitude - a.magnitude ||
      compareStrings(a.pattern.companyId ?? '', b.pattern.companyId ?? '') ||
      compareStrings(a.pattern.function ?? '', b.pattern.function ?? '') ||
      compareStrings(a.pattern.kind, b.pattern.kind)
  );
  const perKind = new Map<Pattern['kind'], number>();
  const selected: Pattern[] = [];
  for (const candidate of ordered) {
    if (selected.length >= MAX_PATTERNS) break;
    const used = perKind.get(candidate.pattern.kind) ?? 0;
    if (maxPerKind !== null && used >= maxPerKind) continue;
    perKind.set(candidate.pattern.kind, used + 1);
    selected.push(candidate.pattern);
  }
  return selected;
}

/** Raw detectors for one company; `patterns` aggregates these before ranking. */
function companyCandidates(companyId: string, history: HistoryFile, jobs: NormalizedJob[], day: string): Candidate[] {
  const series = inventorySeries(history?.companies?.[companyId] ?? []);
  const found: Candidate[] = [];

  const direction = directionOf(series, day, DETECTOR_DAYS);
  if (direction && direction.state !== 'steady') found.push(directionPattern(direction, companyId));
  const burst = burstPattern(series, day, companyId);
  if (burst) found.push(burst);
  const churn = churnPattern(series, day, companyId);
  if (churn) found.push(churn);

  const companyJobs = Array.isArray(jobs) ? jobs.filter((job) => job?.companyId === companyId) : [];
  if (companyJobs.length) {
    found.push(...functionShiftPatterns(functionMomentum(companyJobs, day, DETECTOR_DAYS, series.map((point) => point.date)), companyId));
  }
  return found;
}

/** Same detectors as `patterns`, restricted to one company (no per-kind cap). */
export function companyPatterns(companyId: string, history: HistoryFile, jobs: NormalizedJob[], day: string): Pattern[] {
  const target = isoDay(day);
  if (!target) return [];
  return rank(companyCandidates(companyId, history, jobs, target), null);
}

/**
 * Ranked notable findings for every company in `history` plus market-wide
 * entries (`companyId: null`): expansion / contraction from `directionOf`,
 * burst and churn per company, and function-shift market-wide and per company.
 *
 * Feed policy: sorted by `score` descending and capped at 12, with at most 4
 * entries per kind; once a kind is capped the loop keeps filling slots with the
 * next candidates by score (so the feed is diverse without padding). Ties use
 * the raw metric before any id. Insufficient history, or a collection gap
 * inside a claimed window, means a detector simply does not fire.
 */
export function patterns(history: HistoryFile, jobs: NormalizedJob[], day: string): Pattern[] {
  const target = isoDay(day);
  if (!target) return [];
  const found: Candidate[] = [];

  const aggregate = aggregateInventory(history);
  const marketDirection = directionOf(aggregate, target, DETECTOR_DAYS);
  if (marketDirection && marketDirection.state !== 'steady') found.push(directionPattern(marketDirection, null));
  found.push(...functionShiftPatterns(functionMomentum(jobs, target, DETECTOR_DAYS, aggregate.map((point) => point.date)), null));

  for (const companyId of Object.keys(history?.companies ?? {})) {
    found.push(...companyCandidates(companyId, history, jobs, target));
  }

  return rank(found, MAX_PER_KIND);
}
