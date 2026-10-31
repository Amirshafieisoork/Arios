import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {normalizeUsername,loginIdentity} from '../public/identity.mjs';
import {passwordLogin} from '../supabase/functions/arios-api/auth.mjs';

test('personnel codes normalize Persian, Arabic and full-width digits as username identities',()=>{
  for(const code of ['100001',' ۱۰۰۰۰۱ ','١٠٠٠٠١','１００００１']){
    assert.equal(normalizeUsername(code),'100001');
    assert.deepEqual(loginIdentity({identifier:code}),{username:'100001'});
    assert.deepEqual(loginIdentity({username:code}),{username:'100001'});
  }
  assert.equal(normalizeUsername('900001'),'900001');
  assert.equal(normalizeUsername('1'.repeat(40)),'1'.repeat(40));
});
test('numeric username validation reserves phone formats and rejects short or ambiguous codes',()=>{
  for(const value of ['123','10000','010001','980001','09123456789','9123456789','989123456789','1'.repeat(41),'100001.staff'])assert.throws(()=>normalizeUsername(value));
  for(const identifier of ['123','۰۱۲۳۴۵','۰۹۱۲۱۲۳۴۵۶','98badphone','+98badphone'])assert.throws(()=>loginIdentity({identifier}));
});
test('personnel login preserves Iranian phone, international phone, email and existing letter usernames',()=>{
  for(const identifier of ['۰۹۱۲ ۳۴۵ ۶۷۸۹','٠٩١٢٣٤٥٦٧٨٩','00989123456789','+98 (912) 345-6789','989123456789','9123456789'])assert.deepEqual(loginIdentity({identifier}),{phone:'+989123456789'});
  assert.deepEqual(loginIdentity({identifier:'+442071838750'}),{phone:'+442071838750'});
  assert.deepEqual(loginIdentity({identifier:' Manager@Example.com '}),{email:'manager@example.com'});
  assert.deepEqual(loginIdentity({identifier:' Stock.ARIOS '}),{username:'stock.arios'});
  assert.deepEqual(loginIdentity({identifier:'همکار.۱'}),{username:'همکار.1'});
});
test('private password login maps explicit numeric username to the same existing Auth account',async()=>{
  const user={id:'existing-worker',name:'همکار نمونه',role:'worker',username:'100001',personnelCode:'100001',phone:'+989123456789'};
  const calls=[];
  const repo={rateLimit:async()=>({allowed:true}),loadState:async()=>({state:{users:[user]}}),getProfileByDomainId:async id=>{assert.equal(id,user.id);return {auth_user_id:'existing-auth',domain_user_id:id,role:'worker'};},getSetting:async()=>null};
  const client={auth:{admin:{getUserById:async id=>{assert.equal(id,'existing-auth');return {data:{user:{id,email:'account.existing@phone.arios.invalid'}}};}}}};
  const result=await passwordLogin({client,repo,payload:{username:'۱۰۰۰۰۱',password:'initial-test-password'},authUrl:'https://qategfabulrkvdckzmqp.supabase.co',authKey:'fixture-server-key',fetcher:async(url,options)=>{
    calls.push(url);assert.deepEqual(JSON.parse(options.body),{email:'account.existing@phone.arios.invalid',password:'initial-test-password'});
    return new Response(JSON.stringify({access_token:'fixture-access',refresh_token:'fixture-refresh',expires_in:3600,user:{id:'existing-auth'}}),{headers:{'Content-Type':'application/json'}});
  }});
  assert.deepEqual(result,{access_token:'fixture-access',refresh_token:'fixture-refresh',expires_in:3600});
  assert.equal(calls.length,1);assert.equal(JSON.stringify(result).includes('@phone.arios.invalid'),false);
});
test('numeric personnel identity rules remain identical in browser and deployed Edge source',async()=>{
  assert.equal(await readFile('public/identity.mjs','utf8'),await readFile('supabase/functions/arios-api/identity.mjs','utf8'));
});
