#!/usr/bin/env node
/** Offline-only signing recovery. The public repository contains ciphertext. */
import {readFile,mkdir,writeFile,realpath} from 'node:fs/promises';
import {dirname,basename,resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {BACKUP_FORMAT,decryptBackupPart,sha256} from '../supabase/functions/arios-api/backup-format.mjs';

const root=resolve(import.meta.dirname,'..');
const fail=message=>{throw Error(message);};
const hex64=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
export async function decryptSigningRecovery({metadata,key,ciphertext}){
  if(metadata?.format!=='arios-android-signing-recovery/v1'||metadata.encryptionFormat!==BACKUP_FORMAT||!(/^[a-f0-9-]{36}$/).test(metadata.backupId||'')||metadata.itemId!=='android-release-signing.zip'||!hex64(metadata.sha256)||!hex64(metadata.signerCertificateSha256)||!Number.isSafeInteger(metadata.bytes)||metadata.bytes<4||metadata.bytes>65536)fail('Invalid signing recovery metadata');
  if(key?.format!=='arios-backup-key/v1'||typeof key.key!=='string'||!(/^[a-f0-9]{64}$/).test(key.key)||key.keyId!==metadata.keyId||(await sha256(new TextEncoder().encode(key.key))).slice(0,12)!==key.keyId)fail('Recovery key identifier mismatch');
  if(!(ciphertext instanceof Uint8Array)||ciphertext.byteLength!==metadata.bytes+36)fail('Invalid signing recovery ciphertext');
  let bytes;try{bytes=await decryptBackupPart(ciphertext,key.key,metadata.backupId,metadata.itemId);}catch{fail('Signing recovery authentication failed');}
  if(bytes.byteLength!==metadata.bytes||await sha256(bytes)!==metadata.sha256||bytes[0]!==80||bytes[1]!==75||bytes[2]!==3||bytes[3]!==4){bytes.fill(0);fail('Signing recovery archive checksum or format mismatch');}
  return bytes;
}

async function main(args){
  const options={};for(let i=0;i<args.length;i+=2){if(!['--key','--out'].includes(args[i])||!args[i+1]||options[args[i]])fail('Usage: node scripts/recover-android-signing.mjs --key PRIVATE_BACKUP_KEY.json --out NEW_PRIVATE_DIRECTORY');options[args[i]]=args[i+1];}
  if(!options['--key']||!options['--out'])fail('Both --key and --out are required');
  // Resolve the existing parent to reject symlink aliases into the checkout.
  const requested=resolve(options['--out']),target=join(await realpath(dirname(requested)),basename(requested)),checkout=await realpath(root);
  if(target===checkout||target.startsWith(checkout+'/'))fail('Signing recovery must be outside the source checkout');
  const metadata=JSON.parse(await readFile(join(root,'android-app/recovery/signing.json'),'utf8'));
  const key=JSON.parse(await readFile(resolve(options['--key']),'utf8'));
  const bytes=await decryptSigningRecovery({metadata,key,ciphertext:new Uint8Array(await readFile(join(root,'android-app/recovery/signing.arios')))});
  try{
    // mkdir without recursive is exclusive: existing files/directories are refused.
    await mkdir(target,{mode:0o700});
    await writeFile(join(target,'Arios-Android-signing-recovery.zip'),bytes,{mode:0o600,flag:'wx'});
    console.log(`Verified private signing archive written to ${target}. Extract it privately; never publish its contents.`);
  }finally{bytes.fill(0);}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main(process.argv.slice(2)).catch(error=>{console.error(error.message);process.exitCode=1;});
