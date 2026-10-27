import {renderPersonalStockWorkspace,wirePersonalStockWorkspace} from './personal-stock-workspace.mjs';
import {catalogSelect} from './catalogs.mjs';
/** Stock and project consumption. Authorization and quantities are rechecked by the API. */
const list = value => Array.isArray(value) ? value : [];
const stockRoles = new Set(['manager', 'warehouse']);
const inventoryRoles = new Set(['manager', 'warehouse', 'worker']);
const quantity = value => Math.round(Number(value || 0) * 1000) / 1000;
const field = (label, content, full = false) => `<label class="field${full ? ' full' : ''}"><span class="field-label">${label}</span>${content}</label>`;
const empty = (message, ctx) => `<div class="empty-state"><p>${ctx.e(message)}</p></div>`;
const canManage = state => stockRoles.has(state.user.role);
const projects = state => list(state.projects).filter(project => state.user.role !== 'worker' || list(project.memberIds).includes(state.user.id));
const stock = state => list(canManage(state) ? state.inventory : state.stockCatalog).filter(item => !item.archivedAt);
const archivedStock = state => canManage(state) ? list(state.archivedInventory) : [];
const scope = (state, ctx) => {
  const available = projects(state);
  return ctx.inventoryProjectId ? available.filter(project => project.id === ctx.inventoryProjectId) : available;
};
const input = (name, type, value, attributes = '', ctx) => `<input name="${name}" type="${type}" value="${ctx.e(value)}" ${attributes}>`;
const projectName = (state, ctx, id) => list(state.projects).find(project => project.id === id)?.name || ctx.projectName?.(id) || 'پروژه';
const personName = (state, ctx, id) => list(state.users).find(person => person.id === id)?.name || ctx.personName?.(id) || 'عضو تیم';
function stockOptions(items, selected, ctx) {
  return items.map(item => `<option value="${ctx.e(item.id)}" ${item.id === selected ? 'selected' : ''} ${Number(item.quantity) <= 0 ? 'disabled' : ''}>${ctx.e(item.name)} · ${ctx.e(ctx.n(item.quantity))} ${ctx.e(item.unit)}</option>`).join('');
}
function projectOptions(items, selected, ctx) {
  return items.map(project => `<option value="${ctx.e(project.id)}" ${project.id === selected ? 'selected' : ''}>${ctx.e(project.name)}</option>`).join('');
}
function materials(state, ctx) {
  const ids = new Set(scope(state, ctx).map(project => project.id));
  return list(state.materials).filter(item => ids.has(item.projectId)).sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
}
function stockCard(item, state, ctx) {
  const low = canManage(state) && Number(item.quantity) <= Number(item.minQuantity || 0);
  return `<article class="list-item inventory-stock-item" data-inventory-stock data-inventory-name="${ctx.e(item.name.toLocaleLowerCase('fa'))}">
    <div class="row between"><div><h3>${ctx.e(item.name)}</h3>${canManage(state) ? `<small class="muted">بهای واحد ${ctx.money(item.unitPrice)} · حداقل ${ctx.e(ctx.n(item.minQuantity))} ${ctx.e(item.unit)}</small>` : '<small class="muted">موجودی قابل برداشت برای پروژه</small>'}</div><span class="badge ${low ? 'warning' : Number(item.quantity) > 0 ? 'success' : ''}">${ctx.e(ctx.n(item.quantity))} ${ctx.e(item.unit)}</span></div>
    <div class="actions">${canManage(state) ? `<button type="button" class="button secondary small" data-inventory-action="receive" data-inventory-id="${ctx.e(item.id)}">ورود به انبار</button>` : ''}<button type="button" class="button secondary small" data-inventory-action="consume" data-inventory-id="${ctx.e(item.id)}" ${Number(item.quantity) <= 0 || !projects(state).length ? 'disabled' : ''}>مصرف در پروژه</button>${canManage(state) ? `<button type="button" class="button danger small" data-inventory-action="delete" data-inventory-id="${ctx.e(item.id)}">حذف کالا</button>` : ''}</div>
  </article>`;
}
function archivedCard(item, ctx) {
  return `<article class="list-item inventory-archived-item"><div class="row between"><div><h3>${ctx.e(item.name)}</h3><small class="muted">حذف از فهرست فعال در ${ctx.e(ctx.date(item.archivedAt))}</small></div><span class="badge">موجودی محفوظ ${ctx.e(ctx.n(item.quantity))} ${ctx.e(item.unit)}</span></div><p class="muted">سوابق مصرف و برگشت این کالا نگه‌داری شده‌اند.</p><button type="button" class="button secondary small" data-inventory-action="restore" data-inventory-id="${ctx.e(item.id)}">بازگردانی به فهرست فعال</button></article>`;
}
function materialCard(item, state, ctx) {
  const original = item.originalQuantity ?? quantity(Number(item.quantity) + Number(item.returnedQuantity || 0));
  const history = list(item.returns);
  return `<article class="list-item inventory-consumption" data-inventory-consumption data-inventory-project="${ctx.e(item.projectId)}">
    <div class="row between"><div><h3>${ctx.e(item.name)}</h3><small class="muted">${ctx.e(projectName(state, ctx, item.projectId))} · ${ctx.e(ctx.date(item.date))}</small></div><span class="badge">مصرف خالص ${ctx.e(ctx.n(item.quantity))} ${ctx.e(item.unit)}</span></div>
    <p class="muted">برداشت ${ctx.e(ctx.n(original))} ${ctx.e(item.unit)}${Number(item.returnedQuantity) > 0 ? ` · برگشت ${ctx.e(ctx.n(item.returnedQuantity))} ${ctx.e(item.unit)}` : ''}${item.recordedBy ? ` · ثبت ${ctx.e(personName(state, ctx, item.recordedBy))}` : ''}</p>
    ${canManage(state) ? `<p class="muted">بهای مصرف خالص ${ctx.money(quantity(item.quantity * item.unitPrice))}${item.clientVisible ? ' · قابل مشاهده برای مشتری' : ' · داخلی'}</p>` : ''}
    ${item.inventoryId && Number(item.quantity) > 0 ? `<button type="button" class="button secondary small" data-inventory-action="return" data-inventory-id="${ctx.e(item.id)}">برگشت کالا به انبار</button>` : !item.inventoryId ? '<small class="muted">قلم مستقل از انبار؛ برگشت موجودی ندارد</small>' : '<span class="badge success">تمام مقدار به انبار برگشته است</span>'}
    ${history.length ? `<details class="inventory-return-history"><summary>سوابق برگشت (${ctx.e(ctx.n(history.length))})</summary>${history.map(entry => `<div class="inventory-return-entry"><div class="row between"><strong>${ctx.e(ctx.n(entry.quantity))} ${ctx.e(item.unit)}</strong><small>${ctx.e(ctx.date(entry.date))}</small></div>${entry.note ? `<p class="pre-wrap">${ctx.e(entry.note)}</p>` : ''}<small class="muted">ثبت ${ctx.e(personName(state, ctx, entry.recordedBy))}</small></div>`).join('')}</details>` : ''}
  </article>`;
}

export function renderInventoryWorkspace(state, ctx) {
  if (!inventoryRoles.has(state.user.role)) return empty('این بخش برای نقش شما در دسترس نیست', ctx);
  const scoped = Boolean(ctx.inventoryProjectId), personal = !scoped && ctx.inventoryView === 'personal';
  const navigation = scoped ? '' : `<nav class="personal-stock-tabs" aria-label="بخش‌های انبار"><a class="button secondary ${!personal?'active':''}" href="#inventory" ${!personal?'aria-current="page"':''}>موجودی و مصرف پروژه</a><a class="button secondary ${personal?'active':''}" href="#inventory/personal" ${personal?'aria-current="page"':''}>${state.user.role==='worker'?'حساب برداشت شخصی من':'برداشت شخصی همکاران'}</a></nav>`;
  if(personal)return `<div class="inventory-workspace">${navigation}${renderPersonalStockWorkspace(state,ctx)}</div>`;
  const items = stock(state), archived = archivedStock(state), availableProjects = scope(state, ctx), rows = materials(state, ctx);
  const canConsume = availableProjects.length > 0 && items.some(item => Number(item.quantity) > 0);
  const consumeButton = `<button type="button" class="button primary" data-inventory-action="consume" ${canConsume ? '' : 'disabled'}>ثبت مصرف کالا</button>`;
  const heading = scoped ? `<div class="row between"><div><h2>کالاهای مصرفی پروژه</h2><p class="muted">برداشت و برگشت کالا با حفظ سوابق</p></div>${consumeButton}</div>` : `<div class="page-heading"><div><p class="eyebrow">ARIOS WORKSPACE</p><h1>${canManage(state) ? 'انبار و مصرف پروژه‌ها' : 'کالاهای مصرفی پروژه‌های من'}</h1><p class="muted">${canManage(state) ? 'ورود کالا، برداشت برای پروژه و برگشت اقلام استفاده‌نشده' : 'مصرف و برگشت کالا فقط برای پروژه‌های تخصیص‌یافتهٔ شما'}</p></div><div class="page-actions">${canManage(state) ? '<button type="button" class="button secondary" data-inventory-action="create">کالای جدید</button>' : ''}${consumeButton}</div></div>`;
  const prerequisites = !availableProjects.length ? `<div class="notice">${state.user.role === 'manager' ? 'برای ثبت مصرف، ابتدا از بخش پروژه‌ها یک پروژه بسازید' : state.user.role === 'worker' ? 'هنوز پروژه‌ای به شما تخصیص داده نشده؛ با مدیر هماهنگ کنید' : 'هنوز پروژه‌ای برای ثبت مصرف وجود ندارد؛ مدیر باید پروژه را تعریف کند'}</div>` : !items.some(item => Number(item.quantity) > 0) ? `<div class="notice">${canManage(state) ? 'برای ثبت مصرف، یک کالا تعریف و موجودی آن را وارد کنید' : 'موجودی قابل برداشت وجود ندارد؛ با انباردار هماهنگ کنید'}</div>` : '';
  const stockSection = scoped ? '' : `<section class="card"><div class="row between"><h2>موجودی انبار</h2><span class="badge">${ctx.e(ctx.n(items.length))} قلم</span></div>${items.length ? '<label class="field inventory-search"><span class="field-label">جست‌وجوی کالا</span><input type="search" data-inventory-search placeholder="نام کالا"></label>' : ''}<div class="inventory-stock-list">${items.map(item => stockCard(item, state, ctx)).join('') || empty(canManage(state) ? 'هنوز کالایی تعریف نشده؛ با «کالای جدید» نام، واحد و موجودی اولیه را ثبت کنید' : 'هنوز کالایی در انبار تعریف نشده است', ctx)}</div><p class="empty-state" data-inventory-search-empty hidden>کالایی با این نام پیدا نشد</p></section>`;
  const archivedSection = !scoped && archived.length ? `<details class="card inventory-archive"><summary>کالاهای حذف‌شده از فهرست فعال (${ctx.e(ctx.n(archived.length))})</summary><p class="muted">موجودی این اقلام صفر نشده است. برای ورود یا برداشت تازه، ابتدا کالا را به فهرست فعال بازگردانید؛ برگشت مصرف‌های قبلی همچنان قابل ثبت است.</p><div class="inventory-stock-list">${archived.map(item => archivedCard(item, ctx)).join('')}</div></details>` : '';
  return `<div class="inventory-workspace">${heading}${navigation}${prerequisites}${stockSection}${archivedSection}<section class="card"><div class="row between"><h2>سوابق مصرف و برگشت</h2>${!scoped && availableProjects.length ? `<label class="filter-label">پروژه<select data-inventory-project-filter><option value="">همهٔ پروژه‌های مجاز</option>${projectOptions(availableProjects, '', ctx)}</select></label>` : ''}</div>${rows.map(item => materialCard(item, state, ctx)).join('') || empty('هنوز مصرف کالایی برای این پروژه‌ها ثبت نشده است', ctx)}<p class="empty-state" data-inventory-project-empty hidden>مصرفی برای پروژهٔ انتخاب‌شده ثبت نشده است</p></section></div>`;
}

export function openInventoryConsumption(state, ctx, projectId = ctx.inventoryProjectId, inventoryId) {
  if (!inventoryRoles.has(state.user.role)) return;
  const availableProjects = scope(state, ctx), items = stock(state), usable = items.filter(item => Number(item.quantity) > 0);
  if (!availableProjects.length || !usable.length) { ctx.toast?.(!availableProjects.length ? 'پروژهٔ مجاز برای ثبت مصرف وجود ندارد' : 'موجودی قابل برداشت وجود ندارد'); return; }
  const selected = usable.find(item => item.id === inventoryId) || usable[0];
  ctx.modal({ title: 'ثبت مصرف کالا برای پروژه', submitLabel: 'ثبت برداشت از انبار', body: `<div class="form-grid">${field('پروژه', `<select name="projectId" required>${projectOptions(availableProjects, projectId || availableProjects[0].id, ctx)}</select>`, true)}${field('کالای انبار', `<select name="inventoryId" required>${stockOptions(items, selected.id, ctx)}</select>`, true)}${field('مقدار مصرف', input('quantity', 'number', Math.min(1, selected.quantity), 'required min="0.001" step="0.001" max="' + Number(selected.quantity) + '"', ctx))}${field('تاریخ مصرف', input('date', 'date', ctx.today(), 'required', ctx))}<p class="muted field full" data-inventory-stock-note>موجودی قابل برداشت: ${ctx.e(ctx.n(selected.quantity))} ${ctx.e(selected.unit)}</p>${canManage(state) ? '<label class="checkbox-label field full"><input type="checkbox" name="clientVisible">این قلم و بهای آن برای مشتری نمایش داده شود</label>' : ''}</div>`, onSubmit: form => ctx.mutate('material.consume', { projectId: form.get('projectId'), inventoryId: form.get('inventoryId'), quantity: Number(form.get('quantity')), date: form.get('date'), ...(canManage(state) ? { clientVisible: form.has('clientVisible') } : {}) }) });
  const form = globalThis.document?.querySelector('#modal-form'), select = form?.querySelector('[name="inventoryId"]');
  select?.addEventListener('change', () => {
    const selectedItem = items.find(item => item.id === select.value), amount = form.querySelector('[name="quantity"]'), note = form.querySelector('[data-inventory-stock-note]');
    if (!selectedItem) return;
    amount.max = String(selectedItem.quantity);
    if (Number(amount.value) > Number(selectedItem.quantity)) amount.value = String(selectedItem.quantity);
    if (note) note.textContent = `موجودی قابل برداشت: ${ctx.n(selectedItem.quantity)} ${selectedItem.unit}`;
  });
}
function openReturn(state, ctx, id) {
  const material = materials(state, ctx).find(item => item.id === id);
  if (!material?.inventoryId || Number(material.quantity) <= 0) return;
  ctx.modal({ title: 'برگشت کالا به انبار', submitLabel: 'ثبت برگشت', body: `<p><strong>${ctx.e(material.name)}</strong> · ${ctx.e(projectName(state, ctx, material.projectId))}</p><p class="notice">حداکثر مقدار قابل برگشت ${ctx.e(ctx.n(material.quantity))} ${ctx.e(material.unit)} است</p><div class="form-grid">${field('مقدار برگشت', input('quantity', 'number', Math.min(1, material.quantity), `required min="0.001" step="0.001" max="${Number(material.quantity)}"`, ctx))}${field('تاریخ برگشت', input('date', 'date', ctx.today() < material.date ? material.date : ctx.today(), `required min="${ctx.e(material.date)}"`, ctx))}${field('یادداشت برگشت', '<textarea name="note" rows="3" maxlength="1000" placeholder="دلیل یا توضیح برگشت"></textarea>', true)}</div>`, onSubmit: form => ctx.mutate('material.return', { id: material.id, quantity: Number(form.get('quantity')), date: form.get('date'), note: form.get('note') }) });
}
function openCreate(state, ctx) {
  if (!canManage(state)) return;
  ctx.modal({ title: 'کالای جدید انبار', submitLabel: 'ثبت کالا', body: `<div class="form-grid">${field('نام کالا', input('name', 'text', '', 'required maxlength="160"', ctx), true)}${field('واحد', catalogSelect(state,'units',ctx,{name:'unit',required:true}))}${field('موجودی اولیه', input('quantity', 'number', 0, 'required min="0" step="0.001"', ctx))}${field('حداقل موجودی', input('minQuantity', 'number', 0, 'required min="0" step="0.001"', ctx))}${field('بهای واحد (تومان)', input('unitPrice', 'number', 0, 'required min="0" step="1"', ctx))}</div>`, onSubmit: form => ctx.mutate('inventory.create', { name: form.get('name'), unit: form.get('unit'), quantity: Number(form.get('quantity')), minQuantity: Number(form.get('minQuantity')), unitPrice: Number(form.get('unitPrice')) }) });
}
function openReceive(state, ctx, id) {
  if (!canManage(state)) return;
  const item = stock(state).find(item => item.id === id);
  if (!item) return;
  ctx.modal({ title: 'ورود کالا به انبار', submitLabel: 'ثبت ورود', body: `<p><strong>${ctx.e(item.name)}</strong> · موجودی فعلی ${ctx.e(ctx.n(item.quantity))} ${ctx.e(item.unit)}</p><div class="form-grid">${field(`مقدار ورودی (${ctx.e(item.unit)})`, input('quantity', 'number', 1, 'required min="0.001" step="0.001"', ctx), true)}</div>`, onSubmit: form => ctx.mutate('inventory.receive', { id: item.id, quantity: Number(form.get('quantity')) }) });
}
function openDelete(state, ctx, id) {
  if (!canManage(state)) return;
  const item = stock(state).find(item => item.id === id);
  if (!item) return;
  const referenced = list(state.materials).some(material => material.inventoryId === item.id);
  const retained = Number(item.quantity) !== 0 || referenced;
  ctx.modal({ title: 'حذف کالای انبار', submitLabel: retained ? 'حذف از فهرست فعال' : 'تأیید حذف کالا', body: `<p><strong>${ctx.e(item.name)}</strong></p><p class="inventory-removal-quantity">موجودی فعلی: <strong>${ctx.e(ctx.n(item.quantity))} ${ctx.e(item.unit)}</strong></p><p class="notice">${retained ? 'کالا از فهرست فعال حذف می‌شود؛ موجودی فعلی و همهٔ سوابق مصرف، برگشت و هزینه حفظ می‌شوند. از بخش کالاهای حذف‌شده می‌توانید آن را بازگردانید.' : 'این کالا موجودی و سابقهٔ مصرف ندارد و حذف می‌شود. اگر هم‌زمان سابقه‌ای برای آن ثبت شده باشد، با حفظ سوابق از فهرست فعال کنار گذاشته می‌شود.'}</p><label class="checkbox-label inventory-removal-confirm"><input type="checkbox" name="confirmed" required>موجودی نمایش‌داده‌شده و نتیجهٔ حذف این کالا را بررسی و تأیید می‌کنم.</label>`, onSubmit: form => ctx.mutate('inventory.delete', { id: item.id, expectedQuantity: Number(item.quantity), confirmed: form.has('confirmed') }) });
}
function openRestore(state, ctx, id) {
  if (!canManage(state)) return;
  const item = archivedStock(state).find(item => item.id === id);
  if (!item) return;
  ctx.modal({ title: 'بازگردانی کالای انبار', submitLabel: 'بازگردانی به فهرست فعال', body: `<p><strong>${ctx.e(item.name)}</strong></p><p>موجودی محفوظ: ${ctx.e(ctx.n(item.quantity))} ${ctx.e(item.unit)}</p><p class="notice">پس از بازگردانی، ورود کالا و مصرف تازه برای این قلم دوباره فعال می‌شود. سوابق قبلی حفظ می‌شوند.</p>`, onSubmit: () => ctx.mutate('inventory.restore', { id: item.id }) });
}
function installStyles() {
  const document = globalThis.document;
  if (!document?.head || document.querySelector('link[data-inventory-styles]')) return;
  const link = document.createElement('link'); link.rel = 'stylesheet'; link.href = new URL('./inventory-workspace.css', import.meta.url).href; link.dataset.inventoryStyles = ''; document.head.append(link);
}
export function wireInventoryWorkspace(state, ctx) {
  if (!inventoryRoles.has(state.user.role)) return;
  installStyles();
  const document = globalThis.document;
  if (!document) return;
  if(!ctx.inventoryProjectId)wirePersonalStockWorkspace(state,ctx);
  document.querySelectorAll('[data-inventory-action]').forEach(button => {
    if (button.inventoryBound) return; button.inventoryBound = true;
    button.addEventListener('click', () => {
      const action = button.dataset.inventoryAction, id = button.dataset.inventoryId;
      if (action === 'consume') openInventoryConsumption(state, ctx, ctx.inventoryProjectId, id);
      if (action === 'return') openReturn(state, ctx, id);
      if (action === 'create') openCreate(state, ctx);
      if (action === 'receive') openReceive(state, ctx, id);
      if (action === 'delete') openDelete(state, ctx, id);
      if (action === 'restore') openRestore(state, ctx, id);
    });
  });
  document.querySelector('[data-inventory-search]')?.addEventListener('input', event => {
    const value = event.target.value.trim().toLocaleLowerCase('fa'); let visible = 0;
    document.querySelectorAll('[data-inventory-stock]').forEach(row => { row.hidden = !row.dataset.inventoryName.includes(value); if (!row.hidden) visible += 1; });
    const emptyNode = document.querySelector('[data-inventory-search-empty]'); if (emptyNode) emptyNode.hidden = visible > 0;
  });
  document.querySelector('[data-inventory-project-filter]')?.addEventListener('change', event => {
    const value = event.target.value; let visible = 0;
    document.querySelectorAll('[data-inventory-consumption]').forEach(row => { row.hidden = Boolean(value && row.dataset.inventoryProject !== value); if (!row.hidden) visible += 1; });
    const emptyNode = document.querySelector('[data-inventory-project-empty]'); if (emptyNode) emptyNode.hidden = visible > 0;
  });
}
