import test from 'node:test';
import assert from 'node:assert/strict';
import {currentDossierStage,dossierAwaitingMe,dossierReviewCount,renderProjectReviewInbox} from '../public/project-review-inbox.mjs';
import {portalNotifications,reportProjects} from '../public/portal-workflows.mjs';

const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const ctx={e:escape,n:String};
function project(status='submitted',currentStage=0){return {id:'paper/1',name:'پروژه <الف>',projectCode:'AR-001',dossierSubmission:{id:'submission-1',status,approval:{currentStage,stages:[{label:'مسئول پروژه',userId:'reviewer'},{label:'مسئول واحد',userId:'reviewer'},{label:'مدیر گروه فنی',userId:'other'},{label:'واحد فروش',userId:'other'},{label:'واحد مالی',userId:'other'},{label:'مدیرعامل',userId:'other'}]}}};}

test('aggregate inbox points to the current explicit responsibility, including a shared second role',()=>{
  const user={id:'reviewer',role:'worker'};
  const p=project();assert.equal(currentDossierStage(p).label,'مسئول پروژه');assert(dossierAwaitingMe(p,user));
  p.dossierSubmission.approval.currentStage=1;
  assert.equal(currentDossierStage(p).label,'مسئول واحد');assert(dossierAwaitingMe(p,user));
  p.dossierSubmission.approval.currentStage=2;assert(!dossierAwaitingMe(p,user));
  for(const status of ['approved','changes_requested','rejected']){p.dossierSubmission.status=status;assert.equal(currentDossierStage(p),null);assert(!dossierAwaitingMe(p,user));}
  assert(!dossierAwaitingMe(project(),{...user,deletedAt:'2026-10-25'}));
  assert(!dossierAwaitingMe(project(),{...user,role:'customer'}));
});

test('review queue counts only this reviewer and links to the aggregate dossier without a write action',()=>{
  const state={user:{id:'reviewer',role:'accountant'},users:[{id:'reviewer',name:'حسابدار'}],projects:[project(),{id:'blank',name:'پروژه تازه'},project('approved')]};
  assert.equal(dossierReviewCount(state),1);
  const html=renderProjectReviewInbox(state,ctx);
  assert(html.includes('#project/paper%2F1/dossier'));assert(html.includes('در انتظار مسئول پروژه: حسابدار'));assert(html.includes('پروژه &lt;الف&gt;'));assert(!html.includes('پروژه <الف>'));
  assert(html.includes('1 در انتظار تأیید من'));assert(!html.includes('<form'));assert(!html.includes('data-review'));
  assert(!renderProjectReviewInbox(state,ctx,{projectId:'blank'}).includes('AR-001'));
  assert.equal(renderProjectReviewInbox({...state,user:{role:'customer'}},ctx),'');
});

test('follow-up notification names the current aggregate role without opening operational report entry',()=>{
  const p={...project(),canRecordWork:false,memberIds:[]};
  const state={user:{id:'reviewer',role:'worker'},projects:[p],users:[]};
  const notifications=portalNotifications(state);
  assert.equal(notifications.length,1);assert.equal(notifications[0].kind,'dossier');assert.match(notifications[0].title,/مسئول پروژه/);assert.equal(notifications[0].href,'#project/paper%2F1/dossier');
  p.dossierSubmission.approval.currentStage=1;
  assert.equal(portalNotifications(state).length,1);assert.match(portalNotifications(state)[0].title,/مسئول واحد/);
  p.dossierSubmission.approval.currentStage=2;
  assert.equal(portalNotifications(state).length,0);assert.deepEqual(reportProjects(state),[]);
});
