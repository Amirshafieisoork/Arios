import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {resolve} from 'node:path';

// Exercise the released HTTP handler, authorization and domain together. Only
// Supabase's transport and repository persistence are replaced by local fixtures.
const built = await build({
  entryPoints:[resolve('supabase/functions/arios-api/index.ts')], bundle:true, write:false,
  format:'esm', platform:'node', target:'node24',
  plugins:[{name:'dossier-test-client',setup(builder){
    builder.onResolve({filter:/^npm:@supabase\/supabase-js@/},()=>({path:'injected-client',namespace:'dossier-test-client'}));
    builder.onLoad({filter:/.*/,namespace:'dossier-test-client'},()=>({contents:'export function createClient(){throw Error("Inject the test client");}',loader:'js'}));
  }}],
});
const {createHandler}=await import('data:text/javascript;base64,'+Buffer.from(built.outputFiles[0].text).toString('base64'));
const labels=['مسئول پروژه','مسئول واحد','مدیر گروه فنی','واحد فروش','واحد مالی','مدیرعامل'];

function fixture(){
  let state={schemaVersion:1,users:[
    {id:'manager',role:'manager',name:'مدیر آزمون'},
    {id:'reviewer',role:'worker',name:'مسئول دو مرحله'},
    {id:'accountant',role:'accountant',name:'حسابدار آزمون'},
    {id:'worker',role:'worker',name:'مجری آزمون',hourlyRate:150000},
    {id:'outsider',role:'worker',name:'نیروی پروژه دیگر'},
  ],projects:[{
    id:'p1',name:'پروژه آزمایش',type:'CCTV',customerId:null,memberIds:['worker'],contactIds:[],
    projectCode:'AR-1405-001',projectManagerId:'reviewer',reviewChain:labels.map((label,index)=>({label,userId:['reviewer','reviewer','accountant','accountant','manager','manager'][index]})),
    status:'active',progress:10,startDate:'2026-10-01',endDate:'2026-11-01',location:'محل آزمون',description:'شرح اولیه',budget:10000000,contractAmount:12000000,
  }],reports:[{
    id:'r1',projectId:'p1',workerId:'worker',date:'2026-10-02',start:'09:00',end:'12:00',breakMinutes:0,description:'نصب واقعی ثبت‌شده',output:'سه ساعت کار',
    status:'approved',minutes:180,rate:150000,laborCost:450000,version:1,createdAt:'2026-10-02T12:00:00Z',
  }],materials:[{id:'m1',projectId:'p1',name:'کابل',quantity:10,originalQuantity:12,unit:'متر',unitPrice:10000,date:'2026-10-02',returns:[{id:'ret1',date:'2026-10-03',quantity:2}],recordedBy:'manager'}],invoices:[],messages:[],tickets:[],inventory:[],receipts:[],audit:[]};
  let revision=1;
  const repo={
    loadState:async()=>({state:structuredClone(state),revision}),
    mutateState:async callback=>{const draft=structuredClone(state),result=callback(draft);state=draft;revision++;return {result,state:structuredClone(state),revision};},
    rateLimit:async()=>({allowed:true}),getSetting:async()=>null,
    getProfile:async authId=>{const person=state.users.find(user=>'auth-'+user.id===authId);return person&&{auth_user_id:authId,domain_user_id:person.id,role:person.role};},
    listProfileLinks:async()=>state.users.map(user=>({domain_user_id:user.id,role:user.role})),
  };
  const client={auth:{getUser:async token=>state.users.some(user=>user.id===token)?{data:{user:{id:'auth-'+token}}}:{data:{user:null},error:{status:401}}}};
  const handle=createHandler({repo,client,fetcher:()=>assert.fail('Dossier operations must not contact AI or messaging providers')});
  const request=async(actor,path,payload)=>{
    const response=await handle(new Request('https://edge.example/functions/v1/arios-api'+path,{
      method:payload===undefined?'GET':'POST',headers:{...(actor?{Authorization:'Bearer '+actor}:{}),...(payload===undefined?{}:{'Content-Type':'application/json'})},
      ...(payload===undefined?{}:{body:JSON.stringify(payload)}),
    }));
    return {status:response.status,body:await response.json()};
  };
  return {request,action:(actor,action,payload)=>request(actor,'/actions',{action,payload}),get state(){return state;}};
}
const worksheet=(overrides={})=>({projectId:'p1',version:0,workItems:[{id:'work-1',description:'اجرت محرمانه آزمون',quantity:3,unit:'عدد',unitRate:200000}],staffAllocations:[{id:'staff-1',userId:'worker',wage:500000,bonus:10000,paidAmount:0,notes:'تخصیص محرمانه آزمون'}],declaredLaborAmount:700000,finalLaborAmount:600000,notes:'یادداشت مالی محرمانه',...overrides});
const noFinance=body=>{
  const json=JSON.stringify(body);
  assert.doesNotMatch(json,/"(?:rate|hourlyRate|laborCost|unitPrice|unitRate|wage|bonus|paidAmount|staffAllocations|declaredLaborAmount|finalLaborAmount|approvedLaborCost|materialCost|workTotal)"/);
  assert.doesNotMatch(json,/محرمانه آزمون|یادداشت مالی محرمانه/);
};

test('Edge aggregate dossier requires six explicit approvals even when one actor holds adjacent roles',async()=>{
  const f=fixture();
  const saved=await f.action('manager','project.dossier.save',worksheet());
  assert.equal(saved.status,200,JSON.stringify(saved.body));
  const submitted=await f.action('reviewer','project.dossier.submit',{projectId:'p1',version:1,from:'2026-10-01',to:'2026-10-31'});
  assert.equal(submitted.status,200,JSON.stringify(submitted.body));
  noFinance(submitted.body);
  assert.equal(f.state.projects[0].dossierSubmission.snapshot.worksheet.workItems[0].unitRate,200000,'The canonical frozen snapshot retains private finance');
  const snapshot=structuredClone(f.state.projects[0].dossierSubmission.snapshot);
  const payroll=structuredClone(f.state.reports);
  const first=f.state.projects[0].dossierSubmission;
  const initial={projectId:'p1',id:first.id,version:first.version,status:'approved',reviewNote:''};
  const beforeWrong=structuredClone(f.state);
  const wrong=await f.action('manager','project.dossier.review',initial);
  assert.equal(wrong.status,403,JSON.stringify(wrong.body));
  assert.deepEqual(f.state,beforeWrong);
  for(const [index,actor] of ['reviewer','reviewer','accountant','accountant','manager','manager'].entries()){
    const current=f.state.projects[0].dossierSubmission;
    assert.equal(current.approval.currentStage,index);
    const payload={projectId:'p1',id:current.id,version:current.version,status:'approved',reviewNote:'بررسی مرحله '+(index+1)};
    const reviewed=await f.action(actor,'project.dossier.review',payload);
    assert.equal(reviewed.status,200,JSON.stringify(reviewed.body));
    if(actor==='reviewer')noFinance(reviewed.body);
    const next=f.state.projects[0].dossierSubmission;
    assert.equal(next.approval.stages[index].status,'approved');
    assert.equal(next.approval.stages[index].reviewedBy,actor);
    assert.equal(next.status,index===5?'approved':'submitted');
    assert.deepEqual(next.snapshot,snapshot);
    if(index===0){
      assert.equal(next.approval.stages[1].status,'pending','The same actor must explicitly approve their second responsibility');
      const beforeReplay=structuredClone(f.state);
      const replay=await f.action(actor,'project.dossier.review',payload);
      assert.equal(replay.status,409,JSON.stringify(replay.body));
      assert.deepEqual(f.state,beforeReplay);
    }
  }
  assert.deepEqual(f.state.reports,payroll,'Aggregate signatures never book payroll twice');
  f.state.reports[0].description='تغییر بعدی منبع';f.state.materials[0].quantity=1;f.state.projects[0].projectCode='NEW-CODE';
  const read=await f.request('reviewer','/state');
  assert.equal(read.status,200);noFinance(read.body);
  const descriptor=read.body.projects[0].dossierSubmission;
  assert.equal(descriptor.snapshot,undefined);
  assert.equal(descriptor.approval.history,undefined);
  const detail=await f.request('reviewer','/project-dossiers/read',{projectId:'p1',id:descriptor.id});
  assert.equal(detail.status,200,JSON.stringify(detail.body));noFinance(detail.body);
  assert.equal(detail.body.dossierSubmission.id,descriptor.id);
  assert.equal(detail.body.dossierSubmission.version,descriptor.version);
  assert.equal(detail.body.dossierSubmission.snapshot.project.projectCode,'AR-1405-001');
  assert.equal(detail.body.dossierSubmission.snapshot.reports[0].description,'نصب واقعی ثبت‌شده');
  assert.equal(detail.body.dossierSubmission.snapshot.materials[0].quantity,10);
  assert.equal(detail.body.dossierSubmission.approval.history.filter(event=>event.action==='approved').length,6);
});

test('Edge dossier read permission does not grant financial or execution writes and failures are atomic',async()=>{
  const f=fixture();
  const read=await f.request('reviewer','/state');
  assert.equal(read.status,200);assert.equal(read.body.projects[0].canRecordWork,false);noFinance(read.body);
  const operations=[
    ['project.dossier.save',worksheet()],
    ['report.create',{projectId:'p1',workerId:'reviewer',date:'2026-10-04',start:'09:00',end:'10:00',breakMinutes:0,description:'ثبت غیرمجاز'}],
    ['material.consume',{projectId:'p1',name:'کالای جدید',quantity:1,unit:'عدد',unitPrice:1,date:'2026-10-04'}],
    ['task.create',{projectId:'p1',title:'وظیفه غیرمجاز'}],
  ];
  for(const [action,payload] of operations){
    const before=structuredClone(f.state),denied=await f.action('reviewer',action,payload);
    assert.equal(denied.status,403,action+' '+JSON.stringify(denied.body));assert.deepEqual(f.state,before);
  }
  assert.equal((await f.request(null,'/state')).status,401);
  assert.equal((await f.action(null,'project.dossier.submit',{projectId:'p1',version:0})).status,401);
  const outsider=await f.request('outsider','/state');assert.equal(outsider.status,200);assert.equal(outsider.body.projects.length,0);
  const before=structuredClone(f.state),denied=await f.action('outsider','project.dossier.submit',{projectId:'p1',version:0});
  assert.equal(denied.status,403,JSON.stringify(denied.body));assert.deepEqual(f.state,before);
});

test('Edge project creation enforces the official unique code and all six configured responsibilities',async()=>{
  const f=fixture(),create={name:'پروژه تازه',type:'CCTV',memberIds:['worker'],location:'محل پروژه تازه',budget:0,contractAmount:0,startDate:'2026-10-01',endDate:'2026-11-01',description:''};
  const before=structuredClone(f.state),incomplete=await f.action('manager','project.create',create);
  assert.equal(incomplete.status,400,JSON.stringify(incomplete.body));assert.deepEqual(f.state,before);
  const configured={...create,projectCode:'ar-۱۴۰۵-۰۰۲',projectManagerId:'reviewer',reviewChain:f.state.projects[0].reviewChain};
  const created=await f.action('manager','project.create',configured);
  assert.equal(created.status,200,JSON.stringify(created.body));
  assert.equal(created.body.result.projectCode,'AR-1405-002');
  assert.equal(created.body.result.reviewChain.length,6);
  assert.equal(created.body.result.reviewChain[0].userId,created.body.result.reviewChain[1].userId);
  const after=structuredClone(f.state),duplicate=await f.action('manager','project.create',{...configured,projectCode:'AR-1405-002'});
  assert.equal(duplicate.status,409,JSON.stringify(duplicate.body));assert.deepEqual(f.state,after);
});

test('Edge lazy dossier reads authenticate and scope every current or archived revision independently',async()=>{
  const f=fixture();
  assert.equal((await f.action('manager','project.dossier.save',worksheet())).status,200);
  assert.equal((await f.action('manager','project.dossier.submit',{projectId:'p1',version:1})).status,200);
  for(const actor of ['reviewer','reviewer','accountant','accountant','manager','manager']){
    const current=f.state.projects[0].dossierSubmission;
    const approved=await f.action(actor,'project.dossier.review',{projectId:'p1',id:current.id,version:current.version,status:'approved',reviewNote:''});
    assert.equal(approved.status,200,JSON.stringify(approved.body));
  }
  const approved=f.state.projects[0].dossierSubmission,oldId=approved.id;
  const revised=await f.action('manager','project.dossier.revise',{projectId:'p1',id:oldId,version:approved.version,reason:'نسخه تازه با مسئولان تازه'});
  assert.equal(revised.status,200,JSON.stringify(revised.body));
  const changed=await f.action('manager','project.update',{id:'p1',projectManagerId:'worker',reviewChain:labels.map((label,index)=>({label,userId:['worker','worker','accountant','accountant','manager','manager'][index]}))});
  assert.equal(changed.status,200,JSON.stringify(changed.body));
  f.state.reports[0].description='کارکرد نسخه جدید پس از تغییر مسئول';
  const saved=await f.action('manager','project.dossier.save',worksheet({version:f.state.projects[0].dossier.version,notes:'فقط نسخه جدید'}));
  assert.equal(saved.status,200,JSON.stringify(saved.body));
  const submitted=await f.action('manager','project.dossier.submit',{projectId:'p1',version:f.state.projects[0].dossier.version});
  assert.equal(submitted.status,200,JSON.stringify(submitted.body));
  const newId=f.state.projects[0].dossierSubmission.id,beforeReads=structuredClone(f.state);
  const former=await f.request('reviewer','/state');
  assert.equal(former.status,200);noFinance(former.body);
  const project=former.body.projects[0];
  assert.equal(project.dossierSubmission,undefined,'A former reviewer must not discover a later revision');
  assert.equal(project.dossierSubmissionHistory.length,1);
  const descriptor=project.dossierSubmissionHistory[0];
  assert.equal(descriptor.id,oldId);assert.equal(descriptor.snapshot,undefined);assert.equal(descriptor.approval.history,undefined);
  const historical=await f.request('reviewer','/project-dossiers/read',{projectId:'p1',id:oldId});
  assert.equal(historical.status,200,JSON.stringify(historical.body));noFinance(historical.body);
  assert.equal(historical.body.dossierSubmission.id,descriptor.id);
  assert.equal(historical.body.dossierSubmission.version,descriptor.version);
  assert.equal(historical.body.dossierSubmission.snapshot.reports[0].description,'نصب واقعی ثبت‌شده');
  const latest=await f.request('manager','/project-dossiers/read',{projectId:'p1',id:newId});
  assert.equal(latest.status,200,JSON.stringify(latest.body));
  assert.equal(latest.body.dossierSubmission.snapshot.reports[0].description,'کارکرد نسخه جدید پس از تغییر مسئول');
  assert.equal(latest.body.dossierSubmission.snapshot.worksheet.workItems[0].unitRate,200000);
  for(const [actor,projectId,id] of [['reviewer','p1',newId],['outsider','p1',oldId],['reviewer','missing-project',oldId],['reviewer','p1','missing-submission']]){
    const denied=await f.request(actor,'/project-dossiers/read',{projectId,id});
    assert([403,404].includes(denied.status),JSON.stringify({actor,projectId,id,...denied}));
    assert.equal(denied.body.dossierSubmission,undefined);
  }
  const anonymous=await f.request(null,'/project-dossiers/read',{projectId:'p1',id:oldId});
  assert.equal(anonymous.status,401);assert.equal(anonymous.body.dossierSubmission,undefined);
  assert.deepEqual(f.state,beforeReads,'Loading a dossier never mutates its evidence, history or version');
});

test('Edge workspace state carries bounded descriptors instead of repeating large archived evidence',async()=>{
  const f=fixture();
  assert.equal((await f.action('manager','project.dossier.save',worksheet())).status,200);
  assert.equal((await f.action('manager','project.dossier.submit',{projectId:'p1',version:1})).status,200);
  const current=f.state.projects[0].dossierSubmission,archived=structuredClone(current);
  archived.status='approved';archived.archivedAt='2026-10-20T10:00:00Z';
  const reports=Array.from({length:50},(_,index)=>({...archived.snapshot.reports[0],id:'large-source-'+index,description:'x'.repeat(3000)}));
  archived.snapshot.reports=reports;
  archived.snapshot.days=[{date:'2026-10-02',reports:structuredClone(reports),minutes:9000,approvedMinutes:9000,memberIds:['worker']}];
  f.state.projects[0].dossierSubmissionHistory=Array.from({length:20},(_,index)=>({...structuredClone(archived),id:'archive-'+index}));
  const canonicalBytes=Buffer.byteLength(JSON.stringify(f.state));
  assert(canonicalBytes>4.5*1024*1024,'Fixture must reproduce a state larger than the hosted response limit');
  const response=await f.request('manager','/state');
  assert.equal(response.status,200);
  const projectedBytes=Buffer.byteLength(JSON.stringify(response.body));
  assert(projectedBytes<100000,`Descriptors must keep the response small; received ${projectedBytes} bytes`);
  const descriptors=response.body.projects[0].dossierSubmissionHistory;
  assert.equal(descriptors.length,20);
  for(const [index,descriptor] of descriptors.entries()){
    assert.equal(descriptor.id,'archive-'+index);assert.equal(descriptor.snapshot,undefined);assert.equal(descriptor.approval.history,undefined);
  }
  const loaded=await f.request('manager','/project-dossiers/read',{projectId:'p1',id:'archive-19'});
  assert.equal(loaded.status,200,JSON.stringify(loaded.body));
  assert.equal(loaded.body.dossierSubmission.snapshot.reports.length,50);
  assert.equal(loaded.body.dossierSubmission.id,descriptors[19].id);
  assert.equal(loaded.body.dossierSubmission.version,descriptors[19].version);
});
