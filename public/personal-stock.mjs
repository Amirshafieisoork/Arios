import { employeeFinanceAccount } from './finance-ledger.mjs';
/** Personal inventory charges are a separate employee ledger; project wages and signed reports stay immutable. */
const rows=value=>Array.isArray(value)?value:[];
const clone=value=>structuredClone(value);
const staffRoles=new Set(['manager','worker','warehouse','accountant']);
const issueKeys=['id','employeeId','inventoryId','name','unit','unitPrice','quantity','returnedQuantity','netQuantity','amount','date','note','version','createdAt','recordedBy','returns','archivedAt','archivedBy','archiveReason','updatedAt'];
const settlementKeys=['id','employeeId','amount','method','date','reference','note','version','createdAt','recordedBy','archivedAt','archivedBy','archiveReason','updatedAt'];
const select=(row,keys)=>Object.fromEntries(keys.filter(key=>row[key]!==undefined).map(key=>[key,clone(row[key])]));
const safeIssue=row=>({...select(row,issueKeys),returns:rows(row.returns).map(entry=>select(entry,['id','quantity','amount','date','note','createdAt','recordedBy']))});
const safeSettlement=row=>select(row,settlementKeys);
function fail(message,status=400,code='INVALID_PERSONAL_STOCK'){const error=new Error(message);error.status=status;error.code=code;throw error;}
function text(value,label,max=1000,optional=false){if(optional&&(value===undefined||value===null||value===''))return '';if(typeof value!=='string'||!value.trim()||value.trim().length>max||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value))fail(`${label} معتبر نیست.`);return value.trim();}
function quantity(value,label='مقدار',allowZero=false){if(typeof value!=='number'||!Number.isFinite(value)||value<(allowZero?0:0.001)||!Number.isSafeInteger(Math.round(value*1000))||Math.abs(value*1000-Math.round(value*1000))>0.000001)fail(`${label} باید ${allowZero?'نامنفی':'مثبت'} و حداکثر سه رقم اعشار باشد.`);return Math.round(value*1000);}
function money(value,label='مبلغ',allowZero=false){if(!Number.isSafeInteger(value)||value<(allowZero?0:1))fail(`${label} باید عدد صحیح ${allowZero?'نامنفی':'مثبت'} به تومان باشد.`);return value;}
function date(value){if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value)||!Number.isFinite(Date.parse(value+'T00:00:00Z'))||new Date(value+'T00:00:00Z').toISOString().slice(0,10)!==value)fail('تاریخ معتبر نیست.');return value;}
function freshActor(state,actor){const user=rows(state.users).find(user=>user.id===actor?.id&&!user.deletedAt&&user.role===actor.role);if(!user)fail('برای ادامه با حساب فعال وارد شوید.',403,'FORBIDDEN');return user;}
function allow(user,roles){if(!roles.includes(user.role))fail('این عملیات برای نقش شما مجاز نیست.',403,'FORBIDDEN');}
function find(list,id,label){const value=list.find(row=>row.id===id);if(!value)fail(`${label} یافت نشد.`,404,'NOT_FOUND');return value;}
function exactAmount(unitPrice,milli){const value=(BigInt(unitPrice)*BigInt(milli)+500n)/1000n;if(value>BigInt(Number.MAX_SAFE_INTEGER))fail('مبلغ از محدودهٔ مجاز بیشتر است.');return Number(value);}
function sum(list,key){let value=0;for(const row of list){value+=row[key]||0;if(!Number.isSafeInteger(value))fail('جمع حساب از محدودهٔ مجاز بیشتر است.');}return value;}
function requestId(value){if(value===undefined||value==='')return '';if(typeof value!=='string'||!/[A-Za-z0-9]/.test(value)||!/^[A-Za-z0-9_-]{8,120}$/.test(value))fail('شناسهٔ درخواست معتبر نیست.');return value;}
const version=(row,value)=>{if(!Number.isSafeInteger(value)||value!==row.version)fail('این ثبت هم‌زمان تغییر کرده است؛ آخرین نسخه را باز کنید.',409,'VERSION_CONFLICT');};
function stockFor(state,issue,{active=false}={}){const stock=find(rows(state.inventory),issue.inventoryId,'کالای مرتبط در انبار');if(stock.unit!==issue.unit)fail('واحد کالا با سابقهٔ برداشت شخصی سازگار نیست.',409,'STOCK_UNIT_MISMATCH');if(active&&stock.archivedAt)fail('پیش از برداشت، کالای حذف‌شده را بازیابی کنید.',409,'STOCK_ARCHIVED');return stock;}
function stockChange(stock,delta){const next=quantity(stock.quantity,'موجودی انبار',true)+delta;if(!Number.isSafeInteger(next)||next<0)fail('موجودی انبار کافی نیست.',409,'INSUFFICIENT_STOCK');stock.quantity=next/1000;}
function balanceFor(state,employeeId){const issues=rows(state.personalStockIssues).filter(row=>row.employeeId===employeeId&&!row.archivedAt),settlements=rows(state.personalStockSettlements).filter(row=>row.employeeId===employeeId&&!row.archivedAt);const totalCharges=sum(issues,'amount'),totalSettled=sum(settlements,'amount'),balance=totalCharges-totalSettled;if(!Number.isSafeInteger(balance))fail('ماندهٔ حساب از محدودهٔ مجاز بیشتر است.');return {employeeId,totalCharges,totalSettled,balance,outstandingDebt:Math.max(0,balance),credit:Math.max(0,-balance)};}
function wagesFor(state,employeeId){const approvedWages=sum(rows(state.reports).filter(report=>report.workerId===employeeId&&report.status==='approved'&&!report.archivedAt),'laborCost'),payrollDeductions=sum(rows(state.personalStockSettlements).filter(row=>row.employeeId===employeeId&&row.method==='payroll'&&!row.archivedAt),'amount');const account=employeeFinanceAccount(state,employeeId);return {approvedWages,payrollDeductions,payrollPaid:account.payrollPaid,advancePayrollDeductions:account.advancePayrollDeductions,advanceBalance:account.advanceBalance};}
function checkedAccount(state,employeeId){const balance=balanceFor(state,employeeId),wages=wagesFor(state,employeeId),projectedNetWages=wages.approvedWages-wages.payrollDeductions-wages.payrollPaid-wages.advancePayrollDeductions-wages.advanceBalance-balance.balance;if(!Number.isSafeInteger(projectedNetWages))fail('خالص کارکرد از محدودهٔ مجاز بیشتر است.');return {...balance,...wages,projectedNetWages};}
function replay(list,user,rid,fingerprint,safe){if(!rid)return null;const old=list.find(row=>row.recordedBy===user.id&&row.requestId===rid);if(!old)return null;if(old.requestFingerprint!==fingerprint)fail('این شناسه برای درخواست دیگری استفاده شده است.',409,'IDEMPOTENCY_CONFLICT');return safe(old);}
/** Called on an already-cloned domain draft. Any thrown error must abort the enclosing domain transaction. */
export function applyPersonalStockAction(state,actor,action,payload={}){
  if(!payload||typeof payload!=='object'||Array.isArray(payload))fail('ورودی عملیات معتبر نیست.');
  const user=freshActor(state,actor);if(!staffRoles.has(user.role))fail('این بخش برای حساب شما فعال نیست.',403,'FORBIDDEN');
  state.personalStockIssues ||= [];state.personalStockSettlements ||= [];
  if(!Array.isArray(state.personalStockIssues)||!Array.isArray(state.personalStockSettlements))fail('ساختار حساب همکاران معتبر نیست.',500,'INVALID_STATE');
  const at=new Date().toISOString(),rid=requestId(payload.requestId);
  if(action==='personalStock.issue'){
    allow(user,['manager','warehouse']);
    const employeeId=text(payload.employeeId,'همکار',120),inventoryId=text(payload.inventoryId,'کالای انبار',120),milli=quantity(payload.quantity),issuedDate=date(payload.date),note=text(payload.note,'توضیح',1000,true);
    const fingerprint=JSON.stringify({employeeId,inventoryId,quantity:milli,date:issuedDate,note,unitPrice:payload.unitPrice??null});
    const old=replay(state.personalStockIssues,user,rid,fingerprint,safeIssue);if(old)return old;
    const employee=find(rows(state.users),employeeId,'همکار');if(employee.deletedAt||!staffRoles.has(employee.role))fail('همکار باید حساب فعال سازمانی داشته باشد.');
    const stock=find(rows(state.inventory),inventoryId,'کالای انبار');if(stock.archivedAt)fail('کالای حذف‌شده را پیش از برداشت بازیابی کنید.',409,'STOCK_ARCHIVED');
    const unitPrice=money(payload.unitPrice??stock.unitPrice,'بهای واحد',true);
    if(user.role!=='manager'&&unitPrice!==stock.unitPrice)fail('تغییر بهای برداشت شخصی فقط برای مدیر مجاز است.',403,'PRICE_OVERRIDE_FORBIDDEN');
    const amount=exactAmount(unitPrice,milli);
    const issue={id:'psi_'+crypto.randomUUID(),employeeId,inventoryId,name:stock.name,unit:stock.unit,unitPrice,quantity:milli/1000,returnedQuantity:0,netQuantity:milli/1000,amount,date:issuedDate,note,version:1,createdAt:at,recordedBy:user.id,returns:[],...(rid?{requestId:rid,requestFingerprint:fingerprint}:{})};
    stockChange(stock,-milli);state.personalStockIssues.push(issue);checkedAccount(state,employeeId);return safeIssue(issue);
  }
  if(action==='personalStock.settle'){
    allow(user,['manager','accountant']);
    const employeeId=text(payload.employeeId,'همکار',120),amount=money(payload.amount),settledDate=date(payload.date),reference=text(payload.reference,'شناسهٔ تسویه',120),note=text(payload.note,'توضیح',1000,true),method=payload.method;
    if(!['payroll','cash','bank'].includes(method))fail('روش تسویه معتبر نیست.');
    const fingerprint=JSON.stringify({employeeId,amount,date:settledDate,reference,note,method});
    const old=replay(state.personalStockSettlements,user,rid,fingerprint,safeSettlement);if(old)return old;
    const employee=find(rows(state.users),employeeId,'همکار');if(!staffRoles.has(employee.role)&&!state.personalStockIssues.some(issue=>issue.employeeId===employeeId))fail('حساب همکار معتبر نیست.');
    if(state.personalStockSettlements.some(row=>row.reference===reference&&row.method===method&&(method!=='payroll'||row.employeeId===employeeId)))fail('این شناسهٔ تسویه قبلاً ثبت شده است؛ ثبت قبلی را بررسی کنید.',409,'DUPLICATE_REFERENCE');
    if(amount>balanceFor(state,employeeId).balance)fail('مبلغ تسویه از بدهی باقی‌مانده بیشتر است.',409,'OVERPAYMENT');
    if(method==='payroll'){const wage=wagesFor(state,employeeId);if(amount>Math.max(0,wage.approvedWages-wage.payrollDeductions-wage.payrollPaid-wage.advancePayrollDeductions))fail('کارکرد تأییدشدهٔ کافی برای این کسر حقوق وجود ندارد.',409,'INSUFFICIENT_APPROVED_WAGES');}
    const settlement={id:'pss_'+crypto.randomUUID(),employeeId,amount,method,date:settledDate,reference,note,version:1,createdAt:at,recordedBy:user.id,...(rid?{requestId:rid,requestFingerprint:fingerprint}:{})};state.personalStockSettlements.push(settlement);checkedAccount(state,employeeId);return safeSettlement(settlement);
  }
  if(action==='personalStock.return'){
    allow(user,['manager','warehouse']);const issue=find(state.personalStockIssues,payload.id,'برداشت شخصی'),milli=quantity(payload.quantity),returnedDate=date(payload.date),note=text(payload.note,'توضیح برگشت',1000,true);
    const fingerprint=JSON.stringify({id:issue.id,quantity:milli,date:returnedDate,note,version:payload.version});
    const old=replay(rows(issue.returns),user,rid,fingerprint,entry=>safeIssue(issue));if(old)return old;
    if(issue.archivedAt)fail('ابتدا برداشت حذف‌شده را بازیابی کنید.',409,'RECORD_ARCHIVED');version(issue,payload.version);
    if(returnedDate<issue.date)fail('تاریخ برگشت نباید پیش از برداشت باشد.');
    const currentMilli=quantity(issue.netQuantity,'ماندهٔ کالا',true);if(milli>currentMilli)fail('مقدار برگشت از ماندهٔ برداشت بیشتر است.',409,'RETURN_EXCEEDS_ISSUED');
    const nextMilli=currentMilli-milli,nextAmount=exactAmount(issue.unitPrice,nextMilli),refund=issue.amount-nextAmount,stock=stockFor(state,issue);
    const entry={id:'psr_'+crypto.randomUUID(),quantity:milli/1000,amount:refund,date:returnedDate,note,createdAt:at,recordedBy:user.id,...(rid?{requestId:rid,requestFingerprint:fingerprint}:{})};
    if(rows(issue.returns).length>=1000)fail('تعداد برگشت‌های این برداشت به سقف مجاز رسیده است.',409,'RETURN_LIMIT');
    stockChange(stock,milli);issue.returnedQuantity=(quantity(issue.returnedQuantity,'مقدار برگشتی',true)+milli)/1000;issue.netQuantity=nextMilli/1000;issue.amount=nextAmount;issue.returns.push(entry);issue.version++;issue.updatedAt=at;checkedAccount(state,issue.employeeId);return safeIssue(issue);
  }
  const settlementAction=action.startsWith('personalStock.settlement.');
  if(['personalStock.archive','personalStock.restore','personalStock.settlement.archive','personalStock.settlement.restore'].includes(action)){
    allow(user,['manager']);const collection=settlementAction?state.personalStockSettlements:state.personalStockIssues,row=find(collection,payload.id,settlementAction?'تسویه':'برداشت شخصی'),restore=action.endsWith('.restore'),reason=text(payload.reason,'دلیل اصلاح',1000);
    if(restore?!row.archivedAt:Boolean(row.archivedAt))return settlementAction?safeSettlement(row):safeIssue(row);
    version(row,payload.version);
    if(!settlementAction){const stock=stockFor(state,row,{active:restore});stockChange(stock,(restore?-1:1)*quantity(row.netQuantity,'ماندهٔ برداشت',true));}
    if(settlementAction&&restore){if(row.amount>balanceFor(state,row.employeeId).balance)fail('تسویهٔ بازیابی‌شده از بدهی باقی‌مانده بیشتر است.',409,'OVERPAYMENT');if(row.method==='payroll'){const wage=wagesFor(state,row.employeeId);if(row.amount>Math.max(0,wage.approvedWages-wage.payrollDeductions-wage.payrollPaid-wage.advancePayrollDeductions))fail('کارکرد تأییدشده برای بازیابی کسر حقوق کافی نیست.',409,'INSUFFICIENT_APPROVED_WAGES');}}
    row.history ||= [];if(row.history.length>=(restore?1020:1000))fail('تاریخچهٔ اصلاحات این ثبت به سقف مجاز رسیده است.',409,'HISTORY_LIMIT');
    row.history.push({action,reason,at,actorId:user.id});
    if(restore){delete row.archivedAt;delete row.archivedBy;delete row.archiveReason;}else{row.archivedAt=at;row.archivedBy=user.id;row.archiveReason=reason;}row.version++;row.updatedAt=at;checkedAccount(state,row.employeeId);return settlementAction?safeSettlement(row):safeIssue(row);
  }
  fail('عملیات حساب شخصی شناخته‌شده نیست.',400,'UNKNOWN_ACTION');
}
/** Allowlisted employee balances; no wage/rate information is disclosed to warehouse or colleagues. */
export function personalStockSnapshot(state,actor){
  const user=rows(state.users).find(row=>row.id===actor?.id&&!row.deletedAt&&row.role===actor.role);
  if(!user||!staffRoles.has(user.role))return {issues:[],settlements:[],accounts:[]};
  const all=['manager','accountant','warehouse'].includes(user.role),financial=['manager','accountant'].includes(user.role),allowed=id=>all||id===user.id;
  const issues=rows(state.personalStockIssues).filter(row=>allowed(row.employeeId)),settlements=rows(state.personalStockSettlements).filter(row=>allowed(row.employeeId));
  const employeeIds=new Set([...rows(state.users).filter(row=>staffRoles.has(row.role)&&(all||row.id===user.id)).map(row=>row.id),...issues.map(row=>row.employeeId),...settlements.map(row=>row.employeeId)]);
  return {issues:issues.map(safeIssue),settlements:user.role==='warehouse'?[]:settlements.map(safeSettlement),accounts:[...employeeIds].map(employeeId=>financial?checkedAccount(state,employeeId):balanceFor(state,employeeId))};
}
