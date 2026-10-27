import test from 'node:test';
import assert from 'node:assert/strict';
import {createSeedState,publicState,applyAction} from '../public/domain.mjs';
import {renderInventoryWorkspace,wireInventoryWorkspace} from '../public/inventory-workspace.mjs';
import {renderOperations} from '../public/operations.mjs';
import {renderPersonalStockWorkspace,openPersonalStockIssue,openPersonalStockReturn,openPersonalStockSettlement,wirePersonalStockWorkspace} from '../public/personal-stock-workspace.mjs';
const escape=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const ctx=extra=>({e:escape,n:String,money:value=>`COST:${value}`,date:String,today:()=> '2026-10-27',projectName:String,personName:String,icon:()=>'',badge:()=>'',...extra});
const form=values=>{const result=new FormData();for(const [key,value]of Object.entries(values))result.set(key,value);return result;};
function fixture(){const seed=createSeedState();seed.users.push({id:'warehouse',name:'انباردار',role:'warehouse'},{id:'accountant',name:'حسابدار',role:'accountant'},{id:'inactive',name:'همکار غیرفعال',role:'worker',deletedAt:'2026-10-25'});return seed;}
function noDocument(t){const previous=globalThis.document;globalThis.document={querySelector:()=>null,querySelectorAll:()=>[]};t.after(()=>previous===undefined?delete globalThis.document:globalThis.document=previous);}

test('personal issue form creates a stock debit once across a retried submit and keeps project ledgers unchanged',async t=>{
 noDocument(t);const seed=fixture(),beforeMaterials=structuredClone(seed.materials),beforeReports=structuredClone(seed.reports);let modal;const calls=[];
 const context=ctx({modal:value=>modal=value,mutate:async(action,payload)=>{calls.push({action,payload});return applyAction(seed,'manager',action,payload);}});
 openPersonalStockIssue(publicState(seed,'manager'),context,{employeeId:'worker',inventoryId:'inv2'});
 assert.match(modal.body,/همکار/);assert(!modal.body.includes('همکار غیرفعال'));assert(!modal.body.includes('مشتری آفتاب'));
 const fields=form({employeeId:'worker',inventoryId:'inv2',quantity:'1.25',unitPrice:'28000',date:'2026-10-27',note:'مصرف شخصی <script>'});
 await modal.onSubmit(fields);await modal.onSubmit(fields);
 assert.equal(seed.personalStockIssues.length,1);assert.equal(seed.inventory.find(row=>row.id==='inv2').quantity,498.75);
 assert.equal(calls[0].payload.requestId,calls[1].payload.requestId);assert.equal(seed.personalStockIssues[0].amount,35000);
 assert.deepEqual(seed.materials,beforeMaterials);assert.deepEqual(seed.reports,beforeReports);
 const html=renderPersonalStockWorkspace(publicState(seed,'manager'),context);assert.match(html,/مصرف شخصی &lt;script&gt;/);assert(!html.includes('<script>'));
});

test('return and payroll settlement forms conserve stock and do not deduct wages twice',async t=>{
 noDocument(t);const seed=fixture();const issued=applyAction(seed,'manager','personalStock.issue',{employeeId:'worker',inventoryId:'inv2',quantity:2,date:'2026-10-27'});let modal;
 const context=ctx({modal:value=>modal=value,mutate:async(action,payload)=>applyAction(seed,'manager',action,payload)});
 const wageBefore=seed.reports.filter(row=>row.workerId==='worker'&&row.status==='approved').reduce((total,row)=>total+row.laborCost,0);
 openPersonalStockReturn(publicState(seed,'manager'),context,issued.id);
 await modal.onSubmit(form({quantity:'0.5',date:'2026-10-27',note:'برگشت سالم'}));
 const before=publicState(seed,'manager').personalStock.accounts.find(row=>row.employeeId==='worker');
 assert.equal(before.balance,42000);assert.equal(seed.inventory.find(row=>row.id==='inv2').quantity,498.5);
 openPersonalStockSettlement(publicState(seed,'manager'),context,'worker');
 assert.match(modal.body,/کسر از حقوق/);assert.match(modal.body,/شمارهٔ پیگیری یا شناسهٔ فیش حقوقی/);
 const fields=form({employeeId:'worker',amount:'42000',method:'payroll',date:'2026-10-27',reference:'payroll-2026-10-local',note:'تسویهٔ آزمون'});
 await modal.onSubmit(fields);await modal.onSubmit(fields);
 const after=publicState(seed,'manager').personalStock.accounts.find(row=>row.employeeId==='worker');
 assert.equal(after.balance,0);assert.equal(after.payrollDeductions,42000);assert.equal(after.projectedNetWages,before.projectedNetWages);assert.equal(after.approvedWages,wageBefore);assert.equal(seed.personalStockSettlements.length,1);
});

test('warehouse price is read-only and worker personal view stays read-only and scoped',t=>{
 noDocument(t);const seed=fixture();applyAction(seed,'manager','personalStock.issue',{employeeId:'worker',inventoryId:'inv2',quantity:1,date:'2026-10-27',note:'own-note'});applyAction(seed,'manager','personalStock.issue',{employeeId:'worker2',inventoryId:'inv1',quantity:1,date:'2026-10-27',note:'other-private-note'});
 let modal;openPersonalStockIssue(publicState(seed,'warehouse'),ctx({modal:value=>modal=value}));
 assert.match(modal.body,/name="unitPrice"[^>]*readonly/);assert.match(modal.body,/value="worker"/);
 const worker=publicState(seed,'worker'),html=renderInventoryWorkspace(worker,ctx({inventoryView:'personal'}));
 assert.match(html,/حساب برداشت شخصی من/);assert.match(html,/own-note/);assert(!html.includes('other-private-note'));
 assert(!html.includes('data-personal-stock-issue>'));assert(!html.includes('data-personal-stock-return='));assert(!html.includes('data-personal-stock-settle='));assert(!html.includes('دستمزد تأییدشده'));
 const warehouse=renderPersonalStockWorkspace(publicState(seed,'warehouse'),ctx());assert(!warehouse.includes('سوابق تسویه و کسر از حقوق'));assert(!warehouse.includes('دستمزد تأییدشده'));
 const customer=publicState(seed,'customer');assert.equal(renderPersonalStockWorkspace(customer,ctx()),'');
 assert(!renderOperations('finance',{...customer,personalStock:publicState(seed,'manager').personalStock},ctx()).includes('حساب برداشت شخصی'));
});

test('financial screen and team expose account actions while scoped project inventory does not mix personal charges',()=>{
 const seed=fixture();applyAction(seed,'manager','personalStock.issue',{employeeId:'worker',inventoryId:'inv2',quantity:1,date:'2026-10-27'});
 const manager=publicState(seed,'manager');assert.match(renderOperations('team',manager,ctx()),/ماندهٔ برداشت شخصی همکاران/);
 const finance=renderOperations('finance',publicState(seed,'accountant'),ctx());assert.match(finance,/ثبت تسویه یا کسر از حقوق/);assert(!finance.includes('data-personal-stock-issue>'));
 const scoped=renderInventoryWorkspace(manager,ctx({inventoryProjectId:'p1',inventoryView:'personal'}));assert(!scoped.includes('data-personal-stock-workspace'));assert(!scoped.includes('personal-stock-tabs'));
});

test('cancel controls submit the displayed version and a reason, and worker cannot bind them',async t=>{
 noDocument(t);const seed=fixture(),issue=applyAction(seed,'manager','personalStock.issue',{employeeId:'worker',inventoryId:'inv2',quantity:1,date:'2026-10-27'});let modal,click;
 const button={dataset:{personalStockArchive:issue.id},addEventListener:(_,callback)=>click=callback};
 globalThis.document={querySelector:()=>null,querySelectorAll:selector=>selector==='[data-personal-stock-archive]'?[button]:[]};
 const context=ctx({modal:value=>modal=value,mutate:async(action,payload)=>applyAction(seed,'manager',action,payload)});
 wirePersonalStockWorkspace(publicState(seed,'worker'),context);assert.equal(click,undefined);
 wireInventoryWorkspace(publicState(seed,'manager'),context);assert.equal(typeof click,'function');click();assert.match(modal.body,/دلیل اصلاح/);
 await modal.onSubmit(form({reason:'اشتباه در ثبت تحویل'}));assert(seed.personalStockIssues[0].archivedAt);assert.equal(seed.inventory.find(row=>row.id==='inv2').quantity,500);
});
