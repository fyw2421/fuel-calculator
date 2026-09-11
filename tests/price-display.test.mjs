// Reproduction harness for the "today / next-round price does not render" bug.
//
// It runs the REAL inline script from index.html inside a vm sandbox against
// the REAL API payloads captured in tests/fixtures/, then asserts on the text
// the page ends up showing.
//
//   node tests/price-display.test.mjs
//
// Exit code 0 = all assertions pass.

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { createDom } from './dom-stub.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

// The page and the forecast API both key off "today". Freezing the clock keeps
// assertions stable no matter when the suite runs.
const FROZEN_NOW = new Date('2026-09-11T10:00:00+08:00').getTime();
class FakeDate extends Date {
  constructor(...args) {
    if (args.length === 0) super(FROZEN_NOW);
    else super(...args);
  }
  static now() {
    return FROZEN_NOW;
  }
}

const FIXTURE_FILES = {
  oilPrice: 'oilPrice.json',
  forecast: 'forecast.json',
  schedule: 'schedule.json',
};

function loadFixtures() {
  const out = {};
  for (const [key, file] of Object.entries(FIXTURE_FILES)) {
    out[key] = JSON.parse(
      fs.readFileSync(path.join(HERE, 'fixtures', file), 'utf8')
    );
  }
  return out;
}

function which(url) {
  if (url.includes('xxapi.cn/api/oilPrice')) return 'oilPrice';
  if (url.includes('action=forecast')) return 'forecast';
  if (url.includes('action=schedule')) return 'schedule';
  return null;
}

/**
 * @param {object} opts
 * @param {number} [opts.throttleSchedule] how many leading schedule calls
 *   answer with the API's JSON-level rate limit (HTTP 200 + code 4029).
 */
// Yield through the timers phase (not setImmediate) so the page's own retry
// timers get a chance to fire between turns.
async function drip(turns = 1) {
  for (let i = 0; i < turns; i++) await new Promise((r) => setTimeout(r, 0));
}

/** Poll until `predicate()` holds, so live runs never rely on a fixed sleep. */
async function waitUntil(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  console.log(`  (timed out after ${timeoutMs}ms waiting for ${label})`);
  return false;
}

async function runPage(opts = {}) {
  const fixtures = loadFixtures();
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
  if (!scriptMatch) throw new Error('inline <script> not found in index.html');

  const dom = createDom(html);
  const requested = [];
  const counts = { schedule: 0 };

  async function fetchStub(url) {
    requested.push(url);
    const kind = which(url);
    if (!kind) throw new Error('unexpected fetch: ' + url);

    if (kind === 'schedule') {
      counts.schedule++;
      if (opts.throttleSchedule && counts.schedule <= opts.throttleSchedule) {
        // Real behaviour: HTTP 200, but the body says "too fast" (code 4029).
        return {
          status: 200,
          json: async () => ({
            code: 4029,
            msg: '调用过快，请稍后再试',
            data: { limit_qps: 1, retry_after: 1 },
          }),
        };
      }
    }
    return { status: 200, json: async () => fixtures[kind] };
  }

  // Retry backoff is real wall-clock time in the page. Record the delays the
  // page asked for, but fire them immediately so the suite stays fast; the
  // delay values themselves are asserted separately.
  const observedDelays = [];

  const sandbox = {
    document: dom.document,
    window: dom.window,
    localStorage: dom.localStorage,
    fetch: opts.live
      ? (url) => {
          requested.push(url);
          return globalThis.fetch(url);
        }
      : fetchStub,
    console,
    setTimeout: (fn, delay) => {
      observedDelays.push(delay);
      return setTimeout(fn, opts.live ? delay : 0);
    },
    clearTimeout,
    Date: opts.live ? Date : FakeDate,
    Promise,
    JSON,
    Math,
  };
  vm.createContext(sandbox);
  vm.runInContext(scriptMatch[1], sandbox, { filename: 'index.html<script>' });

  if (opts.live) {
    await waitUntil(() => text(dom, 'priceNow') !== '--', 25000, "today's price");
    await waitUntil(() => text(dom, 'priceNext') !== '--', 25000, 'next-round price');
    // The schedule request fires only after the forecast resolves and may be
    // rate-limited into a backoff retry, so wait for it before touching the
    // calendar -- rendering happens when it lands only if the mask is open.
    await waitUntil(
      () => sandbox.adjustSchedule && sandbox.adjustSchedule.length > 0,
      30000,
      'adjustment schedule'
    );
  } else {
    // Everything is synchronous under the stub, so a few turns is plenty.
    await drip(60);
  }

  return { dom, requested, sandbox, html, observedDelays };
}

// ---------------------------------------------------------------- assertions

let failures = 0;
let checks = 0;
function check(name, actual, expected) {
  checks++;
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(
    `  ${ok ? 'PASS' : 'FAIL'}  ${name}` +
      (ok ? '' : `\n          expected: ${JSON.stringify(expected)}\n          actual:   ${JSON.stringify(actual)}`)
  );
}
function checkIncludes(name, haystack, needle) {
  checks++;
  const ok = String(haystack).includes(needle);
  if (!ok) failures++;
  console.log(
    `  ${ok ? 'PASS' : 'FAIL'}  ${name}` +
      (ok ? '' : `\n          expected to contain: ${JSON.stringify(needle)}\n          actual:               ${JSON.stringify(haystack)}`)
  );
}

const text = (dom, id) => dom.byId.get(id).textContent;
const htmlOf = (dom, id) => dom.byId.get(id).innerHTML;

async function scenarioHappyPath() {
  console.log('\nScenario 1: both APIs healthy');
  const { dom, requested } = await runPage();

  const fixtures = loadFixtures();
  const hunan = fixtures.oilPrice.data.find((x) => x.regionName.includes('湖南'));
  const change = fixtures.forecast.data.prediction.estimated_change_per_liter;
  const direction = fixtures.forecast.data.prediction.direction;

  console.log(`  (fixture: 湖南 95# = ${hunan.n95}, direction = ${direction}, change = ${change})`);

  // --- Today's price block ------------------------------------------------
  check('today price renders 95# value', text(dom, 'priceNow'), hunan.n95.toFixed(2));
  check('today date renders as MM-DD', text(dom, 'priceDate'), '09-11');
  check('today weekday renders', text(dom, 'priceWeek'), '星期五');

  // --- Next-round block ---------------------------------------------------
  const expectedNext = (hunan.n95 - change).toFixed(2);
  check('next-round price = today - decrease', text(dom, 'priceNext'), expectedNext);
  checkIncludes('next-round date shows the 24:00 window', htmlOf(dom, 'nextDate'), '09-11 24时');
  // Same-year adjustments deliberately omit the year.
  checkIncludes('next-round date shows effective day', htmlOf(dom, 'nextDate'), '>09-12<');
  check('next-round weekday renders', text(dom, 'nextWeek'), '星期六');

  // --- Direction ----------------------------------------------------------
  // direction is 下跌 => price falls => negative diff, green ("down").
  const diffClass = dom.byId.get('priceDiff').className;
  checkIncludes('next-round diff is negative', htmlOf(dom, 'priceDiff'), '-' + change.toFixed(2));
  checkIncludes('next-round diff styled as a decrease', diffClass, 'down');
  checkIncludes('next-round diff is clickable', diffClass, 'clickable');

  // --- Both endpoints were actually hit -----------------------------------
  const kinds = requested.map(which);
  check('today-price endpoint requested', kinds.includes('oilPrice'), true);
  check('forecast endpoint requested', kinds.includes('forecast'), true);
  check('schedule endpoint requested', kinds.includes('schedule'), true);

  // --- Calendar -----------------------------------------------------------
  dom.byId.get('dateBadge').dispatch('click'); // opens the calendar
  const cal = htmlOf(dom, 'calDays');
  check('calendar title renders', text(dom, 'calTitle'), '2026年9月');
  checkIncludes('calendar marks adjustment days', cal, 'class="adjust"');
}

async function scenarioThrottledSchedule() {
  console.log('\nScenario 2: schedule endpoint rate-limits once (HTTP 200 + code 4029)');
  const { dom, observedDelays } = await runPage({ throttleSchedule: 1 });

  dom.byId.get('dateBadge').dispatch('click');
  const cal = htmlOf(dom, 'calDays');

  // A single 4029 must be retried, otherwise the calendar loses its markers.
  checkIncludes('calendar still marks adjustment days after a 4029', cal, 'class="adjust"');
  check('calendar still renders all cells', (cal.match(/data-day=/g) || []).length, 30);
  // ...and the retry must actually back off (the API hints retry_after: 1s).
  check('retry backs off at least 1s', observedDelays.some((d) => d >= 1000), true);
}

// Optional end-to-end pass against the real endpoints. Fixtures pin the shapes;
// this confirms the live APIs still match those assumptions.
//   LIVE=1 node tests/price-display.test.mjs
async function scenarioLive() {
  console.log('\nScenario 3: live APIs (end-to-end)');
  const { dom, requested } = await runPage({ live: true });

  const nowEl = text(dom, 'priceNow');
  check('live today price is a 2dp number', /^\d+\.\d{2}$/.test(nowEl), true);
  check('live today date renders', /^\d{2}-\d{2}$/.test(text(dom, 'priceDate')), true);
  check('live today weekday renders', /^星期[日一二三四五六]$/.test(text(dom, 'priceWeek')), true);
  check('live next-round price is a 2dp number', /^\d+\.\d{2}$/.test(text(dom, 'priceNext')), true);
  checkIncludes('live next-round shows a 24:00 window', htmlOf(dom, 'nextDate'), '24时');
  checkIncludes(
    'live next-round diff is signed and coloured',
    htmlOf(dom, 'priceDiff'),
    dom.byId.get('priceDiff').className.includes('up') ? '+' : '-'
  );
  check('live oil price seeded the input', /^\d+\.\d{2}$/.test(dom.byId.get('oilPrice').value), true);

  const kinds = requested.map(which);
  check('live hit all three endpoints', [kinds.includes('oilPrice'), kinds.includes('forecast'), kinds.includes('schedule')].join(), 'true,true,true');

  dom.byId.get('dateBadge').dispatch('click');
  checkIncludes('live calendar marks adjustment days', htmlOf(dom, 'calDays'), 'class="adjust"');

  console.log(`  (live: today ${nowEl}, next ${text(dom, 'priceNext')}, diff ${htmlOf(dom, 'priceDiff').replace(/<[^>]*>/g, '')})`);
}

// The price fixes touch the same script scope as the calculator, so guard that
// the app's primary feature still computes correctly.
async function scenarioCalculator() {
  console.log('\nScenario 0: calculator regression');
  const { dom } = await runPage();

  const set = (id, v) => {
    dom.byId.get(id).value = v;
    dom.byId.get(id).dispatch('input');
  };

  // amount mode: 230 CNY at 8.54/L in a 68L tank
  set('oilPrice', '8.54');
  set('fuelValue', '230');
  check('amount mode: litres', text(dom, 'gaugeLiters'), '26.93 L');
  check('amount mode: percent of tank', text(dom, 'gaugePercent'), '39.6%');
  check('amount mode: detail shown', dom.byId.get('gaugeDetail').classList.contains('show'), true);

  // percent mode: 50% of a 68L tank at 8.54/L
  dom.byId.get('modePercent').dispatch('click');
  set('fuelValue', '50');
  check('percent mode: cost', text(dom, 'gaugePercent'), '约 290.36 元');

  // over-capacity warning
  set('fuelValue', '120');
  check('over-capacity flags a warning', dom.byId.get('gaugePercent').classList.contains('warning'), true);

  // clearing resets the gauge
  dom.byId.get('modeAmount').dispatch('click');
  set('fuelValue', '');
  check('empty input resets the gauge', text(dom, 'gaugePercent'), '--');
  check('empty input restores idle state', dom.byId.get('gaugePercent').classList.contains('idle'), true);
}

async function main() {
  await scenarioCalculator();
  await scenarioHappyPath();
  await scenarioThrottledSchedule();
  if (process.env.LIVE === '1') await scenarioLive();

  console.log(`\n${checks - failures}/${checks} checks passed`);
  if (failures) {
    console.log(`${failures} FAILED`);
    process.exit(1);
  }
  console.log('all good');
}

main().catch((err) => {
  console.error('\nharness error:', err);
  process.exit(2);
});
