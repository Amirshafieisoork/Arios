import test from 'node:test';
import assert from 'node:assert/strict';
import {applyAction,createSeedState,publicState,PROJECT_APPROVAL_LABELS} from '../public/domain.mjs';
import {buildDossierSummary,safeDossierSubmission} from '../public/dossier-model.mjs';
import {managementEditPayload} from '../public/admin-workspace.mjs';

function fixture(){
 const state=createSeedState();
 const project=applyAction(state,'manager','project.create',{codingVersion:1,customerId:'customer',customerCode:'10151',createDossier:true,dossierTitle:'گروه مانا مستر',serviceCode:'110',name:'پروژه اول زیرساخت',location:'تهران',memberIds:['worker'],budget:100,contractAmount:200,startDate:'2026-11-01',endDate:'2026-12-01',description:'',projectManagerId:'manager',reviewChain:PROJECT_APPROVAL_LABELS.map(label=>({label,userId:'manager'}))});
 return {state,project};
}

test('structured identity survives generic maintenance, project financial edits and dossier summary projections',()=>{
 const {state,project}=fixture(),code='10151-01-110-001';
 const managed=publicState(state,'manager').management.projects.find(row=>row.id===project.id);
 for(const key of ['codingVersion','dossierId','dossierNumber','serviceCode','projectNumber'])assert.equal(managed[key],project[key]);
 const form=new FormData();form.set('name','زیرساخت ساختمان مرکزی');form.set('type','برق ساختمان');form.set('contractAmount','250');
 const payload=managementEditPayload('projects',managed,form);assert.equal(payload.changes.type,undefined);
 applyAction(state,'manager','admin.record.update',payload);
 const updated=state.projects.find(row=>row.id===project.id);assert.equal(updated.projectCode,code);assert.equal(updated.type,'زیرساخت');assert.equal(updated.contractAmount,250);
 const summary=buildDossierSummary({...state,user:state.users.find(row=>row.id==='manager')},project.id);
 const safe=safeDossierSubmission({snapshot:summary},true);
 for(const key of ['codingVersion','dossierId','dossierNumber','serviceCode','projectNumber','type'])assert.equal(safe.snapshot.project[key],updated[key]);
});

test('dossier rename updates live identity while submitted historical report identity stays frozen',()=>{
 const {state,project}=fixture();
 applyAction(state,'manager','material.create',{projectId:project.id,name:'کابل آزمایشی',unit:'متر',quantity:1,unitPrice:1,date:'2026-11-01',clientVisible:false});
 applyAction(state,'manager','project.dossier.submit',{projectId:project.id,version:0});
 const frozen=structuredClone(state.projects.find(row=>row.id===project.id).dossierSubmission);
 applyAction(state,'manager','customer-dossier.update',{id:project.dossierId,title:'ساختمان مرکزی مانا مستر'});
 const updated=state.projects.find(row=>row.id===project.id);
 assert.equal(updated.dossierTitle,'ساختمان مرکزی مانا مستر');assert.equal(updated.projectCode,'10151-01-110-001');
 assert.deepEqual(updated.dossierSubmission,frozen);assert.equal(frozen.snapshot.project.dossierTitle,'گروه مانا مستر');
});
