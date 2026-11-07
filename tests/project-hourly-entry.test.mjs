import test from 'node:test';
import assert from 'node:assert/strict';
import {createSeedState,publicState,applyAction} from '../public/domain.mjs';
import {canRecordProjectHours,hourlyReportMinutes} from '../public/project-workspace.mjs';

test('project hourly entry requires assigned execution membership and report permission',()=>{
 const state=createSeedState(),worker=publicState(state,'worker');
 const assigned=worker.projects.find(project=>project.id==='p1');
 assert.equal(canRecordProjectHours(worker,assigned),true);
 assert.equal(canRecordProjectHours(worker,{...assigned,memberIds:[]}),false);
 assert.equal(canRecordProjectHours(worker,{...assigned,canRecordWork:false}),false);
 assert.equal(canRecordProjectHours(worker,{...assigned,archivedAt:'2026-11-07'}),false);
 state.users.find(person=>person.id==='worker').permissions={'reports.submit':false};
 assert.equal(canRecordProjectHours(publicState(state,'worker'),assigned),false);
 assert.equal(canRecordProjectHours(publicState(state,'customer'),assigned),false);
 const manager=publicState(state,'manager');
 assert.equal(canRecordProjectHours(manager,manager.projects.find(project=>project.id==='p1')),true);
 assert.equal(canRecordProjectHours(manager,{...assigned,memberIds:[]}),false);
});

test('entered hours and breaks produce the same net minutes in preview and saved project report',()=>{
 const state=createSeedState(),input={projectId:'p1',date:'2026-11-07',start:'08:15',end:'10:45',breakMinutes:15,description:'اجرای کابل‌کشی طبقهٔ اول',output:'آزمایش اتصال انجام شد'};
 assert.equal(hourlyReportMinutes(input),135);
 const draft=applyAction(state,'worker','report.draft.save',input);
 const report=applyAction(state,'worker','report.create',{...input,draftId:draft.id});
 assert.equal(report.projectId,'p1');assert.equal(report.workerId,'worker');assert.equal(report.minutes,135);assert.equal(report.status,'submitted');
 const saved=state.reports.find(row=>row.id===report.id);assert.equal(saved.minutes,135);assert.equal(saved.laborCost,0);
 for(const patch of [{start:''},{end:''},{start:'25:00'},{start:'11:00'},{breakMinutes:150},{breakMinutes:-1}])assert.equal(hourlyReportMinutes({...input,...patch}),null);
 const before=structuredClone(state);
 assert.throws(()=>applyAction(state,'worker','report.create',{...input,start:'11:00'}));assert.deepEqual(state,before);
});

test('editing project name and public title preserves its official identity and existing records',()=>{
 const state=createSeedState(),project=state.projects.find(row=>row.id==='p1');
 project.projectCode='10151-01-110-001';
 const reports=structuredClone(state.reports),invoices=structuredClone(state.invoices);
 const saved=applyAction(state,'manager','project.update',{id:'p1',name:'ساختمان مرکزی مانا',publicTitle:'پروژهٔ زیرساخت مانا'});
 assert.equal(saved.name,'ساختمان مرکزی مانا');assert.equal(saved.publicTitle,'پروژهٔ زیرساخت مانا');assert.equal(saved.projectCode,'10151-01-110-001');
 assert.deepEqual(state.reports,reports);assert.deepEqual(state.invoices,invoices);
});
