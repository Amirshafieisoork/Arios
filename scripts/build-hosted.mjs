import { build } from 'esbuild';
import { readFile, readdir, mkdir, rm, cp, writeFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
const root=resolve(import.meta.dirname,'..');
const dist=resolve(root,'dist');
const types={'.html':'text/html; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.ttf':'font/ttf','.png':'image/png','.webp':'image/webp','.txt':'text/plain; charset=utf-8'};
const assets={};
async function walk(dir,prefix=''){for(const entry of await readdir(dir,{withFileTypes:true})){if(entry.name.startsWith('.')||entry.isSymbolicLink())continue;const path=resolve(dir,entry.name),name=prefix+'/'+entry.name;if(entry.isDirectory())await walk(path,name);else if(entry.isFile()){const data=await readFile(path);assets[name]={mime:types[extname(name)]||'application/octet-stream',data:data.toString('base64')};}}}
await walk(resolve(root,'public'));
try { const source=await readFile(resolve(root,'../deliverables/ARIOS_OS_source.zip')); assets['/downloads/ARIOS_OS_source.zip']={mime:'application/zip',data:source.toString('base64')}; } catch(error) { if(error.code!=='ENOENT') throw error; }
if(Buffer.from(assets['/preview-config.mjs'].data,'base64').toString().includes('= true'))throw Error('Hosted app must use real API.');
await rm(dist,{recursive:true,force:true});
await mkdir(resolve(dist,'server'),{recursive:true});
await mkdir(resolve(dist,'.openai'),{recursive:true});
await build({entryPoints:[resolve(root,'worker/index.mjs')],bundle:true,format:'esm',platform:'browser',target:'es2022',outfile:resolve(dist,'server/index.js'),minify:false,plugins:[{name:'arios-assets',setup(b){b.onLoad({filter:/\/worker\/assets\.mjs$/},()=>({contents:'export default '+JSON.stringify(assets),loader:'js'}));}}]});
await cp(resolve(root,'.openai/hosting.json'),resolve(dist,'.openai/hosting.json'));
await cp(resolve(root,'drizzle'),resolve(dist,'.openai/drizzle'),{recursive:true});
await writeFile(resolve(dist,'server/package.json'),JSON.stringify({type:'module'}));
console.log(`Hosted Worker built with ${Object.keys(assets).length} assets and D1 migrations.`);
