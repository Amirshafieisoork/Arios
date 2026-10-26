import {CATALOG_DEFINITIONS,readCatalogs} from './catalogs.mjs';
const rows=state=>state.catalogs||readCatalogs(state,{includeArchived:true});
export function renderCatalogSettings(state,ctx){
  if(state.user?.role!=='manager')return '<div class="empty-state"><p>این بخش فقط برای مدیر در دسترس است.</p></div>';
  const catalogs=rows(state);
  return `<section class="catalog-settings"><div class="card"><h2>دسته‌بندی‌ها و گزینه‌های فرم‌ها</h2><p class="muted">عنوان‌های مورد نیاز تیم را اضافه یا ویرایش کنید. حذف، گزینه را از فرم‌های تازه کنار می‌گذارد؛ عنوان ثبت‌شده در سوابق قبلی حفظ می‌شود.</p></div>${Object.entries(CATALOG_DEFINITIONS).map(([key,definition])=>{
    const entries=catalogs[key]||[],active=entries.filter(item=>!item.archivedAt),archived=entries.filter(item=>item.archivedAt);
    const itemHTML=item=>`<div class="list-item row between"><strong>${ctx.e(item.label)}</strong><div class="actions">${item.archivedAt?`<button type="button" class="button secondary small" data-catalog-action="restore" data-catalog="${key}" data-catalog-id="${ctx.e(item.id)}">بازگردانی</button>`:`<button type="button" class="button secondary small" data-catalog-action="update" data-catalog="${key}" data-catalog-id="${ctx.e(item.id)}">ویرایش</button><button type="button" class="button danger small" data-catalog-action="archive" data-catalog="${key}" data-catalog-id="${ctx.e(item.id)}">حذف</button>`}</div></div>`;
    return `<section class="card" aria-labelledby="catalog-title-${key}"><div class="card-head"><h3 id="catalog-title-${key}">${ctx.e(definition.title)}</h3><button type="button" class="button primary small" data-catalog-action="create" data-catalog="${key}">افزودن ${ctx.e(definition.singular)}</button></div>${active.map(itemHTML).join('')||'<p class="muted">عنوان فعالی ثبت نشده است.</p>'}${archived.length?`<details><summary>حذف‌شده‌ها (${ctx.e(ctx.n?.(archived.length)??archived.length)})</summary>${archived.map(itemHTML).join('')}</details>`:''}</section>`;
  }).join('')}</section>`;
}
export function wireCatalogSettings(state,ctx){
  if(state.user?.role!=='manager')return;
  document.querySelectorAll('[data-catalog-action]').forEach(button=>button.addEventListener('click',()=>{
    const {catalog:catalog,catalogAction:action,catalogId:id}=button.dataset,definition=CATALOG_DEFINITIONS[catalog];if(!definition)return;
    const item=(rows(state)[catalog]||[]).find(row=>row.id===id);
    if(action!=='create'&&!item)return;
    const editing=['create','update'].includes(action),title=action==='create'?`افزودن ${definition.singular}`:action==='update'?`ویرایش ${definition.singular}`:action==='restore'?`بازگردانی ${definition.singular}`:`حذف ${definition.singular}`;
    ctx.modal({title,submitLabel:action==='create'?'افزودن':action==='update'?'ذخیرهٔ عنوان':action==='restore'?'بازگردانی':'حذف از فرم‌ها',body:editing?`<label class="field"><span class="field-label">عنوان</span><input name="label" value="${ctx.e(item?.label||'')}" required maxlength="${definition.max}"></label><p class="muted">تغییر عنوان روی انتخاب‌های بعدی اثر دارد؛ متن سوابق قبلی تغییر نمی‌کند.</p>`:`<p><strong>${ctx.e(item.label)}</strong></p><p>${action==='restore'?'این گزینه دوباره در فرم‌ها قابل انتخاب می‌شود.':'این گزینه از انتخاب‌های تازه حذف می‌شود و سوابق قبلی با همان عنوان باقی می‌مانند.'}</p>`,onSubmit:form=>ctx.mutate(`catalog.${action}`,{catalog,...(id?{id}:{}),...(editing?{label:form.get('label')}:{})})});
  }));
}
