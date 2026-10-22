/** Persian civil dates for the interface; persisted values always remain Gregorian ISO. */
const DAY = 86400000;
const jalaliFormatter = new Intl.DateTimeFormat('en-US-u-ca-persian-nu-latn', { timeZone: 'UTC', year: 'numeric', month: 'numeric', day: 'numeric' });
const months = ['فروردین','اردیبهشت','خرداد','تیر','مرداد','شهریور','مهر','آبان','آذر','دی','بهمن','اسفند'];
const weekdays = ['ش','ی','د','س','چ','پ','ج'];
const controllers = new WeakMap();
let sequence = 0, activePicker;

export function latinDigits(value) {
  return String(value ?? '').replace(/[۰-۹٠-٩]/g, char => String('۰۱۲۳۴۵۶۷۸۹'.includes(char) ? '۰۱۲۳۴۵۶۷۸۹'.indexOf(char) : '٠١٢٣٤٥٦٧٨٩'.indexOf(char)));
}
export function persianDigits(value) { return String(value ?? '').replace(/\d/g, digit => '۰۱۲۳۴۵۶۷۸۹'[Number(digit)]); }

function isoValue(value) {
  const text = latinDigits(value).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const date = new Date(text + 'T12:00:00Z');
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === text ? text : null;
}
function partsFromISO(iso) {
  const date = new Date(iso + 'T12:00:00Z');
  const parts = Object.fromEntries(jalaliFormatter.formatToParts(date).filter(item => ['year','month','day'].includes(item.type)).map(item => [item.type, Number(item.value)]));
  return [parts.year, parts.month, parts.day];
}
const compare = (left, right) => left[0] - right[0] || left[1] - right[1] || left[2] - right[2];

/** Convert a Jalali date (Persian/Arabic/Latin digits) to a valid YYYY-MM-DD. */
export function jalaliToISO(value) {
  const text = latinDigits(value).trim().replace(/[\u200e\u200f]/g, '');
  const match = text.match(/^(\d{4})\s*[/.-]\s*(\d{1,2})\s*[/.-]\s*(\d{1,2})$/);
  if (!match) return null;
  const target = match.slice(1).map(Number), [year, month, day] = target;
  // These bounds comfortably cover the application's allowed Gregorian years.
  if (year < 1200 || year > 1700 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  if ((month > 6 && day > 30) || (month === 12 && day > 30)) return null;
  let low = Math.floor(Date.UTC(year + 621, 0, 1) / DAY) - 2;
  let high = Math.floor(Date.UTC(year + 623, 0, 1) / DAY) + 2;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2), iso = new Date(middle * DAY).toISOString().slice(0, 10);
    const difference = compare(partsFromISO(iso), target);
    if (!difference) return iso;
    if (difference < 0) low = middle + 1;
    else high = middle - 1;
  }
  return null;
}

/** Convert an ISO civil date to the numeric Jalali value displayed in forms. */
export function isoToJalali(value, { digits = 'persian' } = {}) {
  const iso = isoValue(String(value ?? '').slice(0, 10));
  if (!iso) return '';
  const [year, month, day] = partsFromISO(iso);
  const formatted = `${year}/${String(month).padStart(2, '0')}/${String(day).padStart(2, '0')}`;
  return digits === 'latin' ? formatted : persianDigits(formatted);
}

/** Format dates and timestamps explicitly with the Persian calendar and digits. */
export function formatPersianDate(value, options = {}) {
  if (!value) return '—';
  const source = String(value);
  const civil = isoValue(latinDigits(source)) || jalaliToISO(source);
  const date = value instanceof Date ? value : new Date(civil ? civil + 'T12:00:00Z' : source);
  if (!Number.isFinite(date.getTime())) return '—';
  try {
    return new Intl.DateTimeFormat('fa-IR-u-ca-persian-nu-arabext', {
      year: 'numeric', month: 'long', day: 'numeric', timeZone: civil ? 'UTC' : 'Asia/Tehran', ...options,
      calendar: 'persian', numberingSystem: 'arabext',
    }).format(date);
  } catch { return '—'; }
}

function todayISO() {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US-u-ca-gregory-nu-latn', { timeZone: 'Asia/Tehran', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date()).filter(item => ['year','month','day'].includes(item.type)).map(item => [item.type, item.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function ensureStyles(document) {
  if (!document.head || document.head.querySelector('link[data-arios-persian-dates]')) return;
  const style = document.createElement('link');
  style.rel = 'stylesheet'; style.href = new URL('./dates.css', import.meta.url).href;
  style.dataset.ariosPersianDates = '';
  document.head.appendChild(style);
}

export function closePersianDatePicker() { activePicker?.close(); }

function openPicker(controller) {
  closePersianDatePicker();
  const { original, visible, button, document } = controller;
  let selected = isoValue(original.value) || todayISO();
  const minimum = () => isoValue(original.min) || '1900-01-01';
  const maximum = () => isoValue(original.max) || '2199-12-31';
  if (selected < minimum()) selected = minimum();
  if (selected > maximum()) selected = maximum();
  let [year, month] = partsFromISO(selected);
  const dialog = document.createElement('dialog');
  dialog.className = 'persian-date-picker'; dialog.dir = 'rtl';
  dialog.setAttribute('aria-label', 'انتخاب تاریخ شمسی');
  const close = () => {
    if (dialog.open && typeof dialog.close === 'function') dialog.close();
    dialog.remove(); button.setAttribute('aria-expanded', 'false');
    if (activePicker?.dialog === dialog) activePicker = undefined;
    if (button.isConnected) button.focus();
  };
  const monthAvailable = (nextYear, nextMonth) => {
    if (nextYear < 1200 || nextYear > 1700) return false;
    const start = jalaliToISO(`${nextYear}/${nextMonth}/1`);
    const end = jalaliToISO(`${nextYear}/${nextMonth}/31`) || jalaliToISO(`${nextYear}/${nextMonth}/30`) || jalaliToISO(`${nextYear}/${nextMonth}/29`);
    return Boolean(start && end && start <= maximum() && end >= minimum());
  };
  const shift = amount => { const next = month + amount; return [year + (next < 1 ? -1 : next > 12 ? 1 : 0), next < 1 ? 12 : next > 12 ? 1 : next]; };
  function draw() {
    const first = jalaliToISO(`${year}/${month}/1`);
    const offset = (new Date(first + 'T12:00:00Z').getUTCDay() + 1) % 7;
    const count = month <= 6 ? 31 : month <= 11 ? 30 : jalaliToISO(`${year}/12/30`) ? 30 : 29;
    const prev = shift(-1), next = shift(1), today = todayISO();
    dialog.innerHTML = `<div class="persian-calendar-head"><button type="button" data-calendar-shift="-1" aria-label="ماه قبل" ${monthAvailable(...prev) ? '' : 'disabled'}>›</button><strong aria-live="polite">${months[month - 1]} ${persianDigits(year)}</strong><button type="button" data-calendar-shift="1" aria-label="ماه بعد" ${monthAvailable(...next) ? '' : 'disabled'}>‹</button></div><div class="persian-calendar-week" aria-hidden="true">${weekdays.map(day => `<span>${day}</span>`).join('')}</div><div class="persian-calendar-days" role="group" aria-label="روزهای ${months[month - 1]}">${'<span aria-hidden="true"></span>'.repeat(offset)}${Array.from({ length: count }, (_, index) => {
      const day = index + 1, iso = jalaliToISO(`${year}/${month}/${day}`);
      const chosen = iso === original.value, disabled = iso < minimum() || iso > maximum();
      return `<button type="button" data-calendar-date="${iso}" aria-label="${formatPersianDate(iso, { weekday: 'long' })}" aria-pressed="${chosen}" ${iso === today ? 'aria-current="date"' : ''} ${disabled ? 'disabled' : ''}>${persianDigits(day)}</button>`;
    }).join('')}</div><div class="persian-calendar-foot"><button type="button" data-calendar-today ${today < minimum() || today > maximum() ? 'disabled' : ''}>امروز</button><button type="button" data-calendar-clear>پاک کردن</button><button type="button" data-calendar-close>بستن</button></div>`;
  }
  dialog.addEventListener('click', event => {
    const target = event.target.closest('button');
    if (!target || target.disabled) return;
    if (target.dataset.calendarShift) {
      const direction = Number(target.dataset.calendarShift); [year, month] = shift(direction); draw();
      dialog.querySelector(`[data-calendar-shift="${direction}"]`)?.focus();
    } else if (target.dataset.calendarDate) { controller.setISO(target.dataset.calendarDate, true); close(); visible.focus(); }
    else if (target.hasAttribute('data-calendar-today')) { controller.setISO(todayISO(), true); close(); visible.focus(); }
    else if (target.hasAttribute('data-calendar-clear')) { controller.setISO('', true); close(); visible.focus(); }
    else if (target.hasAttribute('data-calendar-close')) close();
  });
  dialog.addEventListener('keydown', event => {
    event.stopPropagation();
    if (event.key === 'Escape') { event.preventDefault(); close(); }
  });
  dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
  dialog.addEventListener('click', event => { if (event.target === dialog && event.clientX && event.clientY) { const rect = dialog.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) close(); } });
  draw(); document.body.appendChild(dialog); button.setAttribute('aria-expanded', 'true');
  if (typeof dialog.showModal === 'function') dialog.showModal();
  else { dialog.setAttribute('open', ''); dialog.setAttribute('role', 'dialog'); dialog.setAttribute('aria-modal', 'true'); }
  activePicker = { anchor: original, dialog, close };
  dialog.querySelector('[data-calendar-date][aria-pressed="true"]:not(:disabled)')?.focus();
  if (!dialog.contains(document.activeElement)) dialog.querySelector('[data-calendar-date]:not(:disabled)')?.focus();
}

function enhance(original) {
  if (controllers.has(original)) return controllers.get(original);
  const document = original.ownerDocument, initialISO = original.value;
  const id = ++sequence, oldId = original.id;
  const control = document.createElement('span'); control.className = 'persian-date-control';
  const visible = document.createElement('input');
  visible.type = 'text'; visible.inputMode = 'numeric'; visible.autocomplete = 'off'; visible.dir = 'ltr';
  visible.id = oldId || `arios-jalali-date-${id}`;
  visible.className = `${original.className || ''} persian-date-visible`.trim();
  visible.placeholder = '۱۴۰۵/۰۱/۰۱'; visible.maxLength = 14;
  visible.setAttribute('aria-label', original.getAttribute('aria-label') || original.closest('label')?.querySelector('.field-label')?.textContent?.trim() || 'تاریخ شمسی');
  const described = original.getAttribute('aria-describedby');
  const hint = document.createElement('small'); hint.className = 'persian-date-hint'; hint.id = `arios-date-hint-${id}`; hint.textContent = 'شمسی · سال/ماه/روز';
  visible.setAttribute('aria-describedby', [described, hint.id].filter(Boolean).join(' '));
  const button = document.createElement('button'); button.type = 'button'; button.className = 'persian-date-trigger';
  button.setAttribute('aria-label', 'باز کردن تقویم شمسی'); button.setAttribute('aria-haspopup', 'dialog'); button.setAttribute('aria-expanded', 'false');
  button.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M5 4h14a2 2 0 0 1 2 2v14H3V6a2 2 0 0 1 2-2ZM7 2v5m10-5v5M3 10h18"/><path d="M7 14h2m3 0h2m3 0h1M7 17h2m3 0h2"/></svg>';
  original.before(control); original.type = 'hidden'; original.dataset.persianDateIso = '';
  if (oldId) original.id = `${oldId}-iso`;
  control.append(visible, button, original); control.after(hint);
  let writing = false;
  const dispatch = () => {
    writing = true;
    try { original.dispatchEvent(new Event('input', { bubbles: true })); original.dispatchEvent(new Event('change', { bubbles: true })); }
    finally { writing = false; }
  };
  const validate = () => {
    const value = visible.value.trim(), iso = jalaliToISO(value);
    let error = '';
    if (!value) { original.value = ''; if (original.required) error = 'تاریخ شمسی را وارد کنید'; }
    else if (!iso) { original.value = ''; error = 'تاریخ شمسی معتبر با قالب سال/ماه/روز وارد کنید'; }
    else if (original.min && iso < original.min) { original.value = ''; error = `تاریخ نباید پیش از ${isoToJalali(original.min)} باشد`; }
    else if (original.max && iso > original.max) { original.value = ''; error = `تاریخ نباید پس از ${isoToJalali(original.max)} باشد`; }
    else if (iso < '1900-01-01' || iso > '2199-12-31') { original.value = ''; error = 'تاریخ خارج از بازهٔ قابل ثبت است'; }
    else original.value = iso;
    visible.setCustomValidity(error);
    visible.setAttribute('aria-invalid', error ? 'true' : 'false');
    return !error;
  };
  const syncFlags = () => { visible.disabled = original.disabled; visible.readOnly = original.readOnly; visible.required = original.required; button.disabled = original.disabled || original.readOnly; };
  const setISO = (value, notify = false) => { original.value = isoValue(value) || ''; visible.value = isoToJalali(original.value); syncFlags(); validate(); if (notify) dispatch(); };
  const controller = { original, visible, button, document, setISO };
  controllers.set(original, controller); setISO(initialISO);
  visible.addEventListener('input', () => { validate(); dispatch(); });
  visible.addEventListener('change', () => { if (validate() && original.value) visible.value = isoToJalali(original.value); dispatch(); });
  visible.addEventListener('keydown', event => { if (event.key === 'ArrowDown' && event.altKey) { event.preventDefault(); openPicker(controller); } });
  button.addEventListener('click', event => { event.preventDefault(); openPicker(controller); });
  original.addEventListener('change', () => { if (!writing) setISO(original.value); });
  original.form?.addEventListener('reset', () => queueMicrotask(() => setISO(initialISO)));
  if (typeof MutationObserver !== 'undefined') new MutationObserver(() => { syncFlags(); validate(); }).observe(original, { attributes: true, attributeFilter: ['disabled','readonly','required','min','max'] });
  return controller;
}

/** Run after rendering a page or modal. Existing date references and form names stay ISO. */
export function installPersianDateInputs(root = globalThis.document) {
  if (!root?.querySelectorAll) return 0;
  if (activePicker && !activePicker.anchor.isConnected) closePersianDatePicker();
  const inputs = [...root.querySelectorAll('input[type="date"]')];
  if (root.matches?.('input[type="date"]')) inputs.unshift(root);
  if (!inputs.length) return 0;
  ensureStyles(inputs[0].ownerDocument);
  for (const original of inputs) enhance(original);
  return inputs.length;
}

/** For a programmatic date change, keep the visible and persisted values together. */
export function setPersianDateValue(input, value, notify = false) {
  const iso = isoValue(value) || jalaliToISO(value) || '';
  const controller = controllers.get(input);
  if (controller) controller.setISO(iso, notify);
  else input.value = iso;
}
