import test from 'node:test';
import assert from 'node:assert/strict';
import { latinDigits, persianDigits, jalaliToISO, isoToJalali, formatPersianDate, installPersianDateInputs } from '../public/dates.mjs';

test('Jalali conversion handles Persian and Arabic digits and Persian leap days', () => {
  assert.equal(jalaliToISO('۱۴۰۳/۰۱/۰۱'), '2024-03-20');
  assert.equal(jalaliToISO('١٤٠٣/١٢/٣٠'), '2025-03-20');
  assert.equal(jalaliToISO('1405/7/30'), '2026-10-22');
  assert.equal(jalaliToISO(' ۱۴۰۵ - ۷ - ۳۰ '), '2026-10-22');
  assert.equal(isoToJalali('2026-10-22'), '۱۴۰۵/۰۷/۳۰');
  assert.equal(isoToJalali('2024-03-20', { digits: 'latin' }), '1403/01/01');
});

test('invalid calendar dates are rejected rather than rolled over or stored as Gregorian', () => {
  for (const invalid of ['۱۴۰۲/۱۲/۳۰', '۱۴۰۳/۰۷/۳۱', '۱۴۰۳/۰۰/۰۱', '۱۴۰۳/۱۳/۰۱', '۱۴۰۳/۰۱/۰۰', '۱۴۰۳/۰۱/۳۲', '2026-10-22', '<script>', '', null]) assert.equal(jalaliToISO(invalid), null, String(invalid));
  assert.equal(isoToJalali('2025-02-30'), '');
  assert.equal(isoToJalali('not-a-date'), '');
});

test('civil date round trips retain the exact persisted day across months and year boundaries', () => {
  for (const value of ['1900-01-01','2023-03-20','2023-03-21','2024-02-29','2024-03-19','2024-03-20','2024-09-21','2024-09-22','2025-03-20','2025-03-21','2026-10-22','2199-12-31']) {
    assert.equal(jalaliToISO(isoToJalali(value)), value, value);
  }
});

test('visible dates always use Persian calendar/digits with timezone-safe civil dates', () => {
  assert.equal(formatPersianDate('2026-10-22'), '۳۰ مهر ۱۴۰۵');
  assert.equal(formatPersianDate('1405/7/30'), '۳۰ مهر ۱۴۰۵');
  assert.equal(formatPersianDate('2026-10-21T23:00:00Z'), '۳۰ مهر ۱۴۰۵');
  assert.equal(formatPersianDate('2026-10-22', { calendar: 'gregory', numberingSystem: 'latn' }), '۳۰ مهر ۱۴۰۵');
  assert.equal(formatPersianDate(undefined), '—');
  assert.equal(formatPersianDate('invalid'), '—');
  assert.equal(latinDigits('۱۲٣٤۵'), '12345');
  assert.equal(persianDigits('1405/07/30'), '۱۴۰۵/۰۷/۳۰');
});

test('date enhancement is safe to import on the server or with no date controls', () => {
  assert.equal(installPersianDateInputs(), 0);
  assert.equal(installPersianDateInputs({ querySelectorAll: () => [] }), 0);
});
