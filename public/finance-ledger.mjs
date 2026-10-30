/** Append-only, whole-toman cash and employee ledger. Funding is never counted as an expense. */
export const FINANCE_TYPES = Object.freeze({advance:'پرداخت مساعده',advance_repayment:'برگشت مساعده',payroll_payment:'پرداخت و تسویهٔ حقوق',petty_issue:'تحویل تنخواه',petty_expense:'هزینه از تنخواه',petty_return:'برگشت تنخواه',expense:'هزینهٔ مستقیم',reversal:'برگشت سند'});
const staff=new Set(['manager','accountant','worker','warehouse']);
const rows=value=>Array.isArray(value)?value:[];
const copy=value=>structuredClone(value);
const visibleKeys=['id','type','employeeId','projectId','amount','advanceDeduction','date','reference','method','note','category','version','recordedBy','createdAt','reverseOf','reversingType','reason'];
function fail(message,status=400,code='INVALID_FINANCE'){const error=new Error(message);error.status=status;error.code=code;throw error;}
function text(value,label,max=1000,optional=false){if(optional&&(value===undefined||value===null||value===''))return '';if(typeof value!=='string'||!value.trim()||value.trim().length>max||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value))fail(`${label} معتبر نیست.`);return value.trim();}
function money(value,label='مبلغ',zero=false){if(!Number.isSafeInteger(value)||value<(zero?0:1))fail(`${label} باید عدد صحیح ${zero?'نامنفی':'مثبت'} به تومان باشد.`);return value;}
function checked(value){if(!Number.isSafeInteger(value))fail('جمع حساب از محدودهٔ مجاز بیشتر است.',409,'FINANCE_OVERFLOW');return value;}
function sum(list,key='amount'){return list.reduce((value,row)=>checked(value+money(row[key]??0,key,true)),0);}
function date(value){if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value)||!Number.isFinite(Date.parse(value+'T00:00:00Z'))||new Date(value+'T00:00:00Z').toISOString().slice(0,10)!==value)fail('تاریخ معتبر نیست.');return value;}
function requestId(value){if(value===undefined||value==='')return '';if(typeof value!=='string'||!/^[A-Za-z0-9_-]{8,120}$/.test(value))fail('شناسهٔ درخواست معتبر نیست.');return value;}
function actorFor(state,actor){const user=rows(state.users).find(row=>row.id===actor?.id&&!row.deletedAt&&row.role===actor.role);if(!user)fail('برای ادامه با حساب فعال وارد شوید.',403,'FORBIDDEN');return user;}
function select(row){return Object.fromEntries(visibleKeys.filter(key=>row[key]!==undefined).map(key=>[key,copy(row[key])]));}
export function activeFinanceEntries(state){const all=rows(state.financeEntries),reversed=new Set(all.filter(row=>row.type==='reversal').map(row=>row.reverseOf));return all.filter(row=>row.type!=='reversal'&&!reversed.has(row.id));}
/** Used by both ledgers to prevent a payroll cash payment and stock deduction consuming the same wage. */
export function employeeFinanceAccount(state,employeeId){
  const entries=activeFinanceEntries(state).filter(row=>row.employeeId===employeeId),of=type=>entries.filter(row=>row.type===type);
  const approvedWages=sum(rows(state.reports).filter(row=>row.workerId===employeeId&&row.status==='approved'&&!row.archivedAt),'laborCost');
  const stockCharges=sum(rows(state.personalStockIssues).filter(row=>row.employeeId===employeeId&&!row.archivedAt));
  const settlements=rows(state.personalStockSettlements).filter(row=>row.employeeId===employeeId&&!row.archivedAt);
  const stockSettled=sum(settlements),stockBalance=checked(stockCharges-stockSettled),stockPayrollDeductions=sum(settlements.filter(row=>row.method==='payroll'));
  const advanceIssued=sum(of('advance')),advanceRepaid=sum(of('advance_repayment')),advancePayrollDeductions=sum(of('payroll_payment'),'advanceDeduction');
  const advanceBalance=checked(advanceIssued-advanceRepaid-advancePayrollDeductions),payrollPaid=sum(of('payroll_payment'));
  const grossPayable=checked(approvedWages-stockPayrollDeductions-advancePayrollDeductions-payrollPaid),netPayable=checked(grossPayable-advanceBalance-stockBalance);
  return {employeeId,approvedWages,stockCharges,stockSettled,stockBalance,stockPayrollDeductions,advanceIssued,advanceRepaid,advancePayrollDeductions,advanceBalance,payrollPaid,grossPayable,netPayable,availableToPay:Math.max(0,netPayable)};
}
function pettyAccount(state,employeeId,projectId){const project=rows(state.projects).find(row=>row.id===projectId);const entries=activeFinanceEntries(state).filter(row=>row.employeeId===employeeId&&row.projectId===projectId),of=type=>entries.filter(row=>row.type===type),issued=sum(of('petty_issue')),spent=sum(of('petty_expense')),returned=sum(of('petty_return'));return {employeeId,projectId,...(project?{projectName:project.name,projectCode:project.projectCode||'',projectArchived:Boolean(project.archivedAt)}:{}),issued,spent,returned,balance:checked(issued-spent-returned)};}
function validateBalances(state){
  const entries=activeFinanceEntries(state);
  for(const employeeId of new Set(entries.map(row=>row.employeeId).filter(Boolean))){
    if(employeeFinanceAccount(state,employeeId).advanceBalance<0)fail('این تغییر، برگشت یا کسر مساعده را از اصل پرداخت بیشتر می‌کند.',409,'ADVANCE_BALANCE_CONFLICT');
    let balance=0;for(const row of entries.filter(row=>row.employeeId===employeeId).sort((a,b)=>a.date.localeCompare(b.date)||a.createdAt.localeCompare(b.createdAt))){
      balance=checked(balance+(row.type==='advance'?row.amount:row.type==='advance_repayment'?-row.amount:row.type==='payroll_payment'?-(row.advanceDeduction||0):0));
      if(balance<0)fail('تاریخ برگشت یا تسویهٔ مساعده پیش از تأمین آن است.',409,'ADVANCE_DATE_CONFLICT');
    }
  }
  const pools=new Map();for(const row of entries.filter(row=>row.type.startsWith('petty_')))pools.set(JSON.stringify([row.employeeId,row.projectId]),row);
  for(const pool of pools.values()){
    let balance=0;for(const row of entries.filter(row=>row.employeeId===pool.employeeId&&row.projectId===pool.projectId&&row.type.startsWith('petty_')).sort((a,b)=>a.date.localeCompare(b.date)||a.createdAt.localeCompare(b.createdAt))){
      balance=checked(balance+(row.type==='petty_issue'?row.amount:-row.amount));
      if(balance<0)fail('ماندهٔ تنخواه در تاریخ سند کافی نیست؛ ابتدا اسناد وابسته را اصلاح کنید.',409,'INSUFFICIENT_PETTY_CASH');
    }
  }
}
function safeEntry(state,row){const result=select(row);if(row.type!=='reversal'){const reversal=rows(state.financeEntries).find(entry=>entry.type==='reversal'&&entry.reverseOf===row.id);if(reversal){result.reversed=true;result.reversalId=reversal.id;}}return result;}
/** Mutates a cloned domain draft. The caller commits it atomically with the audit record. */
export function applyFinanceAction(state,actor,action,payload={}){
  if(!payload||typeof payload!=='object'||Array.isArray(payload))fail('ورودی عملیات مالی معتبر نیست.');
  const user=actorFor(state,actor);if(!['manager','accountant'].includes(user.role))fail('ثبت مالی فقط برای مدیر و حسابدار مجاز است.',403,'FORBIDDEN');
  if(state.financeEntries===undefined)state.financeEntries=[];
  if(!Array.isArray(state.financeEntries))fail('ساختار اسناد مالی معتبر نیست.',500,'INVALID_STATE');
  const types={'finance.advance.create':'advance','finance.advance.repay':'advance_repayment','finance.payroll.pay':'payroll_payment','finance.petty.issue':'petty_issue','finance.petty.expense':'petty_expense','finance.petty.return':'petty_return','finance.expense.create':'expense'};
  if(!types[action]&&action!=='finance.entry.reverse')fail('عملیات مالی شناخته‌شده نیست.',400,'UNKNOWN_ACTION');
  const rid=requestId(payload.requestId),fingerprint=JSON.stringify({action,payload:Object.fromEntries(Object.entries(payload).filter(([key])=>key!=='requestId').sort(([a],[b])=>a.localeCompare(b)))});
  if(rid){const old=state.financeEntries.find(row=>row.recordedBy===user.id&&row.requestId===rid);if(old){if(old.requestFingerprint!==fingerprint)fail('شناسهٔ درخواست قبلاً برای سند دیگری استفاده شده است.',409,'IDEMPOTENCY_CONFLICT');return safeEntry(state,old);}}
  const at=new Date().toISOString(),entry={id:'fin_'+crypto.randomUUID(),type:types[action],date:date(payload.date),version:1,recordedBy:user.id,createdAt:at,...(rid?{requestId:rid,requestFingerprint:fingerprint}:{})};
  if(action==='finance.entry.reverse'){
    if(user.role!=='manager')fail('برگشت سند فقط برای مدیر مجاز است.',403,'FORBIDDEN');
    const original=state.financeEntries.find(row=>row.id===payload.id);if(!original)fail('سند مالی یافت نشد.',404,'NOT_FOUND');
    if(payload.version!==original.version)fail('نسخهٔ سند تغییر کرده است؛ صفحه را تازه کنید.',409,'VERSION_CONFLICT');
    if(original.type==='reversal'||state.financeEntries.some(row=>row.type==='reversal'&&row.reverseOf===original.id))fail('این سند قبلاً برگشت خورده است.',409,'ENTRY_REVERSED');
    if(entry.date<original.date)fail('تاریخ برگشت نباید پیش از سند اصلی باشد.');
    Object.assign(entry,{type:'reversal',reverseOf:original.id,reversingType:original.type,amount:original.amount,reason:text(payload.reason,'دلیل برگشت سند'),...(original.employeeId?{employeeId:original.employeeId}:{}),...(original.projectId?{projectId:original.projectId}:{})});
  }else{
    entry.amount=money(payload.amount,'مبلغ',entry.type==='payroll_payment');entry.method=payload.method;
    if(!['cash','bank'].includes(entry.method))fail('روش پرداخت نقدی یا بانکی را مشخص کنید.');
    entry.reference=text(payload.reference,'شماره پیگیری یا شماره سند',120);entry.note=text(payload.note,'شرح سند',1000,true);
    if(state.financeEntries.some(row=>row.type!=='reversal'&&row.reference===entry.reference&&row.method===entry.method))fail('این شماره پیگیری قبلاً ثبت شده است؛ سند قبلی را بررسی کنید.',409,'DUPLICATE_REFERENCE');
    if(entry.type!=='expense'){
      entry.employeeId=text(payload.employeeId,'همکار',120);const employee=rows(state.users).find(row=>row.id===entry.employeeId);
      const funding=['advance','petty_issue'].includes(entry.type),hasHistory=state.financeEntries.some(row=>row.employeeId===entry.employeeId)||rows(state.reports).some(row=>row.workerId===entry.employeeId);
      if(!employee||(funding?(!staff.has(employee.role)||employee.deletedAt):(!staff.has(employee.role)&&!hasHistory)))fail('همکار سازمانی معتبر و فعال را انتخاب کنید.');
    }
    if(entry.type.startsWith('petty_')||payload.projectId){
      entry.projectId=text(payload.projectId,'پروژه',120);const project=rows(state.projects).find(row=>row.id===entry.projectId);
      if(!project||(project.archivedAt&&!['petty_expense','petty_return'].includes(entry.type)))fail('پروژهٔ معتبر و فعال را انتخاب کنید.',409,'PROJECT_ARCHIVED');
    }
    if(['petty_expense','expense'].includes(entry.type))entry.category=text(payload.category||'سایر','دستهٔ هزینه',100);
    if(entry.type==='advance_repayment'&&entry.amount>employeeFinanceAccount(state,entry.employeeId).advanceBalance)fail('برگشت مساعده از ماندهٔ آن بیشتر است.',409,'ADVANCE_OVERPAYMENT');
    if(entry.type==='payroll_payment'){
      const account=employeeFinanceAccount(state,entry.employeeId);entry.advanceDeduction=money(payload.advanceDeduction??0,'مساعدهٔ منظورشده در تسویه',true);
      if(entry.amount===0&&entry.advanceDeduction===0)fail('مبلغ پرداخت یا مساعدهٔ تسویه‌شده باید مثبت باشد.');
      if(entry.advanceDeduction>account.advanceBalance)fail('مساعدهٔ تسویه‌شده از ماندهٔ مساعده بیشتر است.',409,'ADVANCE_OVERPAYMENT');
      // Outstanding stock and advances are reserved before paying cash. Applying an advance
      // moves it from outstanding to settled without deducting it from the net amount twice.
      if(entry.amount>account.availableToPay||checked(entry.amount+entry.advanceDeduction)>Math.max(0,checked(account.grossPayable-account.stockBalance)))fail('مبلغ تسویه از کارکرد تأییدشده پس از مساعده و بدهی انبار بیشتر است.',409,'INSUFFICIENT_PAYROLL');
    }
  }
  state.financeEntries.push(entry);validateBalances(state);return safeEntry(state,entry);
}
function materialCost(state,projectId){let total=0;for(const row of rows(state.materials).filter(row=>!row.archivedAt&&row.projectId===projectId)){const milli=Math.round(row.quantity*1000);if(!Number.isSafeInteger(milli)||milli<0)fail('مقدار هزینهٔ مصالح معتبر نیست.',500,'INVALID_STATE');const amount=(BigInt(money(row.unitPrice,'بهای واحد',true))*BigInt(milli)+500n)/1000n;if(amount>BigInt(Number.MAX_SAFE_INTEGER))fail('هزینه از محدودهٔ مجاز بیشتر است.',409,'FINANCE_OVERFLOW');total=checked(total+Number(amount));}return total;}
export function employeeFinanceSnapshot(state,actor){
  const user=rows(state.users).find(row=>row.id===actor?.id&&!row.deletedAt&&row.role===actor.role);if(!user||!staff.has(user.role))return {entries:[],accounts:[],pettyAccounts:[],projectAccounts:[],summary:{}};
  const all=['manager','accountant'].includes(user.role),allowed=row=>all||row.employeeId===user.id;
  const payrollRow=row=>row.type==='payroll_payment'||row.reversingType==='payroll_payment';
  const entries=rows(state.financeEntries).filter(row=>allowed(row)&&(all||!payrollRow(row))).map(row=>safeEntry(state,row)),active=activeFinanceEntries(state).filter(allowed);
  const ids=new Set([...rows(state.users).filter(row=>staff.has(row.role)&&(all||row.id===user.id)).map(row=>row.id),...active.map(row=>row.employeeId).filter(Boolean)]);
  const fullAccounts=[...ids].map(id=>employeeFinanceAccount(state,id));
  const accounts=all?fullAccounts:fullAccounts.map(row=>Object.fromEntries(['employeeId','advanceIssued','advanceRepaid','advanceBalance'].map(key=>[key,row[key]])));
  const pools=new Map();for(const row of active.filter(row=>row.type.startsWith('petty_')))pools.set(JSON.stringify([row.employeeId,row.projectId]),row);
  const pettyAccounts=[...pools.values()].map(row=>pettyAccount(state,row.employeeId,row.projectId));
  const projectAccounts=all?rows(state.projects).map(project=>{const laborCost=sum(rows(state.reports).filter(row=>!row.archivedAt&&row.status==='approved'&&row.projectId===project.id),'laborCost'),materials=materialCost(state,project.id),pettyExpenses=sum(active.filter(row=>row.type==='petty_expense'&&row.projectId===project.id)),directExpenses=sum(active.filter(row=>row.type==='expense'&&row.projectId===project.id)),invoices=rows(state.invoices).filter(row=>!row.archivedAt&&row.projectId===project.id),invoiced=sum(invoices),received=sum(invoices,'paid');return {projectId:project.id,laborCost,materialCost:materials,pettyExpenses,directExpenses,totalCost:checked(laborCost+materials+pettyExpenses+directExpenses),invoiced,received,receivable:checked(invoiced-received)};}):[];
  if(!all)return {entries,accounts,pettyAccounts,projectAccounts:[],summary:{advanceBalance:sum(fullAccounts,'advanceBalance'),pettyBalance:sum(pettyAccounts,'balance')}};
  const directExpenses=sum(active.filter(row=>row.type==='expense')),pettySpent=sum(pettyAccounts,'spent');
  const cashOut=sum(active.filter(row=>['advance','payroll_payment','petty_issue','expense'].includes(row.type))),clientReceipts=sum(rows(state.receipts).filter(row=>!row.archivedAt)),stockRecoveries=sum(rows(state.personalStockSettlements).filter(row=>!row.archivedAt&&['cash','bank'].includes(row.method))),cashIn=checked(sum(active.filter(row=>['advance_repayment','petty_return'].includes(row.type)))+clientReceipts+stockRecoveries);
  const summary={approvedWages:sum(accounts,'approvedWages'),payrollPaid:sum(accounts,'payrollPaid'),advanceBalance:sum(accounts,'advanceBalance'),netPayable:accounts.reduce((value,row)=>checked(value+row.netPayable),0),availableToPay:sum(accounts,'availableToPay'),pettyIssued:sum(pettyAccounts,'issued'),pettySpent,pettyReturned:sum(pettyAccounts,'returned'),pettyBalance:sum(pettyAccounts,'balance'),directExpenses,totalOperatingExpenses:checked(directExpenses+pettySpent),clientReceipts,stockRecoveries,cashIn,cashOut,netCashFlow:checked(cashIn-cashOut)};
  return {entries,accounts,pettyAccounts,projectAccounts,summary};
}
