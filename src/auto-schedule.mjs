export const DEFAULT_DAILY_TIME = '08:00';
export const DEFAULT_INTERVAL_HOURS = 8;
export const MIN_INTERVAL_HOURS = 0.5;
export const MAX_INTERVAL_HOURS = 720;
const MINUTE = 60_000;
const OPEN_SIDEBAR_GRACE = 5 * MINUTE;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const BEIJING_OFFSET = 8 * HOUR;
const MODES = /** @type {const} */ (['daily', 'interval']);

/** @typedef {{ enabled: boolean, mode: 'daily' | 'interval', time: string, intervalHours: number }} ScheduleSettings */
/** @typedef {ScheduleSettings & { startsAt: number, savedAt?: number }} AutoSchedule */
/** @typedef {Record<ScheduleSettings['mode'], AutoSchedule>} AutoSchedules */

/** @param {unknown} value */
export function isDailyTime(value) {
  return typeof value === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
}

/** @param {unknown} value */
export function isIntervalHours(value) {
  if (typeof value !== 'number' || value < MIN_INTERVAL_HOURS || value > MAX_INTERVAL_HOURS) return false;
  const minutes = value * 60;
  return Math.abs(minutes - Math.round(minutes)) < 1e-8;
}

/** @param {string} input @param {'hours' | 'minutes'} [unit] */
export function parseIntervalHours(input, unit = 'hours') {
  const text = input.trim();
  const pattern = unit === 'minutes' ? /^\d+$/ : /^(?:\d+|\d*\.\d+)$/;
  if (!pattern.test(text)) return null;
  const hours = unit === 'minutes' ? Number(text) / 60 : Number(text);
  return isIntervalHours(hours) ? Math.round(hours * 60) / 60 : null;
}

/** @param {unknown} value @returns {AutoSchedule} */
export function readAutoSchedule(value) {
  const saved = /** @type {(Partial<AutoSchedule> & { dailyTime?: string }) | null} */ (value);
  const mode = saved?.mode === 'interval' ? 'interval' : 'daily';
  const validMode = saved?.mode === undefined || saved.mode === 'daily' || saved.mode === 'interval';
  const rawTime = mode === 'interval' ? saved?.dailyTime ?? saved?.time : saved?.time;
  const time = typeof rawTime === 'string' && isDailyTime(rawTime) ? rawTime : DEFAULT_DAILY_TIME;
  const intervalHours = typeof saved?.intervalHours === 'number' && isIntervalHours(saved.intervalHours) ? saved.intervalHours : DEFAULT_INTERVAL_HOURS;
  const startsAt = typeof saved?.startsAt === 'number' && Number.isSafeInteger(saved.startsAt) && saved.startsAt > 0 ? saved.startsAt : 0;
  const savedAt = typeof saved?.savedAt === 'number' && Number.isSafeInteger(saved.savedAt) && saved.savedAt > 0 ? saved.savedAt : undefined;
  const validSettings = mode === 'interval' ? isIntervalHours(saved?.intervalHours) : isDailyTime(saved?.time);
  return { enabled: saved?.enabled === true && validMode && validSettings && startsAt > 0, mode, time, intervalHours, startsAt, ...(savedAt === undefined ? {} : { savedAt }) };
}

/** @param {unknown} value @returns {AutoSchedules} */
export function readAutoSchedules(value) {
  if (value && typeof value === 'object' && ('daily' in value || 'interval' in value)) {
    const saved = /** @type {Partial<AutoSchedules>} */ (value);
    return {
      daily: readAutoSchedule({ ...saved.daily, mode: 'daily' }),
      interval: readAutoSchedule({ ...saved.interval, mode: 'interval' }),
    };
  }
  const legacy = readAutoSchedule(value);
  return {
    daily: legacy.mode === 'daily' ? legacy : { ...legacy, mode: 'daily', enabled: false, startsAt: 0 },
    interval: legacy.mode === 'interval' ? legacy : { ...legacy, mode: 'interval', enabled: false, startsAt: 0 },
  };
}

/** @param {string} time @param {number} now */
function scheduledAt(time, now) {
  const [hour, minute] = time.split(':').map(Number);
  return new Date(now + BEIJING_OFFSET).setUTCHours(hour, minute, 0, 0) - BEIJING_OFFSET;
}

/** @param {number} hours */
const intervalDuration = hours => Math.round(hours * 60) * MINUTE;

/** @param {ScheduleSettings} settings @param {number} [now] @returns {AutoSchedule} */
export function createAutoSchedule(settings, now = Date.now()) {
  if (settings.mode === 'interval') {
    return readAutoSchedule({ ...settings, startsAt: now + intervalDuration(settings.intervalHours), savedAt: now });
  }
  const at = scheduledAt(settings.time, now);
  return readAutoSchedule({ ...settings, startsAt: at > now ? at : at + DAY, savedAt: now });
}

/** @param {AutoSchedule} schedule @param {number} [now] */
export function nextAutoRunAt(schedule, now = Date.now()) {
  if (!schedule.enabled) return null;
  const period = schedule.mode === 'daily' ? DAY : intervalDuration(schedule.intervalHours);
  return schedule.startsAt > now ? schedule.startsAt : schedule.startsAt + (Math.floor((now - schedule.startsAt) / period) + 1) * period;
}

/** @param {AutoSchedule} schedule @param {number} now @param {number} [watchingSince] */
function dueRun(schedule, now, watchingSince) {
  if (!schedule.enabled || now < schedule.startsAt) return null;
  const today = schedule.mode === 'daily' ? scheduledAt(schedule.time, now) : null;
  const at = today === null ? now - (now - schedule.startsAt) % intervalDuration(schedule.intervalHours)
    : today > now ? today - DAY : today;
  // Grace is only for a sidebar already on this table at the scheduled time.
  const window = watchingSince !== undefined && watchingSince <= at ? OPEN_SIDEBAR_GRACE : MINUTE;
  if (at < schedule.startsAt || now >= at + window) return null;
  const iso = new Date(at).toISOString();
  const slot = schedule.mode === 'daily' ? new Date(at + BEIJING_OFFSET).toISOString().slice(0, 16) : iso;
  return { mode: schedule.mode, slot, minute: iso.slice(0, 16) };
}

/** @param {AutoSchedule} schedule @param {number} [now] */
export function dueAutoRun(schedule, now = Date.now()) {
  return dueRun(schedule, now)?.slot ?? null;
}

/** @param {Pick<Storage, 'getItem' | 'setItem'>} storage @param {string} key @param {string} slot */
export function claimAutoRun(storage, key, slot) {
  // Each mode uses its own key; ISO dates and times sort in run order.
  const previous = storage.getItem(key);
  if (previous && previous >= slot) return false;
  storage.setItem(key, slot);
  return true;
}

/** @param {Pick<Storage, 'getItem'>} storage @param {string} key @param {AutoSchedules} schedules @param {number} [now] @param {number} [watchingSince] */
export function pendingAutoRuns(storage, key, schedules, now = Date.now(), watchingSince) {
  const lastMinute = storage.getItem(`${key}:minute`);
  return MODES.flatMap(mode => {
    const schedule = schedules[mode];
    const run = dueRun(schedule, now, watchingSince);
    if (!run || (lastMinute && lastMinute >= run.minute)) return [];
    const previous = storage.getItem(mode === 'daily' ? key : `${key}:interval`);
    if (previous && (previous >= run.slot || (mode === 'daily' && !schedule.savedAt && previous === run.slot.slice(0, 10)))) return [];
    return [run];
  });
}

/** @param {Pick<Storage, 'getItem' | 'setItem'>} storage @param {string} key @param {AutoSchedules} schedules @param {number} [now] @param {number} [watchingSince] */
export function claimDueAutoRuns(storage, key, schedules, now = Date.now(), watchingSince) {
  const runs = pendingAutoRuns(storage, key, schedules, now, watchingSince);
  for (const run of runs) claimAutoRun(storage, run.mode === 'daily' ? key : `${key}:interval`, run.slot);
  const lastMinute = runs.map(run => run.minute).sort().at(-1);
  return lastMinute && claimAutoRun(storage, `${key}:minute`, lastMinute) ? runs : [];
}
