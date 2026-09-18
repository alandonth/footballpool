interface Env { DB:D1Database; ASSETS:Fetcher; AUTH_PEPPER:string }
type User={id:string;username:string;display_name:string|null;role:"player"|"admin";theme:string;logo_mode:"espn"|"badge";must_change_password:number};
const SEASON=2026, SESSION_DAYS=30, ESPN="https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard";

export default {
 async fetch(request:Request,env:Env,ctx:ExecutionContext){
  const url=new URL(request.url);if(!url.pathname.startsWith("/api/"))return env.ASSETS.fetch(request);
  try{return await api(request,env,ctx,url)}catch(error){console.error(error);return json({error:"Something went wrong."},500)}
 },
 async scheduled(_event:ScheduledEvent,env:Env,ctx:ExecutionContext){ctx.waitUntil(syncRelevantWeeks(env))}
};

async function api(req:Request,env:Env,ctx:ExecutionContext,url:URL){
 if(url.pathname==="/api/health")return json({ok:true});
 if(url.pathname==="/api/auth/register"&&req.method==="POST")return register(req,env);
 if(url.pathname==="/api/auth/login"&&req.method==="POST")return login(req,env);
 if(url.pathname==="/api/auth/logout"&&req.method==="POST")return logout(req,env);
 const user=await currentUser(req,env);if(!user)return json({error:"Sign in required"},401);
 if(url.pathname==="/api/me"&&req.method==="GET")return json({user});
 if(url.pathname==="/api/me"&&req.method==="PATCH")return updateMe(req,env,user);
 if(url.pathname==="/api/pools"&&req.method==="GET")return listPools(env,user);
 if(url.pathname==="/api/pools"&&req.method==="POST")return changePool(req,env,user);
 if(url.pathname==="/api/schedule"&&req.method==="GET")return schedule(url,env,ctx);
 if(url.pathname==="/api/picks"&&req.method==="GET")return pickData(url,env,user);
 if(url.pathname==="/api/picks"&&req.method==="POST")return savePick(req,env,user);
 if(url.pathname==="/api/admin/users"&&req.method==="GET")return adminUsers(env,user);
 if(url.pathname==="/api/admin/reset-password"&&req.method==="POST")return adminReset(req,env,user);
 if(url.pathname==="/api/admin/pick"&&req.method==="POST")return adminPick(req,env,user);
 if(url.pathname==="/api/admin/game"&&req.method==="POST")return adminGame(req,env,user);
 return json({error:"Not found"},404);
}

async function register(req:Request,env:Env){
 const b=await body(req),username=cleanUsername(b.username),password=String(b.password||""),display=cleanDisplay(b.displayName);
 if(!username||password.length<10)return json({error:"Use a username and a password of at least 10 characters."},400);
 const exists=await env.DB.prepare("SELECT id FROM users WHERE username=? COLLATE NOCASE").bind(username).first();if(exists)return json({error:"That username is already taken."},409);
 const count=await env.DB.prepare("SELECT COUNT(*) count FROM users").first<{count:number}>(),id=crypto.randomUUID(),salt=randomToken(18),hash=await hashPassword(password,salt,env.AUTH_PEPPER),role=count?.count===0?"admin":"player",now=Date.now();
 await env.DB.prepare("INSERT INTO users(id,username,password_hash,password_salt,display_name,role,created_at) VALUES(?,?,?,?,?,?,?)").bind(id,username,hash,salt,display,role,now).run();
 return createSession(env,id,{id,username,display_name:display,role,theme:"stadium",logo_mode:"espn",must_change_password:0});
}
async function login(req:Request,env:Env){
 const b=await body(req),username=cleanUsername(b.username),password=String(b.password||"");const row=await env.DB.prepare("SELECT * FROM users WHERE username=? COLLATE NOCASE").bind(username).first<any>();
 if(!row||row.disabled||!timingSafe(await hashPassword(password,row.password_salt,env.AUTH_PEPPER),row.password_hash))return json({error:"Incorrect username or password."},401);
 return createSession(env,row.id,publicUser(row));
}
async function logout(req:Request,env:Env){const token=cookie(req,"fp_session");if(token)await env.DB.prepare("DELETE FROM sessions WHERE id_hash=?").bind(await sha256(token)).run();return json({ok:true},200,{"set-cookie":clearCookie()})}
async function currentUser(req:Request,env:Env){const token=cookie(req,"fp_session");if(!token)return null;return env.DB.prepare("SELECT u.id,u.username,u.display_name,u.role,u.theme,u.logo_mode,u.must_change_password FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.id_hash=? AND s.expires_at>? AND u.disabled=0").bind(await sha256(token),Date.now()).first<User>()}
async function createSession(env:Env,userId:string,user:User){const token=randomToken(32),now=Date.now(),expires=now+SESSION_DAYS*86400000;await env.DB.prepare("INSERT INTO sessions(id_hash,user_id,expires_at,created_at) VALUES(?,?,?,?)").bind(await sha256(token),userId,expires,now).run();return json({user},200,{"set-cookie":sessionCookie(token,expires)})}
async function updateMe(req:Request,env:Env,user:User){const b=await body(req),theme=["stadium","aquatic","blizzard","liberty","flight"].includes(String(b.theme))?String(b.theme):user.theme,logo=b.logoMode==="badge"?"badge":"espn",display=cleanDisplay(b.displayName);await env.DB.prepare("UPDATE users SET display_name=?,theme=?,logo_mode=? WHERE id=?").bind(display,theme,logo,user.id).run();return json({ok:true})}

async function listPools(env:Env,user:User){const rows=await env.DB.prepare("SELECT p.* FROM memberships m JOIN pools p ON p.id=m.pool_id WHERE m.user_id=? ORDER BY p.created_at").bind(user.id).all();return json({pools:rows.results})}
async function changePool(req:Request,env:Env,user:User){const b=await body(req);if(b.action==="create"){const name=String(b.name||"").trim().slice(0,50);if(!name)return json({error:"Pool name required."},400);const pool={id:crypto.randomUUID(),name,invite_code:inviteCode(),owner_id:user.id,season:SEASON,created_at:Date.now()};await env.DB.batch([env.DB.prepare("INSERT INTO pools(id,name,invite_code,owner_id,season,created_at) VALUES(?,?,?,?,?,?)").bind(...Object.values(pool)),env.DB.prepare("INSERT INTO memberships(id,pool_id,user_id,joined_at) VALUES(?,?,?,?)").bind(crypto.randomUUID(),pool.id,user.id,Date.now())]);return json({pool})}if(b.action==="join"){const pool=await env.DB.prepare("SELECT * FROM pools WHERE invite_code=?").bind(String(b.inviteCode||"").toUpperCase()).first<any>();if(!pool)return json({error:"Invite code not found."},404);await env.DB.prepare("INSERT OR IGNORE INTO memberships(id,pool_id,user_id,joined_at) VALUES(?,?,?,?)").bind(crypto.randomUUID(),pool.id,user.id,Date.now()).run();return json({pool})}return json({error:"Invalid action."},400)}

async function schedule(url:URL,env:Env,ctx:ExecutionContext){
 const week=clampWeek(url.searchParams.get("week"));
 const rows=await gamesForWeek(env,week);

 if(!rows.length){
  try{
   await syncWeek(env,week);
  }catch(error){
   console.error(`Initial Week ${week} schedule sync failed`,error);
  }
 }else if(Date.now()-Number(rows[0]?.source_updated_at||0)>15*60_000){
  ctx.waitUntil(
   syncWeek(env,week).catch(error=>
    console.error(`Background Week ${week} schedule sync failed`,error)
   )
  );
 }

 const games=await gamesForWeek(env,week);
 return json({
  week,
  games:games.map(gameDto),
  lastUpdated:games[0]?.source_updated_at||null,
  stale:!games.length||Date.now()-Number(games[0]?.source_updated_at||0)>30*60_000
 });
}
async function gamesForWeek(env:Env,week:number){return (await env.DB.prepare("SELECT * FROM games WHERE season=? AND week=? ORDER BY start_time").bind(SEASON,week).all<any>()).results}
async function syncRelevantWeeks(env:Env){const all=Array.from({length:18},(_,i)=>i+1);for(const week of all){try{const rows=await gamesForWeek(env,week),near=rows.some(g=>Math.abs(new Date(g.start_time).getTime()-Date.now())<8*86400000);if(!rows.length||near)await syncWeek(env,week)}catch(error){console.error(`Week ${week} sync failed`,error)}}}
async function syncWeek(env:Env,week:number){
 const response=await fetch(`${ESPN}?seasontype=2&week=${week}&dates=${SEASON}`,{headers:{accept:"application/json","user-agent":"FamilyPickem/1.0"}});if(!response.ok)throw new Error(`ESPN ${response.status}`);const data:any=await response.json(),now=Date.now(),stmts:D1PreparedStatement[]=[];
 for(const event of data.events||[]){const c=event.competitions?.[0],home=c?.competitors?.find((x:any)=>x.homeAway==="home"),away=c?.competitors?.find((x:any)=>x.homeAway==="away");if(!home||!away)continue;const values=[String(event.id),SEASON,week,event.date,event.status?.type?.shortDetail||"Scheduled",event.status?.type?.completed?1:0,String(home.team.id),home.team.abbreviation,home.team.displayName,home.team.logo||null,score(home.score),String(away.team.id),away.team.abbreviation,away.team.displayName,away.team.logo||null,score(away.score),home.winner?String(home.team.id):away.winner?String(away.team.id):null,now];
  stmts.push(env.DB.prepare("INSERT INTO games(id,season,week,start_time,status,completed,home_id,home_abbr,home_name,home_logo,home_score,away_id,away_abbr,away_name,away_logo,away_score,winner_id,source_updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET start_time=excluded.start_time,status=excluded.status,completed=excluded.completed,home_score=excluded.home_score,away_score=excluded.away_score,winner_id=excluded.winner_id,home_logo=excluded.home_logo,away_logo=excluded.away_logo,source_updated_at=excluded.source_updated_at").bind(...values));
 }if(stmts.length)await env.DB.batch(stmts);
}

async function pickData(url:URL,env:Env,user:User){const poolId=url.searchParams.get("poolId")||"",week=clampWeek(url.searchParams.get("week"));if(!await isMember(env,poolId,user.id))return json({error:"Not a member."},403);const mine=(await env.DB.prepare("SELECT game_id,team_id,admin_adjusted FROM picks WHERE pool_id=? AND user_id=?").bind(poolId,user.id).all<any>()).results,people=(await env.DB.prepare("SELECT u.id user_id,COALESCE(u.display_name,u.username) display_name FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.pool_id=?").bind(poolId).all<any>()).results,all=(await env.DB.prepare("SELECT p.user_id,p.team_id,p.game_id,g.week,g.completed,g.winner_id FROM picks p JOIN games g ON g.id=p.game_id WHERE p.pool_id=?").bind(poolId).all<any>()).results;
 const standings=people.map(p=>{const pp=all.filter(x=>x.user_id===p.user_id&&x.completed),wp=pp.filter(x=>x.week===week);return{...p,correct:pp.filter(x=>x.team_id===x.winner_id).length,total:pp.length,weekCorrect:wp.filter(x=>x.team_id===x.winner_id).length,weekTotal:wp.length}}).sort((a,b)=>b.correct-a.correct||a.display_name.localeCompare(b.display_name));
 const history=[];for(let w=1;w<=18;w++){const complete=await env.DB.prepare("SELECT COUNT(*) c,SUM(completed) done FROM games WHERE season=? AND week=?").bind(SEASON,w).first<any>();if(!complete?.c||Number(complete.done)!==Number(complete.c))continue;const games=all.filter(x=>x.week===w&&x.completed);const scores=people.map(p=>({displayName:p.display_name,score:games.filter(x=>x.user_id===p.user_id&&x.team_id===x.winner_id).length,total:games.filter(x=>x.user_id===p.user_id).length})),max=Math.max(...scores.map(s=>s.score));history.push({week:w,winners:scores.filter(s=>s.score===max&&s.total>0)})}
 return json({picks:Object.fromEntries(mine.map(p=>[p.game_id,p.team_id])),adjusted:Object.fromEntries(mine.map(p=>[p.game_id,!!p.admin_adjusted])),standings,history});
}
async function savePick(req:Request,env:Env,user:User){const b=await body(req);if(!await isMember(env,b.poolId,user.id))return json({error:"Not a member."},403);const game=await env.DB.prepare("SELECT * FROM games WHERE id=?").bind(b.gameId).first<any>();if(!game||![game.home_id,game.away_id].includes(b.teamId))return json({error:"Invalid game or team."},400);if(Date.now()>=new Date(game.lock_override||game.start_time).getTime())return json({error:"That game is locked."},409);await env.DB.prepare("INSERT INTO picks(id,pool_id,user_id,game_id,team_id,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(pool_id,user_id,game_id) DO UPDATE SET team_id=excluded.team_id,updated_at=excluded.updated_at,admin_adjusted=0").bind(crypto.randomUUID(),b.poolId,user.id,b.gameId,b.teamId,Date.now()).run();return json({saved:true})}
async function isMember(env:Env,poolId:string,userId:string){return !!await env.DB.prepare("SELECT id FROM memberships WHERE pool_id=? AND user_id=?").bind(poolId,userId).first()}

async function adminUsers(env:Env,user:User){if(user.role!=="admin")return json({error:"Admin required."},403);return json({users:(await env.DB.prepare("SELECT id,username,display_name,role,disabled,created_at FROM users ORDER BY created_at").all()).results,audit:(await env.DB.prepare("SELECT a.*,u.username admin_username FROM audit_log a JOIN users u ON u.id=a.admin_id ORDER BY a.created_at DESC LIMIT 50").all()).results})}
async function adminReset(req:Request,env:Env,user:User){if(user.role!=="admin")return json({error:"Admin required."},403);const b=await body(req),password=String(b.password||"");if(password.length<10)return json({error:"Temporary password must be at least 10 characters."},400);const target=await env.DB.prepare("SELECT username FROM users WHERE id=?").bind(b.userId).first<any>();if(!target)return json({error:"User not found."},404);const salt=randomToken(18),hash=await hashPassword(password,salt,env.AUTH_PEPPER);await env.DB.batch([env.DB.prepare("UPDATE users SET password_hash=?,password_salt=?,must_change_password=1 WHERE id=?").bind(hash,salt,b.userId),env.DB.prepare("DELETE FROM sessions WHERE user_id=?").bind(b.userId),audit(env,user.id,"reset_password","user",b.userId,null,"temporary password issued",String(b.reason||"Account recovery"))]);return json({ok:true})}
async function adminPick(req:Request,env:Env,user:User){if(user.role!=="admin")return json({error:"Admin required."},403);const b=await body(req),old=await env.DB.prepare("SELECT team_id FROM picks WHERE pool_id=? AND user_id=? AND game_id=?").bind(b.poolId,b.userId,b.gameId).first<any>();await env.DB.batch([env.DB.prepare("INSERT INTO picks(id,pool_id,user_id,game_id,team_id,updated_at,admin_adjusted) VALUES(?,?,?,?,?,?,1) ON CONFLICT(pool_id,user_id,game_id) DO UPDATE SET team_id=excluded.team_id,updated_at=excluded.updated_at,admin_adjusted=1").bind(crypto.randomUUID(),b.poolId,b.userId,b.gameId,b.teamId,Date.now()),audit(env,user.id,"override_pick","pick",`${b.poolId}:${b.userId}:${b.gameId}`,old?.team_id||null,b.teamId,String(b.reason||"Correction"))]);return json({ok:true})}
async function adminGame(req:Request,env:Env,user:User){if(user.role!=="admin")return json({error:"Admin required."},403);const b=await body(req),old=await env.DB.prepare("SELECT lock_override FROM games WHERE id=?").bind(b.gameId).first<any>();await env.DB.batch([env.DB.prepare("UPDATE games SET lock_override=? WHERE id=?").bind(b.lockOverride||null,b.gameId),audit(env,user.id,"override_lock","game",b.gameId,old?.lock_override||null,b.lockOverride||null,String(b.reason||"Schedule correction"))]);return json({ok:true})}
function audit(env:Env,adminId:string,action:string,type:string,target:string,oldValue:any,newValue:any,reason:string){return env.DB.prepare("INSERT INTO audit_log(id,admin_id,action,target_type,target_id,old_value,new_value,reason,created_at) VALUES(?,?,?,?,?,?,?,?,?)").bind(crypto.randomUUID(),adminId,action,type,target,oldValue==null?null:String(oldValue),newValue==null?null:String(newValue),reason.slice(0,200),Date.now())}

function gameDto(g:any){return{id:g.id,startTime:g.start_time,lockTime:g.lock_override||g.start_time,status:g.status,completed:!!g.completed,winnerId:g.winner_id,home:{id:g.home_id,abbreviation:g.home_abbr,name:g.home_name,logo:g.home_logo,score:g.home_score},away:{id:g.away_id,abbreviation:g.away_abbr,name:g.away_name,logo:g.away_logo,score:g.away_score}}}
function publicUser(r:any):User{return{id:r.id,username:r.username,display_name:r.display_name,role:r.role,theme:r.theme||"stadium",logo_mode:r.logo_mode||"espn",must_change_password:r.must_change_password||0}}
async function body(req:Request){return await req.json() as Record<string,any>}function cleanUsername(v:any){const s=String(v||"").trim().toLowerCase();return /^[a-z0-9_]{3,24}$/.test(s)?s:""}function cleanDisplay(v:any){const s=String(v||"").trim().slice(0,40);return s||null}function clampWeek(v:any){return Math.min(18,Math.max(1,Number(v||1)))}function score(v:any){const n=Number(v);return Number.isFinite(n)?n:null}function inviteCode(){const chars="ABCDEFGHJKLMNPQRSTUVWXYZ23456789";return Array.from(crypto.getRandomValues(new Uint8Array(6)),n=>chars[n%chars.length]).join("")}function randomToken(bytes:number){return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(bytes)))).replace(/[+/=]/g,"").slice(0,bytes*2)}
async function hashPassword(password:string,salt:string,pepper:string){const key=await crypto.subtle.importKey("raw",new TextEncoder().encode(password+pepper),"PBKDF2",false,["deriveBits"]),bits=await crypto.subtle.deriveBits({name:"PBKDF2",hash:"SHA-256",salt:new TextEncoder().encode(salt),iterations:100000},key,256);return hex(bits)}async function sha256(v:string){return hex(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(v)))}function hex(v:ArrayBuffer){return [...new Uint8Array(v)].map(x=>x.toString(16).padStart(2,"0")).join("")}function timingSafe(a:string,b:string){if(a.length!==b.length)return false;let r=0;for(let i=0;i<a.length;i++)r|=a.charCodeAt(i)^b.charCodeAt(i);return r===0}
function cookie(req:Request,name:string){return req.headers.get("cookie")?.split(";").map(x=>x.trim()).find(x=>x.startsWith(name+"="))?.slice(name.length+1)||null}function sessionCookie(token:string,expires:number){return `fp_session=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Expires=${new Date(expires).toUTCString()}`}function clearCookie(){return "fp_session=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0"}function json(data:any,status=200,headers:Record<string,string>={}){return new Response(JSON.stringify(data),{status,headers:{"content-type":"application/json; charset=utf-8","cache-control":"no-store",...headers}})}
