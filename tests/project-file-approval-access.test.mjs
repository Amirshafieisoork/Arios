import test from 'node:test';
import assert from 'node:assert/strict';
import {createSeedState} from '../public/domain.mjs';
import {handleProjectFiles} from '../supabase/functions/arios-api/project-files.mjs';

const labels=['مسئول پروژه','مسئول واحد','مدیر گروه فنی','واحد فروش','واحد مالی','مدیرعامل'];
const stages=userId=>labels.map((label,index)=>({label,userId:index===1?userId:'manager',status:'pending'}));

function fixture() {
  const state=createSeedState(),project=state.projects.find(item=>item.id==='p1');
  state.users.push({id:'reviewer',name:'بررسی‌کننده',role:'worker'},{id:'former-reviewer',name:'بررسی‌کننده پیشین',role:'worker'},{id:'review-accountant',name:'حسابدار',role:'accountant'});
  project.projectManagerId='manager';
  project.reviewChain=stages('reviewer');
  const file=(id,mimeType='image/png',extra={})=>({id,name:id+(mimeType==='application/pdf'?'.pdf':'.png'),mimeType,size:8,uploadedBy:'worker',status:'ready',storagePath:`projects/p1/worker/${id}.${mimeType==='application/pdf'?'pdf':'png'}`,...extra});
  project.files=[file('live-photo','image/png',{reportId:'live-report'}),file('frozen-photo','image/png',{reportId:'old-report'}),file('unrelated'),file('document','application/pdf'),file('draft','image/png',{draftId:'private-draft',uploadedBy:'reviewer',storagePath:'projects/p1/reviewer/draft.png'})];
  state.reports.push({id:'live-report',projectId:'p1',workerId:'worker',date:'2026-10-24',start:'09:00',end:'10:00',minutes:60,status:'approved',photoIds:['live-photo','document']});
  const signed=[];
  const repo={loadState:async()=>({state:structuredClone(state)}),rateLimit:async()=>({allowed:true})};
  const bucket={createSignedUrl:async(path,ttl)=>{signed.push({path,ttl});return{data:{signedUrl:'https://storage.example/'+path}};}};
  const handle=(actor,id,operation='download')=>handleProjectFiles({repo,supabase:{storage:{from:()=>bucket}},user:typeof actor==='string'?state.users.find(user=>user.id===actor):actor,request:new Request('https://edge.example/api/project-files/'+operation,{method:'POST'}),path:'/api/project-files/'+operation,readJSON:async()=>({projectId:'p1',id,fileName:'photo.png',mimeType:'image/png',size:8}),json:data=>data});
  return{state,project,signed,handle};
}
const forbidden=promise=>assert.rejects(promise,error=>error.status===403&&error.code==='FORBIDDEN');

test('configured review-only worker downloads report evidence but cannot read unrelated files, PDFs or drafts',async()=>{
  const f=fixture();
  assert.equal((await f.handle('reviewer','live-photo')).expiresIn,90);
  for(const id of ['unrelated','document','draft','frozen-photo'])await forbidden(f.handle('reviewer',id));
  assert.equal(f.signed.length,1);
});

test('review-only permissions never authorize upload reservation or completion',async()=>{
  const f=fixture();
  await forbidden(f.handle('reviewer','live-photo','upload-url'));
  await forbidden(f.handle('reviewer','live-photo','complete'));
  assert.equal(f.signed.length,0);
});

test('accountant financial visibility alone cannot download project attachments',async()=>{
  const f=fixture(),accountant=f.state.users.find(user=>user.role==='accountant');
  assert(accountant);
  await forbidden(f.handle(accountant.id,'live-photo'));
  f.project.reviewChain[4].userId=accountant.id;
  await f.handle(accountant.id,'live-photo');
  await forbidden(f.handle(accountant.id,'unrelated'));
  await forbidden(f.handle(accountant.id,'live-photo','upload-url'));
  assert.equal(f.signed.length,1);
});

test('frozen current and archived reviewers see only their assigned snapshot evidence',async()=>{
  const f=fixture();
  f.project.dossierSubmission={id:'submission1',approval:{stages:stages('former-reviewer')},snapshot:{reports:[{id:'old-report',photoIds:['frozen-photo']}]}};
  await f.handle('former-reviewer','frozen-photo');
  await forbidden(f.handle('former-reviewer','live-photo'));
  f.project.dossierSubmissionHistory=[f.project.dossierSubmission];
  f.project.dossierSubmission={id:'submission2',approval:{stages:stages('reviewer')},snapshot:{reports:[{id:'live-report',photoIds:['live-photo']}]}};
  await f.handle('former-reviewer','frozen-photo');
  await forbidden(f.handle('former-reviewer','live-photo'));
  assert.equal(f.signed.length,2);
});

test('revoked reviewer assignments, deleted accounts and stale roles cannot sign evidence URLs',async()=>{
  const f=fixture();
  f.project.reviewChain=stages('manager');
  await forbidden(f.handle('reviewer','live-photo'));
  f.project.reviewChain=stages('reviewer');
  const stale=structuredClone(f.state.users.find(user=>user.id==='reviewer'));
  f.state.users.find(user=>user.id==='reviewer').role='customer';
  await forbidden(f.handle(stale,'live-photo'));
  f.state.users.find(user=>user.id==='reviewer').role='worker';
  f.state.users.find(user=>user.id==='reviewer').deletedAt='2026-10-26T00:00:00Z';
  await forbidden(f.handle('reviewer','live-photo'));
  assert.equal(f.signed.length,0);
});

test('existing execution members, managers and client-visible customer downloads retain their scope',async()=>{
  const f=fixture();
  await f.handle('worker','unrelated');
  await f.handle('manager','unrelated');
  await forbidden(f.handle('customer','unrelated'));
  f.project.files.find(file=>file.id==='unrelated').clientVisible=true;
  await f.handle('customer','unrelated');
  assert.equal(f.signed.length,3);
});
