'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { dateFormatter } = require('../panel-date-format');
test('formatadores reutilizados preservam dia e hora nos fusos do painel, incluindo horário de verão', () => {
  const stamps = ['2026-03-08T06:59:59Z','2026-03-08T07:00:00Z','2026-11-01T05:59:59Z','2026-11-01T06:00:00Z','2026-10-08T04:00:00Z'];
  const zones = ['America/New_York','America/Chicago','America/Denver','America/Los_Angeles','America/Phoenix','Pacific/Honolulu','America/Anchorage'];
  for (const timeZone of zones) for (const [locale, fields] of [['en-US',{hour:'numeric',hourCycle:'h23'}],['en-CA',{year:'numeric',month:'2-digit',day:'2-digit'}],['en-US',{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}],['pt-BR',{day:'2-digit',month:'2-digit'}]]) {
    const options = {timeZone,...fields}, before = new Intl.DateTimeFormat(locale,options), after = dateFormatter(locale,options);
    for (const at of stamps) {
      assert.equal(after.format(new Date(at)), before.format(new Date(at)));
      assert.deepEqual(after.formatToParts(new Date(at)), before.formatToParts(new Date(at)));
    }
    assert.throws(()=>after.format(new Date(NaN)),RangeError);
  }
});
