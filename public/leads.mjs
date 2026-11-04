const STATUSES = {new:'در انتظار تماس',contacted:'تماس گرفته شده',closed:'بسته شده'};
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const digits = value => String(value ?? '').replace(/[۰-۹]/g, digit => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(digit))).replace(/[٠-٩]/g, digit => String('٠١٢٣٤٥٦٧٨٩'.indexOf(digit)));
const searchText = value => digits(value).replace(/ي/g,'ی').replace(/ك/g,'ک').replace(/[\s+()\-]/g,'').toLowerCase();
const validLead = lead => lead && typeof lead.id === 'string' && lead.id.length > 0 && lead.id.length <= 120 &&
  typeof lead.name === 'string' && typeof lead.message === 'string' && typeof lead.phone === 'string' &&
  /^\+?[0-9]{7,15}$/.test(lead.phone) && Object.hasOwn(STATUSES,lead.status) &&
  typeof lead.createdAt === 'string' && !Number.isNaN(Date.parse(lead.createdAt)) &&
  typeof lead.updatedAt === 'string' && !Number.isNaN(Date.parse(lead.updatedAt));

async function leadRequest(path, options, fetcher) {
  const response = await fetcher('/api/' + path, {credentials:'same-origin',...options});
  let data;
  try { data = await response.json(); } catch { throw new Error('پاسخ درخواست‌های مشاوره دریافت نشد؛ دوباره تلاش کنید.'); }
  if (!response.ok) {
    if ([401,403].includes(response.status)) throw new Error('برای مشاهده و پیگیری مشاوره‌ها با حساب مدیر وارد شوید.');
    if (response.status === 404) throw new Error('این درخواست دیگر در دسترس نیست؛ فهرست را تازه‌سازی کنید.');
    if (response.status === 429) throw new Error('تعداد درخواست‌ها زیاد شده است؛ کمی بعد دوباره تلاش کنید.');
    throw new Error('درخواست انجام نشد؛ اتصال را بررسی و دوباره تلاش کنید.');
  }
  return data;
}

export async function requestLeads({fetcher = fetch,signal} = {}) {
  const data = await leadRequest('leads',{method:'GET',signal},fetcher);
  if (!Array.isArray(data?.leads) || data.leads.length > 100 || !data.leads.every(validLead)) throw new Error('فهرست مشاوره‌ها کامل دریافت نشد؛ دوباره تلاش کنید.');
  return data.leads;
}

export async function updateLeadStatus(id,status,{fetcher = fetch,signal} = {}) {
  if (typeof id !== 'string' || !id || !Object.hasOwn(STATUSES,status)) throw new Error('وضعیت درخواست معتبر نیست.');
  const data = await leadRequest(`leads/${encodeURIComponent(id)}/status`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({status}),signal},fetcher);
  if (!validLead(data?.lead) || data.lead.id !== id || data.lead.status !== status) throw new Error('ذخیرهٔ وضعیت تأیید نشد؛ فهرست را تازه‌سازی کنید.');
  return data.lead;
}

export function filterLeads(leads,{status = 'all',query = ''} = {}) {
  const queryText = searchText(query);
  return leads.filter(lead => (status === 'all' || lead.status === status) && (!queryText ||
    [lead.name,lead.phone,lead.message].some(value => searchText(value).includes(queryText))));
}

function rowsHTML(leads,ctx) {
  if (!leads.length) return '<div class="leads-empty"><h2>درخواستی با این مشخصات پیدا نشد</h2><p>جست‌وجو یا وضعیت انتخاب‌شده را تغییر دهید.</p></div>';
  const e = ctx.e || escape;
  return leads.map(lead => `<article class="lead-card" data-lead-id="${e(lead.id)}"><div class="lead-card-heading"><div><span class="lead-status lead-status--${lead.status}"><i aria-hidden="true"></i>${STATUSES[lead.status]}</span><h2>${e(lead.name || 'متقاضی مشاوره')}</h2></div><time datetime="${e(lead.createdAt)}">${e(ctx.date ? ctx.date(lead.createdAt) : new Date(lead.createdAt).toLocaleDateString('fa-IR'))}<span>${e(new Intl.DateTimeFormat('fa-IR',{hour:'2-digit',minute:'2-digit',timeZone:'Asia/Tehran'}).format(new Date(lead.createdAt)))}</span></time></div><a class="lead-phone" href="tel:${e(lead.phone)}" dir="ltr" aria-label="تماس با ${e(lead.name || 'متقاضی مشاوره')} با شماره ${e(lead.phone)}">${e(lead.phone)}</a><p class="lead-message">${e(lead.message || 'توضیحی ثبت نشده است؛ نیاز متقاضی در تماس مشاوره مشخص می‌شود.')}</p><div class="lead-card-actions">${lead.status === 'new' ? `<button class="button primary small" type="button" data-lead-status="contacted" data-lead-id="${e(lead.id)}">تماس گرفته شد</button>` : ''}${lead.status !== 'closed' ? `<button class="button secondary small" type="button" data-lead-status="closed" data-lead-id="${e(lead.id)}">بستن درخواست</button>` : `<button class="button secondary small" type="button" data-lead-status="new" data-lead-id="${e(lead.id)}">بازگشت به انتظار تماس</button>`}${lead.status === 'contacted' ? `<button class="button secondary small" type="button" data-lead-status="new" data-lead-id="${e(lead.id)}">تماس دوباره لازم است</button>` : ''}</div></article>`).join('');
}

export function renderLeads(state,ctx = {}) {
  if (state?.user?.role !== 'manager') return '<div class="notice">این بخش برای نقش شما در دسترس نیست.</div>';
  return `<div class="leads-workspace" data-leads-workspace><div class="page-heading"><div><p class="eyebrow">ARIOS / CONSULTATION</p><h1>درخواست‌های مشاوره</h1><p class="muted">متقاضیان تماس از سایت آریوس؛ برای شروع یک همکاری پیگیری کنید.</p></div><button class="button secondary" type="button" data-leads-reload>تازه‌سازی</button></div><div class="leads-metrics" data-leads-metrics aria-live="polite"></div><section class="card leads-inbox"><div class="leads-toolbar"><label class="leads-search">جست‌وجوی درخواست<input type="search" data-leads-search maxlength="120" placeholder="نام، شماره یا موضوع مشاوره" autocomplete="off"></label><label>وضعیت<select data-leads-filter><option value="all">همهٔ درخواست‌ها</option>${Object.entries(STATUSES).map(([value,label]) => `<option value="${value}">${label}</option>`).join('')}</select></label></div><p class="leads-notice" data-leads-notice role="status" aria-live="polite"></p><div data-leads-error class="leads-error" role="alert" hidden></div><div class="leads-list" data-leads-list aria-busy="true"><p class="muted">در حال دریافت درخواست‌های مشاوره…</p></div></section></div>`;
}

export function wireLeads(state,ctx = {},{root = typeof document !== 'undefined' ? document.querySelector('[data-leads-workspace]') : null,fetcher = fetch} = {}) {
  if (state?.user?.role !== 'manager' || !root) return () => {};
  const metrics = root.querySelector('[data-leads-metrics]'),list = root.querySelector('[data-leads-list]'),
    error = root.querySelector('[data-leads-error]'),notice = root.querySelector('[data-leads-notice]'),
    reload = root.querySelector('[data-leads-reload]'),search = root.querySelector('[data-leads-search]'),filter = root.querySelector('[data-leads-filter]');
  let leads = [],pending = false,disposed = false,hasLoaded = false;
  const controller = new AbortController(),e = ctx.e || escape,n = ctx.n || String;
  const active = () => !disposed && root.isConnected !== false;
  function setError(message = '') {error.hidden = !message;error.textContent = message;}
  function draw() {
    if (!active()) return;
    metrics.innerHTML = Object.entries(STATUSES).map(([status,label]) => `<article class="card lead-metric"><span>${label}</span><strong>${e(n(leads.filter(lead => lead.status === status).length))}</strong></article>`).join('');
    list.innerHTML = hasLoaded && !leads.length ? '<div class="leads-empty"><h2>هنوز درخواست مشاوره‌ای ثبت نشده است</h2><p>وقتی مخاطبی از گفتگوی سایت درخواست تماس بدهد، شماره و شرح نیاز او در این بخش نمایش داده می‌شود.</p><a class="button secondary" href="/">مشاهدهٔ سایت آریوس</a></div>' : rowsHTML(filterLeads(leads,{status:filter.value,query:search.value}),ctx);
    list.setAttribute('aria-busy',String(pending));
    reload.disabled = pending;
    list.querySelectorAll('[data-lead-status]').forEach(button => {button.disabled = pending;button.addEventListener('click',() => save(button.dataset.leadId,button.dataset.leadStatus));});
  }
  async function load() {
    if (pending || !active()) return;
    pending = true;reload.disabled = true;list.setAttribute('aria-busy','true');setError();notice.textContent = 'در حال دریافت درخواست‌ها…';
    try {
      const rows = await requestLeads({fetcher,signal:controller.signal});
      if (!active()) return;
      leads = rows;hasLoaded = true;notice.textContent = 'حداکثر ۱۰۰ درخواست اخیر؛ برای تماس با متقاضی، شمارهٔ او را انتخاب کنید.';
    } catch (err) {
      if (!active() || err.name === 'AbortError') return;
      setError(err.message);notice.textContent = hasLoaded ? 'فهرست قبلی حفظ شده است؛ دوباره تازه‌سازی کنید.' : '';
      if (!hasLoaded) list.innerHTML = '<p class="muted">برای دریافت درخواست‌ها، تازه‌سازی را انتخاب کنید.</p>';
    } finally {
      pending = false;if (active()) {reload.disabled = false;list.setAttribute('aria-busy','false');if(hasLoaded) draw();}
    }
  }
  async function save(id,status) {
    if (pending || !active()) return;
    pending = true;setError();notice.textContent = 'در حال ذخیرهٔ وضعیت…';draw();
    try {
      const lead = await updateLeadStatus(id,status,{fetcher,signal:controller.signal});
      if (!active()) return;
      leads = leads.map(row => row.id === id ? lead : row);notice.textContent = 'وضعیت درخواست ذخیره شد.';
    } catch (err) {
      if (!active() || err.name === 'AbortError') return;
      setError(err.message);notice.textContent = 'وضعیت قبلی حفظ شده است؛ می‌توانید دوباره تلاش کنید.';
    } finally {pending = false;draw();}
  }
  reload.addEventListener('click',load);search.addEventListener('input',draw);filter.addEventListener('change',draw);
  if (ctx.api?.isStatic || ctx.demo) {
    list.innerHTML = '<div class="leads-empty"><h2>مشاوره‌ها در سایت اصلی ثبت می‌شوند</h2><p>نسخهٔ نمایشی درخواست تماس واقعی دریافت نمی‌کند.</p></div>';
    notice.textContent = '';reload.disabled = true;search.disabled = true;filter.disabled = true;list.setAttribute('aria-busy','false');
  } else load();
  return () => {disposed = true;controller.abort();};
}
