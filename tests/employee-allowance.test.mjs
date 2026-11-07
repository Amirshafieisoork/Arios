import test from 'node:test';
import assert from 'node:assert/strict';
import {applyAction,createSeedState,publicState} from '../public/domain.mjs';
import {employeeFinanceAccount,employeeFinanceSnapshot,ALLOWANCE_CATEGORIES} from '../public/finance-ledger.mjs';
import {omitMoney} from '../public/permissions.mjs';

function fixture(){const state=createSeedState();state.users.push({id:'accountant',role:'accountant',name:'حسابدار'});state.reports=[];state.materials=[];state.receipts=[];state.invoices=[];state.inventory=[{id:'item',name:'کالای شخصی',unit:'عدد',quantity:10,unitPrice:100}];return state;}
let serial=0;
const input=extra=>({employeeId:'worker',amount:100,date:'2026-11-06',method:'bank',reference:'BENEFIT-'+(++serial),category:'حق صبحانه',note:'حق صبحانه دوره کار',...extra});
const post=(state,action,extra={},actor='manager')=>applyAction(state,actor,action,input(extra));
const account=state=>employeeFinanceAccount(state,'worker');
const ledger=state=>employeeFinanceSnapshot(state,state.users.find(row=>row.id==='manager'));

test('allowance earnings stay confidential in nested financial redaction and ordinary staff projections',()=>{
 const state=fixture();post(state,'finance.allowance.create',{amount:300});
 assert.deepEqual(omitMoney({employeeId:'worker',account:{approvedAllowances:300,earnedTotal:300}}),{employeeId:'worker',account:{}});
 const employeeView=JSON.stringify(publicState(state,'worker'));
 assert(!employeeView.includes('"approvedAllowances"'));assert(!employeeView.includes('"earnedTotal"'));
});
function unchanged(state,fn,code){const before=structuredClone(state);assert.throws(fn,error=>!code||error.code===code);assert.deepEqual(state,before);}

test('breakfast and other benefits accrue separately from work wages and become payable without claiming a cash transfer',()=>{
 const state=fixture();post(state,'finance.allowance.create',{amount:300});
 assert(ALLOWANCE_CATEGORIES.includes('حق صبحانه'));assert.equal(account(state).approvedWages,0);assert.equal(account(state).approvedAllowances,300);assert.equal(account(state).earnedTotal,300);assert.equal(account(state).netPayable,300);
 assert.equal(ledger(state).summary.cashOut,0);assert.equal(ledger(state).summary.approvedAllowances,300);assert.equal(ledger(state).summary.earnedTotal,300);assert.equal(ledger(state).summary.totalOperatingExpenses,0);
 post(state,'finance.payroll.pay',{amount:300});
 assert.equal(account(state).netPayable,0);assert.equal(account(state).payrollPaid,300);assert.equal(ledger(state).summary.cashOut,300);
 unchanged(state,()=>post(state,'finance.payroll.pay',{amount:1}),'INSUFFICIENT_PAYROLL');
});

test('benefits combine with reported wages, stock liabilities and advances without double deduction',()=>{
 const state=fixture();state.reports=[{id:'wage',projectId:'p1',workerId:'worker',date:'2026-11-05',status:'approved',laborCost:500}];
 post(state,'finance.allowance.create',{amount:200});
 post(state,'finance.advance.create',{amount:100});
 applyAction(state,'manager','personalStock.issue',{employeeId:'worker',inventoryId:'item',quantity:2,date:'2026-11-06'});
 assert.equal(account(state).earnedTotal,700);assert.equal(account(state).availableToPay,400);
 assert.equal(publicState(state,'manager').personalStock.accounts.find(row=>row.employeeId==='worker').projectedNetWages,400);
 post(state,'finance.payroll.pay',{amount:400,advanceDeduction:100});
 applyAction(state,'accountant','personalStock.settle',{employeeId:'worker',amount:200,method:'payroll',reference:'BENEFIT-STOCK',date:'2026-11-06'});
 assert.equal(account(state).netPayable,0);assert.equal(ledger(state).summary.cashOut,500);
 assert.equal(publicState(state,'manager').personalStock.accounts.find(row=>row.employeeId==='worker').projectedNetWages,0);
});

test('a paid benefit or benefit used for a stock payroll deduction cannot be cancelled before its dependent settlement',()=>{
 const state=fixture(),grant=post(state,'finance.allowance.create',{amount:200});
 const paid=post(state,'finance.payroll.pay',{amount:200});
 unchanged(state,()=>post(state,'finance.entry.reverse',{id:grant.id,version:1,reason:'اصلاح مزایا'}),'ALLOWANCE_IN_USE');
 post(state,'finance.entry.reverse',{id:paid.id,version:1,reason:'ابطال پرداخت'});
 post(state,'finance.entry.reverse',{id:grant.id,version:1,reason:'ابطال مزایا'});
 assert.equal(account(state).approvedAllowances,0);assert.equal(ledger(state).summary.cashOut,0);
 const stock=fixture(),benefit=post(stock,'finance.allowance.create',{amount:100});
 applyAction(stock,'manager','personalStock.issue',{employeeId:'worker',inventoryId:'item',quantity:1,date:'2026-11-06'});
 applyAction(stock,'accountant','personalStock.settle',{employeeId:'worker',amount:100,method:'payroll',reference:'BENEFIT-STOCK-REVERSE',date:'2026-11-06'});
 unchanged(stock,()=>post(stock,'finance.entry.reverse',{id:benefit.id,version:1,reason:'اصلاح مزایا'}),'ALLOWANCE_IN_USE');
});

test('future benefits cannot finance earlier payroll payments or inventory payroll deductions',()=>{
 const state=fixture();post(state,'finance.allowance.create',{amount:300,date:'2026-11-10'});
 unchanged(state,()=>post(state,'finance.payroll.pay',{amount:1,date:'2026-11-09'}),'ALLOWANCE_DATE_CONFLICT');
 applyAction(state,'manager','personalStock.issue',{employeeId:'worker',inventoryId:'item',quantity:1,date:'2026-11-06'});
 unchanged(state,()=>applyAction(state,'manager','personalStock.settle',{employeeId:'worker',amount:100,method:'payroll',reference:'FUTURE-BENEFIT',date:'2026-11-09'}),'INSUFFICIENT_APPROVED_WAGES');
 applyAction(state,'manager','personalStock.settle',{employeeId:'worker',amount:100,method:'payroll',reference:'MATURE-BENEFIT',date:'2026-11-10'});
 post(state,'finance.payroll.pay',{amount:200,date:'2026-11-10'});assert.equal(account(state).netPayable,0);
});

test('benefits require an active organizational member and canonical finance officer and reject repeated or invalid grants',()=>{
 const state=fixture(),worker=state.users.find(row=>row.id==='worker');worker.permissions={'finance.view':true,'projects.prices':true,'finance.manage':true,'finance.reverse':true};
 unchanged(state,()=>post(state,'finance.allowance.create',{},'worker'),'FORBIDDEN');
 unchanged(state,()=>post(state,'finance.allowance.create',{employeeId:'customer'}));
 for(const amount of [0,-1,0.5,Infinity])unchanged(state,()=>post(state,'finance.allowance.create',{amount}));
 const payload=input({amount:200,requestId:'allowance-repeat-001'}),grant=applyAction(state,'accountant','finance.allowance.create',payload);
 assert.equal(applyAction(state,'accountant','finance.allowance.create',payload).id,grant.id);assert.equal(account(state).approvedAllowances,200);
 unchanged(state,()=>applyAction(state,'accountant','finance.allowance.create',{...payload,amount:100}),'IDEMPOTENCY_CONFLICT');
 state.users.find(row=>row.id==='worker').deletedAt='2026-11-06';unchanged(state,()=>post(state,'finance.allowance.create'));
});
