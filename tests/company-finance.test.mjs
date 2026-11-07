import test from 'node:test';
import assert from 'node:assert/strict';
import {applyAction,createSeedState,publicState} from '../public/domain.mjs';
import {employeeFinanceAccount,employeeFinanceSnapshot,COMPANY_EXPENSE_CATEGORIES} from '../public/finance-ledger.mjs';

function fixture(){const state=createSeedState();state.users.push({id:'accountant',role:'accountant',name:'حسابدار'});state.reports=[];state.materials=[];state.invoices=[];state.receipts=[];return state;}
let serial=0;
const payload=extra=>({scope:'company',amount:100,date:'2026-11-06',method:'cash',reference:'COMPANY-'+(++serial),note:'هزینه ساختمان مرکزی',...extra});
const post=(state,action,extra={},actor='manager')=>applyAction(state,actor,action,payload(extra));
const ledger=state=>employeeFinanceSnapshot(state,state.users.find(row=>row.id==='manager'));
function unchanged(state,fn,code){const before=structuredClone(state);assert.throws(fn,error=>!code||error.code===code);assert.deepEqual(state,before);}

test('the company has its own fund without inventing a user or project and funding is not an operating expense',()=>{
 const state=fixture(),users=structuredClone(state.users),projects=structuredClone(state.projects);
 post(state,'finance.petty.issue',{amount:1000});
 post(state,'finance.petty.expense',{amount:250,category:'حق صبحانه'});
 post(state,'finance.petty.return',{amount:100});
 post(state,'finance.expense.create',{amount:400,category:'اجاره و شارژ ساختمان'});
 const snapshot=ledger(state),fund=snapshot.companyAccounts[0];
 assert.equal(fund.scope,'company');assert.equal(fund.costCenter,'central_office');assert.equal(fund.fundId,'company-main');assert.equal(fund.employeeId,undefined);
 assert.equal(fund.issued,1000);assert.equal(fund.spent,250);assert.equal(fund.returned,100);assert.equal(fund.balance,650);
 assert.equal(snapshot.pettyAccounts.length,0);assert.equal(snapshot.companySummary.totalOperatingExpenses,650);assert.equal(snapshot.companySummary.cashOut,1400);assert.equal(snapshot.companySummary.cashIn,100);
 assert.equal(snapshot.summary.totalOperatingExpenses,650);assert.equal(snapshot.summary.pettyBalance,650);
 assert.deepEqual(state.users,users);assert.deepEqual(state.projects,projects);assert(COMPANY_EXPENSE_CATEGORIES.includes('حق صبحانه'));
 assert.deepEqual(snapshot.companySummary.expensesByCategory.find(row=>row.category==='حق صبحانه'),{category:'حق صبحانه',amount:250});
});

test('project funds, company custodians and named company funds cannot consume one another',()=>{
 const state=fixture();
 post(state,'finance.petty.issue',{amount:1000});
 post(state,'finance.petty.issue',{amount:500,employeeId:'worker'});
 post(state,'finance.petty.issue',{amount:300,fundId:'office-second'});
 post(state,'finance.petty.issue',{scope:'project',projectId:'p1',employeeId:'worker',amount:200});
 unchanged(state,()=>post(state,'finance.petty.expense',{employeeId:'worker',amount:501}),'INSUFFICIENT_PETTY_CASH');
 unchanged(state,()=>post(state,'finance.petty.expense',{fundId:'office-second',amount:301}),'INSUFFICIENT_PETTY_CASH');
 unchanged(state,()=>post(state,'finance.petty.expense',{scope:'project',projectId:'p1',employeeId:'worker',amount:201}),'INSUFFICIENT_PETTY_CASH');
 post(state,'finance.petty.expense',{amount:1000,category:'حق صبحانه'});
 assert.equal(ledger(state).companyAccounts.find(row=>!row.employeeId&&row.fundId==='company-main').balance,0);
 assert.equal(ledger(state).pettyAccounts[0].balance,200);
 assert.equal(ledger(state).companyAccounts.find(row=>row.employeeId==='worker').balance,500);
});

test('company benefits are operating expenses and never silently reduce employee wages or advances',()=>{
 const state=fixture(),before=employeeFinanceAccount(state,'worker');
 post(state,'finance.petty.issue',{employeeId:'worker',amount:500});
 post(state,'finance.petty.expense',{employeeId:'worker',amount:100,category:'حق صبحانه'});
 post(state,'finance.expense.create',{amount:50,category:'ناهار و پذیرایی'});
 assert.deepEqual(employeeFinanceAccount(state,'worker'),before);
 assert.equal(ledger(state).companySummary.totalOperatingExpenses,150);
});

test('company spend and return validate dated funds and reversals cannot strand dependent spending',()=>{
 const state=fixture(),issue=post(state,'finance.petty.issue',{amount:500,date:'2026-11-05'});
 unchanged(state,()=>post(state,'finance.petty.expense',{amount:1,date:'2026-11-04'}),'INSUFFICIENT_PETTY_CASH');
 const expense=post(state,'finance.petty.expense',{amount:200});
 unchanged(state,()=>post(state,'finance.entry.reverse',{id:issue.id,version:1,reason:'مبلغ اشتباه'}),'INSUFFICIENT_PETTY_CASH');
 post(state,'finance.entry.reverse',{id:expense.id,version:1,reason:'هزینه اشتباه'});
 assert.equal(ledger(state).companySummary.pettySpent,0);assert.equal(ledger(state).companyAccounts[0].balance,500);
 post(state,'finance.entry.reverse',{id:issue.id,version:1,reason:'برگشت وجه'});
 assert.equal(ledger(state).companySummary.pettyBalance,0);assert.equal(ledger(state).companySummary.cashOut,0);
 assert.equal(state.financeEntries.filter(row=>row.type==='reversal').length,2);
});

test('company totals and custodian assignments remain confidential from delegated staff and customers',()=>{
 const state=fixture();post(state,'finance.petty.issue',{employeeId:'worker',amount:700});post(state,'finance.expense.create',{amount:123,category:'حق صبحانه'});
 const worker=state.users.find(row=>row.id==='worker');worker.permissions={'finance.view':true,'projects.prices':true,'finance.manage':true,'finance.reverse':true};
 const snapshot=publicState(state,'worker').employeeFinance;
 assert.equal(snapshot.companyAccounts,undefined);assert.equal(snapshot.companySummary,undefined);assert.equal(snapshot.entries.filter(row=>row.scope==='company').length,0);assert.equal(snapshot.summary.cashOut,0);
 for(const actor of ['worker','customer'])unchanged(state,()=>post(state,'finance.petty.issue',{amount:1},actor),'FORBIDDEN');
 unchanged(state,()=>post(state,'finance.entry.reverse',{id:state.financeEntries[0].id,version:1,reason:'تغییر غیرمجاز'},'worker'),'FORBIDDEN');
 assert.equal(publicState(state,'customer').employeeFinance,undefined);
 assert.equal(publicState(state,'accountant').employeeFinance.companySummary.cashOut,823);
});

test('historical general expenses are classified in company accounts without rewriting stored documents',()=>{
 const state=fixture();state.financeEntries=[{id:'historic-company',type:'expense',amount:100,date:'2026-10-01',method:'cash',reference:'OLD-COMPANY',note:'قدیمی',category:'حق صبحانه',version:1,recordedBy:'manager',createdAt:'2026-10-01T00:00:00Z'}];
 const original=structuredClone(state.financeEntries[0]);
 assert.equal(ledger(state).entries[0].scope,'company');assert.equal(ledger(state).companySummary.directExpenses,100);assert.deepEqual(state.financeEntries[0],original);
 const worker=state.users.find(row=>row.id==='worker');worker.permissions={'finance.view':true,'projects.prices':true};
 assert.equal(publicState(state,'worker').employeeFinance.entries.length,0);
 post(state,'finance.entry.reverse',{id:original.id,version:1,reason:'اصلاح هزینه قدیمی'});
 assert.equal(ledger(state).companySummary.directExpenses,0);assert.deepEqual(state.financeEntries[0],original);
});

test('company documents preserve idempotency and reject invalid scope, cost center, custodian and whole-toman amounts',()=>{
 const state=fixture(),input=payload({amount:500,requestId:'company-request-001'});
 const issue=applyAction(state,'manager','finance.petty.issue',input);assert.equal(applyAction(state,'manager','finance.petty.issue',input).id,issue.id);assert.equal(state.financeEntries.length,1);
 unchanged(state,()=>applyAction(state,'manager','finance.petty.issue',{...input,amount:501}),'IDEMPOTENCY_CONFLICT');
 for(const extra of [{scope:'invalid'},{scope:'company',projectId:'p1'},{costCenter:'other-office'},{employeeId:'customer'},{fundId:'../../escape'},{amount:1.5}])unchanged(state,()=>post(state,'finance.petty.issue',extra));
 unchanged(state,()=>post(state,'finance.advance.create',{employeeId:'worker'}));
});
