import test from 'node:test';
import assert from 'node:assert/strict';
import {PROJECT_APPROVAL_LABELS,projectLabel,projectViewPermissions,projectMatchesQuery,projectConfigurationFields,projectConfigurationPayload,renderProjectIdentity,renderProjectReviewChain} from '../public/project-admin.mjs';
import {allowedPortalPage,portalNavigation} from '../public/access.mjs';

const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const ctx={e:escape,n:String};
const state={user:{id:'owner',role:'manager'},users:[
  {id:'owner',name:'مدیر مجموعه',role:'manager'},
  {id:'lead',name:'مسئول اجرا',role:'worker'},
  {id:'finance',name:'حسابدار',role:'accountant'},
  {id:'archived',name:'عضو بایگانی',role:'worker',deletedAt:'2026-10-20T00:00:00Z'},
  {id:'client',name:'مشتری',role:'customer'},
  {id:'store',name:'انباردار',role:'warehouse'},
]};
function configuration(){
  const f=new FormData();
  f.set('projectCode',' ar-۱۴۰۵-۰۰۱ ');f.set('customerCode',' ۱۲۳ ');f.set('dossierCode',' case-۱۲ ');f.set('dossierTitle',' پرونده شمال ');
  f.set('projectManagerId','lead');
  for(const [index,id] of ['lead','owner','owner','finance','owner'].entries())f.set('reviewer'+(index+1),id);
  return f;
}

test('project configuration keeps all six responsibilities and permits the same account in two stages',()=>{
  const payload=projectConfigurationPayload(configuration());
  assert.equal(payload.projectCode,'AR-1405-001');assert.equal(payload.customerCode,'123');assert.equal(payload.dossierCode,'CASE-12');assert.equal(payload.dossierTitle,'پرونده شمال');
  assert.equal(payload.reviewChain.length,6);assert.deepEqual(payload.reviewChain.map(stage=>stage.label),PROJECT_APPROVAL_LABELS);
  assert.equal(payload.reviewChain[0].userId,'lead');assert.equal(payload.reviewChain[1].userId,'lead');
  const missing=configuration();missing.delete('reviewer4');assert.throws(()=>projectConfigurationPayload(missing),/هر شش/);
  const noCode=configuration();noCode.set('projectCode',' ');assert.throws(()=>projectConfigurationPayload(noCode),/کد پروژه/);
});

test('manager form requires actual active reviewers without inventing codes or choosing accounts',()=>{
  const html=projectConfigurationFields(state,ctx);
  assert(html.includes('name="projectCode"'));assert(html.includes('name="projectManagerId"'));assert(!html.includes(' selected'));
  assert.equal((html.match(/<select /g)||[]).length,6);
  for(const id of ['archived','client','store'])assert(!html.includes(`value="${id}"`));
  const first=html.slice(html.indexOf('<select name="projectManagerId"'),html.indexOf('</select>',html.indexOf('<select name="projectManagerId"')));
  assert(!first.includes('value="finance"'));assert(html.includes('value="finance"'));
  assert.match(html,/انتخاب یک نفر برای دو مسئولیت مجاز/);
});

test('project identity and search use official codes and responsible names with Persian digit normalization',()=>{
  const project={name:'ساختمان مرکزی',projectCode:'AR-1405-001',projectManagerId:'lead',dossierCode:'CASE-12',dossierTitle:'پرونده غرب'};
  assert.equal(projectLabel(project),'AR-1405-001 · ساختمان مرکزی');
  assert(projectMatchesQuery(project,'ar-۱۴۰۵-۰۰۱',state.users));assert(projectMatchesQuery(project,'مسئول اجرا',state.users));assert(projectMatchesQuery(project,'پرونده غرب',state.users));assert(!projectMatchesQuery(project,'ناشناخته',state.users));
  const html=renderProjectIdentity(state,{...project,dossierTitle:'<script>bad</script>'},ctx);
  assert(html.includes('AR-1405-001'));assert(html.includes('مسئول اجرا'));assert(html.includes('&lt;script&gt;'));assert(!html.includes('<script>'));
  assert.match(renderProjectIdentity(state,{name:'قدیمی'},ctx),/ثبت نشده/);
});

test('six-stage display never merges duplicate reviewers and accountant navigation exposes review without administration',()=>{
  const project={projectManagerId:'lead',reviewChain:PROJECT_APPROVAL_LABELS.map(label=>({label,userId:'lead'}))};
  const html=renderProjectReviewChain(state,project,ctx);
  assert.equal((html.match(/<li>/g)||[]).length,6);for(const label of PROJECT_APPROVAL_LABELS)assert(html.includes(label));
  assert(allowedPortalPage('reports','accountant'));assert(allowedPortalPage('project','accountant'));
  for(const page of ['projects','team','voice','inventory'])assert(!allowedPortalPage(page,'accountant'));
  assert(portalNavigation('accountant').main.some(([page])=>page==='reports'));
});


test('read-only project reviewers receive dossier and reports tabs without execution controls',()=>{
  for(const role of ['worker','accountant']){
    const access=projectViewPermissions({canRecordWork:false},{role});
    assert(access.reviewOnly);assert(!access.canRecord);
    assert(access.tabs.reports);assert(access.tabs.dossier);
    for(const name of ['tasks','materials','files','messages','support'])assert(!access.tabs[name]);
    assert.equal(Boolean(access.tabs.finance),role==='accountant');
  }
  const execution=projectViewPermissions({canRecordWork:true},{role:'worker'});
  assert(execution.canRecord);assert(execution.tabs.tasks);assert(execution.tabs.files);assert(!execution.tabs.finance);
  const customer=projectViewPermissions({canRecordWork:false},{role:'customer'});
  assert(customer.tabs.finance);assert(!customer.tabs.dossier);assert(!customer.tabs.reports);assert(!customer.canRecord);
});
