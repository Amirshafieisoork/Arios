/** Weekly encrypted application + object bytes + pinned source backup.
 * Invoked ONLY after the existing scheduler signature has been verified, or by
 * an authenticated manager. Telegram receives ciphertext, never provider keys.
 */
import {APIError, manager} from './auth.mjs';
import {getConfig} from './voice-service.mjs';
import {BACKUP_FORMAT,BACKUP_CHUNK_BYTES,encryptBackupPart,redactBackupSecrets,safeBackupName,sha256,weeklyBackupSlot,hex} from './backup-format.mjs';

const BUCKET='arios-backups', CONFIG='backup_config', KEY='backup_recovery_key', INDEX='backup_index';
const encoder=new TextEncoder(), MAX_SOURCE=48*1024*1024, MAX_OBJECT=20*1024*1024, RETENTION_BYTES=256*1024*1024;
const fail=(message,status=400,code='BACKUP_INVALID')=>{throw new APIError(message,status,code);};
const db=async request=>{const result=await request;if(result?.error)throw new Error('BACKUP_STORAGE_UNAVAILABLE');return result?.data;};
const object=value=>value&&typeof value==='object'&&!Array.isArray(value)?value:{};
const idOK=id=>typeof id==='string'&&/^[a-f0-9-]{36}$/.test(id);
const jobKey=id=>'backup_job:'+id;
const errorCode=error=>/^BACKUP_[A-Z_]+$/.test(error?.message||'')?error.message:'BACKUP_UNAVAILABLE';
const fileName=(job,id)=>`Arios-${job.week}-${job.id.slice(0,8)}-${id}.arios`;

export async function ensureBackupKey(repo) {
  let key=await repo.getSetting(KEY);
  if(key&&/^[a-f0-9]{64}$/.test(key.key||'')&&/^[a-f0-9]{12}$/.test(key.keyId||'')){
    if((await sha256(encoder.encode(key.key))).slice(0,12)!==key.keyId)throw new Error('BACKUP_KEY_INVALID');return key;
  }
  if(key||((await repo.getSetting(INDEX))||[]).length)throw new Error('BACKUP_KEY_MISSING');
  // Caller holds weekly-backup lock: concurrent setup must never replace a key
  // that has already encrypted an archive.
  const secret=hex(crypto.getRandomValues(new Uint8Array(32)));
  key={format:'arios-backup-key/v1',key:secret,keyId:(await sha256(encoder.encode(secret))).slice(0,12),createdAt:new Date().toISOString()};
  await repo.setSetting(KEY,key);return key;
}

async function privateRecipient(repo,config) {
  const [loaded,links]=await Promise.all([repo.loadState(),repo.listTelegramLinks()]);
  const user=loaded?.state?.users?.find(person=>person.id===config.targetUserId&&person.role==='manager'&&!person.deletedAt);
  const link=links?.find(link=>link.user_id===user?.id&&/^\d{1,20}$/.test(String(link.chat_id))&&String(link.chat_id)===String(link.telegram_user_id));
  if(!user||!link)throw new Error('BACKUP_RECIPIENT_UNAVAILABLE');
  return {userId:user.id,chatId:String(link.chat_id)};
}

async function uploadPart({repo,supabase,job,key,id,name,bytes,offset=0,totalBytes=bytes.byteLength}) {
  if(!safeBackupName(name)||bytes.byteLength>BACKUP_CHUNK_BYTES)throw new Error('BACKUP_PART_INVALID');
  const encrypted=await encryptBackupPart(bytes,key.key,job.id,id),path=`${job.id}/${id}.arios`;
  await db(supabase.storage.from(BUCKET).upload(path,encrypted,{contentType:'application/octet-stream',upsert:true}));
  const descriptor={id,name,path,file:fileName(job,id),bytes:bytes.byteLength,totalBytes,offset,sha256:await sha256(bytes),cipherSha256:await sha256(encrypted),cipherBytes:encrypted.byteLength,delivery:{status:'pending',attempts:0}};
  const existing=job.parts.findIndex(part=>part.id===id);if(existing<0)job.parts.push(descriptor);else job.parts[existing]=descriptor;
  await repo.setSetting(jobKey(job.id),job);return descriptor;
}
async function uploadFile(context,name,bytes) {
  for(let offset=0;offset<bytes.byteLength||offset===0;offset+=BACKUP_CHUNK_BYTES){
    const chunk=bytes.slice(offset,offset+BACKUP_CHUNK_BYTES),existing=context.job.parts.find(part=>part.name===name&&part.offset===offset);
    if(existing){if(existing.bytes!==chunk.byteLength||existing.totalBytes!==bytes.byteLength||existing.sha256!==await sha256(chunk))throw new Error('BACKUP_OBJECT_CHANGED');continue;}
    const id='part-'+String(context.job.parts.length+1).padStart(5,'0');
    await uploadPart({...context,id,name,bytes:chunk,offset,totalBytes:bytes.byteLength});
  }
}

async function boundedFetchBytes(url,fetcher,max) {
  const response=await fetcher(url,{redirect:'error',signal:AbortSignal.timeout(25000),headers:{Accept:'application/octet-stream','User-Agent':'Arios-Backup/1'}});
  if(!response.ok)throw new Error('BACKUP_SOURCE_UNAVAILABLE');
  if(Number(response.headers.get('content-length'))>max)throw new Error('BACKUP_SOURCE_TOO_LARGE');
  const reader=response.body?.getReader();if(!reader)throw new Error('BACKUP_SOURCE_UNAVAILABLE');
  const chunks=[];let size=0;
  try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>max){await reader.cancel();throw new Error('BACKUP_SOURCE_TOO_LARGE');}chunks.push(value);}}finally{reader.releaseLock();}
  const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}return bytes;
}

async function startJob({repo,supabase,config,key,at,manual=false}) {
  if(!/^[a-f0-9]{40}$/.test(config.sourceRef||''))throw new Error('BACKUP_SOURCE_NOT_PINNED');
  const recipient=await privateRecipient(repo,config),snapshot=await db(supabase.rpc('arios_backup_snapshot'));
  if(!snapshot?.state?.data?.users||!Array.isArray(snapshot.objects)||snapshot.objects.length>10000)throw new Error('BACKUP_SNAPSHOT_INVALID');
  for(const item of snapshot.objects)if(!['arios-audio','arios-project-files'].includes(item.bucket)||!safeBackupName(item.name)||!Number.isSafeInteger(item.size)||item.size<1||item.size>MAX_OBJECT)throw new Error('BACKUP_OBJECT_INVALID');
  // This Free-plan installation has 1GB Storage. Two generations can coexist
  // during replacement without unbounded weekly multiplication of media bytes.
  if(snapshot.objects.reduce((sum,item)=>sum+item.size,0)+MAX_SOURCE+32*1024*1024>RETENTION_BYTES)throw new Error('BACKUP_CAPACITY_EXCEEDED');
  const job={id:crypto.randomUUID(),format:BACKUP_FORMAT,week:weeklyBackupSlot(at).week,weeklySlot:weeklyBackupSlot(at).week,createdAt:new Date(at).toISOString(),status:'collecting',trigger:manual?'manual':'weekly',keyId:key.keyId,sourceRef:config.sourceRef,recipient,revision:snapshot.state.revision,objects:snapshot.objects,objectCursor:0,sourceDone:false,dataDone:false,parts:[],attempts:0};
  if(manual)job.week=new Date(at+12600000).toISOString().slice(0,10);
  const index=(await repo.getSetting(INDEX))||[];
  if(index.length>=100)throw new Error('BACKUP_HISTORY_CAPACITY');
  await repo.setSetting(jobKey(job.id),job);await repo.setSetting(INDEX,[job.id,...index.filter(id=>id!==job.id)]);
  const exportData=redactBackupSecrets({...snapshot,objects:undefined,exclusions:['Auth passwords, Auth sessions and native Passkey credentials','API keys, bot tokens, scheduler signing keys and recovery key','temporary link codes, leases and rate limits']});
  const bytes=encoder.encode(JSON.stringify(exportData));if(bytes.byteLength>32*1024*1024)throw new Error('BACKUP_SNAPSHOT_TOO_LARGE');
  try{await uploadFile({repo,supabase,job,key},'application.json',bytes);job.dataDone=true;await repo.setSetting(jobKey(job.id),job);}
  catch(error){job.status='failed';job.errorPhase='collecting';job.errorCode=errorCode(error);await repo.setSetting(jobKey(job.id),job);throw error;}
  return job;
}

async function objectBytes(supabase,item) {
  const store=supabase.storage.from(item.bucket);
  // Storage info() uses lastModified, which is not the DB updated_at captured by
  // the snapshot. Compare the exact same DB metadata on both sides instead.
  const info=()=>db(supabase.rpc('arios_backup_object_info',{p_bucket:item.bucket,p_name:item.name}));
  const valid=value=>value&&String(value.id)===String(item.id)&&value.updatedAt===item.updatedAt&&Number(value.size)===item.size;
  if(!valid(await info()))throw new Error('BACKUP_OBJECT_CHANGED');
  const blob=await db(store.download(item.name));if(!blob||blob.size!==item.size||blob.size>MAX_OBJECT)throw new Error('BACKUP_OBJECT_INCOMPLETE');
  const bytes=new Uint8Array(await blob.arrayBuffer());
  if(!valid(await info()))throw new Error('BACKUP_OBJECT_CHANGED');
  return bytes;
}

async function finalizeJob({repo,supabase,job,key,at}) {
  // Rows are a single-MVCC snapshot and every object has its original immutable
  // id/mtime checked around the download. Subsequent business edits are allowed:
  // they belong to the next snapshot, not to this captured revision.
  const current=await repo.loadState();job.endingRevision=current?.revision??null;
  const manifest={format:BACKUP_FORMAT,backupId:job.id,keyId:job.keyId,capturedAt:job.createdAt,sourceRef:job.sourceRef,stateRevision:job.revision,endingRevision:job.endingRevision,entries:job.parts.filter(p=>p.id!=='manifest'&&p.id!=='receipt').map(({id,name,bytes,totalBytes,offset,sha256})=>({id,name,bytes,totalBytes,offset,sha256})),exclusions:['Supabase Auth password hashes, sessions and native Passkeys','Provider secrets; configure them again after disaster recovery']};
  const descriptor=await uploadPart({repo,supabase,job,key,id:'manifest',name:'manifest.json',bytes:encoder.encode(JSON.stringify(manifest))});
  const receipt={format:BACKUP_FORMAT,backupId:job.id,keyId:job.keyId,createdAt:job.createdAt,manifest:{id:descriptor.id,file:descriptor.file,cipherSha256:descriptor.cipherSha256},parts:job.parts.filter(p=>p.id!=='manifest').map(p=>({id:p.id,file:p.file,cipherSha256:p.cipherSha256}))};
  const bytes=encoder.encode(JSON.stringify(receipt,null,2)),path=`${job.id}/receipt.json`;
  await db(supabase.storage.from(BUCKET).upload(path,bytes,{contentType:'application/json',upsert:true}));
  job.parts=job.parts.filter(p=>p.id!=='receipt');job.parts.push({id:'receipt',file:`Arios-${job.week}-${job.id.slice(0,8)}-receipt.json`,path,cipherSha256:await sha256(bytes),cipherBytes:bytes.byteLength,delivery:{status:'pending',attempts:0}});
  job.status='sending';job.verifiedAt=new Date(at).toISOString();delete job.objects;await repo.setSetting(jobKey(job.id),job);
}

/** sendDocument returns uncertain status on ambiguous acknowledgement; never
 * automatically duplicate a potentially delivered archive part. */
export async function sendBackupDocument({token,chatId,file,bytes,caption,fetcher=fetch}) {
  if(!/^\d+:[A-Za-z0-9_-]{20,}$/.test(token||''))return {status:'failed',code:'BACKUP_BOT_UNAVAILABLE'};
  const form=new FormData();form.set('chat_id',chatId);form.set('caption',caption);form.set('document',new Blob([bytes],{type:'application/octet-stream'}),file);
  try{
    const response=await fetcher(`https://api.telegram.org/bot${token}/sendDocument`,{method:'POST',body:form,redirect:'error',signal:AbortSignal.timeout(25000)});
    const raw=await boundedResponseJSON(response,32768);
    if(response.ok&&raw?.ok===true&&Number.isSafeInteger(raw.result?.message_id))return {status:'sent',messageId:String(raw.result.message_id)};
    if(raw?.ok===false&&Number(raw.error_code)===429)return {status:'pending',code:'BACKUP_TELEGRAM_RATE_LIMIT',retryMs:Math.max(60000,Math.min(3600000,Number(raw.parameters?.retry_after)*1000||60000))};
    if(raw?.ok===false&&Number(raw.error_code)>=400&&Number(raw.error_code)<500)return {status:'failed',code:'BACKUP_TELEGRAM_REJECTED'};
    return {status:'unknown',code:'BACKUP_DELIVERY_UNCERTAIN'};
  }catch{return {status:'unknown',code:'BACKUP_DELIVERY_UNCERTAIN'};}
}
async function boundedResponseJSON(response,max){const bytes=await (async()=>{const reader=response.body?.getReader();if(!reader)throw Error();const chunks=[];let size=0;try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>max){await reader.cancel();throw Error();}chunks.push(value);}}finally{reader.releaseLock();}const out=new Uint8Array(size);let cursor=0;for(const chunk of chunks){out.set(chunk,cursor);cursor+=chunk.byteLength;}return out;})();return JSON.parse(new TextDecoder().decode(bytes));}

async function deliverPart({repo,supabase,config,job,part,fetcher,at}) {
  const recipient=await privateRecipient(repo,config);
  if(recipient.userId!==job.recipient.userId||recipient.chatId!==job.recipient.chatId)throw new Error('BACKUP_RECIPIENT_CHANGED');
  const bot=await getConfig(repo),blob=await db(supabase.storage.from(BUCKET).download(part.path));
  const bytes=new Uint8Array(await blob.arrayBuffer());if(await sha256(bytes)!==part.cipherSha256)throw new Error('BACKUP_STORED_PART_CHANGED');
  part.delivery={status:'sending',attempts:(part.delivery.attempts||0)+1,at:new Date(at).toISOString()};await repo.setSetting(jobKey(job.id),job);
  const outcome=await sendBackupDocument({token:bot.telegramBotToken,chatId:recipient.chatId,file:part.file,bytes,caption:part.id==='receipt'?`نسخهٔ پشتیبان هفتگی آریوس آماده است (${job.week}).\nتمام فایل‌های این مجموعه و کلید بازیابی را نگه دارید.\nرمزهای ورود و Passkey در این خروجی نیستند.`:`بک‌آپ رمزگذاری‌شدهٔ آریوس · ${job.week} · ${part.id}\nبرای بازیابی، کلید ذخیره‌شده در تنظیمات حساب لازم است.`,fetcher});
  Object.assign(part.delivery,outcome,{...(outcome.retryMs?{nextAttemptAt:new Date(at+outcome.retryMs).toISOString()}:{}),at:new Date(at).toISOString()});
  if(outcome.status==='failed'||outcome.status==='unknown'){job.status=outcome.status;job.errorCode=outcome.code;}
  await repo.setSetting(jobKey(job.id),job);
}

async function pruneBackups({repo,supabase,keep=8}) {
  const index=(await repo.getSetting(INDEX))||[],jobs=[];for(const id of index)if(idOK(id)){const job=await repo.getSetting(jobKey(id));if(job)jobs.push(job);}
  const retain=new Set();let retainedBytes=0;
  for(const job of jobs.filter(j=>j.status==='sent')){const bytes=(job.parts||[]).reduce((sum,p)=>sum+(p.cipherBytes||0),0);if(retain.size<keep&&(retainedBytes+bytes<=RETENTION_BYTES||retain.size===0)){retain.add(job.id);retainedBytes+=bytes;}}
  const expiredFailed=new Set(jobs.filter(j=>['failed','unknown'].includes(j.status)&&Date.now()-Date.parse(j.createdAt)>14*86400000).map(j=>j.id));
  for(const old of jobs.filter(j=>j.status==='sent'&&!retain.has(j.id)||expiredFailed.has(j.id))){
    const paths=(old.parts||[]).map(p=>p.path).filter(path=>typeof path==='string'&&path.startsWith(old.id+'/'));
    for(let i=0;i<paths.length;i+=100)await db(supabase.storage.from(BUCKET).remove(paths.slice(i,i+100)));
    await repo.deleteSetting(jobKey(old.id));
  }
  await repo.setSetting(INDEX,jobs.filter(j=>(j.status!=='sent'||retain.has(j.id))&&!expiredFailed.has(j.id)).map(j=>j.id));
}

/** Each signed tick does at most two bounded file operations; large datasets
 * continue on following ticks, with durable progress rather than an Edge timeout. */
export async function runWeeklyBackup({repo,supabase,fetcher=fetch,at=Date.now(),clock=Date.now,manual=false,maxSteps=2}) {
  const config=object(await repo.getSetting(CONFIG));if(config.enabled!==true&&!manual)return {skipped:true};
  const lock=crypto.randomUUID();if(!await repo.acquireLock('weekly-backup',lock,900000))return {busy:true};
  let job;
  try{
    const index=(await repo.getSetting(INDEX))||[],latest=idOK(index[0])?await repo.getSetting(jobKey(index[0])):null,slot=weeklyBackupSlot(at);
    const retryCollection=latest?.status==='failed'&&latest.errorPhase==='collecting'&&(latest.collectionAttempts||0)<3;
    job=['collecting','sending'].includes(latest?.status)?latest:null;
    const initial=config.initialRunPending===true;
    if(!job){
      if(!manual&&!initial&&!retryCollection&&(slot.dueAt<Date.parse(config.createdAt||'')||(latest?.weeklySlot||latest?.week)===slot.week))return {skipped:true};
      if(!manual&&!Number.isFinite(Date.parse(config.createdAt||'')))return {skipped:true};
      const key=await ensureBackupKey(repo);job=await startJob({repo,supabase,config,key,at,manual:manual||initial});job.collectionAttempts=retryCollection?(latest.collectionAttempts||0)+1:0;await repo.setSetting(jobKey(job.id),job);
      if(initial){config.initialRunPending=false;await repo.setSetting(CONFIG,config);}
    }
    const key=await repo.getSetting(KEY);if(key?.keyId!==job.keyId)throw new Error('BACKUP_KEY_MISSING');
    const started=clock();
    for(let step=0;step<maxSteps&&clock()-started<45000;step++){
      if(job.status==='collecting'){
        if(!job.dataDone)throw new Error('BACKUP_SNAPSHOT_INCOMPLETE');
        if(!job.sourceDone){const bytes=await boundedFetchBytes(`https://codeload.github.com/Amirshafieisoork/Arios/zip/${job.sourceRef}`,fetcher,MAX_SOURCE);if(bytes[0]!==80||bytes[1]!==75)throw new Error('BACKUP_SOURCE_INVALID');await uploadFile({repo,supabase,job,key},'source.zip',bytes);job.sourceDone=true;await repo.setSetting(jobKey(job.id),job);continue;}
        if(job.objectCursor<job.objects.length){const item=job.objects[job.objectCursor],bytes=await objectBytes(supabase,item);await uploadFile({repo,supabase,job,key},`storage/${item.bucket}/${item.name}`,bytes);job.objectCursor++;await repo.setSetting(jobKey(job.id),job);continue;}
        await finalizeJob({repo,supabase,job,key,at});continue;
      }
      if(job.status==='sending'){
        const stale=job.parts.find(part=>part.delivery?.status==='sending');if(stale){stale.delivery.status='unknown';job.status='unknown';job.errorCode='BACKUP_DELIVERY_UNCERTAIN';await repo.setSetting(jobKey(job.id),job);break;}
        const part=job.parts.find(part=>part.delivery?.status!=='sent');
        if(!part){job.status='sent';job.sentAt=new Date(at).toISOString();await repo.setSetting(jobKey(job.id),job);await pruneBackups({repo,supabase,keep:8});break;}
        if(part.delivery.status!=='pending'||Date.parse(part.delivery.nextAttemptAt||'')>at)break;
        await deliverPart({repo,supabase,config,job,part,fetcher,at});if(job.status!=='sending')break;
      }
    }
    return {backupId:job.id,status:job.status,parts:job.parts.length,sent:job.parts.filter(p=>p.delivery.status==='sent').length};
  }catch(error){
    const code=errorCode(error);if(job){job.errorPhase=job.status;job.status='failed';job.errorCode=code;await repo.setSetting(jobKey(job.id),job);}
    await repo.setSetting('backup_last_error',{at:new Date(at).toISOString(),code});return {status:'failed',errorCode:code};
  }finally{await repo.releaseLock('weekly-backup',lock);}
}

export async function backupStatus({repo,user}) {
  manager(user);const config=object(await repo.getSetting(CONFIG)),key=object(await repo.getSetting(KEY)),ids=(await repo.getSetting(INDEX))||[],jobs=[];
  for(const id of ids.slice(0,12))if(idOK(id)){const job=await repo.getSetting(jobKey(id));if(job)jobs.push({id:job.id,week:job.week,createdAt:job.createdAt,status:job.status,errorCode:job.errorCode||null,sentAt:job.sentAt||null,sourceRef:job.sourceRef,parts:job.parts?.length||0,sent:job.parts?.filter(p=>p.delivery?.status==='sent').length||0,files:job.parts?.map(p=>({id:p.id,file:p.file}))||[]});}
  let linked=false;try{await privateRecipient(repo,{targetUserId:config.targetUserId||user.id});linked=true;}catch{}
  return {enabled:config.enabled===true,targetIsYou:config.targetUserId===user.id,linked,schedule:'شنبه‌ها ساعت ۲۱:۱۵',timezone:'Asia/Tehran',retentionWeeks:8,retentionBytes:RETENTION_BYTES,keyReady:Boolean(key.keyId),keyId:key.keyId||null,recoveryKeySavedAt:config.recoveryKeySavedAt||null,sourcePinned:/^[a-f0-9]{40}$/.test(config.sourceRef||''),jobs,lastError:await repo.getSetting('backup_last_error'),excludesAuthCredentials:true};
}

export async function handleBackups({repo,supabase,user,request,path,readJSON,json,fetcher=fetch,at=Date.now()}) {
  if(!path.startsWith('/api/backups'))return null;
  manager(user);
  if(path==='/api/backups'&&request.method==='GET')return json(await backupStatus({repo,user}));
  if(path==='/api/backups/settings'&&request.method==='POST'){
    const payload=await readJSON(request,1024);if(typeof payload.enabled!=='boolean')fail('وضعیت بک‌آپ معتبر نیست.');
    const current=object(await repo.getSetting(CONFIG));if(payload.enabled)await privateRecipient(repo,{targetUserId:user.id});
    const index=(await repo.getSetting(INDEX))||[];
    await repo.setSetting(CONFIG,{...current,enabled:payload.enabled,targetUserId:user.id,createdAt:current.createdAt||new Date(at).toISOString(),timezone:'Asia/Tehran',schedule:'Saturday21:15',initialRunPending:payload.enabled&&index.length===0});
    return json(await backupStatus({repo,user}));
  }
  if(path==='/api/backups/recovery-key'&&request.method==='POST'){
    await readJSON(request,1024);const lock=crypto.randomUUID();if(!await repo.acquireLock('weekly-backup',lock,900000))fail('بک‌آپ در حال آماده‌سازی است؛ کمی بعد امتحان کنید.',409);
    try{const key=await ensureBackupKey(repo),config=object(await repo.getSetting(CONFIG));await repo.setSetting(CONFIG,{...config,recoveryKeySavedAt:new Date(at).toISOString()});return json({recoveryKey:key});}finally{await repo.releaseLock('weekly-backup',lock);}
  }
  if(path==='/api/backups/run'&&request.method==='POST'){
    await readJSON(request,1024);const config=object(await repo.getSetting(CONFIG));if(config.enabled!==true||config.targetUserId!==user.id)fail('ابتدا تلگرام خودتان را برای دریافت بک‌آپ فعال کنید.',409);
    return json(await runWeeklyBackup({repo,supabase,fetcher,at,manual:true,maxSteps:1}));
  }
  if(path==='/api/backups/file'&&request.method==='POST'){
    const payload=await readJSON(request,1024);if(!idOK(payload.backupId)||typeof payload.partId!=='string')fail('فایل بک‌آپ معتبر نیست.');
    const job=await repo.getSetting(jobKey(payload.backupId)),part=job?.parts?.find(item=>item.id===payload.partId);if(!part)fail('فایل بک‌آپ یافت نشد.',404);
    const result=await db(supabase.storage.from(BUCKET).createSignedUrl(part.path,60,{download:part.file}));return json({url:result.signedUrl,fileName:part.file});
  }
  if(path==='/api/backups/retry-delivery'&&request.method==='POST'){
    const payload=await readJSON(request,1024);if(!idOK(payload.backupId)||payload.confirmDuplicate!==true)fail('تأیید ارسال دوباره لازم است.');
    const lock=crypto.randomUUID();if(!await repo.acquireLock('weekly-backup',lock,900000))fail('بک‌آپ در حال اجراست؛ کمی بعد امتحان کنید.',409);
    try{const job=await repo.getSetting(jobKey(payload.backupId)),config=object(await repo.getSetting(CONFIG));if(!job||!['unknown','failed'].includes(job.status)||job.errorPhase==='collecting'||job.recipient.userId!==user.id||config.targetUserId!==user.id)fail('این مجموعه برای ارسال دوباره آماده نیست.',409);
      await privateRecipient(repo,config);for(const part of job.parts)if(part.delivery.status!=='sent')part.delivery={status:'pending',attempts:part.delivery.attempts||0};job.status='sending';delete job.errorCode;await repo.setSetting(jobKey(job.id),job);return json({ok:true});
    }finally{await repo.releaseLock('weekly-backup',lock);}
  }
  fail('مسیر بک‌آپ پیدا نشد.',404);
}
