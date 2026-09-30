import assert from 'node:assert/strict';
import test from 'node:test';
import {
  aggregateInventory,
  companyPatterns,
  derivedFunctionInventory,
  directionOf,
  functionMomentum,
  inventorySeries,
  patterns
} from '../src/lib/insights';
import type { DailyCompanyPoint, HistoryFile, NormalizedJob } from '../src/lib/types';

const DAY_MS = 86_400_000;

function point(date: string, current: number, opened = 0, removed = 0, stale = false): DailyCompanyPoint {
  return { date, current, opened, removed, stale };
}

function history(companies: Record<string, DailyCompanyPoint[]>): HistoryFile {
  return { trackingSince: '2026-08-01', companies };
}

function daily(
  startDay: string,
  count: number,
  current: (index: number) => number,
  opened: (index: number) => number = () => 0,
  removed: (index: number) => number = () => 0
): DailyCompanyPoint[] {
  const start = Date.parse(`${startDay}T00:00:00Z`);
  return Array.from({ length: count }, (_, index) => {
    const date = new Date(start + index * DAY_MS).toISOString().slice(0, 10);
    return point(date, current(index), opened(index), removed(index));
  });
}

function dates(points: DailyCompanyPoint[]): string[] {
  return points.map((entry) => entry.date);
}

function job(overrides: Partial<NormalizedJob> & { id: string; companyId: string; firstSeen: string }): NormalizedJob {
  return {
    sourceId: '1',
    company: 'Example',
    ticker: 'EXM',
    title: 'Engineer',
    function: 'Engineering',
    category: 'Software Engineering',
    level: 'Mid level',
    location: 'Remote',
    country: 'United States',
    remote: true,
    sourceUrl: 'https://example.test/1',
    provider: 'greenhouse',
    lastSeen: overrides.firstSeen,
    current: true,
    missingCount: 0,
    ...overrides
  };
}

test('inventorySeries returns a date-sorted copy with only inventory fields', () => {
  const input = [point('2026-08-10', 5, 1, 0), point('2026-08-08', 4, 2, 1, true), point('bad-date', 1)];
  const series = inventorySeries(input);
  assert.deepEqual(series, [
    { date: '2026-08-08', current: 4, opened: 2, removed: 1 },
    { date: '2026-08-10', current: 5, opened: 1, removed: 0 }
  ]);
  assert.equal(input[0]?.date, '2026-08-10');
});

test('aggregateInventory sums market-wide counts per observed date without gap filling', () => {
  const file = history({
    a: [point('2026-08-01', 3, 3), point('2026-08-03', 4, 1)],
    b: [point('2026-08-01', 10, 10), point('2026-08-03', 9, 0, 1)]
  });
  assert.deepEqual(aggregateInventory(file), [
    { date: '2026-08-01', current: 13, opened: 13, removed: 0 },
    { date: '2026-08-03', current: 13, opened: 1, removed: 1 }
  ]);
});

test('aggregateInventory skips dates below the company coverage threshold', () => {
  const file = history(
    Object.fromEntries(
      Array.from({ length: 10 }, (_, index) => {
        const points = [point('2026-08-01', 1)];
        if (index < 9) points.push(point('2026-08-02', 1));
        if (index < 8) points.push(point('2026-08-03', 1));
        return [`c${index}`, points];
      })
    )
  );
  assert.deepEqual(aggregateInventory(file).map((entry) => entry.date), ['2026-08-01', '2026-08-02']);
  assert.deepEqual(aggregateInventory(file, 0.8).map((entry) => entry.date), ['2026-08-01', '2026-08-02', '2026-08-03']);
  assert.deepEqual(aggregateInventory(file, 1.1), []);
});

test('aggregateInventory includes stale points in sums and coverage like the charts', () => {
  const file = history({
    a: [point('2026-08-01', 5, 5), point('2026-08-02', 999, 0, 0, true)],
    b: [point('2026-08-01', 2, 2), point('2026-08-02', 3, 1)]
  });
  assert.deepEqual(aggregateInventory(file), [
    { date: '2026-08-01', current: 7, opened: 7, removed: 0 },
    { date: '2026-08-02', current: 1002, opened: 1, removed: 0 }
  ]);
});

test('aggregateInventory uses companies tracked by the date as its coverage denominator', () => {
  const file = history({
    earlyA: [point('2026-08-01', 5, 5), point('2026-08-02', 6, 1)],
    earlyB: [point('2026-08-01', 5, 5), point('2026-08-02', 6, 1)],
    late: [point('2026-08-03', 1, 1)]
  });
  const aggregate = aggregateInventory(file);
  // `late` never counts against 08-01/08-02, and 08-03 is dropped because the early pair has no point
  assert.deepEqual(aggregate.map((entry) => entry.date), ['2026-08-01', '2026-08-02']);
  assert.equal(aggregate[0]?.current, 10);
});

test('derivedFunctionInventory includes firstSeen on the day and excludes removedAt on the day', () => {
  const jobs = [
    job({ id: 'base', companyId: 'a', firstSeen: '2026-08-01' }),
    job({ id: 'same-day', companyId: 'a', firstSeen: '2026-08-20' }),
    job({ id: 'future', companyId: 'a', firstSeen: '2026-08-21' }),
    job({ id: 'removed-today', companyId: 'a', firstSeen: '2026-08-01', removedAt: '2026-08-20' }),
    job({ id: 'removed-before', companyId: 'a', firstSeen: '2026-08-01', removedAt: '2026-08-19' }),
    job({ id: 'customer', companyId: 'a', firstSeen: '2026-08-02', function: 'Customer' })
  ];
  // zero counts are omitted: only Engineering and Customer appear
  assert.deepEqual(derivedFunctionInventory(jobs, '2026-08-20'), { Engineering: 2, Customer: 1 });
  assert.deepEqual(derivedFunctionInventory(jobs, '2026-08-19'), { Engineering: 2, Customer: 1 });
  assert.deepEqual(derivedFunctionInventory(jobs, '2026-08-01'), { Engineering: 3 });
  assert.deepEqual(derivedFunctionInventory(jobs, 'not-a-day'), {});
});

test('directionOf returns null when fewer than days*2 observations exist at or before the day', () => {
  const thirteen = inventorySeries(daily('2026-08-01', 13, () => 10));
  assert.equal(directionOf(thirteen, '2026-08-13'), null);
  const fourteen = inventorySeries(daily('2026-08-01', 14, () => 10));
  assert.equal(directionOf(fourteen, '2026-08-06'), null);
  assert.equal(directionOf(fourteen, '2026-08-14', 0), null);
  assert.equal(directionOf([], '2026-08-14'), null);
});

test('directionOf classifies expansions and contractions with window averages', () => {
  const expanding = directionOf(inventorySeries(daily('2026-08-01', 14, (index) => (index < 7 ? 40 : 53))), '2026-08-14');
  assert.deepEqual(expanding, { state: 'expanding', delta: 13, recentAvg: 53, priorAvg: 40, days: 7 });
  const contracting = directionOf(inventorySeries(daily('2026-08-01', 14, (index) => (index < 7 ? 60 : 42))), '2026-08-14');
  assert.deepEqual(contracting, { state: 'contracting', delta: -18, recentAvg: 42, priorAvg: 60, days: 7 });
});

test('directionOf keeps small moves inside the documented steady band', () => {
  const flat = directionOf(inventorySeries(daily('2026-08-01', 14, () => 40)), '2026-08-14');
  assert.deepEqual(flat, { state: 'steady', delta: 0, recentAvg: 40, priorAvg: 40, days: 7 });
  // |6| < 10% of prior average (100), so this is steady even though it exceeds the absolute floor of 3
  const percentBand = directionOf(inventorySeries(daily('2026-08-01', 14, (index) => (index < 7 ? 100 : 106))), '2026-08-14');
  assert.equal(percentBand?.state, 'steady');
  // +3 exactly is outside the band when the 10% floor is below 3
  const floorBand = directionOf(inventorySeries(daily('2026-08-01', 14, (index) => (index < 7 ? 20 : 23))), '2026-08-14');
  assert.equal(floorBand?.state, 'expanding');
});

test('directionOf requires the last days*2 observations to be consecutive calendar days', () => {
  // 14 observations, but the trailing span is 44 calendar days
  const sparse = [
    ...daily('2026-08-19', 7, () => 40),
    ...daily('2026-09-06', 5, () => 53),
    ...daily('2026-09-30', 2, () => 53)
  ];
  assert.equal(directionOf(inventorySeries(sparse), '2026-10-01'), null);
  // the same shape over 14 consecutive days is a real 7-day move
  const dense = inventorySeries([...daily('2026-09-18', 7, () => 40), ...daily('2026-09-25', 7, () => 53)]);
  const expected = { state: 'expanding', delta: 13, recentAvg: 53, priorAvg: 40, days: 7 };
  assert.deepEqual(directionOf(dense, '2026-10-01'), expected);
  // future points and older observations do not disturb the required 14-day span
  assert.deepEqual(directionOf([...dense, point('2026-10-31', 999)], '2026-10-01'), expected);
  assert.deepEqual(directionOf([point('2026-08-01', 5), ...dense], '2026-10-01'), expected);
});

test('functionMomentum compares derived inventory for all functions and sorts by |delta|', () => {
  const jobs = [
    job({ id: 'eng-base', companyId: 'a', firstSeen: '2026-08-10' }),
    job({ id: 'eng-new-1', companyId: 'a', firstSeen: '2026-08-26' }),
    job({ id: 'eng-new-2', companyId: 'a', firstSeen: '2026-08-27' }),
    ...Array.from({ length: 4 }, (_, index) =>
      job({ id: `sales-${index}`, companyId: 'a', firstSeen: '2026-08-11', function: 'Sales / Marketing', removedAt: '2026-08-25' })
    ),
    ...Array.from({ length: 3 }, (_, index) => job({ id: `customer-${index}`, companyId: 'a', firstSeen: '2026-08-12', function: 'Customer' }))
  ];
  const momentum = functionMomentum(jobs, '2026-08-31', 7, dates(daily('2026-08-01', 31, () => 10)));
  assert.equal(momentum.length, 10);
  assert.deepEqual(momentum.slice(0, 3), [
    { function: 'Sales / Marketing', current: 0, prior: 4, delta: -4 },
    { function: 'Engineering', current: 3, prior: 1, delta: 2 },
    { function: 'AI / Data', current: 0, prior: 0, delta: 0 }
  ]);
});

test('functionMomentum requires every calendar day between its snapshots to be observed', () => {
  const jobs = [job({ id: 'a', companyId: 'x', firstSeen: '2026-08-01' })];
  const observed = dates(daily('2026-08-01', 31, () => 10));
  assert.equal(functionMomentum(jobs, '2026-08-31', 7, observed).length, 10);
  assert.deepEqual(functionMomentum(jobs, '2026-08-31', 7, observed.filter((day) => day !== '2026-08-28')), []);
  assert.deepEqual(functionMomentum(jobs, '2026-08-31', 7, []), []);
  // without observed dates density cannot be certified, so it fails closed
  assert.deepEqual(functionMomentum(jobs, '2026-08-31', 7), []);
});

test('functionMomentum refuses windows that overlap the tracking-start ramp', () => {
  const observed = dates(daily('2026-08-01', 31, () => 10));
  const jobs = [job({ id: 'a', companyId: 'x', firstSeen: '2026-08-20' })];
  assert.deepEqual(functionMomentum(jobs, '2026-08-31', 7, observed), []);
  assert.deepEqual(functionMomentum([], '2026-08-31', 7, observed), []);
  assert.deepEqual(functionMomentum(jobs, 'not-a-day', 7, observed), []);
});

test('burst fires on a weekly opened spike relative to prior weeks', () => {
  const file = history({ spike: daily('2026-08-01', 31, () => 50, (index) => (index >= 24 ? 4 : 1)) });
  const found = patterns(file, [], '2026-08-31').filter((entry) => entry.kind === 'burst');
  assert.equal(found.length, 1);
  assert.equal(found[0]?.companyId, 'spike');
  assert.equal(found[0]?.score, 96);
  assert.equal(found[0]?.detail, 'Opened 28 postings in the last 7 days vs a prior weekly median of 7.');
});

test('burst does not fire below threshold or without 21 days of prior history', () => {
  const belowThreshold = history({ spike: daily('2026-08-01', 31, () => 50, (index) => (index >= 24 ? 1 : 1)) });
  assert.deepEqual(patterns(belowThreshold, [], '2026-08-31').filter((entry) => entry.kind === 'burst'), []);
  // same spike, but the series only starts 13 days before the window
  const shortHistory = history({ spike: daily('2026-08-12', 20, () => 50, (index) => (index >= 13 ? 4 : 1)) });
  assert.deepEqual(patterns(shortHistory, [], '2026-08-31').filter((entry) => entry.kind === 'burst'), []);
});

test('burst ignores prior weeks that were observed on only one day', () => {
  const holey = history({
    holey: [
      ...daily('2026-08-05', 1, () => 50, () => 1),
      ...daily('2026-08-12', 1, () => 50, () => 1),
      ...daily('2026-08-19', 1, () => 50, () => 1),
      ...daily('2026-08-26', 7, () => 50, () => 6)
    ]
  });
  // single observed days per prior week would deflate the median and fake a spike
  assert.deepEqual(patterns(holey, [], '2026-09-01').filter((entry) => entry.kind === 'burst'), []);
  const observedWeeks = history({
    spike: [...daily('2026-08-05', 21, () => 50, () => 1), ...daily('2026-08-26', 7, () => 50, () => 6)]
  });
  const bursts = patterns(observedWeeks, [], '2026-09-01').filter((entry) => entry.kind === 'burst');
  assert.equal(bursts.length, 1);
  assert.equal(bursts[0]?.companyId, 'spike');
});

test('churn fires when trailing gross activity is high and roughly balanced', () => {
  const file = history({
    churny: daily('2026-08-01', 31, () => 50, (index) => (index >= 24 ? 2 : 0), (index) => (index >= 24 ? 2 : 0))
  });
  const found = patterns(file, [], '2026-08-31').filter((entry) => entry.kind === 'churn');
  assert.equal(found.length, 1);
  assert.equal(found[0]?.companyId, 'churny');
  assert.equal(found[0]?.score, 56);
  assert.equal(found[0]?.detail, 'Opened 14 and removed 14 postings in the last 7 days (gross 28).');
});

test('churn does not fire on imbalanced, small, sparse, or baseline-only windows', () => {
  const imbalanced = history({ a: daily('2026-08-01', 31, () => 50, (index) => (index >= 24 ? 10 : 0)) });
  assert.deepEqual(patterns(imbalanced, [], '2026-08-31').filter((entry) => entry.kind === 'churn'), []);
  const small = history({ a: daily('2026-08-01', 31, () => 50, (index) => (index >= 29 ? 2 : 0), (index) => (index >= 29 ? 2 : 0)) });
  assert.deepEqual(patterns(small, [], '2026-08-31').filter((entry) => entry.kind === 'churn'), []);
  // earliest point sits inside the trailing window: the incomplete baseline cannot produce churn
  const baseline = history({ a: daily('2026-08-28', 4, () => 50, () => 5, () => 5) });
  assert.deepEqual(patterns(baseline, [], '2026-08-31').filter((entry) => entry.kind === 'churn'), []);
  // a 1-day hole inside the trailing window also disables churn
  const holey = history({ a: daily('2026-08-01', 31, () => 50, () => 3, () => 3).filter((entry) => entry.date !== '2026-08-27') });
  assert.deepEqual(patterns(holey, [], '2026-08-31').filter((entry) => entry.kind === 'churn'), []);
});

test('churn and burst stay silent through a collection hole until 7 dense days exist', () => {
  const file = history({
    gappy: [
      ...daily('2026-08-01', 21, () => 50, () => 1),
      // resumed collection lumps the missing days of opened/removed flow into 08-26
      ...daily('2026-08-26', 7, () => 50, () => 6, () => 6)
    ]
  });
  const flow = (day: string) => patterns(file, [], day).filter((entry) => entry.kind === 'churn' || entry.kind === 'burst');
  assert.deepEqual(flow('2026-08-26'), []);
  assert.deepEqual(flow('2026-08-27'), []);
  assert.deepEqual(flow('2026-08-31'), []);
  const resumed = flow('2026-09-01');
  assert.ok(resumed.some((entry) => entry.kind === 'churn' && entry.companyId === 'gappy'));
  assert.ok(resumed.some((entry) => entry.kind === 'burst' && entry.companyId === 'gappy'));
});

test('patterns emits market-wide expansion with companyId null and supporting numbers', () => {
  const file = history({
    rising: daily('2026-08-01', 14, (index) => (index < 7 ? 40 : 53)),
    alsoRising: daily('2026-08-01', 14, (index) => (index < 7 ? 80 : 106)),
    flat: daily('2026-08-01', 14, () => 10)
  });
  const market = patterns(file, [], '2026-08-14').find((entry) => entry.companyId === null);
  assert.equal(market?.kind, 'expansion');
  assert.equal(market?.headline, 'Market open roles expanding');
  assert.equal(market?.detail, '+39 open roles in 7 days (130 → 169).');
  assert.equal(market?.score, 69);
  const contractions = patterns(
    history({ falling: daily('2026-08-01', 14, (index) => (index < 7 ? 60 : 42)) }),
    [],
    '2026-08-14'
  ).filter((entry) => entry.kind === 'contraction');
  const company = contractions.find((entry) => entry.companyId === 'falling');
  assert.equal(company?.detail, '-18 open roles in 7 days (60 → 42).');
  assert.ok(contractions.some((entry) => entry.companyId === null));
});

test('steady companies produce no expansion or contraction patterns', () => {
  const found = patterns(history({ flat: daily('2026-08-01', 14, () => 40) }), [], '2026-08-14');
  assert.deepEqual(found.filter((entry) => entry.kind === 'expansion' || entry.kind === 'contraction'), []);
});

test('patterns emits function-shift market-wide and per company', () => {
  const jobs = [
    job({ id: 'eng-base', companyId: 'a', firstSeen: '2026-08-10' }),
    job({ id: 'eng-new-1', companyId: 'a', firstSeen: '2026-08-26' }),
    job({ id: 'eng-new-2', companyId: 'a', firstSeen: '2026-08-27' }),
    ...Array.from({ length: 4 }, (_, index) =>
      job({ id: `sales-${index}`, companyId: 'a', firstSeen: '2026-08-11', function: 'Sales / Marketing', removedAt: '2026-08-25' })
    ),
    job({ id: 'other-company', companyId: 'b', firstSeen: '2026-08-10', function: 'Operations' })
  ];
  const shifts = patterns(history({ a: daily('2026-08-01', 31, () => 50), b: daily('2026-08-01', 31, () => 50) }), jobs, '2026-08-31').filter((entry) => entry.kind === 'function-shift');
  const market = shifts.find((entry) => entry.companyId === null && entry.function === 'Sales / Marketing');
  assert.equal(market?.headline, 'Market role-mix shift');
  assert.equal(market?.detail, 'Sales / Marketing open roles -4 in 7 days (4 → 0).');
  assert.equal(market?.score, 54);
  const company = shifts.find((entry) => entry.companyId === 'a' && entry.function === 'Engineering');
  assert.equal(company?.detail, 'Engineering open roles +2 in 7 days (1 → 3).');
});

test('function-shift needs the absolute or relative threshold per company', () => {
  const file = history({ x: daily('2026-08-01', 31, () => 50) });
  // +1 role from a prior of 5 is 20%: below both the absolute and the relative company threshold
  const jobs = [
    ...Array.from({ length: 5 }, (_, index) => job({ id: `base-${index}`, companyId: 'x', firstSeen: '2026-08-10' })),
    job({ id: 'new', companyId: 'x', firstSeen: '2026-08-26' })
  ];
  const companyShifts = patterns(file, jobs, '2026-08-31').filter((entry) => entry.kind === 'function-shift' && entry.companyId === 'x');
  assert.deepEqual(companyShifts, []);
});

test('market-wide function-shift ignores sub-2% drift but still fires on large moves', () => {
  const file = history({ x: daily('2026-08-01', 31, () => 50) });
  const base = Array.from({ length: 500 }, (_, index) => job({ id: `eng-${index}`, companyId: 'x', firstSeen: '2026-08-10' }));
  const drift = [...base, ...Array.from({ length: 9 }, (_, index) => job({ id: `drift-${index}`, companyId: 'x', firstSeen: '2026-08-26' }))];
  const driftFound = patterns(file, drift, '2026-08-31');
  // +9 on a 500 baseline is 1.8%: below the market threshold, but still a real company move
  assert.deepEqual(driftFound.filter((entry) => entry.kind === 'function-shift' && entry.companyId === null), []);
  assert.ok(driftFound.some((entry) => entry.kind === 'function-shift' && entry.companyId === 'x' && entry.function === 'Engineering'));
  const jump = [...base, ...Array.from({ length: 30 }, (_, index) => job({ id: `jump-${index}`, companyId: 'x', firstSeen: '2026-08-26' }))];
  const market = patterns(file, jump, '2026-08-31').find((entry) => entry.kind === 'function-shift' && entry.companyId === null && entry.function === 'Engineering');
  assert.equal(market?.detail, 'Engineering open roles +30 in 7 days (500 → 530).');
});

test('companyPatterns restricts detectors to one company and tolerates unknown ids', () => {
  const file = history({
    rising: daily('2026-08-01', 14, (index) => (index < 7 ? 40 : 53)),
    falling: daily('2026-08-01', 14, (index) => (index < 7 ? 60 : 42))
  });
  const found = companyPatterns('rising', file, [], '2026-08-14');
  assert.ok(found.length > 0);
  assert.ok(found.every((entry) => entry.companyId === 'rising'));
  assert.ok(found.some((entry) => entry.kind === 'expansion'));
  assert.deepEqual(companyPatterns('missing', file, [], '2026-08-14'), []);
});

test('patterns caps each kind at 4, keeps score order, and leaves churn scores unclamped', () => {
  const file = history({
    ...Object.fromEntries(
      Array.from({ length: 8 }, (_, index) => [
        `churn${index}`,
        daily('2026-08-01', 31, () => 50, (i) => (i >= 24 ? 5 + index : 0), (i) => (i >= 24 ? 5 + index : 0))
      ])
    ),
    ...Object.fromEntries(Array.from({ length: 8 }, (_, index) => [`burst${index}`, daily('2026-08-01', 31, () => 50, (i) => (i >= 24 ? 10 : 1))])),
    ...Object.fromEntries(Array.from({ length: 8 }, (_, index) => [`rise${index}`, daily('2026-08-01', 31, (i) => (i < 24 ? 40 : 60))]))
  });
  const found = patterns(file, [], '2026-08-31');
  const scores = found.map((entry) => entry.score);
  assert.deepEqual(scores, [...scores].sort((a, b) => b - a));
  assert.equal(found.length, 12);
  // large gross activity is never flattened into a 100 tie
  const churn = found.filter((entry) => entry.kind === 'churn');
  assert.equal(churn.length, 4);
  assert.ok(churn.every((entry) => entry.score > 100));
  assert.equal(churn[0]?.companyId, 'churn7');
  assert.equal(churn[0]?.detail, 'Opened 84 and removed 84 postings in the last 7 days (gross 168).');
  assert.equal(churn[0]?.score, 336);
  // other kinds fill the remaining slots without exceeding the cap
  assert.ok(found.filter((entry) => entry.kind === 'burst').length <= 4);
  assert.ok(found.filter((entry) => entry.kind === 'expansion').length <= 4);
  assert.ok(found.some((entry) => entry.companyId === null));
});

test('score ties break on the raw metric before companyId', () => {
  const file = history({
    aaa: daily('2026-08-01', 31, () => 50, (index) => (index >= 24 ? 10 : 1)),
    zzz: daily('2026-08-01', 31, () => 50, (index) => (index >= 24 ? 12 : 1))
  });
  const bursts = patterns(file, [], '2026-08-31').filter((entry) => entry.kind === 'burst');
  // both burst scores cap at 100; the larger raw opening flow ranks first despite the companyId order
  assert.deepEqual(bursts.map((entry) => [entry.companyId, entry.score]), [['zzz', 100], ['aaa', 100]]);
});

test('detectors never throw and stay empty on empty or malformed input', () => {
  assert.deepEqual(patterns({ trackingSince: '2026-08-01', companies: {} }, [], '2026-08-14'), []);
  assert.deepEqual(patterns(history({}), [], 'not-a-day'), []);
  assert.deepEqual(aggregateInventory({ trackingSince: '2026-08-01', companies: {} }), []);
  assert.deepEqual(inventorySeries([]), []);
  assert.deepEqual(derivedFunctionInventory([], '2026-08-14'), {});
  assert.deepEqual(functionMomentum([], '2026-08-14'), []);
  assert.equal(directionOf([], '2026-08-14'), null);
  assert.equal(companyPatterns('x', history({}), [], '2026-08-14').length, 0);
});

test('every fired pattern describes postings with supporting numbers and no "hire" wording', () => {
  const file = history({
    spike: daily('2026-08-01', 31, () => 50, (index) => (index >= 24 ? 4 : 1)),
    churny: daily('2026-08-01', 31, () => 40, (index) => (index >= 24 ? 2 : 0), (index) => (index >= 24 ? 2 : 0)),
    falling: daily('2026-08-01', 31, (index) => (index < 24 ? 60 : 42))
  });
  const jobs = [
    job({ id: 'eng', companyId: 'falling', firstSeen: '2026-08-01' }),
    ...Array.from({ length: 3 }, (_, index) => job({ id: `new-${index}`, companyId: 'falling', firstSeen: '2026-08-28' }))
  ];
  const found = patterns(file, jobs, '2026-08-31');
  assert.ok(found.length >= 5);
  for (const entry of found) {
    assert.ok(Number.isFinite(entry.score) && entry.score >= 0);
    assert.match(entry.detail, /\d/);
    assert.doesNotMatch(entry.detail + entry.headline, /hire|hiring/i);
    assert.ok(entry.detail.length > 0 && entry.headline.length > 0);
  }
});
