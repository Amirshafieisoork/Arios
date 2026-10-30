import test from 'node:test';
import assert from 'node:assert/strict';
import {runWeeklyBackup,handleBackups,backupStatus,sendBackupDocument,ensureBackupKey} from '../supabase/functions/arios-api/backup-service.mjs';
import {weeklyBackupSlot,encryptBackupPart,decryptBackupPart,sha256,redactBackupSecrets,BACKUP_CHUNK_BYTES} from '../supabase/functions/arios-api/backup-format.mjs';
import {verifyBackup} from '../scripts/verify-backup.mjs';

const AT=Date.parse('2026-10-31T17:45:00Z'),SOURCE='a'.repeat(40),TOKEN='123456:testing_backup_bot_token_12345678';
const ZIP=Uint8Array.from(Buffer.from('UEsDBBQAAAAAAAEAAQBEHnVrBQAAAAUAAAAIAAAAaGVsbG8udHh0aGVsbG9QSwECFAMUAAAAAAABAAEARB51awUAAAAFAAAACAAAAAAAAAAAAAAAgAEAAAAAaGVsbG8udHh0UEsFBgAAAAABAAEANgAAACsAAAAAAA==','base64'));
const json=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});
function fixture({audio=true,initial=true}={}){
  const users=[{id:'manager',role:'manager',name:'مدیر',passwordHash:'must-never-export'}],state={users,projects:[{id:'p1',name:'پروژه'}],reports:[{id:'r1',minutes:60}],financeEntries:[{id:'f1',amount:120000}]};
  const item={bucket:'arios-audio',name:'voice/manager/v1.ogg',id:crypto.randomUUID(),updatedAt:'2026-10-30T12:13:14.123456+00:00',size:4};
  const snapshot={format:'arios-application-snapshot/v1',capturedAt:new Date(AT).toISOString(),state:{data:state,revision:12},profiles:[{auth_user_id:'auth1',domain_user_id:'manager',role:'manager'}],drafts:[{id:'v1'}],leads:[],reminders:[],telegramLinks:[{user_id:'manager',chat_id:'123',telegram_user_id:'123'}],telegramUpdates:[],settings:{telegram_offset:55},integrationConfiguration:{aiModel:'test'},objects:audio?[item]:[]};
  const settings=new Map([['integrations',{telegramBotToken:TOKEN,aiApiKey:'never-archive-this'}],['backup_config',{enabled:true,targetUserId:'manager',createdAt:new Date(AT-86400000).toISOString(),sourceRef:SOURCE,initialRunPending:initial}]]),locks=new Map(),files=new Map(),sent=[],removed=[];
  if(audio)files.set('arios-audio/'+item.name,new Uint8Array([0,1,2,255]));
  const copy=v=>v===undefined?undefined:structuredClone(v);
  const repo={getSetting:async key=>copy(settings.get(key)),setSetting:async(key,value)=>settings.set(key,copy(value)),deleteSetting:async key=>settings.delete(key),loadState:async()=>({state:copy(state),revision:12}),listTelegramLinks:async()=>copy(snapshot.telegramLinks),acquireLock:async(name,token,lease)=>{assert(lease>=120000);if(locks.has(name))return false;locks.set(name,token);return true;},releaseLock:async(name,token)=>{if(locks.get(name)===token)locks.delete(name);}};
  const client={rpc:async(name,args)=>name==='arios_backup_snapshot'?{data:copy(snapshot)}:name==='arios_backup_object_info'?{data:copy(snapshot.objects.find(i=>i.bucket===args.p_bucket&&i.name===args.p_name))}:{error:{code:'MISSING_RPC'}},storage:{from:bucket=>({upload:async(path,data)=>{files.set(bucket+'/'+path,new Uint8Array(data));return {data:{path}};},download:async path=>files.has(bucket+'/'+path)?{data:new Blob([files.get(bucket+'/'+path)])}:{error:{code:'MISSING_FILE'}},remove:async paths=>{for(const path of paths){files.delete(bucket+'/'+path);removed.push(bucket+'/'+path);}return {data:[]};},createSignedUrl:async(path)=>({data:{signedUrl:'https://project.supabase.co/storage/v1/object/sign/'+bucket+'/'+path+'?token=opaque'}})})}};
  const fetcher=async(url,options)=>{if(url.startsWith('https://codeload.github.com/')){assert.equal(url,'https://codeload.github.com/Amirshafieisoork/Arios/zip/'+SOURCE);assert.equal(options.redirect,'error');return new Response(ZIP);}if(url.startsWith('https://api.telegram.org/')){const doc=options.body.get('document');sent.push({name:doc.name,bytes:new Uint8Array(await doc.arrayBuffer()),caption:options.body.get('caption'),chatId:options.body.get('chat_id')});return json({ok:true,result:{message_id:sent.length}});}throw Error('Unexpected request');};
  const run=(options={})=>runWeeklyBackup({repo,supabase:client,fetcher,at:AT,clock:()=>AT,maxSteps:100,...options});
  const latest=()=>settings.get('backup_job:'+settings.get('backup_index')?.[0]);
  return {users,state,item,snapshot,settings,files,sent,removed,repo,client,fetcher,run,latest};
}

test('weekly schedule is Saturday21:15 Tehran with late catchup and stable Gregorian slot',()=>{
  assert.equal(weeklyBackupSlot(AT).week,'2026-10-31');assert.equal(weeklyBackupSlot(AT-1).week,'2026-10-24');assert.equal(weeklyBackupSlot(AT+86400000).week,'2026-10-31');assert.equal(weeklyBackupSlot(AT).dueAt,AT);
});
test('AES-GCM parts bind backup id and part id and reject damage/wrong key',async()=>{
  const bytes=new Uint8Array([0,255,3]),key='f'.repeat(64),encrypted=await encryptBackupPart(bytes,key,'backup','part');
  assert.deepEqual(await decryptBackupPart(encrypted,key,'backup','part'),bytes);await assert.rejects(decryptBackupPart(encrypted,key,'other','part'));await assert.rejects(decryptBackupPart(encrypted,'a'.repeat(64),'backup','part'));encrypted[25]^=1;await assert.rejects(decryptBackupPart(encrypted,key,'backup','part'));
});
test('full bytes roundtrip: coherent application, audio, exact pinned ZIP, no secrets and Telegram receipts',async()=>{
  const f=fixture(),result=await f.run();assert.equal(result.status,'sent');assert.equal(f.latest().status,'sent');assert.equal(f.sent.length,5);assert(f.sent.every(p=>p.chatId==='123'&&p.bytes.byteLength<50*1024*1024));
  assert(f.sent.every(p=>!new TextDecoder().decode(p.bytes).includes('must-never-export')));assert(!JSON.stringify(f.latest()).includes(TOKEN));
  const receipt=JSON.parse(new TextDecoder().decode(f.sent.find(p=>p.name.endsWith('receipt.json')).bytes)),entries=new Map();
  const report=await verifyBackup({receipt,key:f.settings.get('backup_recovery_key'),readPart:async name=>f.sent.find(p=>p.name===name)?.bytes,writeEntry:async(name,bytes)=>entries.set(name,bytes)});
  assert.equal(report.entries.length,3);assert.deepEqual(entries.get('source.zip'),ZIP);assert.deepEqual(entries.get('storage/arios-audio/'+f.item.name),new Uint8Array([0,1,2,255]));
  const data=JSON.parse(new TextDecoder().decode(entries.get('application.json')));assert.equal(data.state.data.reports[0].minutes,60);assert.equal(data.state.data.financeEntries[0].amount,120000);assert.equal(data.profiles[0].auth_user_id,'auth1');assert.equal(data.settings.telegram_offset,55);assert.equal(data.state.data.users[0].passwordHash,undefined);assert(!JSON.stringify(data).includes('never-archive'));
  await f.run();assert.equal(f.sent.length,5,'same weekly slot never sends twice');
});
test('verify refuses missing/corrupt parts and wrong recovery key, never creates a false success',async()=>{
  const f=fixture();await f.run();const receipt=JSON.parse(new TextDecoder().decode(f.sent.at(-1).bytes)),key=f.settings.get('backup_recovery_key');
  await assert.rejects(verifyBackup({receipt,key,readPart:async()=>undefined}),/Missing/);
  await assert.rejects(verifyBackup({receipt,key:{...key,key:'b'.repeat(64)},readPart:async name=>f.sent.find(p=>p.name===name)?.bytes}),/identifier/);
  const damaged=structuredClone(f.sent);damaged[0].bytes[30]^=1;await assert.rejects(verifyBackup({receipt,key,readPart:async name=>damaged.find(p=>p.name===name)?.bytes}),/damaged/);
});
test('resumable batches and manual clicks continue the same in-flight job',async()=>{
  const f=fixture();await f.run({maxSteps:1});const id=f.latest().id;assert.equal(f.sent.length,0);await f.run({maxSteps:1,manual:true});assert.equal(f.latest().id,id);assert.equal(f.settings.get('backup_index').length,1);await f.run();assert.equal(f.latest().status,'sent');
  const sunday=AT+86400000;await f.run({manual:true,at:sunday});const count=f.sent.length;await f.run({at:sunday});assert.equal(f.sent.length,count,'manual Sunday covers current weekly slot');
});
test('immutable Storage SQL metadata is checked before and after bytes, not SDK info lastModified',async()=>{
  const f=fixture();let info=0;const rpc=f.client.rpc;f.client.rpc=async(name,args)=>{if(name==='arios_backup_object_info'){info++;const value=await rpc(name,args);if(info===2)value.data.updatedAt='2026-10-30T12:13:14.123457+00:00';return value;}return rpc(name,args);};
  await f.run();assert.equal(info,2);assert.equal(f.latest().status,'failed');assert.equal(f.latest().errorCode,'BACKUP_OBJECT_CHANGED');assert.equal(f.sent.length,0);
});
test('normal business edits during collection retain the original snapshot revision',async()=>{
  const f=fixture();await f.run({maxSteps:1});f.repo.loadState=async()=>({state:structuredClone(f.state),revision:99});await f.run();assert.equal(f.latest().status,'sent');assert.equal(f.latest().revision,12);assert.equal(f.latest().endingRevision,99);
});
test('source step crash after complete file resumes idempotently without duplicate logical chunks',async()=>{
  const f=fixture({audio:false});await f.run({maxSteps:1});const job=f.latest();assert(job.sourceDone);job.sourceDone=false;f.settings.set('backup_job:'+job.id,job);await f.run();assert.equal(f.latest().status,'sent');assert.equal(f.latest().parts.filter(p=>p.name==='source.zip').length,1);
});
test('multi-chunk source retries after first persisted chunk without duplicate offsets',async()=>{
  const f=fixture({audio:false}),large=new Uint8Array(BACKUP_CHUNK_BYTES+10);large.set([80,75]);const fetcher=async(url,options)=>url.startsWith('https://codeload.github.com/')?new Response(large):f.fetcher(url,options);
  await f.run({maxSteps:1,fetcher});const job=f.latest(),sourceParts=job.parts.filter(p=>p.name==='source.zip');assert.equal(sourceParts.length,2);
  const second=sourceParts[1];job.parts=job.parts.filter(p=>p.id!==second.id);job.sourceDone=false;f.settings.set('backup_job:'+job.id,job);f.files.delete('arios-backups/'+second.path);
  await f.run({fetcher});assert.equal(f.latest().status,'sent');const chunks=f.latest().parts.filter(p=>p.name==='source.zip');assert.deepEqual(chunks.map(p=>p.offset),[0,BACKUP_CHUNK_BYTES]);
});
test('no backup goes to unlinked, archived, nonmanager or changed recipient',async()=>{
  const f=fixture();f.snapshot.telegramLinks[0].chat_id='-123';await f.run();assert.equal(f.sent.length,0);assert.equal(f.settings.get('backup_last_error').code,'BACKUP_RECIPIENT_UNAVAILABLE');
  const changed=fixture();await changed.run({maxSteps:3});changed.snapshot.telegramLinks[0].chat_id='999';changed.snapshot.telegramLinks[0].telegram_user_id='999';await changed.run();assert.equal(changed.sent.length,0);assert.equal(changed.latest().status,'failed');assert.equal(changed.latest().errorCode,'BACKUP_RECIPIENT_CHANGED');
});
test('uncertain send is paused permanently until explicit retry,429defers safely',async()=>{
  const f=fixture();let calls=0;await f.run({fetcher:async(url,options)=>url.startsWith('https://codeload.github.com/')?f.fetcher(url,options):(++calls,Promise.reject(Error('network')))});assert.equal(calls,1);assert.equal(f.latest().status,'unknown');await f.run();assert.equal(f.sent.length,0);
  const rate=fixture();await rate.run({fetcher:async(url,options)=>url.startsWith('https://codeload.github.com/')?rate.fetcher(url,options):json({ok:false,error_code:429,parameters:{retry_after:120}},429)});assert.equal(rate.latest().status,'sending');assert(rate.latest().parts.find(p=>p.delivery.status==='pending').delivery.nextAttemptAt);await rate.run();assert.equal(rate.sent.length,0);
});
test('a worker crash before send acknowledgement leaves sending marker unknown, without replay',async()=>{
  const f=fixture();await f.run({maxSteps:3});const job=f.latest();job.parts[0].delivery={status:'sending',attempts:1};job.status='sending';f.settings.set('backup_job:'+job.id,job);await f.run();assert.equal(f.latest().status,'unknown');assert.equal(f.sent.length,0);
});
test('retention bounds successful local copies to eight and256MB after confirmed delivery',async()=>{
  const f=fixture({audio:false});await ensureBackupKey(f.repo);const old=[];for(let i=0;i<9;i++){const id=crypto.randomUUID(),path=id+'/old.arios';old.push(id);f.files.set('arios-backups/'+path,new Uint8Array([i]));f.settings.set('backup_job:'+id,{id,status:'sent',createdAt:new Date(AT-i*86400000).toISOString(),parts:[{id:'part-00001',path,cipherBytes:80*1024*1024,delivery:{status:'sent'}}]});}f.settings.set('backup_index',old);
  await f.run();assert.equal(f.latest().status,'sent');const retained=f.settings.get('backup_index').map(id=>f.settings.get('backup_job:'+id));assert.equal(retained.filter(j=>j.status==='sent').length,4);assert(f.removed.length>=6);assert(f.files.has('arios-backups/'+f.latest().parts[0].path));
});
test('manager-only routes never expose key in status, require own recipient and prevent stranger downloads',async()=>{
  const f=fixture();await f.run();const status=await backupStatus({repo:f.repo,user:f.users[0]});assert.equal(status.keyReady,true);assert.equal(status.key,undefined);assert(!JSON.stringify(status).includes(f.settings.get('backup_recovery_key').key));
  const handle=(user,path,body={})=>handleBackups({repo:f.repo,supabase:f.client,user,request:new Request('https://arios.test'+path,{method:'POST'}),path,readJSON:async()=>body,json});
  await assert.rejects(handle({id:'worker',role:'worker'},'/api/backups/recovery-key'),error=>error.status===403);
  await assert.rejects(handle(f.users[0],'/api/backups/file',{backupId:crypto.randomUUID(),partId:'part-00001'}),error=>error.status===404);
  const keyResponse=await handle(f.users[0],'/api/backups/recovery-key');assert.equal((await keyResponse.json()).recoveryKey.format,'arios-backup-key/v1');
});
test('capacity and source pin fail visibly before making a misleading archive',async()=>{
  const f=fixture();f.settings.get('backup_config').sourceRef='main';await f.run();assert.equal(f.sent.length,0);assert.equal(f.settings.get('backup_last_error').code,'BACKUP_SOURCE_NOT_PINNED');
  const huge=fixture();huge.snapshot.objects=Array.from({length:20},(_,i)=>({...huge.item,name:'voice/manager/a'+i+'.ogg',size:20*1024*1024}));await huge.run();assert.equal(huge.settings.get('backup_last_error').code,'BACKUP_CAPACITY_EXCEEDED');assert.equal(huge.sent.length,0);
});
