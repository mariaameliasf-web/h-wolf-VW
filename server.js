const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || 'change-this-to-a-long-random-secret';
const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const DATA = path.join(ROOT, 'data');
const productsFile = path.join(DATA, 'products.json');
const messagesFile = path.join(DATA, 'messages.json');
fs.mkdirSync(DATA, { recursive: true });
fs.mkdirSync(path.join(PUBLIC, 'images'), { recursive: true });

const mime = {'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'application/javascript; charset=utf-8','.json':'application/json; charset=utf-8','.jpg':'image/jpeg','.jpeg':'image/jpeg','.png':'image/png','.webp':'image/webp','.gif':'image/gif','.svg':'image/svg+xml'};
function readJson(file, fallback){try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch{return fallback;}}
function writeJson(file, value){fs.writeFileSync(file, JSON.stringify(value,null,2));}
function send(res, status, data, type='application/json; charset=utf-8'){res.writeHead(status,{'Content-Type':type,'Cache-Control':'no-store'});res.end(type.startsWith('application/json')?JSON.stringify(data):data);}
function body(req){return new Promise((resolve,reject)=>{let s='';req.on('data',c=>{s+=c;if(s.length>12*1024*1024) req.destroy();});req.on('end',()=>{try{resolve(s?JSON.parse(s):{})}catch(e){reject(e)}});req.on('error',reject)})}
function isAdmin(req){const key=req.headers['x-admin-key'] || String(req.headers.authorization||'').replace(/^Bearer\s+/i,'');if(!key)return false;const a=Buffer.from(String(key)),b=Buffer.from(String(ADMIN_KEY));return a.length===b.length&&crypto.timingSafeEqual(a,b);}
function admin(req,res){if(!isAdmin(req)){send(res,401,{error:'Unauthorized'});return false}return true;}
function safeFile(p){const full=path.normalize(path.join(PUBLIC,p));return full.startsWith(PUBLIC+path.sep)?full:null;}
async function route(req,res){
 const u=new URL(req.url,`http://${req.headers.host||'localhost'}`);const p=u.pathname;
 if(req.method==='GET'&&p==='/api/products') return send(res,200,readJson(productsFile,[]).filter(x=>x.active!==false));
 if(p==='/api/admin/products'&&req.method==='GET'){if(!admin(req,res))return;return send(res,200,readJson(productsFile,[]));}
 if(p==='/api/admin/products'&&req.method==='POST'){if(!admin(req,res))return;const b=await body(req);if(!b.name||!b.description||!b.price)return send(res,400,{error:'Name, description and price are required.'});const ps=readJson(productsFile,[]);const product={id:crypto.randomUUID(),name:String(b.name),description:String(b.description),price:String(b.price),images:Array.isArray(b.images)?b.images:[],active:b.active!==false};ps.push(product);writeJson(productsFile,ps);return send(res,201,product);}
 if(p.startsWith('/api/admin/products/')&&req.method==='PUT'){if(!admin(req,res))return;const id=p.split('/').pop(),ps=readJson(productsFile,[]),i=ps.findIndex(x=>x.id===id);if(i<0)return send(res,404,{error:'Product not found.'});const b=await body(req);ps[i]={...ps[i],...b,id};writeJson(productsFile,ps);return send(res,200,ps[i]);}
 if(p.startsWith('/api/admin/products/')&&req.method==='DELETE'){if(!admin(req,res))return;const id=p.split('/').pop(),ps=readJson(productsFile,[]),next=ps.filter(x=>x.id!==id);if(next.length===ps.length)return send(res,404,{error:'Product not found.'});writeJson(productsFile,next);res.writeHead(204);return res.end();}
 if(p==='/api/admin/upload'&&req.method==='POST'){if(!admin(req,res))return;const b=await body(req),files=Array.isArray(b.files)?b.files:[],out=[];for(const f of files.slice(0,8)){if(!f.data||!f.name)continue;const ext=path.extname(f.name).toLowerCase();if(!['.jpg','.jpeg','.png','.webp','.gif'].includes(ext))continue;const base=path.basename(f.name,ext).replace(/[^a-z0-9]+/gi,'-').replace(/^-|-$/g,'').toLowerCase()||'product';const filename=`${Date.now()}-${crypto.randomBytes(3).toString('hex')}-${base}${ext}`;const data=String(f.data).replace(/^data:image\/[^;]+;base64,/,'');fs.writeFileSync(path.join(PUBLIC,'images',filename),Buffer.from(data,'base64'));out.push('/images/'+filename)}return send(res,200,{files:out});}
 if(p==='/api/chat'&&req.method==='POST'){const b=await body(req);if(!String(b.message||'').trim())return send(res,400,{error:'Message is required.'});const ms=readJson(messagesFile,[]),cid=b.conversationId||crypto.randomUUID();ms.push({id:crypto.randomUUID(),conversationId:cid,role:'customer',name:String(b.name||'Visitor').slice(0,120),email:String(b.email||'').slice(0,160),message:String(b.message).trim().slice(0,4000),createdAt:new Date().toISOString()});writeJson(messagesFile,ms);return send(res,201,{conversationId:cid});}
 if(p.startsWith('/api/chat/')&&req.method==='GET'){const cid=decodeURIComponent(p.split('/').pop());return send(res,200,readJson(messagesFile,[]).filter(x=>x.conversationId===cid));}
 if(p==='/api/admin/chat'&&req.method==='GET'){if(!admin(req,res))return;const ms=readJson(messagesFile,[]),map=new Map();for(const m of ms){if(!map.has(m.conversationId))map.set(m.conversationId,{conversationId:m.conversationId,name:m.name,email:m.email,updatedAt:m.createdAt,messages:[]});const c=map.get(m.conversationId);c.messages.push(m);if(m.createdAt>c.updatedAt)c.updatedAt=m.createdAt;}return send(res,200,[...map.values()].sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)));}
 if(p.startsWith('/api/admin/chat/')&&req.method==='POST'){if(!admin(req,res))return;const cid=decodeURIComponent(p.split('/').pop()),b=await body(req),ms=readJson(messagesFile,[]);if(!ms.some(x=>x.conversationId===cid))return send(res,404,{error:'Conversation not found.'});if(!String(b.message||'').trim())return send(res,400,{error:'Message is required.'});ms.push({id:crypto.randomUUID(),conversationId:cid,role:'agent',name:'H Wolf VW',email:'hwolfvw@gmail.com',message:String(b.message).trim().slice(0,4000),createdAt:new Date().toISOString()});writeJson(messagesFile,ms);return send(res,201,{ok:true});}
 if(req.method==='GET'){let file=p==='/admin'?path.join(PUBLIC,'admin.html'):safeFile(p==='/'?'/index.html':p);if(file&&fs.existsSync(file)&&fs.statSync(file).isFile()){const ext=path.extname(file);res.writeHead(200,{'Content-Type':mime[ext]||'application/octet-stream'});return fs.createReadStream(file).pipe(res);}if(!p.startsWith('/api/')){res.writeHead(200,{'Content-Type':mime['.html']});return fs.createReadStream(path.join(PUBLIC,'index.html')).pipe(res);}}
 send(res,404,{error:'Not found'});
}
const server=http.createServer((req,res)=>route(req,res).catch(e=>{console.error(e);send(res,500,{error:'Server error'});}));server.listen(PORT,()=>console.log(`H Wolf VW running on http://localhost:${PORT}`));
