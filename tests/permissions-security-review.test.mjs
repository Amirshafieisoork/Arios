import test from 'node:test';
import assert from 'node:assert/strict';
import {createSeedState,publicState,applyAction,readDossierSubmission,PROJECT_APPROVAL_LABELS} from '../public/domain.mjs';
import {hasPermission,effectivePermissions,normalizePermissions,applyPermissionOverrides} from '../public/permissions.mjs';
import {build} from 'esbuild';
import {resolve} from 'node:path';

const forbidden=error=>error?.status===403;
const user=(state,id)=>state.users.find(person=>person.id===id);

test('permission decisions use canonical identities and fail closed for unknown or deleted actors',()=>{
  const state=createSeedState();
  const forged={id:'worker',role:'manager',permissions:{'people.manage':true,'permissions.manage':true}};
  assert.equal(hasPermission(forged,'people.manage',state),false);
  assert.equal(hasPermission({id:'missing-user',role:'manager'},'people.manage',state),false);
  user(state,'worker').deletedAt='2026-10-31T00:00:00Z';
  assert.equal(hasPermission(forged,'people.manage',state),false);
  assert.equal(Object.values(effectivePermissions(forged,state)).some(Boolean),false);
});

test('permission payloads reject unknown keys, truthy strings and customer operational grants',()=>{
  const state=createSeedState(),owner=user(state,'manager'),customer=user(state,'customer');
  for(const input of [{'projects.create':'true'},{'role.manager':true},{'__admin':true},[]])assert.throws(()=>normalizePermissions(input));
  assert.throws(()=>applyPermissionOverrides(state,owner,customer,{'inventory.create':true}));
  assert.throws(()=>applyPermissionOverrides(state,user(state,'worker'),user(state,'worker2'),{'projects.create':true}),forbidden);
  assert.equal(user(state,'worker2').permissions,undefined);
});

test('the primary manager cannot be locked out through an ordinary permission edit',()=>{
  const state=createSeedState(),owner=user(state,'manager');
  assert.throws(()=>applyPermissionOverrides(state,owner,owner,{'permissions.manage':false}),forbidden);
  assert.equal(hasPermission(owner,'permissions.manage',state),true);
  assert.equal(hasPermission(owner,'projects.create',state),true);
});

test('manager-only capabilities cannot be delegated or recovered from stale staff overrides',()=>{
  const state=createSeedState(),owner=user(state,'manager'),worker=user(state,'worker');
  for(const key of ['people.manage','permissions.manage','integrations.manage','backups.manage','voice.manage']){
    assert.throws(()=>applyPermissionOverrides(state,owner,worker,{[key]:true}),error=>error.code==='ROLE_PERMISSION_REQUIRED');
    worker.permissions={...worker.permissions,[key]:true};
    assert.equal(hasPermission(worker,key,state),false,key);
  }
  const before=structuredClone(state);
  assert.throws(()=>applyAction(state,worker.id,'account.permissions.update',{id:'worker2',permissions:{'projects.create':true}}),forbidden);
  assert.deepEqual(state,before);
});

test('partial permission edits preserve existing revocations and price capability booleans survive projection',()=>{
  const state=createSeedState(),owner=user(state,'manager'),worker=user(state,'worker');
  worker.permissions={'projects.prices':false,'inventory.prices':true,'inventory.view':true,'reports.submit':false};
  applyPermissionOverrides(state,owner,worker,{'inventory.create':true});
  const snapshot=publicState(state,worker.id);
  assert.equal(snapshot.user.permissions['inventory.prices'],true);
  assert.equal(snapshot.user.permissionOverrides['inventory.prices'],true);
  assert.equal(snapshot.user.permissions['projects.prices'],false);
  assert.equal(snapshot.user.permissions['reports.submit'],false);
  assert.equal(snapshot.inventory[0].unitPrice,state.inventory[0].unitPrice);
  assert.equal(snapshot.projects[0].budget,undefined);
});

test('delegated project and inventory creation work without disclosing or accepting hidden prices',()=>{
  const state=createSeedState(),worker=user(state,'worker');
  worker.permissions={'projects.create':true,'projects.edit':true,'inventory.create':true,'inventory.view':true};
  const payload={name:'پروژهٔ جدید',type:'CCTV',memberIds:[],location:'تهران',startDate:'2026-11-06',endDate:'2026-11-20',projectCode:'DELEGATE-CREATE',projectManagerId:'manager',reviewChain:PROJECT_APPROVAL_LABELS.map(label=>({label,userId:'manager'}))};
  const project=applyAction(state,worker.id,'project.create',payload);
  assert.equal(project.budget,undefined);
  assert.equal(state.projects.find(row=>row.id===project.id).budget,0);
  assert.equal(applyAction(state,worker.id,'project.update',{id:project.id,name:'ویرایش سازنده'}).name,'ویرایش سازنده');
  const stock=applyAction(state,worker.id,'inventory.create',{name:'کالای جدید',unit:'عدد',quantity:2,minQuantity:1});
  assert.equal(stock.unitPrice,undefined);
  assert.equal(state.inventory.find(row=>row.id===stock.id).unitPrice,0);
  for(const [action,input] of [['project.create',{...payload,projectCode:'DENIED-PRICE',budget:100}],['inventory.create',{name:'کالای مخفی',unit:'عدد',quantity:1,minQuantity:0,unitPrice:100}]]){
    const before=structuredClone(state);assert.throws(()=>applyAction(state,worker.id,action,input),forbidden);assert.deepEqual(state,before);
  }
});

test('delegated finance records respect project scope and require a separate reversal grant',()=>{
  const state=createSeedState(),worker=user(state,'worker');
  worker.permissions={'projects.prices':true,'finance.view':true,'finance.manage':true};
  const payload={employeeId:worker.id,projectId:'p1',amount:100,date:'2026-11-06',method:'bank',reference:'DELEGATED-ADVANCE'};
  const entry=applyAction(state,worker.id,'finance.advance.create',payload);
  assert.equal(entry.amount,100);
  const before=structuredClone(state);
  assert.throws(()=>applyAction(state,worker.id,'finance.advance.create',{...payload,projectId:'p2',reference:'UNRELATED-ADVANCE'}),forbidden);
  assert.throws(()=>applyAction(state,worker.id,'finance.entry.reverse',{id:entry.id,version:entry.version,date:'2026-11-06',reason:'اصلاح'}),forbidden);
  assert.deepEqual(state,before);
  applyAction(state,'manager','account.permissions.update',{id:worker.id,permissions:{'finance.reverse':true}});
  assert.equal(applyAction(state,worker.id,'finance.entry.reverse',{id:entry.id,version:entry.version,date:'2026-11-06',reason:'اصلاح'}).reverseOf,entry.id);
});

test('revoked project price visibility is applied to every manager snapshot representation',()=>{
  const state=createSeedState();
  state.users.push({id:'restricted-manager',name:'مدیر با دسترسی محدود',role:'manager',permissions:{'projects.prices':false}});
  const project=state.projects[0],budget=318274659,contractAmount=572831496;
  project.budget=budget;project.contractAmount=contractAmount;
  const snapshot=publicState(state,'restricted-manager');
  const visible=snapshot.projects.find(item=>item.id===project.id);
  assert(visible);
  assert.equal(visible.budget,undefined);assert.equal(visible.contractAmount,undefined);
  // The management table and export both reuse this complete snapshot. A
  // second copy of the same project must not reveal values hidden in its card.
  const encoded=JSON.stringify(snapshot);
  assert(!encoded.includes(String(budget)));assert(!encoded.includes(String(contractAmount)));
  assert.equal(project.budget,budget);assert.equal(project.contractAmount,contractAmount);
});

test('delegated project management does not grant access to unrelated projects',()=>{
  const state=createSeedState(),worker=user(state,'worker');
  worker.permissions={'projects.view':true,'projects.edit':true,'projects.create':true};
  assert.equal(hasPermission(worker,'projects.edit',state),true);
  assert(!publicState(state,worker.id).projects.some(project=>project.id==='p2'));
  const before=structuredClone(state);
  assert.throws(()=>applyAction(state,worker.id,'project.update',{id:'p2',name:'تغییر غیرمجاز'}),forbidden);
  assert.deepEqual(state,before);
});

test('permission administrators cannot give a different account a capability they themselves lack',()=>{
  const state=createSeedState();
  state.users.push({id:'limited-manager',name:'مدیر محدود',role:'manager',permissions:{'projects.prices':false}});
  const actor=user(state,'limited-manager'),target=user(state,'worker');
  const before=structuredClone(target);
  assert.throws(()=>applyPermissionOverrides(state,actor,target,{'projects.prices':true}),forbidden);
  assert.deepEqual(target,before);
});

test('a successful delegated project edit does not return monetary fields from the raw action result',()=>{
  const state=createSeedState(),worker=user(state,'worker');
  worker.permissions={'projects.edit':true,'projects.prices':false};
  state.projects[0].budget=495173826;state.projects[0].contractAmount=628397451;
  const result=applyAction(state,worker.id,'project.update',{id:'p1',name:'نام اصلاح‌شده'});
  assert.equal(result.name,'نام اصلاح‌شده');
  assert.equal(result.budget,undefined);assert.equal(result.contractAmount,undefined);
  assert.equal(state.projects[0].budget,495173826);assert.equal(state.projects[0].contractAmount,628397451);
});

test('financially restricted manager snapshots cannot recover project costs through employee or stock summaries',()=>{
  const state=createSeedState();
  state.users.push({id:'limited-finance-manager',name:'مدیر بدون مبالغ',role:'manager',permissions:{'projects.prices':false,'inventory.prices':false,'finance.view':false}});
  state.financeEntries=[{id:'private-advance',type:'advance',employeeId:'worker',amount:413975286,date:'2026-10-15',recordedBy:'manager',createdAt:'2026-10-15T10:00:00Z',version:1}];
  state.projects[0].budget=734195862;
  const snapshot=publicState(state,'limited-finance-manager'),encoded=JSON.stringify(snapshot);
  assert(!encoded.includes('413975286'));assert(!encoded.includes('734195862'));
  assert.equal(snapshot.employeeFinance?.summary?.advanceBalance,undefined);
  assert.equal(snapshot.personalStock?.accounts?.find(account=>account.employeeId==='worker')?.projectedNetWages,undefined);
});

test('explicit frozen dossier reads honor revoked prices while preserving nonfinancial report evidence',()=>{
  const state=createSeedState();
  state.users.push({id:'dossier-reader',name:'مدیر بدون قیمت',role:'manager',permissions:{'projects.prices':false}});
  const project=state.projects[0];
  project.projectManagerId='dossier-reader';
  project.dossierSubmission={id:'frozen-evidence',version:1,status:'approved',snapshot:{project,reports:[{id:'evidence-row',description:'شرح کار قابل مشاهده',rate:714395826,laborCost:714395826}],worksheet:{declaredLaborAmount:714395826,finalLaborAmount:714395826,workItems:[],staffAllocations:[]},workTotal:714395826,approvedLaborCost:714395826,materialCost:714395826}};
  const result=readDossierSubmission(state,'dossier-reader',project.id,'frozen-evidence');
  assert.equal(result.snapshot.reports[0].description,'شرح کار قابل مشاهده');
  assert(!JSON.stringify(result).includes('714395826'));
});

const built=await build({entryPoints:[resolve('supabase/functions/arios-api/index.ts')],bundle:true,write:false,format:'esm',platform:'node',target:'node24',plugins:[{name:'security-review-client',setup(plugin){plugin.onResolve({filter:/^npm:@supabase\/supabase-js@/},()=>({path:'fixture',namespace:'security-review-client'}));plugin.onLoad({filter:/.*/,namespace:'security-review-client'},()=>({contents:'export function createClient(){throw Error("Use the injected review fixture");}',loader:'js'}));}}]});
const {createHandler}=await import('data:text/javascript;base64,'+Buffer.from(built.outputFiles[0].text).toString('base64'));

test('a manager without price access cannot obtain full backup ciphertext or its recovery key',async()=>{
  for(const revoked of ['projects.prices','inventory.prices']){
    const state=createSeedState(),actor={id:'restricted-backup-manager',name:'مدیر محدود',role:'manager',permissions:{[revoked]:false}};state.users.push(actor);
    const authId='11111111-1111-4111-8111-111111111111',reads=[];
    const repo={getProfile:async()=>({auth_user_id:authId,domain_user_id:actor.id,role:'manager'}),loadState:async()=>({state:structuredClone(state),revision:1}),getSetting:async key=>{reads.push(key);if(key.startsWith('backup'))throw Error('Backup data must not be read');return null;},rateLimit:async()=>({allowed:true})};
    const client={auth:{getUser:async()=>({data:{user:{id:authId}}})}};
    const handler=createHandler({client,repo,env:{SUPABASE_URL:'https://review.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'fixture-only-key'},fetcher:async()=>{throw Error('No network is permitted in this test');}});
    for(const path of ['/backups/recovery-key','/backups/file','/backups/run']){
      const response=await handler(new Request('https://review.supabase.co/functions/v1/arios-api'+path,{method:'POST',headers:{Authorization:'Bearer fixture-token','Content-Type':'application/json'},body:'{}'}));
      assert.equal(response.status,403,revoked+' '+path);
    }
    assert(!reads.some(key=>key.startsWith('backup')));
  }
});
