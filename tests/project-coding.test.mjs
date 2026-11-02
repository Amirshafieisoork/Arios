import test from 'node:test';
import assert from 'node:assert/strict';
import {PROJECT_SERVICE_TYPES,customerCodeFor,dossierCasesForCustomer,dossierNumber,nextDossierNumber,nextProjectSequence,structuredProjectCode} from '../public/project-coding.mjs';
import {createSeedState,applyAction,publicState,PROJECT_APPROVAL_LABELS} from '../public/domain.mjs';
import {projectConfigurationPayload} from '../public/project-admin.mjs';

const chain=()=>PROJECT_APPROVAL_LABELS.map(label=>({label,userId:'manager'}));
const structuredPayload=(overrides={})=>({
  name:'پروژهٔ نمونه',location:'ساختمان مرکزی',customerId:'customer',memberIds:[],budget:0,contractAmount:0,
  startDate:'2026-10-01',endDate:'2026-10-31',serviceCode:'110',dossierCode:'01',dossierTitle:'پروندهٔ گروه مانا مستر',
  projectManagerId:'manager',reviewChain:chain(),...overrides
});

test('official service catalog and customer/dossier/project code ranges match the supplied coding rules',()=>{
  assert.deepEqual(PROJECT_SERVICE_TYPES.map(item=>item.code),['110','111','112','113','114','115','120','121','122','123','130','131','132','140','141','142']);
  assert.equal(dossierNumber('۱۰۱۵۱-۰۱','10151'),'01');assert.equal(dossierNumber('00','10151'),'');assert.equal(dossierNumber('100','10151'),'');
  const state={users:[{id:'c1',role:'customer'},{id:'c2',role:'customer'}],projects:[]};
  assert.equal(customerCodeFor(state,'c1'),'10000');assert.equal(customerCodeFor(state,'c2'),'10001');
  state.users[0].customerCode='۱۰۱۵۱';assert.equal(customerCodeFor(state,'c1'),'10151');
});

test('dossier numbers and project sequences advance without reusing archived project codes',()=>{
  const state={users:[{id:'c1',role:'customer',customerCode:'10151'}],customerDossiers:[{id:'d1',customerId:'c1',customerCode:'10151',dossierCode:'01',title:'گروه مانا مستر'}],projects:[
    {id:'p1',customerId:'c1',customerCode:'10151',dossierCode:'01',projectCode:'10151-01-110-001'},
    {id:'p2',customerId:'c1',customerCode:'10151',dossierCode:'01',projectCode:'10151-01-110-003',archivedAt:'2026-10-20'}
  ]};
  assert.deepEqual(dossierCasesForCustomer(state,'c1'),[{code:'01',title:'گروه مانا مستر'}]);
  assert.equal(nextDossierNumber(state,'c1'),'02');assert.equal(nextProjectSequence(state,'10151','01','110'),'004');
  assert.deepEqual(structuredProjectCode(state,'c1','01','110'),{customerCode:'10151',dossierCode:'01',serviceCode:'110',projectCode:'10151-01-110-004',type:'زیرساخت'});
});

test('project creation assigns a stable customer code and creates a reusable named dossier',()=>{
  const state=createSeedState();
  const first=applyAction(state,'manager','project.create',structuredPayload({customerCode:'10151'}));
  assert.equal(first.projectCode,'10151-01-110-001');assert.equal(first.customerCode,'10151');assert.equal(first.dossierCode,'01');assert.equal(first.dossierTitle,'پروندهٔ گروه مانا مستر');assert.equal(first.serviceCode,'110');assert.equal(first.type,'زیرساخت');
  assert.equal(state.users.find(person=>person.id==='customer').customerCode,'10151');assert.equal(state.customerDossiers.length,1);
  const second=applyAction(state,'manager','project.create',structuredPayload({name:'پروژهٔ دوم'}));
  assert.equal(second.projectCode,'10151-01-110-002');assert.equal(state.customerDossiers.length,1);
  const third=applyAction(state,'manager','project.create',structuredPayload({name:'برق ساختمان',serviceCode:'111',dossierCode:'02',dossierTitle:'شعبهٔ دوم'}));
  assert.equal(third.projectCode,'10151-02-111-001');assert.equal(state.customerDossiers.length,2);
  const managerView=publicState(state,'manager');
  assert.equal(managerView.users.find(person=>person.id==='customer').customerCode,'10151');
  assert.equal(managerView.customerDossiers.length,2);
});

test('customer codes cannot be reassigned or overlap with another customer',()=>{
  const state=createSeedState();
  state.users.find(person=>person.id==='customer2').customerCode='10151';
  const before=structuredClone(state);
  assert.throws(()=>applyAction(state,'manager','project.create',structuredPayload({customerCode:'10151'})),/اختصاص یافته/);
  assert.deepEqual(state,before);
  const assigned=applyAction(state,'manager','project.create',structuredPayload({customerCode:'10152'}));
  assert.equal(assigned.customerCode,'10152');
  const unchanged=structuredClone(state);
  assert.throws(()=>applyAction(state,'manager','project.create',structuredPayload({customerCode:'10153'})),/قابل تغییر نیست/);
  assert.deepEqual(state,unchanged);
});

test('coded projects reject missing customers, invalid activities, nonsequential case numbers and stale codes atomically',()=>{
  const state=createSeedState();
  const cases=[
    {...structuredPayload(),customerId:''},
    {...structuredPayload(),serviceCode:'999'},
    {...structuredPayload(),customerCode:'100000'},
    {...structuredPayload(),dossierCode:'02'},
    {...structuredPayload(),projectCode:'10000-01-111-001'}
  ];
  for(const payload of cases){const before=structuredClone(state);assert.throws(()=>applyAction(state,'manager','project.create',payload));assert.deepEqual(state,before);}
  const good=applyAction(state,'manager','project.create',structuredPayload());
  const before=structuredClone(state);
  assert.throws(()=>applyAction(state,'manager','project.create',structuredPayload({name:'پروژهٔ تکراری',projectCode:good.projectCode})),error=>error.code==='PROJECT_CODE_STALE');
  assert.deepEqual(state,before);
});

test('the project form prepares a known legacy customer code without asking staff to type a project code',()=>{
  const state={users:[{id:'manager',name:'مدیر',role:'manager'},{id:'customer',name:'مهندس احمدی',role:'customer'}],projects:[]};
  const form=new FormData();form.set('codingMode','structured');form.set('customerId','customer');form.set('customerCode','10151');form.set('dossierChoice','__new__');form.set('dossierTitle','گروه مانا مستر');form.set('serviceCode','110');form.set('projectManagerId','manager');
  for(let index=1;index<6;index++)form.set(`reviewer${index}`,'manager');
  const payload=projectConfigurationPayload(form,state);
  assert.equal(payload.customerCode,'10151');assert.equal(payload.dossierCode,'01');assert.equal(payload.serviceCode,'110');assert.equal(payload.projectCode,'10151-01-110-001');assert.equal(payload.type,'زیرساخت');
  assert.equal(payload.reviewChain.length,6);
});

test('customer dossier and activity sequence limits are enforced',()=>{
  const state={users:[{id:'c1',role:'customer',customerCode:'10151'}],customerDossiers:Array.from({length:99},(_,index)=>({id:`d${index}`,customerId:'c1',customerCode:'10151',dossierCode:String(index+1).padStart(2,'0')})),projects:[]};
  assert.throws(()=>nextDossierNumber(state,'c1'),/سقف ۹۹ پرونده/);
  const full={users:state.users,projects:Array.from({length:999},(_,index)=>({projectCode:`10151-01-110-${String(index+1).padStart(3,'0')}`}))};
  assert.throws(()=>nextProjectSequence(full,'10151','01','110'),/سقف ۹۹۹ پروژه/);
});
