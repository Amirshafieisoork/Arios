/** Shared editable labels. Workflow states and access roles are deliberately separate. */
export const CATALOG_DEFINITIONS = Object.freeze({
  projectTypes: Object.freeze({title:'نوع فعالیت پروژه', singular:'نوع فعالیت', max:80, defaults:['نظارت تصویری','برق و هوشمندسازی','برگزاری رویداد','تولید محتوا','خدمات و پشتیبانی','بازرگانی']}),
  departments: Object.freeze({title:'واحدهای سازمانی', singular:'واحد', max:100, defaults:['اجرای پروژه','فنی','فروش','مالی','انبار']}),
  skills: Object.freeze({title:'تخصص همکاران', singular:'تخصص', max:180, defaults:['نصب و راه‌اندازی','شبکه','برق','هوشمندسازی','تولید محتوا','پشتیبانی']}),
  units: Object.freeze({title:'واحد شمارش کالا', singular:'واحد شمارش', max:40, defaults:['عدد','متر','بسته','دستگاه','رول','کیلوگرم','ست']})
});
const list=value=>Array.isArray(value)?value:[];
const plain=value=>value&&typeof value==='object'&&!Array.isArray(value);
const normalized=value=>String(value??'').normalize('NFKC').replace(/ي/g,'ی').replace(/ك/g,'ک').replace(/\s+/g,' ').trim().toLocaleLowerCase('fa');
const legacyId=value=>{let hash=2166136261;for(const c of value){hash^=c.charCodeAt(0);hash=Math.imul(hash,16777619);}return (hash>>>0).toString(36);};
function fail(message,status=400,code='INVALID_CATALOG'){const error=new Error(message);error.status=status;error.code=code;throw error;}
function keyOf(value){if(typeof value!=='string'||!Object.hasOwn(CATALOG_DEFINITIONS,value))fail('گروه دسته‌بندی معتبر نیست.');return value;}
function labelOf(value,key){if(typeof value!=='string')fail('عنوان را وارد کنید.');const label=value.normalize('NFKC').replace(/\s+/g,' ').trim();if(!label||label.length>CATALOG_DEFINITIONS[key].max||/[\u0000-\u001f\u007f]/.test(label))fail(`عنوان ${CATALOG_DEFINITIONS[key].singular} معتبر نیست.`);return label;}
function legacyLabels(state,key){
  const rows=key==='projectTypes'?list(state.projects).map(item=>item.type):key==='units'?[...list(state.inventory),...list(state.materials)].map(item=>item.unit):list(state.users).map(item=>item[key==='skills'?'skill':'department']);
  return rows.filter(value=>typeof value==='string'&&value.trim()&&value.length<=CATALOG_DEFINITIONS[key].max);
}
function safeEntry(item){return Object.fromEntries(['id','label','archivedAt','archivedBy','createdAt','updatedAt','aliases'].filter(key=>item[key]!==undefined).map(key=>[key,structuredClone(item[key])]));}
/** Server projection and migration-free defaults; returned entries never share mutable references. */
export function readCatalogs(state,{includeArchived=false}={}){
  const result={};
  for(const [key,definition]of Object.entries(CATALOG_DEFINITIONS)){
    const stored=plain(state?.catalogs)&&Array.isArray(state.catalogs[key]);
    const rows=stored?state.catalogs[key].filter(item=>plain(item)&&typeof item.id==='string'&&typeof item.label==='string').map(safeEntry):definition.defaults.map((label,index)=>({id:`${key}-default-${index+1}`,label}));
    const seen=new Set(rows.flatMap(item=>[item.label,...list(item.aliases)]).map(normalized));
    for(const raw of legacyLabels(state||{},key)){const label=raw.trim(),value=normalized(label);if(!seen.has(value)){rows.push({id:`${key}-legacy-${legacyId(value)}`,label});seen.add(value);}}
    result[key]=rows.filter(item=>includeArchived||!item.archivedAt);
  }
  return result;
}
/** Mutates only a validated draft; caller owns atomic commit and the audit event. */
export function applyCatalogAction(draft,user,action,payload={}){
  if(user?.role!=='manager'||user.deletedAt)fail('ویرایش دسته‌بندی‌ها فقط برای مدیر مجاز است.',403,'FORBIDDEN');
  if(!plain(payload))fail('ورودی دسته‌بندی معتبر نیست.');
  const key=keyOf(payload.catalog),catalogs=readCatalogs(draft,{includeArchived:true}),rows=catalogs[key];
  const timestamp=new Date().toISOString();let item;
  if(action==='catalog.create'){
    const label=labelOf(payload.label,key),norm=normalized(label);
    if(rows.some(row=>[row.label,...list(row.aliases)].some(value=>normalized(value)===norm)))fail('این عنوان قبلاً ثبت شده است؛ مورد حذف‌شده را بازگردانید.',409,'DUPLICATE_CATALOG_LABEL');
    if(rows.length>=200)fail('این گروه به سقف ۲۰۰ عنوان رسیده است.',409,'CATALOG_LIMIT');
    item={id:`cat_${globalThis.crypto.randomUUID()}`,label,createdAt:timestamp};rows.push(item);
  }else{
    if(!['catalog.update','catalog.archive','catalog.restore'].includes(action))fail('عملیات دسته‌بندی شناخته‌شده نیست.');
    item=rows.find(row=>row.id===payload.id);if(!item)fail('عنوان دسته‌بندی یافت نشد.',404,'CATALOG_NOT_FOUND');
    if(action==='catalog.update'){
      if(item.archivedAt)fail('ابتدا عنوان حذف‌شده را بازگردانید.',409,'CATALOG_ARCHIVED');
      const label=labelOf(payload.label,key),norm=normalized(label);
      if(rows.some(row=>row.id!==item.id&&[row.label,...list(row.aliases)].some(value=>normalized(value)===norm)))fail('این عنوان قبلاً ثبت شده است.',409,'DUPLICATE_CATALOG_LABEL');
      if(item.label!==label){const aliases=[...new Set([...list(item.aliases),item.label])];if(aliases.length>40)fail('این عنوان چندین بار تغییر کرده است؛ عنوان تازه‌ای اضافه کنید.',409,'CATALOG_RENAME_LIMIT');item.aliases=aliases;item.label=label;}
      item.updatedAt=timestamp;
    }else if(action==='catalog.archive'){
      item.archivedAt ||= timestamp;item.archivedBy=user.id;
    }else{delete item.archivedAt;delete item.archivedBy;item.updatedAt=timestamp;}
  }
  draft.catalogs=catalogs;
  return {catalog:key,...safeEntry(item)};
}
export function catalogOptions(state,key,currentValue=''){
  keyOf(key);
  const rows=Array.isArray(state?.catalogs?.[key])?state.catalogs[key]:readCatalogs(state||{},{includeArchived:true})[key];
  const result=rows.filter(item=>!item.archivedAt).map(item=>({value:item.label,label:item.label}));
  if(currentValue&&!result.some(item=>item.value===currentValue))result.unshift({value:String(currentValue),label:`${currentValue} (ثبت قبلی)`,historical:true});
  return result;
}
export function catalogOptionHTML(state,key,escape,current=''){
  return catalogOptions(state,key,current).map(item=>`<option value="${escape(item.value)}"${item.value===current?' selected':''}>${escape(item.label)}</option>`).join('');
}
export function catalogSelect(state,key,ctx,{name,value='',required=false,optional=false}={}){
  const choices=catalogOptionHTML(state,key,ctx.e,value);
  return `<select name="${ctx.e(name||key)}"${required?' required':''}>${optional?'<option value="">ثبت نشده</option>':''}${!choices?'<option value="">ابتدا عنوانی اضافه کنید</option>':choices}</select>`;
}
