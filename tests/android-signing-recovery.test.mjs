import test from 'node:test';
import assert from 'node:assert/strict';
import {encryptBackupPart,sha256} from '../supabase/functions/arios-api/backup-format.mjs';
import {decryptSigningRecovery} from '../scripts/recover-android-signing.mjs';

async function fixture(){
  const bytes=new Uint8Array([80,75,3,4,1,2,3,4,5,6]),secret='ab'.repeat(32),key={format:'arios-backup-key/v1',key:secret,keyId:(await sha256(new TextEncoder().encode(secret))).slice(0,12)};
  const metadata={format:'arios-android-signing-recovery/v1',encryptionFormat:'arios-backup/v1',backupId:'12345678-1234-1234-1234-123456789abc',itemId:'android-release-signing.zip',keyId:key.keyId,sha256:await sha256(bytes),bytes:bytes.length,signerCertificateSha256:'cd'.repeat(32)};
  const ciphertext=await encryptBackupPart(bytes,secret,metadata.backupId,metadata.itemId);
  return {metadata,key,ciphertext,bytes};
}
test('Android signing recovery decrypts only an authenticated ZIP matching public metadata',async()=>{
  const f=await fixture();assert.deepEqual(await decryptSigningRecovery(f),f.bytes);
});
test('Android signing recovery rejects wrong keys including forged matching key identifiers',async()=>{
  const f=await fixture();await assert.rejects(decryptSigningRecovery({...f,key:{...f.key,key:'ef'.repeat(32)}}),/identifier mismatch/);
  const wrongKey='ef'.repeat(32),wrongId=(await sha256(new TextEncoder().encode(wrongKey))).slice(0,12);
  await assert.rejects(decryptSigningRecovery({...f,metadata:{...f.metadata,keyId:wrongId},key:{...f.key,key:wrongKey,keyId:wrongId}}),/authentication failed/);
});
test('Android signing recovery rejects tampering, truncation and changed authenticated item identity',async()=>{
  const f=await fixture(),damaged=f.ciphertext.slice();damaged[damaged.length-1]^=1;
  await assert.rejects(decryptSigningRecovery({...f,ciphertext:damaged}),/authentication failed/);
  await assert.rejects(decryptSigningRecovery({...f,ciphertext:f.ciphertext.slice(0,-1)}),/ciphertext/);
  await assert.rejects(decryptSigningRecovery({...f,metadata:{...f.metadata,backupId:'22345678-1234-1234-1234-123456789abc'}}),/authentication failed/);
});
test('Android signing recovery rejects mismatched digest, size, format and non-ZIP plaintext',async()=>{
  const f=await fixture();
  for(const change of [{sha256:'00'.repeat(32)},{bytes:f.bytes.length+1},{format:'unknown'},{encryptionFormat:'unknown'}])await assert.rejects(decryptSigningRecovery({...f,metadata:{...f.metadata,...change}}));
  const bytes=new Uint8Array([80,75,9,9,1,2,3,4,5,6]),ciphertext=await encryptBackupPart(bytes,f.key.key,f.metadata.backupId,f.metadata.itemId);
  await assert.rejects(decryptSigningRecovery({...f,ciphertext,metadata:{...f.metadata,sha256:await sha256(bytes)}}),/format mismatch/);
});
