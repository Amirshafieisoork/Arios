import {renderPasskeySettings,wirePasskeySettings} from './passkey-settings.mjs';
import {renderManagementRoleSettings,wireManagementRoleSettings} from './management-role-settings.mjs';
import {renderPersonalStockWorkspace,renderPersonalStockTeamSummary,wirePersonalStockWorkspace} from './personal-stock-workspace.mjs';
// Operational screens. All requests go through the shared, scoped API adapter.
import { portalNotifications } from './portal-workflows.mjs';
import {renderReportProjectIdentity} from './project-admin.mjs';
import {renderProjectReviewInbox} from './project-review-inbox.mjs';
import {allowedPortalPage,assignableRoles,roleLabels} from './access.mjs';
import {financeTrend,analyticsCharts,analyticsExports,teamOverview} from './insight-views.mjs';
import {analyticsCSV} from './insights.mjs';
import {openReportComposer,renderReportDrafts,wireReportDrafts,renderReportAttachments,wireReportAttachments,renderMemberMissions,wireMemberMissions} from './project-workspace.mjs';
import {catalogSelect} from './catalogs.mjs';
const memories = new Map();
const managerPages = new Set(['finance-admin', 'inventory', 'team', 'analytics']);
const labels = { warehouse:'انباردار', accountant:'حسابدار', open: 'باز', in_progress: 'در حال رسیدگی', resolved: 'حل‌شده', submitted: 'در انتظار بررسی', approved: 'تأییدشده', changes_requested: 'نیازمند اصلاح', rejected: 'ردشده', manager: 'مدیر', worker: 'نیروی اجرایی', customer: 'مشتری' };
const sum = (rows, field) => rows.reduce((total, row) => total + (Number(row[field]) || 0), 0);
const byDate = rows => [...rows].sort((a, b) => String(b.createdAt || b.date || '').localeCompare(String(a.createdAt || a.date || '')));
const list = value => Array.isArray(value) ? value : [];
const supabaseAuth = ctx => ctx.authMode === 'supabase' || Boolean(ctx.capabilities?.supabaseAuth);
function memory(page, state) {
  const key = `${state.user.id}:${page}`;
  if (!memories.has(key)) memories.set(key, { projectId: '', conversations: new Map(), filter: 'all' });
  return memories.get(key);
}
function allowed(page,state){return allowedPortalPage(page,state.user.role);}
function empty(message, ctx) { return `<div class="empty-state"><p>${ctx.e(message)}</p></div>`; }
function header(title, subtitle, actions, ctx) { return `<div class="page-heading"><div><p class="eyebrow">ARIOS WORKSPACE</p><h1>${ctx.e(title)}</h1><p class="muted">${ctx.e(subtitle)}</p></div><div class="page-actions">${actions || ''}</div></div>`; }
function metric(label, value, detail, ctx) { return `<article class="card metric"><span class="muted">${ctx.e(label)}</span><strong>${value}</strong><small class="muted">${ctx.e(detail)}</small></article>`; }
function selectProjects(state, ctx, value = '', all = true) {
  return `${all ? '<option value="">همهٔ پروژه‌ها</option>' : ''}${list(state.projects).map(p => `<option value="${ctx.e(p.id)}" ${p.id === value ? 'selected' : ''}>${ctx.e(p.projectCode?p.projectCode+' · '+p.name:p.name)}</option>`).join('')}`;
}
function projectFilter(state, ctx, value) { return `<label class="filter-label">پروژه<select data-project-filter>${selectProjects(state, ctx, value)}</select></label>`; }
function selection(state, page) {
  const m = memory(page, state);
  if (m.projectId && !state.projects.some(p => p.id === m.projectId)) m.projectId = '';
  return m;
}
const projectRows = (rows, projectId) => list(rows).filter(row => !projectId || row.projectId === projectId);
const userOptions = (users, ctx, role) => users.filter(u => !u.deletedAt && (!role || u.role === role)).map(u => `<option value="${ctx.e(u.id)}">${ctx.e(u.name)}</option>`).join('');
function field(label, content) { return `<label>${label}${content}</label>`; }
function contact(person, ctx) {
  const phone = String(person.phone || '').trim();
  if (phone) return `<a class="account-phone" dir="ltr" href="tel:${ctx.e(phone)}">${ctx.e(phone)}</a>`;
  return '<span class="muted">شماره تماس ثبت نشده</span>';
}
function accountFields(person, ctx, { create = false } = {}) {
  const role=person?.role || 'worker';
  return `${field('نام و نام خانوادگی', `<input name="name" value="${ctx.e(person?.name || '')}" required maxlength="120" autocomplete="name">`)}${field('شماره تماس', `<input name="phone" type="tel" dir="ltr" inputmode="tel" value="${ctx.e(person?.phone || '')}" placeholder="۰۹۱۲۱۲۳۴۵۶۷" required maxlength="30" autocomplete="tel">`)}${field('نقش حساب', `<select name="role">${(role==='manager'?['manager']:assignableRoles).map(value=>`<option value="${value}" ${role===value?'selected':''}>${ctx.e(roleLabels[value])}</option>`).join('')}</select>`)}${field('نام کاربری', `<input name="username" dir="ltr" value="${ctx.e(person?.username || '')}" minlength="3" maxlength="40" autocomplete="off" ${role==='warehouse'?'required':''}><small class="muted" data-username-note>برای انباردار الزامی؛ ۳ تا ۴۰ نویسه، با حرف شروع شود</small>`)}${create ? field('رمز عبور', '<input name="password" type="password" required minlength="6" maxlength="128" autocomplete="new-password"><small class="muted">حداقل ۶ نویسه؛ ترکیب خاصی اجباری نیست</small>') : ''}`;
}
function wireAccountFields(){
  const form=document.querySelector('#modal-form'),role=form?.querySelector('[name="role"]'),username=form?.querySelector('[name="username"]');
  if(!role||!username)return;
  const update=()=>{username.required=role.value==='warehouse';};
  role.addEventListener('change',update);update();
}

function formProject(state, ctx, selected) { return field('پروژه', `<select name="projectId" required>${selectProjects(state, ctx, selected, false)}</select>`); }
function messageRows(rows, state, ctx) {
  return byDate(rows).map(m => `<article class="message-item"><div class="row between"><strong>${ctx.e(ctx.personName(m.authorId))}</strong><small class="muted">${ctx.e(ctx.date(m.createdAt))}</small></div><p class="pre-wrap">${ctx.e(m.text)}</p><div class="row between"><small class="muted">${ctx.e(ctx.projectName(m.projectId))}</small>${m.internal ? '<span class="badge">داخلی · تیم پروژه</span>' : '<span class="badge">قابل مشاهده برای مشتری</span>'}</div></article>`).join('') || empty('هنوز پیامی ثبت نشده است.', ctx);
}
function renderReports(state, ctx) {
  const m = selection(state, 'reports'), canSubmit = ['manager','worker'].includes(state.user.role) && list(state.projects).some(project=>project.canRecordWork!==false);
  const reviewInbox = renderProjectReviewInbox(state,ctx,{projectId:m.projectId});
  const rows = projectRows(state.reports, m.projectId).filter(r => m.filter === 'all' || r.status === m.filter);
  return `${header('گزارش‌های کار', 'گزارش‌های روزانه و پروندهٔ تفصیلی هر پروژه', canSubmit ? '<button class="button primary" data-new-report>+ گزارش روزانه</button>' : '', ctx)}${reviewInbox}${canSubmit?renderMemberMissions(state,ctx,m.projectId)+renderReportDrafts(state,ctx):''}
    ${state.user.role === 'manager' && !state.projects.length ? '<div class="notice">برای شروع، <a class="text-link" href="#team">نیروهای اجرایی را تعریف کنید</a> و سپس از <a class="text-link" href="#projects">بخش پروژه‌ها</a> پروژه بسازید و اعضای آن را مشخص کنید.</div>' : ''}
    <div class="grid metrics">${metric('گزارش‌های قابل مشاهده', ctx.e(ctx.n(state.reports.length)), 'بر اساس سطح دسترسی شما', ctx)}${metric('در انتظار بررسی', ctx.e(ctx.n(state.reports.filter(r => r.status === 'submitted').length)), 'نیازمند بررسی مدیر', ctx)}${metric('زمان تأییدشده', `${ctx.e(ctx.n(Math.round(sum(state.reports.filter(r => r.status === 'approved'), 'minutes') / 6) / 10))} ساعت`, 'فقط گزارش‌های تأییدشده', ctx)}</div>
    <section class="card"><div class="toolbar">${projectFilter(state, ctx, m.projectId)}<label>وضعیت<select data-report-filter><option value="all">همهٔ وضعیت‌ها</option>${['submitted','approved','changes_requested','rejected'].map(v => `<option value="${v}" ${m.filter === v ? 'selected' : ''}>${labels[v]}</option>`).join('')}</select></label></div>
    <div class="report-list">${byDate(rows).map(r => `<article class="list-item report-item"><div class="row between"><div><strong>${ctx.e(ctx.personName(r.workerId))}</strong><small class="muted"> · ${ctx.e(ctx.projectName(r.projectId))}</small></div>${ctx.badge(r.status)}</div>${renderReportProjectIdentity(r,state,ctx)}<p class="pre-wrap">${ctx.e(r.description)}</p><p class="muted pre-wrap">خروجی: ${ctx.e(r.output || 'ثبت نشده')}</p>${renderReportAttachments(r,ctx)}<div class="row between"><span class="muted">${ctx.e(ctx.date(r.date))} · ${ctx.e(r.start)} تا ${ctx.e(r.end)} · ${ctx.e(ctx.n(r.minutes))} دقیقه · استراحت ${ctx.e(ctx.n(r.breakMinutes || 0))} دقیقه</span>${['manager','accountant'].includes(state.user.role) ? `<strong>${ctx.money(r.laborCost || 0)}</strong>` : ''}</div>${r.reviewNote ? `<p class="review-note">یادداشت مدیر: ${ctx.e(r.reviewNote)}</p>` : ''}${['telegram','upload','text'].includes(r.source) ? `<p class="muted">منبع گزارش: ${ctx.e({telegram:'ویس تلگرام',upload:'فایل صوتی',text:'متن'}[r.source])}</p>` : ''}${r.status !== 'approved' && (state.user.role === 'manager' || r.workerId === state.user.id) ? `<button class="button secondary small" data-edit-report="${ctx.e(r.id)}">ویرایش و ارسال دوباره</button>` : ''}${state.user.role === 'manager' && r.status !== 'approved' ? `<div class="row"><button class="button primary small" data-review="${ctx.e(r.id)}" data-status="approved">تأیید گزارش</button><button class="button secondary small" data-review="${ctx.e(r.id)}" data-status="changes_requested">درخواست اصلاح</button><button class="button danger small" data-review="${ctx.e(r.id)}" data-status="rejected">رد گزارش</button></div>` : ''}</article>`).join('') || empty('گزارشی با این فیلتر وجود ندارد.', ctx)}</div></section>`;
}
function renderLaborCosts(state,ctx,projectId){
  const reports=projectRows(state.reports,projectId).filter(r=>r.status==='approved');
  return `<section class="card"><div class="card-head"><h2>کارکرد و دستمزد تأییدشده</h2><strong>${ctx.money(sum(reports,'laborCost'))}</strong></div><p class="muted">فقط گزارش‌های تأییدشده و نرخ قطعی همان گزارش در جمع هزینه منظور شده‌اند</p>${byDate(reports).map(r=>`<article class="list-item"><div class="row between"><strong>${ctx.e(ctx.personName(r.workerId))}</strong><strong>${ctx.money(r.laborCost||0)}</strong></div><small class="muted">${ctx.e(ctx.projectName(r.projectId))} · ${ctx.e(ctx.date(r.date))} · ${ctx.e(ctx.n(r.minutes))} دقیقه</small></article>`).join('')||empty('هنوز کارکرد تأییدشده‌ای ثبت نشده است',ctx)}</section>`;
}
function renderFinance(state, ctx) {
  const m = selection(state, 'finance');
  const invoices = projectRows(state.invoices, m.projectId);
  const receipts = projectRows(state.receipts, m.projectId);
  const materials = projectRows(state.materials, m.projectId);
  const manager = ['manager','accountant'].includes(state.user.role);
  if (!['manager','accountant','customer'].includes(state.user.role)) return empty('اطلاعات مالی برای این حساب در دسترس نیست.', ctx);
  return `${header('مالی و صورت‌حساب‌ها', 'مبالغ به تومان هستند؛ رسیدها پس از دریافت وجه توسط مدیر یا حسابدار ثبت می‌شوند.', manager ? '<button class="button primary" data-new-invoice>+ صورت‌حساب جدید</button>' : '', ctx)}
    <div class="grid metrics">${metric('مجموع صورت‌حساب‌ها', ctx.money(sum(invoices, 'amount')), 'صورت‌حساب‌های صادرشده', ctx)}${metric('پرداخت ثبت‌شده', ctx.money(sum(invoices, 'paid')), 'ثبت‌شده توسط مدیر', ctx)}${metric('ماندهٔ پرداخت', ctx.money(sum(invoices, 'amount') - sum(invoices, 'paid')), 'مبالغ تسویه‌نشده', ctx)}</div>
    ${manager ? financeTrend(state,ctx,m.projectId) : ''}<section class="card"><div class="toolbar">${projectFilter(state, ctx, m.projectId)}</div><div class="notice">دریافت وجه با رسید واقعی توسط مدیر یا حسابدار ثبت می‌شود. برای هماهنگی تسویه، از «هماهنگی پرداخت» در صورت‌حساب استفاده کنید؛ این صفحه درگاه بانکی نیست.</div><div class="invoice-list">${invoices.map(i => `<article class="list-item"><div class="row between"><div><h3>${ctx.e(i.title)}</h3><small class="muted">${ctx.e(ctx.projectName(i.projectId))} · سررسید ${ctx.e(ctx.date(i.dueDate))}</small></div>${ctx.badge(i.status)}</div><div class="grid metrics"><div><small>مبلغ</small><strong>${ctx.money(i.amount)}</strong></div><div><small>پرداخت‌شده</small><strong>${ctx.money(i.paid)}</strong></div><div><small>مانده</small><strong>${ctx.money(i.amount - i.paid)}</strong></div></div><div class="actions"><button class="button secondary small" data-invoice-details="${ctx.e(i.id)}">مشاهده و چاپ</button>${manager && i.amount > i.paid ? `<button class="button primary small" data-receipt="${ctx.e(i.id)}">ثبت رسید دریافتی</button>` : ''}${!manager && i.amount > i.paid ? `<button class="button primary small" data-coordinate-payment="${ctx.e(i.id)}">هماهنگی پرداخت</button>` : ''}</div></article>`).join('') || empty('هنوز صورت‌حسابی صادر نشده است.', ctx)}</div></section>
    <div class="grid two"><section class="card"><h2>تجهیزات مصرف‌شده</h2>${materials.map(item => `<div class="list-item"><div class="row between"><strong>${ctx.e(item.name)}</strong><span>${ctx.e(ctx.n(item.quantity))} ${ctx.e(item.unit)}</span></div><div class="row between"><small>${ctx.e(ctx.projectName(item.projectId))}${manager && !item.clientVisible ? ' · داخلی' : ''}</small><strong>${ctx.money(item.quantity * item.unitPrice)}</strong></div></div>`).join('') || empty('تجهیزات مصرفی ثبت نشده است.', ctx)}</section><section class="card"><h2>رسیدهای دریافت وجه</h2>${byDate(receipts).map(r => `<div class="list-item"><div class="row between"><strong>${ctx.money(r.amount)}</strong><small>${ctx.e(ctx.date(r.createdAt))}</small></div><p class="muted">شماره پیگیری: ${ctx.e(r.reference)}</p><small>${ctx.e(ctx.projectName(r.projectId))} · ثبت دستی توسط مدیر</small></div>`).join('') || empty('رسیدی برای این پروژه‌ها ثبت نشده است.', ctx)}</section></div>`+(manager?renderLaborCosts(state,ctx,m.projectId)+renderPersonalStockWorkspace(state,ctx,{finance:true}):'');
}
function renderInventory(state, ctx) {
  const low = state.inventory.filter(i => i.quantity <= i.minQuantity);
  return `${header('انبار و تجهیزات', 'ورود کالا و موجودی واقعی؛ مصرف تجهیزات از صفحهٔ هر پروژه ثبت می‌شود.', '<button class="button primary" data-new-inventory>+ کالای جدید</button>', ctx)}<div class="grid metrics">${metric('اقلام انبار', ctx.e(ctx.n(state.inventory.length)), 'نوع کالا', ctx)}${metric('نیازمند تأمین', ctx.e(ctx.n(low.length)), 'موجودی برابر یا کمتر از حداقل', ctx)}${metric('ارزش موجودی', ctx.money(state.inventory.reduce((v, i) => v + i.quantity * i.unitPrice, 0)), 'بر اساس بهای ثبت‌شده', ctx)}</div><section class="card">${state.inventory.map(i => `<article class="list-item"><div class="row between"><div><h3>${ctx.e(i.name)}</h3><small class="muted">بهای واحد ${ctx.money(i.unitPrice)} · حداقل ${ctx.e(ctx.n(i.minQuantity))} ${ctx.e(i.unit)}</small></div><span class="badge ${i.quantity <= i.minQuantity ? 'warning' : 'success'}">${ctx.e(ctx.n(i.quantity))} ${ctx.e(i.unit)}</span></div><button class="button secondary small" data-stock="${ctx.e(i.id)}">+ ورود به انبار</button></article>`).join('') || empty('هنوز کالایی تعریف نشده است. از «کالای جدید» نام، واحد و موجودی اولیه را ثبت کنید.', ctx)}</section>`;
}
function renderSupport(state, ctx) {
  const m = selection(state, 'support');
  const tickets = projectRows(state.tickets, m.projectId).filter(t => m.filter === 'all' || t.status === m.filter);
  return `${header('پیام‌ها و پشتیبانی', 'گفت‌وگوی پروژه و پیگیری درخواست‌های پشتیبانی در یک جا', '<button class="button primary" data-new-ticket>+ تیکت جدید</button>', ctx)}<section class="card"><div class="toolbar">${projectFilter(state, ctx, m.projectId)}<label>وضعیت تیکت<select data-ticket-filter><option value="all">همهٔ وضعیت‌ها</option>${['open','in_progress','resolved'].map(v => `<option value="${v}" ${m.filter === v ? 'selected' : ''}>${labels[v]}</option>`).join('')}</select></label></div></section><div class="grid two"><section class="card"><div class="row between"><h2>درخواست‌های پشتیبانی</h2><span class="badge">${ctx.e(ctx.n(tickets.length))}</span></div>${byDate(tickets).map(t => `<article class="list-item"><div class="row between"><h3>${ctx.e(t.subject)}</h3>${ctx.badge(t.status)}</div><p class="muted">${ctx.e(ctx.projectName(t.projectId))} · ${ctx.e(ctx.personName(t.authorId))}${t.priority === 'high' ? ' · اولویت بالا' : ''}</p><p class="pre-wrap">${ctx.e(t.description)}</p><div class="row between"><small>${ctx.e(ctx.date(t.createdAt))} · ${ctx.e(ctx.n(list(t.replies).length))} پاسخ</small><button class="button secondary small" data-ticket="${ctx.e(t.id)}">مشاهده و پاسخ</button></div></article>`).join('') || empty('درخواستی با این فیلتر وجود ندارد.', ctx)}</section><section class="card"><div class="row between"><h2>پیام‌های پروژه</h2><button class="button secondary small" data-new-message>+ پیام</button></div>${messageRows(projectRows(state.messages, m.projectId), state, ctx)}</section></div>`;
}
function conversation(state) {
  const m = memory('assistant', state);
  if (m.projectId && !state.projects.some(p => p.id === m.projectId)) m.projectId = '';
  if (!m.conversations.has(m.projectId)) m.conversations.set(m.projectId, { messages: [], pending: false, ticketId: '', draft: '', error: '' });
  return { m, chat: m.conversations.get(m.projectId) };
}
function renderAssistant(state, ctx) {
  const { m, chat } = conversation(state);
  const live = Boolean(ctx.capabilities?.ai) && !ctx.api.isStatic;
  const project = state.projects.find(p => p.id === m.projectId);
  const prompts = project ? ['وضعیت این پروژه را خلاصه کن', 'برای پیگیری مشکل چه اطلاعاتی لازم است؟', 'موارد باز این پروژه را مرور کن'] : ['آریوس چه خدماتی ارائه می‌دهد؟', 'چطور ویس را به گزارش کار تبدیل کنم؟', 'برای شروع پروژه چه اطلاعاتی آماده کنم؟'];
  return `${header('دستیار آریوس', 'گفت‌وگوی عمومی و راهنمایی بر اساس اطلاعات مجاز پروژهٔ انتخاب‌شده', '', ctx)}
    <section class="card assistant-shell" data-assistant-user="${ctx.e(state.user.id)}" data-assistant-project="${ctx.e(m.projectId)}">
      <div class="toolbar"><label>موضوع گفتگو<select data-ai-project><option value="">گفت‌وگوی عمومی آریوس</option>${selectProjects(state, ctx, m.projectId, false)}</select></label><span class="badge ${live ? 'success' : 'warning'}">${live ? 'سرویس پیکربندی شده' : 'سرویس نیازمند تنظیم است'}</span><button class="button secondary small" type="button" data-ai-clear ${chat.pending || !chat.messages.length ? 'disabled' : ''}>گفت‌وگوی تازه</button></div>
      <div class="notice">${project ? `${ctx.e(project.name)} · پیشرفت ${ctx.e(ctx.n(project.progress))}٪ · فقط اطلاعات مجاز همین پروژه در گفتگو استفاده می‌شود` : 'راهنمای خدمات و استفاده از آریوس؛ اطلاعات خصوصی پروژه‌ها در گفت‌وگوی عمومی استفاده نمی‌شود'}</div>
      ${!live ? `<div class="notice assistant-connection-note">${state.user.role === 'manager' ? 'برای دریافت پاسخ، اتصال اختصاصی هوش مصنوعی را در <a class="text-link" href="#voice">تنظیم اتصال‌ها</a> تکمیل کنید' : 'مدیر باید اتصال اختصاصی هوش مصنوعی را تنظیم کند'}${project ? '؛ در این فاصله می‌توانید درخواست پشتیبانی ثبت کنید' : ''}</div>` : ''}
      <div class="assistant-messages" aria-live="polite">${chat.messages.length ? chat.messages.map(msg => `<article class="chat-bubble ${msg.role === 'user' ? 'user' : 'assistant'}"><strong>${msg.role === 'user' ? 'شما' : 'دستیار آریوس'}</strong><p class="pre-wrap">${ctx.e(msg.content)}</p>${msg.sources?.length ? `<small class="muted">منابع: ${msg.sources.map(source => ctx.e(source.label)).join('، ')}</small>` : ''}</article>`).join('') : `<div class="assistant-welcome"><h2>چطور می‌توانم کمک کنم؟</h2><p class="muted">${project ? 'پرسش یا مسئلهٔ همین پروژه را بنویسید؛ گفتگو و ارجاع به پشتیبانی در همین زمینه باقی می‌ماند' : 'برای پرسش دربارهٔ خدمات، مسیر همکاری و استفاده از فضای کار، نیازی به ساخت پروژه نیست'}</p><div class="assistant-prompts">${prompts.map(prompt => `<button class="button secondary small" type="button" data-ai-prompt="${ctx.e(prompt)}">${ctx.e(prompt)}</button>`).join('')}</div></div>`}${chat.pending ? '<p class="assistant-loading" role="status">دستیار در حال آماده‌کردن پاسخ است…</p>' : ''}</div>
      ${chat.error ? `<div class="assistant-error" role="alert"><p>${ctx.e(chat.error)}</p><span>متن پیام حفظ شده است</span><button class="button secondary small" type="button" data-ai-retry ${!live || chat.pending ? 'disabled' : ''}>تلاش دوباره</button></div>` : ''}
      ${chat.ticketId ? `<div class="notice success">تیکت پشتیبانی ${ctx.e(chat.ticketId)} ثبت شد <button class="button secondary small" data-open-support>پیگیری تیکت</button></div>` : ''}
      <form data-ai-form><label>پیام شما<textarea name="message" rows="4" maxlength="4000" placeholder="پرسش خود را بنویسید…" ${chat.pending ? 'disabled' : ''}>${ctx.e(chat.draft)}</textarea></label><div class="row between"><small class="muted">${project ? 'در صورت نیاز، همین گفتگو به تیکت پشتیبانی تبدیل می‌شود' : 'برای بررسی اطلاعات پروژه، آن را از فهرست بالا انتخاب کنید'}</small><div class="row"><button class="button primary" type="submit" ${!live || chat.pending ? 'disabled' : ''}>${chat.pending ? 'در حال پاسخ…' : 'ارسال پیام'}</button>${project ? `<button class="button secondary" type="button" data-ai-escalate ${chat.pending || chat.ticketId ? 'disabled' : ''}>${chat.ticketId ? 'تیکت ثبت شده' : 'ثبت تیکت پشتیبانی'}</button>` : ''}</div></div></form>
    </section><nav class="assistant-quick-actions" aria-label="دسترسی سریع دستیار">${[[state.user.role==='customer'?'projects':'reports','گزارش و فعالیت','reports'],[state.user.role==='manager'?'analytics':'projects','تحلیل و پیشرفت','analytics'],['notifications','یادآوری‌ها','bell'],['projects','جست‌وجوی پروژه','search']].map(([route,title,icon])=>`<a href="#${route}">${ctx.icon(icon)}<strong>${title}</strong></a>`).join('')}</nav>`;
}
function renderNotifications(state, ctx) {
  const items = portalNotifications(state), groups = [['report', 'گزارش منتظر بررسی'], ['review', 'گزارش نیازمند اصلاح'], ['ticket', 'درخواست پشتیبانی'], ['invoice', 'صورت‌حساب باز'], ['message', 'پیام پروژه']];
  return `${header('مرکز پیگیری', 'موارد قابل پیگیری بر اساس وضعیت فعلی پروژه‌های مجاز شما', '', ctx)}<div class="grid metrics">${groups.filter(([kind]) => items.some(item => item.kind === kind)).map(([kind,label]) => metric(label, ctx.e(ctx.n(items.filter(item => item.kind === kind).length)), 'بر اساس اطلاعات فعلی فضای کار', ctx)).join('')}</div><section class="card notifications-list"><div class="card-head"><h2>پیگیری‌های پروژه</h2><span class="muted">حداکثر ۶۰ مورد اخیر</span></div>${items.map(item => `<a class="notification-item" href="${ctx.e(item.href)}"><span class="notification-kind">${ctx.icon({report:'reports',review:'reports',ticket:'support',invoice:'finance',message:'messages'}[item.kind])}</span><div><strong>${ctx.e(item.title)}</strong><p>${ctx.e(String(item.detail || '').slice(0, 300))}</p><small>${ctx.e(ctx.projectName(item.projectId))} · ${ctx.e(ctx.date(item.date))}</small></div><span aria-hidden="true">←</span></a>`).join('') || `<div class="empty-state"><h3>موردی برای پیگیری ندارید</h3><p>با ثبت پیام، درخواست، گزارش یا صورت‌حساب، موارد مرتبط در این صفحه قرار می‌گیرند</p><a class="button secondary" href="#projects">مشاهدهٔ پروژه‌ها</a></div>`}</section>`;
}
function accountActions(person,ctx){
  if(!supabaseAuth(ctx))return '';
  if(person.managementRole==='primary'&&ctx.managementRoles?.canTransferPrimary===false&&ctx.userId!==person.id)return '<small class="muted">حساب مدیر اصلی فقط توسط خود او ویرایش می‌شود.</small>';
  if(person.role==='manager')return `${person.deletedAt?'':`<button class="button secondary small" data-edit-account="${ctx.e(person.id)}">ویرایش اطلاعات</button>`}<small class="muted">نقش مدیر و دسترسی حساب اصلی محافظت شده است.</small>`;
  const id=ctx.e(person.id);
  const status=person.loginNeedsReview ? '<span class="badge warning">ورود نیازمند هماهنگی نقش</span>' : person.loginEnabled===false ? '<span class="badge warning">ورود فعال نشده</span>' : person.loginEnabled===true ? '<span class="badge success">ورود فعال</span>' : '';
  return person.deletedAt ? `<button class="button secondary small" data-restore-account="${id}">بازگرداندن دسترسی</button>` : `${status}<button class="button secondary small" data-edit-account="${id}">ویرایش اطلاعات و نقش</button>${accountLoginAction(person,ctx)}<button class="button danger small" data-archive-account="${id}">حذف دسترسی</button>`;
}
function accountLoginAction(person,ctx,resetLabel='بازنشانی رمز'){
  if(person.loginNeedsReview)return '<small class="muted">ابتدا اطلاعات و نقش این فرد را ویرایش و دوباره ذخیره کنید</small>';
  const id=ctx.e(person.id);
  return person.loginEnabled===false ? `<button class="button primary small" data-activate-account="${id}">فعال‌سازی ورود</button>` : `<button class="button secondary small" data-reset-account="${id}">${resetLabel}</button>`;
}
function renderPasswordRequests(state,ctx){
  if(!supabaseAuth(ctx))return '';
  const m=memory('password-requests',state);
  return `<section class="card" data-password-requests-user="${ctx.e(state.user.id)}"><div class="card-head"><div><h2>درخواست‌های بازیابی رمز</h2><p class="muted">پس از احراز هویت فرد، رمز تازه را تعیین و از مسیر مورد توافق به خود او اعلام کنید</p></div><button class="button secondary small" data-load-password-requests>تازه‌سازی درخواست‌ها</button></div><div data-password-request-list>${m.requests ? passwordRequestRows(m.requests,state,ctx) : '<p class="muted">برای مشاهده، درخواست‌ها را تازه‌سازی کنید</p>'}</div></section>`;
}
function passwordRequestRows(requests,state,ctx){
  return requests.filter(r=>r.status==='pending'&&state.users.some(u=>u.id===r.userId&&!u.deletedAt)).map(r=>{
    const person=state.users.find(u=>u.id===r.userId);
    return `<article class="list-item"><div class="row between"><div><strong>${ctx.e(ctx.personName(r.userId))}</strong><p class="muted" dir="ltr">${ctx.e(r.identifier)}</p><small>${ctx.e(ctx.date(r.createdAt))}</small></div>${person.role==='manager'?'<p class="muted">حساب مالک محافظت شده است؛ بازیابی آن از <a class="text-link" href="https://supabase.com/dashboard/project/qategfabulrkvdckzmqp/auth/users" target="_blank" rel="noopener noreferrer">داشبورد رسمی احراز هویت</a> انجام می‌شود</p>':accountLoginAction(person,ctx,'تعیین رمز تازه')}</div></article>`;
  }).join('')||'<p class="muted">درخواست بازی در انتظار بررسی نیست</p>';
}

function renderTeam(state, ctx) {
  const active=state.users.filter(u=>!u.deletedAt),managers=active.filter(u=>u.role==='manager'),workers=active.filter(u=>u.role==='worker'),customers=active.filter(u=>u.role==='customer'),specialists=active.filter(u=>['warehouse','accountant'].includes(u.role)),archived=state.users.filter(u=>u.deletedAt);
  const hosted=Boolean(ctx.capabilities?.hosted)&&!supabaseAuth(ctx);
  const personRow=person=>`<article class="list-item"><div class="row between"><div><h3>${ctx.e(person.name)}</h3><p>${contact(person,ctx)}</p>${person.username?`<small class="muted">نام کاربری: <b dir="ltr">${ctx.e(person.username)}</b></small>`:''}</div><span class="badge">${ctx.e(person.managementTitle||roleLabels[person.role]||person.role)}</span></div><div class="actions">${accountActions(person,ctx)}</div></article>`;
  return `${header('کاربران و دسترسی‌ها',supabaseAuth(ctx)?'حساب مستقل برای همکار، مشتری، انباردار و حسابدار':'نیروها، مشتریان و دسترسی پروژه',`${supabaseAuth(ctx)?'':'<button class="button secondary" data-new-profile>+ نیروی اجرایی</button>'}<button class="button primary" data-new-account>${supabaseAuth(ctx)?'+ ثبت کاربر':hosted?'+ عضو یا مشتری':'+ حساب ورود'}</button>`,ctx)}<div class="grid metrics">${metric('همکاران اجرایی',ctx.e(ctx.n(workers.length)),'حساب‌های فعال',ctx)}${metric('مشتریان',ctx.e(ctx.n(customers.length)),'حساب‌های فعال',ctx)}${metric('انبار و حسابداری',ctx.e(ctx.n(specialists.length)),'دسترسی‌های اختصاصی',ctx)}${metric('نیروهای دارای پروژه',ctx.e(ctx.n(workers.filter(worker=>state.projects.some(project=>project.status!=='completed'&&list(project.memberIds).includes(worker.id))).length)),'تخصیص به پروژهٔ در جریان',ctx)}</div>${teamOverview(state,ctx)}${renderPersonalStockTeamSummary(state,ctx)}<section class="card"><h2>مدیران</h2>${managers.map(personRow).join('')||empty('مدیری ثبت نشده است',ctx)}</section><section class="card"><h2>همکاران اجرایی</h2>${workers.map(w=>`<article class="list-item"><div class="row between"><div><h3>${ctx.e(w.name)}</h3><small class="muted">${ctx.e(w.skill||'تخصص ثبت نشده')} · ${ctx.e(w.department||'تیم آریوس')}</small><p>${contact(w,ctx)}</p>${w.username?`<small dir="ltr">${ctx.e(w.username)}</small>`:''}</div><span class="badge">${ctx.e(ctx.n(state.projects.filter(p=>list(p.memberIds).includes(w.id)).length))} پروژه</span></div><div class="row between"><span>نرخ پایه: ${ctx.money(w.hourlyRate||0)} / ساعت</span><div class="actions">${accountActions(w,ctx)}<button class="button primary small" data-member-mission="${ctx.e(w.id)}">ثبت مأموریت</button><button class="button secondary small" data-rate="${ctx.e(w.id)}">ثبت نرخ تاریخ‌دار</button></div></div>${list(w.rateHistory).length?`<details><summary>تاریخچهٔ نرخ‌ها</summary>${[...w.rateHistory].sort((a,b)=>a.effectiveDate.localeCompare(b.effectiveDate)).map(rate=>`<p>${ctx.e(ctx.date(rate.effectiveDate))} — ${ctx.money(rate.hourlyRate)} / ساعت</p>`).join('')}</details>`:'<small class="muted">هنوز نرخ تاریخ‌دار ثبت نشده است</small>'}</article>`).join('')||empty('همکاری ثبت نشده است',ctx)}</section><section class="card"><h2>مشتریان</h2>${customers.map(personRow).join('')||empty('مشتری ثبت نشده است',ctx)}</section><section class="card"><h2>انباردار و حسابدار</h2><p class="muted">انباردار فقط به انبار و ثبت مصرف پروژه دسترسی دارد؛ حسابدار از بخش مالی استفاده می‌کند</p>${specialists.map(personRow).join('')||empty('حسابی برای انبار و حسابداری ثبت نشده است',ctx)}</section>${supabaseAuth(ctx)?`<div class="notice">هر شخص یک حساب دارد. برای تبدیل مشتری به همکار یا برعکس، اطلاعات و نقش همان حساب را ویرایش کنید؛ سوابق قبلی حفظ می‌شوند.</div><section class="card"><details><summary>حساب‌های حذف‌شده از فهرست فعال (${ctx.e(ctx.n(archived.length))})</summary><p class="muted">ورود این حساب‌ها قطع است؛ گزارش‌ها و سوابق مالی حفظ شده‌اند. برای استفادهٔ دوباره از همان شماره، دسترسی حساب را بازگردانید.</p>${archived.map(personRow).join('')||empty('حساب حذف‌شده‌ای وجود ندارد',ctx)}</details></section>${renderPasswordRequests(state,ctx)}`:''}`;
}
function renderAnalytics(state, ctx) {
  const approved = state.reports.filter(r => r.status === 'approved');
  const progress = state.projects.length ? Math.round(sum(state.projects, 'progress') / state.projects.length) : 0;
  return `${header('گزارش‌ها و تحلیل‌ها', 'خلاصهٔ محاسبه‌شده از اطلاعات واقعی همین فضای کاری', '', ctx)}${analyticsExports(ctx)}<div class="grid metrics">${metric('پیشرفت میانگین', `${ctx.e(ctx.n(progress))}٪`, 'میانگین سادهٔ پروژه‌ها', ctx)}${metric('زمان کار تأییدشده', `${ctx.e(ctx.n(Math.round(sum(approved, 'minutes') / 6) / 10))} ساعت`, 'گزارش‌های تأییدشده', ctx)}${metric('درخواست‌های باز', ctx.e(ctx.n(state.tickets.filter(t => t.status !== 'resolved').length)), 'باز و در حال رسیدگی', ctx)}${metric('وصول صورت‌حساب‌ها', `${ctx.e(ctx.n(sum(state.invoices,'amount') ? Math.round(sum(state.invoices,'paid') / sum(state.invoices,'amount') * 100) : 0))}٪`, 'نسبت پرداخت به مبلغ صادرشده', ctx)}</div>${analyticsCharts(state,ctx)}<section class="card"><h2>عملکرد پروژه‌ها</h2>${state.projects.map(p => { const reports = approved.filter(r => r.projectId === p.id); const materialCost = state.materials.filter(r => r.projectId === p.id).reduce((v,r) => v + r.quantity * r.unitPrice,0); const labor = sum(reports,'laborCost'); const invoices = state.invoices.filter(i => i.projectId === p.id); return `<article class="list-item"><div class="row between"><a href="#project/${ctx.e(p.id)}"><h3>${ctx.e(p.name)}</h3></a><strong>${ctx.e(ctx.n(p.progress))}٪</strong></div><progress max="100" value="${Math.max(0, Math.min(100, Number(p.progress) || 0))}"></progress><div class="grid metrics"><div><small>هزینهٔ تجهیزات</small><strong>${ctx.money(materialCost)}</strong></div><div><small>دستمزد تأییدشده</small><strong>${ctx.money(labor)}</strong></div><div><small>جمع هزینهٔ ثبت‌شده</small><strong>${ctx.money(materialCost + labor)}</strong></div><div><small>ماندهٔ صورت‌حساب‌ها</small><strong>${ctx.money(sum(invoices,'amount') - sum(invoices,'paid'))}</strong></div></div></article>`; }).join('') || empty('پروژه‌ای برای تحلیل وجود ندارد.', ctx)}</section><div class="grid two"><section class="card"><h2>وضعیت پروژه‌ها</h2>${['active','attention','completed'].map(status => `<div class="list-item row between">${ctx.badge(status)}<strong>${ctx.e(ctx.n(state.projects.filter(p => p.status === status).length))}</strong></div>`).join('')}</section><section class="card"><h2>وضعیت پشتیبانی</h2>${['open','in_progress','resolved'].map(status => `<div class="list-item row between">${ctx.badge(status)}<strong>${ctx.e(ctx.n(state.tickets.filter(t => t.status === status).length))}</strong></div>`).join('')}</section></div>`;
}
function renderSettings(state, ctx) {
  const live = Boolean(ctx.capabilities?.ai) && !ctx.api.isStatic;
  return `${header('تنظیمات و اطلاعات حساب', 'اطلاعات اتصال و خروجیِ مجاز همین پروژهٔ مستقل آریوس', '', ctx)}<div class="grid two"><section class="card"><h2>حساب شما</h2><div class="list-item"><strong>${ctx.e(state.user.name)}</strong><p>${contact(state.user, ctx)}</p>${state.user.role === 'manager' && state.user.email ? `<p class="muted">${ctx.e(state.user.email)}</p>` : ''}${state.user.username?`<p class="muted">نام کاربری: <b dir="ltr">${ctx.e(state.user.username)}</b></p>`:''}<span class="badge">${ctx.e(state.user.managementTitle || labels[state.user.role] || state.user.role)}</span></div><p class="muted">${ctx.api.isStatic ? 'این پیش‌نمایش از دادهٔ نمایشی در مرورگر استفاده می‌کند؛ حساب واقعی ساخته نمی‌شود.' : ctx.demo ? 'نسخهٔ نمایشی سرور با اطلاعات ساختگی آریوس فعال است.' : 'ورود مستقل و دسترسی‌های پروژه در سرور کنترل می‌شوند.'}</p></section><section class="card"><h2>وضعیت اتصال‌ها</h2><div class="list-item row between"><span>دستیار هوش مصنوعی</span><span class="badge ${live ? 'success' : 'warning'}">${live ? 'پیکربندی شده' : 'نیازمند تنظیم اتصال اختصاصی'}</span></div><div class="list-item row between"><span>ثبت دریافت وجه</span><span class="badge">رسید واقعی با تأیید مدیر</span></div><p class="muted">دریافت وجه توسط مدیر با رسید و شماره پیگیری ثبت می‌شود. اطلاعات اتصال محرمانه در مرورگر نمایش داده نمی‌شود.</p><div class="actions">${state.user.role === 'manager' ? '<a class="button primary" href="#voice">تنظیم اتصال‌ها</a>' : ''}${['manager','accountant','customer'].includes(state.user.role) ? '<a class="button secondary" href="#finance">صورت‌حساب و دریافت‌ها</a>' : ''}</div></section></div>${state.user.role === 'manager' ? `<section class="card"><h2>خروجی و سوابق</h2><p class="muted">فایل JSON شامل داده‌های مجاز این مدیر است. این خروجی جایگزین نسخهٔ پشتیبان پایگاه داده نیست.</p><div class="row"><button class="button primary" data-export>دریافت خروجی داده‌ها</button>${ctx.api.isStatic || (ctx.capabilities?.hosted && !ctx.capabilities?.supabaseAuth) ? '<a class="button secondary" href="./downloads/ARIOS_OS_source.zip" download>دریافت سورس آریوس</a>' : ''}</div><h3>آخرین فعالیت‌ها</h3>${byDate(list(state.audit)).slice(0,12).map(a => `<div class="list-item"><strong>${ctx.e(a.description || a.action)}</strong><p class="muted">${ctx.e(ctx.personName(a.actorId))} · ${ctx.e(ctx.date(a.createdAt))}</p></div>`).join('') || empty('فعالیتی ثبت نشده است.', ctx)}</section>` : ''}`;
}
export function renderOperations(page, state, ctx) {
  if (!['reports','finance','inventory','support','assistant','team','analytics','settings','notifications'].includes(page)) return null;
  if (!allowed(page,state)) return empty('این بخش برای نقش شما در دسترس نیست.', ctx);
  return (state.user.role==='manager'&&['team','settings'].includes(page)?renderManagementRoleSettings(state,ctx):'')+(page==='settings'?renderPasskeySettings(state,ctx):'')+({reports:renderReports,finance:renderFinance,inventory:renderInventory,support:renderSupport,assistant:renderAssistant,notifications:renderNotifications,team:renderTeam,analytics:renderAnalytics,settings:renderSettings})[page](state,ctx);
}
function bind(selector, fn) { document.querySelectorAll(selector).forEach(el => el.addEventListener('click', () => fn(el))); }
function ticketModal(state, ctx, projectId = '', description = '', after) {
  if (!state.projects.length) return ctx.toast('ابتدا باید به یک پروژه دسترسی داشته باشید.');
  ctx.modal({title:'درخواست پشتیبانی جدید', submitLabel:'ثبت تیکت', body:`${formProject(state,ctx,projectId)}${field('موضوع','<input name="subject" required maxlength="180" placeholder="خلاصهٔ مسئله">')}${field('اولویت','<select name="priority"><option value="normal">عادی</option><option value="high">بالا</option></select>')}${field('شرح مسئله',`<textarea name="description" required rows="7" maxlength="16000">${ctx.e(description)}</textarea>`)}`, onSubmit:async data => { const result=await ctx.mutate('ticket.create',Object.fromEntries(data)); if (after) after(result); }});
}
function newMessage(state, ctx, projectId, initialText = '') {
  if (!state.projects.length) return ctx.toast('پروژه‌ای برای ارسال پیام ندارید.');
  ctx.modal({title:'پیام پروژه',submitLabel:'ارسال پیام',body:`${formProject(state,ctx,projectId)}${field('متن پیام',`<textarea name="text" required rows="5" maxlength="8000">${ctx.e(initialText)}</textarea>`)}${state.user.role !== 'customer' ? '<label class="checkbox"><input type="checkbox" name="internal">پیام داخلی تیم؛ برای مشتری نمایش داده نشود</label>' : '<p class="muted">این پیام برای تیم پروژه ارسال می‌شود.</p>'}`,onSubmit: data => ctx.mutate('message.send',{projectId:data.get('projectId'),text:data.get('text'),internal:data.has('internal')})});
}
function openTicket(ticket,state,ctx) {
  ctx.modal({title:ticket.subject,submitLabel:'ارسال پاسخ',body:`<p class="pre-wrap">${ctx.e(ticket.description)}</p>${ctx.badge(ticket.status)}<div class="ticket-replies">${list(ticket.replies).map(reply => `<article class="message-item"><strong>${ctx.e(ctx.personName(reply.authorId))}</strong><small class="muted"> · ${ctx.e(ctx.date(reply.createdAt))}</small><p class="pre-wrap">${ctx.e(reply.text)}</p></article>`).join('') || empty('هنوز پاسخی ثبت نشده است.',ctx)}</div>${field('پاسخ شما','<textarea name="text" required rows="4" maxlength="8000"></textarea>')}${state.user.role === 'manager' ? `<label>وضعیت تیکت<select data-ticket-status="${ctx.e(ticket.id)}">${['open','in_progress','resolved'].map(v => `<option value="${v}" ${ticket.status === v ? 'selected' : ''}>${labels[v]}</option>`).join('')}</select></label><p class="muted">تغییر وضعیت مستقل از ارسال پاسخ ذخیره می‌شود.</p>` : ''}`,onSubmit:data=>ctx.mutate('ticket.reply',{id:ticket.id,text:data.get('text')})});
  const input=document.querySelector('[data-ticket-status]');
  input?.addEventListener('change',async()=>{ input.disabled=true; try { await ctx.mutate('ticket.update',{id:ticket.id,status:input.value}); } catch(error) { input.disabled=false; input.value=ticket.status; ctx.toast(error.message); }});
}
function openInvoiceDetails(invoice,state,ctx) {
  const receipts=list(state.receipts).filter(item=>item.invoiceId===invoice.id);
  const logoURL=new URL('/assets/brand/arios-logo-navy-gold-v2.webp',globalThis.location?.href||'https://arios-rouge.vercel.app/').href;
  const content=`<div class="invoice-document"><img class="invoice-brand-logo" src="${ctx.e(logoURL)}" width="110" height="96" alt="لوگوی آریوس"><h2>${ctx.e(invoice.title)}</h2><p>${ctx.e(ctx.projectName(invoice.projectId))}</p><div class="info-row"><span>شناسهٔ صورت‌حساب</span><strong>${ctx.e(invoice.id)}</strong></div><div class="info-row"><span>سررسید</span><strong>${ctx.e(ctx.date(invoice.dueDate))}</strong></div><div class="info-row"><span>مبلغ صورت‌حساب</span><strong>${ctx.money(invoice.amount)}</strong></div><div class="info-row"><span>پرداخت ثبت‌شده</span><strong>${ctx.money(invoice.paid)}</strong></div><div class="info-row"><span>مانده</span><strong>${ctx.money(invoice.amount-invoice.paid)}</strong></div><h3>رسیدهای ثبت‌شده</h3>${receipts.map(receipt=>`<p>${ctx.e(ctx.date(receipt.createdAt))} · ${ctx.money(receipt.amount)} · پیگیری ${ctx.e(receipt.reference)}</p>`).join('')||'<p>رسیدی برای این صورت‌حساب ثبت نشده است</p>'}<p class="invoice-document-note">این برگه بازنمایی سوابق ثبت‌شده در آریوس است و رسید بانکی یا تأیید پرداخت جدید محسوب نمی‌شود</p></div>`;
  ctx.modal({title:'جزئیات صورت‌حساب',submitLabel:'چاپ صورت‌حساب',body:content,onSubmit:async()=>{
    const popup=window.open('','_blank');
    if(!popup)throw new Error('برای چاپ، اجازهٔ باز شدن پنجرهٔ جدید را در مرورگر بدهید');
    popup.opener=null;
    popup.addEventListener('load',()=>{popup.focus();popup.print();},{once:true});
    popup.document.write(`<!doctype html><html lang="fa" dir="rtl"><head><meta charset="utf-8"><title>${ctx.e(invoice.title)}</title><style>body{font-family:Tahoma,Arial,sans-serif;max-width:760px;margin:50px auto;line-height:2;color:#1b3036;padding:20px}.info-row{display:flex;justify-content:space-between;gap:30px;border-bottom:1px solid #ddd;padding:8px 0}.invoice-brand-logo{display:block;width:110px;height:96px;object-fit:contain;margin-bottom:20px}h2{font-size:24px}small{font-size:11px}.eyebrow{letter-spacing:3px;color:#8b754d}.invoice-document-note{margin-top:30px;font-size:11px;color:#666}@media print{body{margin:0;padding:12mm}}</style></head><body>${content}</body></html>`);
    popup.document.close();
  }});
}
function isCurrentAssistant(userId, projectId) {
  const mount=document.querySelector('[data-assistant-user]');
  return mount?.dataset.assistantUser === userId && mount.dataset.assistantProject === projectId;
}
function wireAssistant(state,ctx) {
  const {m,chat}=conversation(state);
  const selector=document.querySelector('[data-ai-project]');
  selector?.addEventListener('change',()=>{ m.projectId=selector.value; ctx.refresh(); });
  const form=document.querySelector('[data-ai-form]');
  const textarea=form?.querySelector('textarea');
  textarea?.addEventListener('input',()=>{chat.draft=textarea.value;});
  bind('[data-ai-prompt]',el=>{if(!textarea || chat.pending)return;chat.draft=el.dataset.aiPrompt;textarea.value=chat.draft;textarea.focus();});
  bind('[data-ai-clear]',()=>{if(chat.pending)return;chat.messages=[];chat.draft='';chat.error='';chat.ticketId='';ctx.refresh();});
  bind('[data-ai-retry]',()=>{if(!chat.pending && textarea?.value.trim())form?.requestSubmit();});
  bind('[data-open-support]',()=>ctx.go('support'));
  form?.addEventListener('submit',async event=>{
    event.preventDefault();
    if (!ctx.capabilities?.ai || ctx.api.isStatic || chat.pending) return;
    const message=textarea.value.trim();
    if (!message) return ctx.toast('پیام خود را بنویسید');
    const userId=state.user.id, projectId=m.projectId;
    const history=chat.messages.slice(-10).map(({role,content})=>({role,content}));
    const submitted={role:'user',content:message};
    chat.messages.push(submitted);chat.draft='';chat.pending=true;chat.error='';
    ctx.refresh();
    try {
      const result=await ctx.api.assistant({...(projectId?{projectId}:{}),message,history});
      if (typeof result.answer !== 'string' || !result.answer.trim() || result.live !== true) throw new Error('پاسخ معتبر از اتصال هوش مصنوعی دریافت نشد');
      chat.messages.push({role:'assistant',content:result.answer,sources:list(result.sources)});
      if (projectId && result.ticket?.id) chat.ticketId=result.ticket.id;
    } catch(error) {
      chat.messages=chat.messages.filter(item=>item!==submitted);
      chat.draft=message;
      chat.error=error.message || 'اتصال به دستیار برقرار نشد؛ دوباره تلاش کنید';
    } finally {
      chat.pending=false;
      // A delayed response may never render into a different account or project.
      if(isCurrentAssistant(userId,projectId)) {
        try { await ctx.refresh(); } catch(error) { ctx.toast(error.message || 'تازه‌سازی گفتگو انجام نشد'); }
      }
    }
  });
  bind('[data-ai-escalate]',()=>{
    if(chat.pending || chat.ticketId || !m.projectId) return;
    const draft=(textarea?.value || chat.draft || '').trim();
    const transcript=chat.messages.map(message=>`${message.role === 'user' ? 'کاربر' : 'دستیار'}: ${message.content}`).join('\n\n');
    const description=[transcript,draft ? `شرح تکمیلی مسئله: ${draft}` : ''].filter(Boolean).join('\n\n');
    if(!description) return ctx.toast('ابتدا شرح مسئله را بنویسید');
    ticketModal(state,ctx,m.projectId,description,result=>{chat.ticketId=result?.id || result?.ticket?.id || 'ثبت‌شده';ctx.refresh();});
  });
}
function editReport(report,state,ctx) {
  if(report.status==='approved'||(state.user.role!=='manager'&&report.workerId!==state.user.id))return;
  return openReportComposer(state,ctx,report.projectId,{report});
}
function openAccountActivation(id,state,ctx){
  const person=state.users.find(u=>u.id===id);
  if(!supabaseAuth(ctx)||!person||person.deletedAt||person.loginEnabled!==false||person.loginNeedsReview||!assignableRoles.includes(person.role))return;
  ctx.modal({title:`فعال‌سازی ورود: ${person.name}`,submitLabel:'فعال‌سازی ورود همین فرد',body:`<p>حساب ورود برای <strong>${ctx.e(person.name)}</strong> ساخته می‌شود. نقش فعلی: <strong>${ctx.e(roleLabels[person.role]||person.role)}</strong></p><div class="notice">این کار روی همین پرونده انجام می‌شود؛ فرد دوباره ثبت نمی‌شود و پروژه‌ها، گزارش‌ها، نرخ‌ها و سوابق مالی حفظ می‌شوند. رمز تازه را فقط به صاحب حساب اعلام کنید؛ پیامک یا ایمیل خودکار ارسال نمی‌شود.</div>${field('شماره تماس',`<input name="phone" type="tel" dir="ltr" inputmode="tel" value="${ctx.e(person.phone||'')}" required maxlength="30" autocomplete="tel">`)}${field('نام کاربری',`<input name="username" dir="ltr" value="${ctx.e(person.username||'')}" minlength="3" maxlength="40" autocomplete="off" ${person.role==='warehouse'?'required':''}><small class="muted">برای انباردار الزامی؛ ۳ تا ۴۰ نویسه، با حرف شروع شود</small>`)}${field('رمز ورود','<input name="password" type="password" required minlength="6" maxlength="128" autocomplete="new-password"><small class="muted">حداقل ۶ نویسه</small>')}${field('تکرار رمز ورود','<input name="confirmPassword" type="password" required minlength="6" maxlength="128" autocomplete="new-password">')}`,onSubmit:async data=>{
    const password=data.get('password');
    if(typeof password!=='string'||password.length<6||password.length>128)throw Error('رمز ورود باید بین ۶ تا ۱۲۸ نویسه باشد');
    if(password!==data.get('confirmPassword'))throw Error('رمز و تکرار آن یکسان نیستند');
    return ctx.mutate('account.activate',{id:person.id,phone:data.get('phone'),username:data.get('username')||'',password});
  }});
}
function openAccountPasswordReset(id,state,ctx){
  const person=state.users.find(u=>u.id===id);if(!supabaseAuth(ctx)||person?.deletedAt||!assignableRoles.includes(person?.role))return;
  if(person.loginNeedsReview)return ctx.toast('ابتدا اطلاعات و نقش این فرد را ویرایش و دوباره ذخیره کنید');
  if(person.loginEnabled===false)return openAccountActivation(id,state,ctx);
  ctx.modal({title:`بازنشانی رمز: ${person.name}`,submitLabel:'ثبت رمز تازه',body:`<div class="notice">ابتدا هویت فرد را بررسی کنید. پس از ذخیره، نشست‌های ورود قبلی او قطع می‌شوند. پیامک یا ایمیل خودکار ارسال نمی‌شود؛ رمز تازه را از مسیر مورد توافق فقط به صاحب حساب اعلام کنید.</div>${field('رمز تازه','<input name="password" type="password" required minlength="6" maxlength="128" autocomplete="new-password"><small class="muted">حداقل ۶ نویسه</small>')}${field('تکرار رمز تازه','<input name="confirmPassword" type="password" required minlength="6" maxlength="128" autocomplete="new-password">')}`,onSubmit:async data=>{
    if(data.get('password')!==data.get('confirmPassword'))throw Error('رمز و تکرار آن یکسان نیستند');
    const pending=memory('password-requests',state),previous=pending.requests;pending.requests=undefined;
    try{return await ctx.mutate('account.password.reset',{id:person.id,password:data.get('password')});}
    catch(error){pending.requests=previous;throw error;}
  }});
}
export function wireOperations(page,state,ctx) {
  if(page==='settings')wirePasskeySettings(state,ctx);
  if(state.user.role==='manager'&&['team','settings'].includes(page))wireManagementRoleSettings(state,ctx);
  if(!allowed(page,state)) return;
  if(page==='finance'||page==='team')wirePersonalStockWorkspace(state,ctx);
  document.querySelector('[data-project-filter]')?.addEventListener('change',event=>{memory(page,state).projectId=event.target.value;ctx.refresh();});
  if(page==='assistant') return wireAssistant(state,ctx);
  if(page==='analytics' && state.user.role==='manager') bind('[data-analytics-export]',button=>{
    try { const content=analyticsCSV(button.dataset.analyticsExport,state),url=URL.createObjectURL(new Blob([content],{type:'text/csv;charset=utf-8'})),link=document.createElement('a');link.href=url;link.download=`ARIOS-${button.dataset.analyticsExport}-${new Date().toISOString().slice(0,10)}.csv`;document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000); } catch(error) { ctx.toast(error.message); }
  });
  if(page==='team') document.querySelector('[data-team-search]')?.addEventListener('input',event=>{const query=event.target.value.trim().replace(/ي/g,'ی').replace(/ك/g,'ک');let visible=0;document.querySelectorAll('[data-team-overview-row]').forEach(row=>{row.hidden=!String(row.dataset.teamKey||'').replace(/ي/g,'ی').replace(/ك/g,'ک').includes(query);if(!row.hidden)visible++;});const empty=document.querySelector('[data-team-search-empty]');if(empty)empty.hidden=visible>0||!query;});
  if(page==='reports'||page==='team')wireMemberMissions(state,ctx);
  if(page==='reports') {
    wireReportDrafts(state,ctx);wireReportAttachments(ctx);
    bind('[data-new-report]',()=>ctx.openReport(memory(page,state).projectId || undefined));
    bind('[data-edit-report]',el=>{const report=state.reports.find(item=>item.id===el.dataset.editReport);if(report)editReport(report,state,ctx);});
    document.querySelector('[data-report-filter]')?.addEventListener('change',event=>{memory(page,state).filter=event.target.value;ctx.refresh();});
    bind('[data-review]',el=>ctx.modal({title:labels[el.dataset.status],submitLabel:'ذخیرهٔ بررسی',body:field('یادداشت بررسی',`<textarea name="reviewNote" rows="4" maxlength="2000" ${el.dataset.status==='approved'?'':'required'}></textarea>`),onSubmit:data=>ctx.mutate('report.review',{id:el.dataset.review,status:el.dataset.status,reviewNote:data.get('reviewNote')})}));
  }
  if(page==='finance') {
    bind('[data-invoice-details]',el=>{const invoice=state.invoices.find(item=>item.id===el.dataset.invoiceDetails);if(invoice)openInvoiceDetails(invoice,state,ctx);});
    bind('[data-coordinate-payment]',el=>{const invoice=state.invoices.find(item=>item.id===el.dataset.coordinatePayment);if(invoice)newMessage(state,ctx,invoice.projectId,`برای هماهنگی تسویهٔ صورت‌حساب «${invoice.title}» با ماندهٔ ${ctx.n(invoice.amount-invoice.paid)} تومان پیام می‌دهم. لطفاً روش و مشخصات پرداخت را اعلام کنید.`);});
  }
  if(page==='finance' && ['manager','accountant'].includes(state.user.role)) {
    bind('[data-new-invoice]',()=>ctx.openInvoice(memory(page,state).projectId || undefined));
    bind('[data-receipt]',el=>{
      const invoice=state.invoices.find(i=>i.id===el.dataset.receipt);if(!invoice)return;
      ctx.modal({title:'ثبت رسید دریافت وجه',submitLabel:'ثبت رسید',body:`<p>${ctx.e(invoice.title)}</p><p>مانده: ${ctx.money(invoice.amount-invoice.paid)}</p><div class="notice">فقط وجهی را ثبت کنید که واقعاً دریافت شده است. این فرم درگاه بانکی نیست.</div>${field('مبلغ دریافتی (تومان)',`<input name="amount" type="number" min="1" max="${invoice.amount-invoice.paid}" step="1" required>`)}${field('شماره پیگیری منحصربه‌فرد','<input name="reference" required maxlength="160" autocomplete="off">')}`,onSubmit:data=>ctx.mutate('payment.record',{invoiceId:invoice.id,amount:Number(data.get('amount')),reference:data.get('reference')})});
    });
  }
  if(page==='inventory') {
    bind('[data-new-inventory]',()=>ctx.modal({title:'تعریف کالای جدید',submitLabel:'ثبت کالا و موجودی اولیه',body:`${field('نام کالا','<input name="name" required maxlength="160">')}${field('واحد شمارش',catalogSelect(state,'units',ctx,{name:'unit',required:true}))}${field('موجودی اولیه','<input name="quantity" type="number" min="0" step="0.001" value="0" required>')}${field('حداقل موجودی برای هشدار','<input name="minQuantity" type="number" min="0" step="0.001" value="0" required>')}${field('بهای واحد (تومان)','<input name="unitPrice" type="number" min="0" step="1" value="0" required>')}`,onSubmit:data=>ctx.mutate('inventory.create',{name:data.get('name'),unit:data.get('unit'),quantity:Number(data.get('quantity')),minQuantity:Number(data.get('minQuantity')),unitPrice:Number(data.get('unitPrice'))})}));
    bind('[data-stock]',el=>{
      const item=state.inventory.find(i=>i.id===el.dataset.stock);if(!item)return;
      ctx.modal({title:`ورود به انبار: ${item.name}`,submitLabel:'ثبت ورود کالا',body:`<p>موجودی: ${ctx.e(ctx.n(item.quantity))} ${ctx.e(item.unit)}</p>${field(`مقدار ورودی (${ctx.e(item.unit)})`,'<input name="quantity" type="number" min="0.001" step="0.001" required>')}`,onSubmit:data=>ctx.mutate('inventory.receive',{id:item.id,quantity:Number(data.get('quantity'))})});
    });
  }
  if(page==='support') {
    document.querySelector('[data-ticket-filter]')?.addEventListener('change',event=>{memory(page,state).filter=event.target.value;ctx.refresh();});
    bind('[data-new-ticket]',()=>ticketModal(state,ctx,memory(page,state).projectId));
    bind('[data-new-message]',()=>newMessage(state,ctx,memory(page,state).projectId));
    bind('[data-ticket]',el=>{const ticket=state.tickets.find(t=>t.id===el.dataset.ticket);if(ticket)openTicket(ticket,state,ctx);});
  }
  if(page==='team') {
    bind('[data-team-schedule]',button=>{
      const person=state.users.find(user=>user.id===button.dataset.teamSchedule&&user.role==='worker'&&!user.deletedAt);if(!person)return;
      const choices=[['','انتخاب وضعیت'],['available','آمادهٔ همکاری'],['busy','مشغول'],['leave','مرخصی']];
      ctx.modal({title:`وضعیت و برنامهٔ کاری ${person.name}`,submitLabel:'ذخیرهٔ برنامهٔ کاری',body:`<p class="muted">برنامهٔ کاری به وقت تهران است؛ حضور و کارکرد واقعی فقط از گزارش‌های تأییدشده محاسبه می‌شود.</p>${field('وضعیت فعلی',`<select name="availability" required>${choices.map(([value,title])=>`<option value="${value}" ${(person.availability||'')===value?'selected':''}>${title}</option>`).join('')}</select>`)}<div class="form-grid">${field('شروع برنامهٔ کاری',`<input name="workStart" type="time" value="${ctx.e(person.workStart||'')}">`)}${field('پایان برنامهٔ کاری',`<input name="workEnd" type="time" value="${ctx.e(person.workEnd||'')}">`)}</div><p class="muted">برای حذف ساعات برنامه، هر دو ساعت را خالی بگذارید.</p>`,onSubmit:data=>ctx.mutate('team.schedule',{id:person.id,availability:data.get('availability'),workStart:data.get('workStart')||'',workEnd:data.get('workEnd')||''})});
    });
    bind('[data-activate-account]',el=>openAccountActivation(el.dataset.activateAccount,state,ctx));
    bind('[data-reset-account]',el=>openAccountPasswordReset(el.dataset.resetAccount,state,ctx));
    bind('[data-archive-account]',el=>{
      const person=state.users.find(u=>u.id===el.dataset.archiveAccount);if(!person||person.deletedAt||!assignableRoles.includes(person.role))return;
      ctx.modal({title:`حذف دسترسی: ${person.name}`,submitLabel:'حذف از کاربران فعال',body:`<p>ورود <strong>${ctx.e(person.name)}</strong> قطع می‌شود و از فهرست کاربران فعال خارج خواهد شد.</p><div class="notice">گزارش‌های کار، سوابق مالی و نام فرد در تاریخچه حفظ می‌شوند. می‌توانید بعداً دسترسی همین حساب را بازگردانید.</div><label class="checkbox"><input type="checkbox" required>حذف دسترسی این حساب را تأیید می‌کنم</label>`,onSubmit:()=>ctx.mutate('account.archive',{id:person.id})});
    });
    bind('[data-restore-account]',el=>{
      const person=state.users.find(u=>u.id===el.dataset.restoreAccount);if(!person?.deletedAt)return;
      ctx.modal({title:`بازگرداندن دسترسی: ${person.name}`,submitLabel:'بازگرداندن حساب',body:`<p>${person.loginEnabled===false?'پروندهٔ این فرد با همان شناسه، نقش و سوابق به فهرست فعال بازمی‌گردد. برای ورود به پنل، پس از بازگرداندن از «فعال‌سازی ورود» استفاده کنید.':'این حساب با همان شماره تماس، نقش و سوابق دوباره فعال می‌شود. رمز فعلی حفظ می‌شود؛ در صورت نیاز پس از فعال‌سازی آن را بازنشانی کنید.'}</p>`,onSubmit:()=>ctx.mutate('account.restore',{id:person.id})});
    });
    bind('[data-load-password-requests]',async button=>{
      const mount=document.querySelector('[data-password-requests-user]'),target=mount?.querySelector('[data-password-request-list]');if(!target)return;
      button.disabled=true;target.textContent='در حال دریافت درخواست‌ها…';
      try{const response=await ctx.api.passwordResetRequests();if(!mount.isConnected||mount.dataset.passwordRequestsUser!==state.user.id)return;const m=memory('password-requests',state);m.requests=list(response.requests);target.innerHTML=passwordRequestRows(m.requests,state,ctx);target.querySelectorAll('[data-reset-account]').forEach(el=>el.addEventListener('click',()=>openAccountPasswordReset(el.dataset.resetAccount,state,ctx)));target.querySelectorAll('[data-activate-account]').forEach(el=>el.addEventListener('click',()=>openAccountActivation(el.dataset.activateAccount,state,ctx)));}
      catch(error){if(target.isConnected){target.textContent=error.message||'دریافت درخواست‌ها انجام نشد؛ دوباره تازه‌سازی کنید';target.setAttribute('role','alert');}}
      finally{if(button.isConnected)button.disabled=false;}
    });
    bind('[data-new-profile]',()=>ctx.modal({title:'پروفایل نیروی اجرایی',submitLabel:'افزودن پروفایل',body:`<div class="notice">${ctx.capabilities?.hosted && !supabaseAuth(ctx) ? 'ایمیل حساب ChatGPT نیرو را وارد کنید. پس از مجازشدن دسترسی او به سایت، با همان ایمیل وارد فضای کار می‌شود.' : 'این فرم فقط پروفایل بدون ورود می‌سازد. برای نیرویی که باید وارد پنل شود، از ابتدا «حساب ورود» بسازید.'}</div>${field('نام','<input name="name" required maxlength="100">')}${field('ایمیل کاری','<input name="email" type="email" required>')}${field('واحد',catalogSelect(state,'departments',ctx,{name:'department',optional:true}))}${field('تخصص',catalogSelect(state,'skills',ctx,{name:'skill',optional:true}))}`,onSubmit:data=>ctx.mutate('worker.create',Object.fromEntries(data))}));
    bind('[data-new-account]',()=>{
      if(ctx.api.isStatic) return ctx.toast('ساخت حساب ورود در پیش‌نمایش فعال نیست؛ نسخهٔ سرور مستقل لازم است.');
      const hosted=Boolean(ctx.capabilities?.hosted) && !supabaseAuth(ctx);
      if(supabaseAuth(ctx)) {
        ctx.modal({title:'ثبت همکار یا مشتری',submitLabel:'ساخت حساب',body:`<div class="notice">حساب با شماره تماس و رمز ساخته می‌شود؛ ایمیل لازم نیست. بعداً می‌توانید نقش مشتری و همکار را از همین بخش تغییر دهید.</div>${accountFields(null,ctx,{create:true})}<fieldset><legend>پروژه‌های مجاز (اختیاری)</legend>${state.projects.map(p=>`<label class="checkbox"><input name="projectIds" type="checkbox" value="${ctx.e(p.id)}">${ctx.e(p.name)}</label>`).join('')||'<p class="muted">پس از ساخت پروژه، دسترسی را از بخش پروژه‌ها مشخص کنید.</p>'}</fieldset><p class="muted">اگر این شخص قبلاً حساب دارد، اطلاعات و نقش همان حساب را ویرایش کنید.</p>`,onSubmit:data=>ctx.mutate('account.create',{name:data.get('name'),phone:data.get('phone'),role:data.get('role'),username:data.get('username')||'',password:data.get('password'),projectIds:data.getAll('projectIds')})});
        wireAccountFields();return;
      }
      ctx.modal({title:hosted?'افزودن عضو یا مشتری':'حساب ورود مستقل',submitLabel:hosted?'ثبت عضو و دسترسی پروژه':'ساخت حساب',body:`${hosted?'<div class="notice">ایمیل باید با حساب ChatGPT فرد یکسان باشد. برای ورود، دسترسی سایت هم باید از تنظیمات اشتراک‌گذاری به او داده شود.</div>':''}${field('نام','<input name="name" required maxlength="100">')}${field(hosted?'ایمیل حساب ChatGPT':'ایمیل','<input name="email" type="email" required autocomplete="off">')}${field('نقش','<select name="role"><option value="customer">مشتری</option><option value="worker">همکار اجرایی</option></select>')}${hosted?'':field('رمز عبور اولیه','<input name="password" type="password" required minlength="6" maxlength="128" autocomplete="new-password">')}<fieldset><legend>پروژه‌های مجاز</legend>${state.projects.map(p=>`<label class="checkbox"><input name="projectIds" type="checkbox" value="${ctx.e(p.id)}">${ctx.e(p.name)}${p.customerId?' · دارای مشتری':''}</label>`).join('')||'<p class="muted">هنوز پروژه‌ای ساخته نشده است؛ اعضا را بعداً از بخش پروژه‌ها تخصیص دهید.</p>'}</fieldset>`,onSubmit:data=>ctx.mutate('account.create',{name:data.get('name'),email:data.get('email'),role:data.get('role'),...(hosted?{}:{password:data.get('password')}),projectIds:data.getAll('projectIds')})});
    });
    bind('[data-edit-account]',el=>{
      const person=state.users.find(item=>item.id===el.dataset.editAccount);
      if(!supabaseAuth(ctx)||!person||person.deletedAt||!(assignableRoles.includes(person.role)||person.role==='manager'))return;
      ctx.modal({title:`اطلاعات و نقش: ${person.name}`,submitLabel:'ذخیرهٔ اطلاعات و نقش',body:`${accountFields(person,ctx)}${field('واحد',catalogSelect(state,'departments',ctx,{name:'department',value:person.department||'',optional:true}))}${field('تخصص',catalogSelect(state,'skills',ctx,{name:'skill',value:person.skill||'',optional:true}))}<div class="notice">تغییر نقش، دسترسی‌های بعدی این حساب را تغییر می‌دهد. گزارش‌ها، صورت‌حساب‌ها و سوابق قبلی حذف نمی‌شوند. ${person.loginEnabled===false?'این پرونده هنوز حساب ورود ندارد؛ ذخیرهٔ اطلاعات به‌تنهایی ورود را فعال نمی‌کند. برای تعیین رمز و ورود، از «فعال‌سازی ورود» استفاده کنید.':'رمز عبور فعلی حفظ می‌شود.'}</div>`,onSubmit:data=>ctx.mutate('account.update',{id:person.id,name:data.get('name'),phone:data.get('phone'),role:data.get('role'),username:data.get('username')||'',department:data.get('department'),skill:data.get('skill')})});wireAccountFields();
    });
    bind('[data-rate]',el=>{
      const worker=state.users.find(u=>u.id===el.dataset.rate);if(!worker)return;
      ctx.modal({title:`ثبت نرخ: ${worker.name}`,submitLabel:'ثبت نرخ جدید',body:`<p class="muted">نرخِ گزارش بر اساس تاریخ کار محاسبه می‌شود. نرخ ثبت‌شده و دستمزد گزارش‌های قبلی تغییر نمی‌کند.</p>${field('نرخ ساعتی (تومان)','<input name="hourlyRate" type="number" min="0" step="1" required>')}${field('تاریخ اجرا','<input name="effectiveDate" type="date" required>')}`,onSubmit:data=>ctx.mutate('worker.rate',{id:worker.id,hourlyRate:Number(data.get('hourlyRate')),effectiveDate:data.get('effectiveDate')})});
    });
  }
  if(page==='settings' && state.user.role==='manager') bind('[data-export]',()=>{
    const blob=new Blob([JSON.stringify({exportedAt:new Date().toISOString(),schemaVersion:1,...state},null,2)],{type:'application/json;charset=utf-8'});
    const url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download='ARIOS_workspace_export.json';document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);ctx.toast('خروجی داده‌های مجاز دریافت شد.');
  });
}
