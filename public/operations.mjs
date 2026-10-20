// Operational screens. All requests go through the shared, scoped API adapter.
const memories = new Map();
const managerPages = new Set(['finance-admin', 'inventory', 'team', 'analytics']);
const labels = { open: 'باز', in_progress: 'در حال رسیدگی', resolved: 'حل‌شده', submitted: 'در انتظار بررسی', approved: 'تأییدشده', changes_requested: 'نیازمند اصلاح', rejected: 'ردشده', manager: 'مدیر', worker: 'نیروی اجرایی', customer: 'مشتری' };
const sum = (rows, field) => rows.reduce((total, row) => total + (Number(row[field]) || 0), 0);
const byDate = rows => [...rows].sort((a, b) => String(b.createdAt || b.date || '').localeCompare(String(a.createdAt || a.date || '')));
const list = value => Array.isArray(value) ? value : [];
function memory(page, state) {
  const key = `${state.user.id}:${page}`;
  if (!memories.has(key)) memories.set(key, { projectId: '', conversations: new Map(), filter: 'all' });
  return memories.get(key);
}
function allowed(page, state) {
  if (managerPages.has(page)) return state.user.role === 'manager';
  if (page === 'reports') return state.user.role !== 'customer';
  return true;
}
function empty(message, ctx) { return `<div class="empty-state"><p>${ctx.e(message)}</p></div>`; }
function header(title, subtitle, actions, ctx) { return `<div class="page-heading"><div><p class="eyebrow">ARIOS WORKSPACE</p><h1>${ctx.e(title)}</h1><p class="muted">${ctx.e(subtitle)}</p></div><div class="page-actions">${actions || ''}</div></div>`; }
function metric(label, value, detail, ctx) { return `<article class="card metric"><span class="muted">${ctx.e(label)}</span><strong>${value}</strong><small class="muted">${ctx.e(detail)}</small></article>`; }
function selectProjects(state, ctx, value = '', all = true) {
  return `${all ? '<option value="">همهٔ پروژه‌ها</option>' : ''}${list(state.projects).map(p => `<option value="${ctx.e(p.id)}" ${p.id === value ? 'selected' : ''}>${ctx.e(p.name)}</option>`).join('')}`;
}
function projectFilter(state, ctx, value) { return `<label class="filter-label">پروژه<select data-project-filter>${selectProjects(state, ctx, value)}</select></label>`; }
function selection(state, page) {
  const m = memory(page, state);
  if (m.projectId && !state.projects.some(p => p.id === m.projectId)) m.projectId = '';
  return m;
}
const projectRows = (rows, projectId) => list(rows).filter(row => !projectId || row.projectId === projectId);
const userOptions = (users, ctx, role) => users.filter(u => !role || u.role === role).map(u => `<option value="${ctx.e(u.id)}">${ctx.e(u.name)}</option>`).join('');
function field(label, content) { return `<label>${label}${content}</label>`; }
function formProject(state, ctx, selected) { return field('پروژه', `<select name="projectId" required>${selectProjects(state, ctx, selected, false)}</select>`); }
function messageRows(rows, state, ctx) {
  return byDate(rows).map(m => `<article class="message-item"><div class="row between"><strong>${ctx.e(ctx.personName(m.authorId))}</strong><small class="muted">${ctx.e(ctx.date(m.createdAt))}</small></div><p class="pre-wrap">${ctx.e(m.text)}</p><div class="row between"><small class="muted">${ctx.e(ctx.projectName(m.projectId))}</small>${m.internal ? '<span class="badge">داخلی · تیم پروژه</span>' : '<span class="badge">قابل مشاهده برای مشتری</span>'}</div></article>`).join('') || empty('هنوز پیامی ثبت نشده است.', ctx);
}
function renderReports(state, ctx) {
  const m = selection(state, 'reports');
  const rows = projectRows(state.reports, m.projectId).filter(r => m.filter === 'all' || r.status === m.filter);
  return `${header('گزارش‌های کار', 'ساعت کار، خروجی اجرا و بررسی گزارش‌ها', '<button class="button primary" data-new-report>+ گزارش جدید</button>', ctx)}
    ${state.user.role === 'manager' && !state.projects.length ? '<div class="notice">برای شروع، <a class="text-link" href="#team">نیروهای اجرایی را تعریف کنید</a> و سپس از <a class="text-link" href="#projects">بخش پروژه‌ها</a> پروژه بسازید و اعضای آن را مشخص کنید.</div>' : ''}
    <div class="grid metrics">${metric('گزارش‌های قابل مشاهده', ctx.e(ctx.n(state.reports.length)), 'بر اساس سطح دسترسی شما', ctx)}${metric('در انتظار بررسی', ctx.e(ctx.n(state.reports.filter(r => r.status === 'submitted').length)), 'نیازمند بررسی مدیر', ctx)}${metric('زمان تأییدشده', `${ctx.e(ctx.n(Math.round(sum(state.reports.filter(r => r.status === 'approved'), 'minutes') / 6) / 10))} ساعت`, 'فقط گزارش‌های تأییدشده', ctx)}</div>
    <section class="card"><div class="toolbar">${projectFilter(state, ctx, m.projectId)}<label>وضعیت<select data-report-filter><option value="all">همهٔ وضعیت‌ها</option>${['submitted','approved','changes_requested','rejected'].map(v => `<option value="${v}" ${m.filter === v ? 'selected' : ''}>${labels[v]}</option>`).join('')}</select></label></div>
    <div class="report-list">${byDate(rows).map(r => `<article class="list-item report-item"><div class="row between"><div><strong>${ctx.e(ctx.personName(r.workerId))}</strong><small class="muted"> · ${ctx.e(ctx.projectName(r.projectId))}</small></div>${ctx.badge(r.status)}</div><p class="pre-wrap">${ctx.e(r.description)}</p><p class="muted pre-wrap">خروجی: ${ctx.e(r.output || 'ثبت نشده')}</p><div class="row between"><span class="muted">${ctx.e(ctx.date(r.date))} · ${ctx.e(r.start)} تا ${ctx.e(r.end)} · ${ctx.e(ctx.n(r.minutes))} دقیقه · استراحت ${ctx.e(ctx.n(r.breakMinutes || 0))} دقیقه</span>${state.user.role === 'manager' ? `<strong>${ctx.money(r.laborCost || 0)}</strong>` : ''}</div>${r.reviewNote ? `<p class="review-note">یادداشت مدیر: ${ctx.e(r.reviewNote)}</p>` : ''}${['telegram','upload','text'].includes(r.source) ? `<p class="muted">منبع گزارش: ${ctx.e({telegram:'ویس تلگرام',upload:'فایل صوتی',text:'متن'}[r.source])}</p>` : ''}${r.status !== 'approved' && (state.user.role === 'manager' || r.workerId === state.user.id) ? `<button class="button secondary small" data-edit-report="${ctx.e(r.id)}">ویرایش و ارسال دوباره</button>` : ''}${state.user.role === 'manager' && r.status !== 'approved' ? `<div class="row"><button class="button primary small" data-review="${ctx.e(r.id)}" data-status="approved">تأیید گزارش</button><button class="button secondary small" data-review="${ctx.e(r.id)}" data-status="changes_requested">درخواست اصلاح</button><button class="button danger small" data-review="${ctx.e(r.id)}" data-status="rejected">رد گزارش</button></div>` : ''}</article>`).join('') || empty('گزارشی با این فیلتر وجود ندارد.', ctx)}</div></section>`;
}
function renderFinance(state, ctx) {
  const m = selection(state, 'finance');
  const invoices = projectRows(state.invoices, m.projectId);
  const receipts = projectRows(state.receipts, m.projectId);
  const materials = projectRows(state.materials, m.projectId);
  const manager = state.user.role === 'manager';
  if (state.user.role === 'worker') return empty('اطلاعات مالی برای این حساب در دسترس نیست.', ctx);
  return `${header('مالی و صورت‌حساب‌ها', 'مبالغ به تومان هستند؛ رسیدها پس از دریافت وجه توسط مدیر ثبت می‌شوند.', manager ? '<button class="button primary" data-new-invoice>+ صورت‌حساب جدید</button>' : '', ctx)}
    <div class="grid metrics">${metric('مجموع صورت‌حساب‌ها', ctx.money(sum(invoices, 'amount')), 'صورت‌حساب‌های صادرشده', ctx)}${metric('پرداخت ثبت‌شده', ctx.money(sum(invoices, 'paid')), 'ثبت‌شده توسط مدیر', ctx)}${metric('ماندهٔ پرداخت', ctx.money(sum(invoices, 'amount') - sum(invoices, 'paid')), 'مبالغ تسویه‌نشده', ctx)}</div>
    <section class="card"><div class="toolbar">${projectFilter(state, ctx, m.projectId)}</div><div class="notice">درگاه پرداخت آنلاین هنوز متصل نشده است. برای تسویه، از پیام پروژه با تیم هماهنگ کنید؛ مشتری نمی‌تواند پرداخت موفق ثبت کند.</div><div class="invoice-list">${invoices.map(i => `<article class="list-item"><div class="row between"><div><h3>${ctx.e(i.title)}</h3><small class="muted">${ctx.e(ctx.projectName(i.projectId))} · سررسید ${ctx.e(ctx.date(i.dueDate))}</small></div>${ctx.badge(i.status)}</div><div class="grid metrics"><div><small>مبلغ</small><strong>${ctx.money(i.amount)}</strong></div><div><small>پرداخت‌شده</small><strong>${ctx.money(i.paid)}</strong></div><div><small>مانده</small><strong>${ctx.money(i.amount - i.paid)}</strong></div></div>${manager && i.amount > i.paid ? `<button class="button primary small" data-receipt="${ctx.e(i.id)}">ثبت رسید دریافتی</button>` : ''}</article>`).join('') || empty('هنوز صورت‌حسابی صادر نشده است.', ctx)}</div></section>
    <div class="grid two"><section class="card"><h2>تجهیزات مصرف‌شده</h2>${materials.map(item => `<div class="list-item"><div class="row between"><strong>${ctx.e(item.name)}</strong><span>${ctx.e(ctx.n(item.quantity))} ${ctx.e(item.unit)}</span></div><div class="row between"><small>${ctx.e(ctx.projectName(item.projectId))}${manager && !item.clientVisible ? ' · داخلی' : ''}</small><strong>${ctx.money(item.quantity * item.unitPrice)}</strong></div></div>`).join('') || empty('تجهیزات مصرفی ثبت نشده است.', ctx)}</section><section class="card"><h2>رسیدهای دریافت وجه</h2>${byDate(receipts).map(r => `<div class="list-item"><div class="row between"><strong>${ctx.money(r.amount)}</strong><small>${ctx.e(ctx.date(r.createdAt))}</small></div><p class="muted">شماره پیگیری: ${ctx.e(r.reference)}</p><small>${ctx.e(ctx.projectName(r.projectId))} · ثبت دستی توسط مدیر</small></div>`).join('') || empty('رسیدی برای این پروژه‌ها ثبت نشده است.', ctx)}</section></div>`;
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
  if (!state.projects.some(p => p.id === m.projectId)) m.projectId = state.projects[0]?.id || '';
  if (!m.conversations.has(m.projectId)) m.conversations.set(m.projectId, { messages: [], pending: false, ticketId: '', draft: '' });
  return { m, chat: m.conversations.get(m.projectId) };
}
function renderAssistant(state, ctx) {
  const { m, chat } = conversation(state);
  const live = Boolean(ctx.capabilities?.ai) && !ctx.api.isStatic;
  const project = state.projects.find(p => p.id === m.projectId);
  return `${header('دستیار هوشمند آریوس', live ? 'راهنمایی بر اساس اطلاعات مجاز پروژهٔ انتخاب‌شده' : 'اتصال هوش مصنوعی آماده نیست؛ مسئله را برای پشتیبانی ثبت کنید.', '', ctx)}<section class="card assistant-shell" data-assistant-user="${ctx.e(state.user.id)}" data-assistant-project="${ctx.e(m.projectId)}"><div class="toolbar"><label>پروژهٔ گفتگو<select data-ai-project>${selectProjects(state, ctx, m.projectId, false)}</select></label><span class="badge ${live ? 'success' : 'warning'}">${live ? 'هوش مصنوعی متصل است' : 'هوش مصنوعی متصل نیست'}</span></div>${project ? `<div class="notice">${ctx.e(project.name)} · پیشرفت ${ctx.e(ctx.n(project.progress))}٪ · اطلاعات هر پروژه در گفت‌وگوی مستقل نگهداری می‌شود.</div>` : empty('برای استفاده از پشتیبانی ابتدا باید به یک پروژه دسترسی داشته باشید.', ctx)}<div class="assistant-messages" aria-live="polite">${chat.messages.length ? chat.messages.map(msg => `<article class="chat-bubble ${msg.role === 'user' ? 'user' : 'assistant'}"><strong>${msg.role === 'user' ? 'شما' : 'دستیار آریوس'}</strong><p class="pre-wrap">${ctx.e(msg.content)}</p>${msg.sources?.length ? `<small class="muted">منابع: ${msg.sources.map(source => ctx.e(source.label)).join('، ')}</small>` : ''}</article>`).join('') : `<div class="assistant-welcome"><h2>${live ? 'چطور می‌توانم کمک کنم؟' : 'مسئلهٔ پروژه را برای ما بنویسید'}</h2><p class="muted">${live ? 'مشکل، نام تجهیز و اقداماتی را که انجام داده‌اید شرح دهید. اگر مسئله حل نشد، مکالمه به پشتیبانی ارجاع می‌شود.' : 'پس از ثبت تیکت، تیم پشتیبانی مسئله را بررسی می‌کند. در این حالت پاسخ هوش مصنوعی تولید نمی‌شود.'}</p></div>`}${chat.pending ? '<p class="muted" role="status">دستیار در حال بررسی مسئله است…</p>' : ''}</div>${chat.ticketId ? `<div class="notice success">تیکت پشتیبانی ${ctx.e(chat.ticketId)} ثبت شد. <button class="button secondary small" data-open-support>پیگیری تیکت</button></div>` : ''}<form data-ai-form><label>شرح مسئله<textarea name="message" rows="4" maxlength="8000" placeholder="مثلاً تصویر دوربین ورودی قطع شده؛ اتصال برق را بررسی کرده‌ام…" ${!project || chat.pending ? 'disabled' : ''}>${ctx.e(chat.draft)}</textarea></label><div class="row between"><small class="muted">${live ? 'برای پشتیبانی انسانی می‌توانید مکالمه را به تیکت تبدیل کنید.' : 'تیکت با همان شرح مسئله برای تیم پروژه ارسال می‌شود.'}</small><div class="row">${live ? `<button class="button primary" type="submit" ${!project || chat.pending ? 'disabled' : ''}>${chat.pending ? 'در حال بررسی…' : 'ارسال به دستیار'}</button>` : ''}<button class="button ${live ? 'secondary' : 'primary'}" type="button" data-ai-escalate ${!project || chat.pending || chat.ticketId ? 'disabled' : ''}>${chat.ticketId ? 'تیکت ثبت شده' : 'ثبت تیکت پشتیبانی'}</button></div></div></form></section>`;
}
function renderTeam(state, ctx) {
  const workers = state.users.filter(u => u.role === 'worker');
  const hosted = Boolean(ctx.capabilities?.hosted);
  return `${header('تیم و دسترسی‌ها', hosted ? 'نیروها، مشتریان، دسترسی با حساب ChatGPT و نرخ‌های تاریخ‌دار' : 'پروفایل نیروی اجرایی، حساب ورود مستقل و نرخ‌های تاریخ‌دار', `<button class="button secondary" data-new-profile>+ نیروی اجرایی</button><button class="button primary" data-new-account>${hosted ? '+ عضو یا مشتری' : '+ حساب ورود'}</button>`, ctx)}${!workers.length && !state.projects.length ? '<div class="notice">ابتدا نیروهای اجرایی و در صورت نیاز مشتری را ثبت کنید، سپس از <a class="text-link" href="#projects">بخش پروژه‌ها</a> پروژه بسازید و نیروها را به آن اختصاص دهید. گزارش کار و اتصال تلگرام پس از این مرحله آماده است.</div>' : ''}<div class="grid metrics">${metric('نیروهای اجرایی', ctx.e(ctx.n(workers.length)), 'پروفایل‌های ثبت‌شده', ctx)}${metric('مشتریان', ctx.e(ctx.n(state.users.filter(u => u.role === 'customer').length)), 'حساب‌های مشتری', ctx)}${metric('پروژه‌های جاری', ctx.e(ctx.n(state.projects.filter(p => p.status !== 'completed').length)), 'در حال اجرا یا نیازمند توجه', ctx)}</div><section class="card"><h2>نیروهای اجرایی</h2>${workers.map(w => `<article class="list-item"><div class="row between"><div><h3>${ctx.e(w.name)}</h3><small class="muted">${ctx.e(w.skill || 'تخصص ثبت نشده')} · ${ctx.e(w.department || 'تیم آریوس')} · ${ctx.e(w.email)}</small></div><span class="badge">${ctx.e(ctx.n(state.projects.filter(p => list(p.memberIds).includes(w.id)).length))} پروژه</span></div><div class="row between"><span>نرخ پایه: ${ctx.money(w.hourlyRate || 0)} / ساعت</span><button class="button secondary small" data-rate="${ctx.e(w.id)}">ثبت نرخ تاریخ‌دار</button></div>${list(w.rateHistory).length ? `<details><summary>تاریخچهٔ نرخ‌ها</summary>${[...w.rateHistory].sort((a,b) => a.effectiveDate.localeCompare(b.effectiveDate)).map(rate => `<p>${ctx.e(ctx.date(rate.effectiveDate))} — ${ctx.money(rate.hourlyRate)} / ساعت</p>`).join('')}</details>` : '<small class="muted">هنوز نرخ تاریخ‌دار ثبت نشده است.</small>'}</article>`).join('') || empty('نیرویی ثبت نشده است.', ctx)}</section><section class="card"><h2>مشتریان</h2>${state.users.filter(u => u.role === 'customer').map(c => `<div class="list-item row between"><div><strong>${ctx.e(c.name)}</strong><p class="muted">${ctx.e(c.email)}</p></div><span class="badge">${ctx.e(ctx.n(state.projects.filter(p => p.customerId === c.id).length))} پروژه</span></div>`).join('') || empty('مشتری ثبت نشده است.', ctx)}</section>`;
}
function renderAnalytics(state, ctx) {
  const approved = state.reports.filter(r => r.status === 'approved');
  const progress = state.projects.length ? Math.round(sum(state.projects, 'progress') / state.projects.length) : 0;
  return `${header('گزارش‌ها و تحلیل‌ها', 'خلاصهٔ محاسبه‌شده از اطلاعات واقعی همین فضای کاری', '', ctx)}<div class="grid metrics">${metric('پیشرفت میانگین', `${ctx.e(ctx.n(progress))}٪`, 'میانگین سادهٔ پروژه‌ها', ctx)}${metric('زمان کار تأییدشده', `${ctx.e(ctx.n(Math.round(sum(approved, 'minutes') / 6) / 10))} ساعت`, 'گزارش‌های تأییدشده', ctx)}${metric('درخواست‌های باز', ctx.e(ctx.n(state.tickets.filter(t => t.status !== 'resolved').length)), 'باز و در حال رسیدگی', ctx)}${metric('وصول صورت‌حساب‌ها', `${ctx.e(ctx.n(sum(state.invoices,'amount') ? Math.round(sum(state.invoices,'paid') / sum(state.invoices,'amount') * 100) : 0))}٪`, 'نسبت پرداخت به مبلغ صادرشده', ctx)}</div><section class="card"><h2>عملکرد پروژه‌ها</h2>${state.projects.map(p => { const reports = approved.filter(r => r.projectId === p.id); const materialCost = state.materials.filter(r => r.projectId === p.id).reduce((v,r) => v + r.quantity * r.unitPrice,0); const labor = sum(reports,'laborCost'); const invoices = state.invoices.filter(i => i.projectId === p.id); return `<article class="list-item"><div class="row between"><a href="#project/${ctx.e(p.id)}"><h3>${ctx.e(p.name)}</h3></a><strong>${ctx.e(ctx.n(p.progress))}٪</strong></div><progress max="100" value="${Math.max(0, Math.min(100, Number(p.progress) || 0))}"></progress><div class="grid metrics"><div><small>هزینهٔ تجهیزات</small><strong>${ctx.money(materialCost)}</strong></div><div><small>دستمزد تأییدشده</small><strong>${ctx.money(labor)}</strong></div><div><small>جمع هزینهٔ ثبت‌شده</small><strong>${ctx.money(materialCost + labor)}</strong></div><div><small>ماندهٔ صورت‌حساب‌ها</small><strong>${ctx.money(sum(invoices,'amount') - sum(invoices,'paid'))}</strong></div></div></article>`; }).join('') || empty('پروژه‌ای برای تحلیل وجود ندارد.', ctx)}</section><div class="grid two"><section class="card"><h2>وضعیت پروژه‌ها</h2>${['active','attention','completed'].map(status => `<div class="list-item row between">${ctx.badge(status)}<strong>${ctx.e(ctx.n(state.projects.filter(p => p.status === status).length))}</strong></div>`).join('')}</section><section class="card"><h2>وضعیت پشتیبانی</h2>${['open','in_progress','resolved'].map(status => `<div class="list-item row between">${ctx.badge(status)}<strong>${ctx.e(ctx.n(state.tickets.filter(t => t.status === status).length))}</strong></div>`).join('')}</section></div>`;
}
function renderSettings(state, ctx) {
  const live = Boolean(ctx.capabilities?.ai) && !ctx.api.isStatic;
  return `${header('تنظیمات و اطلاعات حساب', 'اطلاعات اتصال و خروجیِ مجاز همین پروژهٔ مستقل آریوس', '', ctx)}<div class="grid two"><section class="card"><h2>حساب شما</h2><div class="list-item"><strong>${ctx.e(state.user.name)}</strong><p>${ctx.e(state.user.email || '')}</p><span class="badge">${ctx.e(labels[state.user.role] || state.user.role)}</span></div><p class="muted">${ctx.api.isStatic ? 'این پیش‌نمایش از دادهٔ نمایشی در مرورگر استفاده می‌کند؛ حساب واقعی ساخته نمی‌شود.' : ctx.demo ? 'نسخهٔ نمایشی سرور با اطلاعات ساختگی آریوس فعال است.' : 'ورود مستقل و دسترسی‌های پروژه در سرور کنترل می‌شوند.'}</p></section><section class="card"><h2>وضعیت اتصال‌ها</h2><div class="list-item row between"><span>دستیار هوش مصنوعی</span><span class="badge ${live ? 'success' : 'warning'}">${live ? 'متصل' : 'نیازمند تنظیم اتصال اختصاصی'}</span></div><div class="list-item row between"><span>پرداخت آنلاین</span><span class="badge warning">متصل نشده</span></div><p class="muted">دریافت وجه توسط مدیر با رسید و شماره پیگیری ثبت می‌شود. اطلاعات اتصال محرمانه در مرورگر نمایش داده نمی‌شود.</p></section></div>${state.user.role === 'manager' ? `<section class="card"><h2>خروجی و سوابق</h2><p class="muted">فایل JSON شامل داده‌های مجاز این مدیر است. این خروجی جایگزین نسخهٔ پشتیبان پایگاه داده نیست.</p><div class="row"><button class="button primary" data-export>دریافت خروجی داده‌ها</button>${ctx.api.isStatic || ctx.capabilities?.hosted ? '<a class="button secondary" href="./downloads/ARIOS_OS_source.zip" download>دریافت سورس آریوس</a>' : ''}</div><h3>آخرین فعالیت‌ها</h3>${byDate(list(state.audit)).slice(0,12).map(a => `<div class="list-item"><strong>${ctx.e(a.description || a.action)}</strong><p class="muted">${ctx.e(ctx.personName(a.actorId))} · ${ctx.e(ctx.date(a.createdAt))}</p></div>`).join('') || empty('فعالیتی ثبت نشده است.', ctx)}</section>` : ''}`;
}
export function renderOperations(page, state, ctx) {
  if (!['reports','finance','inventory','support','assistant','team','analytics','settings'].includes(page)) return null;
  if (!allowed(page,state)) return empty('این بخش برای نقش شما در دسترس نیست.', ctx);
  return ({reports:renderReports,finance:renderFinance,inventory:renderInventory,support:renderSupport,assistant:renderAssistant,team:renderTeam,analytics:renderAnalytics,settings:renderSettings})[page](state,ctx);
}
function bind(selector, fn) { document.querySelectorAll(selector).forEach(el => el.addEventListener('click', () => fn(el))); }
function ticketModal(state, ctx, projectId = '', description = '', after) {
  if (!state.projects.length) return ctx.toast('ابتدا باید به یک پروژه دسترسی داشته باشید.');
  ctx.modal({title:'درخواست پشتیبانی جدید', submitLabel:'ثبت تیکت', body:`${formProject(state,ctx,projectId)}${field('موضوع','<input name="subject" required maxlength="180" placeholder="خلاصهٔ مسئله">')}${field('اولویت','<select name="priority"><option value="normal">عادی</option><option value="high">بالا</option></select>')}${field('شرح مسئله',`<textarea name="description" required rows="7" maxlength="16000">${ctx.e(description)}</textarea>`)}`, onSubmit:async data => { const result=await ctx.mutate('ticket.create',Object.fromEntries(data)); if (after) after(result); }});
}
function newMessage(state, ctx, projectId) {
  if (!state.projects.length) return ctx.toast('پروژه‌ای برای ارسال پیام ندارید.');
  ctx.modal({title:'پیام پروژه',submitLabel:'ارسال پیام',body:`${formProject(state,ctx,projectId)}${field('متن پیام','<textarea name="text" required rows="5" maxlength="8000"></textarea>')}${state.user.role !== 'customer' ? '<label class="checkbox"><input type="checkbox" name="internal">پیام داخلی تیم؛ برای مشتری نمایش داده نشود</label>' : '<p class="muted">این پیام برای تیم پروژه ارسال می‌شود.</p>'}`,onSubmit: data => ctx.mutate('message.send',{projectId:data.get('projectId'),text:data.get('text'),internal:data.has('internal')})});
}
function openTicket(ticket,state,ctx) {
  ctx.modal({title:ticket.subject,submitLabel:'ارسال پاسخ',body:`<p class="pre-wrap">${ctx.e(ticket.description)}</p>${ctx.badge(ticket.status)}<div class="ticket-replies">${list(ticket.replies).map(reply => `<article class="message-item"><strong>${ctx.e(ctx.personName(reply.authorId))}</strong><small class="muted"> · ${ctx.e(ctx.date(reply.createdAt))}</small><p class="pre-wrap">${ctx.e(reply.text)}</p></article>`).join('') || empty('هنوز پاسخی ثبت نشده است.',ctx)}</div>${field('پاسخ شما','<textarea name="text" required rows="4" maxlength="8000"></textarea>')}${state.user.role === 'manager' ? `<label>وضعیت تیکت<select data-ticket-status="${ctx.e(ticket.id)}">${['open','in_progress','resolved'].map(v => `<option value="${v}" ${ticket.status === v ? 'selected' : ''}>${labels[v]}</option>`).join('')}</select></label><p class="muted">تغییر وضعیت مستقل از ارسال پاسخ ذخیره می‌شود.</p>` : ''}`,onSubmit:data=>ctx.mutate('ticket.reply',{id:ticket.id,text:data.get('text')})});
  const input=document.querySelector('[data-ticket-status]');
  input?.addEventListener('change',async()=>{ input.disabled=true; try { await ctx.mutate('ticket.update',{id:ticket.id,status:input.value}); } catch(error) { input.disabled=false; input.value=ticket.status; ctx.toast(error.message); }});
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
  bind('[data-open-support]',()=>ctx.go('support'));
  form?.addEventListener('submit',async event=>{
    event.preventDefault();
    if (!ctx.capabilities?.ai || ctx.api.isStatic || chat.pending || !m.projectId) return;
    const message=textarea.value.trim();
    if (!message) return ctx.toast('شرح مسئله را بنویسید.');
    const userId=state.user.id, projectId=m.projectId;
    const history=chat.messages.slice(-10).map(({role,content})=>({role,content}));
    chat.messages.push({role:'user',content:message});chat.draft='';chat.pending=true;
    ctx.refresh();
    try {
      const result=await ctx.api.assistant({projectId,message,history});
      if (typeof result.answer !== 'string' || result.live !== true) throw new Error('پاسخ معتبر از اتصال هوش مصنوعی دریافت نشد.');
      chat.messages.push({role:'assistant',content:result.answer,sources:list(result.sources)});
      if (result.ticket?.id) chat.ticketId=result.ticket.id;
    } catch(error) {
      chat.draft=message;
      if(isCurrentAssistant(userId,projectId)) ctx.toast(error.message || 'اتصال به دستیار برقرار نشد؛ می‌توانید تیکت ثبت کنید.');
    } finally {
      chat.pending=false;
      // A delayed response may never render into a different account or project.
      if(isCurrentAssistant(userId,projectId)) await ctx.refresh();
    }
  });
  bind('[data-ai-escalate]',()=>{
    if(chat.pending || chat.ticketId || !m.projectId) return;
    const draft=(textarea?.value || chat.draft || '').trim();
    const transcript=chat.messages.map(message=>`${message.role === 'user' ? 'مشتری / کاربر' : 'دستیار'}: ${message.content}`).join('\n\n');
    const description=[transcript,draft ? `شرح تکمیلی مسئله: ${draft}` : ''].filter(Boolean).join('\n\n');
    if(!description) return ctx.toast('ابتدا شرح مسئله را بنویسید.');
    ticketModal(state,ctx,m.projectId,description,result=>{chat.ticketId=result?.id || result?.ticket?.id || 'ثبت‌شده';ctx.refresh();});
  });
}
function editReport(report, state, ctx) {
  if (report.status === 'approved' || (state.user.role !== 'manager' && report.workerId !== state.user.id)) return;
  const projects = state.projects.filter(project => list(project.memberIds).includes(report.workerId));
  if (!projects.length) return ctx.toast('نیروی این گزارش باید عضو یکی از پروژه‌های در دسترس باشد. از مدیر بخواهید اعضای پروژه را بررسی کند.');
  ctx.modal({
    title: 'ویرایش گزارش کار',
    submitLabel: 'ذخیره و ارسال دوباره برای بررسی',
    body: `<div class="notice">نسخهٔ جدید برای بررسی مدیر ارسال می‌شود. گزارش تأییدشده قابل ویرایش نیست.</div><p>نیروی اجرایی: <strong>${ctx.e(ctx.personName(report.workerId))}</strong></p><div class="form-grid">${field('پروژه', `<select name="projectId" required>${projects.map(project => `<option value="${ctx.e(project.id)}" ${project.id === report.projectId ? 'selected' : ''}>${ctx.e(project.name)}</option>`).join('')}</select>`)}${field('تاریخ فعالیت', `<input name="date" type="date" required value="${ctx.e(report.date)}">`)}${field('ساعت شروع', `<input name="start" type="time" required value="${ctx.e(report.start)}">`)}${field('ساعت پایان', `<input name="end" type="time" required value="${ctx.e(report.end)}">`)}${field('استراحت غیرقابل‌پرداخت (دقیقه)', `<input name="breakMinutes" type="number" min="0" max="1439" step="1" required value="${ctx.e(report.breakMinutes ?? 0)}">`)}${field('شرح فعالیت', `<textarea name="description" rows="5" maxlength="4000" required>${ctx.e(report.description)}</textarea>`)}${field('نتیجه و کار باقی‌مانده', `<textarea name="output" rows="4" maxlength="4000">${ctx.e(report.output || '')}</textarea>`)}</div>${report.reviewNote ? `<p class="review-note">یادداشت مدیر: ${ctx.e(report.reviewNote)}</p>` : ''}`,
    onSubmit: data => ctx.mutate('report.update', { id: report.id, version: report.version, projectId: data.get('projectId'), date: data.get('date'), start: data.get('start'), end: data.get('end'), breakMinutes: Number(data.get('breakMinutes')), description: data.get('description'), output: data.get('output') })
  });
}
export function wireOperations(page,state,ctx) {
  if(!allowed(page,state)) return;
  document.querySelector('[data-project-filter]')?.addEventListener('change',event=>{memory(page,state).projectId=event.target.value;ctx.refresh();});
  if(page==='assistant') return wireAssistant(state,ctx);
  if(page==='reports') {
    bind('[data-new-report]',()=>ctx.openReport(memory(page,state).projectId || undefined));
    bind('[data-edit-report]',el=>{const report=state.reports.find(item=>item.id===el.dataset.editReport);if(report)editReport(report,state,ctx);});
    document.querySelector('[data-report-filter]')?.addEventListener('change',event=>{memory(page,state).filter=event.target.value;ctx.refresh();});
    bind('[data-review]',el=>ctx.modal({title:labels[el.dataset.status],submitLabel:'ذخیرهٔ بررسی',body:field('یادداشت بررسی',`<textarea name="reviewNote" rows="4" maxlength="2000" ${el.dataset.status==='approved'?'':'required'}></textarea>`),onSubmit:data=>ctx.mutate('report.review',{id:el.dataset.review,status:el.dataset.status,reviewNote:data.get('reviewNote')})}));
  }
  if(page==='finance' && state.user.role==='manager') {
    bind('[data-new-invoice]',()=>ctx.openInvoice(memory(page,state).projectId || undefined));
    bind('[data-receipt]',el=>{
      const invoice=state.invoices.find(i=>i.id===el.dataset.receipt);if(!invoice)return;
      ctx.modal({title:'ثبت رسید دریافت وجه',submitLabel:'ثبت رسید',body:`<p>${ctx.e(invoice.title)}</p><p>مانده: ${ctx.money(invoice.amount-invoice.paid)}</p><div class="notice">فقط وجهی را ثبت کنید که واقعاً دریافت شده است. این فرم درگاه بانکی نیست.</div>${field('مبلغ دریافتی (تومان)',`<input name="amount" type="number" min="1" max="${invoice.amount-invoice.paid}" step="1" required>`)}${field('شماره پیگیری منحصربه‌فرد','<input name="reference" required maxlength="160" autocomplete="off">')}`,onSubmit:data=>ctx.mutate('payment.record',{invoiceId:invoice.id,amount:Number(data.get('amount')),reference:data.get('reference')})});
    });
  }
  if(page==='inventory') {
    bind('[data-new-inventory]',()=>ctx.modal({title:'تعریف کالای جدید',submitLabel:'ثبت کالا و موجودی اولیه',body:`${field('نام کالا','<input name="name" required maxlength="160">')}${field('واحد شمارش','<input name="unit" required maxlength="40" placeholder="مثلاً عدد، متر یا بسته">')}${field('موجودی اولیه','<input name="quantity" type="number" min="0" step="0.001" value="0" required>')}${field('حداقل موجودی برای هشدار','<input name="minQuantity" type="number" min="0" step="0.001" value="0" required>')}${field('بهای واحد (تومان)','<input name="unitPrice" type="number" min="0" step="1" value="0" required>')}`,onSubmit:data=>ctx.mutate('inventory.create',{name:data.get('name'),unit:data.get('unit'),quantity:Number(data.get('quantity')),minQuantity:Number(data.get('minQuantity')),unitPrice:Number(data.get('unitPrice'))})}));
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
    bind('[data-new-profile]',()=>ctx.modal({title:'پروفایل نیروی اجرایی',submitLabel:'افزودن پروفایل',body:`<div class="notice">${ctx.capabilities?.hosted ? 'ایمیل حساب ChatGPT نیرو را وارد کنید. پس از مجازشدن دسترسی او به سایت، با همان ایمیل وارد فضای کار می‌شود.' : 'این فرم فقط پروفایل می‌سازد. برای ورود مستقل از «حساب ورود» استفاده کنید.'}</div>${field('نام','<input name="name" required maxlength="100">')}${field('ایمیل کاری','<input name="email" type="email" required>')}${field('واحد','<input name="department" maxlength="100">')}${field('تخصص','<input name="skill" maxlength="180">')}`,onSubmit:data=>ctx.mutate('worker.create',Object.fromEntries(data))}));
    bind('[data-new-account]',()=>{
      if(ctx.api.isStatic) return ctx.toast('ساخت حساب ورود در پیش‌نمایش فعال نیست؛ نسخهٔ سرور مستقل لازم است.');
      const hosted=Boolean(ctx.capabilities?.hosted);
      ctx.modal({title:hosted?'افزودن عضو یا مشتری':'حساب ورود مستقل',submitLabel:hosted?'ثبت عضو و دسترسی پروژه':'ساخت حساب',body:`${hosted?'<div class="notice">ایمیل باید با حساب ChatGPT فرد یکسان باشد. برای ورود، دسترسی سایت هم باید از تنظیمات اشتراک‌گذاری به او داده شود.</div>':''}${field('نام','<input name="name" required maxlength="100">')}${field(hosted?'ایمیل حساب ChatGPT':'ایمیل','<input name="email" type="email" required autocomplete="off">')}${field('نقش','<select name="role"><option value="customer">مشتری</option><option value="worker">نیروی اجرایی</option></select>')}${hosted?'':field('رمز عبور اولیه','<input name="password" type="password" required minlength="12" maxlength="128" autocomplete="new-password">')}<fieldset><legend>پروژه‌های مجاز</legend>${state.projects.map(p=>`<label class="checkbox"><input name="projectIds" type="checkbox" value="${ctx.e(p.id)}">${ctx.e(p.name)}${p.customerId?' · دارای مشتری':''}</label>`).join('')||'<p class="muted">هنوز پروژه‌ای ساخته نشده است؛ اعضا را بعداً از بخش پروژه‌ها تخصیص دهید.</p>'}</fieldset><p class="muted">حساب مشتری فقط به پروژهٔ بدون مشتری متصل می‌شود. ${hosted?'عضویت و نقش فرد با ایمیل واردشده ثبت می‌شود.':'ایمیل باید جدید باشد؛ پروفایل بدون ورود با این فرم تبدیل نمی‌شود.'}</p>`,onSubmit:data=>ctx.mutate('account.create',{name:data.get('name'),email:data.get('email'),role:data.get('role'),...(hosted?{}:{password:data.get('password')}),projectIds:data.getAll('projectIds')})});
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
