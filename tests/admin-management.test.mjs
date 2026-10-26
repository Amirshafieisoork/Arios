import test from 'node:test';
import assert from 'node:assert/strict';
import {applyAction,createSeedState,publicState,projectAccess,projectReadAccess,readDossierSubmission,PROJECT_APPROVAL_LABELS} from '../public/domain.mjs';
import {buildDossierSummary} from '../public/dossier-model.mjs';

const fixture=()=>{const state=createSeedState();state.users.push({id:'warehouse',role:'warehouse',name:'انباردار'},{id:'accountant',role:'accountant',name:'حسابدار'});return state;};
const record=(state,collection,id)=>state[collection].find(row=>row.id===id);
const admin=(state,collection,id,operation,extra={})=>applyAction(state,'manager',`admin.record.${operation}`,{collection,id,reason:'اصلاح رکورد با درخواست مدیر',...extra});
const unchanged=(state,run,code)=>{const before=structuredClone(state);assert.throws(run,error=>!code||error.code===code);assert.deepEqual(state,before);};
const configured=()=>{const state=fixture();applyAction(state,'manager','project.update',{id:'p1',projectCode:'AR-ADMIN',projectManagerId:'manager',reviewChain:PROJECT_APPROVAL_LABELS.map(label=>({label,userId:'manager'}))});return state;};

test('manager maintenance rejects other roles, protected field injection and stale report versions atomically',()=>{
 const state=fixture();
 for(const role of ['worker','customer','warehouse','accountant'])for(const operation of ['update','archive','restore'])unchanged(state,()=>applyAction(state,role,`admin.record.${operation}`,{collection:'projects',id:'p1',changes:{name:'تزریق'},reason:'تلاش'}),'FORBIDDEN');
 unchanged(state,()=>admin(state,'invoices','i2','update',{changes:{paid:0}}));
 unchanged(state,()=>admin(state,'users','worker','archive'));
 unchanged(state,()=>admin(state,'reports','r1','update',{changes:{description:'شرح'},version:1}),'VERSION_CONFLICT');
});

test('project deletion hides active data from every operational role and blocks writes while manager can recover the same records',()=>{
 const state=configured(),project=record(state,'projects','p1');
 const original=structuredClone({reports:state.reports,materials:state.materials,receipts:state.receipts,inventory:state.inventory});
 project.files=[{id:'safe-file',name:'نقشه',status:'ready',storagePath:'SECRET',mimeType:'application/pdf',size:10}];
 admin(state,'projects','p1','archive');
 for(const role of ['worker','customer','warehouse','accountant']){
  assert.equal(projectAccess(state,role,'p1'),false);assert.equal(projectReadAccess(state,role,'p1'),false);
  const view=publicState(state,role);assert(!view.projects.some(row=>row.id==='p1'));assert(!view.reports.some(row=>row.projectId==='p1'));assert.equal(view.management,undefined);
 }
 assert.equal(projectAccess(state,'manager','p1'),true);
 const manager=publicState(state,'manager');assert(!manager.projects.some(row=>row.id==='p1'));
 const managed=manager.management.projects.find(row=>row.id==='p1');assert(managed.archivedAt);assert.equal(managed.files[0].storagePath,undefined);
 for(const [action,payload] of [['message.send',{projectId:'p1',text:'تازه'}],['invoice.create',{projectId:'p1',title:'تازه',amount:1,dueDate:'2026-10-30'}],['project.update',{id:'p1',name:'تازه'}],['report.review',{id:'r2',status:'approved'}]])unchanged(state,()=>applyAction(state,'manager',action,payload),'PROJECT_ARCHIVED');
 assert.deepEqual({reports:state.reports,materials:state.materials,receipts:state.receipts,inventory:state.inventory},original);
 admin(state,'projects','p1','restore');assert(publicState(state,'worker').projects.some(row=>row.id==='p1'));assert.equal(record(state,'projects','p1').id,'p1');
});

test('irrelevant caller project IDs cannot mask archived canonical parents or move reports out of a deleted project',()=>{
 const state=configured();
 const draft=applyAction(state,'worker','report.draft.save',{projectId:'p1',workerId:'worker',date:'2026-10-26',start:'08:00',end:'09:00',description:'پیش‌نویس'});
 admin(state,'projects','p1','archive');
 for(const [action,payload] of [
  ['project.update',{id:'p1',projectId:'p2',progress:5}],
  ['report.review',{id:'r2',projectId:'p2',status:'approved'}],
  ['report.update',{id:'r2',projectId:'p2',date:'2026-10-26',start:'08:00',end:'09:00',description:'انتقال',version:1}],
  ['payment.record',{invoiceId:'i2',projectId:'p2',amount:1,reference:'FORGED-PARENT'}],
  ['material.return',{id:'m1',projectId:'p2',quantity:1,date:'2026-10-27'}],
  ['account.update',{id:'worker',projectIds:['p1']}],
 ])unchanged(state,()=>applyAction(state,'manager',action,payload),'PROJECT_ARCHIVED');
 unchanged(state,()=>applyAction(state,'worker','report.draft.delete',{id:draft.id,projectId:'p2',version:draft.version}),'PROJECT_ARCHIVED');
});

test('archived project frozen reads remain available only to the manager and restore retains original publication setting',()=>{
 const state=configured(),project=record(state,'projects','p1');project.publicVisible=true;
 applyAction(state,'manager','project.dossier.submit',{projectId:'p1',version:0,from:'2026-10-01',to:'2026-10-31'});
 const id=project.dossierSubmission?.id||record(state,'projects','p1').dossierSubmission.id;
 assert(readDossierSubmission(state,'accountant','p1',id));
 admin(state,'projects','p1','archive');
 for(const role of ['worker','accountant','customer','warehouse'])assert.throws(()=>readDossierSubmission(state,role,'p1',id),error=>error.status===403);
 assert(readDossierSubmission(state,'manager','p1',id).snapshot);
 admin(state,'projects','p1','restore');assert.equal(record(state,'projects','p1').publicVisible,true);
});

test('project metadata and stages are editable without losing delegated updates, with atomic date validation',()=>{
 const state=configured();admin(state,'projects','p1','update',{changes:{name:'نام تازه',type:'کار سفارشی',location:'محل تازه',budget:100,contractAmount:200,startDate:'2026-10-01',endDate:'2026-11-01',description:'توضیح',phases:[{name:'مرحله تازه',progress:25}]}});
 const project=record(state,'projects','p1');assert.equal(project.name,'نام تازه');assert.equal(project.phases[0].progress,25);assert(project.updatedAt);assert.equal(project.adminHistory.length,1);assert.equal(project.adminHistory[0].before.name,'مجتمع آفتاب');
 unchanged(state,()=>admin(state,'projects','p1','update',{changes:{name:'نباید بماند',endDate:'2026-09-01'}}));
});

test('task maintenance keeps deleted assignees as historical references and removes archived tasks from live scopes',()=>{
 const state=fixture();const task=applyAction(state,'manager','task.create',{projectId:'p1',title:'کار فردا',description:'شرح',assigneeId:'worker',dueDate:'2026-10-27'});
 record(state,'users','worker').deletedAt='2026-10-26T12:00:00Z';
 admin(state,'tasks',task.id,'update',{projectId:'p1',version:task.version,changes:{assigneeId:'worker',title:'عنوان اصلاحی',status:'done'}});
 const current=record(state,'projects','p1').tasks.find(row=>row.id===task.id);assert.equal(current.title,'عنوان اصلاحی');assert(current.updatedAt);assert.equal(current.adminHistory.length,1);
 admin(state,'tasks',task.id,'archive',{projectId:'p1',version:current.version});assert(!publicState(state,'manager').projects.find(row=>row.id==='p1').tasks.some(row=>row.id===task.id));
 unchanged(state,()=>applyAction(state,'manager','task.update',{projectId:'p1',id:task.id,version:current.version,status:'open'}),'RECORD_ARCHIVED');
 admin(state,'tasks',task.id,'restore',{projectId:'p1'});assert(publicState(state,'manager').projects.find(row=>row.id==='p1').tasks.some(row=>row.id===task.id));
});

test('approved report correction preserves frozen evidence and rate history while requiring a new live approval',()=>{
 const state=configured();applyAction(state,'manager','project.dossier.submit',{projectId:'p1',version:0,from:'2026-10-01',to:'2026-10-31'});
 const frozen=structuredClone(record(state,'projects','p1').dossierSubmission),old=structuredClone(record(state,'reports','r1'));
 record(state,'users',old.workerId).deletedAt='2026-10-26T00:00:00Z';
 admin(state,'reports',old.id,'update',{version:old.version,changes:{description:'شرح اصلاح‌شده',end:'15:00'}});
 const updated=record(state,'reports',old.id);assert.equal(updated.status,'submitted');assert.equal(updated.minutes,390);assert.equal(updated.laborCost,0);assert.equal(updated.rate,old.rate);assert.equal(updated.version,old.version+1);assert.equal(updated.adminHistory[0].before.laborCost,old.laborCost);
 assert.deepEqual(record(state,'projects','p1').dossierSubmission,frozen);
 unchanged(state,()=>admin(state,'reports',old.id,'update',{version:updated.version,changes:{workerId:'customer'}}));
});

test('archived approved reports leave live labor totals and restores cannot introduce duplicate approved work',()=>{
 const state=fixture(),old=record(state,'reports','r1'),cost=old.laborCost;
 const previous=publicState(state,'manager').projects.find(row=>row.id==='p1').laborCost;
 admin(state,'reports',old.id,'archive');assert.equal(publicState(state,'manager').projects.find(row=>row.id==='p1').laborCost,previous-cost);
 const replacement=applyAction(state,'manager','report.create',{projectId:'p1',workerId:old.workerId,date:old.date,start:old.start,end:old.end,breakMinutes:old.breakMinutes,description:'گزارش جایگزین'});
 applyAction(state,'manager','report.review',{id:replacement.id,status:'approved'});
 unchanged(state,()=>admin(state,'reports',old.id,'restore'),'TIME_OVERLAP');assert(record(state,'reports',old.id).archivedAt);
});

test('material edits and removal conserve net physical stock through returns and failed restores',()=>{
 const state=fixture(),initial=record(state,'inventory','inv1').quantity;
 const consumed=applyAction(state,'manager','material.consume',{projectId:'p1',inventoryId:'inv1',quantity:3,date:'2026-10-25'});
 applyAction(state,'manager','material.return',{id:consumed.id,quantity:1,date:'2026-10-26'});
 admin(state,'materials',consumed.id,'update',{changes:{quantity:4,unitPrice:4000000}});assert.equal(record(state,'inventory','inv1').quantity,initial-4);assert.equal(record(state,'materials',consumed.id).originalQuantity,5);
 admin(state,'materials',consumed.id,'archive');assert.equal(record(state,'inventory','inv1').quantity,initial);assert.equal(record(state,'materials',consumed.id).returns.length,1);
 admin(state,'materials',consumed.id,'restore');assert.equal(record(state,'inventory','inv1').quantity,initial-4);
 admin(state,'materials',consumed.id,'archive');admin(state,'inventory','inv1','update',{changes:{quantity:0}});
 unchanged(state,()=>admin(state,'materials',consumed.id,'restore'),'INSUFFICIENT_STOCK');
 unchanged(state,()=>admin(state,'inventory','inv1','update',{changes:{unit:'متر'}}),'STOCK_UNIT_IN_USE');
});

test('receipt corrections and removals reconcile invoice paid amount, prevent overpayment and retain unique history references',()=>{
 const state=fixture();admin(state,'receipts','rc2','update',{changes:{amount:10000000,reference:'CORRECTED-REF'}});assert.equal(record(state,'invoices','i2').paid,10000000);
 admin(state,'receipts','rc2','archive');assert.equal(record(state,'invoices','i2').paid,0);assert(!publicState(state,'customer').receipts.some(row=>row.id==='rc2'));
 admin(state,'receipts','rc2','archive');assert.equal(record(state,'invoices','i2').paid,0,'a duplicate archive cannot reverse twice');
 applyAction(state,'manager','payment.record',{invoiceId:'i2',amount:40000000,reference:'NEW-REF'});
 unchanged(state,()=>admin(state,'receipts','rc2','restore'),'OVERPAYMENT');
 unchanged(state,()=>admin(state,'invoices','i2','update',{changes:{amount:1000000}}),'OVERPAYMENT');
 unchanged(state,()=>admin(state,'invoices','i2','archive'),'ACTIVE_RECEIPTS');
 const newReceipt=state.receipts.find(row=>row.reference==='NEW-REF');admin(state,'receipts',newReceipt.id,'archive');admin(state,'invoices','i2','archive');
 unchanged(state,()=>admin(state,'receipts','rc2','restore'),'INVOICE_ARCHIVED');
 admin(state,'invoices','i2','restore');admin(state,'receipts','rc2','restore');assert.equal(record(state,'invoices','i2').paid,10000000);
});

test('new dossier summaries exclude removed rows and previous frozen snapshots remain byte-identical',()=>{
 const state=configured();applyAction(state,'manager','project.dossier.submit',{projectId:'p1',version:0,from:'2026-10-01',to:'2026-10-31'});
 const frozen=JSON.stringify(record(state,'projects','p1').dossierSubmission);
 admin(state,'reports','r1','archive');admin(state,'materials','m1','archive');
 const summary=buildDossierSummary({...state,user:record(state,'users','manager')},'p1');assert(!summary.reports.some(row=>row.id==='r1'));assert(!summary.materials.some(row=>row.id==='inv1'));
 assert.equal(JSON.stringify(record(state,'projects','p1').dossierSubmission),frozen);
});

test('manager can amend and recover messages, tickets and stock without exposing management/private fields to others',()=>{
 const state=fixture();const message=applyAction(state,'manager','message.send',{projectId:'p1',text:'پیام قدیمی',internal:false});
 admin(state,'messages',message.id,'update',{changes:{text:'پیام اصلاحی',internal:true}});assert.equal(record(state,'messages',message.id).text,'پیام اصلاحی');
 admin(state,'messages',message.id,'archive');admin(state,'messages',message.id,'restore');
 admin(state,'tickets','t1','update',{changes:{subject:'عنوان تازه',description:'شرح تازه',priority:'high',status:'resolved'}});assert.equal(record(state,'tickets','t1').status,'resolved');
 admin(state,'inventory','inv4','update',{changes:{name:'نام تازه',quantity:5.125,minQuantity:2.5,unitPrice:1000}});assert.equal(record(state,'inventory','inv4').quantity,5.125);
 record(state,'projects','p1').privateSecret='SECRET';record(state,'reports','r1').privateSecret='SECRET';
 assert(!JSON.stringify(publicState(state,'manager').management).includes('SECRET'));
 for(const role of ['worker','customer','warehouse','accountant'])assert.equal(publicState(state,role).management,undefined);
});

test('manager file lists retain private draft ownership and never leak storage locations',()=>{
 const state=fixture();record(state,'projects','p1').files=[
  {id:'private-draft',draftId:'d1',uploadedBy:'worker',name:'SECRET-DRAFT',status:'ready',storagePath:'SECRET-STORAGE'},
  {id:'private-archived-draft',draftId:'d2',uploadedBy:'worker',name:'SECRET-ARCHIVE',status:'ready',archivedAt:'2026-10-26'},
  {id:'manager-draft',draftId:'d3',uploadedBy:'manager',name:'پیش‌نویس مدیر',status:'ready'},
  {id:'submitted',draftId:'d4',reportId:'r1',uploadedBy:'worker',name:'تصویر گزارش ارسال‌شده',status:'ready'},
 ];
 const view=publicState(state,'manager'),project=view.projects.find(row=>row.id==='p1'),managed=view.management.projects.find(row=>row.id==='p1');
 assert.deepEqual(project.files.map(file=>file.id),['manager-draft','submitted']);assert.equal(project.archivedFiles.length,0);
 assert.deepEqual(managed.files.map(file=>file.id),['manager-draft','submitted']);assert.equal(managed.archivedFiles.length,0);assert(!JSON.stringify(view).includes('SECRET'));
});

test('administrative history caps reject edits atomically and reserve room to recover an already removed record',()=>{
 const state=fixture(),row=record(state,'messages','msg1')||state.messages[0];
 row.adminHistory=[{reason:'x'.repeat(1024*1024)}];
 unchanged(state,()=>admin(state,'messages',row.id,'update',{changes:{text:'نباید بماند'}}),'ADMIN_HISTORY_LIMIT');
 row.adminHistory=Array.from({length:1000},()=>({action:'admin.record.archive',reason:'سابقه'}));row.archivedAt='2026-10-26T00:00:00Z';
 admin(state,'messages',row.id,'restore');assert.equal(record(state,'messages',row.id).archivedAt,undefined);assert.equal(record(state,'messages',row.id).adminHistory.length,1001);
});
