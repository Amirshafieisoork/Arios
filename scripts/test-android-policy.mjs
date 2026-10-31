#!/usr/bin/env node
/** Execute the actual Android URL/file policy on a JVM, without device stubs. */
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';

const root=resolve(import.meta.dirname,'..');
const compiler=resolve(process.env.ARIOS_ANDROID_ECJ_JAR||'/workspace/work/android-toolchain/downloads/ecj-3.39.0.jar');
const java=process.env.ARIOS_ANDROID_JAVA||'java';
const compilerBytes=await readFile(compiler);
if(createHash('sha256').update(compilerBytes).digest('hex')!=='01f5a92ac19bb2b3bf85e295a68f2c73c264369109158b566ce9b490af982948')throw Error('Unexpected ECJ compiler checksum.');
const out=await mkdtemp(join(tmpdir(),'arios-android-policy-'));
function run(args){const result=spawnSync(java,args,{cwd:root,stdio:'inherit'});if(result.error)throw result.error;if(result.status!==0)throw Error('Android policy verification failed.');}
try{
  run(['-jar',compiler,'-17','-encoding','UTF-8','-d',out,'android-app/src/main/java/ir/arioshub/app/SecurityPolicy.java','android-app/tests/SecurityPolicyTest.java']);
  run(['-cp',out,'SecurityPolicyTest']);
}finally{await rm(out,{recursive:true,force:true});}
