import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {SERVICE_TYPES} from '../public/project-coding.mjs';
import {projectCodingFields,projectCodingPayload,projectCodePreview} from '../public/project-coding-form.mjs';
import {projectConfigurationFields,projectConfigurationPayload,projectMatchesQuery,renderProjectIdentity,openCustomerDossierRename} from '../public/project-admin.mjs';

const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const ctx={e:escape,n:String};
const state={user:{id:'manager',role:'manager'},users:[{id:'manager',role:'manager',name:'مدیر'},{id:'client',role:'customer',name:'مهندس احمدی',customerCode:'10151'},{id:'other',role:'customer',name:'مشتری دوم',customerCode:'10152'}],customerDossiers:[{id:'case1',customerId:'client',customerCode:'10151',number:'01',code:'10151-01',title:'گروه مانا مستر'},{id:'case2',customerId:'other',customerCode:'10152',number:'01',code:'10152-01',title:'شعبه دوم'}],projects:[{id:'p',customerId:'client',customerCode:'10151',dossierCode:'10151-01',serviceCode:'110',projectNumber:'001',projectCode:'10151-01-110-001'}]};
const fields=value=>{const f=new FormData();for(const[key,item]of Object.entries(value))f.set(key,item);return f;};
const responsibilities=f=>{f.set('projectManagerId','manager');for(let i=1;i<6;i++)f.set('reviewer'+i,'manager');return f;};

test('project preview follows independent customer, dossier and service numbering',()=>{
  assert.equal(projectCodePreview(state,{customerId:'client',dossierId:'case1',serviceCode:'110'}).code,'10151-01-110-002');
  assert.equal(projectCodePreview(state,{customerId:'client',dossierId:'case1',serviceCode:'111'}).code,'10151-01-111-001');
  assert.equal(projectCodePreview(state,{customerId:'other',dossierId:'case2',serviceCode:'110'}).code,'10152-01-110-001');
  assert.equal(projectCodePreview(state,{customerId:'client',dossierId:'__new__',serviceCode:'110'}).code,'10151-02-110-001');
  assert.equal(projectCodePreview(state,{customerId:'client',customerCode:'99999',dossierId:'case1',serviceCode:'110'}).customerCode,'10151');
  const archived=structuredClone(state);archived.customerDossiers[0].archivedAt='2026-11-06';archived.projects[0].archivedAt='2026-11-06';
  assert.equal(projectCodePreview(archived,{customerId:'client',dossierId:'__new__',serviceCode:'110'}).code,'10151-02-110-001');
});

test('payload supports new and existing dossiers and leaves automatic allocation to the server',()=>{
  const existing=fields({codingVersion:'1',customerId:'client',customerCode:'۱۰۱۵۱',dossierId:'case1',serviceCode:'۱۱۰'});
  const result=projectCodingPayload(existing);
  assert.deepEqual(result,{codingVersion:1,customerId:'client',customerCode:'10151',serviceCode:'110',dossierId:'case1'});
  assert(!('projectNumber'in result));assert(!('projectCode'in result));
  const fresh=fields({customerId:'client',dossierId:'__new__',dossierTitle:' گروه مانا مستر ',dossierNumber:'۲',serviceCode:'۱۱۱',projectNumber:'۳'});
  assert.deepEqual(projectCodingPayload(fresh),{codingVersion:1,customerId:'client',serviceCode:'111',createDossier:true,dossierTitle:'گروه مانا مستر',dossierNumber:'02',projectNumber:'003'});
  const configured=projectConfigurationPayload(responsibilities(existing));
  assert.equal(configured.reviewChain.length,6);assert.equal(configured.codingVersion,1);assert(!('projectCode'in configured));
});

test('hierarchy inputs reject missing entities, invalid ranges and non-catalogue services',()=>{
  const base={customerId:'client',customerCode:'10151',dossierId:'__new__',dossierTitle:'ساختمان',serviceCode:'110'};
  for(const [patch,pattern]of [[{customerId:''},/مشتری پروژه/],[{customerCode:'9999'},/پنج‌رقمی/],[{customerCode:'100000'},/پنج‌رقمی/],[{serviceCode:'999'},/نوع خدمات/],[{dossierId:''},/پروندهٔ مشتری/],[{dossierTitle:' '},/نام پرونده/],[{dossierNumber:'00'},/۰۱ تا ۹۹/],[{dossierNumber:'100'},/۰۱ تا ۹۹/],[{projectNumber:'000'},/۰۰۱ تا ۹۹۹/],[{projectNumber:'1000'},/۰۰۱ تا ۹۹۹/]])assert.throws(()=>projectCodingPayload(fields({...base,...patch})),pattern);
});

test('new project uses a single customer selector, all service codes and a readable advisory preview',async()=>{
  const html=projectConfigurationFields(state,ctx);
  assert.equal((html.match(/name="customerId"/g)||[]).length,1);
  assert(!html.includes('name="projectCode"'));assert(html.includes('data-coding-preview'));assert(html.includes('10151'));
  for(const service of SERVICE_TYPES)assert(html.includes(`value="${service.code}"`));
  assert(html.includes('aria-live="polite"'));assert(html.includes('ثبت شمارهٔ پروژهٔ موجود'));
  const app=await readFile(new URL('../public/app.mjs',import.meta.url),'utf8');
  const create=app.slice(app.indexOf('function openProject(){'),app.indexOf('function openProjectUpdate'));
  assert(create.includes('wireProjectCodingForm(state,workflowContext())'));
  assert(!create.includes("catalogSelect(state,'projectTypes'"));assert(!create.includes("type:f.get('type')"));
});

test('structured updates cannot accidentally blank or reassign customer and project identity',()=>{
  const project={...state.projects[0],codingVersion:1,dossierTitle:'گروه مانا مستر',projectManagerId:'manager'};
  const html=projectConfigurationFields(state,ctx,project);
  assert(html.includes('10151-01-110-001'));assert(html.includes('data-project-coding-fixed'));
  for(const name of ['projectCode','customerId','customerCode','dossierId','dossierNumber','serviceCode','projectNumber'])assert(!html.includes(`name="${name}"`));
  const payload=projectConfigurationPayload(responsibilities(fields({projectCodingFixed:'1'})));
  assert.equal(payload.projectManagerId,'manager');assert.equal(payload.reviewChain.length,6);
  for(const key of ['projectCode','customerId','customerCode','dossierCode','dossierTitle','codingVersion'])assert(!Object.hasOwn(payload,key));
});

test('legacy update remains available and conversion requires an explicit selection',()=>{
  const html=projectConfigurationFields(state,ctx,{id:'legacy',projectCode:'AR-1405-007',customerId:'client'});
  assert(html.includes('value="AR-1405-007"'));assert(html.includes('data-coding-convert'));assert(html.includes('data-coding-conversion hidden disabled'));
  const payload=projectConfigurationPayload(responsibilities(fields({projectCode:'AR-۱۴۰۵-۰۰۷',customerId:'client',customerCode:'OLD'})));
  assert.equal(payload.projectCode,'AR-1405-007');assert.equal(payload.customerId,'client');assert(!Object.hasOwn(payload,'codingVersion'));
});

test('identity and search expose the customer, dossier, service and project sequence without unsafe markup',()=>{
  const project={...state.projects[0],codingVersion:1,name:'زیرساخت',dossierTitle:'<script>ساختمان</script>',projectManagerId:'manager'};
  const html=renderProjectIdentity(state,project,ctx);
  assert(html.includes('10151-01-110-001'));assert(html.includes('نوع خدمات'));assert(html.includes('شمارهٔ پروژه در پرونده و خدمات'));
  assert(!html.includes('<script>'));assert(html.includes('&lt;script&gt;'));
  assert(projectMatchesQuery(project,'مهندس احمدی',state.users));assert(projectMatchesQuery(project,'۱۰۱۵۱',state.users));assert(projectMatchesQuery(project,'۱۰۱۵۱ـ۰۱ـ۱۱۰ـ۰۰۱',state.users));
});

test('authorized dossier rename updates only the canonical title and remains unavailable to read-only users',async()=>{
  const project={...state.projects[0],codingVersion:1,dossierId:'case1',dossierTitle:'گروه مانا مستر'};let opened;const mutations=[];
  openCustomerDossierRename(state,{...ctx,modal:value=>opened=value,mutate:async(action,payload)=>mutations.push({action,payload})},project);
  assert(opened);assert(opened.body.includes('گروه مانا مستر'));assert(!opened.body.includes('name="projectCode"'));
  await opened.onSubmit(fields({dossierTitle:' نام تازه '}));assert.deepEqual(mutations,[{action:'customer-dossier.update',payload:{id:'case1',title:'نام تازه'}}]);
  assert(renderProjectIdentity(state,project,ctx).includes('data-action="rename-customer-dossier"'));
  const readOnly={...state,user:{...state.users[1]}};opened=null;
  openCustomerDossierRename(readOnly,{...ctx,modal:value=>opened=value},project);assert.equal(opened,null);
  assert(!renderProjectIdentity(readOnly,project,ctx).includes('data-action="rename-customer-dossier"'));
});
