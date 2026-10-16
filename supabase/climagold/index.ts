import { createClient } from "npm:@supabase/supabase-js@2.95.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type,x-climagold-hall,x-cg-session,apikey,authorization",
  "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS",
};
const jsonHeaders = { ...corsHeaders, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" };

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: jsonHeaders });
}
function b64Bytes(s: string) {
  const bin = atob(s); const out = new Uint8Array(bin.length);
  for (let i=0;i<bin.length;i++) out[i]=bin.charCodeAt(i);
  return out;
}
function normHall(v: string | null) { const h=(v||"").toUpperCase(); return ["H1","H2","AUTO","M1","M2"].includes(h)?h:null; }
function normUser(v: unknown){ return String(v??"").trim().toLowerCase(); }
function b64ToBytes(s:string){ return b64Bytes(s); }
function bytesToB64(a:Uint8Array){ let s=""; for(let i=0;i<a.length;i++)s+=String.fromCharCode(a[i]); return btoa(s); }
function bytesToB64Url(a:Uint8Array){ return bytesToB64(a).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/g,""); }
function hex(a:ArrayBuffer){ return Array.from(new Uint8Array(a)).map(x=>x.toString(16).padStart(2,"0")).join(""); }
async function sha256Text(s:string){ return hex(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(s))); }
async function pbkdf2(password:string,saltB64:string,iterations:number){
  const key=await crypto.subtle.importKey("raw",new TextEncoder().encode(password),"PBKDF2",false,["deriveBits"]);
  const bits=await crypto.subtle.deriveBits({name:"PBKDF2",salt:b64ToBytes(saltB64),iterations,hash:"SHA-256"},key,256);
  return bytesToB64(new Uint8Array(bits));
}
function safeEq(a:string,b:string){ if(a.length!==b.length)return false; let x=0; for(let i=0;i<a.length;i++)x|=a.charCodeAt(i)^b.charCodeAt(i); return x===0; }
async function makeHash(password:string){ const salt=crypto.getRandomValues(new Uint8Array(16)); const s=bytesToB64(salt); return {salt:s,hash:await pbkdf2(password,s,210000),iterations:210000}; }

const supabaseUrl=Deno.env.get("SUPABASE_URL")!;
let secret=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")||"";
if(!secret){
  try{ const m=JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS")||"{}"); secret=m.default||Object.values(m)[0]||""; }catch{}
}
if(!supabaseUrl||!secret) throw new Error("Brak konfiguracji Supabase po stronie serwera");
const db=createClient(supabaseUrl,secret,{auth:{persistSession:false,autoRefreshToken:false}});

type AppUser={id:number,hall:string,username:string,role:"admin"|"supervisor"|"viewer",active:boolean,is_main:boolean};
async function getAuth(req:Request,hall:string):Promise<AppUser|null>{
  const token=req.headers.get("X-CG-Session")||""; if(!token)return null;
  const sh=await sha256Text(token);
  const {data:s}=await db.from("climagold_app_sessions").select("user_id,hall,expires_at").eq("session_hash",sh).eq("hall",hall).maybeSingle();
  if(!s)return null;
  if(new Date(s.expires_at).getTime()<Date.now()){ await db.from("climagold_app_sessions").delete().eq("session_hash",sh); return null; }
  const {data:u}=await db.from("climagold_app_users").select("id,hall,username,role,active,is_main").eq("id",s.user_id).eq("hall",hall).maybeSingle();
  if(!u||!u.active)return null;
  db.from("climagold_app_sessions").update({last_seen_at:new Date().toISOString()}).eq("session_hash",sh).then(()=>{});
  return u as AppUser;
}
function requireRole(u:AppUser|null,roles:string[]){ if(!u)throw Object.assign(new Error("Sesja wygasła. Zaloguj się ponownie."),{status:401}); if(!roles.includes(u.role))throw Object.assign(new Error("Brak uprawnień."),{status:403}); }
async function body(req:Request){ try{return await req.json()}catch{return {}} }
async function listUsers(hall:string){
  const {data,error}=await db.from("climagold_app_users").select("id,username,role,active,is_main").eq("hall",hall).order("id"); if(error)throw error; return data||[];
}
async function loadState(hall:string){ const {data,error}=await db.from("climagold_hall_state").select("data,version").eq("hall",hall).single(); if(error)throw error; return data; }
async function mutateState(hall:string,by:string,fn:(s:any)=>void){
  for(let n=0;n<4;n++){
    const row=await loadState(hall); const state=structuredClone(row.data||{}); fn(state); delete state.users;
    const {data:ok,error}=await db.from("climagold_hall_state").update({data:state,version:Number(row.version)+1,updated_at:new Date().toISOString(),updated_by:by}).eq("hall",hall).eq("version",row.version).select("version");
    if(error)throw error; if(ok&&ok.length)return state;
  }
  throw Object.assign(new Error("Dane zostały zmienione równocześnie. Spróbuj ponownie."),{status:409});
}
async function loginAttemptBlocked(hall:string,username:string){
  const n=normUser(username); const {data}=await db.from("climagold_login_attempts").select("blocked_until").eq("hall",hall).eq("username_norm",n).maybeSingle();
  return !!(data?.blocked_until&&new Date(data.blocked_until).getTime()>Date.now());
}
async function noteLoginFailure(hall:string,username:string){
  const n=normUser(username), now=Date.now(); const {data}=await db.from("climagold_login_attempts").select("failed_count,window_started_at").eq("hall",hall).eq("username_norm",n).maybeSingle();
  let count=1,start=new Date(now).toISOString(); if(data&&now-new Date(data.window_started_at).getTime()<10*60_000){count=Number(data.failed_count||0)+1;start=data.window_started_at}
  const blocked=count>=5?new Date(now+10*60_000).toISOString():null;
  await db.from("climagold_login_attempts").upsert({hall,username_norm:n,failed_count:count,window_started_at:start,blocked_until:blocked});
}
async function clearLoginFailures(hall:string,username:string){ await db.from("climagold_login_attempts").delete().eq("hall",hall).eq("username_norm",normUser(username)); }

async function handleApi(req:Request,hall:string,path:string){
  const method=req.method.toUpperCase();
  if(path==="/api/login"&&method==="POST"){
    const x=await body(req), username=String(x.username||"").trim(), password=String(x.password||"");
    if(!username||!password)return json({error:"Podaj login i hasło."},400);
    if(await loginAttemptBlocked(hall,username))return json({error:"Za dużo nieudanych prób. Spróbuj ponownie za kilka minut."},429);
    const {data:all}=await db.from("climagold_app_users").select("id,hall,username,password_salt,password_hash,password_iterations,role,active,is_main").eq("hall",hall);
    const u=(all||[]).find((z:any)=>normUser(z.username)===normUser(username));
    let good=false; if(u&&u.active){ try{ good=safeEq(await pbkdf2(password,u.password_salt,Number(u.password_iterations||210000)),u.password_hash); }catch{} }
    if(!good){await noteLoginFailure(hall,username);return json({error:"Błędny login lub hasło."},401)}
    await clearLoginFailures(hall,username); await db.from("climagold_app_sessions").delete().lt("expires_at",new Date().toISOString());
    const raw=crypto.getRandomValues(new Uint8Array(32)), token=bytesToB64Url(raw), session_hash=await sha256Text(token), expires_at=new Date(Date.now()+7*86400_000).toISOString();
    const {error}=await db.from("climagold_app_sessions").insert({session_hash,user_id:u.id,hall,expires_at}); if(error)throw error;
    return json({token,user:{id:u.id,username:u.username,role:u.role,is_main:u.is_main}});
  }
  const u=await getAuth(req,hall);
  if(path==="/api/me"&&method==="GET")return json({user:u?{id:u.id,username:u.username,role:u.role,is_main:u.is_main}:null});
  if(!u)return json({error:"Sesja wygasła. Zaloguj się ponownie."},401);
  if(path==="/api/version"&&method==="GET"){
    const {data,error}=await db.from("climagold_hall_state").select("version").eq("hall",hall).single();
    if(error)throw error;
    return json({version:data.version});
  }
  if(path==="/api/data"&&method==="GET"){
    const row=await loadState(hall), state=structuredClone(row.data||{}); delete state.users; if(u.role!=="admin"&&u.role!=="supervisor")delete state.deleted_entries; state.users=u.role==="admin"?await listUsers(hall):[]; state._online={version:row.version,updated_at:(await db.from("climagold_hall_state").select("updated_at,updated_by").eq("hall",hall).single()).data?.updated_at}; return json(state);
  }
  if(path==="/api/entry"&&method==="POST"){
    requireRole(u,["admin","supervisor"]); const x:any=await body(req);
    const clean:any={id:x.id?Number(x.id):undefined,start_date:String(x.start_date||""),end_date:String(x.end_date||""),device_type:String(x.device_type||""),number:String(x.number||""),start_time:String(x.start_time||""),end_time:String(x.end_time||""),day_systems:Array.isArray(x.day_systems)?x.day_systems:[],employee_systems:Array.isArray(x.employee_systems)?x.employee_systems:[],employee_participation:Array.isArray(x.employee_participation)?x.employee_participation.slice(0,10).map((p:any)=>({employee:String(p?.employee||""),start_at:String(p?.start_at||""),end_at:String(p?.end_at||"")})):[],employees:Array.isArray(x.employees)?x.employees.slice(0,10):[],additional_employees:Array.isArray(x.additional_employees)?x.additional_employees.slice(0,10):[],corrections:Array.isArray(x.corrections)?x.corrections.slice(0,10).map((v:any)=>Number(v)||0):[0,0,0,0,0,0,0,0,0,0],notes:String(x.notes||""),mark_color:String(x.mark_color||"")};
    if(!clean.start_date||!clean.start_time)return json({error:"Uzupełnij datę i godzinę rozpoczęcia."},400);
    await mutateState(hall,u.username,(s:any)=>{s.entries=Array.isArray(s.entries)?s.entries:[]; if(clean.id){const i=s.entries.findIndex((e:any)=>Number(e.id)===clean.id); if(i<0)throw Object.assign(new Error("Nie znaleziono wpisu."),{status:404}); s.entries[i]=clean;}else{clean.id=[...(s.entries||[]),...(s.deleted_entries||[]).map((z:any)=>z.entry||{})].reduce((m:number,e:any)=>Math.max(m,Number(e.id)||0),0)+1;s.entries.unshift(clean)}}); return json({ok:true,id:clean.id});
  }
  if(path.startsWith("/api/entry/")&&method==="DELETE"){
    requireRole(u,["admin","supervisor"]); const id=Number(path.split("/").pop()),token=crypto.randomUUID();
    await mutateState(hall,u.username,(s:any)=>{
      s.entries=Array.isArray(s.entries)?s.entries:[];
      const i=s.entries.findIndex((e:any)=>Number(e.id)===id);
      if(i<0)throw Object.assign(new Error("Nie znaleziono wpisu."),{status:404});
      const removed=s.entries.splice(i,1)[0];
      s.deleted_entries=[{token,entry:removed,deleted_at:new Date().toISOString(),deleted_by:u.username},...(Array.isArray(s.deleted_entries)?s.deleted_entries:[])].slice(0,30);
    });
    return json({ok:true});
  }
  if(path==="/api/entry/undo"&&method==="POST"){
    requireRole(u,["admin","supervisor"]); const x:any=await body(req),token=String(x.token||"");
    if(!token)return json({error:"Nie wskazano usuniętego wpisu."},400);
    let restoredId=0;
    await mutateState(hall,u.username,(s:any)=>{
      s.entries=Array.isArray(s.entries)?s.entries:[];
      s.deleted_entries=Array.isArray(s.deleted_entries)?s.deleted_entries:[];
      const i=s.deleted_entries.findIndex((z:any)=>z.token===token);
      if(i<0)throw Object.assign(new Error("Nie znaleziono usuniętego wpisu. Odśwież ewidencję."),{status:404});
      const saved=structuredClone(s.deleted_entries[i].entry);
      const used=new Set(s.entries.map((e:any)=>Number(e.id)));
      if(used.has(Number(saved.id)))saved.id=[...s.entries,...s.deleted_entries.map((z:any)=>z.entry||{})].reduce((m:number,e:any)=>Math.max(m,Number(e.id)||0),0)+1;
      restoredId=Number(saved.id);
      s.entries.unshift(saved);
      s.deleted_entries.splice(i,1);
    });
    return json({ok:true,id:restoredId});
  }
  if(path==="/api/ratings"&&method==="POST"){
    requireRole(u,["admin","supervisor"]); const x:any=await body(req); if(!Array.isArray(x.ratings))return json({error:"Nieprawidłowe oceny."},400); await mutateState(hall,u.username,(s:any)=>{s.ratings=x.ratings}); return json({ok:true});
  }
  if(path==="/api/daily-system"&&method==="POST"){
    requireRole(u,["admin","supervisor"]); const x:any=await body(req);
    const date=String(x.date||""), system=String(x.system||"");
    if(!/^\d{4}-\d{2}-\d{2}$/.test(date))return json({error:"Nieprawidłowa data."},400);
    await mutateState(hall,u.username,(s:any)=>{
      s.settings=(s.settings&&typeof s.settings==="object")?s.settings:{};
      const systems=Array.isArray(s.settings.systems)?s.settings.systems:[];
      if(system&&!systems.includes(system))throw Object.assign(new Error("Nieprawidłowy system pracy."),{status:400});
      const map=(s.settings.daily_systems&&typeof s.settings.daily_systems==="object"&&!Array.isArray(s.settings.daily_systems))?{...s.settings.daily_systems}:{};
      if(system)map[date]=system;else delete map[date];
      s.settings.daily_systems=map;
    });
    return json({ok:true});
  }

  if(path==="/api/employee-daily-systems"&&method==="POST"){
    requireRole(u,["admin","supervisor"]);
    const x:any=await body(req),date=String(x.date||""),wanted=x.employees;
    if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||!wanted||typeof wanted!=="object"||Array.isArray(wanted)||Object.keys(wanted).length>100)
      return json({error:"Nieprawidłowe wyjątki pracowników."},400);
    await mutateState(hall,u.username,(s:any)=>{
      s.settings=s.settings||{};
      const all=[...(s.settings.employees||[]),...(s.settings.additional_employees||[])];
      const allowed=new Set(all.map((n:any)=>String(n)));
      const systems=new Set((s.settings.systems||[]).map((v:any)=>String(v)));
      const next:any={};
      for(const [name,value] of Object.entries(wanted)){
        const sys=String(value);
        if(!allowed.has(name)||!systems.has(sys))
          throw Object.assign(new Error("Wybierz prawidłowego pracownika i system pracy."),{status:400});
        next[name]=sys;
      }
      const current=s.settings.employee_daily_systems;
      const daily=current&&typeof current==="object"&&!Array.isArray(current)?{...current}:{};
      if(Object.keys(next).length)daily[date]=next;else delete daily[date];
      s.settings.employee_daily_systems=daily;
    });
    return json({ok:true});
  }
  if(path==="/api/additional-employees"&&method==="POST"){
    requireRole(u,["admin","supervisor"]);
    const x:any=await body(req);
    if(!Array.isArray(x.employees)||x.employees.length>100||x.employees.some((n:any)=>typeof n!=="string"||!n.trim()||n.length>120))
      return json({error:"Nieprawidłowa lista pracowników dodatkowych."},400);
    const names=x.employees.map((n:string)=>n.trim());
    if(new Set(names.map((n:string)=>n.toLocaleLowerCase("pl"))).size!==names.length)
      return json({error:"Powtarzające się osoby na liście."},400);
    await mutateState(hall,u.username,(state:any)=>{
      state.settings=state.settings||{};
      const ordinary=state.settings.employees||[];
      if(names.some((n:string)=>ordinary.some((o:string)=>String(o).toLocaleLowerCase("pl")===n.toLocaleLowerCase("pl"))))
        throw Object.assign(new Error("Osoba znajduje się już na liście stałych pracowników."),{status:400});
      state.settings.additional_employees=names;
    });
    return json({ok:true});
  }
  if(path==="/api/settings"&&method==="POST"){
    requireRole(u,["admin"]); const x:any=await body(req); const settings={employees:Array.isArray(x.employees)?x.employees:[],types:Array.isArray(x.types)?x.types:[],systems:Array.isArray(x.systems)?x.systems:[],holidays:Array.isArray(x.holidays)?x.holidays:[],break_groups:Array.isArray(x.break_groups)?x.break_groups:[],system_breaks:(x.system_breaks&&typeof x.system_breaks==="object"&&!Array.isArray(x.system_breaks))?x.system_breaks:{},employee_break_groups:(x.employee_break_groups&&typeof x.employee_break_groups==="object"&&!Array.isArray(x.employee_break_groups))?x.employee_break_groups:{},daily_systems:(x.daily_systems&&typeof x.daily_systems==="object"&&!Array.isArray(x.daily_systems))?x.daily_systems:{},seeded:x.seeded??1,seed_version:x.seed_version||"online"}; await mutateState(hall,u.username,(s:any)=>{ settings.additional_employees=(s.settings&&Array.isArray(s.settings.additional_employees))?s.settings.additional_employees:[];settings.employee_daily_systems=(s.settings&&s.settings.employee_daily_systems&&typeof s.settings.employee_daily_systems==="object"&&!Array.isArray(s.settings.employee_daily_systems))?s.settings.employee_daily_systems:{};s.settings=settings}); return json({ok:true});
  }
  if(path==="/api/restore"&&method==="POST"){
    requireRole(u,["admin"]); const x:any=await body(req), d=x.data||{}; if(!d.settings||!Array.isArray(d.entries)||!Array.isArray(d.ratings))return json({error:"Nieprawidłowa kopia danych."},400); await mutateState(hall,u.username,(s:any)=>{s.settings=d.settings;s.entries=d.entries;s.ratings=d.ratings}); return json({ok:true});
  }
  if(path==="/api/user"&&method==="POST"){
    requireRole(u,["admin"]); const x:any=await body(req), username=String(x.username||"").trim(), password=String(x.password||""), role=String(x.role||""); if(!username||!password||!["admin","supervisor","viewer"].includes(role))return json({error:"Podaj login, hasło i poprawną rolę."},400);
    const h=await makeHash(password); const {error}=await db.from("climagold_app_users").insert({hall,username,password_salt:h.salt,password_hash:h.hash,password_iterations:h.iterations,role,active:true,is_main:false}); if(error){if(error.code==="23505")return json({error:"Taki login już istnieje na tej hali."},409);throw error} return json({ok:true});
  }
  if(path.startsWith("/api/user/")&&method==="PATCH"){
    requireRole(u,["admin"]); const id=Number(path.split("/").pop()), x:any=await body(req); const {data:t}=await db.from("climagold_app_users").select("id,username,role,is_main").eq("id",id).eq("hall",hall).maybeSingle(); if(!t)return json({error:"Nie znaleziono użytkownika."},404);
    const username=String(x.username??t.username).trim(), role=String(x.role??t.role); if(!username||!["admin","supervisor","viewer"].includes(role))return json({error:"Nieprawidłowe dane użytkownika."},400); if(t.is_main&&username!==t.username)return json({error:"Nie można zmienić loginu konta głównego."},400); if(t.is_main&&role!=="admin")return json({error:"Konto główne musi pozostać administratorem."},400);
    const upd:any={username,role,updated_at:new Date().toISOString()}; if(x.password){const h=await makeHash(String(x.password));upd.password_salt=h.salt;upd.password_hash=h.hash;upd.password_iterations=h.iterations}
    const {error}=await db.from("climagold_app_users").update(upd).eq("id",id).eq("hall",hall); if(error){if(error.code==="23505")return json({error:"Taki login już istnieje na tej hali."},409);throw error} return json({ok:true});
  }
  if(path.startsWith("/api/user/")&&method==="DELETE"){
    requireRole(u,["admin"]); const id=Number(path.split("/").pop()); const {data:t}=await db.from("climagold_app_users").select("is_main").eq("id",id).eq("hall",hall).maybeSingle(); if(!t)return json({error:"Nie znaleziono użytkownika."},404); if(t.is_main)return json({error:"Nie można usunąć konta głównego."},400); await db.from("climagold_app_users").delete().eq("id",id).eq("hall",hall); return json({ok:true});
  }
  return json({error:"Nieznana operacja."},404);
}

Deno.serve(async(req:Request)=>{
  try{
    if(req.method==="OPTIONS")return new Response(null,{status:204,headers:corsHeaders});
    const url=new URL(req.url), api=url.searchParams.get("api");
    const hall=normHall(req.headers.get("X-ClimaGold-Hall")||url.searchParams.get("hall"));
    if(api){ if(!hall)return json({error:"Wybierz dział."},400); return await handleApi(req,hall,api); }
    if(!hall){
      const base=url.origin+url.pathname; const h='<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Clima Gold</title><style>body{font-family:Arial;background:#0b1220;color:#fff;display:grid;place-items:center;min-height:100vh;margin:0}.b{width:min(90vw,430px);background:#172033;padding:30px;border-radius:18px;text-align:center}.a{display:block;margin:10px;padding:16px 20px;background:#f2c94c;color:#111;text-decoration:none;font-weight:800;border-radius:12px}.m{background:#e9edf0}.auto{background:#f0c36b}.sep{height:1px;background:#31404d;margin:18px 0}</style><div class="b"><h1>CLIMA GOLD</h1><p>Ewidencja pracy online</p><a class="a" href="'+base+'?hall=H1">ELEKTRYCY H1</a><a class="a m" href="'+base+'?hall=M1">MONTAŻ H1</a><a class="a auto" href="'+base+'?hall=AUTO">AUTOMATYCY</a><div class="sep"></div><a class="a" href="'+base+'?hall=H2">ELEKTRYCY H2</a><a class="a m" href="'+base+'?hall=M2">MONTAŻ H2</a></div>';return new Response(h,{headers:{"Content-Type":"text/html; charset=utf-8","Cache-Control":"no-store"}});
    }
    const assetHall=hall==="M1"?"H1":hall==="M2"?"H2":hall;
    const {data:parts,error:assetErr}=await db.from("climagold_web_assets").select("part,data").eq("hall",assetHall).order("part",{ascending:true});
    if(assetErr) throw assetErr;
    if(!parts?.length) return new Response("Brak interfejsu dla tej hali.",{status:404,headers:{"Content-Type":"text/plain; charset=utf-8"}});
    const compressed=b64Bytes(parts.map((p:any)=>p.data).join(""));
    const ds=new DecompressionStream("gzip");
    let html=await new Response(new Blob([compressed]).stream().pipeThrough(ds)).text();
    if(hall!==assetHall){
      html=html.replace("var HALL='"+assetHall+"'","var HALL='"+hall+"'");
    }
    const label=hall==="H1"?"Elektrycy H1":hall==="H2"?"Elektrycy H2":hall==="M1"?"Montaż H1":hall==="M2"?"Montaż H2":"Automatycy";
    const badge=label.toUpperCase();
    if(assetHall==="H1"){
      html=html.replace(/Clima Gold — H1/g,"Clima Gold — "+label).replace(/Hala H1/g,label).replace(/HALA H1/g,badge);
    }else if(assetHall==="H2"){
      html=html.replace(/Clima Gold — H2/g,"Clima Gold — "+label).replace(/Hala H2/g,label).replace(/HALA H2/g,badge);
    }
    html=html.replace("function hallName(){return HALL==='AUTO'?'Automatycy':HALL}","function hallName(){return HALL==='AUTO'?'Automatycy':HALL==='H1'?'Elektrycy H1':HALL==='H2'?'Elektrycy H2':HALL==='M1'?'Montaż H1':HALL==='M2'?'Montaż H2':HALL}");
    return new Response(html,{headers:{"Content-Type":"text/html; charset=utf-8","Cache-Control":"no-store"}});
  }catch(e:any){ console.error(e); return json({error:e?.message||"Błąd serwera."},Number(e?.status)||500); }
});
