import test from 'node:test';
import assert from 'node:assert/strict';
import {createSeedState,publicState,applyAction} from '../public/domain.mjs';
import {renderFinanceWorkspace,openCompanyExpense,openCompanyPettyCashEntry,openBusinessExpense,openFinanceReversal,openEmployeeAllowance,openPayrollPayment,financeCSV} from '../public/finance-workspace.mjs';

const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fields=values=>{const form=new FormData();for(const [key,value]of Object.entries(values))form.set(key,value);return form;};
const context=extra=>({e:escape,n:String,money:value=>`COST:${value}`,date:String,today:()=> '2026-11-06',icon:()=>'',projectName:String,personName:String,badge:()=>'',...extra});
const transaction=(reference,amount,extra={})=>fields({reference,amount:String(amount),date:'2026-11-06',method:'cash',note:'ثبت آزمایشی',...extra});
function fixture(){const seed=createSeedState();seed.users.push({id:'accountant',name:'حسابدار',role:'accountant'});return seed;}
function noDocument(t){const previous=globalThis.document;globalThis.document={querySelector:()=>null,querySelectorAll:()=>[]};t.after(()=>previous===undefined?delete globalThis.document:globalThis.document=previous);}

test('company petty cash works without a project or custodian and breakfast does not reduce employee wages',async t=>{
 noDocument(t);const seed=fixture();let modal;const ctx=context({modal:value=>modal=value,mutate:async(action,payload)=>applyAction(seed,'manager',action,payload)});
 const originalWages=publicState(seed,'manager').employeeFinance.accounts.find(row=>row.employeeId==='worker').netPayable;
 openCompanyPettyCashEntry(publicState(seed,'manager'),ctx);
 assert.match(modal.body,/صندوق ساختمان مرکزی/);assert(!modal.body.includes('name="projectId"'));
 await modal.onSubmit(transaction('company-issue',1000000,{employeeId:''}));
 let state=publicState(seed,'manager'),pool=state.employeeFinance.companyAccounts[0];
 assert.equal(pool.balance,1000000);assert.equal(pool.employeeId,undefined);
 const poolId=JSON.stringify(['central_office','company-main','']);
 openCompanyPettyCashEntry(state,ctx,{type:'expense',poolId});assert.match(modal.body,/حق صبحانه/);assert.match(modal.body,/max="1000000"/);
 await modal.onSubmit(transaction('company-breakfast',250000,{companyPool:poolId,category:'حق صبحانه'}));
 state=publicState(seed,'manager');openCompanyPettyCashEntry(state,ctx,{type:'return',poolId});
 assert.match(modal.body,/name="amount"[^>]*value="750000"/);
 await modal.onSubmit(transaction('company-return',750000,{companyPool:poolId}));
 state=publicState(seed,'manager');pool=state.employeeFinance.companyAccounts[0];assert.equal(pool.balance,0);assert.equal(pool.spent,250000);
 assert.equal(state.employeeFinance.accounts.find(row=>row.employeeId==='worker').netPayable,originalWages);
 assert.equal(state.employeeFinance.companySummary.totalOperatingExpenses,250000);
 const html=renderFinanceWorkspace(state,ctx);assert.match(html,/data-finance-tab="company"/);assert.match(html,/data-company-category-filter/);assert.match(html,/COST:250000/);assert.match(html,/ساختمان مرکزی شرکت/);
});

test('direct company cost records the central building and selected category independently of project payloads',async()=>{
 const seed=fixture();let modal,payload;const ctx=context({modal:value=>modal=value,mutate:async(action,value)=>{payload=value;return applyAction(seed,'manager',action,value);}});
 openCompanyExpense(publicState(seed,'manager'),ctx);assert.match(modal.title,/ساختمان مرکزی/);
 for(const label of ['حق صبحانه','آب، برق و گاز','اجاره و شارژ ساختمان','لوازم و ملزومات اداری'])assert(modal.body.includes(label));
 assert(!modal.body.includes('name="projectId"'));
 await modal.onSubmit(transaction('central-electricity',800000,{category:'آب، برق و گاز',projectId:'p1'}));
 assert.equal(payload.scope,'company');assert.equal(payload.costCenter,'central_office');assert(!('projectId'in payload));
 const state=publicState(seed,'manager');assert.equal(state.employeeFinance.companySummary.directExpenses,800000);assert.equal(state.employeeFinance.projectAccounts.find(row=>row.projectId==='p1').directExpenses,0);
});

test('company custodian cash stays distinct from personal advances and project petty cash',async t=>{
 noDocument(t);const seed=fixture();let modal;const ctx=context({modal:value=>modal=value,mutate:async(action,payload)=>applyAction(seed,'manager',action,payload)});
 openCompanyPettyCashEntry(publicState(seed,'manager'),ctx,{type:'issue'});await modal.onSubmit(transaction('company-worker',300000,{employeeId:'worker'}));
 const state=publicState(seed,'manager'),pool=state.employeeFinance.companyAccounts[0];assert.equal(pool.employeeId,'worker');assert.equal(pool.balance,300000);assert.equal(state.employeeFinance.pettyAccounts.length,0);
 assert.equal(state.employeeFinance.accounts.find(row=>row.employeeId==='worker').advanceBalance,0);
 const poolId=JSON.stringify(['central_office','company-main','worker']);openCompanyPettyCashEntry(state,ctx,{type:'expense',poolId});
 await modal.onSubmit(transaction('company-worker-expense',50000,{companyPool:poolId,category:'ناهار و پذیرایی'}));
 assert.equal(publicState(seed,'manager').employeeFinance.companyAccounts[0].balance,250000);
});

test('delegated finance cannot open company forms or leak company entries through history and CSV',()=>{
 const seed=fixture();seed.users.find(row=>row.id==='worker').permissions={'finance.view':true,'finance.manage':true,'projects.prices':true};
 applyAction(seed,'manager','finance.expense.create',{scope:'company',costCenter:'central_office',amount:333777,date:'2026-11-06',method:'bank',reference:'company-secret',note:'COMPANY_PRIVATE',category:'حق صبحانه'});
 const state=publicState(seed,'worker');state.employeeFinance.entries.push({id:'injected-company',scope:'company',type:'expense',amount:333777,date:'2026-11-06',note:'COMPANY_PRIVATE'});
 state.employeeFinance.companyAccounts=[{balance:333777}];state.employeeFinance.companySummary={totalOperatingExpenses:333777};
 const html=renderFinanceWorkspace(state,context());assert(!html.includes('data-finance-tab="company"'));assert(!html.includes('COMPANY_PRIVATE'));assert(!html.includes('COST:333777'));assert(!financeCSV(state).includes('COMPANY_PRIVATE'));
 let opened=0;const ctx=context({modal:()=>opened++});openCompanyExpense(state,ctx);openCompanyPettyCashEntry(state,ctx);openFinanceReversal(state,ctx,'injected-company');assert.equal(opened,0);
});

test('read-only company accounting can inspect and export costs but cannot create or reverse them',()=>{
 const seed=fixture();seed.users.find(row=>row.id==='accountant').permissions={'finance.manage':false};
 applyAction(seed,'manager','finance.expense.create',{scope:'company',costCenter:'central_office',amount:50000,date:'2026-11-06',method:'cash',reference:'readonly-company',category:'حق صبحانه'});
 const state=publicState(seed,'accountant'),html=renderFinanceWorkspace(state,context());assert(html.includes('data-finance-tab="company"'));assert(html.includes('COST:50000'));
 assert(!html.includes('data-company-expense'));assert(!html.includes('data-company-petty='));assert.match(financeCSV(state),/ساختمان مرکزی شرکت/);
 let opened=0;const ctx=context({modal:()=>opened++});openCompanyExpense(state,ctx);openCompanyPettyCashEntry(state,ctx);assert.equal(opened,0);
});

test('general expense entrypoint gives delegated staff only project costs and never company scope',async()=>{
 const seed=fixture();seed.users.find(row=>row.id==='worker').permissions={'finance.view':true,'finance.manage':true,'projects.prices':true};
 const state=publicState(seed,'worker');let modal,payload;const ctx=context({modal:value=>modal=value,mutate:async(action,value)=>payload=value});
 openBusinessExpense(state,ctx);assert(modal);assert.match(modal.body,/name="projectId" required/);assert(!modal.body.includes('هزینهٔ عمومی شرکت'));
 assert.throws(()=>modal.onSubmit(transaction('delegated-empty',100000,{category:'ملزومات'})),/انتخاب پروژه/);
 await modal.onSubmit(transaction('delegated-project',100000,{category:'ملزومات',projectId:'p1'}));assert.equal(payload.projectId,'p1');assert(!('scope'in payload));
});

test('employee breakfast entitlement increases payable once and only payroll records the cash payment',async t=>{
 noDocument(t);const seed=fixture();let modal;const ctx=context({modal:value=>modal=value,mutate:async(action,payload)=>applyAction(seed,'manager',action,payload)});
 const before=publicState(seed,'manager').employeeFinance,workerBefore=before.accounts.find(row=>row.employeeId==='worker');
 openEmployeeAllowance(publicState(seed,'manager'),ctx,'worker');assert.match(modal.body,/این سند پرداخت نقدی نیست/);assert.match(modal.body,/حق صبحانه/);assert(!modal.body.includes('name="projectId"'));
 const benefit=transaction('breakfast-entitlement',100000,{employeeId:'worker',category:'حق صبحانه'});
 await modal.onSubmit(benefit);await modal.onSubmit(benefit);
 let state=publicState(seed,'manager'),account=state.employeeFinance.accounts.find(row=>row.employeeId==='worker');
 assert.equal(account.approvedAllowances,100000);assert.equal(account.availableToPay,workerBefore.availableToPay+100000);assert.equal(state.employeeFinance.summary.cashOut,before.summary.cashOut);assert.equal(seed.financeEntries.filter(row=>row.type==='allowance').length,1);
 const html=renderFinanceWorkspace(state,ctx);assert.match(html,/حق و مزایای ثبت‌شده/);assert.match(html,/COST:100000/);assert.match(html,/data-finance-allowance="worker"/);
 openPayrollPayment(state,ctx,'worker');await modal.onSubmit(transaction('settle-wages-benefits',account.availableToPay,{employeeId:'worker',advanceDeduction:0}));
 state=publicState(seed,'manager');account=state.employeeFinance.accounts.find(row=>row.employeeId==='worker');assert.equal(account.availableToPay,0);assert.equal(state.employeeFinance.summary.cashOut,before.summary.cashOut+workerBefore.availableToPay+100000);
});

test('benefit accrual controls stay closed for delegated finance and read-only accountants',()=>{
 const seed=fixture();seed.users.find(row=>row.id==='worker').permissions={'finance.view':true,'finance.manage':true,'projects.prices':true};seed.users.find(row=>row.id==='accountant').permissions={'finance.manage':false};
 for(const id of ['worker','accountant','customer']){const state=publicState(seed,id);let opened=0;const ctx=context({modal:()=>opened++});openEmployeeAllowance(state,ctx,'worker');assert.equal(opened,0);assert(!renderFinanceWorkspace(state,ctx).includes('data-finance-allowance'));}
});
