'use strict';

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_RE = /^\d{4}-\d{2}$/;

function isDate(s) {
  return typeof s === 'string' && DAY_RE.test(s) && !Number.isNaN(parse(s).getTime());
}

function isMonth(s) {
  return typeof s === 'string' && MONTH_RE.test(s);
}

/** Parse 'YYYY-MM-DD' as a local date (avoids UTC shifting). */
function parse(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function format(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function today() {
  return format(new Date());
}

function currentMonth() {
  return today().slice(0, 7);
}

/** All date strings in 'YYYY-MM'. */
function daysInMonth(month) {
  const [y, m] = month.split('-').map(Number);
  const last = new Date(y, m, 0).getDate();
  const out = [];
  for (let d = 1; d <= last; d++) out.push(`${month}-${String(d).padStart(2, '0')}`);
  return out;
}

function weekday(dateStr) {
  return parse(dateStr).getDay(); // 0 = Sun .. 6 = Sat
}

function isWeekend(dateStr) {
  const d = weekday(dateStr);
  return d === 0 || d === 6;
}

module.exports = { isDate, isMonth, parse, format, today, currentMonth, daysInMonth, weekday, isWeekend };
