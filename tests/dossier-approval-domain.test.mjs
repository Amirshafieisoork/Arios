import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createSeedState,applyAction,publicState,projectAccess,projectReadAccess,projectReviewerAccess,readDossierSubmission,PROJECT_APPROVAL_LABELS} from '../public/domain.mjs';
const chain=ids=>PROJECT_APPROVAL_LABELS.map((label,index)=>({label,userId:ids[index]}));
function fixture() {
  const state=createSeedState();
  state.users.push({id:'reviewer',name:'مسئول واحد',phone:'+989121111111',email:'private-review@example.com',role:'worker',hourlyRate:1234},{id:'accountant',name:'مسئول مالی',role:'accountant'},{id:'outsider',name:'دیگر',role:'worker'},{id:'warehouse',name:'انبار',role:'warehouse'});
  state.users.find(person=>person.id==='worker').phone='+989122222222';
  applyAction(state,'manager','project.update',{id:'p1',projectCode:' ar-۱۴۰۵-۰۰۱ ',projectManagerId:'reviewer',reviewChain:chain(['reviewer','reviewer','accountant','accountant','manager','manager'])});
  return state;
}
const project=state=>state.projects.find(item=>item.id==='p1');
const current=state=>project(state).dossierSubmission;
const submit=(state,actor='manager',extra={})=>applyAction(state,actor,'project.dossier.submit',{projectId:'p1',version:project(state).dossier?.version||0,from:'2026-10-01',to:'2026-10-31',...extra});
const review=(state,actor,status='approved',extra={})=>applyAction(state,actor,'project.dossier.review',{projectId:'p1',id:current(state).id,version:current(state).version,status,reviewNote:status==='approved'?'': 'شرح کامل شود',...extra});
function unchanged(state,callback,code) {const before=structuredClone(state);assert.throws(callback,error=>!code||error.code===code);assert.deepEqual(state,before);}
const worksheet={version:0,workItems:[{id:'work',description:'نصب',quantity:2.125,unit:'متر',unitRate:1000}],staffAllocations:[{userId:'worker',wage:1000,bonus:100,paidAmount:0}],declaredLaborAmount:5000,finalLaborAmount:4000,notes:'توافق دستی'};
function noFinance(value) {
  assert.doesNotMatch(JSON.stringify(value), /"(?:hourlyRate|rateHistory|rate|laborCost|unitPrice|cost|approvedLaborCost|materialCost|workTotal|worksheet|workItems|staffAllocations|declaredLaborAmount|finalLaborAmount|wage|bonus|paidAmount|paymentReference)"/);
}

test('new project API requires real code and all six active responsibilities and normalizes unique official codes',()=>{
  const state=fixture();
  const base={name:'پروژه تازه',type:'CCTV',location:'تهران',memberIds:[],budget:0,contractAmount:0,startDate:'2026-10-01',endDate:'2026-10-31',projectCode:'AR-NEW',projectManagerId:'reviewer',reviewChain:chain(Array(6).fill('reviewer'))};
  for (const update of [{projectCode:''},{projectManagerId:''},{reviewChain:[]},{reviewChain:chain(['accountant','manager','manager','manager','manager','manager'])},{reviewChain:chain(['reviewer','warehouse','manager','manager','manager','manager'])}]) unchanged(state,()=>applyAction(state,'manager','project.create',{...base,...update}));
  for (const code of ['ar-۱۴۰۵-۰۰۱','AR-١٤٠٥-٠٠١','AR-1405-00\u200f1']) unchanged(state,()=>applyAction(state,'manager','project.create',{...base,projectCode:code}),'DUPLICATE_PROJECT_CODE');
  const result=applyAction(state,'manager','project.create',base);assert.equal(result.reviewChain.length,6);assert(result.reviewChain.every(stage=>stage.userId==='reviewer'));
  assert.equal(project(state).projectCode,'AR-1405-001');assert.equal(state.projects.find(item=>item.id==='p2').projectCode,undefined,'legacy records are not invented or backfilled');
});

test('six explicit approvals preserve duplicate actors and stale retries cannot advance a second responsibility',()=>{
  const state=fixture();submit(state,'reviewer');
  const initial=current(state).id;
  for (const [index,actor] of ['reviewer','reviewer','accountant','accountant','manager','manager'].entries()) {
    if(index===0) unchanged(state,()=>review(state,'manager'),'FORBIDDEN');
    const previous=current(state).version;
    review(state,actor);
    assert.equal(current(state).approval.currentStage,index+1);assert.equal(current(state).status,index===5?'approved':'submitted');assert.equal(current(state).id,initial);
    if(index<5) unchanged(state,()=>review(state,actor,'approved',{version:previous}),'VERSION_CONFLICT');
    assert.equal(current(state).approval.stages[index].reviewedBy,actor);assert(current(state).approval.stages[index].reviewedAt);
  }
  assert.equal(current(state).approval.history.filter(event=>event.action==='approved').length,6);
  unchanged(state,()=>review(state,'manager'),'IMMUTABLE_DOSSIER');
});

test('aggregate approval freezes report/material/worksheet evidence and never books wages or edits daily approvals',()=>{
  const state=fixture();applyAction(state,'accountant','project.dossier.save',{projectId:'p1',...worksheet});
  const reports=structuredClone(state.reports),invoices=structuredClone(state.invoices),receipts=structuredClone(state.receipts);
  submit(state);const frozen=structuredClone(current(state).snapshot);
  state.reports.find(report=>report.id==='r2').description='later live edit';state.materials.find(material=>material.id==='m1').quantity=99;
  applyAction(state,'manager','project.update',{id:'p1',projectCode:'AR-CHANGED',reviewChain:chain(['reviewer','manager','manager','manager','manager','manager'])});
  assert.deepEqual(current(state).snapshot,frozen);assert.equal(current(state).approval.stages[1].userId,'reviewer');
  for(const actor of ['reviewer','reviewer','accountant','accountant','manager','manager'])review(state,actor);
  const afterReports=structuredClone(state.reports);afterReports.find(report=>report.id==='r2').description=reports.find(report=>report.id==='r2').description;
  assert.deepEqual(afterReports,reports);assert.deepEqual(state.invoices,invoices);assert.deepEqual(state.receipts,receipts);
  unchanged(state,()=>applyAction(state,'manager','project.dossier.save',{projectId:'p1',...worksheet,version:1}),'DOSSIER_LOCKED');
});

test('project lead may submit operational evidence while financial values stay private in state and action responses',()=>{
  const state=fixture();applyAction(state,'manager','project.dossier.save',{projectId:'p1',...worksheet});
  const result=submit(state,'reviewer');noFinance(result);assert.equal(current(state).snapshot.worksheet.finalLaborAmount,4000);
  noFinance(review(state,'reviewer'));const view=publicState(state,'reviewer');noFinance(view);assert.equal(view.projects[0].canRecordWork,false);assert(view.reports.some(report=>report.workerId==='worker2'));
  const colleague=view.users.find(person=>person.id==='worker');assert.equal(colleague.phone,undefined);assert.equal(colleague.email,undefined);
  assert.deepEqual(view.messages,[]);assert.deepEqual(view.tickets,[]);assert.equal(view.projects[0].tasks,undefined);
  assert.equal(projectAccess(state,'reviewer','p1'),false);assert.equal(projectReadAccess(state,'reviewer','p1'),true);assert.equal(projectReviewerAccess(state,{id:'outsider',role:'manager'},'p1'),false);
  unchanged(state,()=>applyAction(state,'reviewer','report.create',{projectId:'p1',workerId:'reviewer'}),'FORBIDDEN');
  unchanged(state,()=>applyAction(state,'reviewer','material.consume',{projectId:'p1',inventoryId:'inv1',quantity:1,date:'2026-10-25'}),'FORBIDDEN');
  unchanged(state,()=>applyAction(state,'reviewer','project.dossier.save',{projectId:'p1',...worksheet}),'FORBIDDEN');
});

test('a returned aggregate keeps prior cycle evidence immutable when corrected and resubmitted',()=>{
  const state=fixture();submit(state);review(state,'reviewer');review(state,'reviewer','changes_requested');
  const old=structuredClone(current(state));
  state.reports.find(report=>report.id==='r2').description='corrected live description';
  unchanged(state,()=>submit(state,'manager'),'VERSION_CONFLICT');
  submit(state,'manager',{submissionVersion:old.version});
  assert.notEqual(current(state).id,old.id);assert.equal(current(state).version,1);assert.equal(current(state).approval.cycle,2);assert.equal(current(state).approval.currentStage,0);
  assert(current(state).approval.stages.every(stage=>stage.status==='pending'));assert.equal(current(state).snapshot.reports.find(report=>report.id==='r2').description,'corrected live description');
  assert.deepEqual(project(state).dossierSubmissionHistory[0].snapshot,old.snapshot);assert.deepEqual(project(state).dossierSubmissionHistory[0].approval,old.approval);
});

test('only manager can reassign the pending reviewer and previous stage evidence stays intact',()=>{
  const state=fixture();submit(state);review(state,'reviewer');
  const previous=structuredClone(current(state).approval.stages[0]);const payload=()=>({projectId:'p1',id:current(state).id,version:current(state).version,userId:'worker3',reason:'جایگزین مسئول واحد'});
  unchanged(state,()=>applyAction(state,'accountant','project.dossier.reassign',payload()),'FORBIDDEN');
  unchanged(state,()=>applyAction(state,'manager','project.dossier.reassign',{...payload(),reason:''}));
  applyAction(state,'manager','project.dossier.reassign',payload());assert.equal(current(state).approval.currentStage,1);assert.deepEqual(current(state).approval.stages[0],previous);assert.equal(current(state).approval.stages[1].userId,'worker3');
  unchanged(state,()=>review(state,'reviewer'),'FORBIDDEN');review(state,'worker3');assert.equal(current(state).approval.currentStage,2);
  const event=current(state).approval.history.find(event=>event.action==='reassigned');assert.equal(event.fromUserId,'reviewer');assert.equal(event.toUserId,'worker3');assert.equal(event.actorId,'manager');
});

test('inactive and changed-role reviewers cannot act and a manager cannot bypass their stage',()=>{
  for(const change of [user=>{user.deletedAt=new Date().toISOString();},user=>{user.role='customer';}]) {
    const state=fixture();submit(state);change(state.users.find(person=>person.id==='reviewer'));
    unchanged(state,()=>review(state,'reviewer'));unchanged(state,()=>review(state,'manager'),'INACTIVE_REVIEWER');
    applyAction(state,'manager','project.dossier.reassign',{projectId:'p1',id:current(state).id,version:current(state).version,userId:'manager',reason:'مسئول قبلی فعال نیست'});review(state,'manager');assert.equal(current(state).approval.currentStage,1);
  }
});

test('approved documents need an explicit new revision, keep every archived frozen value and enforce archive limit',()=>{
  const state=fixture();submit(state);for(const actor of ['reviewer','reviewer','accountant','accountant','manager','manager'])review(state,actor);
  const approved=structuredClone(current(state));
  unchanged(state,()=>submit(state,'accountant',{submissionVersion:approved.version}),'IMMUTABLE_DOSSIER');
  const payload={projectId:'p1',id:approved.id,version:approved.version,reason:'افزودن کارکرد دورهٔ بعد'};
  unchanged(state,()=>applyAction(state,'reviewer','project.dossier.revise',payload),'FORBIDDEN');
  applyAction(state,'accountant','project.dossier.revise',payload);assert.equal(current(state),undefined);assert.equal(project(state).dossier.version,1);
  assert.deepEqual(project(state).dossierSubmissionHistory[0].snapshot,approved.snapshot);submit(state);assert.equal(current(state).approval.cycle,2);
  review(state,'reviewer','changes_requested');project(state).dossierSubmissionHistory=Array.from({length:20},()=>structuredClone(approved));
  unchanged(state,()=>submit(state,'manager',{submissionVersion:current(state).version}),'DOSSIER_REVISION_LIMIT');
});

test('former frozen reviewer sees only assigned prior evidence and cannot inspect new live or submitted sources',()=>{
  const state=fixture();submit(state);review(state,'reviewer','changes_requested');
  const old=structuredClone(current(state));applyAction(state,'manager','project.update',{id:'p1',projectManagerId:'manager',reviewChain:chain(Array(6).fill('manager'))});
  state.reports.push({...state.reports[0],id:'later-report',description:'PRIVATE_FUTURE_REPORT'});state.materials.push({...state.materials[0],id:'later-material',name:'PRIVATE_FUTURE_MATERIAL'});
  submit(state,'manager',{submissionVersion:old.version});const view=publicState(state,'reviewer');assert.equal(view.projects[0].dossierSubmission,undefined);assert.equal(view.projects[0].dossierSubmissionHistory.length,1);assert.equal(view.reports.length,0);assert.equal(view.materials.length,0);assert.doesNotMatch(JSON.stringify(view),/PRIVATE_FUTURE_/);noFinance(view);
  const ordinary=publicState(state,'worker');assert.equal(ordinary.projects[0].dossierSubmission,undefined);assert.deepEqual(ordinary.projects[0].dossierSubmissionHistory,[]);assert(ordinary.reports.every(report=>report.workerId==='worker'));
});

test('legacy projects retain original daily review behavior and domain/workflow browser and Edge mirrors agree',async()=>{
  const state=createSeedState();assert.equal(state.projects[0].projectCode,undefined);applyAction(state,'manager','report.review',{id:'r2',status:'approved'});assert.equal(state.reports.find(report=>report.id==='r2').laborCost,520000);
  for(const name of ['domain.mjs','approval-workflow.mjs'])assert.equal(await readFile(new URL('../public/'+name,import.meta.url),'utf8'),await readFile(new URL('../supabase/functions/arios-api/'+name,import.meta.url),'utf8'));
});

test('oversized source periods and total frozen storage reject atomically without losing prior evidence',()=>{
  const state=fixture();
  state.reports.find(report=>report.id==='r2').description='ط'.repeat(600_000);
  unchanged(state,()=>submit(state),'DOSSIER_SNAPSHOT_TOO_LARGE');
  state.reports.find(report=>report.id==='r2').description='شرح عادی';submit(state);review(state,'reviewer','changes_requested');
  const old=structuredClone(current(state));
  const archived={...structuredClone(old),snapshot:{...old.snapshot,notes:'a'.repeat(8*1024*1024)}};
  project(state).dossierSubmissionHistory=[archived];
  unchanged(state,()=>submit(state,'manager',{submissionVersion:old.version}),'DOSSIER_STORAGE_LIMIT');
});

test('control-history bound permits finishing the six reviews and explicit revision recovery',()=>{
  const state=fixture();submit(state);
  const initial=current(state).approval.history[0];current(state).approval.history=Array.from({length:1000},(_,index)=>({...initial,id:String(index)}));
  unchanged(state,()=>applyAction(state,'manager','project.dossier.reassign',{projectId:'p1',id:current(state).id,version:current(state).version,userId:'manager',reason:'تغییر'}),'APPROVAL_HISTORY_LIMIT');
  for(const actor of ['reviewer','reviewer','accountant','accountant','manager','manager']) review(state,actor);
  assert.equal(current(state).status,'approved');assert.equal(current(state).approval.history.length,1006);
  applyAction(state,'manager','project.dossier.revise',{projectId:'p1',id:current(state).id,version:current(state).version,reason:'دوره بعد'});
  submit(state);assert.equal(current(state).approval.history.length,1);assert.equal(project(state).dossierSubmissionHistory[0].approval.history.length,1007);
});

test('history control cap cannot strand a submitted document after its reviewer loses access',()=>{
  const state=fixture();submit(state);
  const event=current(state).approval.history[0];current(state).approval.history=Array.from({length:1000},(_,index)=>({...event,id:String(index)}));
  state.users.find(user=>user.id==='reviewer').deletedAt=new Date().toISOString();
  applyAction(state,'manager','project.dossier.reassign',{projectId:'p1',id:current(state).id,version:current(state).version,userId:'manager',reason:'بازیابی مرحلهٔ متوقف‌شده پس از خروج مسئول'});
  assert.equal(current(state).approval.stages[0].userId,'manager');review(state,'manager','changes_requested');assert.equal(current(state).status,'changes_requested');
});

test('state lists bounded document descriptors while selected frozen reads stay canonical, private and detached',()=>{
  const state=fixture();applyAction(state,'accountant','project.dossier.save',{projectId:'p1',...worksheet});submit(state);
  const id=current(state).id,raw=structuredClone(current(state));
  const descriptor=publicState(state,'manager').projects[0].dossierSubmission;
  assert.equal(descriptor.snapshot,undefined);assert.equal(descriptor.approval.history,undefined);assert.equal(descriptor.approval.historyCount,1);assert.equal(descriptor.approval.stages.length,6);
  assert.equal(readDossierSubmission(state,'accountant','p1',id).snapshot.worksheet.finalLaborAmount,4000);
  const operational=readDossierSubmission(state,{id:'reviewer',role:'manager'},'p1',id);noFinance(operational);operational.snapshot.reports[0].description='local alteration';assert.deepEqual(current(state),raw);
  for(const actor of ['worker','customer','warehouse','outsider']) assert.throws(()=>readDossierSubmission(state,actor,'p1',id),error=>error.status===403);
  state.users.find(user=>user.id==='reviewer').deletedAt=new Date().toISOString();assert.throws(()=>readDossierSubmission(state,'reviewer','p1',id),error=>error.status===401);
});

test('former reviewer selected-read scope preserves only their archived document, without loading future evidence in state',()=>{
  const state=fixture();submit(state);review(state,'reviewer','changes_requested');const old=structuredClone(current(state));
  applyAction(state,'manager','project.update',{id:'p1',projectManagerId:'manager',reviewChain:chain(Array(6).fill('manager'))});submit(state,'manager',{submissionVersion:old.version});
  assert.equal(readDossierSubmission(state,'reviewer','p1',old.id).id,old.id);assert.throws(()=>readDossierSubmission(state,'reviewer','p1',current(state).id),error=>error.status===403);
  project(state).dossierSubmissionHistory=Array.from({length:20},(_,index)=>({...structuredClone(old),id:'past-'+index,snapshot:{...old.snapshot,reports:[{...old.snapshot.reports[0],description:'پ'.repeat(150_000)}]}}));
  const serialized=JSON.stringify(publicState(state,'manager'));assert(Buffer.byteLength(serialized)<100_000);assert(!serialized.includes('پ'.repeat(100)));
  assert.equal(readDossierSubmission(state,'manager','p1','past-0').snapshot.reports[0].description.length,150_000);
});

test('audit control byte limit and 500-character notes reserve space for terminal reviews',()=>{
  const state=fixture();submit(state);
  unchanged(state,()=>review(state,'reviewer','changes_requested',{reviewNote:'ش'.repeat(501)}));
  const initial=current(state).approval.history[0];current(state).approval.history=Array.from({length:900},(_,index)=>({...initial,id:String(index),note:'ش'.repeat(1500)}));
  unchanged(state,()=>applyAction(state,'manager','project.dossier.reassign',{projectId:'p1',id:current(state).id,version:current(state).version,userId:'manager',reason:'تغییر مسئول'}),'APPROVAL_HISTORY_LIMIT');
  review(state,'reviewer','changes_requested',{reviewNote:'ش'.repeat(500)});assert.equal(current(state).status,'changes_requested');
});
