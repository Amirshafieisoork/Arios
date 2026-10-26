import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {
  applyDossierAction, buildDossierSummary, dossierDate, workItemTotal,
  safeDossierSubmission, safeDossierWorksheet,
} from '../public/dossier-model.mjs';

function fixture() {
  const manager = {id:'manager',role:'manager',name:'مدیر'};
  const accountant = {id:'accountant',role:'accountant',name:'حسابدار'};
  const worker = {id:'worker',role:'worker',name:'همکار پروژه',employeeCode:'EMP-12',hourlyRate:150000};
  return {
    user:manager,
    users:[manager,accountant,worker,{id:'other',role:'worker',name:'همکار دیگر'},{id:'customer',role:'customer',name:'مشتری',phone:'09120000000'}],
    projects:[{id:'p1',name:'پروژهٔ آزمایش',projectCode:'AR-12',customerId:'customer',projectManagerId:'worker',memberIds:['worker'],reviewChain:[{label:'مسئول پروژه',userId:'worker'}]}],
    reports:[
      {id:'r1',projectId:'p1',workerId:'worker',date:'2026-10-01',start:'08:00',end:'11:00',breakMinutes:0,minutes:180,description:'نصب',output:'نصب انجام شد',status:'approved',rate:150000,laborCost:450000,internalSecret:'SECRET_REPORT'},
      {id:'r2',projectId:'p1',workerId:'worker',date:'2026-10-02',start:'09:00',end:'11:30',breakMinutes:30,minutes:120,description:'آزمایش',output:'آزمایش انجام شد',status:'submitted',rate:150000,laborCost:0},
      {id:'foreign',projectId:'p2',workerId:'other',date:'2026-10-01',start:'08:00',end:'10:00',minutes:120,description:'خارج از پروژه',status:'approved',rate:900000,laborCost:1800000},
    ],
    materials:[{id:'m1',projectId:'p1',inventoryId:'i1',itemCode:'CBL-10',name:'کابل',unit:'متر',originalQuantity:12.5,quantity:10.25,date:'2026-10-01',unitPrice:10000,returns:[{id:'return1',date:'2026-10-03',quantity:2.25}]}],
    inventory:[],
  };
}
const payload = (overrides = {}) => ({projectId:'p1',version:0,workItems:[{id:'wi1',description:'نصب کابل',quantity:1.125,unit:'متر',unitRate:1000}],staffAllocations:[{id:'sa1',userId:'worker',wage:1000,bonus:100,paidAmount:200,paymentDate:'2026-10-04',paymentReference:'دستی-۱۲',notes:'پرداخت ثبت‌شدهٔ دستی'}],declaredLaborAmount:1500,finalLaborAmount:1200,notes:'شرح فرم',...overrides});
const actor = (state,id='manager') => state.users.find(person=>person.id===id);
function unchanged(state, operation, expected) {
  const before = structuredClone(state);
  assert.throws(operation,expected);
  assert.deepEqual(state,before);
}

test('actual completion date and notes remain distinct from planned delivery and visible without financial data',()=>{
  const state=fixture();state.projects[0].endDate='2026-10-15';
  applyDossierAction(state,actor(state),'project.dossier.save',payload({completionDate:'2026-10-04',completionNotes:'تحویل واقعی انجام شد'}));
  state.user=actor(state,'worker');
  const summary=buildDossierSummary(state,'p1');
  assert.equal(summary.project.endDate,'2026-10-15');
  assert.equal(summary.completionDate,'2026-10-04');
  assert.equal(summary.completionNotes,'تحویل واقعی انجام شد');
  assert.equal(summary.worksheet,undefined);
  state.user=actor(state);
  unchanged(state,()=>applyDossierAction(state,actor(state),'project.dossier.save',payload({version:1,completionDate:'2026-02-30'})),error=>error.status===400);
});

test('worksheet decimal quantities round to whole toman once and reject invalid money and precision', () => {
  assert.equal(workItemTotal(1.125,1000),1125);
  assert.equal(workItemTotal(1.125,5),6);
  assert.equal(workItemTotal(0.001,500),1);
  for (const [quantity,rate] of [[0,1],[-1,1],[Infinity,1],[1.0001,1],[1,-1],[1,1.2],[1,Number.MAX_SAFE_INTEGER],[1000000,1000000000000]]) {
    assert.throws(()=>workItemTotal(quantity,rate));
  }
});

test('worksheet validates real dates and inclusive chronological filters', () => {
  assert.equal(dossierDate('2024-02-29'),'2024-02-29');
  for(const date of ['2026-02-29','2026-02-30','2026-13-01','2026-1-01','1405/07/01'])assert.throws(()=>dossierDate(date));
  assert.throws(()=>buildDossierSummary(fixture(),'p1',{from:'2026-10-03',to:'2026-10-01'}));
  const summary=buildDossierSummary(fixture(),'p1',{from:'2026-10-02',to:'2026-10-02'});
  assert.deepEqual(summary.reports.map(row=>row.id),['r2']);
  assert.equal(summary.totalMinutes,120);
  assert.equal(summary.approvedMinutes,0);
  assert.equal(summary.approvedLaborCost,0);
});

test('dossier aggregates actual project work and signed material return events in their own dates', () => {
  const state=fixture();
  const all=buildDossierSummary(state,'p1');
  assert.deepEqual(all.reports.map(row=>row.id),['r1','r2']);
  assert.equal(all.totalMinutes,300);
  assert.equal(all.approvedMinutes,180);
  assert.equal(all.approvedLaborCost,450000);
  assert.equal(all.materials[0].quantity,10.25);
  assert.deepEqual(all.materials[0].days,[{date:'2026-10-01',quantity:12.5},{date:'2026-10-03',quantity:-2.25}]);
  assert.equal(all.materialCost,102500);
  const issued=buildDossierSummary(state,'p1',{from:'2026-10-01',to:'2026-10-01'});
  assert.equal(issued.materials[0].quantity,12.5);
  const returned=buildDossierSummary(state,'p1',{from:'2026-10-03',to:'2026-10-03'});
  assert.equal(returned.materials[0].quantity,-2.25);
  assert.equal(returned.materialCost,-22500);
  assert.equal(returned.materialItemCount,1);
});

test('a built summary is a detached evidence snapshot with known report and person fields only', () => {
  const state=fixture();
  const summary=buildDossierSummary(state,'p1');
  assert.doesNotMatch(JSON.stringify(summary),/SECRET_REPORT/);
  assert.equal(summary.people.find(person=>person.id==='worker').hourlyRate,undefined);
  state.projects[0].name='نام تازه';state.users.find(person=>person.id==='worker').name='نام همکار تازه';state.reports[0].description='ویرایش';state.materials[0].returns[0].quantity=9;
  assert.equal(summary.project.name,'پروژهٔ آزمایش');
  assert.equal(summary.people.find(person=>person.id==='worker').name,'همکار پروژه');
  assert.equal(summary.reports[0].description,'نصب');
  assert.equal(summary.materials[0].quantity,10.25);
});

test('canonical active manager or accountant saves a versioned worksheet without modifying payroll', () => {
  const state=fixture(), beforeReports=structuredClone(state.reports);
  const saved=applyDossierAction(state,actor(state),'project.dossier.save',payload());
  assert.equal(saved.dossier.version,1);
  assert.equal(saved.dossier.workItems[0].total,1125);
  assert.equal(saved.dossier.staffAllocations[0].paidAmount,200);
  assert.equal(saved.dossier.history[0].actorId,'manager');
  assert.deepEqual(state.reports,beforeReports);
  saved.dossier.notes='client mutation';assert.equal(state.projects[0].dossier.notes,'شرح فرم');
  applyDossierAction(state,actor(state,'accountant'),'project.dossier.save',payload({version:1,notes:'ثبت حسابدار'}));
  assert.equal(state.projects[0].dossier.version,2);
  unchanged(state,()=>applyDossierAction(state,actor(state),'project.dossier.save',payload({version:1})),error=>error.status===409);
});

test('worksheet refuses forged roles, removed accounts and financial writes by operational reviewers', () => {
  for(const makeActor of [state=>({...actor(state,'worker'),role:'manager'}),state=>actor(state,'worker'),()=>({id:'missing',role:'manager'})]) {
    const state=fixture();unchanged(state,()=>applyDossierAction(state,makeActor(state),'project.dossier.save',payload()),error=>error.status===403);
  }
  const state=fixture();state.users[0].deletedAt='2026-10-01T00:00:00Z';
  unchanged(state,()=>applyDossierAction(state,state.users[0],'project.dossier.save',payload()),error=>error.status===403);
});

test('worksheet refuses a payment without real manual evidence, duplicates and nonmembers', () => {
  const base=payload();
  const cases=[
    {...base,staffAllocations:[{...base.staffAllocations[0],paymentDate:''}]},
    {...base,staffAllocations:[{...base.staffAllocations[0],paymentReference:''}]},
    {...base,staffAllocations:[{...base.staffAllocations[0],paymentDate:'2026-02-30'}]},
    {...base,staffAllocations:[{...base.staffAllocations[0],paidAmount:1101}]},
    {...base,staffAllocations:[base.staffAllocations[0],base.staffAllocations[0]]},
    {...base,staffAllocations:[{...base.staffAllocations[0],userId:'other'}]},
    {...base,finalLaborAmount:1099},
  ];
  for(const invalid of cases){const state=fixture();unchanged(state,()=>applyDossierAction(state,actor(state),'project.dossier.save',invalid));}
});

test('submitted and approved dossiers lock worksheet edits; returned dossiers allow corrected values', () => {
  for(const status of ['submitted','approved']) {
    const state=fixture();state.projects[0].dossierSubmission={id:'s1',version:1,status};
    unchanged(state,()=>applyDossierAction(state,actor(state),'project.dossier.save',payload()),error=>error.status===409);
  }
  const state=fixture();state.projects[0].dossierSubmission={id:'s1',version:2,status:'changes_requested'};
  applyDossierAction(state,actor(state),'project.dossier.save',payload());
  assert.equal(state.projects[0].dossier.version,1);
});

test('worker summary includes operational evidence while hiding every nested financial field', () => {
  const state=fixture();state.user=actor(state,'worker');state.projects[0].dossier={workItems:[{description:'SECRET_WORKSHEET',quantity:1,unitRate:99}],history:[{paidTotal:9999}]};
  const summary=buildDossierSummary(state,'p1');
  assert.equal(summary.financial,false);
  assert.equal(summary.worksheet,undefined);
  assert.equal(summary.materials[0].cost,undefined);
  assert.equal(summary.reports[0].rate,undefined);
  assert.equal(summary.days[0].reports[0].laborCost,undefined);
  assert.equal(summary.customer.phone,undefined);
  assert.doesNotMatch(JSON.stringify(summary),/SECRET_WORKSHEET|paidTotal|unitRate|laborCost|"rate"/);
  state.user=actor(state,'other');assert.throws(()=>buildDossierSummary(state,'p1'),error=>error.status===403);
});

test('submission projection strips finance recursively and returns independent frozen-source copies', () => {
  const state=fixture();applyDossierAction(state,actor(state),'project.dossier.save',payload());
  const submission={id:'s1',version:4,status:'submitted',snapshot:buildDossierSummary(state,'p1'),approval:{cycle:1,currentStage:1,stages:[{label:'مسئول پروژه',userId:'worker',status:'approved',reviewedAt:'2026-10-04T10:00:00Z',reviewedBy:'worker'},{label:'مسئول واحد',userId:'worker',status:'pending'}],history:[{action:'approved',actorId:'worker',stageIndex:0,at:'2026-10-04T10:00:00Z'}]}};
  const worker=safeDossierSubmission(submission,false);
  assert.equal(worker.snapshot.financial,false);
  assert.equal(worker.snapshot.worksheet,undefined);
  assert.equal(worker.snapshot.materialCost,undefined);
  assert.equal(worker.snapshot.materials[0].cost,undefined);
  assert.equal(worker.snapshot.reports[0].rate,undefined);
  assert.equal(worker.snapshot.days[0].reports[0].laborCost,undefined);
  assert.equal(worker.snapshot.customer.phone,undefined);
  assert.deepEqual(worker.approval,submission.approval);
  assert.equal(safeDossierWorksheet(state.projects[0].dossier,false),undefined);
  const financial=safeDossierSubmission(submission,true);
  assert.equal(financial.snapshot.worksheet.staffAllocations[0].paidAmount,200);
  assert.equal(financial.snapshot.reports[0].laborCost,450000);
  financial.snapshot.project.name='client edit';worker.approval.stages[0].status='pending';
  assert.equal(submission.snapshot.project.name,'پروژهٔ آزمایش');
  assert.equal(submission.approval.stages[0].status,'approved');
});

test('dossier helper has identical browser and deployed Edge implementations', async()=>{
  assert.equal(await readFile('public/dossier-model.mjs','utf8'),await readFile('supabase/functions/arios-api/dossier-model.mjs','utf8'));
});
