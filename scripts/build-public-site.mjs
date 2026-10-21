import {build} from 'esbuild';
import {readFile,readdir,mkdir,rm,cp,writeFile} from 'node:fs/promises';
import {resolve,extname} from 'node:path';
const root=resolve(import.meta.dirname,'..'),dist=resolve(root,'dist'),assets={};
const types={'.html':'text/html; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.ttf':'font/ttf','.txt':'text/plain; charset=utf-8'};
async function walk(dir,prefix=''){for(const item of await readdir(dir,{withFileTypes:true})){if(item.name.startsWith('.')||item.isSymbolicLink())continue;const path=resolve(dir,item.name),name=prefix+'/'+item.name;if(item.isDirectory())await walk(path,name);else if(item.isFile())assets[name]={mime:types[extname(name)]||'application/octet-stream',data:(await readFile(path)).toString('base64')};}}
await walk(resolve(root,'dist-site'));await rm(dist,{recursive:true,force:true});await mkdir(resolve(dist,'server'),{recursive:true});await mkdir(resolve(dist,'.openai'),{recursive:true});
await build({entryPoints:[resolve(root,'worker/public-site.mjs')],bundle:true,format:'esm',platform:'browser',target:'es2022',outfile:resolve(dist,'server/index.js'),plugins:[{name:'public-assets',setup(b){b.onLoad({filter:/\/worker\/assets-public\.mjs$/},()=>({contents:'export default '+JSON.stringify(assets),loader:'js'}));}}]});
await cp(resolve(root,'.openai/hosting.json'),resolve(dist,'.openai/hosting.json'));await cp(resolve(root,'drizzle'),resolve(dist,'.openai/drizzle'),{recursive:true});await writeFile(resolve(dist,'server/package.json'),'{"type":"module"}');console.log(`Public Sites fallback built with ${Object.keys(assets).length} assets.`);
