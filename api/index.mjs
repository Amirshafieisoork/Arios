import {createBff} from '../backend/bff.mjs';
const handle=createBff();
export const config={api:{bodyParser:false}};
export default async function handler(req,res){
 const origin='https://'+(req.headers['x-forwarded-host']||req.headers.host);
 const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>131072){res.statusCode=413;res.end(JSON.stringify({error:'درخواست بیش از حد بزرگ است.'}));return;}chunks.push(chunk);}
 const body=Buffer.concat(chunks),headers=new Headers();for(const [key,value]of Object.entries(req.headers))if(value!==undefined)headers.set(key,Array.isArray(value)?value.join(','):value);
 const target=new URL(req.url,origin);if(target.searchParams.has('route')){target.pathname='/api/'+target.searchParams.get('route');target.searchParams.delete('route');}
 const response=await handle(new Request(target.toString(),{method:req.method,headers,...(body.length?{body}: {})}));
 res.statusCode=response.status;for(const [name,value]of response.headers)if(name!=='set-cookie')res.setHeader(name,value);const cookies=response.headers.getSetCookie();if(cookies.length)res.setHeader('Set-Cookie',cookies);res.end(Buffer.from(await response.arrayBuffer()));
}
