const state = {
  apps: new Map(),
  windows: new Map(),
  frames: new Map(),
  z: 20,
  drag: null,
  resize: null
};

const els = {
  desktop: document.querySelector('#desktop'),
  layer: document.querySelector('#window-layer'),
  taskItems: document.querySelector('#task-items'),
  launcher: document.querySelector('#launcher'),
  launcherMenu: document.querySelector('#launcher-menu'),
  launcherApps: document.querySelector('#launcher-apps'),
  clock: document.querySelector('#clock')
};

const DB = {
  db: null,
  async open() {
    this.db = await new Promise((resolve, reject) => {
      const req = indexedDB.open('webos', 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('fs')) db.createObjectStore('fs', {keyPath:'path'});
        if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv', {keyPath:'id'});
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    await this.seed();
  },
  tx(store, mode='readonly') { return this.db.transaction(store, mode).objectStore(store); },
  req(request) { return new Promise((resolve,reject)=>{request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error)}); },
  async seed(){
    const root = await this.getFile('/');
    if (!root) await this.putFile({path:'/', type:'dir', children:[], createdAt:Date.now(), updatedAt:Date.now()});
  },
  async getFile(path){return this.req(this.tx('fs').get(path));},
  async putFile(v){return this.req(this.tx('fs','readwrite').put(v));},
  async delFile(path){return this.req(this.tx('fs','readwrite').delete(path));},
  async allFiles(){return this.req(this.tx('fs').getAll());},
  async kvGet(id){return this.req(this.tx('kv').get(id));},
  async kvPut(v){return this.req(this.tx('kv','readwrite').put(v));}
};

function norm(path){
  if (typeof path !== 'string' || !path) throw new Error('Ungültiger Pfad');
  const parts = path.split('/').filter(Boolean);
  const out=[];
  for(const p of parts){ if(p==='.') continue; if(p==='..') out.pop(); else out.push(p); }
  return '/' + out.join('/');
}
function parent(path){const p=norm(path); if(p==='/') return null; const i=p.lastIndexOf('/'); return i<=0?'/':p.slice(0,i);}
function base(path){const p=norm(path); return p==='/'?'':p.slice(p.lastIndexOf('/')+1);}
function isChild(candidate, dir){const c=norm(candidate), d=norm(dir); return c!==d && c.startsWith(d.endsWith('/')?d:d+'/');}

const FS = {
  async list(path='/'){
    path=norm(path); const dir=await DB.getFile(path);
    if(!dir) throw new Error('Ordner nicht gefunden');
    if(dir.type!=='dir') throw new Error('Kein Ordner');
    const all=await DB.allFiles();
    return all.filter(x=>x.path!==path && parent(x.path)===path).sort((a,b)=>a.path.localeCompare(b.path));
  },
  async stat(path){return await DB.getFile(norm(path));},
  async mkdir(path){path=norm(path); if(path==='/') return; if(await DB.getFile(path)) throw new Error('Existiert bereits'); const p=parent(path); const parentEntry=await DB.getFile(p); if(!parentEntry) await this.mkdir(p); else if(parentEntry.type!=='dir') throw new Error('Übergeordneter Pfad ist kein Ordner'); const now=Date.now(); await DB.putFile({path,type:'dir',children:[],createdAt:now,updatedAt:now});},
  async write(path,data=''){path=norm(path); const p=parent(path); const parentEntry=await DB.getFile(p); if(!parentEntry) await this.mkdir(p); else if(parentEntry.type!=='dir') throw new Error('Übergeordneter Pfad ist kein Ordner'); const old=await DB.getFile(path); if(old?.type==='dir') throw new Error('Ein Ordner kann nicht als Datei überschrieben werden'); const now=Date.now(); await DB.putFile({path,type:'file',data:String(data),createdAt:old?.createdAt||now,updatedAt:now});},
  async read(path){const f=await DB.getFile(norm(path)); if(!f) throw new Error('Nicht gefunden'); if(f.type!=='file') throw new Error('Kein File'); return f.data ?? '';},
  async rm(path){path=norm(path); if(path==='/') throw new Error('Root kann nicht gelöscht werden'); const f=await DB.getFile(path); if(!f) return; const all=await DB.allFiles(); for(const x of all){if(x.path===path||isChild(x.path,path)) await DB.delFile(x.path);} },
  async cp(src,dst){src=norm(src);dst=norm(dst);const f=await DB.getFile(src);if(!f)throw new Error('Quelle nicht gefunden'); if(src===dst) throw new Error('Quelle und Ziel sind identisch'); if(f.type==='dir'&&isChild(dst,src)) throw new Error('Ein Ordner kann nicht in sich selbst kopiert werden'); if(await DB.getFile(dst)) throw new Error('Ziel existiert bereits'); if(f.type==='file'){await this.write(dst,f.data??'');return;} await this.mkdir(dst);const all=await DB.allFiles();for(const x of all.filter(a=>isChild(a.path,src))){const rel=x.path.slice(src.length);const np=norm(dst+rel);if(x.type==='dir')await this.mkdir(np);else await this.write(np,x.data??'');}},
  async mv(src,dst){await this.cp(src,dst);await this.rm(src);}
};

function reply(frame, id, ok, result=null, error=null){frame?.postMessage({os:'response',id,ok,result,error}, '*');}
function broadcastToApps(message, exceptId=null){for(const [id,frame] of state.frames){if(id!==exceptId)frame.contentWindow.postMessage(message,'*');}}

async function handleMessage(event){
  const msg=event.data;
  if(!msg || msg.os!=='request') return;
  const frame=[...state.frames.entries()].find(([,f])=>f.contentWindow===event.source)?.[1];
  if(!frame) return;
  const appId=frame.dataset.appId;
  try{
    if(msg.type==='fs'){
      let result;
      const a=msg.args||{};
      if(msg.action==='mkdir') result=await FS.mkdir(a.path);
      else if(msg.action==='writeFile') result=await FS.write(a.path,a.data);
      else if(msg.action==='readFile') result=await FS.read(a.path);
      else if(msg.action==='rm') result=await FS.rm(a.path);
      else if(msg.action==='cp') result=await FS.cp(a.src,a.dst);
      else if(msg.action==='mv') result=await FS.mv(a.src,a.dst);
      else if(msg.action==='list') result=await FS.list(a.path||'/');
      else if(msg.action==='stat') result=await FS.stat(a.path);
      else throw new Error('Unbekannte FS-Aktion');
      if(['mkdir','writeFile','rm','cp','mv'].includes(msg.action)) {
        broadcastToApps({os:'event',type:'fs-changed',action:msg.action,paths:[a.path,a.src,a.dst].filter(Boolean)});
      }
      reply(event.source, msg.id,true,result);
    } else if(msg.type==='kv'){
      // Kein UI und keine exposed DOM-API: Werte liegen getrennt in IndexedDB.
      // Für echte Geheimnisse ist ein Browser-Client grundsätzlich nicht vertrauenswürdig.
      let result;
      const a=msg.args||{};
      if(msg.action==='get') result=(await DB.kvGet(String(a.id)))?.value ?? null;
      else if(msg.action==='set') result=await DB.kvPut({id:String(a.id),value:a.value});
      else throw new Error('Unbekannte KV-Aktion');
      reply(event.source,msg.id,true,result);
    } else if(msg.type==='ipc'){
      const payload={os:'event',type:'ipc',from:appId,name:msg.name||'message',data:msg.data};
      if(msg.to) state.frames.get(msg.to)?.contentWindow.postMessage(payload,'*'); else broadcastToApps(payload,appId);
      reply(event.source,msg.id,true,true);
    } else if(msg.type==='system'){
      if(msg.action==='openApp'){openApp(String(msg.appId),msg.data); reply(event.source,msg.id,true,true);} 
      else if(msg.action==='closeApp'){closeApp(String(msg.appId)); reply(event.source,msg.id,true,true);} 
      else throw new Error('Unbekannte System-Aktion');
    } else reply(event.source,msg.id,false,null,'Unbekannter Request-Typ');
  }catch(err){reply(event.source,msg.id,false,null,err?.message||String(err));}
}
window.addEventListener('message',handleMessage);

function appIcon(app){const b=document.createElement('button');b.className='desktop-icon';b.style.left=`${10 + (state.apps.size%8)*100}px`;b.style.top=`${10 + Math.floor(state.apps.size/8)*100}px`;b.innerHTML=`<span class="icon">${app.icon||'◻'}</span><span class="label"></span>`;b.querySelector('.label').textContent=app.name;b.onclick=()=>openApp(app.id);els.desktop.appendChild(b);}

function makeTask(app, instanceId){const b=document.createElement('button');b.className='task-button';b.dataset.instanceId=instanceId;b.textContent=`${app.icon||'◻'} ${app.name}`;b.onclick=()=>{const w=state.windows.get(instanceId);if(w){w.el.classList.remove('hidden');focusWindow(w.el);}};els.taskItems.appendChild(b);return b;}

function focusWindow(el){state.z++;el.style.zIndex=state.z;document.querySelectorAll('.window').forEach(w=>w.classList.remove('focused'));el.classList.add('focused');const id=el.dataset.instanceId;document.querySelectorAll('.task-button').forEach(b=>b.classList.toggle('active',b.dataset.instanceId===id));}

function openApp(id, launchData=null){
  const app=state.apps.get(id); if(!app) return;
  const instanceId=`${id}-${Date.now()}-${Math.random().toString(36).slice(2,7)}`;
  const width=app.window?.width||640, height=app.window?.height||420;
  const el=document.createElement('section');el.className='window focused';el.dataset.appId=id;el.dataset.instanceId=instanceId;el.style.width=`${width}px`;el.style.height=`${height}px`;el.style.left=`${Math.max(20,(workspaceWidth()-width)/2)}px`;el.style.top=`${Math.max(20,(innerHeight-48-height)/2)}px`;
  el.innerHTML=`<header class="titlebar"><span class="title"></span><div class="window-controls"><button title="Minimieren" data-min>—</button><button title="Vollbild" data-max>□</button><button title="Schließen" data-close>×</button></div></header><div class="window-content"><iframe allow="clipboard-read; clipboard-write"></iframe><div class="resizer"></div></div>`;
  el.querySelector('.title').textContent=`${app.icon||'◻'} ${app.name}`;
  const frame=el.querySelector('iframe'); frame.src=app.url;frame.dataset.appId=id;
  el.querySelector('[data-close]').onclick=()=>closeApp(instanceId);el.querySelector('[data-min]').onclick=()=>el.classList.add('hidden');el.querySelector('[data-max]').onclick=()=>toggleMaximize(el);
  el.addEventListener('pointerdown',()=>focusWindow(el));
  installDrag(el,el.querySelector('.titlebar'));installResize(el,el.querySelector('.resizer'));
  els.layer.appendChild(el);state.windows.set(instanceId,{el,frame,appId:id,task:makeTask(app,instanceId)});state.frames.set(instanceId,frame);frame.addEventListener('load',()=>{
    frame.contentWindow.postMessage({os:'init',appId:id,app},'*');
    if(launchData !== null) frame.contentWindow.postMessage({os:'event',type:'app-open',data:launchData},'*');
  });focusWindow(el);
}
function closeApp(instanceId){const direct=state.windows.get(instanceId);const ids=direct?[instanceId]:[...state.windows].filter(([,w])=>w.appId===instanceId).map(([key])=>key);for(const id of ids){const w=state.windows.get(id);state.frames.delete(id);w.el.remove();w.task.remove();state.windows.delete(id);}}
function toggleMaximize(el){if(el.classList.contains('maximized')){el.classList.remove('maximized');el.style.left=el.dataset.left;el.style.top=el.dataset.top;el.style.width=el.dataset.width;el.style.height=el.dataset.height;return;}el.dataset.left=el.style.left;el.dataset.top=el.style.top;el.dataset.width=el.style.width;el.dataset.height=el.style.height;el.classList.add('maximized');el.style.left='0px';el.style.top='0px';}
function workspaceWidth(){return els.desktop.offsetWidth;}
function snapWindow(el,x){const edge=16,width=workspaceWidth();if(el.classList.contains('maximized'))return;if(x<=edge||x+el.offsetWidth>=width-edge){el.dataset.left=el.style.left;el.dataset.top=el.style.top;el.dataset.width=el.style.width;el.dataset.height=el.style.height;el.classList.add('snapped');el.classList.toggle('snap-left',x<=edge);el.classList.toggle('snap-right',x>edge);el.style.width=`${width/2}px`;el.style.height=`${innerHeight-48}px`;el.style.top='0px';}}
function installDrag(el,bar){bar.addEventListener('pointerdown',e=>{if(e.target.closest('button')||el.classList.contains('maximized'))return;if(el.classList.contains('snapped')){el.classList.remove('snapped','snap-left','snap-right');el.style.left=el.dataset.left;el.style.top=el.dataset.top;el.style.width=el.dataset.width;el.style.height=el.dataset.height;}const r=el.getBoundingClientRect();state.drag={el,dx:e.clientX-r.left,dy:e.clientY-r.top};bar.setPointerCapture(e.pointerId)});bar.addEventListener('pointermove',e=>{if(!state.drag)return;let x=e.clientX-state.drag.dx,y=e.clientY-state.drag.dy;x=Math.max(0,Math.min(document.documentElement.scrollWidth-el.offsetWidth,x));y=Math.max(0,Math.min(innerHeight-48-el.offsetHeight,y));el.style.left=x+'px';el.style.top=y+'px';el.classList.remove('snapped','snap-left','snap-right')});bar.addEventListener('pointerup',()=>{if(state.drag){const r=state.drag.el.getBoundingClientRect();snapWindow(state.drag.el,r.left);}state.drag=null;});}
function installResize(el,handle){handle.addEventListener('pointerdown',e=>{e.stopPropagation();const r=el.getBoundingClientRect();state.resize={el,sx:e.clientX,sy:e.clientY,w:r.width,h:r.height};handle.setPointerCapture(e.pointerId)});handle.addEventListener('pointermove',e=>{if(!state.resize)return;el.style.width=Math.max(280,state.resize.w+e.clientX-state.resize.sx)+'px';el.style.height=Math.max(180,state.resize.h+e.clientY-state.resize.sy)+'px'});handle.addEventListener('pointerup',()=>state.resize=null);}

async function runSchedule(app){
  const s=app.schedule;if(!s?.intervalMs||!s?.script)return;
  setInterval(async()=>{
    try{await import(new URL(s.script,location.href).href);}catch(err){console.warn('Scheduler fehlgeschlagen',app.id,err);}
    [...state.windows.values()].filter(w=>w.appId===app.id).forEach(w=>w.frame.contentWindow.postMessage({os:'event',type:'schedule',appId:app.id},'*'));
  },s.intervalMs);
}

function updateClock(){els.clock.textContent=new Intl.DateTimeFormat('de-DE',{dateStyle:'short',timeStyle:'medium'}).format(new Date());}setInterval(updateClock,1000);updateClock();
els.launcher.onclick=()=>els.launcherMenu.classList.toggle('hidden');document.addEventListener('pointerdown',e=>{if(!els.launcherMenu.contains(e.target)&&e.target!==els.launcher)els.launcherMenu.classList.add('hidden');});

(async function init(){
  await DB.open();
  const meta=await fetch('apps.json').then(r=>r.json());
  for(const app of meta.apps){state.apps.set(app.id,app);if(app.desktop!==false)appIcon(app);const b=document.createElement('button');b.className='launcher-app';b.innerHTML=`<span class="app-icon">${app.icon||'◻'}</span><span></span>`;b.querySelector('span:last-child').textContent=app.name;b.onclick=()=>{openApp(app.id);els.launcherMenu.classList.add('hidden')};els.launcherApps.appendChild(b);runSchedule(app);}
})();
