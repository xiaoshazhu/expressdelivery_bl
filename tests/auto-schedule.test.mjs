import assert from 'node:assert/strict';
import test from 'node:test';
import { claimAutoRun, claimDueAutoRuns, createAutoSchedule, dueAutoRun, isDailyTime, MAX_INTERVAL_HOURS, nextAutoRunAt, parseIntervalHours, pendingAutoRuns, readAutoSchedule, readAutoSchedules } from '../src/auto-schedule.mjs';

const HOUR = 3_600_000;
const MINUTE = 60_000;
const settings = { enabled: true, mode: 'daily', time: '08:00', intervalHours: 8 };
function memoryStorage() {
  const entries = new Map();
  return { getItem: key => entries.get(key) ?? null, setItem: (key, value) => entries.set(key, value) };
}

test('每日自动更新默认关闭，旧版默认开关和无效时间不激活定时查询', () => {
  for (const value of [null, { autoUpdate: true }, { enabled: true }, { enabled: true, time: '25:00', startsAt: 1 }]) {
    const schedule = readAutoSchedule(value);
    assert.equal(schedule.time, '08:00');
    assert.equal(schedule.intervalHours, 8);
    assert.equal(schedule.enabled, false);
    assert.equal(dueAutoRun(schedule, Date.parse('2026-11-24T08:00:00+08:00')), null);
  }
});

test('保存后只在北京时间设定分钟内刷新，错过不补查', () => {
  const at = Date.parse('2026-11-24T08:00:00+08:00');
  const schedule = createAutoSchedule(settings, at - 1);
  assert.equal(schedule.startsAt, at);
  assert.equal(dueAutoRun(schedule, at - 1), null);
  assert.equal(dueAutoRun(schedule, at), '2026-11-24T08:00');
  assert.equal(dueAutoRun(schedule, at + 59_999), '2026-11-24T08:00');
  assert.equal(dueAutoRun(schedule, at + 60_000), null);
});

test('已过设定时间则次日开始，日期按北京时间跨天', () => {
  const at = Date.parse('2026-11-24T00:15:00+08:00');
  const schedule = readAutoSchedule(createAutoSchedule({ ...settings, time: '00:15' }, at + 10_000));
  assert.equal(dueAutoRun(schedule, at + 10_000), null);
  assert.equal(nextAutoRunAt(schedule, at + 10_000), Date.parse('2026-11-25T00:15:00+08:00'));
  assert.equal(dueAutoRun(schedule, Date.parse('2026-11-24T16:15:00Z')), '2026-11-25T00:15');
});

test('同一数据表同一天只能领取一次刷新机会，不影响其他数据表和次日', () => {
  const storage = memoryStorage();
  assert.equal(claimAutoRun(storage, 'table1', '2026-11-24'), true);
  assert.equal(claimAutoRun(storage, 'table1', '2026-11-24'), false);
  assert.equal(claimAutoRun(storage, 'table2', '2026-11-24'), true);
  assert.equal(claimAutoRun(storage, 'table1', '2026-11-25'), true);
});

test('每日定时支持 00:00 和 23:59，并延续已保存的旧版设置', () => {
  for (const time of ['00:00', '23:59']) {
    assert.equal(isDailyTime(time), true);
    const at = Date.parse(`2026-11-24T${time}:00+08:00`);
    const schedule = readAutoSchedule({ enabled: true, time, startsAt: at });
    assert.equal(schedule.mode, 'daily');
    assert.equal(dueAutoRun(schedule, at), `2026-11-24T${time}`);
  }
  assert.equal(isDailyTime('24:00'), false);
});

test('每 8 小时按保存时刻计算，不在保存时立刻查询，跨日和重新读取后仍按同一间隔运行', () => {
  const now = Date.parse('2026-11-24T10:15:20+08:00');
  const schedule = createAutoSchedule({ ...settings, mode: 'interval' }, now);
  const first = now + 8 * HOUR;
  const second = now + 16 * HOUR;
  assert.equal(schedule.startsAt, first);
  assert.equal(dueAutoRun(schedule, now), null);
  assert.equal(dueAutoRun(schedule, first - 1), null);
  assert.equal(dueAutoRun(schedule, first), new Date(first).toISOString());
  assert.equal(dueAutoRun(schedule, first + 59_999), new Date(first).toISOString());
  assert.equal(dueAutoRun(schedule, first + 60_000), null);
  assert.equal(dueAutoRun(schedule, first + HOUR), null);
  const persisted = JSON.parse(JSON.stringify({ interval: schedule }));
  assert.deepEqual(readAutoSchedules(persisted).interval, schedule);
  assert.equal(dueAutoRun(readAutoSchedules(persisted).interval, second), new Date(second).toISOString());
});

test('查询间隔支持小时和整分钟输入，最短 30 分钟', () => {
  for (const [input, expected] of [['8', 8], ['8.5', 8.5], ['1.25', 1.25], ['0.5', 0.5], ['.5', 0.5], ['0.5166666667', 31 / 60], ['720', 720]]) {
    assert.equal(parseIntervalHours(input), expected);
  }
  for (const input of ['', '8.', '0.49', '1.234', '0', '720.5', '8e1', '0x8']) {
    assert.equal(parseIntervalHours(input), null);
  }
  for (const value of [30, 31, 45, 90, 480, 43200]) assert.equal(parseIntervalHours(String(value), 'minutes'), value / 60);
  for (const value of ['29', '30.5', '43201']) assert.equal(parseIntervalHours(value, 'minutes'), null);
});

test('自定义间隔保存后按整分钟计算，不产生小数小时漂移', () => {
  const now = Date.parse('2026-11-24T05:00:00Z');
  for (const intervalMinutes of [30, 31, 45, 510]) {
    const schedule = createAutoSchedule({ ...settings, mode: 'interval', intervalHours: intervalMinutes / 60 }, now);
    const restored = readAutoSchedules(JSON.parse(JSON.stringify({ interval: schedule }))).interval;
    const first = now + intervalMinutes * MINUTE;
    const second = first + intervalMinutes * MINUTE;
    assert.equal(restored.startsAt, first);
    assert.equal(dueAutoRun(restored, first - 1), null);
    assert.equal(dueAutoRun(restored, first), new Date(first).toISOString());
    assert.equal(dueAutoRun(restored, second), new Date(second).toISOString());
  }
});

test('非法间隔和已关闭设置不会触发查询', () => {
  const now = Date.parse('2026-11-24T05:00:00Z');
  for (const intervalHours of [0, -1, 0.49, 1.234, MAX_INTERVAL_HOURS + 0.5, '8', NaN]) {
    const schedule = createAutoSchedule({ ...settings, mode: 'interval', intervalHours }, now);
    assert.equal(schedule.enabled, false);
    assert.equal(dueAutoRun(schedule, now + 8 * HOUR), null);
  }
  const disabled = createAutoSchedule({ ...settings, mode: 'interval', enabled: false }, now);
  assert.equal(dueAutoRun(disabled, now + 8 * HOUR), null);
});

test('按间隔允许同一天多次执行，但同一到点时刻不重复查询', () => {
  const storage = memoryStorage();
  const first = '2026-11-24T00:00:00.000Z';
  const second = '2026-11-24T08:00:00.000Z';
  assert.equal(claimAutoRun(storage, 'table:interval', first), true);
  assert.equal(claimAutoRun(storage, 'table:interval', first), false);
  assert.equal(claimAutoRun(storage, 'table:interval', second), true);
  assert.equal(claimAutoRun(storage, 'table:interval', first), false);
  assert.equal(claimAutoRun(storage, 'table', '2026-11-24'), true);
});

test('迁移旧版单模式时保留原设置，另一项保持关闭', () => {
  const at = Date.parse('2026-11-24T08:00:00+08:00');
  const defaults = readAutoSchedules(null);
  assert.equal(defaults.daily.enabled, false);
  assert.equal(defaults.daily.time, '08:00');
  assert.equal(defaults.interval.enabled, false);
  assert.equal(defaults.interval.intervalHours, 8);
  const savedDaily = readAutoSchedules({ enabled: true, time: '08:00', intervalHours: 1.5, startsAt: at });
  assert.equal(dueAutoRun(savedDaily.daily, at), '2026-11-24T08:00');
  assert.equal(savedDaily.interval.enabled, false);
  assert.equal(savedDaily.interval.intervalHours, 1.5);
  const savedInterval = readAutoSchedules({ mode: 'interval', enabled: true, dailyTime: '09:35', intervalHours: 1.5, startsAt: at });
  assert.equal(dueAutoRun(savedInterval.interval, at), new Date(at).toISOString());
  assert.equal(savedInterval.daily.enabled, false);
  assert.equal(savedInterval.daily.time, '09:35');
  assert.equal(readAutoSchedule(savedInterval).enabled, false, '仅支持单模式的旧版本不会误触发');
});

test('每日定时和按间隔分别到点，保存或关闭其中一项不影响另一项', () => {
  const now = Date.parse('2026-11-24T07:15:00+08:00');
  const interval = createAutoSchedule({ ...settings, mode: 'interval', intervalHours: 0.5 }, now);
  const daily = createAutoSchedule(settings, now + MINUTE);
  const schedules = readAutoSchedules(JSON.parse(JSON.stringify({ daily, interval })));
  assert.deepEqual(schedules, { daily, interval });
  const storage = memoryStorage();
  assert.deepEqual(claimDueAutoRuns(storage, 'table', schedules, now + 30 * MINUTE).map(run => run.mode), ['interval']);
  assert.deepEqual(claimDueAutoRuns(storage, 'table', schedules, now + 45 * MINUTE).map(run => run.mode), ['daily']);
  const updated = { ...schedules, daily: { ...daily, enabled: false } };
  assert.deepEqual(claimDueAutoRuns(storage, 'table', updated, now + 60 * MINUTE).map(run => run.mode), ['interval']);
  assert.deepEqual(claimDueAutoRuns(storage, 'table', updated, now + 60 * MINUTE + 10_000), []);
});

test('每日和间隔同一分钟到点时合并成一次，间隔晚几秒到点也不重复查', () => {
  const at = Date.parse('2026-11-24T08:00:00+08:00');
  const daily = createAutoSchedule(settings, at - MINUTE);
  const intervalSettings = { ...settings, mode: 'interval', intervalHours: 0.5 };
  const storage = memoryStorage();
  const together = { daily, interval: createAutoSchedule(intervalSettings, at - 30 * MINUTE) };
  assert.deepEqual(claimDueAutoRuns(storage, 'table', together, at).map(run => run.mode), ['daily', 'interval']);
  assert.deepEqual(claimDueAutoRuns(storage, 'table', together, at + 1_000), []);

  const staggered = { daily, interval: createAutoSchedule(intervalSettings, at - 30 * MINUTE + 40_000) };
  assert.deepEqual(claimDueAutoRuns(storage, 'other', staggered, at).map(run => run.mode), ['daily']);
  assert.deepEqual(claimDueAutoRuns(storage, 'other', staggered, at + 40_000), []);
  assert.deepEqual(claimDueAutoRuns(storage, 'other', staggered, at + 30 * MINUTE + 40_000).map(run => run.mode), ['interval']);
});

test('已有旧日期标记时不重复旧计划，但当天新保存的未来时间可以刷新', () => {
  const at = Date.parse('2026-11-25T10:30:00+08:00');
  const storage = memoryStorage();
  const legacy = readAutoSchedules({ enabled: true, time: '08:00', startsAt: at - 150 * MINUTE });
  storage.setItem('table', '2026-11-25');
  assert.deepEqual(claimDueAutoRuns(storage, 'table', legacy, at - 150 * MINUTE), []);
  const daily = createAutoSchedule({ ...settings, time: '10:30' }, at - MINUTE);
  assert.deepEqual(claimDueAutoRuns(storage, 'table', { ...legacy, daily }, at).map(run => run.slot), ['2026-11-25T10:30']);
  assert.deepEqual(claimDueAutoRuns(storage, 'table', { ...legacy, daily }, at + 10_000), []);
  const edited = createAutoSchedule({ ...settings, time: '10:40' }, at + MINUTE);
  assert.deepEqual(claimDueAutoRuns(storage, 'table', { ...legacy, daily: edited }, at + 10 * MINUTE).map(run => run.slot), ['2026-11-25T10:40']);
});

test('边栏到点前已打开时可延迟执行，重新打开和超过五分钟时不追跑', () => {
  const at = Date.parse('2026-11-25T23:59:00+08:00');
  const watchedAt = at - MINUTE;
  const daily = createAutoSchedule({ ...settings, time: '23:59' }, watchedAt);
  const interval = createAutoSchedule({ ...settings, mode: 'interval', intervalHours: 0.5 }, at - 30 * MINUTE);
  const schedules = { daily, interval };
  const storage = memoryStorage();
  assert.deepEqual(pendingAutoRuns(storage, 'table', schedules, at + 2 * MINUTE, at + MINUTE), []);
  assert.deepEqual(pendingAutoRuns(storage, 'table', schedules, at + 5 * MINUTE, watchedAt), []);
  const pending = pendingAutoRuns(storage, 'table', schedules, at + 2 * MINUTE, watchedAt);
  assert.deepEqual(pending.map(run => run.mode), ['daily', 'interval']);
  assert.equal(storage.getItem('table'), null, '读取列表之前不领取执行机会');
  assert.deepEqual(claimDueAutoRuns(storage, 'table', schedules, at + 3 * MINUTE, watchedAt), pending);
  assert.deepEqual(claimDueAutoRuns(storage, 'table', schedules, at + 4 * MINUTE, watchedAt), []);
  assert.equal(nextAutoRunAt(daily, at + 2 * MINUTE), Date.parse('2026-11-26T23:59:00+08:00'));
});
