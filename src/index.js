import { DurableObject } from "cloudflare:workers";

const j = (data, status=200) => new Response(JSON.stringify(data), {status, headers:{"content-type":"application/json; charset=utf-8"}});
const nowIso = () => new Date().toISOString();
const clamp = (n,a,b) => Math.max(a,Math.min(b,Number(n)||0));
const id = (p) => `${p}_${crypto.randomUUID()}`;
const DEFAULTS = {
  characterName:"Loki", userName:"Raylee", timezone:"America/New_York",
  autonomy:{enabled:false,minVisits:2,maxVisits:4,minIntervalMinutes:30,activeStart:"08:00",activeEnd:"23:30"},
  reactionLibrary:["❤️","🙄","😂","😭","😒","🤨","😌","💀","👀"],
  agent:{profileId:"",persona:"",userPersona:"",worldbook:"",instructions:"Write briefly and naturally. Do not invent shared experiences. Do not react to everything."},
  modelProfiles:[],
  bridge:{enabled:false,url:"",key:"",immediateReaction:"decide",maxContextChars:2800}
};

export class Companion extends DurableObject {
  constructor(ctx, env){ super(ctx,env); this.ctx=ctx; this.env=env; }
  get(k,d=null){ const v=this.ctx.storage.kv.get(k); return v===undefined?d:v; }
  put(k,v){ this.ctx.storage.kv.put(k,v); }
  settings(){ return {...DEFAULTS,...this.get("settings",{}), autonomy:{...DEFAULTS.autonomy,...(this.get("settings",{}).autonomy||{})}, agent:{...DEFAULTS.agent,...(this.get("settings",{}).agent||{})}, bridge:{...DEFAULTS.bridge,...(this.get("settings",{}).bridge||{})}}; }
  list(kind){ return this.get(`list:${kind}`,[]); }
  save(kind, arr){ this.put(`list:${kind}`,arr); }
  add(kind, item){ const arr=this.list(kind); arr.push(item); this.save(kind,arr); return item; }
  update(kind, itemId, patch){ const arr=this.list(kind); const i=arr.findIndex(x=>x.id===itemId); if(i<0)return null; arr[i]={...arr[i],...patch,updatedAt:nowIso()}; this.save(kind,arr); return arr[i]; }
  async fetch(req){
    const u=new URL(req.url), p=u.pathname, m=req.method;
    if(p==="/api/health") return j({ok:true});
    if(!(await this.auth(req))) return j({ok:false,error:"Bad companion password"},401);
    if(p==="/api/bootstrap"&&m==="GET") return j({ok:true,settings:this.settings(),schedule:this.list("schedule"),diary:this.list("diary"),comments:this.list("comments"),reactions:this.list("reactions"),highlights:this.list("highlights"),notifications:this.list("notifications").slice(-50).reverse()});
    if(p==="/api/settings"&&m==="PUT") return this.setSettings(req);
    if(p==="/api/admin/fresh-start"&&m==="POST") return this.freshStart();
    if(p==="/api/schedule"&&m==="POST") return this.createSchedule(req);
    if(p.startsWith("/api/schedule/")&&m==="PATCH") return this.patch("schedule",p.split("/").pop(),req);
    if(p.startsWith("/api/schedule/")&&m==="DELETE") return this.remove("schedule",p.split("/").pop());
    if(p==="/api/diary"&&m==="POST") return this.createDiary(req);
    if(p.startsWith("/api/diary/")&&m==="PATCH") return this.patch("diary",p.split("/").pop(),req);
    if(p.startsWith("/api/diary/")&&m==="DELETE") return this.remove("diary",p.split("/").pop());
    if(p==="/api/comment"&&m==="POST") return this.createComment(req);
    if(p==="/api/reaction"&&m==="POST") return this.createReaction(req);
    if(p==="/api/highlight"&&m==="POST") return this.createHighlight(req);
    if(p==="/api/agent/run"&&m==="POST") return this.agentRun(req);
    if(p==="/api/session/commit"&&m==="POST") return this.commitSession(req);
    if(p==="/api/notifications/read"&&m==="POST"){ this.save("notifications",this.list("notifications").map(x=>({...x,read:true}))); return j({ok:true}); }
    return j({ok:false,error:"Not found"},404);
  }
  async auth(req){ const secret=String(this.env.COMPANION_PASSWORD||""); if(!secret)return true; const got=req.headers.get("x-companion-key")||""; return got===secret; }
  async body(req){ try{return await req.json();}catch{return{};} }
  async freshStart(){
    const kinds=["schedule","diary","comments","reactions","highlights","notifications"];
    const deleted={};
    for(const kind of kinds){
      const items=this.list(kind);
      deleted[kind]=items.length;
      this.save(kind,[]);
    }
    const pending=this.get("pending:user",[]);
    deleted.pendingUser=Array.isArray(pending)?pending.length:0;
    this.put("pending:user",[]);
    return j({ok:true,freshStart:true,deleted,settingsPreserved:true});
  }
  async setSettings(req){ const b=await this.body(req); const old=this.settings(); const a=b.autonomy||{}; const next={...old,...b,autonomy:{...old.autonomy,...a,minVisits:clamp(a.minVisits??old.autonomy.minVisits,0,10),maxVisits:clamp(a.maxVisits??old.autonomy.maxVisits,0,10),minIntervalMinutes:clamp(a.minIntervalMinutes??old.autonomy.minIntervalMinutes,0,1440)},reactionLibrary:[...new Set((b.reactionLibrary??old.reactionLibrary).map(String))].slice(0,50)}; if(next.autonomy.maxVisits<next.autonomy.minVisits)next.autonomy.maxVisits=next.autonomy.minVisits; this.put("settings",next); await this.arm(); return j({ok:true,settings:next}); }
  async createSchedule(req){ const b=await this.body(req); const x={id:id("s"),owner:"user",date:String(b.date||"").slice(0,10),time:String(b.time||"").slice(0,5),end:String(b.end||"").slice(0,5),text:String(b.text||"").trim(),status:"planned",createdAt:nowIso(),updatedAt:nowIso()}; if(!x.date||!x.text)return j({ok:false,error:"date and text required"},400); this.add("schedule",x); return j({ok:true,item:x}); }
  async createDiary(req){ const b=await this.body(req); const owner="user", date=String(b.date||"").slice(0,10); let arr=this.list("diary"); const existing=arr.find(x=>x.owner===owner&&x.date===date); if(existing){ const item=this.update("diary",existing.id,{text:String(b.text||"").trim()}); return j({ok:true,item}); } const x={id:id("d"),owner,date,text:String(b.text||"").trim(),createdAt:nowIso(),updatedAt:nowIso()}; if(!date||!x.text)return j({ok:false,error:"date and text required"},400); this.add("diary",x); return j({ok:true,item:x}); }
  target(type,targetId){ if(!["schedule","diary"].includes(type))return null; return this.list(type).find(x=>x.id===targetId)||null; }
  async patch(kind,itemId,req){
    const old=this.list(kind).find(x=>x.id===itemId);
    if(!old)return j({ok:false,error:"Not found"},404);
    if(old.owner!=="user")return j({ok:false,error:"Only your own entries can be edited here"},403);
    const b=await this.body(req), patch={};
    if(kind==="schedule"){
      if(b.text!==undefined){patch.text=String(b.text).trim();if(!patch.text)return j({ok:false,error:"Text required"},400);}
      if(b.date!==undefined)patch.date=String(b.date).slice(0,10);
      if(b.time!==undefined)patch.time=String(b.time).slice(0,5);
      if(b.end!==undefined)patch.end=String(b.end).slice(0,5);
      if(b.status!==undefined){
        if(!["planned","done","failed","cancelled","changed"].includes(b.status))return j({ok:false,error:"Invalid status"},400);
        patch.status=b.status;
        if(b.status==="changed"){
          patch.actualText=String(b.actualText||"").trim();
          if(!patch.actualText)return j({ok:false,error:"Describe what you did instead"},400);
        }else patch.actualText="";
      }
    }else{
      if(b.text===undefined||!String(b.text).trim())return j({ok:false,error:"Diary text required"},400);
      patch.text=String(b.text).trim();
    }
    return j({ok:true,item:this.update(kind,itemId,patch)});
  }
  async remove(kind,itemId){
    const arr=this.list(kind), item=arr.find(x=>x.id===itemId);
    if(!item)return j({ok:false,error:"Not found"},404);
    if(item.owner!=="user")return j({ok:false,error:"Only your own entries can be deleted"},403);
    this.save(kind,arr.filter(x=>x.id!==itemId));
    this.save("comments",this.list("comments").filter(x=>!(x.targetType===kind&&x.targetId===itemId)));
    this.save("reactions",this.list("reactions").filter(x=>!(x.targetType===kind&&x.targetId===itemId)));
    if(kind==="diary")this.save("highlights",this.list("highlights").filter(x=>x.diaryId!==itemId));
    return j({ok:true});
  }
  async createComment(req){ const b=await this.body(req); const target=this.target(b.targetType,b.targetId);
    if(!target||target.owner!=="character")return j({ok:false,error:"You can only comment on the character's entries"},403);
    const x={id:id("c"),actor:"user",targetType:b.targetType,targetId:b.targetId,text:String(b.text||"").trim(),createdAt:nowIso()};
    if(!x.text)return j({ok:false,error:"Comment required"},400);this.add("comments",x);return j({ok:true,item:x}); }
  async createReaction(req){ const b=await this.body(req),lib=this.settings().reactionLibrary,target=this.target(b.targetType,b.targetId);
    if(!target||target.owner!=="character")return j({ok:false,error:"You can only react to the character's entries"},403);
    if(!String(b.emoji||"").trim()||String(b.emoji).length>80)return j({ok:false,error:"Enter a reaction (up to 80 characters)"},400);
    let arr=this.list("reactions").filter(x=>!(x.actor==="user"&&x.targetType===b.targetType&&x.targetId===b.targetId));
    const x={id:id("r"),actor:"user",targetType:b.targetType,targetId:b.targetId,emoji:b.emoji,createdAt:nowIso()};
    arr.push(x);this.save("reactions",arr);return j({ok:true,item:x}); }
  async createHighlight(req){const b=await this.body(req),diary=this.target("diary",b.diaryId);
    if(!diary||diary.owner!=="character")return j({ok:false,error:"Only the character's diary can be highlighted"},403);
    const x={id:id("h"),actor:"user",diaryId:diary.id,text:String(b.text||""),start:Number(b.start)||0,end:Number(b.end)||0,createdAt:nowIso()};
    if(!x.text)return j({ok:false,error:"Text required"},400);this.add("highlights",x);return j({ok:true,item:x}); }
  async commitSession(req){ const b=await this.body(req), actions=Array.isArray(b.actions)?b.actions:[]; if(!actions.length)return j({ok:true,empty:true}); const meaningful=actions.filter(x=>["comment","reaction","highlight","write_schedule","write_diary","update_schedule"].includes(x.type)); if(!meaningful.length)return j({ok:true,empty:true}); this.put("pending:user",[...this.get("pending:user",[]),...meaningful].slice(-30)); await this.pushBridge("user_activity",this.compactActivity(meaningful)); return j({ok:true}); }
  compactActivity(actions){ return actions.slice(-8).map(a=>{ if(a.type==="reaction")return `${a.emoji||"reacted"} on “${String(a.targetText||"").slice(0,80)}”`; if(a.type==="comment")return `Comment on “${String(a.targetText||"").slice(0,60)}”: “${String(a.text||"").slice(0,100)}”`; if(a.type==="highlight")return `Highlighted “${String(a.text||"").slice(0,100)}”`; return String(a.summary||a.type); }).join("\n"); }
  localDate(){return new Intl.DateTimeFormat("en-CA",{timeZone:this.settings().timezone||this.env.TZ||"America/New_York",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date());}
  async agentRun(req){
    const b=await this.body(req);
    const mode=["look_schedule","write_schedule","look_diary","write_diary","autonomous"].includes(b.mode)?b.mode:"autonomous";
    try{
      const result=await this.callAgent(mode,b.date);
      if(mode==="write_schedule"&&!(Array.isArray(result.schedule)&&result.schedule.some(x=>String(x.text||"").trim())))throw new Error("Model returned no schedule entry. Nothing was saved; please try again.");
      if(mode==="write_diary"&&!String(result.diary?.text||"").trim())throw new Error("Model returned no diary entry. Nothing was saved; please try again.");
      if((mode==="look_schedule"||mode==="look_diary")&&!(Array.isArray(result.comments)&&result.comments.length)&&!(Array.isArray(result.reactions)&&result.reactions.length))throw new Error("Loki looked, but returned no reaction or comment. Please try again.");
      const outcome=await this.applyAgent(result,mode,b.date);
      if(mode==="write_schedule"&&outcome.schedule===0)throw new Error("Model returned no schedule entry. Nothing was saved; please try again.");
      if(mode==="write_diary"&&outcome.diary===0)throw new Error("Model returned no diary entry. Nothing was saved; please try again.");
      if((mode==="look_schedule"||mode==="look_diary")&&outcome.comments+outcome.reactions===0)throw new Error("Loki did not leave a valid reaction or comment. Nothing was recorded; please try again.");
      if(mode==="look_schedule"||mode==="look_diary"){
        const subject=mode==="look_diary"?"diary":"schedule";
        const details=[];
        if(outcome.reactions)details.push(`reacted to ${outcome.reactions} ${outcome.reactions===1?"entry":"entries"}`);
        if(outcome.comments)details.push(`commented on ${outcome.comments} ${outcome.comments===1?"entry":"entries"}`);
        const receipt=`${this.settings().characterName} looked at your ${subject}. ${details.length?details.join(" and ")+".":"No reaction or comment."}`;
        this.add("notifications",{id:id("n"),text:receipt,read:false,createdAt:nowIso()});
      }
      return j({ok:true,result,applied:outcome});
    }catch(e){return j({ok:false,error:e.message||String(e)},400);}
  }
  async callAgent(mode,requestedDate){
    const s=this.settings(),profile=s.modelProfiles.find(x=>x.id===s.agent.profileId);
    if(!profile)throw new Error("Choose a model profile in Settings first.");
    const pending=this.get("pending:user",[]),date=/^\d{4}-\d{2}-\d{2}$/.test(requestedDate||"")?requestedDate:this.localDate();
    const userScheduleForDate=this.list("schedule").filter(x=>x.owner==="user"&&x.date===date);
    const userDiaryForDate=this.list("diary").filter(x=>x.owner==="user"&&x.date===date);
    const instruction=mode==="write_schedule"?`MANDATORY: Create at least ONE nonempty schedule item in the schedule array for ${date}. You are writing YOUR OWN day, not merely looking. If uncertain, write a small believable everyday plan or activity. Do not leave schedule empty.`:mode==="write_diary"?`MANDATORY: Write a nonempty diary object {"date":"${date}","text":"..."}. Write YOUR OWN diary, even if it is just 1-2 natural sentences. Do not return null diary.`:mode==="look_schedule"?`LOOK ONLY at the user's schedule. Do NOT create schedules or diary entries. MANDATORY: leave at least ONE interaction on a USER schedule entry for TARGET DATE: either a natural comment or exactly one reaction chosen from AVAILABLE REACTIONS. You may do both. For every schedule interaction, targetType MUST be "schedule" and targetId MUST be an exact schedule id shown in ELIGIBLE TARGETS. Never return with both comments and reactions empty.`:mode==="look_diary"?`LOOK ONLY at the user's diary. Do NOT create schedules or diary entries. MANDATORY: leave at least ONE interaction on the USER diary entry for TARGET DATE: either a natural comment or exactly one reaction chosen from AVAILABLE REACTIONS. You may do both. For every diary interaction, targetType MUST be "diary" and targetId MUST be the exact diary id shown in ELIGIBLE TARGETS. Never use "schedule" for a diary interaction. Never return with both comments and reactions empty.`:`Visit naturally. You may write your own schedule/diary or interact with the USER's entries, or do nothing.`;
    const prompt=`You are ${s.characterName}. Return ONLY valid JSON.\nMODE: ${mode}\nTARGET DATE: ${date}\nLOCAL TIMEZONE: ${s.timezone}\nCURRENT UTC: ${nowIso()}\nIMPORTANT INSTRUCTION: ${instruction}\nYou can change the status of YOUR OWN existing schedules using updates [{"id":"existing id","status":"done|failed|cancelled|changed","actualText":"required only for changed"}]. Do not edit or delete original schedule text.\nYou can ONLY comment/react to the USER's existing entries. Never comment/react to your own.\nPERSONA:\n${s.agent.persona}\nUSER:\n${s.agent.userPersona}\nWORLDBOOK:\n${s.agent.worldbook}\nSPECIAL INSTRUCTIONS:\n${s.agent.instructions}\nAVAILABLE REACTIONS: ${s.reactionLibrary.join(" ")}\nELIGIBLE TARGETS FOR THIS REQUEST:\n${mode==="look_diary"?JSON.stringify(userDiaryForDate):mode==="look_schedule"?JSON.stringify(userScheduleForDate):"n/a"}\nINTERACTION JSON SCHEMA: comments use {"targetType":"schedule|diary","targetId":"exact existing id","text":"..."}; reactions use {"targetType":"schedule|diary","targetId":"exact existing id","emoji":"one AVAILABLE REACTION"}.\nRECENT USER ACTIVITY:\n${this.compactActivity(pending)}\nYOUR SCHEDULE:\n${JSON.stringify(this.list("schedule").filter(x=>x.owner==="character").slice(-30))}\nUSER SCHEDULE:\n${JSON.stringify(this.list("schedule").filter(x=>x.owner==="user").slice(-30))}\nYOUR DIARY:\n${JSON.stringify(this.list("diary").filter(x=>x.owner==="character").slice(-7))}\nUSER DIARY:\n${JSON.stringify(this.list("diary").filter(x=>x.owner==="user").slice(-7))}\nReturn JSON shape {"schedule":[],"updates":[],"diary":null,"comments":[],"reactions":[],"summary":{"diary":"","schedule":[]},"messageNow":null}. schedule items use {"date":"${date}","time":"HH:MM or empty","end":"HH:MM or empty","text":"..."}. Comments/reactions must target existing USER entry IDs only.`;
    const base=String(profile.baseUrl||"").replace(/\/$/,"");const path=profile.path||"/chat/completions";
    const r=await fetch(base+path,{method:"POST",headers:{"content-type":"application/json","authorization":`Bearer ${profile.apiKey||""}`,...(profile.headers||{})},body:JSON.stringify({model:profile.model,messages:[{role:"system",content:prompt},{role:"user",content:mode.startsWith("write_")?`Write the required ${mode==="write_schedule"?"schedule":"diary"} for ${date} now. Return a nonempty result.`:mode.startsWith("look_")?`Look at the requested user content now and MUST leave at least one valid reaction or comment on it.`:"Decide what you naturally do this visit."}],...(profile.temperature===null||profile.temperature===undefined?{}:{temperature:Number(profile.temperature)}),response_format:{type:"json_object"}})});
    const txt=await r.text();if(!r.ok)throw new Error(`Model ${r.status}: ${txt.slice(0,300)}`);
    let data;try{data=JSON.parse(txt);}catch{throw new Error("Model returned non-JSON response envelope");}
    const content=data.choices?.[0]?.message?.content??data.output_text??"";
    try{return JSON.parse(content.replace(/^```json\s*|\s*```$/g,""));}catch{throw new Error("Model did not return valid action JSON");}
  }
  async applyAgent(o,mode="autonomous",requestedDate){
    if(!o||typeof o!=="object")throw new Error("Model returned invalid action data");
    const dateNow=/^\d{4}-\d{2}-\d{2}$/.test(requestedDate||"")?requestedDate:this.localDate();
    const outcome={schedule:0,diary:0,updates:0,comments:0,reactions:0};
    const writeSchedule=mode==="write_schedule"||mode==="autonomous",writeDiary=mode==="write_diary"||mode==="autonomous";
    if(writeSchedule)for(const x of (Array.isArray(o.schedule)?o.schedule:[]).slice(0,10)){
      if(!String(x.text||"").trim())continue;
      const item={id:id("s"),owner:"character",date:dateNow,time:String(x.time||"").slice(0,5),end:String(x.end||"").slice(0,5),text:String(x.text).trim().slice(0,1000),status:"planned",createdAt:nowIso(),updatedAt:nowIso()};
      this.add("schedule",item);outcome.schedule++;
    }
    if(mode==="autonomous")for(const x of (Array.isArray(o.updates)?o.updates:[]).slice(0,12)){
      const old=this.list("schedule").find(z=>z.id===x.id&&z.owner==="character");
      if(!old||!["planned","done","failed","cancelled","changed"].includes(x.status))continue;
      const actualText=String(x.actualText||"").trim();if(x.status==="changed"&&!actualText)continue;
      this.update("schedule",old.id,{status:x.status,actualText:x.status==="changed"?actualText:""});outcome.updates++;
    }
    if(writeDiary&&o.diary&&String(o.diary.text||"").trim()){
      const text=String(o.diary.text).trim().slice(0,10000);
      const existing=this.list("diary").find(x=>x.owner==="character"&&x.date===dateNow);
      if(!existing){this.add("diary",{id:id("d"),owner:"character",date:dateNow,text,createdAt:nowIso(),updatedAt:nowIso()});outcome.diary++;}
      else if(mode==="write_diary")throw new Error("A diary entry already exists for this day. No overwrite was made.");
    }
    const forcedType=mode==="look_diary"?"diary":mode==="look_schedule"?"schedule":null;
    const diaryTarget=mode==="look_diary"?this.list("diary").find(z=>z.owner==="user"&&z.date===dateNow):null;
    for(const x of (Array.isArray(o.comments)?o.comments:[]).slice(0,5)){
      const type=forcedType||x.targetType||"schedule";
      let targetId=x.targetId;
      let target=this.target(type,targetId);
      if(mode==="look_diary"&&(!target||target.owner!=="user")) { target=diaryTarget; targetId=diaryTarget?.id; }
      if(!target||target.owner!=="user"||!String(x.text||"").trim())continue;
      this.add("comments",{id:id("c"),actor:"character",targetType:type,targetId,text:String(x.text).slice(0,500),createdAt:nowIso()});outcome.comments++;
    }
    for(const x of (Array.isArray(o.reactions)?o.reactions:[]).slice(0,5)){
      const type=forcedType||x.targetType||"schedule";
      let targetId=x.targetId;
      let target=this.target(type,targetId);
      if(mode==="look_diary"&&(!target||target.owner!=="user")) { target=diaryTarget; targetId=diaryTarget?.id; }
      if(!target||target.owner!=="user"||!this.settings().reactionLibrary.includes(x.emoji))continue;
      const arr=this.list("reactions").filter(r=>!(r.actor==="character"&&r.targetType===type&&r.targetId===targetId));
      arr.push({id:id("r"),actor:"character",targetType:type,targetId,emoji:x.emoji,createdAt:nowIso()});this.save("reactions",arr);outcome.reactions++;
    }
    if(Object.values(outcome).some(Boolean)){
      this.put("pending:user",[]);
      const parts=[];if(outcome.schedule)parts.push(`wrote ${outcome.schedule} schedule ${outcome.schedule===1?"entry":"entries"}`);
      if(outcome.diary)parts.push("wrote a diary entry");if(outcome.updates)parts.push(`updated ${outcome.updates} schedule status(es)`);
      if(outcome.comments)parts.push(`left ${outcome.comments} comment(s)`);if(outcome.reactions)parts.push(`added ${outcome.reactions} reaction(s)`);
      this.add("notifications",{id:id("n"),text:`${this.settings().characterName} ${parts.join(", ")}.`,read:false,createdAt:nowIso()});
      const summary=[];if(o.summary?.diary)summary.push(`Diary\n${String(o.summary.diary).slice(0,280)}`);
      if(Array.isArray(o.summary?.schedule)&&o.summary.schedule.length)summary.push(`Schedule\n${o.summary.schedule.slice(0,8).map(x=>`- ${String(x).slice(0,120)}`).join("\n")}`);
      if(summary.length)await this.pushBridge("character_summary",summary.join("\n\n"));
    }
    return outcome;
  }
  async pushBridge(type,text){ const b=this.settings().bridge; if(!b.enabled||!b.url||!text)return; try{ await fetch(b.url,{method:"POST",headers:{"content-type":"application/json","authorization":`Bearer ${b.key||""}`},body:JSON.stringify({type,text,createdAt:nowIso()})}); }catch{} }
  async arm(){ const s=this.settings(); if(!s.autonomy.enabled||s.autonomy.maxVisits===0){ await this.ctx.storage.deleteAlarm(); return; } const min=Math.max(10,s.autonomy.minIntervalMinutes)*60000; await this.ctx.storage.setAlarm(Date.now()+min); }
  async alarm(){ const s=this.settings(); if(!s.autonomy.enabled||s.autonomy.maxVisits===0)return; const d=new Intl.DateTimeFormat("en-CA",{timeZone:s.timezone||this.env.TZ||"America/New_York",hour:"2-digit",minute:"2-digit",hour12:false}).format(new Date()); const [h,m]=d.split(":").map(Number), cur=h*60+m, [sh,sm]=s.autonomy.activeStart.split(":").map(Number), [eh,em]=s.autonomy.activeEnd.split(":").map(Number); if(cur>=sh*60+sm&&cur<=eh*60+em){ const key=`visits:${new Intl.DateTimeFormat("en-CA",{timeZone:s.timezone||this.env.TZ||"America/New_York",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date())}`; const count=this.get(key,0); const target=this.get(`${key}:target`,null)??Math.floor(Math.random()*(s.autonomy.maxVisits-s.autonomy.minVisits+1))+s.autonomy.minVisits; this.put(`${key}:target`,target); if(count<target){ try{await this.applyAgent(await this.callAgent("autonomous"),"autonomous"); this.put(key,count+1);}catch{} } } const min=Math.max(10,s.autonomy.minIntervalMinutes)*60000; await this.ctx.storage.setAlarm(Date.now()+min+Math.floor(Math.random()*min)); }
}

export default { async fetch(req,env){ const u=new URL(req.url); if(u.pathname.startsWith("/api/")){ const stub=env.COMPANION.get(env.COMPANION.idFromName("main")); return stub.fetch(req); } return env.ASSETS.fetch(req); } };
