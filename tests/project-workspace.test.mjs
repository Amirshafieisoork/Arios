import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createSeedState,publicState,applyAction} from '../public/domain.mjs';
import {handleProjectFiles,detectProjectFileType} from '../supabase/functions/arios-api/project-files.mjs';
import {downloadProjectFile,uploadProjectFile} from '../public/project-workspace.mjs';
const report={projectId:'p1',workerId:'worker',date:'2026-10-24',start:'09:00',end:'12:00',breakMinutes:0,description:'اجرای کابل و آزمایش شبکه',output:'آزمایش انجام شد'};
const location={latitude:35.7,longitude:51.4,accuracy:8,capturedAt:'2026-10-24T08:00:00Z'};
function unchanged(state,callback,code){const before=structuredClone(state);assert.throws(callback,error=>error.code===code);assert.deepEqual(state,before);}

test('project tasks enforce assignment, live membership, optimistic version, and manager-only planning',()=>{
  const state=createSeedState();
  const task=applyAction(state,'manager','task.create',{projectId:'p1',title:'تست شبکه',assigneeId:'worker',dueDate:'2026-10-25'});
  unchanged(state,()=>applyAction(state,'worker2','task.update',{projectId:'p1',id:task.id,version:1,status:'done'}),'FORBIDDEN');
  const updated=applyAction(state,'worker','task.update',{projectId:'p1',id:task.id,version:1,status:'done'});
  assert.equal(updated.status,'done');assert.equal(updated.version,2);
  unchanged(state,()=>applyAction(state,'manager','task.update',{projectId:'p1',id:task.id,version:1,status:'open'}),'VERSION_CONFLICT');
  unchanged(state,()=>applyAction(state,'customer','task.create',{projectId:'p1',title:'تست'}),'FORBIDDEN');
  state.users.find(user=>user.id==='worker2').deletedAt=new Date().toISOString();
  unchanged(state,()=>applyAction(state,'manager','task.create',{projectId:'p1',title:'تست',assigneeId:'worker2'}),'INVALID_INPUT');
  assert.equal(publicState(state,'customer').projects[0].tasks,undefined);
});

test('server report drafts remain author-only and submission is idempotent without a second report',()=>{
  const state=createSeedState();
  const draft=applyAction(state,'worker','report.draft.save',{...report,description:'',location});
  assert.equal(publicState(state,'manager').reportDrafts.length,0);
  assert.equal(publicState(state,'worker2').reportDrafts.length,0);
  assert.equal(publicState(state,'worker').reportDrafts[0].id,draft.id);
  unchanged(state,()=>applyAction(state,'worker2','report.draft.save',{...report,id:draft.id,version:1}),'FORBIDDEN');
  const length=state.reports.length,created=applyAction(state,'worker','report.create',{...report,draftId:draft.id,location});
  assert.equal(state.reports.length,length+1);assert.equal(created.location.latitude,35.7);
  assert.deepEqual(applyAction(state,'worker','report.create',{...report,draftId:draft.id}),created);
  assert.equal(state.reports.length,length+1);assert.equal(publicState(state,'worker').reportDrafts.length,0);
  state.projects[0].memberIds=state.projects[0].memberIds.filter(id=>id!=='worker');
  unchanged(state,()=>applyAction(state,'worker','report.create',{...report,draftId:draft.id}),'FORBIDDEN');
});

test('report location and photos are validated, draft media stays private, moving reports clears old attachments',()=>{
  const state=createSeedState();
  const draft=applyAction(state,'worker','report.draft.save',report);
  state.projects[0].files=[{id:'photo1',name:'site.jpg',mimeType:'image/jpeg',size:4,uploadedBy:'worker',status:'ready',storagePath:'secret-path',draftId:draft.id,createdAt:'2026-10-24T08:00:00Z',clientVisible:false}];
  assert.equal(publicState(state,'worker2').projects[0].files.length,0);
  assert.equal(publicState(state,'manager').projects[0].files.length,0);
  assert(!JSON.stringify(publicState(state,'worker')).includes('secret-path'));
  unchanged(state,()=>applyAction(state,'worker','report.create',{...report,location:{...location,latitude:91}}),'INVALID_INPUT');
  const created=applyAction(state,'worker','report.create',{...report,draftId:draft.id,photoIds:['photo1'],location});
  assert.equal(publicState(state,'worker2').projects[0].files.length,1);
  assert.equal(publicState(state,'customer').projects[0].files.length,0);
  const moved=applyAction(state,'worker','report.update',{...report,id:created.id,version:1,projectId:'p3'});
  assert.equal(moved.location,null);assert.deepEqual(moved.photoIds,[]);
});

test('team availability and work schedule are real manager-managed values only',()=>{
  const state=createSeedState();
  applyAction(state,'manager','team.schedule',{id:'worker',availability:'busy',workStart:'08:30',workEnd:'17:00'});
  assert.equal(publicState(state,'manager').users.find(user=>user.id==='worker').workStart,'08:30');
  assert.equal(publicState(state,'worker').user.workStart,undefined);
  unchanged(state,()=>applyAction(state,'worker','team.schedule',{id:'worker',availability:'leave'}),'FORBIDDEN');
  unchanged(state,()=>applyAction(state,'manager','team.schedule',{id:'worker',availability:'busy',workStart:'18:00',workEnd:'09:00'}),'INVALID_INPUT');
  applyAction(state,'manager','team.schedule',{id:'worker',availability:'available',workStart:'',workEnd:''});
  assert.equal(publicState(state,'manager').users.find(user=>user.id==='worker').workEnd,'');
});

function fixture(){
 const state=createSeedState(),objects=new Map(),calls={signed:[],removed:[]};
 const bucket={createSignedUploadUrl:async path=>({data:{signedUrl:'https://qategfabulrkvdckzmqp.supabase.co/storage/v1/object/upload/sign/arios-project-files/'+path}}),info:async path=>objects.has(path)?{data:{size:objects.get(path).size}}:{error:{message:'missing'}},download:async path=>({data:objects.get(path)}),remove:async paths=>{calls.removed.push(...paths);paths.forEach(path=>objects.delete(path));return{};},createSignedUrl:async(path,ttl,options)=>{calls.signed.push({path,ttl,options});return{data:{signedUrl:'https://qategfabulrkvdckzmqp.supabase.co/storage/v1/object/sign/arios-project-files/'+path+'?token=test'}};}};
 const repo={loadState:async()=>({state:structuredClone(state)}),mutateState:async callback=>{const copy=structuredClone(state);const result=await callback(copy);Object.assign(state,copy);return{result,state:copy};},rateLimit:async()=>({allowed:true})};
 const handle=async(actor,path,payload)=>handleProjectFiles({repo,supabase:{storage:{from:name=>{assert.equal(name,'arios-project-files');return bucket;}}},user:typeof actor==='string'?state.users.find(user=>user.id===actor):actor,request:new Request('https://edge.example'+path,{method:'POST'}),path:'/api/project-files/'+path,readJSON:async()=>payload,json:data=>data});
 return{state,objects,calls,bucket,handle};
}

test('private file upload validates actual bytes and exposes metadata only after successful completion',async()=>{
 const f=fixture();
 const upload=await f.handle('worker','upload-url',{projectId:'p1',fileName:'site.png',mimeType:'image/png',size:8});
 const pending=f.state.projects[0].files[0];assert.equal(upload.id,pending.id);assert.equal(publicState(f.state,'worker').projects[0].files.length,0);
 f.objects.set(pending.storagePath,new Blob([new Uint8Array([137,80,78,71,13,10,26,10])],{type:'image/png'}));
 const done=await f.handle('worker','complete',{projectId:'p1',id:upload.id});assert.equal(done.file.name,'site.png');assert(!JSON.stringify(done).includes('storagePath'));
 await f.handle('worker2','download',{projectId:'p1',id:upload.id,preview:true});assert.equal(f.calls.signed[0].ttl,90);assert.deepEqual(f.calls.signed[0].options,{});
 await assert.rejects(f.handle('customer','download',{projectId:'p1',id:upload.id}),error=>error.status===403);
 await assert.rejects(f.handle('worker3','download',{projectId:'p1',id:upload.id}),error=>error.status===403);
});

test('forged image, oversized file, stale role, and unowned completion cannot produce a ready attachment',async()=>{
 const f=fixture();
 await assert.rejects(f.handle('worker','upload-url',{projectId:'p1',fileName:'site.svg',mimeType:'image/svg+xml',size:20}));
 await assert.rejects(f.handle('worker','upload-url',{projectId:'p1',fileName:'site.png',mimeType:'image/png',size:10485761}));
 const upload=await f.handle('worker','upload-url',{projectId:'p1',fileName:'site.png',mimeType:'image/png',size:8});
 const row=f.state.projects[0].files[0];f.objects.set(row.storagePath,new Blob(['<script>']));
 await assert.rejects(f.handle('worker2','complete',{projectId:'p1',id:upload.id}),error=>error.status===403);
 await assert.rejects(f.handle('worker','complete',{projectId:'p1',id:upload.id}));
 assert.equal(row.status,'pending');assert(f.calls.removed.includes(row.storagePath));
 const stale=structuredClone(f.state.users.find(user=>user.id==='manager'));f.state.users.find(user=>user.id==='manager').role='customer';
 await assert.rejects(f.handle(stale,'upload-url',{projectId:'p1',fileName:'a.png',mimeType:'image/png',size:8}),error=>error.status===403);
});

test('failed signed upload cleans its reservation and deleted drafts cannot expose ready orphan media',async()=>{
 const f=fixture();f.bucket.createSignedUploadUrl=async()=>({error:{message:'unavailable'}});
 await assert.rejects(f.handle('worker','upload-url',{projectId:'p1',fileName:'a.png',mimeType:'image/png',size:8}));assert.equal(f.state.projects[0].files.length,0);
 const draft=applyAction(f.state,'worker','report.draft.save',report);
 f.state.projects[0].files.push({id:'orphan',name:'a.png',mimeType:'image/png',size:8,storagePath:'projects/p1/worker/orphan.png',uploadedBy:'worker',status:'ready',draftId:draft.id,createdAt:new Date().toISOString()});
 applyAction(f.state,'worker','report.draft.delete',{id:draft.id,version:draft.version});
 await assert.rejects(f.handle('worker','download',{projectId:'p1',id:'orphan'}),error=>error.status===403);
 assert.equal(publicState(f.state,'worker').projects[0].files.length,0);
});

test('browser download validates the signed storage origin and never calls uploads with credentials',async()=>{
 await assert.rejects(downloadProjectFile('p1','a',{fetcher:async()=>Response.json({url:'https://evil.example/private'})}));
 const calls=[];await uploadProjectFile('p1',new File([new Uint8Array([137,80,78,71,13,10,26,10])],'a.png',{type:'image/png'}),{fetcher:async(url,options)=>{calls.push({url,options});return url.endsWith('/upload-url')?Response.json({id:'a',uploadUrl:'https://qategfabulrkvdckzmqp.supabase.co/storage/v1/object/upload/sign/arios-project-files/projects/p1/worker/a.png?token=test'}):url.endsWith('/complete')?Response.json({file:{id:'a'}}):new Response('',{status:200});}});
 assert.equal(calls[1].options.credentials,'omit');assert.equal(calls[1].options.redirect,'error');assert.equal(calls[0].options.credentials,'same-origin');
});

test('domain implementations remain identical for browser preview and Supabase production',async()=>assert.equal(await readFile('public/domain.mjs','utf8'),await readFile('supabase/functions/arios-api/domain.mjs','utf8')));
