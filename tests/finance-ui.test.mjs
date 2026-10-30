import test from 'node:test';
import assert from 'node:assert/strict';
import {createSeedState,publicState,applyAction} from '../public/domain.mjs';
import {renderOperations} from '../public/operations.mjs';
import {renderFinanceWorkspace,openEmployeeAdvance,openPayrollPayment,openPettyCashEntry,openBusinessExpense,openFinanceReversal,financeCSV} from '../public/finance-workspace.mjs';
const escape=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const context=extra=>({e:escape,n:String,money:value=>`COST:${value}`,date:String,today:()=> '2026-10-30',projectName:String,personName:String,icon:()=>'',badge:()=>'',...extra});
const fields=values=>{const form=new FormData();for(const [key,value]of Object.entries(values))form.set(key,value);return form;};
function noDocument(t){const previous=globalThis.document;globalThis.document={querySelector:()=>null,querySelectorAll:()=>[]};t.after(()=>previous===undefined?delete globalThis.document:globalThis.document=previous);}
function fixture(){const seed=createSeedState();seed.users.push({id:'accountant',name:'حسابدار',role:'accountant'});return seed;}

test('advance and payroll forms settle previously paid money once without paying it again',async t=>{
 noDocument(t);const seed=fixture();let modal;const contextValue=context({modal:value=>modal=value,mutate:async(action,payload)=>applyAction(seed,'manager',action,payload)});
 openEmployeeAdvance(publicState(seed,'manager'),contextValue,{employeeId:'worker'});
 const advance=fields({employeeId:'worker',amount:'200000',date:'2026-10-30',reference:'advance-100',method:'bank',note:'وجه پرداخت‌شده'});
 await modal.onSubmit(advance);await modal.onSubmit(advance);assert.equal(seed.financeEntries.length,1);
 let state=publicState(seed,'manager'),account=state.employeeFinance.accounts.find(row=>row.employeeId==='worker');
 assert.equal(account.advanceBalance,200000);assert.equal(account.availableToPay,625000);
 openPayrollPayment(state,contextValue,'worker');assert.match(modal.body,/name="amount"[^>]*min="0"/);assert(!/name="amount"[^>]*min="1"/.test(modal.body));
 assert.match(modal.body,/name="advanceDeduction"[^>]*value="200000"/);
 await modal.onSubmit(fields({employeeId:'worker',amount:'625000',advanceDeduction:'200000',date:'2026-10-30',reference:'payroll-100',method:'bank',note:'حقوق مهر'}));
 account=publicState(seed,'manager').employeeFinance.accounts.find(row=>row.employeeId==='worker');
 assert.equal(account.advanceBalance,0);assert.equal(account.payrollPaid,625000);assert.equal(account.availableToPay,0);assert.equal(account.netPayable,0);
});

test('petty cash flow registers funding, expense and return with distinct accounting effects',async t=>{
 noDocument(t);const seed=fixture();let modal;const c=context({modal:value=>modal=value,mutate:async(action,payload)=>applyAction(seed,'manager',action,payload)});
 for(const [type,amount,reference]of [['issue','1000000','petty-i'],['expense','650000','petty-e'],['return','350000','petty-r']]){
   openPettyCashEntry(publicState(seed,'manager'),c,{type,employeeId:'worker',projectId:'p1'});
   await modal.onSubmit(fields({employeeId:'worker',projectId:'p1',amount,date:'2026-10-30',method:'cash',reference,note:'تست گردش',category:'خرید ملزومات'}));
 }
 const state=publicState(seed,'manager'),pool=state.employeeFinance.pettyAccounts.find(row=>row.employeeId==='worker'&&row.projectId==='p1');
 assert.equal(pool.balance,0);assert.equal(pool.spent,650000);assert.equal(state.employeeFinance.summary.totalOperatingExpenses,650000);
 assert.equal(state.employeeFinance.accounts.find(row=>row.employeeId==='worker').netPayable,825000);
 const html=renderFinanceWorkspace(state,c);assert.match(html,/تنخواه پروژه‌ها/);assert.match(html,/COST:650000/);assert.match(html,/تسویه‌شده/);
});

test('expense form and reversal keep an immutable and escaped history while preserving customer boundary',async t=>{
 noDocument(t);const seed=fixture();let modal;const c=context({modal:value=>modal=value,mutate:async(action,payload)=>applyAction(seed,'manager',action,payload)});
 openBusinessExpense(publicState(seed,'manager'),c);assert.match(modal.body,/هزینهٔ عمومی شرکت/);
 await modal.onSubmit(fields({amount:'250000',date:'2026-10-30',method:'bank',reference:'expense-1',note:'<script>bad</script>',category:'رفت‌وآمد'}));
 let state=publicState(seed,'manager'),entry=state.employeeFinance.entries[0];
 const html=renderFinanceWorkspace(state,c);assert.match(html,/&lt;script&gt;bad&lt;\/script&gt;/);assert(!html.includes('<script>bad'));
 openFinanceReversal(state,c,entry.id);await modal.onSubmit(fields({date:'2026-10-30',reason:'مبلغ اشتباه بود'}));
 state=publicState(seed,'manager');assert.equal(state.employeeFinance.entries.length,2);assert.equal(state.employeeFinance.entries[0].reversed,true);assert.equal(state.employeeFinance.summary.totalOperatingExpenses,0);
 assert.match(renderFinanceWorkspace(state,c),/ابطال شده؛ از مانده خارج شده است/);
 const customer=publicState(seed,'customer'),customerHTML=renderOperations('finance',{...customer,employeeFinance:state.employeeFinance},c);
 assert(!customerHTML.includes('data-finance-workspace'));assert(!customerHTML.includes('bad'));assert(!customerHTML.includes('تنخواه'));assert(customerHTML.includes('data-coordinate-payment'));
 let opened=false;openFinanceReversal(publicState(seed,'accountant'),context({modal:()=>opened=true}),entry.id);assert.equal(opened,false);
});

test('financial export protects spreadsheets and excludes unrelated credentials',()=>{
 const seed=fixture();applyAction(seed,'manager','finance.expense.create',{amount:120000,date:'2026-10-30',reference:'export-1',method:'bank',note:' =HYPERLINK("https://example.test")',category:'خرید'});
 const state=publicState(seed,'manager');state.privateSecret='not-in-csv';const csv=financeCSV(state);
 assert(csv.startsWith('\uFEFF'));assert(csv.includes("'=HYPERLINK("));assert(!csv.includes('not-in-csv'));assert.throws(()=>financeCSV({...state,user:{role:'worker'}}),/فعال نیست/);
});
