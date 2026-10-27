import test from 'node:test';
import assert from 'node:assert/strict';
import {createSeedState,applyAction,publicState} from '../public/domain.mjs';
import {updateAccount,resetAccountPassword} from '../supabase/functions/arios-api/auth.mjs';

function transferred() {
  const state=createSeedState();
  applyAction(state,'manager','account.primary-manager.transfer',{
    id:'worker',expectedPrimaryManagerId:'manager',expectedVersion:0,
    requestId:'primary-boundary-transfer-0001',
  });
  return state;
}
function unchanged(state,run,code) {
  const before=structuredClone(state);
  assert.throws(run,error=>error.code===code);
  assert.deepEqual(state,before);
}

test('technical manager cannot change the primary login identity or contact record after ownership transfers',()=>{
  const state=transferred();
  for(const changes of [{phone:'09123456789'},{username:'different_owner'},{name:'Different owner'}]) {
    unchanged(state,()=>applyAction(state,'manager','account.update',{id:'worker',...changes}),'PRIMARY_MANAGER_REQUIRED');
  }
  assert.equal(publicState(state,'manager').managementRoles.canTransferPrimary,false);
  assert.equal(publicState(state,'worker').managementRoles.canTransferPrimary,true);
});

test('primary self edits and technical operational member management continue without changing ownership',()=>{
  const state=transferred();
  applyAction(state,'worker','account.update',{id:'worker',phone:'09123456789',username:'primary_account',name:'Primary owner'});
  applyAction(state,'manager','account.update',{id:'worker2',name:'Updated colleague'});
  applyAction(state,'manager','account.update',{id:'manager',name:'Technical manager'});
  assert.equal(state.users.find(person=>person.id==='worker').phone,'+989123456789');
  assert.equal(state.users.find(person=>person.id==='worker2').name,'Updated colleague');
  assert.equal(state.primaryManagerId,'worker');
  assert.equal(publicState(state,'manager').user.managementTitle,'مدیر فنی');
  assert.equal(publicState(state,'worker').user.managementTitle,'مدیر اصلی');
});

test('account edit fields cannot forge primary authority or bypass the dedicated transfer guard',()=>{
  const state=transferred();
  applyAction(state,'manager','account.update',{
    id:'manager',role:'manager',managementRole:'primary',primaryManagerId:'manager',
    managementTitle:'مدیر اصلی',
  });
  assert.equal(state.primaryManagerId,'worker');
  assert.equal(publicState(state,'manager').user.managementRole,'technical');
  unchanged(state,()=>applyAction(state,'manager','account.primary-manager.transfer',{
    id:'worker2',expectedPrimaryManagerId:'worker',expectedVersion:1,
    requestId:'primary-boundary-forged-0002',
  }),'PRIMARY_MANAGER_REQUIRED');
});

test('primary login edit is rejected before the authenticated API reads a profile or commits state',async()=>{
  const state=transferred(),before=structuredClone(state),calls={profile:0,commit:0};
  const repo={
    rateLimit:async()=>({allowed:true}),
    loadState:async()=>({state:structuredClone(state),revision:7}),
    getProfileByDomainId:async()=>{calls.profile++;throw Error('Must reject before profile access');},
    updateAccount:async()=>{calls.commit++;throw Error('Must not commit');},
  };
  await assert.rejects(updateAccount({},repo,{id:'manager',role:'manager'},
    {id:'worker',phone:'09123456789'}),error=>error.code==='PRIMARY_MANAGER_REQUIRED');
  assert.deepEqual(calls,{profile:0,commit:0});
  assert.deepEqual(state,before);
});

test('technical manager cannot use password reset or archive paths to seize or disable the primary account',async()=>{
  const state=transferred();
  unchanged(state,()=>applyAction(state,'manager','account.archive',{id:'worker'}),'MANAGER_ROLE_PROTECTED');
  let profileReads=0,releases=0;
  const repo={rateLimit:async()=>({allowed:true}),acquireLock:async()=>true,
    releaseLock:async()=>{releases++;},loadState:async()=>({state:structuredClone(state)}),
    getProfileByDomainId:async()=>{profileReads++;throw Error('No primary password reset');},
  };
  await assert.rejects(resetAccountPassword({},repo,{id:'manager',role:'manager'},
    {id:'worker',password:'private-password'}),error=>error.code==='MANAGER_ROLE_PROTECTED');
  assert.equal(profileReads,0);assert.equal(releases,1);
});
