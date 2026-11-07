import {hasPermission,requirePermission} from './permissions.mjs';
/** Append-only, whole-toman cash and employee ledger. Funding is never counted as an expense. */
export const FINANCE_TYPES = Object.freeze({advance:'پرداخت مساعده',advance_repayment:'برگشت مساعده',allowance:'ثبت حق و مزایای همکار',payroll_payment:'پرداخت و تسویهٔ حقوق',petty_issue:'تحویل تنخواه',petty_expense:'هزینه از تنخواه',petty_return:'برگشت تنخواه',expense:'هزینهٔ مستقیم',reversal:'برگشت سند'});
export const COMPANY_EXPENSE_CATEGORIES = Object.freeze(['اجاره و شارژ ساختمان','آب، برق و گاز','اینترنت و تلفن','حق صبحانه','ناهار و پذیرایی','ایاب و ذهاب','لوازم و ملزومات اداری','تعمیر و نگهداری ساختمان','نظافت','حقوق و مزایا','سایر']);
export const ALLOWANCE_CATEGORIES = Object.freeze(['حق صبحانه','حق ناهار','ایاب و ذهاب','سایر مزایا']);
const staff=new Set(['manager','accountant','worker','warehouse']);
const rows=value=>Array.isArray(value)?value:[];
const copy=value=>structuredClone(value);
const visibleKeys=['id','type','employeeId','projectId','scope','costCenter','fundId','amount','advanceDeduction','date','reference','method','note','category','version','recordedBy','createdAt','reverseOf','reversingType','reason'];
function fail(message,status=400,code='INVALID_FINANCE'){const error=new Error(message);error.status=status;error.code=code;throw error;}
function text(value,label,max=1000,optional=false){if(optional&&(value===undefined||value===null||value===''))return '';if(typeof value!=='string'||!value.trim()||value.trim().length>max||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value))fail(`${label} معتبر نیست.`);return value.trim();}
function money(value,label='مبلغ',zero=false){if(!Number.isSafeInteger(value)||value<(zero?0:1))fail(`${label} باید عدد صحیح ${zero?'نامنفی':'مثبت'} به تومان باشد.`);return value;}
function checked(value){if(!Number.isSafeInteger(value))fail('جمع حساب از محدودهٔ مجاز بیشتر است.',409,'FINANCE_OVERFLOW');return value;}
function sum(list,key='amount'){return list.reduce((value,row)=>checked(value+money(row[key]??0,key,true)),0);}
function date(value){if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value)||!Number.isFinite(Date.parse(value+'T00:00:00Z'))||new Date(value+'T00:00:00Z').toISOString().slice(0,10)!==value)fail('تاریخ معتبر نیست.');return value;}
function requestId(value){if(value===undefined||value==='')return '';if(typeof value!=='string'||!/^[A-Za-z0-9_-]{8,120}$/.test(value))fail('شناسهٔ درخواست معتبر نیست.');return value;}
function actorFor(state,actor){const user=rows(state.users).find(row=>row.id===actor?.id&&!row.deletedAt&&row.role===actor.role);if(!user)fail('برای ادامه با حساب فعال وارد شوید.',403,'FORBIDDEN');return user;}
/** Older unassigned direct expenses already belonged to the company; preserve their original rows. */
export const isCompanyFinanceEntry=row=>row?.scope==='company'||(!row?.projectId&&(row?.type==='expense'||row?.type==='reversal'&&row?.reversingType==='expense'));
const companyReader=(state,user)=>['manager','accountant'].includes(user.role)&&hasPermission(user,'finance.view',state)&&hasPermission(user,'projects.prices',state);
const pettyKey=row=>JSON.stringify(isCompanyFinanceEntry(row)?['company',row.costCenter||'central_office',row.fundId||'company-main',row.employeeId||'']:['project',row.employeeId,row.projectId]);
function select(row){return Object.fromEntries(visibleKeys.filter(key=>row[key]!==undefined).map(key=>[key,copy(row[key])]));}
export function activeFinanceEntries(state){const all=rows(state.financeEntries),reversed=new Set(all.filter(row=>row.type==='reversal').map(row=>row.reverseOf));return all.filter(row=>row.type!=='reversal'&&!reversed.has(row.id));}
/** Used by both ledgers to prevent a payroll cash payment and stock deduction consuming the same wage. */
export function employeeFinanceAccount(state,employeeId){
  const entries=activeFinanceEntries(state).filter(row=>row.employeeId===employeeId),of=type=>entries.filter(row=>row.type===type);
  const approvedWages=sum(rows(state.reports).filter(row=>row.workerId===employeeId&&row.status==='approved'&&!row.archivedAt),'laborCost');
  const approvedAllowances=sum(of('allowance')),earnedTotal=checked(approvedWages+approvedAllowances);
  const stockCharges=sum(rows(state.personalStockIssues).filter(row=>row.employeeId===employeeId&&!row.archivedAt));
  const settlements=rows(state.personalStockSettlements).filter(row=>row.employeeId===employeeId&&!row.archivedAt);
  const stockSettled=sum(settlements),stockBalance=checked(stockCharges-stockSettled),stockPayrollDeductions=sum(settlements.filter(row=>row.method==='payroll'));
  const advanceIssued=sum(of('advance')),advanceRepaid=sum(of('advance_repayment')),advancePayrollDeductions=sum(of('payroll_payment'),'advanceDeduction');
  const advanceBalance=checked(advanceIssued-advanceRepaid-advancePayrollDeductions),payrollPaid=sum(of('payroll_payment'));
  const grossPayable=checked(earnedTotal-stockPayrollDeductions-advancePayrollDeductions-payrollPaid),netPayable=checked(grossPayable-advanceBalance-stockBalance);
  return {employeeId,approvedWages,approvedAllowances,earnedTotal,stockCharges,stockSettled,stockBalance,stockPayrollDeductions,advanceIssued,advanceRepaid,advancePayrollDeductions,advanceBalance,payrollPaid,grossPayable,netPayable,availableToPay:Math.max(0,netPayable)};
}
function pettyAccount(state,pool){const project=rows(state.projects).find(row=>row.id===pool.projectId),company=isCompanyFinanceEntry(pool),key=pettyKey(pool);const entries=activeFinanceEntries(state).filter(row=>row.type.startsWith('petty_')&&pettyKey(row)===key),of=type=>entries.filter(row=>row.type===type),issued=sum(of('petty_issue')),spent=sum(of('petty_expense')),returned=sum(of('petty_return'));return {...(company?{scope:'company',key,costCenter:pool.costCenter||'central_office',fundId:pool.fundId||'company-main',...(pool.employeeId?{employeeId:pool.employeeId}:{})}:{employeeId:pool.employeeId,projectId:pool.projectId,...(project?{projectName:project.name,projectCode:project.projectCode||'',projectArchived:Boolean(project.archivedAt)}:{})}),issued,spent,returned,balance:checked(issued-spent-returned)};}
function validateBalances(state){
  const entries=activeFinanceEntries(state);
  for(const employeeId of new Set(entries.map(row=>row.employeeId).filter(Boolean))){
    if(employeeFinanceAccount(state,employeeId).advanceBalance<0)fail('این تغییر، برگشت یا کسر مساعده را از اصل پرداخت بیشتر می‌کند.',409,'ADVANCE_BALANCE_CONFLICT');
    let balance=0;for(const row of entries.filter(row=>row.employeeId===employeeId).sort((a,b)=>a.date.localeCompare(b.date)||a.createdAt.localeCompare(b.createdAt))){
      balance=checked(balance+(row.type==='advance'?row.amount:row.type==='advance_repayment'?-row.amount:row.type==='payroll_payment'?-(row.advanceDeduction||0):0));
      if(balance<0)fail('تاریخ برگشت یا تسویهٔ مساعده پیش از تأمین آن است.',409,'ADVANCE_DATE_CONFLICT');
    }
  }
  const pools=new Map();for(const row of entries.filter(row=>row.type.startsWith('petty_')))pools.set(pettyKey(row),row);
  for(const pool of pools.values()){
    let balance=0;for(const row of entries.filter(row=>row.type.startsWith('petty_')&&pettyKey(row)===pettyKey(pool)).sort((a,b)=>a.date.localeCompare(b.date)||a.createdAt.localeCompare(b.createdAt))){
      balance=checked(balance+(row.type==='petty_issue'?row.amount:-row.amount));
      if(balance<0)fail('ماندهٔ تنخواه در تاریخ سند کافی نیست؛ ابتدا اسناد وابسته را اصلاح کنید.',409,'INSUFFICIENT_PETTY_CASH');
    }
  }
}
function safeEntry(state,row){const result=select(row);if(isCompanyFinanceEntry(row)){result.scope='company';result.costCenter=row.costCenter||'central_office';if(row.type.startsWith('petty_')||row.reversingType?.startsWith('petty_'))result.fundId=row.fundId||'company-main';}if(row.type!=='reversal'){const reversal=rows(state.financeEntries).find(entry=>entry.type==='reversal'&&entry.reverseOf===row.id);if(reversal){result.reversed=true;result.reversalId=reversal.id;}}return result;}
/** Mutates a cloned domain draft. The caller commits it atomically with the audit record. */
export function applyFinanceAction(state,actor,action,payload={}){
  if(!payload||typeof payload!=='object'||Array.isArray(payload))fail('ورودی عملیات مالی معتبر نیست.');
  const user=actorFor(state,actor);requirePermission(user,'finance.manage',state);requirePermission(user,'finance.view',state);requirePermission(user,'projects.prices',state);
  if(action==='finance.entry.reverse')requirePermission(user,'finance.reverse',state);
  if(state.financeEntries===undefined)state.financeEntries=[];
  if(!Array.isArray(state.financeEntries))fail('ساختار اسناد مالی معتبر نیست.',500,'INVALID_STATE');
  const types={'finance.advance.create':'advance','finance.advance.repay':'advance_repayment','finance.allowance.create':'allowance','finance.payroll.pay':'payroll_payment','finance.petty.issue':'petty_issue','finance.petty.expense':'petty_expense','finance.petty.return':'petty_return','finance.expense.create':'expense'};
  if(!types[action]&&action!=='finance.entry.reverse')fail('عملیات مالی شناخته‌شده نیست.',400,'UNKNOWN_ACTION');
  if(types[action]==='allowance'&&!companyReader(state,user))fail('ثبت حق و مزایا فقط برای مدیر و حسابدار مجاز است.',403,'FORBIDDEN');
  if(payload.scope!==undefined&&!['project','company'].includes(payload.scope))fail('بخش حسابداری معتبر نیست.');
  const company=payload.scope==='company'||(types[action]==='expense'&&!payload.projectId&&payload.scope!=='project');
  if(company){
    if(!companyReader(state,user))fail('حساب شرکت فقط برای مدیر و حسابدار مجاز است.',403,'FORBIDDEN');
    if(action!=='finance.entry.reverse'&&!['expense','petty_issue','petty_expense','petty_return'].includes(types[action]))fail('این عملیات برای حساب شرکت قابل ثبت نیست.');
    if(payload.projectId)fail('هزینه یا تنخواه شرکت به پروژه متصل نمی‌شود.');
    if(payload.costCenter!==undefined&&payload.costCenter!=='central_office')fail('مرکز هزینهٔ شرکت معتبر نیست.');
  }else if(payload.scope==='project'&&!payload.projectId)fail('پروژهٔ سند را انتخاب کنید.');
  const rid=requestId(payload.requestId),fingerprint=JSON.stringify({action,payload:Object.fromEntries(Object.entries(payload).filter(([key])=>key!=='requestId').sort(([a],[b])=>a.localeCompare(b)))});
  if(rid){const old=state.financeEntries.find(row=>row.recordedBy===user.id&&row.requestId===rid);if(old){if((isCompanyFinanceEntry(old)||old.type==='allowance'||old.reversingType==='allowance')&&!companyReader(state,user))fail('اصلاح حساب شرکت و حق و مزایا فقط برای مدیر و حسابدار مجاز است.',403,'FORBIDDEN');if(old.requestFingerprint!==fingerprint)fail('شناسهٔ درخواست قبلاً برای سند دیگری استفاده شده است.',409,'IDEMPOTENCY_CONFLICT');return safeEntry(state,old);}}
  const at=new Date().toISOString(),entry={id:'fin_'+crypto.randomUUID(),type:types[action],date:date(payload.date),version:1,recordedBy:user.id,createdAt:at,...(rid?{requestId:rid,requestFingerprint:fingerprint}:{})};
  if(action==='finance.entry.reverse'){
    requirePermission(user,'finance.manage',state);
    const original=state.financeEntries.find(row=>row.id===payload.id);if(!original)fail('سند مالی یافت نشد.',404,'NOT_FOUND');
    if(isCompanyFinanceEntry(original)&&!companyReader(state,user))fail('حساب شرکت فقط برای مدیر و حسابدار مجاز است.',403,'FORBIDDEN');
    if(original.type==='allowance'&&!companyReader(state,user))fail('اصلاح حق و مزایا فقط برای مدیر و حسابدار مجاز است.',403,'FORBIDDEN');
    if(original.projectId&&!['manager','accountant'].includes(user.role)){
      const project=rows(state.projects).find(row=>row.id===original.projectId);
      if(!project||(!(project.memberIds||[]).includes(user.id)&&project.createdBy!==user.id))fail('به اطلاعات مالی این پروژه دسترسی ندارید.',403,'FORBIDDEN');
    }
    if(payload.version!==original.version)fail('نسخهٔ سند تغییر کرده است؛ صفحه را تازه کنید.',409,'VERSION_CONFLICT');
    if(original.type==='reversal'||state.financeEntries.some(row=>row.type==='reversal'&&row.reverseOf===original.id))fail('این سند قبلاً برگشت خورده است.',409,'ENTRY_REVERSED');
    if(entry.date<original.date)fail('تاریخ برگشت نباید پیش از سند اصلی باشد.');
    Object.assign(entry,{type:'reversal',reverseOf:original.id,reversingType:original.type,amount:original.amount,reason:text(payload.reason,'دلیل برگشت سند'),...(original.employeeId?{employeeId:original.employeeId}:{}),...(original.projectId?{projectId:original.projectId}:{}),...(isCompanyFinanceEntry(original)?{scope:'company',costCenter:original.costCenter||'central_office',...(original.type.startsWith('petty_')?{fundId:original.fundId||'company-main'}:{})}:{})});
  }else{
    if(company){entry.scope='company';entry.costCenter='central_office';if(entry.type.startsWith('petty_')){entry.fundId=payload.fundId===undefined?'company-main':text(payload.fundId,'شناسهٔ صندوق تنخواه',64);if(!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(entry.fundId))fail('شناسهٔ صندوق تنخواه معتبر نیست.');}}
    else if(payload.scope==='project')entry.scope='project';
    entry.amount=money(payload.amount,'مبلغ',entry.type==='payroll_payment');entry.method=payload.method;
    if(!['cash','bank'].includes(entry.method))fail('روش پرداخت نقدی یا بانکی را مشخص کنید.');
    entry.reference=text(payload.reference,'شماره پیگیری یا شماره سند',120);entry.note=text(payload.note,'شرح سند',1000,true);
    if(state.financeEntries.some(row=>row.type!=='reversal'&&row.reference===entry.reference&&row.method===entry.method))fail('این شماره پیگیری قبلاً ثبت شده است؛ سند قبلی را بررسی کنید.',409,'DUPLICATE_REFERENCE');
    if(entry.type!=='expense'&&(!company||payload.employeeId)){
      entry.employeeId=text(payload.employeeId,'همکار',120);const employee=rows(state.users).find(row=>row.id===entry.employeeId);
      const funding=['advance','petty_issue','allowance'].includes(entry.type),hasHistory=state.financeEntries.some(row=>row.employeeId===entry.employeeId)||rows(state.reports).some(row=>row.workerId===entry.employeeId);
      if(!employee||(funding?(!staff.has(employee.role)||employee.deletedAt):(!staff.has(employee.role)&&!hasHistory)))fail('همکار سازمانی معتبر و فعال را انتخاب کنید.');
    }
    if(!company&&(entry.type.startsWith('petty_')||payload.projectId)){
      entry.projectId=text(payload.projectId,'پروژه',120);const project=rows(state.projects).find(row=>row.id===entry.projectId);
      if(project&&!['manager','accountant'].includes(user.role)&&!(project.memberIds||[]).includes(user.id)&&project.createdBy!==user.id)fail('به اطلاعات مالی این پروژه دسترسی ندارید.',403,'FORBIDDEN');
      if(!project||(project.archivedAt&&!['petty_expense','petty_return'].includes(entry.type)))fail('پروژهٔ معتبر و فعال را انتخاب کنید.',409,'PROJECT_ARCHIVED');
    }
    if(['petty_expense','expense','allowance'].includes(entry.type))entry.category=text(payload.category||(entry.type==='allowance'?'سایر مزایا':'سایر'),'دستهٔ هزینه',100);
    if(entry.type==='advance_repayment'&&entry.amount>employeeFinanceAccount(state,entry.employeeId).advanceBalance)fail('برگشت مساعده از ماندهٔ آن بیشتر است.',409,'ADVANCE_OVERPAYMENT');
    if(entry.type==='payroll_payment'){
      const account=employeeFinanceAccount(state,entry.employeeId);entry.advanceDeduction=money(payload.advanceDeduction??0,'مساعدهٔ منظورشده در تسویه',true);
      if(entry.amount===0&&entry.advanceDeduction===0)fail('مبلغ پرداخت یا مساعدهٔ تسویه‌شده باید مثبت باشد.');
      if(entry.advanceDeduction>account.advanceBalance)fail('مساعدهٔ تسویه‌شده از ماندهٔ مساعده بیشتر است.',409,'ADVANCE_OVERPAYMENT');
      // Outstanding stock and advances are reserved before paying cash. Applying an advance
      // moves it from outstanding to settled without deducting it from the net amount twice.
      if(entry.amount>account.availableToPay||checked(entry.amount+entry.advanceDeduction)>Math.max(0,checked(account.grossPayable-account.stockBalance)))fail('مبلغ تسویه از کارکرد تأییدشده پس از مساعده و بدهی انبار بیشتر است.',409,'INSUFFICIENT_PAYROLL');
      const futureAllowances=sum(activeFinanceEntries(state).filter(row=>row.type==='allowance'&&row.employeeId===entry.employeeId&&row.date>entry.date));
      if(futureAllowances&&checked(entry.amount+entry.advanceDeduction)>Math.max(0,checked(account.grossPayable-account.stockBalance-futureAllowances)))fail('حق و مزایای تاریخ‌های آینده هنوز قابل تسویه نیست.',409,'ALLOWANCE_DATE_CONFLICT');
    }
  }
  state.financeEntries.push(entry);validateBalances(state);
  if(entry.type==='reversal'&&entry.reversingType==='allowance'&&employeeFinanceAccount(state,entry.employeeId).grossPayable<0)fail('این حق و مزایا در تسویه مصرف شده است؛ ابتدا پرداخت یا کسر حقوق وابسته را اصلاح کنید.',409,'ALLOWANCE_IN_USE');
  return safeEntry(state,entry);
}
function materialCost(state,projectId){let total=0;for(const row of rows(state.materials).filter(row=>!row.archivedAt&&row.projectId===projectId)){const milli=Math.round(row.quantity*1000);if(!Number.isSafeInteger(milli)||milli<0)fail('مقدار هزینهٔ مصالح معتبر نیست.',500,'INVALID_STATE');const amount=(BigInt(money(row.unitPrice,'بهای واحد',true))*BigInt(milli)+500n)/1000n;if(amount>BigInt(Number.MAX_SAFE_INTEGER))fail('هزینه از محدودهٔ مجاز بیشتر است.',409,'FINANCE_OVERFLOW');total=checked(total+Number(amount));}return total;}
export function employeeFinanceSnapshot(state,actor){
  const user=rows(state.users).find(row=>row.id===actor?.id&&!row.deletedAt&&row.role===actor.role);if(!user||!staff.has(user.role))return {entries:[],accounts:[],pettyAccounts:[],projectAccounts:[],summary:{}};
  const all=hasPermission(user,'finance.view',state)&&hasPermission(user,'projects.prices',state),companyAllowed=companyReader(state,user),allowed=row=>isCompanyFinanceEntry(row)?companyAllowed:all||row.employeeId===user.id;
  const payrollRow=row=>row.type==='payroll_payment'||row.reversingType==='payroll_payment';
  const entries=rows(state.financeEntries).filter(row=>allowed(row)&&(all||!payrollRow(row))).map(row=>safeEntry(state,row)),active=activeFinanceEntries(state).filter(allowed);
  const ids=new Set([...rows(state.users).filter(row=>staff.has(row.role)&&(all||row.id===user.id)).map(row=>row.id),...active.map(row=>row.employeeId).filter(Boolean)]);
  const fullAccounts=[...ids].map(id=>employeeFinanceAccount(state,id));
  const accounts=all?fullAccounts:fullAccounts.map(row=>Object.fromEntries(['employeeId','advanceIssued','advanceRepaid','advanceBalance'].map(key=>[key,row[key]])));
  const pools=new Map();for(const row of active.filter(row=>row.type.startsWith('petty_')))pools.set(pettyKey(row),row);
  const pettyAccounts=[...pools.values()].filter(row=>!isCompanyFinanceEntry(row)).map(row=>pettyAccount(state,row));
  const companyAccounts=companyAllowed?[...pools.values()].filter(isCompanyFinanceEntry).map(row=>pettyAccount(state,row)):[];
  const projectAccounts=all?rows(state.projects).filter(project=>['manager','accountant'].includes(user.role)||(project.memberIds||[]).includes(user.id)||project.createdBy===user.id).map(project=>{const laborCost=sum(rows(state.reports).filter(row=>!row.archivedAt&&row.status==='approved'&&row.projectId===project.id),'laborCost'),materials=materialCost(state,project.id),pettyExpenses=sum(active.filter(row=>row.type==='petty_expense'&&row.projectId===project.id)),directExpenses=sum(active.filter(row=>row.type==='expense'&&row.projectId===project.id)),invoices=rows(state.invoices).filter(row=>!row.archivedAt&&row.projectId===project.id),invoiced=sum(invoices),received=sum(invoices,'paid');return {projectId:project.id,laborCost,materialCost:materials,pettyExpenses,directExpenses,totalCost:checked(laborCost+materials+pettyExpenses+directExpenses),invoiced,received,receivable:checked(invoiced-received)};}):[];
  if(!all)return {entries,accounts,pettyAccounts,projectAccounts:[],summary:{advanceBalance:sum(fullAccounts,'advanceBalance'),pettyBalance:sum(pettyAccounts,'balance')}};
  const allPetty=[...pettyAccounts,...companyAccounts],directExpenses=sum(active.filter(row=>row.type==='expense')),pettySpent=sum(allPetty,'spent');
  const cashOut=sum(active.filter(row=>['advance','payroll_payment','petty_issue','expense'].includes(row.type))),clientReceipts=sum(rows(state.receipts).filter(row=>!row.archivedAt)),stockRecoveries=sum(rows(state.personalStockSettlements).filter(row=>!row.archivedAt&&['cash','bank'].includes(row.method))),cashIn=checked(sum(active.filter(row=>['advance_repayment','petty_return'].includes(row.type)))+clientReceipts+stockRecoveries);
  const summary={approvedWages:sum(accounts,'approvedWages'),approvedAllowances:sum(accounts,'approvedAllowances'),earnedTotal:sum(accounts,'earnedTotal'),payrollPaid:sum(accounts,'payrollPaid'),advanceBalance:sum(accounts,'advanceBalance'),netPayable:accounts.reduce((value,row)=>checked(value+row.netPayable),0),availableToPay:sum(accounts,'availableToPay'),pettyIssued:sum(allPetty,'issued'),pettySpent,pettyReturned:sum(allPetty,'returned'),pettyBalance:sum(allPetty,'balance'),directExpenses,totalOperatingExpenses:checked(directExpenses+pettySpent),clientReceipts,stockRecoveries,cashIn,cashOut,netCashFlow:checked(cashIn-cashOut)};
  const result={entries,accounts,pettyAccounts,projectAccounts,summary};
  if(companyAllowed){
    const companyEntries=active.filter(isCompanyFinanceEntry),expenses=companyEntries.filter(row=>['expense','petty_expense'].includes(row.type)),categories=new Map();
    for(const row of expenses){const label=row.category||'سایر';categories.set(label,checked((categories.get(label)||0)+row.amount));}
    const companyCashOut=sum(companyEntries.filter(row=>['petty_issue','expense'].includes(row.type))),companyCashIn=sum(companyEntries.filter(row=>row.type==='petty_return'));
    result.companyAccounts=companyAccounts;
    result.companySummary={pettyIssued:sum(companyAccounts,'issued'),pettySpent:sum(companyAccounts,'spent'),pettyReturned:sum(companyAccounts,'returned'),pettyBalance:sum(companyAccounts,'balance'),directExpenses:sum(companyEntries.filter(row=>row.type==='expense')),totalOperatingExpenses:sum(expenses),cashOut:companyCashOut,cashIn:companyCashIn,netCashFlow:checked(companyCashIn-companyCashOut),expensesByCategory:[...categories].map(([category,amount])=>({category,amount})).sort((a,b)=>a.category.localeCompare(b.category,'fa'))};
  }
  return result;
}
