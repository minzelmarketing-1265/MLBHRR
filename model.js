// MLBHRR shared model — used by index.html (live tool) and backtest.html.
// Exposes everything on window.HRR.
(function(){
const API = "https://statsapi.mlb.com/api/v1";
const WX  = "https://api.open-meteo.com/v1/forecast";
const cache = new Map();

const PARK = {
  COL:1.10, CIN:1.04, BOS:1.04, KC:1.03, TEX:1.02, ARI:1.02, AZ:1.02,
  CWS:1.01, NYY:1.01, BAL:1.00, TOR:1.00, PHI:1.00, ATL:1.00, HOU:1.00,
  WSH:0.99, LAA:0.99, LAD:0.99, MIN:0.99, STL:0.99,
  NYM:0.98, CHC:0.98, CLE:0.98, MIL:0.98, PIT:0.98,
  DET:0.97, MIA:0.97,
  SF:0.96, SD:0.96, TB:0.96, SEA:0.96,
  ATH:1.00, OAK:1.00
};
const VENUE = {
  ARI:{lat:33.4455,lon:-112.0667,dome:false}, AZ:{lat:33.4455,lon:-112.0667,dome:false},
  ATL:{lat:33.8908,lon:-84.4678,dome:false},
  BAL:{lat:39.2839,lon:-76.6217,dome:false},
  BOS:{lat:42.3467,lon:-71.0972,dome:false},
  CHC:{lat:41.9484,lon:-87.6553,dome:false},
  CWS:{lat:41.8300,lon:-87.6338,dome:false},
  CIN:{lat:39.0975,lon:-84.5072,dome:false},
  CLE:{lat:41.4962,lon:-81.6852,dome:false},
  COL:{lat:39.7559,lon:-104.9942,dome:false},
  DET:{lat:42.3390,lon:-83.0485,dome:false},
  HOU:{lat:29.7572,lon:-95.3556,dome:false},
  KC:{lat:39.0517,lon:-94.4803,dome:false},
  LAA:{lat:33.8003,lon:-117.8827,dome:false},
  LAD:{lat:34.0739,lon:-118.2400,dome:false},
  MIA:{lat:25.7781,lon:-80.2197,dome:false},
  MIL:{lat:43.0280,lon:-87.9712,dome:false},
  MIN:{lat:44.9817,lon:-93.2776,dome:false},
  NYM:{lat:40.7571,lon:-73.8458,dome:false},
  NYY:{lat:40.8296,lon:-73.9262,dome:false},
  ATH:{lat:38.5803,lon:-121.5119,dome:false}, OAK:{lat:38.5803,lon:-121.5119,dome:false},
  PHI:{lat:39.9061,lon:-75.1665,dome:false},
  PIT:{lat:40.4469,lon:-80.0057,dome:false},
  SD:{lat:32.7073,lon:-117.1566,dome:false},
  SF:{lat:37.7786,lon:-122.3893,dome:false},
  SEA:{lat:47.5914,lon:-122.3325,dome:false},
  STL:{lat:38.6226,lon:-90.1928,dome:false},
  TB:{lat:27.7682,lon:-82.6534,dome:true},
  TEX:{lat:32.7472,lon:-97.0846,dome:false},
  TOR:{lat:43.6414,lon:-79.3894,dome:true},
  WSH:{lat:38.8730,lon:-77.0074,dome:false}
};

// Lineup-spot scaling factors (tuned)
const RUN_MULT = {1:1.13, 2:1.10, 3:1.05, 4:1.00, 5:0.97, 6:0.93, 7:0.90, 8:0.87, 9:0.85};
const RBI_MULT = {1:0.83, 2:0.92, 3:1.12, 4:1.18, 5:1.10, 6:1.00, 7:0.93, 8:0.88, 9:0.82};
// Re-tuned from backtest (Jul 19-28 2024, n=950): per-PA league-average for regular starters
const LG_RPPA  = 0.108;
const LG_RBIPA = 0.104;

// ---- shared utilities
async function getJSON(url){
  if(cache.has(url)) return cache.get(url);
  const r = await fetch(url);
  if(!r.ok) throw new Error(r.status+" "+url);
  const j = await r.json();
  cache.set(url, j);
  return j;
}
const pAvg = s => { if(s==null) return null; const v=parseFloat(s); return isNaN(v)?null:v; };
const shrink = (n, val, k, prior) => (val==null||n<=0) ? prior : (n*val + k*prior)/(n+k);
const clamp = (x,a,b)=>Math.max(a,Math.min(b,x));

function expAB(o){ if(!o) return 4.0; if(o<=2) return 4.4; if(o===3) return 4.3; if(o<=5) return 4.1; if(o<=7) return 3.9; return 3.6; }
const expPA = o => expAB(o) * 1.13;
function impliedFromAmerican(o){ return o<0 ? (-o)/((-o)+100) : 100/(o+100); }
function profitPerStake(o, stake){ return o>0 ? stake*o/100 : stake*100/(-o); }
function fairAmerican(p){ if(p<=0) return null; if(p>=1) return -100000;
  return p>=0.5 ? Math.round(-100*p/(1-p)) : Math.round(100*(1-p)/p); }
const fmtOdds = o => o==null ? "—" : (o>0?"+"+o:""+o);

// Raw Poisson P(N >= k)
function poissonOverRaw(mu, k){
  if(mu<=0) return k<=0 ? 1 : 0;
  let term = Math.exp(-mu), cdf = term;
  for(let i=1;i<k;i++){ term *= mu/i; cdf += term; }
  return clamp(1 - cdf, 0, 1);
}
// Calibrated Over probability (Platt-style linear shave fit from backtest).
// k=1 (Over 0.5) and k=2 (Over 1.5) suffer Poisson tail overconfidence; k>=3 already calibrated, skip.
function poissonOver(mu, k){
  const raw = poissonOverRaw(mu, k);
  if(k >= 3) return raw;
  const P = PARAMS;
  return clamp(P.overCalibSlope*raw + P.overCalibIntercept, 0, 1);
}

async function getPitcher(id, season){
  if(!id) return null;
  const key="P"+id+"_"+season;
  if(cache.has(key)) return cache.get(key);
  const d = await getJSON(`${API}/people/${id}?hydrate=stats(group=pitching,type=season,season=${season})`);
  const pe = d.people[0];
  const st = pe.stats && pe.stats[0] && pe.stats[0].splits && pe.stats[0].splits[0] ? pe.stats[0].splits[0].stat : {};
  const obj = { id, name:pe.fullName, hand:(pe.pitchHand&&pe.pitchHand.code)||"R",
                baa:pAvg(st.avg), ip:parseFloat(st.inningsPitched)||0 };
  cache.set(key,obj); return obj;
}
async function getTeamBAA(teamId, season){
  const key="T"+teamId+"_"+season;
  if(cache.has(key)) return cache.get(key);
  let baa=null;
  try{ const d = await getJSON(`${API}/teams/${teamId}/stats?stats=season&group=pitching&season=${season}`);
       baa = pAvg(d.stats[0].splits[0].stat.avg); }catch(e){}
  cache.set(key,baa); return baa;
}
async function getBatters(side, lineups, teamId, season, confirmedOnly){
  const arr = lineups && lineups[side+"Players"] ? lineups[side+"Players"] : [];
  if(arr.length){
    return arr.map((p,i)=>({ id:p.id, name:p.fullName, order:i+1, projected:false }));
  }
  if(confirmedOnly) return [];
  const d = await getJSON(`${API}/teams/${teamId}/roster?rosterType=active`);
  return d.roster
    .filter(r => r.position && r.position.abbreviation!=="P" && r.position.type!=="Pitcher")
    .map(r => ({ id:r.person.id, name:r.person.fullName, order:null, projected:true }));
}
async function getBatterStats(id, season){
  const key="B"+id+"_"+season;
  if(cache.has(key)) return cache.get(key);
  const d = await getJSON(`${API}/people/${id}/stats?stats=season,lastXGames,statSplits&group=hitting&sitCodes=vl,vr&limit=5&season=${season}`);
  const out={seasonBA:null, seasonAB:0, seasonPA:0, seasonR:0, seasonRBI:0,
             last5BA:null, vL:null, vLab:0, vR:null, vRab:0};
  for(const s of d.stats){
    const t=s.type.displayName;
    if(t==="season" && s.splits[0]){
      const st=s.splits[0].stat;
      out.seasonBA=pAvg(st.avg);
      out.seasonAB=parseInt(st.atBats)||0;
      out.seasonPA=parseInt(st.plateAppearances)||0;
      out.seasonR=parseInt(st.runs)||0;
      out.seasonRBI=parseInt(st.rbi)||0;
    }
    else if(t==="lastXGames" && s.splits[0]){ out.last5BA=pAvg(s.splits[0].stat.avg); }
    else if(t==="statSplits"){
      for(const sp of s.splits){
        const desc=(sp.split.description||"").toLowerCase();
        if(desc.includes("left")){ out.vL=pAvg(sp.stat.avg); out.vLab=parseInt(sp.stat.atBats)||0; }
        if(desc.includes("right")){ out.vR=pAvg(sp.stat.avg); out.vRab=parseInt(sp.stat.atBats)||0; }
      }
    }
  }
  cache.set(key,out); return out;
}
async function getVsStarter(batId, pitId){
  if(!pitId) return {ab:0,avg:null};
  const key="V"+batId+"_"+pitId;
  if(cache.has(key)) return cache.get(key);
  let res={ab:0,avg:null};
  try{
    const d = await getJSON(`${API}/people/${batId}/stats?stats=vsPlayerTotal&group=hitting&opposingPlayerId=${pitId}`);
    const sp = d.stats[0] && d.stats[0].splits[0];
    if(sp){ res={ab:parseInt(sp.stat.atBats)||0, avg:pAvg(sp.stat.avg)}; }
  }catch(e){}
  cache.set(key,res); return res;
}

async function getWeather(homeAbbr, gameDate){
  const v = VENUE[homeAbbr];
  if(!v) return { tempF:null, dome:false, missing:true };
  if(v.dome) return { tempF:null, dome:true };
  const date = gameDate.slice(0,10);
  const key="W"+homeAbbr+date;
  if(cache.has(key)) return cache.get(key);
  let tempF=null;
  try{
    const url=`${WX}?latitude=${v.lat}&longitude=${v.lon}&hourly=temperature_2m&temperature_unit=fahrenheit&start_date=${date}&end_date=${date}&timezone=auto`;
    const d=await getJSON(url);
    const arr=d.hourly && d.hourly.temperature_2m;
    if(arr && arr.length){
      const slice=arr.slice(18,22).filter(x=>x!=null);
      if(slice.length) tempF = slice.reduce((a,b)=>a+b,0)/slice.length;
    }
  }catch(e){}
  const res={tempF, dome:false};
  cache.set(key,res); return res;
}
function weatherMult(w){
  if(!w || w.dome || w.tempF==null) return 1.0;
  return clamp(1 + (w.tempF-70)/1500, 0.97, 1.03);
}

async function getPitcherFatigue(pid, gameDate, season){
  if(!pid) return {rest:null,lastPitches:null};
  const key="F"+pid+gameDate.slice(0,10);
  if(cache.has(key)) return cache.get(key);
  let res={rest:null, lastPitches:null};
  try{
    const d=await getJSON(`${API}/people/${pid}/stats?stats=gameLog&group=pitching&season=${season}`);
    const splits=(d.stats[0]&&d.stats[0].splits)||[];
    const gd=new Date(gameDate.slice(0,10)+"T00:00:00Z");
    let last=null;
    for(const s of splits){
      const sd=new Date(s.date+"T00:00:00Z");
      if(sd<gd && (!last||sd>new Date(last.date+"T00:00:00Z"))) last=s;
    }
    if(last){
      const diff=Math.round((gd-new Date(last.date+"T00:00:00Z"))/86400000);
      res={ rest:diff,
            lastPitches: parseInt(last.stat.numberOfPitches)||parseInt(last.stat.pitchesThrown)||null };
    }
  }catch(e){}
  cache.set(key,res); return res;
}
function fatigueMult(f){
  if(!f || f.rest==null) return 1.0;
  let m;
  if(f.rest<=2) m=1.06;
  else if(f.rest===3) m=1.03;
  else if(f.rest<=7) m=1.00;
  else if(f.rest<=14) m=1.01;
  else m=1.02;
  if(f.lastPitches && f.lastPitches>=110 && f.rest<=4) m+=0.02;
  return m;
}

// ----- Tunable model parameters (single source of truth) -----
const PARAMS = {
  hitSplitW: 0.45, hitSeasonW: 0.35, hitLast5W: 0.20,
  vsStarterW: 0.15, vsStarterMinAB: 8,
  spBlendStarter: 0.65, spBlendBullpen: 0.35,
  shrinkSeasonK: 60, shrinkSplitK: 50, shrinkSpK: 100, shrinkRateK: 80,
  envHitsExp: 1.0,   // park*wx*fat exponent for hit rate
  envRateExp: 0.5,   // park*wx*fat exponent for run/RBI rates
  pabClampLo: 0.02, pabClampHi: 0.65,
  rateClampLo: 0.02, rateClampHi: 0.30,
  bClampLo: 0.12, bClampHi: 0.45,
  ppClampLo: 0.15, ppClampHi: 0.45,
  muScale: 0.87,           // tightened from 0.93 after Sep 1-7 2024 backtest (n=854) showed +6.7% μ bias
  overCalibSlope: 0.85,     // Platt-style calibration applied AFTER Poisson Over prob
  overCalibIntercept: -0.03 // shaved further after Sep backtest showed 7pp residual in 50-60% Over 1.5 bin
};

function modelHRR(bstat, vs, starter, bullpenBAA, L, order, parkPF, wxM, fatM){
  const P = PARAMS;
  const seasonAdj = shrink(bstat.seasonAB, bstat.seasonBA, P.shrinkSeasonK, L);
  let splitBA=null, splitAB=0;
  if(starter){ if(starter.hand==="L"){ splitBA=bstat.vL; splitAB=bstat.vLab; } else { splitBA=bstat.vR; splitAB=bstat.vRab; } }
  const splitAdj = shrink(splitAB, splitBA, P.shrinkSplitK, seasonAdj);
  const last5 = bstat.last5BA!=null ? bstat.last5BA : seasonAdj;
  let b = P.hitSplitW*splitAdj + P.hitSeasonW*seasonAdj + P.hitLast5W*last5;
  if(vs.ab>=P.vsStarterMinAB && vs.avg!=null) b = (1-P.vsStarterW)*b + P.vsStarterW*vs.avg;
  b = clamp(b, P.bClampLo, P.bClampHi);

  const starterBAA = starter ? shrink(Math.round(starter.ip*3.1), starter.baa, P.shrinkSpK, L) : L;
  const bull = bullpenBAA!=null ? bullpenBAA : L;
  let pp = starter ? (P.spBlendStarter*starterBAA + P.spBlendBullpen*bull) : bull;
  pp = pp * (fatM||1);
  pp = clamp(pp, P.ppClampLo, P.ppClampHi);

  const num = b*pp/L;
  const den = num + (1-b)*(1-pp)/(1-L);
  let pab = num/den;
  const envH = (parkPF||1) * (wxM||1) * (fatM||1);
  pab = pab * Math.pow(envH, P.envHitsExp);
  pab = clamp(pab, P.pabClampLo, P.pabClampHi);

  const rateR_raw = bstat.seasonPA>0 ? bstat.seasonR/bstat.seasonPA : null;
  const rateI_raw = bstat.seasonPA>0 ? bstat.seasonRBI/bstat.seasonPA : null;
  const rR_base = shrink(bstat.seasonPA, rateR_raw, P.shrinkRateK, LG_RPPA);
  const rI_base = shrink(bstat.seasonPA, rateI_raw, P.shrinkRateK, LG_RBIPA);
  const runM = RUN_MULT[order] || 1.0;
  const rbiM = RBI_MULT[order] || 1.0;
  const envSoft = Math.pow(envH, P.envRateExp);
  let rR = rR_base * runM * envSoft;
  let rI = rI_base * rbiM * envSoft;
  rR = clamp(rR, P.rateClampLo, P.rateClampHi);
  rI = clamp(rI, P.rateClampLo, P.rateClampHi);

  const AB = expAB(order);
  const PA = expPA(order);
  const xH   = AB * pab;
  const xR   = PA * rR;
  const xRBI = PA * rI;
  let mu = (xH + xR + xRBI) * P.muScale;
  return { mu, xH, xR, xRBI, b, pp, pab, rR, rI };
}

async function pool(items, worker, n, abortRef){
  const res=[]; let i=0;
  async function next(){ while(i<items.length && !(abortRef && abortRef.aborted)){ const idx=i++; try{ res[idx]=await worker(items[idx], idx); }catch(e){ res[idx]=null; } } }
  await Promise.all(Array.from({length:n}, next));
  return res;
}

window.HRR = {
  API, WX, cache, PARK, VENUE, RUN_MULT, RBI_MULT, LG_RPPA, LG_RBIPA, PARAMS,
  getJSON, pAvg, shrink, clamp, expAB, expPA, impliedFromAmerican, profitPerStake, fairAmerican, fmtOdds, poissonOver, poissonOverRaw,
  getPitcher, getTeamBAA, getBatters, getBatterStats, getVsStarter, getWeather, weatherMult, getPitcherFatigue, fatigueMult,
  modelHRR, pool
};
})();
