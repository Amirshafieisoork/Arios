import test from 'node:test';
import assert from 'node:assert/strict';
import {applyAction,createSeedState,publicState,PROJECT_APPROVAL_LABELS} from '../public/domain.mjs';
import {applyPersonalStockAction,personalStockSnapshot} from '../public/personal-stock.mjs';

function fixture(){
 const state=createSeedState();
 state.users.push({id:'warehouse',name:'انباردار آزمایشی',role:'warehouse'},{id:'accountant',name:'حسابدار آزمایشی',role:'accountant'});
 state.inventory.push({id:'personal-item',name:'ابزار شخصی',unit:'عدد',quantity:10,minQuantity:1,unitPrice:100});
 state.reports=state.reports.filter(report=>report.workerId!=='worker');
 state.reports.push({id:'personal-wage',projectId:'p1',workerId:'worker',date:'2026-10-20',start:'08:00',end:'09:00',breakMinutes:0,description:'کار انجام‌شده',output:'تحویل',status:'approved',minutes:60,createdAt:'2026-10-20T07:00:00Z',version:2,rate:1000,laborCost:1000});
 return state;
}
const issueInput=extra=>({employeeId:'worker',inventoryId:'personal-item',quantity:2,date:'2026-10-27',note:'مصرف شخصی',...extra});
const issue=(state,extra={},actor='manager')=>applyAction(state,actor,'personalStock.issue',issueInput(extra));
const settle=(state,extra={},actor='accountant')=>applyAction(state,actor,'personalStock.settle',{employeeId:'worker',amount:100,method:'cash',date:'2026-10-27',reference:'PERSONAL-SETTLE-1',note:'دریافت واقعی',...extra});
const stock=state=>state.inventory.find(item=>item.id==='personal-item');
const account=(state,employeeId='worker',actor='manager')=>personalStockSnapshot(state,state.users.find(user=>user.id===actor)).accounts.find(row=>row.employeeId===employeeId);
function unchanged(state,run,code){const before=structuredClone(state);assert.throws(run,error=>!code||error.code===code);assert.deepEqual(state,before);}

test('personal withdrawals atomically debit stock and the employee without changing project consumption or approved payroll',()=>{
 const state=fixture(),before=structuredClone({reports:state.reports,materials:state.materials,invoices:state.invoices,receipts:state.receipts});
 const created=issue(state);
 assert.equal(stock(state).quantity,8);assert.equal(created.amount,200);assert.equal(created.unitPrice,100);assert.equal(created.netQuantity,2);
 assert.equal(account(state).balance,200);assert.equal(account(state).projectedNetWages,800);
 assert.deepEqual({reports:state.reports,materials:state.materials,invoices:state.invoices,receipts:state.receipts},before);
 assert(state.audit.some(entry=>entry.action==='personalStock.issue'&&entry.entityId===created.id));
 unchanged(state,()=>issue(state,{quantity:9}),'INSUFFICIENT_STOCK');
});

test('personal stock respects active staff and server-side permissions including warehouse price control',()=>{
 const state=fixture();
 for(const actor of ['worker','worker2','accountant','customer'])unchanged(state,()=>issue(state,{},actor),'FORBIDDEN');
 unchanged(state,()=>issue(state,{employeeId:'customer'}));
 state.users.find(user=>user.id==='worker2').deletedAt='2026-10-27T00:00:00Z';
 unchanged(state,()=>issue(state,{employeeId:'worker2'}));
 unchanged(state,()=>issue(state,{unitPrice:0},'warehouse'),'PRICE_OVERRIDE_FORBIDDEN');
 const warehouseIssue=issue(state,{},'warehouse');assert.equal(warehouseIssue.unitPrice,100);
 const override=issue(state,{employeeId:'accountant',unitPrice:75,quantity:1});assert.equal(override.amount,75);
 for(const actor of ['warehouse','worker','customer'])unchanged(state,()=>settle(state,{},actor),'FORBIDDEN');
 unchanged(state,()=>applyPersonalStockAction(state,{id:'warehouse',role:'manager'},'personalStock.issue',issueInput()),'FORBIDDEN');
});

test('inventory price changes do not rewrite existing personal debts or their return valuation',()=>{
 const state=fixture(),created=issue(state);
 applyAction(state,'manager','admin.record.update',{collection:'inventory',id:'personal-item',changes:{name:'نام تازه',unitPrice:250},reason:'بهای تازه'});
 const returned=applyAction(state,'warehouse','personalStock.return',{id:created.id,quantity:0.5,date:'2026-10-28',version:created.version});
 assert.equal(returned.name,'ابزار شخصی');assert.equal(returned.unitPrice,100);assert.equal(returned.amount,150);assert.equal(returned.returns[0].amount,50);
 assert.equal(stock(state).quantity,8.5);assert.equal(account(state).balance,150);
});

test('whole-toman rounding conserves the charge through fractional and full returns',()=>{
 const state=fixture(),created=issue(state,{quantity:0.333,unitPrice:3});
 assert.equal(created.amount,1);assert.equal(stock(state).quantity,9.667);
 const first=applyAction(state,'warehouse','personalStock.return',{id:created.id,quantity:0.001,date:'2026-10-27',version:1});
 assert.equal(first.amount,1);assert.equal(first.returns[0].amount,0);
 const full=applyAction(state,'warehouse','personalStock.return',{id:created.id,quantity:0.332,date:'2026-10-27',version:2});
 assert.equal(full.amount,0);assert.equal(full.netQuantity,0);assert.equal(full.returnedQuantity,0.333);assert.equal(stock(state).quantity,10);
 assert.equal(full.returns.reduce((sum,row)=>sum+row.amount,0),created.amount);
 unchanged(state,()=>applyAction(state,'manager','personalStock.return',{id:created.id,quantity:0.001,date:'2026-10-27',version:3}),'RETURN_EXCEEDS_ISSUED');
 for(const quantity of [0,-1,NaN,0.0001,Infinity])unchanged(state,()=>issue(state,{quantity}));
});

test('a write that would overflow the employee aggregate is rejected before committing stock or debt',()=>{
 const state=fixture();issue(state,{quantity:1,unitPrice:Number.MAX_SAFE_INTEGER});
 unchanged(state,()=>issue(state,{quantity:1,unitPrice:1}));
 assert.equal(state.personalStockIssues.length,1);assert.equal(stock(state).quantity,9);assert.equal(account(state).balance,Number.MAX_SAFE_INTEGER);
});

test('retries of issues, returns and settlements cannot charge, return or deduct twice',()=>{
 const state=fixture(),input=issueInput({requestId:'issue-request-0001'}),created=applyAction(state,'manager','personalStock.issue',input);
 assert.equal(applyAction(state,'manager','personalStock.issue',input).id,created.id);assert.equal(state.personalStockIssues.length,1);assert.equal(stock(state).quantity,8);
 unchanged(state,()=>applyAction(state,'manager','personalStock.issue',{...input,quantity:1}),'IDEMPOTENCY_CONFLICT');
 const returnedInput={id:created.id,quantity:1,date:'2026-10-28',version:1,requestId:'return-request-0001'};
 const returned=applyAction(state,'warehouse','personalStock.return',returnedInput);
 assert.equal(applyAction(state,'warehouse','personalStock.return',returnedInput).version,returned.version);assert.equal(stock(state).quantity,9);assert.equal(state.personalStockIssues[0].returns.length,1);
 unchanged(state,()=>applyAction(state,'warehouse','personalStock.return',{...returnedInput,quantity:0.5}),'IDEMPOTENCY_CONFLICT');
 const paid=settle(state,{requestId:'settle-request-0001'});assert.equal(settle(state,{requestId:'settle-request-0001'}).id,paid.id);
 assert.equal(state.personalStockSettlements.length,1);assert.equal(account(state).balance,0);
 unchanged(state,()=>settle(state,{amount:50,requestId:'settle-request-0001'}),'IDEMPOTENCY_CONFLICT');
});

test('payroll settlement is explicit and net wage projection never double deducts settled debt',()=>{
 const state=fixture();issue(state,{quantity:5});
 const paid=settle(state,{amount:200,method:'payroll',reference:'PAYROLL-1405-08'});
 let view=account(state);assert.equal(view.approvedWages,1000);assert.equal(view.payrollDeductions,200);assert.equal(view.balance,300);assert.equal(view.projectedNetWages,500);
 settle(state,{amount:300,method:'bank',reference:'BANK-00001'});view=account(state);
 assert.equal(view.balance,0);assert.equal(view.projectedNetWages,800);assert.equal(state.reports.find(row=>row.id==='personal-wage').laborCost,1000);
 const removed=applyAction(state,'manager','personalStock.settlement.archive',{id:paid.id,version:1,reason:'اصلاح فیش'});
 assert.equal(account(state).balance,200);assert.equal(account(state).payrollDeductions,0);assert.equal(account(state).projectedNetWages,800);
 applyAction(state,'manager','personalStock.settlement.restore',{id:paid.id,version:removed.version,reason:'تأیید فیش'});
 assert.equal(account(state).balance,0);assert.equal(account(state).projectedNetWages,800);
});

test('settlements reject overpayment, reused tracking references and payroll unsupported by approved wages',()=>{
 const state=fixture();issue(state,{quantity:5});
 unchanged(state,()=>settle(state,{amount:501}),'OVERPAYMENT');
 state.reports.find(row=>row.id==='personal-wage').laborCost=100;
 unchanged(state,()=>settle(state,{amount:101,method:'payroll'}),'INSUFFICIENT_APPROVED_WAGES');
 settle(state,{amount:100,method:'payroll'});
 unchanged(state,()=>settle(state,{amount:100,method:'payroll'}),'DUPLICATE_REFERENCE');
 unchanged(state,()=>settle(state,{amount:1,method:'payroll',reference:'PAYROLL-SECOND'}),'INSUFFICIENT_APPROVED_WAGES');
});

test('returns after payment create a visible employee credit and cancellation/recovery conserve physical stock',()=>{
 const state=fixture(),created=issue(state,{quantity:5});settle(state,{amount:500});
 const returned=applyAction(state,'warehouse','personalStock.return',{id:created.id,quantity:2,date:'2026-10-28',version:1});
 assert.equal(stock(state).quantity,7);assert.equal(account(state).balance,-200);assert.equal(account(state).credit,200);
 const canceled=applyAction(state,'manager','personalStock.archive',{id:created.id,version:returned.version,reason:'لغو خرید شخصی'});
 assert.equal(stock(state).quantity,10);assert.equal(account(state).balance,-500);
 applyAction(state,'manager','personalStock.archive',{id:created.id,version:returned.version,reason:'تکرار درخواست'});assert.equal(stock(state).quantity,10);
 applyAction(state,'manager','personalStock.restore',{id:created.id,version:canceled.version,reason:'بازیابی خرید'});
 assert.equal(stock(state).quantity,7);assert.equal(account(state).credit,200);assert.equal(state.personalStockIssues[0].returns.length,1);
});

test('failed restores and stale returns leave both stock and employee ledger unchanged',()=>{
 const state=fixture(),created=issue(state,{quantity:5});
 unchanged(state,()=>applyAction(state,'warehouse','personalStock.return',{id:created.id,quantity:1,date:'2026-10-26',version:1}));
 unchanged(state,()=>applyAction(state,'warehouse','personalStock.return',{id:created.id,quantity:1,date:'2026-10-27',version:0}),'VERSION_CONFLICT');
 const canceled=applyAction(state,'manager','personalStock.archive',{id:created.id,version:1,reason:'لغو'});
 applyAction(state,'manager','admin.record.update',{collection:'inventory',id:'personal-item',changes:{quantity:0},reason:'اصلاح شمارش'});
 unchanged(state,()=>applyAction(state,'manager','personalStock.restore',{id:created.id,version:canceled.version,reason:'بازیابی'}),'INSUFFICIENT_STOCK');
});

test('personal stock projections give workers only their account and keep payroll details away from warehouse and customers',()=>{
 const state=fixture();issue(state);issue(state,{employeeId:'worker2',quantity:1,note:'یادداشت محرمانهٔ همکار دیگر'});settle(state);
 const worker=publicState(state,'worker').personalStock;
 assert.equal(worker.issues.length,1);assert(worker.issues.every(row=>row.employeeId==='worker'));assert(worker.settlements.every(row=>row.employeeId==='worker'));
 assert.equal(worker.accounts.length,1);assert.equal(worker.accounts[0].approvedWages,undefined);assert(!JSON.stringify(worker).includes('یادداشت محرمانهٔ همکار دیگر'));
 const warehouse=publicState(state,'warehouse').personalStock;assert.equal(warehouse.settlements.length,0);assert(warehouse.accounts.every(row=>row.approvedWages===undefined&&row.payrollDeductions===undefined));
 const customer=publicState(state,'customer').personalStock;assert.equal(customer,undefined);
 const manager=publicState(state,'manager').personalStock;assert.equal(manager.issues.length,2);assert(manager.accounts.some(row=>row.approvedWages!==undefined));
 assert(!JSON.stringify(manager).includes('requestFingerprint'));assert(!JSON.stringify(manager).includes('requestId'));
});

test('an existing employee debt can still be settled after the person changes to a customer role',()=>{
 const state=fixture();issue(state);
 applyAction(state,'manager','account.update',{id:'worker',role:'customer',projectIds:[]});
 assert.equal(state.users.find(row=>row.id==='worker').role,'customer');
 settle(state,{amount:200});assert.equal(account(state).balance,0);
 unchanged(state,()=>issue(state,{employeeId:'worker'}));
 assert.equal(publicState(state,'worker').personalStock,undefined);
});

test('a personal-use inventory item remains referenced after cancellation and its historical unit cannot be rewritten',()=>{
 const state=fixture(),created=issue(state,{quantity:10});
 unchanged(state,()=>applyAction(state,'manager','admin.record.update',{collection:'inventory',id:'personal-item',changes:{unit:'متر'},reason:'تغییر واحد'}),'STOCK_UNIT_IN_USE');
 const removed=applyAction(state,'manager','inventory.delete',{id:'personal-item',confirmed:true,expectedQuantity:0});
 assert.equal(removed.archived,true);assert(stock(state));
 unchanged(state,()=>applyAction(state,'manager','admin.record.update',{collection:'inventory',id:'personal-item',changes:{unit:'متر'},reason:'تغییر واحد'}));
 const canceled=applyAction(state,'manager','personalStock.archive',{id:created.id,version:1,reason:'لغو برداشت'});assert.equal(stock(state).quantity,10);
 unchanged(state,()=>applyAction(state,'manager','personalStock.restore',{id:created.id,version:canceled.version,reason:'بازیابی'}),'STOCK_ARCHIVED');
});

test('personal withdrawals and payroll deductions do not rewrite an already frozen project dossier',()=>{
 const state=fixture();
 applyAction(state,'manager','project.update',{id:'p1',projectCode:'PERSONAL-TEST',projectManagerId:'manager',reviewChain:PROJECT_APPROVAL_LABELS.map(label=>({label,userId:'manager'}))});
 applyAction(state,'manager','project.dossier.submit',{projectId:'p1',version:0,from:'2026-10-01',to:'2026-10-31'});
 const frozen=JSON.stringify(state.projects.find(row=>row.id==='p1').dossierSubmission);
 const created=issue(state);settle(state,{amount:100,method:'payroll'});
 applyAction(state,'warehouse','personalStock.return',{id:created.id,quantity:1,date:'2026-10-28',version:1});
 assert.equal(JSON.stringify(state.projects.find(row=>row.id==='p1').dossierSubmission),frozen);
});
