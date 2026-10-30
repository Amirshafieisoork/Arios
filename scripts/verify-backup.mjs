#!/usr/bin/env node
/** Offline verification/decryption only. Never connects to or writes production. */
import {readFile,mkdtemp,mkdir,writeFile,rename,rm,lstat} from 'node:fs/promises';
import {dirname,resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {BACKUP_FORMAT,decryptBackupPart,safeBackupName,sha256} from '../supabase/functions/arios-api/backup-format.mjs';

const validId=id=>typeof id==='string'&&/^[a-f0-9-]{36}$/.test(id);
const failure=message=>{throw new Error(message);};
export async function verifyBackup({receipt,key,readPart,writeEntry=async()=>{}}) {
  if(receipt?.format!==BACKUP_FORMAT||!validId(receipt.backupId)||key?.format!=='arios-backup-key/v1'||receipt.keyId!==key.keyId||!Array.isArray(receipt.parts)||receipt.parts.length>10000)failure('Invalid backup receipt or recovery key');
  if((await sha256(new TextEncoder().encode(key.key))).slice(0,12)!==key.keyId)failure('Recovery key identifier mismatch');
  const all=[receipt.manifest,...receipt.parts],ids=new Set();
  for(const part of all){if(!part||typeof part.id!=='string'||!/^manifest$|^part-\d{5}$/.test(part.id)||ids.has(part.id)||!safeBackupName(part.file)||part.file.includes('/')||!/^[a-f0-9]{64}$/.test(part.cipherSha256||''))failure('Invalid or duplicate backup part');ids.add(part.id);}
  if(receipt.manifest.id!=='manifest')failure('Missing encrypted manifest');
  const load=async part=>{const bytes=await readPart(part.file);if(!(bytes instanceof Uint8Array)||bytes.byteLength>16*1024*1024+36||await sha256(bytes)!==part.cipherSha256)failure('Missing, oversized or damaged backup part: '+part.file);return decryptBackupPart(bytes,key.key,receipt.backupId,part.id);};
  const manifest=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await load(receipt.manifest)));
  if(manifest?.format!==BACKUP_FORMAT||manifest.backupId!==receipt.backupId||manifest.keyId!==receipt.keyId||!Array.isArray(manifest.entries)||manifest.entries.length!==receipt.parts.length||!/^[a-f0-9]{40}$/.test(manifest.sourceRef||''))failure('Manifest does not match receipt');
  const groups=new Map(),used=new Set();
  for(const entry of manifest.entries){
    if(!safeBackupName(entry.name)||!['application.json','source.zip'].includes(entry.name)&&!/^storage\/(arios-audio|arios-project-files)\//.test(entry.name)||!Number.isSafeInteger(entry.bytes)||entry.bytes<0||entry.bytes>16*1024*1024||!Number.isSafeInteger(entry.totalBytes)||entry.totalBytes<0||entry.totalBytes>64*1024*1024||!Number.isSafeInteger(entry.offset)||entry.offset<0||entry.offset+entry.bytes>entry.totalBytes||!/^[a-f0-9]{64}$/.test(entry.sha256||'')||used.has(entry.id)||!receipt.parts.some(p=>p.id===entry.id))failure('Invalid file entry in manifest');
    used.add(entry.id);if(!groups.has(entry.name))groups.set(entry.name,[]);groups.get(entry.name).push(entry);
  }
  if(!groups.has('application.json')||!groups.has('source.zip'))failure('Application data or source archive missing');
  const verified=[];
  for(const [name,chunks] of groups){
    chunks.sort((a,b)=>a.offset-b.offset);let cursor=0;const total=chunks[0].totalBytes,out=new Uint8Array(total);
    for(const chunk of chunks){if(chunk.offset!==cursor||chunk.totalBytes!==total)failure('File chunks overlap or are incomplete: '+name);const bytes=await load(receipt.parts.find(p=>p.id===chunk.id));if(bytes.byteLength!==chunk.bytes||await sha256(bytes)!==chunk.sha256)failure('Decrypted file checksum mismatch: '+name);out.set(bytes,cursor);cursor+=bytes.byteLength;}
    if(cursor!==total)failure('File is incomplete: '+name);
    if(name==='application.json'){const snapshot=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(out));if(snapshot.format!=='arios-application-snapshot/v1'||!Array.isArray(snapshot.state?.data?.users)||snapshot.state.revision!==manifest.stateRevision||!Array.isArray(snapshot.profiles))failure('Application snapshot schema mismatch');}
    if(name==='source.zip'&&(out[0]!==80||out[1]!==75))failure('Source archive is not ZIP');
    await writeEntry(name,out);verified.push({name,bytes:out.byteLength,sha256:await sha256(out)});
  }
  return {format:BACKUP_FORMAT,backupId:receipt.backupId,sourceRef:manifest.sourceRef,stateRevision:manifest.stateRevision,capturedAt:manifest.capturedAt,entries:verified};
}

async function main(args) {
  const input={};for(let i=0;i<args.length;i+=2){if(!['--receipt','--key','--out'].includes(args[i])||!args[i+1])failure('Usage: node scripts/verify-backup.mjs --receipt receipt.json --key recovery-key.json --out NEW_DIRECTORY');input[args[i].slice(2)]=args[i+1];}
  if(!input.receipt||!input.key||!input.out)failure('Usage: node scripts/verify-backup.mjs --receipt receipt.json --key recovery-key.json --out NEW_DIRECTORY');
  const target=resolve(input.out);try{await lstat(target);failure('Output directory must not already exist');}catch(error){if(error.code!=='ENOENT')throw error;}
  const receiptPath=resolve(input.receipt),receipt=JSON.parse(await readFile(receiptPath,'utf8')),key=JSON.parse(await readFile(resolve(input.key),'utf8'));
  const temporary=await mkdtemp(join(dirname(target),'.arios-restore-'));
  try{
    const report=await verifyBackup({receipt,key,readPart:async name=>new Uint8Array(await readFile(resolve(dirname(receiptPath),name))),writeEntry:async(name,bytes)=>{const path=resolve(temporary,name);await mkdir(dirname(path),{recursive:true,mode:0o700});await writeFile(path,bytes,{mode:0o600,flag:'wx'});}});
    await writeFile(join(temporary,'verification.json'),JSON.stringify(report,null,2),{mode:0o600,flag:'wx'});await rename(temporary,target);
    console.log(`Verified ${report.entries.length} files. Offline recovery files written to ${target}. No database was changed.`);
  }catch(error){await rm(temporary,{recursive:true,force:true});throw error;}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main(process.argv.slice(2)).catch(error=>{console.error(error.message);process.exitCode=1;});
