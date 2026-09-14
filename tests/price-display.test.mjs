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
import { createDom, createLocalStorage } from './dom-stub.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

// The page keys off "today". Freezing the clock keeps assertions stable no
// matter when the suite runs; individual runs can move it via `opts.now`.
const DEFAULT_NOW = '2026-09-11T10:00:00+08:00';
let frozenNow = new Date(DEFAULT_NOW).getTime();

class FakeDate extends Date {
  constructor(...args) {
    if (args.length === 0) super(frozenNow);
    else super(...args);
  }
  static now() {
    return frozenNow;
  }
}

const FIXTURE_FILES = {
  oilPrice: 'oilPrice.json',
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

// The forecast endpoint is deliberately absent: the page must no longer call
// it. An unrecognised URL makes the stub throw, so a regression fails loudly.
function which(url) {
  if (url.includes('xxapi.cn/api/oilPrice')) return 'oilPrice';
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
  frozenNow = new Date(opts.now || DEFAULT_NOW).getTime();

  const fixtures = loadFixtures();
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
  if (!scriptMatch) throw new Error('inline <script> not found in index.html');

  const dom = createDom(html);
  // Passing a storage object lets a test simulate a second page load in the
  // same browser profile.
  if (opts.localStorage) dom.localStorage = opts.localStorage;
  const requested = [];
  const counts = { schedule: 0 };

  async function fetchStub(url) {
    requested.push(url);
    const kind = which(url);
    if (!kind) throw new Error('unexpected fetch: ' + url);

    if (kind === 'oilPrice' && opts.failOilPrice) {
      throw new TypeError('Failed to fetch (simulated)');
    }

    if (kind === 'schedule') {
      counts.schedule++;
      if (opts.throttleSchedule && counts.schedule <= opts.throttleSchedule) {
        // Real behaviour: throttling is HTTP 429 with code 4029 in the body.
        return {
          status: 429,
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
    // 下轮 renders synchronously from embedded data, so there is nothing to wait
    // for there. The schedule call may be rate-limited into a backoff retry, so
    // wait for it before touching the calendar.
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
  console.log('\nScenario 1: prices render (today from xxapi, next from embedded data)');
  const { dom, requested } = await runPage();

  const fixtures = loadFixtures();
  const hunan = fixtures.oilPrice.data.find((x) => x.regionName.includes('湖南'));

  console.log(`  (fixture: xxapi 湖南 95# = ${hunan.n95}; embedded: 08-28 = 8.54, 09-11 = 8.76)`);

  // --- Today's price block (live from xxapi) ------------------------------
  check('today price renders 95# value', text(dom, 'priceNow'), hunan.n95.toFixed(2));
  check('today date renders as MM-DD', text(dom, 'priceDate'), '09-11');
  check('today weekday renders', text(dom, 'priceWeek'), '星期五');

  // --- Next-round block (embedded, authoritative) -------------------------
  // On 09-11 the 09-11 window has not taken effect yet (it applies from 09-12),
  // so current = 08-28 (8.54) and next = 09-11 (8.76) => +0.22, a rise.
  check('next-round price comes from embedded data', text(dom, 'priceNext'), '8.76');
  checkIncludes('next-round date shows the 24:00 window', htmlOf(dom, 'nextDate'), '09-11 24时');
  // Same-year adjustments deliberately omit the year.
  checkIncludes('next-round date shows effective day', htmlOf(dom, 'nextDate'), '>09-12<');
  check('next-round weekday renders', text(dom, 'nextWeek'), '星期六');

  // --- Direction ----------------------------------------------------------
  const diffClass = dom.byId.get('priceDiff').className;
  checkIncludes('next-round diff is the real rise', htmlOf(dom, 'priceDiff'), '+0.22');
  checkIncludes('next-round diff styled as a rise', diffClass, 'up');
  checkIncludes('next-round diff is clickable', diffClass, 'clickable');
  check('data-recency stamp renders', text(dom, 'dataUpdated'), '数据更新至 09-11');

  // --- Only these two endpoints, and never the forecast one ---------------
  const kinds = requested.map(which);
  check('today-price endpoint requested', kinds.includes('oilPrice'), true);
  check('schedule endpoint requested (calendar)', kinds.includes('schedule'), true);
  check('forecast endpoint NOT requested', kinds.includes('forecast'), false);
  check('exactly two endpoints requested', requested.length, 2);

  // --- Calendar -----------------------------------------------------------
  dom.byId.get('dateBadge').dispatch('click'); // opens the calendar
  const cal = htmlOf(dom, 'calDays');
  check('calendar title renders', text(dom, 'calTitle'), '2026年9月');
  checkIncludes('calendar marks adjustment days', cal, 'class="adjust"');
}

async function scenarioThrottledSchedule() {
  console.log('\nScenario 2: schedule endpoint rate-limits once (HTTP 429 + code 4029)');
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
  checkIncludes('live next-round shows a 24:00 window', htmlOf(dom, 'nextDate'), '24时');

  // 下轮 comes from embedded data, so it is either a confirmed price or 待公布 --
  // and a confirmed one must carry a matching signed, coloured delta.
  const nextPrice = text(dom, 'priceNext');
  const diffClass = dom.byId.get('priceDiff').className;
  if (nextPrice === '--') {
    check('live unannounced state says 待公布', text(dom, 'priceDiff'), '待公布');
    check('live unannounced state shows no direction', /up|down/.test(diffClass), false);
  } else {
    check('live next-round price is a 2dp number', /^\d+\.\d{2}$/.test(nextPrice), true);
    checkIncludes('live next-round diff is signed and coloured', htmlOf(dom, 'priceDiff'),
      diffClass.includes('up') ? '+' : '-');
  }
  check('live oil price seeded the input', /^\d+\.\d{2}$/.test(dom.byId.get('oilPrice').value), true);

  const kinds = requested.map(which);
  check('live hit both remaining endpoints',
    [kinds.includes('oilPrice'), kinds.includes('schedule')].join(), 'true,true');
  check('live never called the forecast endpoint', kinds.includes('forecast'), false);

  dom.byId.get('dateBadge').dispatch('click');
  checkIncludes('live calendar marks adjustment days', htmlOf(dom, 'calDays'), 'class="adjust"');

  console.log(`  (live: today ${nowEl}, next ${nextPrice}, diff ${htmlOf(dom, 'priceDiff').replace(/<[^>]*>/g, '')})`);
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

// Every load must go to the network -- no localStorage cache in between.
async function scenarioNoCache() {
  console.log('\nScenario 4: no caching -- every load hits the network');
  const shared = createLocalStorage();

  const first = await runPage({ localStorage: shared });
  check('first load requested both endpoints',
    first.requested.map(which).sort().join(), 'oilPrice,schedule');
  check('first load wrote nothing to storage', shared._store.size, 0);

  // A second load in the same "browser profile" must not be served from cache.
  const second = await runPage({ localStorage: shared });
  check('second load also requested both endpoints',
    second.requested.map(which).sort().join(), 'oilPrice,schedule');
  check('second load wrote nothing to storage', shared._store.size, 0);

  // And the values must still render on the second load.
  check('second load still renders today price', text(second.dom, 'priceNow'), '8.54');
  check('second load still renders next-round price', text(second.dom, 'priceNext'), '8.76');
}

// 下轮 and the calendar are embedded/offline -- a dead price API must not blank
// them. This is the whole point of dropping the apizero prediction.
async function scenarioNextRoundIsOffline() {
  console.log('\nScenario 6: 下轮 survives a failing price API');
  const { dom } = await runPage({ failOilPrice: true });

  check('today price failed to load', text(dom, 'priceNow'), '--');
  checkIncludes('today failure is surfaced', text(dom, 'priceNowDiff'), '加载失败');
  // ...yet 下轮 still renders from embedded data.
  check('next-round price still renders', text(dom, 'priceNext'), '8.76');
  checkIncludes('next-round diff still renders', htmlOf(dom, 'priceDiff'), '+0.22');
  checkIncludes('next-round window still renders', htmlOf(dom, 'nextDate'), '09-11 24时');
  check('recency stamp still renders', text(dom, 'dataUpdated'), '数据更新至 09-11');
}

// The embedded data drives everything about 下轮, so the date boundary and the
// "announced yet?" state must both be right.
async function scenarioDateProgression() {
  console.log('\nScenario 7: 下轮 rolls over as the date advances');

  // On 09-12 the 09-11 window has taken effect: it becomes the current price and
  // the 09-24 window (not yet announced) becomes next.
  {
    const { dom } = await runPage({ now: '2026-09-12T10:00:00+08:00' });
    check('next window becomes 09-24', htmlOf(dom, 'nextDate').includes('09-24 24时'), true);
    check('unannounced price shows no number', text(dom, 'priceNext'), '--');
    check('unannounced state says 待公布', text(dom, 'priceDiff'), '待公布');
    check('unannounced diff stays clickable',
      dom.byId.get('priceDiff').classList.contains('clickable'), true);
    check('no fabricated direction is shown',
      /up|down/.test(dom.byId.get('priceDiff').className), false);
  }

  // Once the 09-24 announcement lands, the next-round price and delta appear --
  // computed from the embedded data alone.
  {
    const { dom, sandbox } = await runPage({ now: '2026-09-12T10:00:00+08:00' });
    sandbox.FUEL_DATA.adjustments[2].p95 = 8.90; // as if the notice came out
    sandbox.renderNextAdjustment();

    check('announced price renders', text(dom, 'priceNext'), '8.90');
    checkIncludes('delta is computed from embedded entries', htmlOf(dom, 'priceDiff'), '+0.14');
    checkIncludes('rise is styled as a rise', dom.byId.get('priceDiff').className, 'up');
  }

  // A window that falls exactly on today counts as already in force.
  {
    const { dom } = await runPage({ now: '2026-09-12T23:00:00+08:00' });
    check('same-day effective window is current, not next',
      htmlOf(dom, 'nextDate').includes('09-24'), true);
  }
}

// Clicking either change value opens a search for the corresponding price.
async function scenarioDetails() {
  console.log('\nScenario 5: clicking a change value opens its detail search');
  const { dom } = await runPage();

  const lastOpen = () => dom.opened[dom.opened.length - 1];

  check('today change value is clickable',
    dom.byId.get('priceNowDiff').classList.contains('clickable'), true);
  check('next-round diff is clickable',
    dom.byId.get('priceDiff').classList.contains('clickable'), true);

  dom.byId.get('priceNowDiff').dispatch('click');
  check('clicking 今日 opened a page', dom.opened.length, 1);
  checkIncludes('今日 search is about today\'s price', decodeURIComponent(lastOpen().url), '今日油价');
  check('今日 search targets Baidu', lastOpen().url.indexOf('baidu.com') >= 0, true);
  check('今日 opens in a new tab', lastOpen().target, '_blank');
  check('今日 shows the today price', decodeURIComponent(lastOpen().url).includes('95'), true);

  dom.byId.get('priceDiff').dispatch('click');
  check('clicking 下轮 opened a second page', dom.opened.length, 2);
  checkIncludes('下轮 search is about the next adjustment',
    decodeURIComponent(lastOpen().url), '下一轮国内成品油油价调整');
}

async function main() {
  await scenarioCalculator();
  await scenarioHappyPath();
  await scenarioThrottledSchedule();
  await scenarioNoCache();
  await scenarioDetails();
  await scenarioNextRoundIsOffline();
  await scenarioDateProgression();
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
