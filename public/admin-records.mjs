/** Manager maintenance keeps deleted business records recoverable and adjusts live ledgers atomically. */
const list = value => Array.isArray(value) ? value : [];
const clone = value => structuredClone(value);
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const metadata = ['archivedAt','archivedBy','archiveReason','updatedAt','updatedBy'];
const fields = {
  projects: ['id','name','type','customerId','memberIds','contactIds','location','status','progress','budget','contractAmount','startDate','endDate','description','phases','cover','clientNote','publicVisible','publicTitle','publicSummary','projectCode','projectManagerId','customerCode','dossierCode','dossierTitle','reviewChain'],
  tasks: ['id','projectId','projectName','title','description','assigneeId','dueDate','status','version','createdAt','updatedAt'],
  reports: ['id','projectId','workerId','date','start','end','breakMinutes','description','output','status','minutes','createdAt','version','rate','laborCost','reviewNote','reviewedBy','location','photoIds'],
  materials: ['id','projectId','inventoryId','name','quantity','originalQuantity','returnedQuantity','returns','unit','unitPrice','clientVisible','date','recordedBy','createdAt'],
  inventory: ['id','name','unit','quantity','minQuantity','unitPrice'],
  invoices: ['id','projectId','title','amount','paid','dueDate','status'],
  receipts: ['id','invoiceId','projectId','amount','reference','method','recordedBy','createdAt'],
  messages: ['id','projectId','authorId','text','internal','createdAt'],
  tickets: ['id','projectId','authorId','subject','description','priority','status','replies','createdAt'],
};
const editable = {
  projects: fields.projects.filter(key => !['id','cover','contactIds'].includes(key)),
  tasks: ['title','description','assigneeId','dueDate','status'],
  reports: ['projectId','workerId','date','start','end','breakMinutes','description','output','location','photoIds'],
  materials: ['name','quantity','unit','unitPrice','clientVisible','date'],
  inventory: ['name','unit','quantity','minQuantity','unitPrice'],
  invoices: ['title','amount','dueDate'],
  receipts: ['amount','reference'],
  messages: ['text','internal'],
  tickets: ['subject','description','priority','status'],
};
const select = (row, keys) => Object.fromEntries(keys.filter(key => row?.[key] !== undefined).map(key => [key, clone(row[key])]));
export function managementSnapshot(state, actor = {}) {
  const result = {};
  for (const collection of Object.keys(fields)) {
    const rows = collection === 'tasks' ? list(state.projects).flatMap(project => list(project.tasks).map(task => ({...task,projectId:project.id,projectName:project.name,projectArchivedAt:project.archivedAt}))) : list(state[collection]);
    result[collection] = rows.map(row => ({...select(row,[...fields[collection],...metadata,'projectArchivedAt']), ...(row.projectId&&state.projects.find(project=>project.id===row.projectId)?.archivedAt?{projectArchivedAt:state.projects.find(project=>project.id===row.projectId).archivedAt}:{}), ...(collection==='projects'?{files:list(row.files).filter(file=>file.status==='ready'&&!file.archivedAt&&(!file.draftId||file.reportId||file.uploadedBy===actor.id)).map(file=>select(file,['id','name','mimeType','size','uploadedBy','createdAt','clientVisible','reportId','updatedAt'])),archivedFiles:list(row.files).filter(file=>file.status==='ready'&&file.archivedAt&&(!file.draftId||file.reportId||file.uploadedBy===actor.id)).map(file=>select(file,['id','name','mimeType','size','uploadedBy','createdAt','clientVisible','reportId','archivedAt','archivedBy','updatedAt']))}:{}), ...(row.adminHistory?.length ? {amendmentCount:row.adminHistory.length} : {})}));
  }
  return result;
}

export function applyAdminRecordAction(state, actor, action, payload, {fail, run, historicalRate, reportLocation, reportPhotos}) {
  if (actor.role !== 'manager') fail('این عملیات فقط برای مدیر مجاز است.',403,'FORBIDDEN');
  const collection = payload.collection;
  if (!Object.hasOwn(fields,collection)) fail('بخش مدیریت معتبر نیست.');
  const project = collection === 'tasks' ? list(state.projects).find(row => row.id === payload.projectId) : null;
  const row = (collection === 'tasks' ? list(project?.tasks) : list(state[collection])).find(row => row.id === payload.id);
  if (!row) fail('رکورد یافت نشد.',404,'NOT_FOUND');
  const at = new Date().toISOString();
  const text = (value,label,max = 4000,optional = false) => {
    if (optional && (value == null || value === '')) return '';
    if (typeof value !== 'string' || (!optional && !value.trim()) || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) fail(`${label} معتبر نیست.`);
    return value.trim();
  };
  const money = (value,label,min = 0) => {if(!Number.isSafeInteger(value)||value<min)fail(`${label} باید عدد صحیح معتبر باشد.`);return value;};
  const quantity = (value,label = 'مقدار') => {if(typeof value!=='number'||!Number.isFinite(value)||value<0||!Number.isSafeInteger(Math.round(value*1000))||Math.abs(value*1000-Math.round(value*1000))>0.000001)fail(`${label} باید نامنفی و حداکثر سه رقم اعشار باشد.`);return value;};
  const date = value => {if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value)||!Number.isFinite(Date.parse(value+'T00:00:00Z'))||new Date(value+'T00:00:00Z').toISOString().slice(0,10)!==value)fail('تاریخ معتبر نیست.');return value;};
  const bool = value => {if(typeof value!=='boolean')fail('مقدار بله یا خیر معتبر نیست.');return value;};
  const choose = (value,values,label) => {if(!values.includes(value))fail(`${label} معتبر نیست.`);return value;};
  const parent = collection === 'projects' ? row : project || (row.projectId ? list(state.projects).find(item=>item.id===row.projectId) : null);
  const reason = text(payload.reason,'دلیل تغییر',1000,true);
  const before = select(row,fields[collection]);
  const version = payload.version ?? payload.changes?.version;
  if (version !== undefined && row.version !== version) fail('رکورد هم‌زمان تغییر کرده است؛ آخرین نسخه را باز کنید.',409,'VERSION_CONFLICT');
  const archived = Boolean(row.archivedAt);
  const allowParent = collection === 'projects' || !parent?.archivedAt;
  if (!allowParent) fail('ابتدا پروژهٔ حذف‌شده را بازیابی کنید.',409,'PROJECT_ARCHIVED');
  const stockFor = material => {
    const stock = list(state.inventory).find(item=>item.id===material.inventoryId);
    if (!stock) fail('کالای مرتبط در انبار یافت نشد.',409,'STOCK_NOT_FOUND');
    if (stock.unit !== material.unit) fail('واحد مصرف با موجودی مرتبط یکسان نیست.',409,'STOCK_UNIT_MISMATCH');
    return stock;
  };
  const adjustStock = (stock,delta) => {
    const next = Math.round(stock.quantity*1000)+delta;
    if (!Number.isSafeInteger(next)||next<0) fail('موجودی انبار برای این تغییر کافی نیست.',409,'INSUFFICIENT_STOCK');
    stock.quantity=next/1000;
  };
  const invoiceFor = receipt => {
    const invoice=list(state.invoices).find(item=>item.id===receipt.invoiceId);
    if(!invoice||invoice.archivedAt)fail('ابتدا صورت‌حساب مرتبط را بازیابی کنید.',409,'INVOICE_ARCHIVED');
    return invoice;
  };
  const adjustPaid = (invoice,delta) => {
    const paid=invoice.paid+delta;
    if(!Number.isSafeInteger(paid)||paid<0||paid>invoice.amount)fail('این تغییر با مبلغ و ماندهٔ صورت‌حساب سازگار نیست.',409,'OVERPAYMENT');
    invoice.paid=paid;invoice.status=paid===invoice.amount?'paid':'issued';
  };
  const ensureNoOverlap = report => {
    if(report.status!=='approved')return;
    const clock=value=>Number(value.slice(0,2))*60+Number(value.slice(3));
    if(list(state.reports).some(other=>other.id!==report.id&&!other.archivedAt&&other.status==='approved'&&other.workerId===report.workerId&&other.date===report.date&&clock(report.start)<clock(other.end)&&clock(other.start)<clock(report.end)))fail('این بازه با گزارش تأییدشدهٔ دیگری هم‌پوشانی دارد.',409,'TIME_OVERLAP');
  };
  if (action === 'admin.record.update') {
    if(archived)fail('پیش از ویرایش، رکورد حذف‌شده را بازیابی کنید.',409,'RECORD_ARCHIVED');
    if(!object(payload.changes)||!Object.keys(payload.changes).length)fail('تغییرات معتبر نیست.');
    const changes={...payload.changes};delete changes.version;
    if(Object.keys(changes).some(key=>!editable[collection].includes(key)))fail('یکی از فیلدها در این بخش ویرایش‌پذیر نیست.');
    if(collection==='projects')run('project.update',{id:row.id,...changes});
    else if(collection==='tasks'){if(changes.assigneeId===row.assigneeId)delete changes.assigneeId;run('task.update',{projectId:project.id,id:row.id,version:version??row.version,...changes});}
    else if(collection==='reports'){
      if(!reason)fail('برای اصلاح گزارش کار، دلیل اصلاح را ثبت کنید.');
      if(version===undefined)fail('نسخهٔ گزارش را همراه درخواست اصلاح بفرستید.',409,'VERSION_CONFLICT');
      const nextWorkerId=changes.workerId??row.workerId;
      const nextProject=list(state.projects).find(project=>project.id===(changes.projectId??row.projectId));
      if(!nextProject||nextProject.archivedAt)fail('پروژهٔ فعال معتبر نیست.');
      const worker=list(state.users).find(person=>person.id===nextWorkerId);
      if(!worker)fail('نیروی گزارش یافت نشد.');
      if((nextWorkerId!==row.workerId||nextProject.id!==row.projectId)&&(worker.deletedAt||worker.role!=='worker'||!list(nextProject.memberIds).includes(worker.id)))fail('نیروی تازه باید عضو فعال پروژه باشد.');
      const nextDate=date(changes.date??row.date),start=changes.start??row.start,end=changes.end??row.end;
      const clock=value=>{if(typeof value!=='string'||!/^([01]\d|2[0-3]):[0-5]\d$/.test(value))fail('ساعت باید با قالب HH:MM ثبت شود.');return Number(value.slice(0,2))*60+Number(value.slice(3));};
      const elapsed=clock(end)-clock(start),breakMinutes=money(changes.breakMinutes??row.breakMinutes??0,'دقیقه استراحت');
      if(elapsed<=0||breakMinutes>=elapsed)fail('ساعت پایان و مدت استراحت معتبر نیست.');
      const moved=nextProject.id!==row.projectId;
      const photoIds=changes.photoIds!==undefined?reportPhotos(nextProject,changes.photoIds,actor,undefined):(moved?[]:row.photoIds||[]);
      const location=changes.location!==undefined?reportLocation(changes.location):(moved?null:row.location??null);
      const rate=nextWorkerId===row.workerId&&nextDate===row.date?row.rate:historicalRate(worker,nextDate);
      // An administrative amendment is a new live review; the previous signed dossier is never rewritten.
      Object.assign(row,{projectId:nextProject.id,workerId:nextWorkerId,date:nextDate,start,end,breakMinutes,minutes:elapsed-breakMinutes,description:text(changes.description??row.description,'شرح کار'),output:text(changes.output??row.output,'خروجی کار',4000,true),rate,laborCost:0,status:'submitted',version:row.version+1,location,photoIds});
      delete row.reviewNote;delete row.reviewedBy;
    }else if(collection==='materials'){
      if(!reason)fail('برای اصلاح مصرف کالا، دلیل اصلاح را ثبت کنید.');
      if(changes.name!==undefined)row.name=text(changes.name,'نام کالا',160);
      if(changes.unit!==undefined){const unit=text(changes.unit,'واحد کالا',40);if(row.inventoryId&&unit!==row.unit)fail('واحد مصرف مرتبط با انبار قابل تغییر نیست.',409,'STOCK_UNIT_MISMATCH');row.unit=unit;}
      if(changes.unitPrice!==undefined)row.unitPrice=money(changes.unitPrice,'بهای واحد');
      if(changes.date!==undefined){row.date=date(changes.date);if(list(row.returns).some(entry=>entry.date<row.date))fail('تاریخ مصرف نباید پس از برگشت‌های ثبت‌شده باشد.');}
      if(changes.clientVisible!==undefined)row.clientVisible=bool(changes.clientVisible);
      if(changes.quantity!==undefined){const next=quantity(changes.quantity);if(row.inventoryId){const stock=stockFor(row);adjustStock(stock,Math.round(row.quantity*1000)-Math.round(next*1000));}row.originalQuantity=(Math.round(next*1000)+Math.round((row.returnedQuantity||0)*1000))/1000;row.quantity=next;}
      if(!Number.isSafeInteger(Math.round(row.quantity*row.unitPrice)))fail('هزینهٔ مصرف از محدودهٔ مجاز بیشتر است.');
    }else if(collection==='inventory'){
      if(changes.name!==undefined)row.name=text(changes.name,'نام کالا',160);
      if(changes.unit!==undefined){const unit=text(changes.unit,'واحد کالا',40);if(unit!==row.unit&&list(state.materials).some(material=>material.inventoryId===row.id))fail('این واحد در سوابق مصرف استفاده شده است؛ برای واحد تازه کالای جداگانه بسازید.',409,'STOCK_UNIT_IN_USE');row.unit=unit;}
      if(changes.quantity!==undefined){if(!reason)fail('برای اصلاح موجودی، دلیل شمارش یا اصلاح را ثبت کنید.');row.quantity=quantity(changes.quantity,'موجودی');}
      if(changes.minQuantity!==undefined)row.minQuantity=quantity(changes.minQuantity,'حداقل موجودی');
      if(changes.unitPrice!==undefined)row.unitPrice=money(changes.unitPrice,'بهای واحد');
    }else if(collection==='invoices'){
      if(changes.title!==undefined)row.title=text(changes.title,'عنوان صورت‌حساب',200);
      if(changes.dueDate!==undefined)row.dueDate=date(changes.dueDate);
      if(changes.amount!==undefined){if(!reason)fail('برای اصلاح مبلغ صورت‌حساب، دلیل اصلاح را ثبت کنید.');const amount=money(changes.amount,'مبلغ صورت‌حساب',1);if(amount<row.paid)fail('مبلغ صورت‌حساب نمی‌تواند از دریافتی فعال کمتر باشد.',409,'OVERPAYMENT');row.amount=amount;row.status=row.paid===amount?'paid':'issued';}
    }else if(collection==='receipts'){
      if(!reason)fail('برای اصلاح رسید، دلیل اصلاح را ثبت کنید.');
      const invoice=invoiceFor(row);
      if(changes.amount!==undefined){const amount=money(changes.amount,'مبلغ دریافت',1);adjustPaid(invoice,amount-row.amount);row.amount=amount;}
      if(changes.reference!==undefined){const reference=text(changes.reference,'شماره پیگیری',120);if(list(state.receipts).some(receipt=>receipt.id!==row.id&&receipt.reference===reference))fail('این شماره پیگیری قبلاً ثبت شده است.',409,'DUPLICATE_REFERENCE');row.reference=reference;}
    }else if(collection==='messages'){
      if(changes.text!==undefined)row.text=text(changes.text,'متن پیام');
      if(changes.internal!==undefined)row.internal=bool(changes.internal);
    }else if(collection==='tickets'){
      if(changes.subject!==undefined)row.subject=text(changes.subject,'موضوع',200);
      if(changes.description!==undefined)row.description=text(changes.description,'شرح درخواست',12000);
      if(changes.priority!==undefined)row.priority=choose(changes.priority,['normal','high'],'اولویت');
      if(changes.status!==undefined)row.status=choose(changes.status,['open','in_progress','resolved'],'وضعیت');
    }
  }else if(action==='admin.record.archive'){
    if(archived)return {id:row.id,collection,archived:true};
    if(!reason)fail('دلیل حذف را ثبت کنید.');
    if(collection==='invoices'&&list(state.receipts).some(receipt=>receipt.invoiceId===row.id&&!receipt.archivedAt))fail('پیش از حذف صورت‌حساب، رسیدهای فعال آن را حذف کنید؛ دریافتی‌ها جداگانه نگه‌داری می‌شوند.',409,'ACTIVE_RECEIPTS');
    if(collection==='receipts')adjustPaid(invoiceFor(row),-row.amount);
    if(collection==='materials'&&row.inventoryId)adjustStock(stockFor(row),Math.round(row.quantity*1000));
    row.archivedAt=at;row.archivedBy=actor.id;row.archiveReason=reason;
    if(collection==='tasks'||collection==='reports')row.version=(row.version||0)+1;
  }else if(action==='admin.record.restore'){
    if(!archived)return {id:row.id,collection,archived:false};
    if(collection==='receipts')adjustPaid(invoiceFor(row),row.amount);
    if(collection==='materials'&&row.inventoryId){const stock=stockFor(row);if(stock.archivedAt)fail('ابتدا کالای انبار را بازیابی کنید.',409,'STOCK_ARCHIVED');adjustStock(stock,-Math.round(row.quantity*1000));}
    if(collection==='reports')ensureNoOverlap(row);
    delete row.archivedAt;delete row.archivedBy;delete row.archiveReason;
    if(collection==='tasks'||collection==='reports')row.version=(row.version||0)+1;
  }else fail('عملیات مدیریت شناخته‌شده نیست.',400,'UNKNOWN_ACTION');
  // Delegated actions commit a fresh clone into state: always resolve the current canonical object.
  const current = collection==='tasks' ? state.projects.find(item=>item.id===project.id).tasks.find(item=>item.id===row.id) : state[collection].find(item=>item.id===row.id);
  current.updatedAt=at;current.updatedBy=actor.id;
  const after=select(current,fields[collection]);
  const changedKeys=[...new Set([...Object.keys(before),...Object.keys(after)])].filter(key=>JSON.stringify(before[key])!==JSON.stringify(after[key]));
  current.adminHistory ||= [];
  if(current.adminHistory.length>=(action==='admin.record.restore'?1020:1000))fail('تاریخچهٔ اصلاحات این رکورد به حد مجاز رسیده است.',409,'ADMIN_HISTORY_LIMIT');
  const historyEntry={action,actorId:actor.id,at,reason,before:select(before,changedKeys),after:select(after,changedKeys)};
  if(new TextEncoder().encode(JSON.stringify(current.adminHistory.concat(historyEntry))).byteLength>1024*1024+(action==='admin.record.restore'?16*1024:0))fail('حجم تاریخچهٔ اصلاحات این رکورد به حد مجاز رسیده است.',409,'ADMIN_HISTORY_LIMIT');
  current.adminHistory.push(historyEntry);
  return {id:current.id,collection,archived:Boolean(current.archivedAt),...select(current,['version'])};
}
