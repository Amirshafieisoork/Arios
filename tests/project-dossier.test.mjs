import test from 'node:test';
import assert from 'node:assert/strict';
import {createSeedState,publicState,applyAction,readDossierSubmission} from '../public/domain.mjs';
import {buildDossierSummary,safeDossierSubmission} from '../public/dossier-model.mjs';
import {renderProjectDossier,renderDossierPrint,wireProjectDossier,setDossierViewer} from '../public/project-dossier.mjs';
import {PROJECT_APPROVAL_LABELS} from '../public/project-admin.mjs';

const escape=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const ctx={e:escape,n:value=>String(Number(value)||0),money:value=>`${Number(value)||0} تومان`,date:value=>value||'—',icon:()=>'',empty:message=>message};
function loadedView(state,userId) {
  const view=publicState(state,userId),project=view.projects.find(item=>item.id==='p1');
  project.dossierSubmission=readDossierSubmission(state,userId,project.id,project.dossierSubmission.id);
  return view;
}
function fixture() {
  const state=createSeedState(),project=state.projects.find(item=>item.id==='p1');
  Object.assign(project,{projectCode:'AR-TEST',projectManagerId:'worker',reviewChain:PROJECT_APPROVAL_LABELS.map((label,index)=>({label,userId:index===0||index===1?'worker':'manager'}))});
  const financeView={...state,user:state.users.find(user=>user.id==='manager')};
  const snapshot=buildDossierSummary(financeView,project.id);
  const submission={id:'snapshot1',version:1,status:'submitted',from:'',to:'',submittedAt:'2026-10-26T09:00:00Z',submittedBy:'manager',snapshot,approval:{cycle:1,currentStage:0,stages:project.reviewChain.map(stage=>({...stage,userName:state.users.find(user=>user.id===stage.userId).name,status:'pending'})),history:[]}};
  project.dossierSubmission=submission;
  return {state,project,submission,snapshot};
}

test('frozen dossier rendering keeps source evidence while current data changes',()=>{
  const f=fixture();
  const source=f.snapshot.reports[0].description;
  f.state.reports.find(row=>row.id===f.snapshot.reports[0].id).description='تغییر پس از ارسال';
  f.state.projects.find(row=>row.id==='p1').name='نام جدید پروژه';
  const view=loadedView(f.state,'manager'),project=view.projects.find(row=>row.id==='p1');
  const html=renderProjectDossier(view,project,ctx);
  assert.ok(html.includes(escape(source)));
  assert.doesNotMatch(html,/تغییر پس از ارسال/);
  assert.match(html,/نسخه.*ثابت است/);
  assert.equal((html.match(/class="dossier-stage /g)||[]).length,6);
  assert.doesNotMatch(html,/data-dossier-edit/);
});

test('worker reviewer sees operational sections and an explicit financial review scope',()=>{
  const f=fixture(),view=loadedView(f.state,'worker'),project=view.projects.find(row=>row.id==='p1');
  const html=renderProjectDossier(view,project,ctx);
  assert.match(html,/کارکرد و شرح اجرا/);
  assert.match(html,/کالای مصرفی و برگشتی/);
  assert.match(html,/تأیید شما بر مبنای بخش‌های قابل مشاهده است/);
  assert.match(html,/data-dossier-review="approved"/);
  assert.doesNotMatch(html,/فی اجرت|دستمزد نهایی توافق‌شده|data-dossier-edit/);
  const printed=renderDossierPrint(project.dossierSubmission.snapshot,project.dossierSubmission,ctx);
  assert.doesNotMatch(printed,/فی اجرت|دستمزد نهایی توافق‌شده/);
  assert.equal((printed.match(/class="dossier-stage /g)||[]).length,6);
});

test('same reviewer holds two separate stages and next-stage evidence updates independently',()=>{
  const f=fixture();
  applyAction(f.state,'worker','project.dossier.review',{projectId:'p1',id:f.submission.id,version:1,status:'approved',reviewNote:'مرحلهٔ نخست'});
  const view=loadedView(f.state,'worker'),project=view.projects.find(row=>row.id==='p1');
  const html=renderProjectDossier(view,project,ctx);
  assert.match(html,/تأیید به عنوان مسئول واحد/);
  assert.match(html,/مرحلهٔ نخست/);
  assert.equal(project.dossierSubmission.approval.stages[0].status,'approved');
  assert.equal(project.dossierSubmission.approval.stages[1].status,'pending');
  assert.equal(project.dossierSubmission.version,2);
});

test('a lazy frozen descriptor never displays current source data before the saved document loads',()=>{
  const f=fixture(),view=publicState(f.state,'worker'),project=view.projects.find(row=>row.id==='p1');
  assert.equal(project.dossierSubmission.snapshot,undefined);
  const html=renderProjectDossier(view,project,ctx);
  assert.match(html,/در حال دریافت نسخهٔ ثبت‌شده/);
  assert.match(html,/data-dossier-print disabled/);
  assert.doesNotMatch(html,/class="dossier-work-entry"|data-dossier-review=/);
});

test('print is standalone Persian A4 and escapes report, project and review content',()=>{
  const f=fixture();
  const attack='</title><script>alert(1)</script>';
  f.snapshot.project.name=attack;f.snapshot.project.projectCode=attack;f.snapshot.reports[0].description=attack;f.snapshot.days[0].reports[0].description=attack;f.submission.approval.stages[0].note=attack;
  const html=renderDossierPrint(f.snapshot,f.submission,ctx);
  assert.match(html,/<!doctype html><html lang="fa" dir="rtl">/);
  assert.match(html,/@page\{size:A4/);
  assert.match(html,/Vazirmatn-400\.ttf/);
  assert.match(html,/&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(html,/<script>|data-dossier-review=/);
  assert.match(html,/کارکرد و شرح اجرا/);
  assert.match(html,/کالای مصرفی و برگشتی/);
  assert.match(html,/اجرت کار و تفکیک پرسنل/);
});

test('safe printable copies never reveal private nested rate fields after source mutation',()=>{
  const f=fixture(),safe=safeDossierSubmission(f.submission,false);
  f.snapshot.reports[0].rate=999999999;f.snapshot.days[0].reports[0].laborCost=999999999;f.snapshot.worksheet={notes:'PRIVATE_FINANCE',staffAllocations:[{wage:999999999}]};
  const html=renderDossierPrint(safe.snapshot,safe,ctx);
  assert.doesNotMatch(html,/PRIVATE_FINANCE|999999999/);
  assert.match(html,/جزئیات مالی فقط برای مدیر و حسابدار نمایش داده می‌شود/);
});

test('lazy reads cannot resurrect after an actor roundtrip or cache a different financial projection',async()=>{
  const f=fixture(),view=publicState(f.state,'worker'),project=view.projects.find(row=>row.id==='p1');
  const previous=globalThis.document;
  let key='',resolveRead,reads=0,renders=0;
  globalThis.document={querySelector:selector=>selector==='.project-dossier'?{dataset:{dossierLoadKey:key}}:null,querySelectorAll:()=>[]};
  const context={...ctx,api:{dossierRead:()=>{reads+=1;return new Promise(resolve=>{resolveRead=resolve;});}},go:()=>{renders+=1;},toast:()=>{},refresh:async()=>{renders+=1;}};
  const render=()=>{const html=renderProjectDossier(view,project,context);key=/data-dossier-load-key="([^"]*)"/.exec(html)?.[1]||'';return html;};
  const settle=()=>new Promise(resolve=>setImmediate(resolve));
  try {
    setDossierViewer(null);render();wireProjectDossier(view,project,context);assert.equal(reads,1);
    setDossierViewer({id:'other',role:'worker'});setDossierViewer(view.user);
    resolveRead({dossierSubmission:readDossierSubmission(f.state,'worker','p1',f.submission.id)});await settle();
    assert.equal(renders,0,'an old response must not render after A to B to A');
    assert.match(render(),/در حال دریافت نسخهٔ ثبت‌شده/);
    wireProjectDossier(view,project,context);assert.equal(reads,2);
    resolveRead({dossierSubmission:readDossierSubmission(f.state,'manager','p1',f.submission.id)});await settle();
    const rejected=render();assert.match(rejected,/نسخهٔ معتبر و مجاز گزارش دریافت نشد/);assert.doesNotMatch(rejected,/فی اجرت|class="dossier-work-entry"/);
    setDossierViewer(null);render();wireProjectDossier(view,project,context);
    resolveRead({dossierSubmission:readDossierSubmission(f.state,'worker','p1',f.submission.id)});await settle();
    assert.match(render(),/کارکرد و شرح اجرا/);
  } finally {globalThis.document=previous;setDossierViewer(null);}
});
