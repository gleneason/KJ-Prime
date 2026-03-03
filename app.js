const STORAGE_KEY = "kjprime-html-state-v1";

/* ========= Utilities ========= */
function todayISO(){ return new Date().toISOString().slice(0,10); }
function addDaysISO(iso, delta){
  const d = new Date(iso + "T00:00:00"); d.setDate(d.getDate() + delta);
  return d.toISOString().slice(0,10);
}
function clamp(n,a,b){ return Math.max(a, Math.min(b,n)); }
function roundTo(n, d=2){ const p=10**d; return Math.round(n*p)/p; }
function startOfWeekISO(iso){
  const d = new Date(iso + "T00:00:00");
  const day = d.getDay(); // 0 Sun
  const diff = (day===0 ? -6 : 1-day);
  d.setDate(d.getDate()+diff);
  return d.toISOString().slice(0,10);
}
function toast(msg){
  const root = document.getElementById("toast");
  const el = document.createElement("div");
  el.className = "toastItem";
  el.textContent = msg;
  root.appendChild(el);
  setTimeout(()=> el.remove(), 2200);
}

/* ========= Default State ========= */
const DEFAULT_STATE = {
  profile: {
    name: "KJ",
    targetSleepHours: 8.5,
    mode: "Football",
    level: 1,
    totalXP: 0,
    onboardingComplete: false,
    baselines: {}
  },
  ui: {
    tab: "dash",
    onboardStep: 0,
    onboardMode: "Football",
    onboardBase: { bench:"", squat:"", clean:"", forty:"", bodyweight:"" },
    prFocusKey: "bench",
    lastPRFlashId: null,
    titleOverride: null
  },

  checkIns: [],       // {date,sleepHours,sleepQuality,soreness,mindReadiness,illnessFlag}
  foodEntries: [],    // {id,date,mealType,calories,protein,carbs,fats}
  sessions: [],       // {id,date,category,durationMin,rpe,sessionLoad}
  prEntries: [],      // {id,date,metricKey,value,isPR}
  xpLogs: [],         // {date,delta,reason}
  questClaims: [],    // {id,date,questId,xp}

  skillTrees: [
    { name:"Strength", level:1, maxLevel:10, xp:0, xpToNext:350 },
    { name:"Speed", level:1, maxLevel:10, xp:0, xpToNext:350 },
    { name:"Explosive", level:1, maxLevel:10, xp:0, xpToNext:350 },
    { name:"Fuel", level:1, maxLevel:10, xp:0, xpToNext:350 },
    { name:"Recovery", level:1, maxLevel:10, xp:0, xpToNext:350 }
  ],

  badges: []          // {id,date,meta}
};

function loadState(){
  try{
    const raw = localStorage.getItem(STORAGE_KEY);
    if(raw){
      const s = JSON.parse(raw);
      s.ui = s.ui || DEFAULT_STATE.ui;
      s.profile = s.profile || DEFAULT_STATE.profile;
      s.checkIns = s.checkIns || [];
      s.foodEntries = s.foodEntries || [];
      s.sessions = s.sessions || [];
      s.prEntries = s.prEntries || [];
      s.xpLogs = s.xpLogs || [];
      s.questClaims = s.questClaims || [];
      s.skillTrees = s.skillTrees || DEFAULT_STATE.skillTrees;
      s.badges = s.badges || [];
      return s;
    }
  }catch{}
  return JSON.parse(JSON.stringify(DEFAULT_STATE));
}
function saveState(s){ localStorage.setItem(STORAGE_KEY, JSON.stringify(s)); }
function resetState(){
  localStorage.removeItem(STORAGE_KEY);
  toast("State reset.");
  render();
}

/* ========= XP + Level ========= */
function xpForLevel(level){ return Math.round(350 * Math.pow(level, 2.05)); }
function getLevelFromXP(totalXP){
  let lvl=1;
  while(xpForLevel(lvl+1) <= totalXP) lvl++;
  return lvl;
}
function awardXP(state, amount, reason){
  if(amount<=0) return;
  state.profile.totalXP += amount;
  const newLvl = getLevelFromXP(state.profile.totalXP);
  if(newLvl > state.profile.level){
    state.profile.level = newLvl;
    toast(`LEVEL UP! Now Level ${newLvl}`);
  }
  state.xpLogs.push({ date: todayISO(), delta: amount, reason });
}
function awardSkillXP(state, treeName, amount){
  const t = state.skillTrees.find(x=> x.name===treeName);
  if(!t) return;
  t.xp += amount;
  while(t.level < t.maxLevel && t.xp >= t.xpToNext){
    t.xp -= t.xpToNext;
    t.level++;
    t.xpToNext = Math.round(350 * Math.pow(t.level, 1.6));
  }
}

/* ========= Nutrition ========= */
function getNutritionTargets(mode){
  switch(mode){
    case "Track": return { calories:2800, protein:170, carbs:380, fats:80 };
    case "Football": return { calories:3200, protein:200, carbs:350, fats:100 };
    case "OffSeasonStrength": return { calories:3400, protein:210, carbs:400, fats:95 };
    case "OffSeasonSpeed": return { calories:3000, protein:180, carbs:370, fats:85 };
    case "Recovery": return { calories:2600, protein:180, carbs:300, fats:75 };
    default: return { calories:3000, protein:180, carbs:350, fats:90 };
  }
}
function computeMacroAdherence(actual, target){
  const calPct = Math.min((actual.calories/target.calories)*100, 110);
  const proPct = Math.min((actual.protein/target.protein)*100, 110);
  const carbPct = Math.min((actual.carbs/target.carbs)*100, 110);
  const fatPct = Math.min((actual.fats/target.fats)*100, 110);
  return Math.min(0.40*proPct + 0.30*carbPct + 0.20*calPct + 0.10*fatPct, 110);
}

/* ========= Training Load + Readiness ========= */
function sessionLoad(durationMin, rpe){ return Math.round(durationMin * rpe); }
function mean(arr){ return arr.reduce((a,b)=>a+b,0)/Math.max(1,arr.length); }
function stdev(arr){
  if(arr.length<2) return 0;
  const m = mean(arr);
  const v = mean(arr.map(x => (x-m)*(x-m)));
  return Math.sqrt(v);
}
function getLoadsByDay(state, daysBack){
  const end = todayISO();
  const map = new Map();
  for(let i=0;i<daysBack;i++){
    const d = addDaysISO(end, -i);
    map.set(d, 0);
  }
  for(const s of state.sessions){
    if(map.has(s.date)) map.set(s.date, map.get(s.date) + (s.sessionLoad||0));
  }
  return map;
}
function computeReadiness(state, dateISO){
  const check = state.checkIns.find(c => c.date===dateISO);

  const sleepHours = check?.sleepHours ?? 0;
  const sleepScore = clamp((sleepHours / (state.profile.targetSleepHours||8.5))*100, 0, 100);

  const soreness = check?.soreness ?? 5;
  const sorenessScore = clamp(((10-soreness)/10)*100, 0, 100);

  const mind = check?.mindReadiness ?? 5;
  const mindScore = clamp((mind/10)*100, 0, 100);

  const targets = getNutritionTargets(state.profile.mode);
  const food = state.foodEntries.filter(f=> f.date===dateISO);
  const macros = food.reduce((acc,f)=>({
    calories: acc.calories+f.calories,
    protein: acc.protein+f.protein,
    carbs: acc.carbs+f.carbs,
    fats: acc.fats+f.fats
  }), {calories:0,protein:0,carbs:0,fats:0});
  const fuelScore = clamp(computeMacroAdherence(macros, targets), 0, 110);

  const acuteMap = getLoadsByDay(state, 7);
  const chronicMap = getLoadsByDay(state, 28);
  const acuteLoads = Array.from(acuteMap.values());
  const chronicLoads = Array.from(chronicMap.values());

  const acuteLoad7 = acuteLoads.reduce((a,b)=>a+b,0);
  const chronicLoad28 = chronicLoads.reduce((a,b)=>a+b,0);

  const chronicWeekly = chronicLoad28/4;
  const loadRatio = chronicWeekly>0 ? acuteLoad7/chronicWeekly : 0;

  const dailyMean = mean(acuteLoads);
  const dailySD = stdev(acuteLoads);
  const monotony = dailySD>0 ? dailyMean/dailySD : (dailyMean>0 ? 2.2 : 0);
  const strain = Math.round(acuteLoad7 * monotony);

  let loadScore = 100;
  if(loadRatio > 1.3) loadScore -= (loadRatio-1.3)*60;
  if(loadRatio < 0.8 && acuteLoad7>0) loadScore -= (0.8-loadRatio)*25;
  if(monotony > 1.8) loadScore -= (monotony-1.8)*35;
  if(strain > 2500) loadScore -= (strain-2500)/40;
  loadScore = clamp(loadScore, 0, 100);

  const illnessPenalty = check?.illnessFlag ? 20 : 0;

  let score = 0.30*sleepScore + 0.25*loadScore + 0.15*sorenessScore + 0.15*mindScore + 0.15*clamp(fuelScore,0,100);
  score = clamp(Math.round(score - illnessPenalty), 0, 100);

  const zone =
    score>=85 ? "Prime State" :
    score>=70 ? "Game Ready" :
    score>=50 ? "Stable" : "Recovery Focus";

  const deloadFlag = (loadRatio>1.3) || (monotony>1.8) || (strain>3000);

  return {
    date: dateISO,
    sleepScore: Math.round(sleepScore),
    loadScore: Math.round(loadScore),
    sorenessScore: Math.round(sorenessScore),
    mindScore: Math.round(mindScore),
    fuelScore: Math.round(clamp(fuelScore,0,100)),
    acuteLoad7,
    chronicLoad28,
    loadRatio,
    monotony,
    strain,
    score,
    zone,
    deloadFlag
  };
}

/* ========= Prime Score ========= */
function computePrimeScore(state){
  const levels = state.skillTrees.map(t=>t.level);
  const norm = levels.map(l=>(l/10)*100);
  const w = state.profile.mode==="Track"
    ? [0.20,0.30,0.20,0.15,0.15]
    : [0.30,0.20,0.20,0.15,0.15];
  return Math.round(norm.reduce((sum,val,i)=> sum + val*(w[i]||0), 0));
}
function getPrimeTier(score){
  if(score>=90) return "Prime";
  if(score>=75) return "High Prime";
  if(score>=60) return "Elite";
  if(score>=40) return "Varsity";
  return "Development";
}

/* ========= PR Metrics ========= */
const PR_METRICS = [
  { key:"bench", label:"Bench Press", unit:"lb", better:"higher" },
  { key:"squat", label:"Squat", unit:"lb", better:"higher" },
  { key:"clean", label:"Power Clean", unit:"lb", better:"higher" },
  { key:"shot", label:"Shot Put", unit:"ft", better:"higher" },
  { key:"discus", label:"Discus", unit:"ft", better:"higher" },
  { key:"forty", label:"40 Yard", unit:"sec", better:"lower" },
  { key:"hundred", label:"100m", unit:"sec", better:"lower" },
  { key:"twohundred", label:"200m", unit:"sec", better:"lower" }
];
function metricDef(key){ return PR_METRICS.find(m=>m.key===key); }
function getCurrentPR(state, key){
  const def = metricDef(key);
  const arr = state.prEntries.filter(e=>e.metricKey===key);
  if(arr.length===0) return null;
  let best = arr[0].value;
  for(const e of arr){
    best = def.better==="higher" ? Math.max(best,e.value) : Math.min(best,e.value);
  }
  return best;
}
function addPREntry(state, metricKey, value, dateISO){
  const def = metricDef(metricKey);
  if(!def) return {isPR:false};
  const prev = getCurrentPR(state, metricKey);
  const isPR = (prev===null)
    ? true
    : (def.better==="higher" ? value>prev : value<prev);

  const id = crypto.randomUUID ? crypto.randomUUID() : String(Date.now()+Math.random());
  state.prEntries.push({ id, date: dateISO, metricKey, value, isPR });

  awardXP(state, 15, "Logged PR attempt");
  if(isPR){
    awardXP(state, 60, "NEW PR");
    state.ui.lastPRFlashId = id;
    toast("NEW PR!");
  }

  if(["bench","squat","clean"].includes(metricKey)) awardSkillXP(state,"Strength", isPR?80:20);
  if(["forty","hundred","twohundred"].includes(metricKey)) awardSkillXP(state,"Speed", isPR?80:20);
  if(["shot","discus"].includes(metricKey)) awardSkillXP(state,"Explosive", isPR?80:20);

  evaluateBadges(state);
  return {isPR};
}

/* ========= Trend / Best / Streak / Rank ========= */
const TREND_WINDOW_DAYS = 42;

function getTrendInWindow(state, metricKey, days=TREND_WINDOW_DAYS){
  const def = metricDef(metricKey);
  const all = state.prEntries
    .filter(e=>e.metricKey===metricKey)
    .slice()
    .sort((a,b)=> a.date<b.date ? -1 : 1);

  if(all.length<2) return null;
  const endISO = all[all.length-1].date;
  const startISO = addDaysISO(endISO, -days);
  const win = all.filter(e=>e.date>=startISO);
  if(win.length<2) return null;

  const start = win[0];
  const end = win[win.length-1];
  const rawDelta = end.value - start.value;
  const improved = def.better==="higher" ? rawDelta>0 : rawDelta<0;

  const daysBetween = Math.max(1, Math.round((new Date(end.date+"T00:00:00") - new Date(start.date+"T00:00:00"))/(1000*60*60*24)));
  const weeks = Math.max(1, Math.round(daysBetween/7));

  return { def, start, end, rawDelta, magnitude: Math.abs(rawDelta), improved, weeks };
}
function formatTrendBadge(tr){
  if(!tr) return "";
  const minChange = tr.def.unit==="sec" ? 0.02 : 1;
  if(tr.magnitude < minChange) return "";
  const decimals = tr.def.unit==="sec" ? 2 : 0;
  const mag = roundTo(tr.magnitude, decimals);

  const sign = tr.improved
    ? (tr.def.better==="higher" ? "+" : "−")
    : (tr.def.better==="higher" ? "−" : "+");

  const col = tr.improved ? "var(--green)" : "var(--yellow)";
  const border = tr.improved ? "hsl(142 70% 45% / .55)" : "hsl(48 100% 50% / .55)";
  return `<span class="badge" style="color:${col};border-color:${border};">${sign}${mag} ${tr.def.unit} in ${tr.weeks}w</span>`;
}
function getBestInWindow(state, metricKey, windowDays){
  const def = metricDef(metricKey);
  const all = state.prEntries
    .filter(e=>e.metricKey===metricKey)
    .slice()
    .sort((a,b)=> a.date<b.date ? -1 : 1);
  if(all.length<2) return null;
  const endISO = all[all.length-1].date;
  const startISO = addDaysISO(endISO, -windowDays);
  const win = all.filter(e=>e.date>=startISO);
  if(win.length<2) return null;

  let best = win[0];
  for(const e of win){
    best = def.better==="higher"
      ? (e.value>best.value ? e : best)
      : (e.value<best.value ? e : best);
  }
  const tag = windowDays===30 ? "BEST 30D" : windowDays===90 ? "BEST 90D" : `BEST ${windowDays}D`;
  return `<span class="badge" style="color:var(--blue);border-color:hsl(200 80% 60% / .45);">${tag}: ${best.value} ${def.unit}</span>`;
}
function getWeeklyBestSeries(state, metricKey){
  const def = metricDef(metricKey);
  const entries = state.prEntries
    .filter(e=>e.metricKey===metricKey)
    .slice()
    .sort((a,b)=> a.date<b.date ? -1 : 1);
  if(entries.length===0) return [];
  const byWeek = new Map();
  for(const e of entries){
    const wk = startOfWeekISO(e.date);
    const cur = byWeek.get(wk);
    if(cur===undefined) byWeek.set(wk, e.value);
    else byWeek.set(wk, def.better==="higher" ? Math.max(cur,e.value) : Math.min(cur,e.value));
  }
  return Array.from(byWeek.keys()).sort().map(w=>({weekStart:w, value:byWeek.get(w)}));
}
function getWeeklyImprovementStreak(state, metricKey){
  const def = metricDef(metricKey);
  const series = getWeeklyBestSeries(state, metricKey);
  if(series.length<2) return 0;
  let streak=0;
  for(let i=series.length-1;i>0;i--){
    const cur = series[i].value;
    const prev = series[i-1].value;
    const improved = def.better==="higher" ? cur>prev : cur<prev;
    if(improved) streak++;
    else break;
  }
  return streak;
}
const STREAK_RANKS = [
  { min:10, title:"Elite Run", color:"var(--yellow)" },
  { min:6, title:"On Fire", color:"var(--orange)" },
  { min:3, title:"Hot Hand", color:"var(--pink)" },
  { min:0, title:"Prospect", color:"var(--muted)" }
];
function getStreakRank(streak){
  for(const r of STREAK_RANKS) if(streak>=r.min) return r;
  return STREAK_RANKS[STREAK_RANKS.length-1];
}

/* ========= Badges ========= */
const BADGE_DEFS = [
  { id:"badge.first_pr", title:"First Blood", desc:"Log your first PR attempt", icon:"🏁" },
  { id:"badge.first_new_pr", title:"New PR!", desc:"Hit your first NEW PR", icon:"🏆" },
  { id:"badge.quests_10", title:"Quest Grinder", desc:"Claim 10 quests", icon:"🧩" },
  { id:"badge.sessions_20", title:"Workhorse", desc:"Log 20 sessions", icon:"🐎" },
  { id:"badge.gameready_7", title:"Game Day Ready", desc:"Readiness ≥ 80 on 7 days", icon:"🛡️" },
  { id:"badge.hot_hand", title:"Hot Hand", desc:"3-week improvement streak", icon:"🔥" },
  { id:"badge.on_fire", title:"On Fire", desc:"6-week improvement streak", icon:"🌋" },
  { id:"badge.elite_run", title:"Elite Run", desc:"10-week improvement streak", icon:"👑" }
];
function hasBadge(state,id){ return state.badges.some(b=>b.id===id); }
function awardBadge(state,id,meta={}){
  if(hasBadge(state,id)) return false;
  state.badges.push({ id, date: todayISO(), meta });
  awardXP(state, 50, `Badge: ${id}`);
  toast("Badge unlocked!");
  return true;
}
function evaluateBadges(state){
  if(state.prEntries.length>=1) awardBadge(state,"badge.first_pr");
  if(state.prEntries.some(e=>e.isPR)) awardBadge(state,"badge.first_new_pr");
  if(state.questClaims.length>=10) awardBadge(state,"badge.quests_10");
  if(state.sessions.length>=20) awardBadge(state,"badge.sessions_20");

  // Game ready days
  const uniqueDays = new Set(state.checkIns.map(c=>c.date));
  let ready=0;
  for(const d of uniqueDays){
    const r = computeReadiness(state,d);
    if(r.score>=80) ready++;
  }
  if(ready>=7) awardBadge(state,"badge.gameready_7",{ready});

  // Streak max
  let maxStreak=0;
  for(const m of PR_METRICS) maxStreak = Math.max(maxStreak, getWeeklyImprovementStreak(state,m.key));
  if(maxStreak>=3) awardBadge(state,"badge.hot_hand",{maxStreak});
  if(maxStreak>=6) awardBadge(state,"badge.on_fire",{maxStreak});
  if(maxStreak>=10) awardBadge(state,"badge.elite_run",{maxStreak});
}

/* ========= Titles ========= */
function getBestStreakAcrossMetrics(state){
  let best = { streak:0, metricKey:null };
  for(const m of PR_METRICS){
    const s = getWeeklyImprovementStreak(state, m.key);
    if(s > best.streak) best = { streak:s, metricKey:m.key };
  }
  return best;
}
function getTitleFromState(state){
  const best = getBestStreakAcrossMetrics(state);
  return { title: getStreakRank(best.streak).title, streak: best.streak, metricKey: best.metricKey };
}
function getDisplayTitle(state){
  if(state.ui.titleOverride) return { title: state.ui.titleOverride, streak:null, metricKey:null };
  return getTitleFromState(state);
}

/* ========= Quests ========= */
function getQuests(state){
  const d = todayISO();
  const wk = startOfWeekISO(d);
  const readiness = computeReadiness(state, d);
  const targets = getNutritionTargets(state.profile.mode);

  const food = state.foodEntries.filter(f => f.date===d);
  const macros = food.reduce((acc,f)=>({
    calories: acc.calories+f.calories,
    protein: acc.protein+f.protein,
    carbs: acc.carbs+f.carbs,
    fats: acc.fats+f.fats
  }), {calories:0,protein:0,carbs:0,fats:0});

  const checkedIn = !!state.checkIns.find(c=>c.date===d);
  const hitProtein = macros.protein >= targets.protein;
  const loggedSession = state.sessions.filter(s=>s.date===d).length >= 1;
  const gameReady = readiness.score >= 80;

  const weeklySessions = state.sessions.filter(s=>s.date>=wk).length;

  const daily = [
    { id:`daily.checkin.${d}`, title:"Daily Check-In", desc:"Log sleep / soreness / mind", xp:40, done:checkedIn },
    { id:`daily.protein.${d}`, title:"Protein Target", desc:`Hit ${targets.protein}g protein`, xp:50, done:hitProtein },
    { id:`daily.session.${d}`, title:"Train Logged", desc:"Log 1 session (Lift/Sprint/Throws)", xp:60, done:loggedSession },
    { id:`daily.gameready.${d}`, title:"Game Day Ready", desc:"Prime Readiness ≥ 80", xp:60, done:gameReady }
  ];

  const weekly = [
    { id:`weekly.sessions.${wk}`, title:"Weekly Quest", desc:"Log 4 sessions this week", xp:160, done:weeklySessions>=4 }
  ];

  return {daily, weekly};
}
function hasClaimed(state, questId){ return state.questClaims.some(c=>c.questId===questId); }
function claimQuest(state, quest){
  if(!quest.done){ toast("Not completed yet."); return; }
  if(hasClaimed(state, quest.id)){ toast("Already claimed."); return; }
  state.questClaims.push({ id: String(Date.now()+Math.random()), date: todayISO(), questId: quest.id, xp: quest.xp });
  awardXP(state, quest.xp, `Quest: ${quest.title}`);
  toast(`Quest claimed: +${quest.xp} XP`);
  evaluateBadges(state);
}

/* ========= Charts ========= */
function prTimelineSVG(state, metricKey){
  const def = metricDef(metricKey);
  const entries = state.prEntries
    .filter(e=>e.metricKey===metricKey)
    .slice()
    .sort((a,b)=> a.date<b.date ? -1 : 1);

  if(entries.length<2){
    return `<div class="small muted">Log at least 2 attempts to unlock the timeline.</div>`;
  }

  const pts = entries.slice(-12);
  const values = pts.map(p=>p.value);
  const minV = Math.min(...values);
  const maxV = Math.max(...values);
  const pad = (maxV-minV)*0.1 || 1;
  const lo = minV-pad;
  const hi = maxV+pad;

  const W=360, H=160;
  const xStep = W/(pts.length-1);

  const coords = pts.map((p,i)=>{
    const x=i*xStep;
    const y=H-((p.value-lo)/(hi-lo))*H;
    return {x,y,p};
  });

  const path = coords.map((c,i)=>`${i===0?"M":"L"} ${c.x.toFixed(1)} ${c.y.toFixed(1)}`).join(" ");
  const dots = coords.map(c=>{
    const fill = c.p.isPR ? "hsl(48 100% 50%)" : "hsl(0 0% 55%)";
    const r = c.p.isPR ? 4 : 3;
    return `<circle cx="${c.x}" cy="${c.y}" r="${r}" fill="${fill}" />`;
  }).join("");

  return `
    <svg viewBox="0 0 ${W} ${H}" width="100%" height="160" style="display:block;">
      <path d="${path}" fill="none" stroke="hsl(0 60% 25%)" stroke-width="3" stroke-linecap="round" />
      ${dots}
    </svg>
    <div class="tiny muted" style="margin-top:6px;display:flex;justify-content:space-between;">
      <span>${pts[0].date}</span>
      <span>${def.label}</span>
      <span>${pts[pts.length-1].date}</span>
    </div>
  `;
}

/* ========= Share Card (PNG export) ========= */
function roundRect(ctx, x, y, w, h, r, fill, stroke){
  ctx.beginPath();
  ctx.moveTo(x+r, y);
  ctx.arcTo(x+w, y, x+w, y+h, r);
  ctx.arcTo(x+w, y+h, x, y+h, r);
  ctx.arcTo(x, y+h, x, y, r);
  ctx.arcTo(x, y, x+w, y, r);
  ctx.closePath();
  if(fill){ ctx.fillStyle=fill; ctx.fill(); }
  if(stroke){ ctx.strokeStyle=stroke; ctx.lineWidth=2; ctx.stroke(); }
}
function drawShareCard(state, canvas){
  const ctx = canvas.getContext("2d");
  const W=1080, H=1350;
  canvas.width=W; canvas.height=H;

  const bg="#0d0d0d";
  const card="#1c1c1c";
  const border="#2e2e2e";
  const maroon="#5a1414";
  const yellow="#ffd400";
  const muted="#8c8c8c";
  const fg="#ebebeb";
  const green="#34c26c";

  const d=todayISO();
  const readiness=computeReadiness(state,d);
  const primeScore=computePrimeScore(state);
  const t=getDisplayTitle(state);
  const titleLine=`${state.profile.name} — ${t.title}`.toUpperCase();

  const pinned=state.ui.prFocusKey || "bench";
  const pinnedDef=metricDef(pinned);
  const pinnedPR=getCurrentPR(state,pinned);

  ctx.fillStyle=bg; ctx.fillRect(0,0,W,H);
  ctx.fillStyle=maroon; ctx.fillRect(0,0,W,170);

  ctx.fillStyle=fg; ctx.font="900 72px Oswald, sans-serif";
  ctx.fillText("KJ PRIME", 70, 95);

  ctx.fillStyle=yellow; ctx.font="700 26px Oswald, sans-serif";
  ctx.fillText("PRIME > AVERAGE", 70, 140);

  const pad=60;
  const cardX=pad, cardY=220, cardW=W-pad*2, cardH=H-300;
  roundRect(ctx, cardX, cardY, cardW, cardH, 42, card, border);

  ctx.fillStyle=yellow; ctx.font="700 30px Oswald, sans-serif";
  ctx.fillText(titleLine, cardX+50, cardY+80);

  ctx.fillStyle=muted; ctx.font="500 22px Inter, sans-serif";
  ctx.fillText("Prime Readiness", cardX+50, cardY+135);

  ctx.fillStyle=fg; ctx.font="800 60px Oswald, sans-serif";
  ctx.fillText(String(readiness.score), cardX+50, cardY+200);

  ctx.fillStyle=muted; ctx.font="600 22px Inter, sans-serif";
  ctx.fillText((readiness.zone||"").toUpperCase(), cardX+50, cardY+235);

  ctx.fillStyle=muted; ctx.font="500 22px Inter, sans-serif";
  ctx.fillText("Prime Score", cardX+420, cardY+135);

  ctx.fillStyle=fg; ctx.font="800 60px Oswald, sans-serif";
  ctx.fillText(String(primeScore), cardX+420, cardY+200);

  ctx.fillStyle=border; ctx.fillRect(cardX+50, cardY+270, cardW-100, 2);

  ctx.fillStyle=muted; ctx.font="600 22px Inter, sans-serif";
  ctx.fillText("Pinned PR", cardX+50, cardY+330);

  ctx.fillStyle=fg; ctx.font="800 44px Oswald, sans-serif";
  ctx.fillText((pinnedDef?.label ?? pinned).toUpperCase(), cardX+50, cardY+395);

  ctx.fillStyle=yellow; ctx.font="800 64px Oswald, sans-serif";
  const prText = pinnedPR==null ? "—" : `${pinnedPR} ${pinnedDef?.unit ?? ""}`.trim();
  ctx.fillText(prText, cardX+50, cardY+470);

  const tr = getTrendInWindow(state,pinned);
  const trText = tr ? formatTrendBadge(tr).replace(/<[^>]*>/g,"") : "LOG MORE TO UNLOCK TREND";
  const isUp = tr?.improved;
  ctx.fillStyle=isUp ? green : yellow;
  ctx.font="700 28px Oswald, sans-serif";
  ctx.fillText(trText.toUpperCase(), cardX+50, cardY+520);

  ctx.fillStyle=muted; ctx.font="500 20px Inter, sans-serif";
  ctx.fillText(`Generated ${d}`, cardX+50, cardY+cardH-60);
  ctx.fillText(`kj-prime`, cardX+cardW-170, cardY+cardH-60);
}
function openShareModal(state){
  const modal=document.createElement("div");
  modal.className="modal";
  modal.innerHTML=`
    <div class="modal-inner">
      <div class="row" style="justify-content:space-between;align-items:center;">
        <div class="h-heading" style="font-size:16px;">SHARE CARD</div>
        <button class="btn-ghost" data-close style="width:auto;padding:10px 12px;">CLOSE</button>
      </div>
      <div class="canvas-wrap" style="margin-top:12px;">
        <canvas id="shareCanvas" style="width:100%;height:auto;border-radius:14px;"></canvas>
      </div>
      <div class="modal-actions">
        <button class="btn btn-accent" data-download>DOWNLOAD PNG</button>
        <button class="btn" data-regen>RENDER AGAIN</button>
      </div>
      <div class="tiny muted" style="margin-top:10px;line-height:1.5;">
        Tip: choose a metric on PR page to change pinned PR.
      </div>
    </div>
  `;
  document.body.appendChild(modal);

  const canvas=modal.querySelector("#shareCanvas");
  drawShareCard(state,canvas);

  modal.querySelector("[data-close]").onclick=()=>modal.remove();
  modal.onclick=(e)=>{ if(e.target===modal) modal.remove(); };
  modal.querySelector("[data-regen]").onclick=()=>drawShareCard(state,canvas);
  modal.querySelector("[data-download]").onclick=()=>{
    const link=document.createElement("a");
    link.download=`KJ-Prime-Share-${todayISO()}.png`;
    link.href=canvas.toDataURL("image/png");
    link.click();
  };
}

/* ========= UI Components ========= */
function readinessRingHTML(score, zone){
  const size=140, stroke=10;
  const r=(size-stroke*2)/2;
  const C=2*Math.PI*r;
  const prog=(score/100)*C;
  const col = score>=85 ? "var(--yellow)" : score>=70 ? "var(--green)" : score>=50 ? "var(--muted)" : "var(--red)";
  return `
    <div class="ringWrap">
      <svg width="${size}" height="${size}">
        <circle cx="${size/2}" cy="${size/2}" r="${r}" stroke="hsl(0 0% 18%)" stroke-width="${stroke}" fill="none"></circle>
        <circle cx="${size/2}" cy="${size/2}" r="${r}" stroke="${col}" stroke-width="${stroke}" fill="none" stroke-linecap="round"
          stroke-dasharray="${C}" stroke-dashoffset="${C-prog}"></circle>
      </svg>
      <div class="ringText">
        <div class="h-heading" style="font-size:34px;color:${col};">${score}</div>
        <div class="tiny muted">${(zone||"—").toUpperCase()}</div>
      </div>
    </div>
  `;
}
function xpBarHTML(level,totalXP){
  const cur=xpForLevel(level);
  const nxt=xpForLevel(level+1);
  const p=clamp((totalXP-cur)/(nxt-cur),0,1);
  return `
    <div>
      <div class="row" style="justify-content:space-between;">
        <div class="tiny muted h-heading">LEVEL ${level}</div>
        <div class="tiny muted">${totalXP} / ${nxt} XP</div>
      </div>
      <div class="progressBar" style="margin-top:8px;"><div style="width:${Math.max(2,Math.round(p*100))}%;"></div></div>
    </div>
  `;
}
function skillTreeHTML(state){
  const icons={Strength:"🏋️",Speed:"⚡",Explosive:"💥",Fuel:"🔥",Recovery:"🧊"};
  return `
    <div class="grid3" style="grid-template-columns:repeat(5,1fr);gap:10px;">
      ${state.skillTrees.map(t=>{
        const pct=clamp(t.xp/Math.max(1,t.xpToNext),0,1);
        const r=18, C=2*Math.PI*r;
        return `
          <div class="center">
            <div style="position:relative;width:44px;height:44px;margin:0 auto;">
              <svg width="44" height="44" style="transform:rotate(-90deg);">
                <circle cx="22" cy="22" r="${r}" stroke="hsl(0 0% 18%)" stroke-width="3" fill="none"></circle>
                <circle cx="22" cy="22" r="${r}" stroke="hsl(0 60% 25%)" stroke-width="3" fill="none" stroke-linecap="round"
                  stroke-dasharray="${C}" stroke-dashoffset="${C-(pct*C)}"></circle>
              </svg>
              <div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:14px;">
                ${icons[t.name]||"●"}
              </div>
            </div>
            <div class="tiny muted h-heading" style="margin-top:6px;">${t.name.slice(0,3)}</div>
            <div style="font-size:12px;font-weight:700;">Lv${t.level}</div>
          </div>
        `;
      }).join("")}
    </div>
  `;
}

/* ========= Header + Nav ========= */
function headerHTML(state){
  const t=getDisplayTitle(state);
  const line=`${state.profile.name} — ${t.title}`.toUpperCase();
  return `
    <div class="container" style="padding-bottom:0;">
      <div class="row" style="justify-content:space-between;align-items:flex-start;">
        <div>
          <div class="row" style="gap:10px;">
            <img src="./icon-32-safe.png" alt="KJ Prime" style="width:28px;height:28px;border-radius:10px;border:1px solid var(--border);">
            <div>
              <div class="h-heading" style="font-size:22px;">KJ PRIME</div>
              <div class="h-heading tiny accent" style="letter-spacing:.35em;">PRIME > AVERAGE</div>
            </div>
          </div>
          <div style="margin-top:8px;">
            <span class="badge" style="color:var(--yellow);border-color:hsl(48 100% 50% / .35);">${line}</span>
          </div>
        </div>
        <div style="text-align:right;">
          <div class="badge">MODE: ${(state.profile.mode||"").toUpperCase()}</div>
          <button class="btn-ghost" style="margin-top:10px;width:auto;padding:10px 12px;" data-share>SHARE</button>
        </div>
      </div>
    </div>
  `;
}
function navHTML(state){
  const tabs=[
    {key:"dash", label:"Dashboard"},
    {key:"fuel", label:"Fuel"},
    {key:"train", label:"Train"},
    {key:"pr", label:"PRs"},
    {key:"badges", label:"Badges"}
  ];
  return `
    <div class="nav">
      <div class="nav-inner">
        ${tabs.map(t=>`
          <button data-tab="${t.key}" class="${state.ui.tab===t.key ? "active":""}">
            ${t.label.toUpperCase()}
          </button>
        `).join("")}
      </div>
    </div>
  `;
}

/* ========= Pages ========= */
function onboardingHTML(state){
  const step=state.ui.onboardStep||0;
  const mode=state.ui.onboardMode||"Football";
  const base=state.ui.onboardBase||{bench:"",squat:"",clean:"",forty:"",bodyweight:""};

  const modes=[
    {value:"Track",label:"TRACK",desc:"Speed & explosiveness. Higher carbs, sprint-dominant."},
    {value:"Football",label:"FOOTBALL",desc:"Power & durability. Higher cals + protein."},
    {value:"OffSeasonStrength",label:"OFF-SEASON STRENGTH",desc:"Calorie surplus. Max strength gains."},
    {value:"OffSeasonSpeed",label:"OFF-SEASON SPEED",desc:"Speed development. Balanced nutrition."},
    {value:"Recovery",label:"RECOVERY",desc:"Maintain protein. Light training focus."}
  ];

  if(step===0){
    return `
      <div class="container center" style="min-height:calc(100vh - 100px);display:flex;flex-direction:column;justify-content:center;gap:16px;">
        <div>
          <div class="h-heading" style="font-size:48px;letter-spacing:.14em;">KJ PRIME</div>
          <div class="hr"></div>
          <div class="h-heading tiny accent" style="letter-spacing:.35em;">PRIME > AVERAGE</div>
        </div>
        <button class="btn" data-onb-next>BEGIN</button>
      </div>
    `;
  }
  if(step===1){
    return `
      <div class="container center" style="min-height:calc(100vh - 100px);display:flex;flex-direction:column;justify-content:center;gap:16px;">
        <div class="h-heading" style="font-size:22px;line-height:1.2;">
          AVERAGE IS ACCIDENTAL.<br/><span style="color:var(--yellow)">PRIME IS BUILT.</span>
        </div>
        <div class="small muted" style="line-height:1.6;">
          Track every lift, sprint, throw, meal, sleep — and level up like a game.
        </div>
        <button class="btn" data-onb-next>SET YOUR BASELINE</button>
      </div>
    `;
  }
  if(step===2){
    const fields=[
      {k:"bench",label:"Bench 1RM",unit:"lb"},
      {k:"squat",label:"Squat 1RM",unit:"lb"},
      {k:"clean",label:"Clean 1RM",unit:"lb"},
      {k:"forty",label:"40 Yard",unit:"sec"},
      {k:"bodyweight",label:"Bodyweight",unit:"lb"}
    ];
    return `
      <div class="container">
        <div class="card">
          <div class="h-heading" style="font-size:18px;">Set Your Baseline</div>
          <div class="small muted" style="margin-top:8px;">Enter current numbers. This is where we start.</div>
          <div style="margin-top:14px;display:flex;flex-direction:column;gap:10px;">
            ${fields.map(f=>`
              <div class="row">
                <div class="small muted" style="width:140px;">${f.label}</div>
                <div style="flex:1;position:relative;">
                  <input class="input" type="number" step="any" value="${base[f.k]??""}" data-onb-base="${f.k}" placeholder="0"
                         style="padding-right:52px;text-align:right;">
                  <span class="tiny muted" style="position:absolute;right:12px;top:50%;transform:translateY(-50%);">${f.unit}</span>
                </div>
              </div>
            `).join("")}
          </div>
          <div style="margin-top:14px;">
            <button class="btn" data-onb-next>SELECT MODE</button>
          </div>
        </div>
      </div>
    `;
  }
  if(step===3){
    return `
      <div class="container">
        <div class="card">
          <div class="h-heading center" style="font-size:18px;">Select Prime Mode</div>
          <div style="margin-top:12px;display:flex;flex-direction:column;gap:10px;">
            ${modes.map(m=>`
              <button class="btn-ghost" data-onb-mode="${m.value}" style="text-align:left;${mode===m.value?'border-color:hsl(0 60% 25% / .85);background:hsl(0 40% 14%);':''}">
                <div class="h-heading" style="font-size:12px;">${m.label}</div>
                <div class="tiny muted" style="margin-top:6px;letter-spacing:normal;text-transform:none;">${m.desc}</div>
              </button>
            `).join("")}
          </div>
          <div style="margin-top:14px;">
            <button class="btn" data-onb-next>CONFIRM</button>
          </div>
        </div>
      </div>
    `;
  }
  return `
    <div class="container center" style="min-height:calc(100vh - 100px);display:flex;flex-direction:column;justify-content:center;gap:16px;">
      <div class="card">
        <div style="width:76px;height:76px;border-radius:999px;margin:0 auto;border:2px solid var(--maroon);display:flex;align-items:center;justify-content:center;background:hsl(0 40% 14%);">
          <div class="h-heading" style="font-size:38px;">1</div>
        </div>
        <div class="h-heading" style="margin-top:12px;font-size:18px;">LEVEL 1 — PROSPECT</div>
        <div class="tiny muted" style="margin-top:6px;">Development Tier</div>
        <div class="small muted" style="margin-top:12px;line-height:1.6;">
          Daily check-in → readiness. Train logging → real load. PRs → level-ups.
        </div>
        <button class="btn btn-accent" style="margin-top:14px;" data-onb-finish>ACTIVATE PRIME MODE</button>
      </div>
    </div>
  `;
}

function dashHTML(state){
  const d=todayISO();
  const r=computeReadiness(state,d);

  const targets=getNutritionTargets(state.profile.mode);
  const food=state.foodEntries.filter(f=>f.date===d);
  const macros=food.reduce((acc,f)=>({
    calories:acc.calories+f.calories,
    protein:acc.protein+f.protein,
    carbs:acc.carbs+f.carbs,
    fats:acc.fats+f.fats
  }),{calories:0,protein:0,carbs:0,fats:0});

  const primeScore=computePrimeScore(state);
  const tier=getPrimeTier(primeScore);

  const adjustment =
    r.deloadFlag ? "DELOAD RECOMMENDED — Reduce volume 25–40% for 7 days" :
    r.zone==="Recovery Focus" ? "Swap to mobility/technique/light work" :
    r.zone==="Stable" ? "Reduce volume 10–20%" : "";

  const check=state.checkIns.find(c=>c.date===d);
  const sessionsToday=state.sessions.filter(s=>s.date===d).length;

  const {daily, weekly}=getQuests(state);

  return `
    ${headerHTML(state)}
    <div class="container">
      <div class="card">
        <div class="row" style="align-items:center;">
          ${readinessRingHTML(r.score, r.zone)}
          <div style="flex:1;">
            <div class="tiny muted h-heading">PRIME READINESS</div>
            <div class="small muted" style="margin-top:8px;line-height:1.6;">
              Load Ratio: <b style="color:var(--fg)">${r.loadRatio ? r.loadRatio.toFixed(2) : "—"}</b><br/>
              Monotony: <b style="color:var(--fg)">${r.monotony ? r.monotony.toFixed(1) : "—"}</b>
            </div>
            <div style="margin-top:12px;">
              ${xpBarHTML(state.profile.level, state.profile.totalXP)}
            </div>
          </div>
        </div>
        <div style="margin-top:12px;">
          <button class="btn-ghost" data-open-checkin>${check ? "EDIT CHECK-IN" : "DAILY CHECK-IN"}</button>
        </div>
      </div>

      ${adjustment ? `
        <div class="card" style="margin-top:12px;background:hsl(0 40% 14%);border-color:hsl(0 60% 25% / .45);">
          <div class="h-heading tiny" style="color:var(--yellow);letter-spacing:.14em;">COACH ADJUSTMENT</div>
          <div class="small" style="margin-top:8px;">${adjustment}</div>
        </div>
      ` : ""}

      <div class="card" style="margin-top:12px;">
        <div class="row" style="justify-content:space-between;align-items:baseline;">
          <div>
            <div class="tiny muted h-heading">PRIME SCORE</div>
            <div class="h-heading" style="font-size:34px;margin-top:6px;">${primeScore}</div>
          </div>
          <div style="text-align:right;">
            <div class="tiny muted h-heading">TIER</div>
            <div class="h-heading" style="margin-top:6px;color:var(--yellow);">${tier.toUpperCase()}</div>
          </div>
        </div>
        <div class="progressBar" style="margin-top:10px;">
          <div style="width:${primeScore}%;"></div>
        </div>
      </div>

      <div class="card" style="margin-top:12px;">
        <div class="h-heading tiny muted">SKILL TREES</div>
        <div style="margin-top:12px;">${skillTreeHTML(state)}</div>
      </div>

      <div class="card" style="margin-top:12px;">
        <div class="row" style="justify-content:space-between;">
          <div class="h-heading tiny muted">FUEL</div>
          <button class="btn-ghost" data-tab="fuel" style="width:auto;padding:10px 12px;">OPEN</button>
        </div>
        <div style="margin-top:12px;">
          ${(()=>{
            const items=[
              {label:"Cals",cur:macros.calories,tgt:targets.calories,unit:"kcal",col:"var(--green)"},
              {label:"Protein",cur:macros.protein,tgt:targets.protein,unit:"g",col:"var(--blue)"},
              {label:"Carbs",cur:macros.carbs,tgt:targets.carbs,unit:"g",col:"var(--pink)"},
              {label:"Fats",cur:macros.fats,tgt:targets.fats,unit:"g",col:"var(--orange)"}
            ];
            return `<div class="row" style="justify-content:space-around;">${
              items.map(x=>{
                const pct=clamp(x.cur/Math.max(1,x.tgt),0,1.1);
                const r=26,C=2*Math.PI*r,prog=pct*C;
                const hit=x.cur>=x.tgt;
                const col=hit?"var(--yellow)":x.col;
                return `
                  <div class="center">
                    <div style="position:relative;width:64px;height:64px;margin:0 auto;">
                      <svg width="64" height="64" style="transform:rotate(-90deg);">
                        <circle cx="32" cy="32" r="${r}" stroke="hsl(0 0% 18%)" stroke-width="6" fill="none"></circle>
                        <circle cx="32" cy="32" r="${r}" stroke="${col}" stroke-width="6" fill="none" stroke-linecap="round"
                          stroke-dasharray="${C}" stroke-dashoffset="${C-prog}"></circle>
                      </svg>
                      <div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;">
                        <div style="font-size:12px;font-weight:700;">${x.cur}</div>
                      </div>
                    </div>
                    <div class="tiny muted h-heading" style="margin-top:6px;">${x.label}</div>
                    <div class="tiny muted">${x.tgt}${x.unit}</div>
                  </div>
                `;
              }).join("")
            }</div>`;
          })()}
        </div>
      </div>

      <div class="card" style="margin-top:12px;">
        <div class="row" style="justify-content:space-between;">
          <div class="h-heading tiny muted">QUESTS</div>
          <button class="btn-ghost" data-tab="badges" style="width:auto;padding:10px 12px;">BADGES</button>
        </div>

        <div style="margin-top:12px;">
          <div class="h-heading tiny muted">DAILY</div>
          <div style="display:flex;flex-direction:column;gap:8px;margin-top:8px;">
            ${daily.map(q=>`
              <div class="row" style="justify-content:space-between;align-items:flex-start;border-bottom:1px solid var(--border);padding-bottom:8px;">
                <div>
                  <div class="h-heading" style="font-size:12px;">${q.title}</div>
                  <div class="tiny muted" style="margin-top:4px;letter-spacing:normal;text-transform:none;">${q.desc}</div>
                  <div class="tiny muted" style="margin-top:6px;">+${q.xp} XP</div>
                </div>
                <div style="text-align:right;">
                  <div class="badge" style="color:${q.done?"var(--green)":"var(--muted)"};border-color:${q.done?"hsl(142 70% 45% / .45)":"hsl(0 0% 55% / .35)"};">
                    ${q.done?"DONE":"PENDING"}
                  </div>
                  <button class="btn-ghost" data-claim-quest="${q.id}" style="margin-top:8px;width:auto;padding:10px 12px;" ${(!q.done||hasClaimed(state,q.id))?"disabled":""}>
                    ${hasClaimed(state,q.id)?"CLAIMED":"CLAIM"}
                  </button>
                </div>
              </div>
            `).join("")}
          </div>

          <div class="h-heading tiny muted" style="margin-top:14px;">WEEKLY</div>
          <div style="display:flex;flex-direction:column;gap:8px;margin-top:8px;">
            ${weekly.map(q=>`
              <div class="row" style="justify-content:space-between;align-items:flex-start;">
                <div>
                  <div class="h-heading" style="font-size:12px;">${q.title}</div>
                  <div class="tiny muted" style="margin-top:4px;letter-spacing:normal;text-transform:none;">${q.desc}</div>
                  <div class="tiny muted" style="margin-top:6px;">+${q.xp} XP</div>
                </div>
                <div style="text-align:right;">
                  <div class="badge" style="color:${q.done?"var(--green)":"var(--muted)"};border-color:${q.done?"hsl(142 70% 45% / .45)":"hsl(0 0% 55% / .35)"};">
                    ${q.done?"DONE":"PENDING"}
                  </div>
                  <button class="btn-ghost" data-claim-quest="${q.id}" style="margin-top:8px;width:auto;padding:10px 12px;" ${(!q.done||hasClaimed(state,q.id))?"disabled":""}>
                    ${hasClaimed(state,q.id)?"CLAIMED":"CLAIM"}
                  </button>
                </div>
              </div>
            `).join("")}
          </div>
        </div>
      </div>

      <div class="grid3" style="margin-top:12px;">
        <div class="kpi">
          <div class="h-heading" style="font-size:18px;">${check ? String(check.sleepHours).toFixed(1) : "—"}</div>
          <div class="tiny muted h-heading">SLEEP</div>
        </div>
        <div class="kpi">
          <div class="h-heading" style="font-size:18px;">${sessionsToday}</div>
          <div class="tiny muted h-heading">SESSIONS</div>
        </div>
        <div class="kpi">
          <div class="h-heading" style="font-size:18px;">${(state.profile.mode||"").toUpperCase().slice(0,6)}</div>
          <div class="tiny muted h-heading">MODE</div>
        </div>
      </div>

      <div style="margin-top:12px;">
        <button class="btn-danger btn" data-reset>RESET APP</button>
      </div>
    </div>
  `;
}

function fuelHTML(state){
  const d=todayISO();
  const targets=getNutritionTargets(state.profile.mode);
  const food=state.foodEntries.filter(f=>f.date===d);
  const macros=food.reduce((acc,f)=>({
    calories:acc.calories+f.calories,
    protein:acc.protein+f.protein,
    carbs:acc.carbs+f.carbs,
    fats:acc.fats+f.fats
  }),{calories:0,protein:0,carbs:0,fats:0});
  const adherence = Math.round(clamp(computeMacroAdherence(macros, targets),0,110));

  return `
    ${headerHTML(state)}
    <div class="container">
      <div class="card">
        <div class="row" style="justify-content:space-between;">
          <div>
            <div class="h-heading tiny muted">FUEL TARGETS</div>
            <div class="small muted" style="margin-top:8px;line-height:1.7;">
              Calories: <b style="color:var(--fg)">${targets.calories}</b> kcal<br/>
              Protein: <b style="color:var(--fg)">${targets.protein}</b> g<br/>
              Carbs: <b style="color:var(--fg)">${targets.carbs}</b> g<br/>
              Fats: <b style="color:var(--fg)">${targets.fats}</b> g
            </div>
          </div>
          <div style="text-align:right;">
            <div class="h-heading tiny muted">ADHERENCE</div>
            <div class="h-heading" style="font-size:34px;margin-top:6px;color:var(--yellow);">${adherence}</div>
          </div>
        </div>
        <div style="margin-top:12px;">
          <button class="btn btn-accent" data-open-meal>ADD MEAL</button>
        </div>
      </div>

      <div class="card" style="margin-top:12px;">
        <div class="h-heading tiny muted">TODAY TOTALS</div>
        <div class="grid2" style="margin-top:10px;">
          <div class="kpi"><div class="h-heading" style="font-size:18px;">${macros.calories}</div><div class="tiny muted h-heading">CALS</div></div>
          <div class="kpi"><div class="h-heading" style="font-size:18px;">${macros.protein}</div><div class="tiny muted h-heading">PROTEIN</div></div>
          <div class="kpi"><div class="h-heading" style="font-size:18px;">${macros.carbs}</div><div class="tiny muted h-heading">CARBS</div></div>
          <div class="kpi"><div class="h-heading" style="font-size:18px;">${macros.fats}</div><div class="tiny muted h-heading">FATS</div></div>
        </div>
      </div>

      <div class="card" style="margin-top:12px;">
        <div class="row" style="justify-content:space-between;">
          <div class="h-heading tiny muted">MEALS</div>
          <div class="tiny muted">${d}</div>
        </div>
        <div style="margin-top:10px;display:flex;flex-direction:column;gap:8px;">
          ${food.length===0 ? `<div class="small muted">No meals logged yet.</div>` : food.slice().reverse().map(m=>`
            <div class="row" style="justify-content:space-between;border-bottom:1px solid var(--border);padding-bottom:8px;">
              <div>
                <div class="h-heading" style="font-size:12px;">${m.mealType.toUpperCase()}</div>
                <div class="tiny muted" style="letter-spacing:normal;text-transform:none;margin-top:4px;">
                  ${m.calories} kcal · P ${m.protein} · C ${m.carbs} · F ${m.fats}
                </div>
              </div>
              <button class="btn-ghost" data-del-meal="${m.id}" style="width:auto;padding:10px 12px;">DEL</button>
            </div>
          `).join("")}
        </div>
      </div>
    </div>
  `;
}

function trainHTML(state){
  const d=todayISO();
  const todaySessions=state.sessions.filter(s=>s.date===d).slice().reverse();
  const wk=startOfWeekISO(d);
  const weeklyCount=state.sessions.filter(s=>s.date>=wk).length;

  const r=computeReadiness(state,d);

  return `
    ${headerHTML(state)}
    <div class="container">
      <div class="card">
        <div class="row" style="justify-content:space-between;align-items:flex-start;">
          <div>
            <div class="h-heading tiny muted">TRAINING LOG</div>
            <div class="small muted" style="margin-top:8px;line-height:1.6;">
              Weekly Sessions: <b style="color:var(--fg)">${weeklyCount}</b> (Goal 4)<br/>
              Acute Load (7d): <b style="color:var(--fg)">${r.acuteLoad7}</b><br/>
              Strain: <b style="color:var(--fg)">${r.strain}</b>
            </div>
          </div>
          <div style="text-align:right;">
            <div class="h-heading tiny muted">READINESS</div>
            <div class="h-heading" style="font-size:34px;margin-top:6px;color:var(--yellow);">${r.score}</div>
            <div class="tiny muted">${r.zone.toUpperCase()}</div>
          </div>
        </div>

        <div style="margin-top:12px;">
          <button class="btn btn-accent" data-open-session>ADD SESSION</button>
        </div>
      </div>

      <div class="card" style="margin-top:12px;">
        <div class="row" style="justify-content:space-between;">
          <div class="h-heading tiny muted">TODAY SESSIONS</div>
          <div class="tiny muted">${d}</div>
        </div>
        <div style="margin-top:10px;display:flex;flex-direction:column;gap:8px;">
          ${todaySessions.length===0 ? `<div class="small muted">No sessions logged yet.</div>` : todaySessions.map(s=>`
            <div class="row" style="justify-content:space-between;border-bottom:1px solid var(--border);padding-bottom:8px;">
              <div>
                <div class="h-heading" style="font-size:12px;">${s.category.toUpperCase()}</div>
                <div class="tiny muted" style="margin-top:4px;letter-spacing:normal;text-transform:none;">
                  ${s.durationMin} min · RPE ${s.rpe} · Load <b style="color:var(--fg)">${s.sessionLoad}</b>
                </div>
              </div>
              <button class="btn-ghost" data-del-session="${s.id}" style="width:auto;padding:10px 12px;">DEL</button>
            </div>
          `).join("")}
        </div>
      </div>
    </div>
  `;
}

function prHTML(state){
  const key=state.ui.prFocusKey || "bench";
  const def=metricDef(key);
  const pr=getCurrentPR(state,key);
  const streak=getWeeklyImprovementStreak(state,key);
  const rank=getStreakRank(streak);

  const entries=state.prEntries.filter(e=>e.metricKey===key).slice().sort((a,b)=> a.date<b.date ? -1 : 1);
  const last = entries.length ? entries[entries.length-1] : null;
  const flash = last && last.id===state.ui.lastPRFlashId && last.isPR;

  const trendBadge = formatTrendBadge(getTrendInWindow(state,key));
  const best30 = getBestInWindow(state,key,30) || "";
  const best90 = getBestInWindow(state,key,90) || "";

  const streakBadge = streak>=2
    ? `<span class="badge" style="color:var(--pink);border-color:hsl(330 70% 60% / .45);">STREAK: ${streak}W IMPROVED</span>`
    : "";

  const rankBadge = streak>=3
    ? `<span class="badge" style="color:${rank.color};border-color:${rank.color}33;">RANK: ${rank.title.toUpperCase()}</span>`
    : "";

  return `
    ${headerHTML(state)}
    <div class="container">
      <div class="card">
        <div class="row" style="justify-content:space-between;align-items:flex-start;">
          <div>
            <div class="h-heading tiny muted">PR TRACKER</div>
            <div class="small muted" style="margin-top:8px;">Choose metric. Log attempts. The app detects NEW PRs.</div>
          </div>
          <button class="btn-ghost" data-open-pr style="width:auto;padding:10px 12px;">ADD</button>
        </div>

        <div style="margin-top:12px;">
          <select class="input" data-pr-metric>
            ${PR_METRICS.map(m=>`
              <option value="${m.key}" ${m.key===key?"selected":""}>${m.label}</option>
            `).join("")}
          </select>
        </div>

        <div style="margin-top:12px;">
          <div class="h-heading" style="font-size:18px;">${def.label.toUpperCase()}</div>
          <div class="row" style="justify-content:space-between;align-items:baseline;margin-top:8px;">
            <div class="h-heading ${flash ? "badge-prflash":""}" style="font-size:40px;color:var(--yellow);">
              ${pr==null ? "—" : pr} <span class="tiny muted">${def.unit}</span>
            </div>
            <div class="badge" style="color:${rank.color};border-color:${rank.color}33;">${rank.title.toUpperCase()}</div>
          </div>

          <div style="margin-top:10px;display:flex;flex-wrap:wrap;gap:8px;">
            ${trendBadge || ""}
            ${best30}
            ${best90}
            ${streakBadge}
            ${rankBadge}
          </div>

          <div style="margin-top:12px;">
            ${prTimelineSVG(state,key)}
          </div>

          <div style="margin-top:12px;">
            <button class="btn-ghost" data-pin-metric="${key}">PIN THIS METRIC (Share Card)</button>
          </div>
        </div>
      </div>

      <div class="card" style="margin-top:12px;">
        <div class="h-heading tiny muted">HISTORY</div>
        <div style="margin-top:10px;display:flex;flex-direction:column;gap:8px;">
          ${entries.length===0 ? `<div class="small muted">No entries yet.</div>` : entries.slice().reverse().map(e=>`
            <div class="row" style="justify-content:space-between;border-bottom:1px solid var(--border);padding-bottom:8px;">
              <div>
                <div class="h-heading" style="font-size:12px;">${e.date}</div>
                <div class="tiny muted" style="margin-top:4px;letter-spacing:normal;text-transform:none;">
                  ${e.value} ${def.unit} ${e.isPR ? `<span class="badge" style="margin-left:6px;color:var(--yellow)">NEW PR</span>`:""}
                </div>
              </div>
              <button class="btn-ghost" data-del-pr="${e.id}" style="width:auto;padding:10px 12px;">DEL</button>
            </div>
          `).join("")}
        </div>
      </div>
    </div>
  `;
}

function badgesHTML(state){
  const earnedIds = new Set(state.badges.map(b=>b.id));
  return `
    ${headerHTML(state)}
    <div class="container">
      <div class="card">
        <div class="row" style="justify-content:space-between;">
          <div>
            <div class="h-heading tiny muted">BADGE CABINET</div>
            <div class="small muted" style="margin-top:8px;">Earn badges from streaks, quests, sessions, and readiness.</div>
          </div>
          <div class="badge">${state.badges.length} EARNED</div>
        </div>
      </div>

      <div style="margin-top:12px;display:flex;flex-direction:column;gap:10px;">
        ${BADGE_DEFS.map(b=>{
          const unlocked = earnedIds.has(b.id);
          return `
            <div class="badge-card ${unlocked?"":"locked"}">
              <div class="badge-icon">${b.icon}</div>
              <div style="flex:1;">
                <div class="h-heading" style="font-size:14px;">${b.title.toUpperCase()}</div>
                <div class="tiny muted" style="margin-top:4px;letter-spacing:normal;text-transform:none;">${b.desc}</div>
                <div class="tiny muted" style="margin-top:6px;">${unlocked ? "UNLOCKED" : "LOCKED"}</div>
              </div>
            </div>
          `;
        }).join("")}
      </div>

      <div class="card" style="margin-top:12px;">
        <div class="h-heading tiny muted">DEBUG / COACH TOOLS</div>
        <div class="small muted" style="margin-top:8px;line-height:1.6;">
          Use these if you want to quickly test leveling, streaks, and badges.
        </div>
        <div style="margin-top:12px;display:flex;flex-direction:column;gap:10px;">
          <button class="btn-ghost" data-seed>ADD SAMPLE DATA (PRs + sessions + meals)</button>
          <button class="btn-danger btn" data-reset>RESET APP</button>
        </div>
      </div>
    </div>
  `;
}

/* ========= Modals ========= */
function openModal(innerHTML){
  const modal=document.createElement("div");
  modal.className="modal";
  modal.innerHTML=`<div class="modal-inner">${innerHTML}</div>`;
  document.body.appendChild(modal);
  modal.onclick=(e)=>{ if(e.target===modal) modal.remove(); };
  return modal;
}

function openCheckinModal(state){
  const d=todayISO();
  const existing=state.checkIns.find(c=>c.date===d) || {
    date:d, sleepHours:8, sleepQuality:4, soreness:3, mindReadiness:8, illnessFlag:false
  };
  const modal=openModal(`
    <div class="row" style="justify-content:space-between;align-items:center;">
      <div class="h-heading" style="font-size:16px;">DAILY CHECK-IN</div>
      <button class="btn-ghost" data-close style="width:auto;padding:10px 12px;">CLOSE</button>
    </div>

    <div style="margin-top:12px;display:flex;flex-direction:column;gap:10px;">
      <label class="small muted">Sleep Hours</label>
      <input class="input" type="number" step="0.1" data-sleep value="${existing.sleepHours ?? 0}">

      <label class="small muted">Sleep Quality (1–5)</label>
      <input class="input" type="number" min="1" max="5" data-quality value="${existing.sleepQuality ?? 3}">

      <label class="small muted">Soreness (0–10)</label>
      <input class="input" type="number" min="0" max="10" data-soreness value="${existing.soreness ?? 5}">

      <label class="small muted">Mind Readiness (0–10)</label>
      <input class="input" type="number" min="0" max="10" data-mind value="${existing.mindReadiness ?? 5}">

      <label class="small muted">
        <input type="checkbox" data-illness ${existing.illnessFlag ? "checked":""}>
        Illness / cold symptoms
      </label>
    </div>

    <div class="modal-actions">
      <button class="btn btn-accent" data-save>Save</button>
      <button class="btn-ghost" data-close>Cancel</button>
    </div>
  `);

  modal.querySelectorAll("[data-close]").forEach(b=> b.onclick=()=>modal.remove());
  modal.querySelector("[data-save]").onclick=()=>{
    const sleep=parseFloat(modal.querySelector("[data-sleep]").value)||0;
    const quality=parseInt(modal.querySelector("[data-quality]").value||"0",10)||0;
    const soreness=parseInt(modal.querySelector("[data-soreness]").value||"0",10)||0;
    const mind=parseInt(modal.querySelector("[data-mind]").value||"0",10)||0;
    const illness=!!modal.querySelector("[data-illness]").checked;

    const idx=state.checkIns.findIndex(c=>c.date===d);
    const rec={ date:d, sleepHours:sleep, sleepQuality:quality, soreness, mindReadiness:mind, illnessFlag:illness };
    if(idx>=0) state.checkIns[idx]=rec; else state.checkIns.push(rec);

    awardXP(state, 40, "Daily check-in");
    awardSkillXP(state, "Recovery", 30);
    saveState(state);
    modal.remove();
    toast("Check-in saved.");
    render();
  };
}

function openMealModal(state){
  const modal=openModal(`
    <div class="row" style="justify-content:space-between;align-items:center;">
      <div class="h-heading" style="font-size:16px;">ADD MEAL</div>
      <button class="btn-ghost" data-close style="width:auto;padding:10px 12px;">CLOSE</button>
    </div>

    <div style="margin-top:12px;display:flex;flex-direction:column;gap:10px;">
      <label class="small muted">Meal Type</label>
      <select class="input" data-mealtype>
        <option>Breakfast</option><option>Lunch</option><option>Dinner</option><option>Snack</option>
      </select>

      <label class="small muted">Calories</label>
      <input class="input" type="number" data-cals placeholder="0">

      <label class="small muted">Protein (g)</label>
      <input class="input" type="number" data-pro placeholder="0">

      <label class="small muted">Carbs (g)</label>
      <input class="input" type="number" data-carb placeholder="0">

      <label class="small muted">Fats (g)</label>
      <input class="input" type="number" data-fat placeholder="0">
    </div>

    <div class="modal-actions">
      <button class="btn btn-accent" data-save>Save</button>
      <button class="btn-ghost" data-close>Cancel</button>
    </div>
  `);

  modal.querySelectorAll("[data-close]").forEach(b=> b.onclick=()=>modal.remove());
  modal.querySelector("[data-save]").onclick=()=>{
    const id=crypto.randomUUID ? crypto.randomUUID() : String(Date.now()+Math.random());
    const rec={
      id,
      date: todayISO(),
      mealType: modal.querySelector("[data-mealtype]").value,
      calories: parseInt(modal.querySelector("[data-cals]").value||"0",10)||0,
      protein: parseInt(modal.querySelector("[data-pro]").value||"0",10)||0,
      carbs: parseInt(modal.querySelector("[data-carb]").value||"0",10)||0,
      fats: parseInt(modal.querySelector("[data-fat]").value||"0",10)||0
    };
    state.foodEntries.push(rec);

    awardXP(state, 20, "Meal logged");
    awardSkillXP(state, "Fuel", 20);
    saveState(state);
    modal.remove();
    toast("Meal saved.");
    render();
  };
}

function openSessionModal(state){
  const modal=openModal(`
    <div class="row" style="justify-content:space-between;align-items:center;">
      <div class="h-heading" style="font-size:16px;">ADD SESSION</div>
      <button class="btn-ghost" data-close style="width:auto;padding:10px 12px;">CLOSE</button>
    </div>

    <div style="margin-top:12px;display:flex;flex-direction:column;gap:10px;">
      <label class="small muted">Category</label>
      <select class="input" data-cat>
        <option value="lift">Lift</option>
        <option value="sprint">Sprint</option>
        <option value="throws">Throws</option>
      </select>

      <label class="small muted">Duration (minutes)</label>
      <input class="input" type="number" min="1" data-dur value="60">

      <label class="small muted">RPE (1–10)</label>
      <input class="input" type="number" min="1" max="10" data-rpe value="7">
    </div>

    <div class="modal-actions">
      <button class="btn btn-accent" data-save>Save</button>
      <button class="btn-ghost" data-close>Cancel</button>
    </div>

    <div class="tiny muted" style="margin-top:10px;line-height:1.5;">
      Load = duration × RPE. Readiness updates using acute/chronic loads + monotony + strain.
    </div>
  `);

  modal.querySelectorAll("[data-close]").forEach(b=> b.onclick=()=>modal.remove());
  modal.querySelector("[data-save]").onclick=()=>{
    const id=crypto.randomUUID ? crypto.randomUUID() : String(Date.now()+Math.random());
    const cat=modal.querySelector("[data-cat]").value;
    const dur=parseInt(modal.querySelector("[data-dur]").value||"0",10)||0;
    const rpe=parseInt(modal.querySelector("[data-rpe]").value||"0",10)||0;
    const load=sessionLoad(dur,rpe);

    state.sessions.push({ id, date: todayISO(), category: cat, durationMin: dur, rpe, sessionLoad: load });

    awardXP(state, 60, "Session logged");
    if(cat==="lift") awardSkillXP(state,"Strength",30);
    if(cat==="sprint") awardSkillXP(state,"Speed",30);
    if(cat==="throws") awardSkillXP(state,"Explosive",30);
    saveState(state);
    modal.remove();
    toast("Session saved.");
    render();
  };
}

function openPRModal(state){
  const modal=openModal(`
    <div class="row" style="justify-content:space-between;align-items:center;">
      <div class="h-heading" style="font-size:16px;">LOG PR ATTEMPT</div>
      <button class="btn-ghost" data-close style="width:auto;padding:10px 12px;">CLOSE</button>
    </div>

    <div style="margin-top:12px;display:flex;flex-direction:column;gap:10px;">
      <label class="small muted">Metric</label>
      <select class="input" data-metric>
        ${PR_METRICS.map(m=>`<option value="${m.key}" ${m.key===state.ui.prFocusKey?"selected":""}>${m.label}</option>`).join("")}
      </select>

      <label class="small muted">Value</label>
      <input class="input" type="number" step="any" data-val placeholder="0">

      <label class="small muted">Date</label>
      <input class="input" type="date" data-date value="${todayISO()}">
    </div>

    <div class="modal-actions">
      <button class="btn btn-accent" data-save>Save</button>
      <button class="btn-ghost" data-close>Cancel</button>
    </div>
  `);

  modal.querySelectorAll("[data-close]").forEach(b=> b.onclick=()=>modal.remove());
  modal.querySelector("[data-save]").onclick=()=>{
    const metric=modal.querySelector("[data-metric]").value;
    const val=parseFloat(modal.querySelector("[data-val]").value||"0")||0;
    const date=modal.querySelector("[data-date]").value || todayISO();
    if(val<=0){ toast("Enter a value."); return; }
    addPREntry(state, metric, val, date);
    saveState(state);
    modal.remove();
    render();
  };
}

/* ========= Seed (demo data) ========= */
function seedSampleData(state){
  const base = todayISO();
  // sessions last 10 days
  for(let i=10;i>=1;i--){
    const d = addDaysISO(base, -i);
    const cat = (i%3===0) ? "sprint" : (i%2===0) ? "throws" : "lift";
    const dur = (cat==="sprint")? 40 : 65;
    const rpe = (cat==="lift")? 8 : 7;
    state.sessions.push({ id:String(Date.now()+Math.random()), date:d, category:cat, durationMin:dur, rpe, sessionLoad: sessionLoad(dur,rpe) });
  }
  // meals today
  state.foodEntries.push({ id:String(Date.now()+Math.random()), date:base, mealType:"Lunch", calories:900, protein:60, carbs:90, fats:25 });
  state.foodEntries.push({ id:String(Date.now()+Math.random()), date:base, mealType:"Dinner", calories:1100, protein:75, carbs:110, fats:30 });
  // checkins last 7 days
  for(let i=7;i>=0;i--){
    const d = addDaysISO(base, -i);
    state.checkIns.push({ date:d, sleepHours:7.5+(i%3)*0.4, sleepQuality:4, soreness:3+(i%4), mindReadiness:7+(i%3), illnessFlag:false });
  }
  // PRs
  const prDates=[42,35,28,21,14,7,0].map(x=>addDaysISO(base,-x));
  const bench=[205,210,215,220,225,230,235];
  for(let i=0;i<prDates.length;i++){
    addPREntry(state,"bench",bench[i],prDates[i]);
  }
  const hundred=[11.90,11.84,11.78,11.74,11.70,11.68,11.66];
  for(let i=0;i<prDates.length;i++){
    addPREntry(state,"hundred",hundred[i],prDates[i]);
  }
  saveState(state);
  toast("Sample data added.");
}

/* ========= Render ========= */
function render(){
  const state = loadState();
  const app = document.getElementById("app");

  if(!state.profile.onboardingComplete){
    app.innerHTML = onboardingHTML(state);
    return;
  }

  let page = "";
  if(state.ui.tab==="dash") page = dashHTML(state);
  if(state.ui.tab==="fuel") page = fuelHTML(state);
  if(state.ui.tab==="train") page = trainHTML(state);
  if(state.ui.tab==="pr") page = prHTML(state);
  if(state.ui.tab==="badges") page = badgesHTML(state);

  app.innerHTML = page + navHTML(state);
}

/* ========= Event Delegation ========= */
document.addEventListener("click",(e)=>{
  const state = loadState();
  const t = e.target;

  // Reset
  if(t.matches("[data-reset]")){
    resetState();
    return;
  }

  // Share
  if(t.matches("[data-share]")){
    openShareModal(state);
    return;
  }

  // Nav tabs (works anywhere)
  const tabBtn = t.closest("[data-tab]");
  if(tabBtn){
    state.ui.tab = tabBtn.getAttribute("data-tab");
    saveState(state);
    render();
    return;
  }

  // Onboarding
  if(t.matches("[data-onb-next]")){
    state.ui.onboardStep = (state.ui.onboardStep||0)+1;
    saveState(state);
    render();
    return;
  }
  if(t.matches("[data-onb-mode]")){
    state.ui.onboardMode = t.getAttribute("data-onb-mode");
    saveState(state);
    render();
    return;
  }
  if(t.matches("[data-onb-finish]")){
    // write profile
    state.profile.mode = state.ui.onboardMode || "Football";
    state.profile.onboardingComplete = true;
    state.profile.baselines = Object.fromEntries(Object.entries(state.ui.onboardBase||{}).map(([k,v])=>[k, parseFloat(v)||0]));
    awardXP(state, 100, "Onboarding complete");
    saveState(state);
    render();
    toast("Prime Mode activated.");
    return;
  }

  // Daily check-in modal
  if(t.matches("[data-open-checkin]")){
    openCheckinModal(state);
    return;
  }

  // Meal modal
  if(t.matches("[data-open-meal]")){
    openMealModal(state);
    return;
  }

  // Session modal
  if(t.matches("[data-open-session]")){
    openSessionModal(state);
    return;
  }

  // PR modal
  if(t.matches("[data-open-pr]")){
    openPRModal(state);
    return;
  }

  // Delete meal
  if(t.matches("[data-del-meal]")){
    const id=t.getAttribute("data-del-meal");
    state.foodEntries = state.foodEntries.filter(m=>m.id!==id);
    saveState(state);
    render();
    toast("Meal deleted.");
    return;
  }

  // Delete session
  if(t.matches("[data-del-session]")){
    const id=t.getAttribute("data-del-session");
    state.sessions = state.sessions.filter(s=>s.id!==id);
    saveState(state);
    render();
    toast("Session deleted.");
    return;
  }

  // Delete PR
  if(t.matches("[data-del-pr]")){
    const id=t.getAttribute("data-del-pr");
    state.prEntries = state.prEntries.filter(p=>p.id!==id);
    if(state.ui.lastPRFlashId===id) state.ui.lastPRFlashId=null;
    saveState(state);
    render();
    toast("PR entry deleted.");
    return;
  }

  // Claim quest
  if(t.matches("[data-claim-quest]")){
    const qid=t.getAttribute("data-claim-quest");
    const qs=getQuests(state);
    const all=[...qs.daily, ...qs.weekly];
    const q=all.find(x=>x.id===qid);
    if(q) claimQuest(state,q);
    saveState(state);
    render();
    return;
  }

  // Pin metric
  if(t.matches("[data-pin-metric]")){
    state.ui.prFocusKey = t.getAttribute("data-pin-metric");
    saveState(state);
    toast("Pinned metric updated for share card.");
    render();
    return;
  }

  // Seed sample
  if(t.matches("[data-seed]")){
    seedSampleData(state);
    render();
    return;
  }
});

document.addEventListener("input",(e)=>{
  const state = loadState();
  const t = e.target;

  // onboarding baseline inputs
  if(t.matches("[data-onb-base]")){
    const k=t.getAttribute("data-onb-base");
    state.ui.onboardBase = state.ui.onboardBase || {};
    state.ui.onboardBase[k] = t.value;
    saveState(state);
  }

  // PR metric select
  if(t.matches("[data-pr-metric]")){
    state.ui.prFocusKey = t.value;
    saveState(state);
    render();
  }
});

/* Boot */
render();
