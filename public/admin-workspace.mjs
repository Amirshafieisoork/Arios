import {renderCatalogSettings,wireCatalogSettings} from './catalog-settings.mjs';
import {catalogSelect} from './catalogs.mjs';
import {hasPermission,actionPermission} from './permissions.mjs';

const rows=value=>Array.isArray(value)?value:[];
const manager=state=>state?.user?.role!=='customer'&&MANAGEMENT_SECTIONS.some(([key])=>canMaintainCollection(state,key,'update')||canMaintainCollection(state,key,'archive'));
const archived=record=>Boolean(record?.archivedAt||record?.deletedAt);
const choices={project:[['active','در حال اجرا'],['attention','نیازمند پیگیری'],['completed','تکمیل‌شده']],task:[['open','باز'],['in_progress','در حال انجام'],['done','انجام‌شده']],ticket:[['open','باز'],['in_progress','در حال رسیدگی'],['resolved','حل‌شده']],priority:[['normal','عادی'],['high','بالا']]};
export const MANAGEMENT_SECTIONS=Object.freeze([
 ['projects','پروژه‌ها','پروژهٔ جدید'],['tasks','وظایف و مأموریت‌ها','وظیفهٔ جدید'],['reports','گزارش‌های کار','گزارش جدید'],['materials','مصرف کالا','ثبت مصرف'],['inventory','موجودی انبار','کالای جدید'],['invoices','صورت‌حساب‌ها','صورت‌حساب جدید'],['receipts','دریافت‌ها','ثبت دریافت'],['messages','گفت‌وگوها','پیام جدید'],['tickets','پشتیبانی','درخواست جدید'],['catalogs','دسته‌بندی‌ها','']
]);
const sectionMap=new Map(MANAGEMENT_SECTIONS.map(item=>[item[0],item]));
export function canMaintainCollection(state,collection,operation='update'){
 const key=collection==='catalogs'?'catalogs.manage':actionPermission(`admin.record.${operation}`,{collection});
 return Boolean(key&&hasPermission(state?.user,key,state));
}
const availableSections=state=>MANAGEMENT_SECTIONS.filter(([key])=>canMaintainCollection(state,key,'update')||canMaintainCollection(state,key,'archive'));
const selectedSection=(state,requested)=>availableSections(state).some(([key])=>key===requested)?requested:availableSections(state)[0]?.[0];
const canCreate=(state,collection)=>hasPermission(state.user,({projects:'projects.create',tasks:'tasks.manage',reports:'reports.submit',materials:'inventory.issue',inventory:'inventory.create',invoices:'finance.manage',receipts:'finance.manage',messages:'messages.send',tickets:'support.submit'})[collection]);
const historyNotes={projects:'پروژه از فهرست جاری و دسترسی‌های اجرایی خارج می‌شود. گزارش‌ها، فایل‌ها، تأییدها و سوابق مالی آن محفوظ می‌مانند.',tasks:'این وظیفه از برنامهٔ جاری و یادآوری‌های بعدی کنار گذاشته می‌شود.',reports:'گزارش از محاسبات جاری کنار گذاشته می‌شود. اثر دستمزد تأییدشده اصلاح می‌شود؛ نسخه‌های قبلاً تأییدشدهٔ پرونده محفوظ می‌مانند.',materials:'مصرف از محاسبات جاری کنار گذاشته می‌شود. اگر از انبار برداشت شده باشد، موجودی طبق مقدار مصرف خالص اصلاح می‌شود.',inventory:'کالا از فهرست فعال انبار خارج می‌شود. موجودی و سابقهٔ مصرف حفظ می‌شوند.',invoices:'صورت‌حساب از فهرست جاری خارج می‌شود. اگر دریافت فعال دارد، ابتدا دریافت‌های مربوط را حذف کنید.',receipts:'اثر این دریافت از پرداخت صورت‌حساب کسر می‌شود و مانده دوباره محاسبه می‌شود.',messages:'پیام از گفت‌وگوی جاری خارج می‌شود؛ سابقهٔ مدیریتی آن حفظ می‌شود.',tickets:'درخواست از فهرست جاری پشتیبانی خارج می‌شود؛ پاسخ‌ها و تاریخچهٔ آن محفوظ می‌مانند.'};
const numeric=new Set(['budget','contractAmount','progress','breakMinutes','quantity','minQuantity','unitPrice','amount']);
const booleans=new Set(['clientVisible','internal']);
const fieldSets={
 projects:['name','type','location','startDate','endDate','description','budget','contractAmount','status','progress'],
 tasks:['title','description','assigneeId','dueDate','status'],
 reports:['projectId','workerId','date','start','end','breakMinutes','description','output'],
 materials:['name','quantity','unit','unitPrice','clientVisible','date'],
 inventory:['name','unit','quantity','minQuantity','unitPrice'],
 invoices:['title','amount','dueDate'],receipts:['amount','reference'],messages:['text','internal'],tickets:['subject','description','priority','status']
};
export function managementRecords(state,collection){
 if(!manager(state))return [];
 if(Array.isArray(state.management?.[collection])&&(canMaintainCollection(state,collection,'update')||canMaintainCollection(state,collection,'archive')))return state.management[collection];
 if(collection==='tasks')return rows(state.projects).flatMap(project=>rows(project.tasks).map(task=>({...task,projectId:project.id,projectName:project.name})));
 if(collection==='inventory')return [...rows(state.inventory),...rows(state.archivedInventory)];
 return rows(state[collection]);
}
export function managementEditPayload(collection,record,data){
 if(!fieldSets[collection])throw Error('این بخش قابل ویرایش نیست.');
 const changes={};
 for(const key of fieldSets[collection]){
  if(booleans.has(key)){if(!data.has(`preserve:${key}`))changes[key]=data.has(key);continue;}
  if(!data.has(key))continue;
  const value=String(data.get(key)??'').trim();
  changes[key]=numeric.has(key)?Number(value):value;
 }
 if(collection==='projects'&&data.has('phaseEditor')){
  const names=data.getAll('phaseName'),ids=data.getAll('phaseId'),progress=data.getAll('phaseProgress');
  changes.phases=names.map((name,index)=>({...(ids[index]?{id:String(ids[index])}:{}),name:String(name).trim(),progress:Number(progress[index]||0)})).filter(phase=>phase.name);
 }
 return {collection,id:record.id,...(collection==='tasks'?{projectId:record.projectId}:{}),...(record.version?{version:record.version}:{}),...(record.updatedAt!==undefined?{expectedUpdatedAt:record.updatedAt}:{}),changes,reason:String(data.get('reason')||'').trim()};
}
const projectName=(state,id)=>managementRecords(state,'projects').find(project=>project.id===id)?.name||rows(state.projects).find(project=>project.id===id)?.name||'پروژهٔ ثبت‌شده';
const personName=(state,id)=>rows(state.users).find(person=>person.id===id)?.name||'عضو ثبت‌شده';
const titleFor=(record,collection,state)=>record.name||record.title||record.subject||(collection==='receipts'?`دریافت ${record.reference||'ثبت‌شده'}`:collection==='reports'?`گزارش ${personName(state,record.workerId)}`:collection==='messages'?record.text:'رکورد ثبت‌شده');
function recordDetail(record,collection,state,ctx){
 const items=[];
 if(record.projectId)items.push(projectName(state,record.projectId));
 if(collection==='projects')items.push(record.projectCode||'کد ثبت نشده',record.type||'',record.location||'',`${ctx.n(record.progress)}٪ پیشرفت`);
 if(collection==='tasks')items.push(record.assigneeId?personName(state,record.assigneeId):'بدون مسئول',record.dueDate?`مهلت ${ctx.date(record.dueDate)}`:'بدون مهلت');
 if(collection==='reports')items.push(ctx.date(record.date),`${record.start||''} تا ${record.end||''}`);
 if(['materials','inventory'].includes(collection))items.push(`${ctx.n(record.quantity)} ${record.unit||''}`,...(record.unitPrice!==undefined?[`بهای واحد ${ctx.n(record.unitPrice)} تومان`]:[]));
 if(['invoices','receipts'].includes(collection))items.push(...(record.amount!==undefined?[`${ctx.n(record.amount)} تومان`]:[]),collection==='invoices'&&record.paid!==undefined?`پرداخت ${ctx.n(record.paid)} تومان`:record.reference||'');
 if(collection==='messages')items.push(personName(state,record.authorId),record.internal?'یادداشت داخلی':'قابل مشاهده برای مشتری');
 if(collection==='tickets')items.push(record.priority==='high'?'اولویت بالا':'اولویت عادی');
 if(record.archivedAt)items.push(`حذف‌شده در ${ctx.date(record.archivedAt)}`);
 if(record.projectArchivedAt)items.push('پروژه حذف‌شده؛ ابتدا پروژه را بازگردانید');
 return items.filter(Boolean).join(' · ');
}
function recordCard(record,collection,state,ctx){
 const isArchived=archived(record),title=String(titleFor(record,collection,state)),detail=recordDetail(record,collection,state,ctx),linked=collection==='tasks'&&record.sourceTicketId;
 const attrs=`data-management-project="${ctx.e(record.projectId||'')}"`;
 const button=(action,label,style='secondary')=>`<button type="button" class="button ${style} small" data-management-${action}="${ctx.e(record.id)}" ${attrs}>${label}</button>`;
 let controls='';
 if(record.projectArchivedAt)controls='<a class="button secondary small" href="#management/projects/archived">ابتدا پروژه را بازگردانید</a>';
 else if(isArchived)controls=canMaintainCollection(state,collection,'restore')&&!linked?button('restore','بازگرداندن'):'';
 else{
  if(canMaintainCollection(state,collection,'update'))controls+=linked?'<a class="button secondary small" href="#support">ویرایش از پشتیبانی</a>':button('edit','ویرایش');
  if(collection==='projects')controls+=(hasPermission(state.user,'projects.edit',state)?`<button type="button" class="button secondary small" data-management-assignment="${ctx.e(record.id)}">اعضا و تأییدکنندگان</button>`:'')+`<a class="button secondary small" href="#project/${encodeURIComponent(record.id)}">پروندهٔ پروژه</a>`;
  if(canMaintainCollection(state,collection,'archive')&&(!linked||hasPermission(state.user,'support.assign',state)))controls+=button('archive','حذف','danger');
 }
 return `<article class="management-record" data-management-record data-management-search="${ctx.e((title+' '+detail+' '+(record.description||'')).toLocaleLowerCase('fa'))}"><div class="management-record-main"><h3>${ctx.e(title.length>150?title.slice(0,150)+'…':title)}</h3><p class="muted">${ctx.e(detail)}</p>${record.status?(collection==='tasks'?`<span class="badge">${ctx.e(choices.task.find(([value])=>value===record.status)?.[1]||record.status)}</span>`:ctx.badge(record.status)):''}${isArchived?'<span class="badge gray">حذف‌شده از فهرست فعال</span>':''}${record.archiveReason?`<p class="management-reason">علت: ${ctx.e(record.archiveReason)}</p>`:''}</div><div class="management-record-actions">${controls}</div></article>`;
}
/** Controls are reusable beside a record; server scope/version checks remain authoritative. */
export function renderRecordActions(state,ctx,collection,record,{edit=true,archive=true,restore=true}={}){
 if(!record||!sectionMap.has(collection)||collection==='catalogs'||state.user?.role==='customer')return '';
 if(record.projectArchivedAt)return '';
 const attrs=`data-record-collection="${ctx.e(collection)}" data-record-id="${ctx.e(record.id)}" data-record-project="${ctx.e(record.projectId||'')}"`;
 const control=(action,label,style='secondary')=>`<button type="button" class="button ${style} small" data-record-action="${action}" ${attrs}>${label}</button>`;
 if(archived(record))return restore&&!(collection==='tasks'&&record.sourceTicketId)&&canMaintainCollection(state,collection,'restore')?`<div class="actions record-actions">${control('restore','بازگرداندن')}</div>`:'';
 const linked=collection==='tasks'&&record.sourceTicketId;
 const controls=[edit&&canMaintainCollection(state,collection,'update')?(linked?'<a class="button secondary small" href="#support">ویرایش از پشتیبانی</a>':control('edit','ویرایش')):'',archive&&canMaintainCollection(state,collection,'archive')&&(!linked||hasPermission(state.user,'support.assign',state))?control('archive','حذف','danger'):''].filter(Boolean).join('');
 return controls?`<div class="actions record-actions">${controls}</div>`:'';
}
export function wireRecordActions(state,ctx){
 const doc=globalThis.document;if(!doc?.querySelectorAll)return;
 doc.querySelectorAll('[data-record-action]').forEach(button=>{
  if(button.dataset.recordWired)return;button.dataset.recordWired='true';
  button.addEventListener('click',()=>{
   const {recordAction:action,recordCollection:collection,recordId:id,recordProject:projectId}=button.dataset;
   if(!['edit','archive','restore'].includes(action)||!canMaintainCollection(state,collection,action==='edit'?'update':action))return;
   const record=managementRecords(state,collection).find(row=>row.id===id&&(!projectId||row.projectId===projectId));
   if(!record)return;
   if(action==='edit')editRecord(collection,record,state,ctx);else confirmRecord(action,collection,record,state,ctx);
  });
 });
}
export function renderAdminWorkspace(state,ctx,requested='projects',mode='active'){
 if(!manager(state))return ctx.head('دسترسی این بخش فعال نیست','مدیریت اطلاعات فقط برای مدیر مجاز است.');
 const collection=selectedSection(state,requested),section=sectionMap.get(collection),all=managementRecords(state,collection),showArchived=mode==='archived',items=all.filter(item=>archived(item)===showArchived);
 const heading=ctx.head('مدیریت اطلاعات','افزودن، اصلاح، حذف و بازگرداندن اطلاعات فضای کار',`<a class="button secondary" href="#team">کاربران و دسترسی‌ها</a>`);
 const tabs=`<nav class="management-tabs" aria-label="بخش‌های مدیریت اطلاعات">${availableSections(state).map(([key,label])=>`<a class="management-tab ${collection===key?'active':''}" href="#management/${key}" ${collection===key?'aria-current="page"':''}>${label}</a>`).join('')}</nav>`;
 const shortcuts=`<div class="management-shortcuts"><a href="#team">افزودن، ویرایش و حذف افراد</a><a href="#documents">مدارک و فایل‌های پروژه</a><a href="#settings">تنظیمات و اتصال‌ها</a></div>`;
 if(collection==='catalogs')return `<div class="admin-workspace">${heading}${tabs}${shortcuts}${renderCatalogSettings(state,ctx)}</div>`;
 return `<div class="admin-workspace">${heading}${tabs}${shortcuts}<section class="card"><div class="management-toolbar"><div><h2>${ctx.e(section[1])}</h2><p class="muted">حذف‌ها با حفظ سوابق انجام می‌شوند و از زبانهٔ حذف‌شده‌ها قابل بازگرداندن هستند.</p></div>${canCreate(state,collection)?`<button type="button" class="button primary" data-management-new>${ctx.icon('plus')}${ctx.e(section[2])}</button>`:''}</div><div class="management-filterbar"><div class="tabs" aria-label="وضعیت رکوردها"><a class="tab ${!showArchived?'active':''}" href="#management/${collection}">فعال <span>${ctx.n(all.filter(item=>!archived(item)).length)}</span></a><a class="tab ${showArchived?'active':''}" href="#management/${collection}/archived">حذف‌شده‌ها <span>${ctx.n(all.filter(archived).length)}</span></a></div><label class="searchbox management-search">${ctx.icon('search')}<input type="search" data-management-query aria-label="جست‌وجو در ${ctx.e(section[1])}" placeholder="جست‌وجو در ${ctx.e(section[1])}…"></label></div><div class="management-list">${items.map(record=>recordCard(record,collection,state,ctx)).join('')||`<div class="empty-state"><p>${showArchived?'مورد حذف‌شده‌ای وجود ندارد.':'هنوز موردی در این بخش ثبت نشده است.'}</p></div>`}<p class="empty-state" data-management-empty hidden>موردی با این عبارت پیدا نشد.</p></div></section></div>`;
}
const field=(label,body,full=false)=>`<label class="field${full?' full':''}"><span class="field-label">${label}</span>${body}</label>`;
const input=(label,name,value,ctx,type='text',extra='')=>field(label,`<input name="${name}" type="${type}" value="${ctx.e(value??'')}" ${extra}>`);
const textarea=(label,name,value,ctx,max=4000)=>field(label,`<textarea name="${name}" rows="3" maxlength="${max}">${ctx.e(value||'')}</textarea>`,true);
const select=(label,name,value,options,ctx,extra='')=>field(label,`<select name="${name}" ${extra}>${options.map(([id,title])=>`<option value="${ctx.e(id)}" ${String(value??'')===String(id)?'selected':''}>${ctx.e(title)}</option>`).join('')}</select>`);
const activeProjects=state=>managementRecords(state,'projects').filter(project=>!archived(project));
const projectSelect=(state,ctx,value)=>select('پروژه','projectId',value,activeProjects(state).map(project=>[project.id,project.projectCode?project.projectCode+' · '+project.name:project.name]),ctx,'required');
const workerSelect=(state,ctx,value,projectId,allowEmpty=false)=>{
 const eligible=rows(state.users).filter(person=>person.role==='worker'&&!person.deletedAt&&(!projectId||rows(activeProjects(state).find(project=>project.id===projectId)?.memberIds).includes(person.id)));
 const previous=rows(state.users).find(person=>person.id===value);
 const options=[...(allowEmpty?[['','بدون مسئول']]:[]),...(value&&!eligible.some(person=>person.id===value)?[[value,previous?previous.name+(previous.deletedAt?' (حساب حذف‌شده)':' (مسئول ثبت قبلی)'):'مسئول ثبت قبلی']]:[]),...eligible.map(person=>[person.id,person.name])];
 return select('مسئول اجرایی',allowEmpty?'assigneeId':'workerId',value,options,ctx,allowEmpty?'':'required');
};
const unitField=(state,ctx,record={})=>field('واحد شمارش',catalogSelect(state,'units',ctx,{name:'unit',value:record.unit??'',required:true}));
function phaseRow(phase,ctx){return `<div class="management-phase"><input type="hidden" name="phaseId" value="${ctx.e(phase.id||'')}"><label><span class="field-label">نام مرحله</span><input name="phaseName" maxlength="160" value="${ctx.e(phase.name||'')}"></label><label><span class="field-label">پیشرفت (%)</span><input name="phaseProgress" type="number" min="0" max="100" value="${ctx.e(phase.progress||0)}"></label><button type="button" class="button danger small" data-management-remove-phase aria-label="حذف این مرحله">حذف مرحله</button></div>`;}
function editFields(collection,record,state,ctx){
 const amount=(label,name,value,min=0,step=1)=>input(label,name,value,ctx,'number',`required min="${min}" step="${step}"`);
 const price=(label,name,value,min=0)=>hasPermission(state.user,collection==='inventory'?'inventory.prices':'projects.prices',state)&&value!==undefined?amount(label,name,value,min):'<p class="muted">مبلغ محرمانه است.</p>';
 const required=(label,name,value,max=200)=>input(label,name,value,ctx,'text',`required maxlength="${max}"`);
 if(collection==='projects')return required('نام پروژه','name',record.name,160)+field('نوع فعالیت',catalogSelect(state,'projectTypes',ctx,{name:'type',value:record.type,required:true}))+required('محل اجرا','location',record.location)+input('شروع پروژه','startDate',record.startDate,ctx,'date','required')+input('تحویل برنامه‌ریزی‌شده','endDate',record.endDate,ctx,'date','required')+price('بودجهٔ داخلی (تومان)','budget',record.budget)+price('ارزش قرارداد (تومان)','contractAmount',record.contractAmount)+input('پیشرفت کلی (%)','progress',record.progress,ctx,'number','required min="0" max="100"')+select('وضعیت','status',record.status,choices.project,ctx)+textarea('شرح خدمات','description',record.description,ctx,6000)+`<fieldset class="field full management-phases"><legend>مراحل پروژه</legend><input type="hidden" name="phaseEditor" value="1"><div data-management-phase-list>${rows(record.phases).map(phase=>phaseRow(phase,ctx)).join('')}</div><button type="button" class="button secondary small" data-management-add-phase>افزودن مرحله</button></fieldset>`;
 if(collection==='tasks')return required('عنوان وظیفه','title',record.title,240)+workerSelect(state,ctx,record.assigneeId,record.projectId,true)+input('مهلت انجام','dueDate',record.dueDate,ctx,'date')+select('وضعیت','status',record.status,choices.task,ctx)+textarea('شرح مأموریت','description',record.description,ctx,2000);
 if(collection==='reports')return projectSelect(state,ctx,record.projectId)+workerSelect(state,ctx,record.workerId,null)+input('تاریخ کار','date',record.date,ctx,'date','required')+input('ساعت شروع','start',record.start,ctx,'time','required')+input('ساعت پایان','end',record.end,ctx,'time','required')+amount('استراحت (دقیقه)','breakMinutes',record.breakMinutes||0)+textarea('شرح کار','description',record.description,ctx)+textarea('خروجی کار','output',record.output,ctx);
 if(collection==='materials')return required('نام کالا','name',record.name)+amount('مصرف خالص','quantity',record.quantity,0,0.001)+(record.inventoryId?input('واحد مرتبط با انبار','unit',record.unit,ctx,'text','readonly'):unitField(state,ctx,record))+price('بهای واحد (تومان)','unitPrice',record.unitPrice)+input('تاریخ مصرف','date',record.date,ctx,'date','required')+field('نمایش برای مشتری',`<input name="clientVisible" type="checkbox" ${record.clientVisible?'checked':''}> این مصرف و مبلغ آن برای مشتری قابل مشاهده باشد`,true);
 if(collection==='inventory')return required('نام کالا','name',record.name)+unitField(state,ctx,record)+amount('موجودی','quantity',record.quantity,0,0.001)+amount('حداقل موجودی','minQuantity',record.minQuantity||0,0,0.001)+price('بهای واحد (تومان)','unitPrice',record.unitPrice);
 if(collection==='invoices')return required('عنوان صورت‌حساب','title',record.title)+price('مبلغ (تومان)','amount',record.amount,Math.max(1,record.paid||0))+input('سررسید','dueDate',record.dueDate,ctx,'date','required');
 if(collection==='receipts')return price('مبلغ دریافت (تومان)','amount',record.amount,1)+required('شماره پیگیری','reference',record.reference,120);
 if(collection==='messages')return textarea('متن پیام','text',record.text,ctx)+field('نوع پیام',`<input type="checkbox" name="internal" ${record.internal?'checked':''}> یادداشت داخلی تیم`,true);
 if(collection==='tickets')return required('موضوع درخواست','subject',record.subject)+select('اولویت','priority',record.priority,choices.priority,ctx)+(record.taskId?'':select('وضعیت','status',record.status,choices.ticket,ctx))+textarea('شرح درخواست','description',record.description,ctx,12000);
 return '';
}
function wirePhases(ctx){
 const form=document.querySelector('#modal-form');if(!form)return;
 form.querySelector('[data-management-add-phase]')?.addEventListener('click',()=>{const holder=form.querySelector('[data-management-phase-list]');holder.insertAdjacentHTML('beforeend',phaseRow({},ctx));holder.lastElementChild.querySelector('[name="phaseName"]').focus();});
 form.addEventListener('click',event=>{const button=event.target.closest('[data-management-remove-phase]');if(button){button.closest('.management-phase').remove();}});
}
function editRecord(collection,record,state,ctx){
 if(!canMaintainCollection(state,collection,'update'))return;
 if(collection==='tasks'&&record.sourceTicketId){ctx.go?.('support');return;}
 const note=collection==='reports'&&record.status==='approved'?'اصلاح گزارش تأییدشده، آن را برای بررسی دوباره ارسال می‌کند و اثر دستمزد قبلی از محاسبات جاری کنار می‌رود. نسخهٔ امضاشدهٔ پرونده تغییر نمی‌کند.':collection==='materials'?'اصلاح مقدار مصرف مرتبط با انبار، موجودی همان کالا را هم اصلاح می‌کند.':collection==='receipts'?'با اصلاح دریافت، پرداخت و ماندهٔ صورت‌حساب دوباره محاسبه می‌شود.':'';
 ctx.modal({title:`ویرایش ${sectionMap.get(collection)[1]}`,submitLabel:'ذخیرهٔ اصلاحات',body:`${note?`<div class="notice">${ctx.e(note)}</div>`:''}<div class="form-grid">${editFields(collection,record,state,ctx)}${textarea('علت اصلاح','reason','',ctx,500)}</div>`,onSubmit:data=>ctx.mutate('admin.record.update',managementEditPayload(collection,record,data))});
 if(['reports','materials','receipts','inventory','invoices'].includes(collection)){const reason=document.querySelector('#modal-form [name="reason"]');if(reason)reason.required=true;}
 wirePhases(ctx);
}
function confirmRecord(action,collection,record,state,ctx){
 const restore=action==='restore',title=String(titleFor(record,collection,state));
 ctx.modal({title:`${restore?'بازگرداندن':'حذف'} ${sectionMap.get(collection)[1]}`,submitLabel:restore?'بازگرداندن به فهرست فعال':'حذف از فهرست فعال',body:`<p><strong>${ctx.e(title.slice(0,200))}</strong></p><div class="notice">${ctx.e(restore?'رکورد با همان شناسه و سوابق به فهرست فعال برمی‌گردد. موجودی، دستمزد و پرداخت‌ها هنگام بازگردانی دوباره کنترل می‌شوند.':historyNotes[collection])}</div>${textarea(restore?'علت بازگرداندن':'علت حذف','reason','',ctx,500)}<label class="checkbox-label"><input type="checkbox" required>${restore?'بازگرداندن این مورد':'حذف از فهرست فعال با حفظ سابقه'} را تأیید می‌کنم</label>`,onSubmit:data=>ctx.mutate(`admin.record.${action}`,{collection,id:record.id,...(collection==='tasks'?{projectId:record.projectId}:{}),...(record.version?{version:record.version}:{}),...(record.updatedAt!==undefined?{expectedUpdatedAt:record.updatedAt}:{}),reason:String(data.get('reason')||'').trim()})});
 const reason=document.querySelector('#modal-form [name="reason"]');if(reason)reason.required=true;
}
function createRecord(collection,state,ctx){
 if(!canCreate(state,collection))return;
 if(['tasks','messages','tickets'].includes(collection)&&!activeProjects(state).length)return ctx.modal({title:'ابتدا پروژه تعریف کنید',submitLabel:'متوجه شدم',body:'<p>برای ثبت این مورد، یک پروژهٔ فعال لازم است.</p><a class="button secondary" href="#management/projects">مدیریت پروژه‌ها</a>',onSubmit:async()=>{}});
 if(collection==='receipts'&&!managementRecords(state,'invoices').some(item=>!archived(item)))return ctx.modal({title:'ابتدا صورت‌حساب صادر کنید',submitLabel:'متوجه شدم',body:'<p>دریافت وجه باید به یک صورت‌حساب متصل باشد.</p><a class="button secondary" href="#management/invoices">مدیریت صورت‌حساب‌ها</a>',onSubmit:async()=>{}});
 if(collection==='projects')return ctx.openProject();
 if(collection==='reports')return ctx.openReport();
 if(collection==='materials')return ctx.openMaterial();
 if(collection==='invoices')return ctx.openInvoice();
 const amount=(label,name,value,min=0,step=1)=>input(label,name,value,ctx,'number',`required min="${min}" step="${step}"`);
 const current=ctx.today();let fields='',action,make;
 if(collection==='tasks'){
  fields=projectSelect(state,ctx,'')+input('عنوان وظیفه','title','',ctx,'text','required maxlength="240"')+workerSelect(state,ctx,'',activeProjects(state)[0]?.id,true)+input('مهلت انجام','dueDate',current,ctx,'date')+textarea('شرح مأموریت','description','',ctx,2000);action='task.create';make=data=>({projectId:data.get('projectId'),title:data.get('title'),description:data.get('description'),assigneeId:data.get('assigneeId')||null,dueDate:data.get('dueDate')||null});
 }else if(collection==='inventory'){
  fields=editFields(collection,{quantity:0,minQuantity:0,unitPrice:0},state,ctx);action='inventory.create';make=data=>({name:data.get('name'),unit:data.get('unit'),quantity:Number(data.get('quantity')),minQuantity:Number(data.get('minQuantity')),...(data.has('unitPrice')?{unitPrice:Number(data.get('unitPrice'))}:{})});
 }else if(collection==='receipts'){
  const invoices=managementRecords(state,'invoices').filter(item=>!archived(item));
  fields=select('صورت‌حساب','invoiceId','',invoices.map(invoice=>[invoice.id,`${invoice.title} · ${projectName(state,invoice.projectId)} · مانده ${ctx.n(invoice.amount-invoice.paid)} تومان`]),ctx,'required')+amount('مبلغ دریافت (تومان)','amount','',1)+input('شماره پیگیری','reference','',ctx,'text','required maxlength="120"');action='payment.record';make=data=>({invoiceId:data.get('invoiceId'),amount:Number(data.get('amount')),reference:data.get('reference')});
 }else if(collection==='messages'){
  fields=projectSelect(state,ctx,'')+textarea('متن پیام','text','',ctx)+field('نوع پیام','<input type="checkbox" name="internal"> یادداشت داخلی تیم',true);action='message.send';make=data=>({projectId:data.get('projectId'),text:data.get('text'),internal:data.has('internal')});
 }else if(collection==='tickets'){
  fields=projectSelect(state,ctx,'')+input('موضوع درخواست','subject','',ctx,'text','required maxlength="200"')+select('اولویت','priority','normal',choices.priority,ctx)+textarea('شرح درخواست','description','',ctx,12000);action='ticket.create';make=data=>({projectId:data.get('projectId'),subject:data.get('subject'),priority:data.get('priority'),description:data.get('description')});
 }
 if(!action)return;
 ctx.modal({title:sectionMap.get(collection)[2],body:`<div class="form-grid">${fields}</div>`,onSubmit:data=>ctx.mutate(action,make(data))});
 const form=document.querySelector('#modal-form');for(const name of ['text','description']){const item=form?.querySelector(`[name="${name}"]`);if(item&&collection!=='tasks')item.required=true;}
 if(collection==='tasks')form?.querySelector('[name="projectId"]')?.addEventListener('change',event=>{const select=form.querySelector('[name="assigneeId"]'),project=activeProjects(state).find(item=>item.id===event.target.value);select.innerHTML=`<option value="">بدون مسئول</option>${rows(state.users).filter(person=>person.role==='worker'&&!person.deletedAt&&rows(project?.memberIds).includes(person.id)).map(person=>`<option value="${ctx.e(person.id)}">${ctx.e(person.name)}</option>`).join('')}`;});
}
export function wireAdminWorkspace(state,ctx,requested='projects'){
 if(!manager(state))return;
 const collection=selectedSection(state,requested);if(!collection)return;
 if(collection==='catalogs'){wireCatalogSettings(state,ctx);return;}
 const lookup=button=>managementRecords(state,collection).find(record=>record.id===(button.dataset.managementEdit||button.dataset.managementArchive||button.dataset.managementRestore)&&(!button.dataset.managementProject||record.projectId===button.dataset.managementProject));
 document.querySelector('[data-management-new]')?.addEventListener('click',()=>createRecord(collection,state,ctx));
 for(const kind of ['edit','archive','restore'])document.querySelectorAll(`[data-management-${kind}]`).forEach(button=>button.addEventListener('click',()=>{const record=lookup(button);if(record){if(kind==='edit')editRecord(collection,record,state,ctx);else confirmRecord(kind,collection,record,state,ctx);}}));
 document.querySelectorAll('[data-management-assignment]').forEach(button=>button.addEventListener('click',()=>ctx.openProjectUpdate(button.dataset.managementAssignment)));
 document.querySelector('[data-management-query]')?.addEventListener('input',event=>{const search=event.target.value.trim().toLocaleLowerCase('fa').replace(/ي/g,'ی').replace(/ك/g,'ک');let count=0;document.querySelectorAll('[data-management-record]').forEach(row=>{row.hidden=!String(row.dataset.managementSearch||'').replace(/ي/g,'ی').replace(/ك/g,'ک').includes(search);if(!row.hidden)count++;});const empty=document.querySelector('[data-management-empty]');if(empty)empty.hidden=count>0||!search;});
}
