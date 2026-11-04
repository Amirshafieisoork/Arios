import {allowedPortalPage} from './access.mjs';
import {isoToJalali,jalaliToISO,latinDigits,formatPersianDate} from './dates.mjs';

const escape = value => String(value ?? '').replace(/[&<>"']/g,char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const rows = value => Array.isArray(value) ? value : [];
const text = value => latinDigits(value).replace(/ي/g,'ی').replace(/ك/g,'ک').toLowerCase();
const validISO = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value)) && new Date(value + 'T12:00:00Z').toISOString().slice(0,10) === value;
const amounts = invoices => invoices.reduce((sum,invoice) => ({issued:sum.issued + (Number(invoice.amount) || 0),paid:sum.paid + (Number(invoice.paid) || 0),due:sum.due + Math.max(0,(Number(invoice.amount) || 0) - (Number(invoice.paid) || 0))}),{issued:0,paid:0,due:0});
const todayISO = () => new Intl.DateTimeFormat('en-CA-u-ca-gregory-nu-latn',{year:'numeric',month:'2-digit',day:'2-digit',timeZone:'Asia/Tehran'}).format(new Date());
const modes = {customers:['مشتریان و پیگیری فروش','حساب‌های واقعی مشتریان، پروژه‌ها و وضعیت صورت‌حساب‌ها'],calendar:['تقویم و برنامه‌ریزی','شروع و تحویل پروژه‌ها، موعد وظایف و گزارش‌های ثبت‌شده'],documents:['مدارک و فایل‌ها','فایل‌های پروژه‌هایی که به آن‌ها دسترسی دارید']};
const projectURL = (id,tab = 'overview') => `#project/${encodeURIComponent(id)}/${tab}`;

/** Derive from the scoped snapshot only; no new customer or sales stage is inferred. */
export function customerOverview(state) {
  if (state?.user?.role !== 'manager') return [];
  return rows(state.users).filter(user => user.role === 'customer').map(user => {
    const projects = rows(state.projects).filter(project => project.customerId === user.id),ids = new Set(projects.map(project => project.id));
    return {id:user.id,name:user.name,phone:user.phone || '',archived:Boolean(user.deletedAt),projects,...amounts(rows(state.invoices).filter(invoice => ids.has(invoice.projectId)))};
  });
}

/** The API has already removed private drafts and non-client-visible files. */
export function projectDocuments(state) {
  if (!allowedPortalPage('documents',state?.user?.role)) return [];
  return rows(state.projects).flatMap(project => rows(project.files).map(file => ({...file,projectId:project.id,projectName:project.name}))).sort((left,right) => String(right.createdAt || '').localeCompare(String(left.createdAt || '')));
}

export function calendarEvents(state) {
  if (!allowedPortalPage('calendar',state?.user?.role)) return [];
  const projects = rows(state.projects),byId = new Map(projects.map(project => [project.id,project])),events = [];
  const add = event => {if (validISO(event.date)) events.push(event);};
  for (const project of projects) {
    add({id:`start:${project.id}`,date:project.startDate,kind:'start',title:'شروع پروژه',projectId:project.id,projectName:project.name,href:projectURL(project.id)});
    add({id:`end:${project.id}`,date:project.endDate,kind:'end',title:'تحویل برنامه‌ریزی‌شده',projectId:project.id,projectName:project.name,href:projectURL(project.id)});
    for (const task of rows(project.tasks)) add({id:`task:${task.id}`,date:task.dueDate,kind:'task',title:task.title,status:task.status,projectId:project.id,projectName:project.name,href:projectURL(project.id,'tasks')});
  }
  for (const report of rows(state.reports)) {
    const project = byId.get(report.projectId);if (!project) continue;
    const person = rows(state.users).find(user => user.id === report.workerId);
    add({id:`report:${report.id}`,date:report.date,kind:'report',title:`گزارش کار${person?.name ? ` · ${person.name}` : ''}`,status:report.status,projectId:project.id,projectName:project.name,href:'#reports'});
  }
  return events.sort((left,right) => left.date.localeCompare(right.date) || left.id.localeCompare(right.id));
}

export function persianMonth(iso = todayISO(),offset = 0) {
  const base = isoToJalali(iso,{digits:'latin'});if (!base || !Number.isInteger(offset)) return null;
  const [baseYear,baseMonth] = base.split('/').map(Number),absolute = baseYear * 12 + baseMonth - 1 + offset;
  const year = Math.floor(absolute / 12),month = absolute % 12 + 1,start = jalaliToISO(`${year}/${month}/1`);
  if (!start) return null;
  const nextYear = month === 12 ? year + 1 : year,nextMonth = month === 12 ? 1 : month + 1,next = jalaliToISO(`${nextYear}/${nextMonth}/1`);
  if (!next) return null;
  const count = Math.round((Date.parse(next) - Date.parse(start)) / 86400000);
  return {year,month,start,end:new Date(Date.parse(next) - 86400000).toISOString().slice(0,10),days:Array.from({length:count},(_,index) => new Date(Date.parse(start) + index * 86400000).toISOString().slice(0,10)),offset:(new Date(start + 'T12:00:00Z').getUTCDay() + 1) % 7,label:formatPersianDate(start,{month:'long',year:'numeric',day:undefined})};
}

function header(page,e) {const [title,subtitle] = modes[page];return `<div class="page-heading"><div><p class="eyebrow">ARIOS WORKSPACE</p><h1>${e(title)}</h1><p class="muted">${e(subtitle)}</p></div>${page === 'customers' ? '<a class="button primary" href="#leads">درخواست‌های مشاوره</a>' : page === 'documents' ? '<a class="button secondary" href="#projects">پروندهٔ پروژه‌ها</a>' : ''}</div>`;}
function money(value,ctx) {return `${(ctx.e || escape)((ctx.n || String)(value))} <small>تومان</small>`;}
function customerHTML(items,ctx) {
  const e = ctx.e || escape,n = ctx.n || String;
  return items.map(customer => `<article class="hub-customer card"><div class="row between"><div><span class="hub-label">${customer.archived ? 'دسترسی بایگانی‌شده' : 'حساب مشتری'}</span><h2>${e(customer.name)}</h2></div><span class="badge">${e(n(customer.projects.length))} پروژه</span></div>${customer.phone && /^\+?[0-9]{7,15}$/.test(customer.phone) ? `<a class="account-phone" href="tel:${e(customer.phone)}">${e(customer.phone)}</a>` : '<p class="muted">شمارهٔ تماس ثبت نشده است</p>'}<div class="hub-customer-balances"><span>صادرشده<strong>${money(customer.issued,ctx)}</strong></span><span>پرداخت‌شده<strong>${money(customer.paid,ctx)}</strong></span><span>مانده<strong>${money(customer.due,ctx)}</strong></span></div><div class="hub-customer-projects">${customer.projects.map(project => `<a href="${e(projectURL(project.id))}">${e(project.name)} <span aria-hidden="true">←</span></a>`).join('') || '<p class="muted">هنوز پروژه‌ای به این مشتری تخصیص داده نشده است.</p>'}</div></article>`).join('') || '<div class="hub-empty card"><h2>مشتری‌ای با این مشخصات پیدا نشد</h2><p>مشتریان از بخش کاربران و دسترسی‌ها تعریف می‌شوند.</p><a class="button secondary" href="#team">مدیریت حساب‌ها</a></div>';
}
function documentHTML(items,ctx) {
  const e = ctx.e || escape,n = ctx.n || String;
  return items.map(file => `<article class="hub-document"><div class="hub-file-icon" aria-hidden="true">${/^image\//.test(file.mimeType || '') ? 'IMG' : /pdf/.test(file.mimeType || '') ? 'PDF' : 'FILE'}</div><div class="hub-document-details"><h2>${e(file.name)}</h2><a href="${e(projectURL(file.projectId,'files'))}">${e(file.projectName)}</a><small>${e(n(Math.max(1,Math.ceil((Number(file.size) || 0) / 1024))))} کیلوبایت · ${e(ctx.date ? ctx.date(file.createdAt) : formatPersianDate(file.createdAt))}${file.clientVisible ? ' · قابل مشاهده برای مشتری' : ''}</small></div><div class="hub-document-actions"><button class="button secondary small" type="button" data-hub-download="${e(file.id)}" data-project-id="${e(file.projectId)}">دریافت فایل</button><p data-file-message role="status" aria-live="polite"></p></div></article>`).join('') || '<div class="hub-empty"><h2>فایلی برای نمایش وجود ندارد</h2><p>مدارک و تصاویر ثبت‌شدهٔ پروژه‌های مجاز در این بخش نمایش داده می‌شوند.</p><a class="button secondary" href="#projects">مشاهدهٔ پروژه‌ها</a></div>';
}
const eventKinds = {start:'شروع پروژه',end:'تحویل پروژه',task:'وظیفه',report:'گزارش کار'};
const taskStatuses = {open:'باز',in_progress:'در حال انجام',done:'انجام‌شده',submitted:'منتظر بررسی',approved:'تأییدشده',changes_requested:'نیازمند اصلاح',rejected:'ردشده'};
function calendarHTML(events,month,selectedDay,ctx) {
  const e = ctx.e || escape,n = ctx.n || String,monthEvents = events.filter(event => event.date >= month.start && event.date <= month.end),visible = selectedDay ? monthEvents.filter(event => event.date === selectedDay) : monthEvents;
  return `<div class="hub-calendar-head"><div class="hub-month-controls"><button class="icon-btn" type="button" data-hub-month="-1" aria-label="ماه قبل">›</button><h2 aria-live="polite">${e(month.label)}</h2><button class="icon-btn" type="button" data-hub-month="1" aria-label="ماه بعد">‹</button></div><button class="button secondary small" type="button" data-hub-today>ماه جاری</button></div><div class="hub-calendar-legend">${Object.entries(eventKinds).map(([kind,label]) => `<span><i class="hub-event-dot hub-event-dot--${kind}"></i>${label}</span>`).join('')}</div><div class="hub-calendar-week" aria-hidden="true">${['شنبه','یکشنبه','دوشنبه','سه‌شنبه','چهارشنبه','پنجشنبه','جمعه'].map(day => `<span>${day}</span>`).join('')}</div><div class="hub-calendar-grid" role="group" aria-label="روزهای ${e(month.label)}">${'<span aria-hidden="true"></span>'.repeat(month.offset)}${month.days.map((day,index) => {
    const entries = monthEvents.filter(event => event.date === day),selected = day === selectedDay;
    return `<button type="button" data-hub-day="${day}" aria-pressed="${selected}" aria-label="${e(formatPersianDate(day))}، ${e(n(entries.length))} مورد" ${day === todayISO() ? 'aria-current="date"' : ''}><span>${e(n(index + 1))}</span><span class="hub-day-markers" aria-hidden="true">${[...new Set(entries.map(event => event.kind))].map(kind => `<i class="hub-event-dot hub-event-dot--${kind}"></i>`).join('')}</span>${entries.length ? `<small>${e(n(entries.length))} مورد</small>` : ''}</button>`;
  }).join('')}</div><div class="hub-agenda-heading"><h2>${selectedDay ? e(formatPersianDate(selectedDay)) : 'برنامه‌های این ماه'}</h2>${selectedDay ? '<button type="button" class="button secondary small" data-hub-all-days>همهٔ ماه</button>' : ''}</div><div class="hub-agenda">${visible.map(event => `<a class="hub-agenda-item" href="${e(event.href)}"><i class="hub-event-dot hub-event-dot--${event.kind}" aria-hidden="true"></i><div><strong>${e(event.title)}</strong><p>${e(event.projectName)}</p></div><span>${e(formatPersianDate(event.date))}${taskStatuses[event.status] ? `<small>${taskStatuses[event.status]}</small>` : ''}</span></a>`).join('') || '<p class="hub-empty">برای این بازه موردی ثبت نشده است.</p>'}</div>`;
}

export function renderWorkspaceHub(page,state,ctx = {}) {
  if (!modes[page]) return null;
  if (!allowedPortalPage(page,state?.user?.role)) return '<div class="notice">این بخش برای نقش شما در دسترس نیست.</div>';
  const e = ctx.e || escape,n = ctx.n || String;
  if (page === 'customers') {
    const customers = customerOverview(state),totals = customers.reduce((total,item) => ({issued:total.issued + item.issued,paid:total.paid + item.paid,due:total.due + item.due}),{issued:0,paid:0,due:0});
    return `<div class="workspace-hub" data-workspace-hub="customers">${header(page,e)}<div class="hub-metrics">${[['حساب‌های مشتری',e(n(customers.length))],['صورت‌حساب صادرشده',money(totals.issued,ctx)],['پرداخت ثبت‌شده',money(totals.paid,ctx)],['ماندهٔ صورت‌حساب‌ها',money(totals.due,ctx)]].map(([label,value]) => `<article class="card hub-metric"><span>${label}</span><strong>${value}</strong></article>`).join('')}</div><section class="card hub-filters"><label>جست‌وجوی مشتری<input type="search" data-hub-search placeholder="نام یا شمارهٔ تماس" maxlength="120"></label><label>حساب<select data-hub-status><option value="all">همهٔ حساب‌ها</option><option value="active">فعال</option><option value="archived">بایگانی‌شده</option></select></label></section><div class="hub-customer-grid" data-hub-results>${customerHTML(customers,ctx)}</div></div>`;
  }
  if (page === 'documents') {
    const files = projectDocuments(state);
    return `<div class="workspace-hub" data-workspace-hub="documents">${header(page,e)}<section class="card"><div class="hub-filters"><label>جست‌وجوی مدرک<input type="search" data-hub-search placeholder="نام فایل یا پروژه" maxlength="120"></label><label>پروژه<select data-hub-project><option value="">همهٔ پروژه‌ها</option>${rows(state.projects).map(project => `<option value="${e(project.id)}">${e(project.name)}</option>`).join('')}</select></label></div><p class="muted hub-files-count">${e(n(files.length))} فایل در پروژه‌های مجاز شما</p><div data-hub-results>${documentHTML(files,ctx)}</div></section></div>`;
  }
  return `<div class="workspace-hub" data-workspace-hub="calendar">${header(page,e)}<section class="card"><label class="hub-calendar-project">پروژه<select data-hub-project><option value="">همهٔ پروژه‌ها</option>${rows(state.projects).map(project => `<option value="${e(project.id)}">${e(project.name)}</option>`).join('')}</select></label><div data-hub-calendar>${calendarHTML(calendarEvents(state),persianMonth(ctx.today?.() || todayISO()),'',ctx)}</div></section></div>`;
}

export function wireWorkspaceHub(page,state,ctx = {},{root = typeof document !== 'undefined' ? document.querySelector('[data-workspace-hub]') : null,downloadFile} = {}) {
  if (!modes[page] || !allowedPortalPage(page,state?.user?.role) || !root) return;
  const search = root.querySelector('[data-hub-search]'),results = root.querySelector('[data-hub-results]');
  if (page === 'customers') {
    const customers = customerOverview(state),filter = root.querySelector('[data-hub-status]');
    const draw = () => {const query = text(search.value).replace(/[\s+()-]/g,'');results.innerHTML = customerHTML(customers.filter(customer => (filter.value === 'all' || customer.archived === (filter.value === 'archived')) && (!query || [customer.name,customer.phone].some(value => text(value).replace(/[\s+()-]/g,'').includes(query)))),ctx);};
    search.addEventListener('input',draw);filter.addEventListener('change',draw);return;
  }
  const project = root.querySelector('[data-hub-project]');
  if (page === 'documents') {
    const files = projectDocuments(state);
    const wireDownloads = () => results.querySelectorAll('[data-hub-download]').forEach(button => button.addEventListener('click',async () => {
      if (button.disabled) return;
      const message = button.parentElement.querySelector('[data-file-message]');button.disabled = true;message.textContent = 'در حال آماده‌سازی فایل…';
      try {
        const getDownload = downloadFile || (await import('./project-workspace.mjs')).downloadProjectFile;
        const data = await getDownload(button.dataset.projectId,button.dataset.hubDownload);
        const url = new URL(data.url);if (url.protocol !== 'https:' || url.username || url.password || !url.hostname.endsWith('.supabase.co')) throw new Error('نشانی دریافت فایل معتبر نیست.');
        if (root.isConnected === false) return;
        message.textContent = '';const link = document.createElement('a');link.href = url.href;link.target = '_blank';link.rel = 'noopener noreferrer';link.className = 'text-link';link.textContent = 'باز کردن فایل آماده‌شده ↗';message.appendChild(link);
        button.textContent = 'آماده‌سازی دوباره';
        setTimeout(() => {link.remove();if (message.isConnected) message.textContent = 'برای دریافت، دوباره آماده‌سازی کنید.';},Math.min(90,Math.max(1,Number(data.expiresIn) || 90)) * 1000);
      } catch (error) {message.textContent = error.message || 'دریافت فایل انجام نشد؛ دوباره تلاش کنید.';message.setAttribute('role','alert');}
      finally {button.disabled = false;}
    }));
    const draw = () => {const query = text(search.value);results.innerHTML = documentHTML(files.filter(file => (!project.value || file.projectId === project.value) && (!query || [file.name,file.projectName].some(value => text(value).includes(query)))),ctx);wireDownloads();};
    search.addEventListener('input',draw);project.addEventListener('change',draw);wireDownloads();return;
  }
  const events = calendarEvents(state),calendar = root.querySelector('[data-hub-calendar]'),base = ctx.today?.() || todayISO();let offset = 0,selectedDay = '';
  const draw = () => {const month = persianMonth(base,offset);if (!month) return;calendar.innerHTML = calendarHTML(events.filter(event => !project.value || event.projectId === project.value),month,selectedDay,ctx);
    calendar.querySelectorAll('[data-hub-month]').forEach(button => button.addEventListener('click',() => {const next = offset + Number(button.dataset.hubMonth);if (persianMonth(base,next)) {offset = next;selectedDay = '';draw();calendar.querySelector(`[data-hub-month="${button.dataset.hubMonth}"]`)?.focus();}}));
    calendar.querySelectorAll('[data-hub-day]').forEach(button => button.addEventListener('click',() => {selectedDay = selectedDay === button.dataset.hubDay ? '' : button.dataset.hubDay;draw();calendar.querySelector(`[data-hub-day="${button.dataset.hubDay}"]`)?.focus();}));
    calendar.querySelector('[data-hub-today]')?.addEventListener('click',() => {offset = 0;selectedDay = '';draw();});calendar.querySelector('[data-hub-all-days]')?.addEventListener('click',() => {selectedDay = '';draw();});
  };
  project.addEventListener('change',() => {selectedDay = '';draw();});draw();
}

/** Next steps use only the viewer's scoped snapshot, with no extra data fetch. */
export function workspaceNextActions(state,{today=todayISO()}={}) {
 const role=state?.user?.role,reports=rows(state?.reports),projects=rows(state?.projects);
 if(role==='manager')return [
  {href:'#reports',title:'گزارش‌ها و تأییدها',detail:reports.some(r=>r.status==='submitted')?'گزارش‌های روزانهٔ منتظر بررسی را تأیید یا برای اصلاح برگردانید.':'گزارش روزانه و پروندهٔ تفصیلی پروژه‌ها را یک‌جا پیگیری کنید.',count:reports.filter(r=>r.status==='submitted').length,label:'گزارش منتظر بررسی',icon:'reports'},
  {href:'#voice',title:'صندوق ویس‌های تیم',detail:'صوت، متن تبدیل‌شده و پیش‌نویس؛ مرتب بر اساس مرحلهٔ آماده‌سازی.',icon:'assistant'},
  {href:'#team',title:'افراد و اطلاعات همکاری',detail:'حساب، مشخصات همکاری، نرخ کارکرد و مسئولیت‌های هر فرد.',icon:'team'},
  {href:'#finance',title:'حساب‌ها، مساعده و تنخواه',detail:'دریافت و پرداخت پروژه، حساب همکاران و ماندهٔ تنخواه.',icon:'finance'},
 ];
 if(role==='worker') {
  const tasks=projects.flatMap(project=>rows(project.tasks).filter(task=>task.assigneeId===state.user.id&&rows(project.memberIds).includes(state.user.id)&&['open','in_progress'].includes(task.status))),due=tasks.filter(task=>task.dueDate&&task.dueDate<=today),changes=reports.filter(report=>report.workerId===state.user.id&&report.status==='changes_requested');
  return [{href:'#reports',title:'مأموریت‌ها و گزارش‌های من',detail:due.length?'مأموریت‌های امروز و کارهای باز را بررسی کنید.':'برنامهٔ کاری و گزارش‌های روزانهٔ خود را اینجا ببینید.',count:due.length,label:'مأموریت تا امروز',icon:'calendar'},{href:'#voice',title:'ثبت گزارش با ویس',detail:'ویس تازه بفرستید یا متن پیش‌نویس‌های قبلی را تکمیل کنید.',icon:'assistant'},{href:'#reports',title:'گزارش‌های نیازمند اصلاح',detail:changes.length?'یادداشت مدیر را بخوانید و گزارش را دوباره بفرستید.':'نتیجهٔ بررسی گزارش‌ها و سابقهٔ فعالیت خود را ببینید.',count:changes.length,label:'گزارش برای اصلاح',icon:'reports'},{href:'#projects',title:'پروژه‌های من',detail:'جزئیات پروژه، اعضای تیم و فایل‌های مورد نیاز کار.',icon:'projects'}];
 }
 return [];
}
export function renderWorkspaceNextActions(state,ctx={}) {
 const actions=workspaceNextActions(state,{today:ctx.today?.()||todayISO()}),e=ctx.e||escape,n=ctx.n||String;if(!actions.length)return '';
 return `<section class="workspace-next-actions" aria-labelledby="workspace-next-actions-title"><div class="workspace-next-head"><div><h2 id="workspace-next-actions-title">از کجا شروع کنم؟</h2><p>کار مورد نظرتان را مستقیم انتخاب کنید.</p></div><a class="text-link" href="#projects">همهٔ پروژه‌ها ←</a></div><div class="workspace-next-grid">${actions.map(action=>`<a class="workspace-next-card" href="${e(action.href)}"><span class="workspace-next-icon" aria-hidden="true">${ctx.icon?ctx.icon(action.icon):'←'}</span><h3>${e(action.title)}</h3><p>${e(action.detail)}</p><span class="workspace-next-foot">${Number.isInteger(action.count)?`<span><b>${e(n(action.count))}</b> ${e(action.label)}</span>`:'<span>باز کردن بخش</span>'}<span aria-hidden="true">←</span></span></a>`).join('')}</div></section>`;
}
