import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {applyAction,createSeedState,publicState} from '../public/domain.mjs';
import {applyFinanceAction,employeeFinanceAccount,employeeFinanceSnapshot} from '../public/finance-ledger.mjs';

function fixture(){const state=createSeedState();state.users.push({id:'accountant',role:'accountant',name:'حسابدار'},{id:'warehouse',role:'warehouse',name:'انباردار'});state.materials=[];state.receipts=[];state.invoices=[];state.reports=[{id:'wage',projectId:'p1',workerId:'worker',date:'2026-10-10',status:'approved',laborCost:1000,rate:1000,minutes:60,version:2}];state.inventory=[{id:'stock',name:'کالا',unit:'عدد',quantity:10,unitPrice:100}];return state;}
let sequence=0;
const input=extra=>({employeeId:'worker',amount:100,date:'2026-10-27',method:'bank',reference:'FIN-REF-'+(++sequence),note:'ثبت آزمایشی',...extra});
const action=(state,name,extra={},actor='manager')=>applyAction(state,actor,name,input(extra));
const view=state=>employeeFinanceSnapshot(state,state.users[0]);
const account=state=>employeeFinanceAccount(state,'worker');
function unchanged(state,run,code){const before=structuredClone(state);assert.throws(run,error=>!code||error.code===code);assert.deepEqual(state,before);}
const withdraw=state=>applyAction(state,'manager','personalStock.issue',{employeeId:'worker',inventoryId:'stock',quantity:2,date:'2026-10-20'});

test('advance, actual wage payment and stock payroll settlement conserve earned wages without double deduction',()=>{
 const state=fixture(),report=structuredClone(state.reports);withdraw(state);
 action(state,'finance.advance.create',{amount:300,date:'2026-10-20'});
 assert.equal(account(state).grossPayable,1000);assert.equal(account(state).advanceBalance,300);assert.equal(account(state).netPayable,500);
 const paid=action(state,'finance.payroll.pay',{amount:500,advanceDeduction:300});
 assert.equal(account(state).advanceBalance,0);assert.equal(account(state).advancePayrollDeductions,300);assert.equal(account(state).payrollPaid,500);assert.equal(account(state).grossPayable,200);assert.equal(account(state).netPayable,0);
 applyAction(state,'accountant','personalStock.settle',{employeeId:'worker',amount:200,method:'payroll',reference:'STOCK-WAGES',date:'2026-10-27'});
 assert.equal(account(state).stockBalance,0);assert.equal(account(state).grossPayable,0);assert.equal(account(state).netPayable,0);
 const stockView=publicState(state,'manager').personalStock.accounts.find(row=>row.employeeId==='worker');assert.equal(stockView.projectedNetWages,0);
 assert.deepEqual(state.reports,report);assert.equal(view(state).summary.cashOut,800);
 assert(state.audit.some(row=>row.action==='finance.payroll.pay'&&row.entityId===paid.id));
 unchanged(state,()=>action(state,'finance.payroll.pay',{amount:1}),'INSUFFICIENT_PAYROLL');
});

test('an advance may be paid before wages exist and remains visible as a negative net payable',()=>{
 const state=fixture();state.reports=[];action(state,'finance.advance.create',{amount:400});
 assert.equal(account(state).advanceBalance,400);assert.equal(account(state).netPayable,-400);assert.equal(account(state).availableToPay,0);
 action(state,'finance.advance.repay',{amount:150});assert.equal(account(state).advanceBalance,250);
 unchanged(state,()=>action(state,'finance.advance.repay',{amount:251}),'ADVANCE_OVERPAYMENT');
 unchanged(state,()=>action(state,'finance.payroll.pay',{amount:1}),'INSUFFICIENT_PAYROLL');
});

test('applying an advance without cash settles the advance while preserving the same net wages',()=>{
 const state=fixture();action(state,'finance.advance.create',{amount:400,date:'2026-10-20'});
 const net=account(state).netPayable;action(state,'finance.payroll.pay',{amount:0,advanceDeduction:400});
 assert.equal(account(state).advanceBalance,0);assert.equal(account(state).grossPayable,600);assert.equal(account(state).netPayable,net);assert.equal(view(state).summary.cashOut,400);
 unchanged(state,()=>action(state,'finance.payroll.pay',{amount:0,advanceDeduction:0}));
});

test('cash payroll payment reserves unpaid advances and stock, and stock deductions respect wages already consumed',()=>{
 const state=fixture();withdraw(state);action(state,'finance.advance.create',{amount:300,date:'2026-10-20'});
 unchanged(state,()=>action(state,'finance.payroll.pay',{amount:501}),'INSUFFICIENT_PAYROLL');
 action(state,'finance.payroll.pay',{amount:500,advanceDeduction:300});
 const stockIssue=state.personalStockIssues[0];
 applyAction(state,'manager','personalStock.issue',{employeeId:'worker',inventoryId:'stock',quantity:1,date:'2026-10-27'});
 unchanged(state,()=>applyAction(state,'manager','personalStock.settle',{employeeId:'worker',amount:201,method:'payroll',date:'2026-10-27',reference:'OVER-WAGE'}),'INSUFFICIENT_APPROVED_WAGES');
 assert.equal(stockIssue.amount,200);assert.equal(account(state).netPayable,-100);
});

test('petty cash is an accountable fund: issue, spend and return balance exactly; funding is not an expense',()=>{
 const state=fixture();action(state,'finance.petty.issue',{projectId:'p1',amount:1000,date:'2026-10-20'});
 action(state,'finance.petty.expense',{projectId:'p1',amount:300,category:'ایاب و ذهاب'});
 action(state,'finance.petty.return',{projectId:'p1',amount:200});
 action(state,'finance.expense.create',{employeeId:undefined,projectId:'p1',amount:400,category:'خدمات'});
 const result=view(state);assert.equal(result.pettyAccounts[0].balance,500);assert.equal(result.summary.pettySpent,300);assert.equal(result.summary.cashOut,1400);assert.equal(result.summary.cashIn,200);assert.equal(result.summary.totalOperatingExpenses,700);
 const project=result.projectAccounts.find(row=>row.projectId==='p1');assert.equal(project.pettyExpenses,300);assert.equal(project.directExpenses,400);assert.equal(project.totalCost,1700);
 unchanged(state,()=>action(state,'finance.petty.expense',{projectId:'p1',amount:501}),'INSUFFICIENT_PETTY_CASH');
 unchanged(state,()=>action(state,'finance.petty.return',{projectId:'p1',amount:501}),'INSUFFICIENT_PETTY_CASH');
 unchanged(state,()=>action(state,'finance.petty.expense',{projectId:'p3',amount:1}),'INSUFFICIENT_PETTY_CASH');
});

test('backdated repayments or petty spending cannot precede their funding',()=>{
 const state=fixture();action(state,'finance.advance.create',{amount:300,date:'2026-10-25'});
 unchanged(state,()=>action(state,'finance.advance.repay',{amount:50,date:'2026-10-24'}),'ADVANCE_DATE_CONFLICT');
 unchanged(state,()=>action(state,'finance.payroll.pay',{amount:0,advanceDeduction:50,date:'2026-10-24'}),'ADVANCE_DATE_CONFLICT');
 action(state,'finance.petty.issue',{projectId:'p1',amount:300,date:'2026-10-25'});
 unchanged(state,()=>action(state,'finance.petty.expense',{projectId:'p1',amount:50,date:'2026-10-24'}),'INSUFFICIENT_PETTY_CASH');
});

test('corrections append a reversal without rewriting the original and cannot orphan a spent fund',()=>{
 const state=fixture(),issued=action(state,'finance.petty.issue',{projectId:'p1',amount:1000,date:'2026-10-20'}),spent=action(state,'finance.petty.expense',{projectId:'p1',amount:300}),original=structuredClone(state.financeEntries[0]);
 unchanged(state,()=>action(state,'finance.entry.reverse',{id:issued.id,version:1,reason:'اصلاح مبلغ'}),'INSUFFICIENT_PETTY_CASH');
 unchanged(state,()=>action(state,'finance.entry.reverse',{id:spent.id,version:2,reason:'اصلاح'}),'VERSION_CONFLICT');
 const reversed=action(state,'finance.entry.reverse',{id:spent.id,version:1,reason:'هزینه اشتباه ثبت شده است'});
 assert.deepEqual(state.financeEntries[0],original);assert.equal(reversed.reverseOf,spent.id);assert.equal(view(state).pettyAccounts[0].balance,1000);assert.equal(view(state).summary.pettySpent,0);
 action(state,'finance.entry.reverse',{id:issued.id,version:1,reason:'برگشت وجه و اصلاح'});assert.equal(view(state).summary.pettyBalance,0);
 assert.equal(view(state).entries.find(row=>row.id===spent.id).reversed,true);
 unchanged(state,()=>action(state,'finance.entry.reverse',{id:spent.id,version:1,reason:'تکراری'}),'ENTRY_REVERSED');
 unchanged(state,()=>action(state,'finance.entry.reverse',{id:reversed.id,version:1,reason:'برگشت برگشت'}),'ENTRY_REVERSED');
});

test('reversing an advance cannot leave repayments or applied deductions without their original funding',()=>{
 const state=fixture(),issued=action(state,'finance.advance.create',{amount:100,date:'2026-10-20'});action(state,'finance.advance.repay',{amount:20});
 unchanged(state,()=>action(state,'finance.entry.reverse',{id:issued.id,version:1,reason:'اصلاح'}),'ADVANCE_BALANCE_CONFLICT');
});

test('idempotency protects every new financial document and reversal from retries; references remain reserved',()=>{
 const state=fixture(),payload=input({amount:400,requestId:'finance-retry-001'}),created=applyAction(state,'accountant','finance.advance.create',payload);
 assert.equal(applyAction(state,'accountant','finance.advance.create',payload).id,created.id);assert.equal(state.financeEntries.length,1);
 unchanged(state,()=>applyAction(state,'accountant','finance.advance.create',{...payload,amount:200}),'IDEMPOTENCY_CONFLICT');
 unchanged(state,()=>action(state,'finance.advance.create',{reference:payload.reference}),'DUPLICATE_REFERENCE');
 const reversalPayload={id:created.id,version:1,reason:'اصلاح',date:'2026-10-27',requestId:'finance-reverse-001'};
 const reversal=applyAction(state,'manager','finance.entry.reverse',reversalPayload);assert.equal(applyAction(state,'manager','finance.entry.reverse',reversalPayload).id,reversal.id);assert.equal(state.financeEntries.length,2);
 unchanged(state,()=>action(state,'finance.advance.create',{reference:payload.reference}),'DUPLICATE_REFERENCE');
});

test('role boundaries are canonical and financial projections never expose another employee ledger or wage calculation',()=>{
 const state=fixture();action(state,'finance.advance.create',{amount:300});action(state,'finance.payroll.pay',{amount:200});action(state,'finance.petty.issue',{projectId:'p1',employeeId:'worker2',amount:500});
 for(const actor of ['worker','customer','warehouse'])unchanged(state,()=>action(state,'finance.advance.create',{},actor),'FORBIDDEN');
 unchanged(state,()=>action(state,'finance.entry.reverse',{id:state.financeEntries[0].id,version:1,reason:'اصلاح'},'accountant'),'FORBIDDEN');
 unchanged(state,()=>applyFinanceAction(state,{id:'worker',role:'manager'},'finance.advance.create',input()),'FORBIDDEN');
 const worker=publicState(state,'worker').employeeFinance;assert.equal(worker.accounts.length,1);assert.equal(worker.accounts[0].employeeId,'worker');assert.equal(worker.accounts[0].approvedWages,undefined);assert.equal(worker.accounts[0].grossPayable,undefined);assert(worker.entries.every(row=>row.employeeId==='worker'&&row.type!=='payroll_payment'));
 assert.equal(publicState(state,'customer').employeeFinance,undefined);assert.equal(publicState(state,'warehouse').employeeFinance.entries.length,0);
 state.financeEntries[0].secret='PRIVATE';assert.equal(view(state).entries[0].secret,undefined);const detached=view(state);detached.entries[0].amount=99;assert.equal(state.financeEntries[0].amount,300);
});

test('whole toman, valid dates, input size and safe totals are enforced atomically',()=>{
 const state=fixture();for(const amount of [-1,0,1.1,NaN,Infinity,Number.MAX_SAFE_INTEGER+1])unchanged(state,()=>action(state,'finance.advance.create',{amount}));
 unchanged(state,()=>action(state,'finance.advance.create',{date:'2026-02-30'}));unchanged(state,()=>action(state,'finance.advance.create',{reference:'x'.repeat(121)}));unchanged(state,()=>action(state,'finance.advance.create',{method:'crypto'}));
 action(state,'finance.advance.create',{amount:Number.MAX_SAFE_INTEGER});unchanged(state,()=>action(state,'finance.advance.create',{amount:1}),'FINANCE_OVERFLOW');
});

test('aggregate company or project totals cannot overflow after valid individual entries commit',()=>{
 const state=fixture();state.reports=[];
 action(state,'finance.expense.create',{employeeId:undefined,amount:Number.MAX_SAFE_INTEGER});
 unchanged(state,()=>action(state,'finance.expense.create',{employeeId:undefined,amount:1}),'FINANCE_OVERFLOW');
 assert.equal(publicState(state,'manager').employeeFinance.summary.cashOut,Number.MAX_SAFE_INTEGER);
 const wages=fixture();wages.reports[0].laborCost=Number.MAX_SAFE_INTEGER;
 unchanged(wages,()=>action(wages,'finance.expense.create',{employeeId:undefined,projectId:'p1',amount:1}),'FINANCE_OVERFLOW');
 assert.equal(wages.financeEntries,undefined);
});

test('company cash receipts and stock cash recovery are included once; stock payroll deduction is not cash',()=>{
 const state=fixture();withdraw(state);state.receipts=[{id:'r1',amount:100,projectId:'p1'},{id:'r2',amount:80,archivedAt:'2026-10-20'}];state.invoices=[{id:'inv1',projectId:'p1',amount:1000,paid:100}];
 applyAction(state,'accountant','personalStock.settle',{employeeId:'worker',amount:50,method:'cash',date:'2026-10-27',reference:'CASH-RETURN'});
 applyAction(state,'accountant','personalStock.settle',{employeeId:'worker',amount:50,method:'payroll',date:'2026-10-27',reference:'STOCK-DEDUCT'});
 const result=view(state);assert.equal(result.summary.clientReceipts,100);assert.equal(result.summary.stockRecoveries,50);assert.equal(result.summary.cashIn,150);assert.equal(result.projectAccounts.find(row=>row.projectId==='p1').receivable,900);
});

test('archived people and projects can close an existing fund, while new funding needs active records',()=>{
 const state=fixture();action(state,'finance.advance.create',{amount:300,date:'2026-10-20'});action(state,'finance.petty.issue',{projectId:'p1',amount:500,date:'2026-10-20'});
 state.users.find(row=>row.id==='worker').deletedAt='2026-10-26';state.projects.find(row=>row.id==='p1').archivedAt='2026-10-26';
 action(state,'finance.advance.repay',{amount:300});action(state,'finance.petty.return',{projectId:'p1',amount:500});
 assert.equal(view(state).pettyAccounts[0].projectArchived,true);assert.equal(view(state).pettyAccounts[0].balance,0);
 unchanged(state,()=>action(state,'finance.advance.create'));unchanged(state,()=>action(state,'finance.petty.issue',{projectId:'p1'}),'PROJECT_ARCHIVED');
});

test('browser and production financial rules remain exactly identical',async()=>{
 for(const name of ['finance-ledger.mjs','domain.mjs','personal-stock.mjs'])assert.equal(await readFile(new URL('../public/'+name,import.meta.url),'utf8'),await readFile(new URL('../supabase/functions/arios-api/'+name,import.meta.url),'utf8'));
});
