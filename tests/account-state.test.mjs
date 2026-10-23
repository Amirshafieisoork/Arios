import test from 'node:test';
import assert from 'node:assert/strict';
import { workspaceState } from '../supabase/functions/arios-api/account-state.mjs';
import { createSeedState } from '../public/domain.mjs';

test('manager account flags come from protected profile links while Auth identifiers stay private', async () => {
  const state = createSeedState();
  state.users.find(user => user.id === 'worker2').loginEnabled = true;
  const repo = {listProfileLinks: async () => [{domain_user_id:'manager',role:'manager',auth_user_id:'private-auth-id'}, {domain_user_id:'worker',role:'customer'}]};
  const result = await workspaceState(repo,state,'manager');
  assert.equal(result.users.find(user=>user.id==='worker2').loginEnabled,false);
  assert.equal(result.users.find(user=>user.id==='worker').loginEnabled,true);
  assert.equal(result.users.find(user=>user.id==='worker').loginNeedsReview,true);
  assert.equal(result.users.find(user=>user.id==='manager').loginNeedsReview,false);
  assert(!JSON.stringify(result).includes('private-auth-id'));
  assert.equal(state.users.find(user=>user.id==='worker2').loginEnabled,true,'Derived flags never modify stored domain records');
});

test('other roles receive their authorized snapshot without access to the account link directory', async () => {
  const state=createSeedState();
  for(const id of ['worker','customer']) {
    const result=await workspaceState({listProfileLinks:()=>assert.fail('No account-directory read for non-managers')},state,id);
    assert(result.users.every(user=>user.loginEnabled===undefined&&user.loginNeedsReview===undefined));
  }
});
