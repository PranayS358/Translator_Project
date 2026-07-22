const moment = require('moment');
require('moment-hijri');

function gregorianToHijri(dateStr) {
  const m = moment(dateStr, 'YYYY-MM-DD');
  if (!m.isValid()) return { error: 'Invalid Gregorian date. Use YYYY-MM-DD.' };
  return {
    input: dateStr,
    hijri: m.format('iYYYY-iMM-iDD'),
    hijriReadable: m.format('iD iMMMM iYYYY'),
  };
}

function hijriToGregorian(iDateStr) {
  const m = moment(iDateStr, 'iYYYY-iMM-iDD');
  if (!m.isValid()) return { error: 'Invalid Hijri date. Use iYYYY-iMM-iDD, e.g. 1447-01-15.' };
  return {
    input: iDateStr,
    gregorian: m.format('YYYY-MM-DD'),
    gregorianReadable: m.format('D MMMM YYYY (dddd)'),
  };
}

function today() {
  const now = moment();
  return {
    gregorian: now.format('YYYY-MM-DD'),
    gregorianReadable: now.format('dddd, D MMMM YYYY'),
    hijri: now.format('iYYYY-iMM-iDD'),
    hijriReadable: now.format('iD iMMMM iYYYY'),
  };
}

module.exports = { gregorianToHijri, hijriToGregorian, today };
