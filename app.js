"use strict";

/* ══════════════════════════════════════════════════════════════════════════
   FIREBASE SETUP  — fill in your project values to enable live sync
   ══════════════════════════════════════════════════════════════════════════
   1. Go to https://console.firebase.google.com → New project (free Spark plan)
   2. Gear icon → Project settings → Your apps → </> (Web) → Register app
   3. Copy the firebaseConfig values from the snippet shown → paste below
   4. Build → Realtime Database → Create database → any region
      → Start in test mode → Enable
   ══════════════════════════════════════════════════════════════════════════ */
const FIREBASE_CONFIG = {
  apiKey:            "AIzaSyAtZSmDfamkVhdoAXLe-D64rRdTesOS5WI",
  authDomain:        "bill-splitter-94c7b.firebaseapp.com",
  databaseURL:       "https://bill-splitter-94c7b-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId:         "bill-splitter-94c7b",
  storageBucket:     "bill-splitter-94c7b.firebasestorage.app",
  messagingSenderId: "520486473260",
  appId:             "1:520486473260:web:5af38fb488885d438d4b89"
};
const FB_READY = !!FIREBASE_CONFIG.databaseURL && (()=>{
  try{ firebase.initializeApp(FIREBASE_CONFIG); return true; }catch{ return false; }
})();

/* ---------------- State ---------------- */
const KEY = "splittrip.v1";
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now()+"-"+Math.random().toString(16).slice(2));
const today = () => new Date().toISOString().slice(0,10);

let state = load() || { people:[], bills:[], settings:{currency:"$"}, payments:[] };
function load(){ try{ return JSON.parse(localStorage.getItem(KEY)); }catch{ return null; } }
if(!state.payments) state.payments = [];
function save(){
  localStorage.setItem(KEY, JSON.stringify(state));
  if(syncRef) syncRef.set(_stateForPush()).catch(()=>{});
}

// Live sync state
let syncId  = null;   // 6-char trip code, null = local only
let syncRef = null;   // Firebase DatabaseReference when connected
let _syncDebounce;

let activeTab = "add";
let draft = freshDraft();
let historyFilter = "all";       // all | unpaid | paid
let settleSelection = null;      // null = auto (all unpaid); else Set of bill ids
let settleFx = { to: null, rates: {}, loading: false, error: false };

function freshDraft(){
  return { id:null, description:"", date:today(), payerId:(state?.people[0]?.id||null),
    mode:"equal", total:"", participants:new Set(), items:[], tax:"", tip:"", currency:state?.settings?.currency||"$", category:"other" };
}

/* ---------------- Money helpers ---------------- */
const cur = () => state.settings.currency || "$";
const ISO = {'$':'USD','€':'EUR','£':'GBP','¥':'JPY','฿':'THB','A$':'AUD','C$':'CAD','S$':'SGD','Rp':'IDR','₩':'KRW'};
const CURRENCIES = ["$","€","£","¥","฿","A$","C$","S$","Rp","₩"];
const CATEGORIES = [
  {id:'food',      label:'Food',        icon:'🍔'},
  {id:'transport', label:'Transport',   icon:'🚌'},
  {id:'stay',      label:'Stay',        icon:'🏨'},
  {id:'fun',       label:'Activities',  icon:'🎟'},
  {id:'shop',      label:'Shopping',    icon:'🛍'},
  {id:'other',     label:'Other',       icon:'📦'},
];
const catIcon  = id => (CATEGORIES.find(c=>c.id===id)||CATEGORIES.at(-1)).icon;
const catLabel = id => (CATEGORIES.find(c=>c.id===id)||CATEGORIES.at(-1)).label;
const toCents = v => Math.round((parseFloat(v)||0)*100);
const money = (c, sym) => (sym||cur()) + (c/100).toLocaleString(undefined,{minimumFractionDigits:2, maximumFractionDigits:2});

function distribute(amount, weights){
  // split integer `amount` cents across weights, summing exactly to amount
  const tot = weights.reduce((a,b)=>a+b,0);
  if(tot<=0){ const each = Math.floor(amount/weights.length)||0; const out = weights.map(()=>each);
    let r = amount-each*weights.length; for(let i=0;i<r;i++) out[i]++; return out; }
  const raw = weights.map(w=> amount*w/tot);
  const out = raw.map(Math.floor);
  let rem = amount - out.reduce((a,b)=>a+b,0);
  const order = raw.map((r,i)=>({i, f:r-Math.floor(r)})).sort((a,b)=>b.f-a.f);
  for(let k=0;k<rem;k++) out[order[k%order.length].i]++;
  return out;
}

/* Compute each participant's share (cents) for a bill. Returns {personId: cents}. */
function computeShares(bill){
  const shares = {};
  if(bill.mode==="equal"){
    const ps = bill.participants;
    if(!ps.length) return shares;
    const parts = distribute(bill.totalCents, ps.map(()=>1));
    ps.forEach((pid,i)=> shares[pid] = parts[i]);
  } else {
    // itemized: each item split among its sharers; tax+tip allocated proportionally to subtotal
    const subtotal = {};
    let subTot = 0;
    for(const it of bill.items){
      const sharers = it.sharedBy.filter(pid=> state.people.some(p=>p.id===pid));
      if(!sharers.length) continue;
      const parts = distribute(it.amountCents, sharers.map(()=>1));
      sharers.forEach((pid,i)=>{ subtotal[pid]=(subtotal[pid]||0)+parts[i]; subTot+=parts[i]; });
    }
    const extra = (bill.taxCents||0)+(bill.tipCents||0);
    const ids = Object.keys(subtotal);
    const extraParts = distribute(extra, ids.map(id=>subtotal[id]));
    ids.forEach((id,i)=> shares[id] = subtotal[id] + extraParts[i]);
  }
  return shares;
}

/* ---------------- Settlement ---------------- */
function settleTx(bal){
  const creditors=[], debtors=[];
  for(const id in bal){
    if(bal[id]>0) creditors.push({id, amt:bal[id]});
    else if(bal[id]<0) debtors.push({id, amt:-bal[id]});
  }
  creditors.sort((a,b)=>b.amt-a.amt); debtors.sort((a,b)=>b.amt-a.amt);
  const tx=[]; let i=0,j=0;
  while(i<debtors.length && j<creditors.length){
    const pay = Math.min(debtors[i].amt, creditors[j].amt);
    if(pay>0) tx.push({from:debtors[i].id, to:creditors[j].id, amt:pay});
    debtors[i].amt-=pay; creditors[j].amt-=pay;
    if(debtors[i].amt===0) i++;
    if(creditors[j].amt===0) j++;
  }
  return tx;
}

// Count the number of raw (person, bill) debts before any simplification.
// Comparing this against displayTx.length shows how many payments were saved.
function naiveDebtCount(bills){
  let n=0;
  for(const b of bills){ const s=computeShares(b); for(const id in s) if(id!==b.payerId) n++; }
  return n;
}
function settle(bills){
  const bal = {}; // cents: positive = is owed money
  state.people.forEach(p=> bal[p.id]=0);
  for(const b of bills){
    bal[b.payerId] = (bal[b.payerId]||0) + b.totalCents;
    const shares = computeShares(b);
    for(const pid in shares){ bal[pid] = (bal[pid]||0) - shares[pid]; }
  }
  return {bal, tx: settleTx({...bal})};
}

function computeBalByCur(bills){
  const out = {};
  state.people.forEach(p=> out[p.id]={});
  for(const b of bills){
    const bc = b.currency||cur();
    out[b.payerId][bc] = (out[b.payerId][bc]||0) + b.totalCents;
    const shares = computeShares(b);
    for(const pid in shares) out[pid][bc] = (out[pid][bc]||0) - shares[pid];
  }
  return out;
}

/* ---------------- People helpers ---------------- */
const personName = id => (state.people.find(p=>p.id===id)?.name) || "—";
const initials = name => name.trim().split(/\s+/).map(w=>w[0]).slice(0,2).join("").toUpperCase();
function avatar(id){ const n=personName(id); return `<span class="ava">${esc(initials(n))}</span>`; }

/* ---------------- Render ---------------- */
const $ = sel => document.querySelector(sel);
const view = $("#view");
const esc = s => String(s).replace(/[&<>"']/g, c=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]));

const TITLES = {
  add:["Add a Bill","Split a new expense with your group"],
  history:["History","Every bill, all in one place"],
  settle:["Settle Up","Who owes whom right now"],
  people:["Group","Manage people & your data"]
};

function render(){
  const [t,s] = TITLES[activeTab];
  $("#h-title").textContent = t; $("#h-sub").textContent = s;
  if(activeTab==="add") renderAdd();
  else if(activeTab==="history") renderHistory();
  else if(activeTab==="settle") renderSettle();
  else { renderPeople(); if(syncId) _renderQR().catch(()=>{}); }
  renderNav();
  window.scrollTo(0,0);
}

function renderNav(){
  const ic = {
    add:'<path fill="currentColor" d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>',
    history:'<rect x="4" y="5" width="16" height="15" rx="2.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M4 9h16M9 13h6M9 16h6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
    settle:'<path d="M7 8h10M7 8l3-3M7 8l3 3M17 16H7M17 16l-3-3M17 16l-3 3" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>',
    people:'<circle cx="9" cy="8" r="3.2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M3.5 19c0-3 2.5-5 5.5-5s5.5 2 5.5 5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><circle cx="17" cy="9" r="2.4" fill="none" stroke="currentColor" stroke-width="2"/><path d="M16 14.5c2.4.2 4.5 2 4.5 4.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>'
  };
  const lbl = {add:"Add", history:"History", settle:"Settle", people:"Group"};
  const unpaid = state.bills.filter(b=>!b.paid).length;
  $("#nav").innerHTML = ["add","history","settle","people"].map(k=>{
    const badge = (k==="settle" && unpaid) ? ` (${unpaid})` : "";
    return `<button data-tab="${k}" class="${activeTab===k?'on':''}">
      <svg viewBox="0 0 24 24">${ic[k]}</svg><span>${lbl[k]}${badge}</span></button>`;
  }).join("");
}

/* ---------- ADD TAB ---------- */
function renderAdd(){
  if(!state.people.length){
    view.innerHTML = emptyState("👋","No people yet","Add the friends on your trip first, then you can start splitting bills.",
      '<button class="btn" data-go="people">Add people</button>');
    bind(); return;
  }
  if(!draft.payerId || !state.people.some(p=>p.id===draft.payerId)) draft.payerId = state.people[0].id;

  const peopleChips = (selectedSet, dataAttr) => state.people.map(p=>
    `<span class="chip ${selectedSet.has(p.id)?'on':''}" data-${dataAttr}="${p.id}">${esc(p.name)}</span>`).join("");

  let body = `
  <div class="card">
    <label class="fld"><span class="lbl">What was it for?</span>
      <input id="f-desc" placeholder="e.g. Dinner at Nobu" value="${esc(draft.description)}"></label>
    <label class="fld"><span class="lbl">Date</span>
      <input id="f-date" type="date" value="${esc(draft.date)}"></label>
  </div>

  <h2 class="section">Category</h2>
  <div class="card"><div class="people-pick">
    ${CATEGORIES.map(c=>`<span class="chip ${(draft.category||'other')===c.id?'on':''}" data-cat="${c.id}">${c.icon} ${c.label}</span>`).join('')}
  </div></div>

  <h2 class="section">Who paid?</h2>
  <div class="card"><div class="people-pick" id="payer-pick">
    ${state.people.map(p=>`<span class="chip ${draft.payerId===p.id?'payer':''}" data-payer="${p.id}">${esc(p.name)}</span>`).join("")}
  </div></div>

  <h2 class="section">How to split</h2>
  <div class="seg" id="mode-seg">
    <button data-mode="equal" class="${draft.mode==='equal'?'on':''}">Split equally</button>
    <button data-mode="items" class="${draft.mode==='items'?'on':''}">By item / receipt</button>
  </div>`;

  const curPicker = `
    <h2 class="section">Currency</h2>
    <div class="card"><div class="people-pick">
      ${CURRENCIES.map(s=>`<span class="chip ${(draft.currency||cur())===s?'on':''}" data-billcur="${esc(s)}">${esc(s)}</span>`).join("")}
    </div></div>`;

  if(draft.mode==="equal"){
    body += curPicker + `
    <div class="card">
      <label class="fld"><span class="lbl">Total amount (${esc(draft.currency||cur())})</span>
        <input id="f-total" inputmode="decimal" placeholder="0.00" value="${esc(draft.total)}"></label>
    </div>
    <h2 class="section">Split between</h2>
    <div class="hint">Tap everyone who shares this bill. <button class="linkbtn" data-all="1">Select all</button></div>
    <div class="card"><div class="people-pick" id="part-pick">
      ${peopleChips(draft.participants,"part")}
    </div></div>`;
  } else {
    body += curPicker + `
    <div class="hint">Add each line item and tap who shares it — or scan a receipt to fill them in.</div>
    <div class="card" style="padding:6px 0">
      <div class="people-pick" style="padding-top:10px;padding-bottom:4px">
        <button class="btn sec sm" data-scan="1">📷 Scan receipt</button>
        <button class="btn sec sm" data-additem="1">＋ Add item</button>
      </div>
      <div id="items-list">${renderItems()}</div>
    </div>
    <div class="card">
      <label class="fld"><span class="lbl">Tax (${esc(draft.currency||cur())}) — split by item total</span>
        <input id="f-tax" inputmode="decimal" placeholder="0.00" value="${esc(draft.tax)}"></label>
      <label class="fld"><span class="lbl">Tip (${esc(draft.currency||cur())}) — split by item total</span>
        <input id="f-tip" inputmode="decimal" placeholder="0.00" value="${esc(draft.tip)}"></label>
    </div>`;
  }

  body += `<div class="card"><div class="split-preview" id="preview"></div></div>
    <button class="btn" data-save="1" style="margin-top:4px">${draft.id?'Save changes':'Add bill'}</button>
    ${draft.id?'<button class="btn danger" data-canceledit="1" style="margin-top:8px">Cancel edit</button>':''}`;

  view.innerHTML = body;
  bindAdd();
  updatePreview();
}

function renderItems(){
  if(!draft.items.length) return `<div class="hint" style="padding:14px 16px">No items yet. Tap＋ or scan a receipt.</div>`;
  return draft.items.map((it,idx)=>{
    const allOn = state.people.length>0 && it.sharedBy.length===state.people.length;
    return `
    <div class="item-row">
      <div class="nm">
        <input class="inp" data-itemname="${idx}" placeholder="Item name" value="${esc(it.name)}" style="margin-bottom:6px">
        <div class="item-people">
          <span class="mini-chip ${allOn?'on':''}" data-itemall="${idx}" style="font-weight:700">All</span>
          ${state.people.map(p=>`<span class="mini-chip ${it.sharedBy.includes(p.id)?'on':''}" data-itemshare="${idx}:${p.id}">${esc(p.name)}</span>`).join("")}
        </div>
      </div>
      <div style="width:84px; flex-shrink:0">
        <input class="inp" data-itemamt="${idx}" inputmode="decimal" placeholder="0.00" value="${esc(it.amount)}" style="text-align:right">
      </div>
      <button class="del-x" data-delitem="${idx}">×</button>
    </div>`;
  }).join("");
}

function buildBillFromDraft(){
  const b = { id:draft.id||uid(), description:draft.description.trim()||"Untitled",
    date:draft.date||today(), payerId:draft.payerId, mode:draft.mode, paid:false,
    currency:draft.currency||cur(), category:draft.category||'other', createdAt:Date.now() };
  if(draft.mode==="equal"){
    b.participants = [...draft.participants];
    b.totalCents = toCents(draft.total);
  } else {
    b.items = draft.items.map(it=>({name:it.name.trim()||"Item", amountCents:toCents(it.amount), sharedBy:[...it.sharedBy]}));
    b.taxCents = toCents(draft.tax); b.tipCents = toCents(draft.tip);
    b.totalCents = b.items.reduce((a,it)=>a+it.amountCents,0) + b.taxCents + b.tipCents;
    b.participants = [...new Set(b.items.flatMap(it=>it.sharedBy))];
  }
  return b;
}

function updatePreview(){
  const pv = $("#preview"); if(!pv) return;
  const b = buildBillFromDraft();
  const shares = computeShares(b);
  const ids = Object.keys(shares);
  const dc = draft.currency||cur();
  if(!b.totalCents || !ids.length){
    pv.innerHTML = `<div class="muted small">${draft.mode==='items'?'Assign people to items to see the split.':'Pick people and an amount to see the split.'}</div>`; return;
  }
  let rows = `<div class="pr"><b>Total</b><b>${money(b.totalCents,dc)}</b></div>`;
  if(draft.mode==='items'){
    rows += ids.map(id=>{
      const myItems = (b.items||[]).filter(it=>it.sharedBy.includes(id)&&it.amountCents>0);
      const names = myItems.map(it=>esc(it.name||'Item')).join(' · ');
      return `<div class="pr" style="flex-direction:column;align-items:stretch;gap:1px;padding:4px 0">
        <div style="display:flex;justify-content:space-between"><span>${esc(personName(id))}</span><b>${money(shares[id],dc)}</b></div>
        ${names?`<div class="muted small" style="font-size:12px">${names}</div>`:''}
      </div>`;
    }).join("");
  } else {
    rows += ids.map(id=>`<div class="pr"><span>${esc(personName(id))}</span><span>${money(shares[id],dc)}</span></div>`).join("");
  }
  pv.innerHTML = rows;
}

/* ---------- HISTORY TAB ---------- */
function renderHistory(){
  if(!state.bills.length){
    view.innerHTML = emptyState("🧾","No bills yet","Bills you add will appear here in a tidy table. Mark them paid or unpaid as you settle up.",
      '<button class="btn" data-go="add">Add your first bill</button>'); bind(); return;
  }
  const bills = [...state.bills].sort((a,b)=> (b.date||"").localeCompare(a.date||"") || b.createdAt-a.createdAt);
  const shown = bills.filter(b=> historyFilter==="all" ? true : historyFilter==="paid" ? b.paid : !b.paid);
  const unpaidBills = bills.filter(b=>!b.paid);
  const unpaidByCur = unpaidBills.reduce((m,b)=>{ const s=b.currency||cur(); m[s]=(m[s]||0)+b.totalCents; return m; },{});
  const unpaidTotalStr = Object.entries(unpaidByCur).map(([s,c])=>money(c,s)).join(' + ') || money(0);

  view.innerHTML = `
    <div class="filter-bar">
      ${["all","unpaid","paid"].map(f=>`<button data-filter="${f}" class="${historyFilter===f?'on':''}">${f[0].toUpperCase()+f.slice(1)}</button>`).join("")}
    </div>
    <div class="card scroller">
      <table class="bills">
        <thead><tr><th>Date</th><th>Bill</th><th>Paid by</th><th class="r">Total</th><th>Status</th></tr></thead>
        <tbody>
        ${shown.map(b=>`
          <tr data-open="${b.id}">
            <td class="muted">${esc((b.date||"").slice(5))}</td>
            <td>${catIcon(b.category)} ${esc(b.description)}<div class="muted" style="font-size:12px">${b.participants.length} ${b.participants.length===1?'person':'people'} · ${b.mode==='items'?'itemized':'equal'}</div></td>
            <td>${esc(personName(b.payerId).split(' ')[0])}</td>
            <td class="r amt">${money(b.totalCents, b.currency)}</td>
            <td><span class="tag ${b.paid?'paid':'unpaid'}" data-toggle="${b.id}">${b.paid?'Paid':'Unpaid'}</span></td>
          </tr>`).join("")}
        </tbody>
      </table>
    </div>
    <div class="hint">Tap a status to flip it · tap a row for details. Unpaid total: <b>${unpaidTotalStr}</b></div>
    <div id="detail"></div>`;
  bind();
}

function renderDetail(billId){
  const b = state.bills.find(x=>x.id===billId); if(!b) return;
  const shares = computeShares(b);
  const det = $("#detail");
  const bc = b.currency||cur();
  let lines = "";
  if(b.mode==="items"){
    lines = b.items.map(it=>`<div class="pr"><span>${esc(it.name)} <span class="muted">(${it.sharedBy.map(id=>personName(id).split(' ')[0]).join(', ')})</span></span><span>${money(it.amountCents,bc)}</span></div>`).join("");
    if(b.taxCents) lines+=`<div class="pr muted"><span>Tax</span><span>${money(b.taxCents,bc)}</span></div>`;
    if(b.tipCents) lines+=`<div class="pr muted"><span>Tip</span><span>${money(b.tipCents,bc)}</span></div>`;
  }
  det.innerHTML = `
    <h2 class="section">${esc(b.description)}</h2>
    <div class="card"><div class="split-preview">
      ${lines}
      ${lines?'<div style="height:8px"></div>':''}
      <div class="pr"><b>Each person owes ${personName(b.payerId).split(' ')[0]}</b><span></span></div>
      ${Object.keys(shares).map(id=> id===b.payerId?'':`<div class="pr"><span>${esc(personName(id))}</span><b>${money(shares[id],bc)}</b></div>`).join("")}
    </div></div>
    <div class="row card" style="gap:10px">
      <button class="btn sec sm" data-edit="${b.id}">Edit</button>
      <button class="btn sm" data-toggle2="${b.id}">${b.paid?'Mark unpaid':'Mark paid'}</button>
      <button class="btn danger sm" data-delbill="${b.id}">Delete</button>
    </div>`;
  bind();
  det.scrollIntoView({behavior:"smooth", block:"nearest"});
}

/* ---------- SETTLE TAB ---------- */
function renderSettle(){
  const unpaid = state.bills.filter(b=>!b.paid);
  if(state.people.length<2){
    view.innerHTML = emptyState("👥","Add more people","You need at least two people in the group to settle up.",
      '<button class="btn" data-go="people">Manage group</button>'); bind(); return;
  }
  if(!unpaid.length){
    view.innerHTML = emptyState("✅","All settled!","There are no unpaid bills right now. Mark bills as unpaid in History to include them here.",
      '<button class="btn sec" data-go="history">View history</button>'); bind(); return;
  }
  const {bal, tx} = settle(unpaid);
  const totUnpaid = unpaid.reduce((a,b)=>a+b.totalCents,0);

  // Determine the display currency for this settle view
  const billCurs = [...new Set(unpaid.map(b=>b.currency||cur()))];
  const settleCur = billCurs.length===1 ? billCurs[0] : cur();
  const mixedCurs = billCurs.length > 1;

  // Per-currency per-person balances (for breakdown and conversion)
  const bbc = computeBalByCur(unpaid);

  // When all bill currencies have rates loaded, recompute bal+tx in target currency
  const hasAllRates = mixedCurs && !!settleFx.to && billCurs.every(s => settleFx.rates[s] != null);
  let displayBal = bal, displayCur = settleCur;
  if(hasAllRates){
    const convBal = {};
    state.people.forEach(p => {
      convBal[p.id] = 0;
      for(const [sym, cents] of Object.entries(bbc[p.id]||{}))
        convBal[p.id] += Math.round(cents * settleFx.rates[sym]);
    });
    displayBal = convBal;
    displayCur = settleFx.to;
  }

  // Apply recorded payments (in displayCur) on top of the computed balance
  for(const p of state.payments){
    if(p.currency===displayCur && p.from in displayBal && p.to in displayBal){
      displayBal[p.from] += p.amtCents;
      displayBal[p.to]   -= p.amtCents;
    }
  }
  let displayTx = settleTx({...displayBal});

  // Amount formatter
  const fm = (cents) => {
    if(settleFx.to){
      if(hasAllRates)
        return settleFx.to + (cents/100).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2});
      if(!mixedCurs && settleFx.rates[settleCur] != null){
        const v = (cents/100)*settleFx.rates[settleCur];
        return settleFx.to + v.toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2});
      }
    }
    return money(cents, displayCur);
  };

  // Build currency converter card
  const otherCurs = CURRENCIES.filter(s=>s!==settleCur);
  let rateLines = '';
  if(settleFx.to && !settleFx.loading && !settleFx.error){
    if(mixedCurs){
      rateLines = billCurs.filter(s=>settleFx.rates[s]!=null).map(s=>
        `<div class="fx-rate">1 ${ISO[s]||s} = ${settleFx.rates[s].toLocaleString(undefined,{minimumFractionDigits:4,maximumFractionDigits:4})} ${ISO[settleFx.to]||settleFx.to}&nbsp;&nbsp;<span class="muted small">· Frankfurter · ECB</span></div>`
      ).join('');
    } else if(settleFx.rates[settleCur]!=null){
      rateLines = `<div class="fx-rate">1 ${ISO[settleCur]||settleCur} = ${settleFx.rates[settleCur].toLocaleString(undefined,{minimumFractionDigits:4,maximumFractionDigits:4})} ${ISO[settleFx.to]||settleFx.to}&nbsp;&nbsp;<span class="muted small">· Frankfurter · ECB reference rate</span></div>`;
    }
  }
  const fxCard = `
    <h2 class="section">Currency converter</h2>
    <div class="card">
      <div class="people-pick" id="fx-pick">
        <span class="chip ${!settleFx.to?'on':''}" data-fx="">${esc(settleCur)} <span style="opacity:.7;font-size:13px">base</span></span>
        ${otherCurs.map(s=>`<span class="chip ${settleFx.to===s?'on':''}" data-fx="${esc(s)}">${esc(s)}</span>`).join("")}
      </div>
      ${settleFx.loading?`<div class="hint" style="padding-bottom:12px">Fetching live rates…</div>`:''}
      ${settleFx.error?`<div class="hint" style="color:var(--red);padding-bottom:12px">Could not fetch rates — check your connection.</div>`:''}
      ${rateLines}
    </div>`;

  const mixedBanner = mixedCurs && !hasAllRates ? `<div class="hint" style="color:var(--red);margin-top:4px">⚠️ Bills are in multiple currencies (${billCurs.join(', ')}) — select a target currency below to see totals converted to a single currency.</div>` : '';

  // Per-currency breakdown section (shown when mixed + at least one rate loaded)
  let breakdownSection = '';
  if(mixedCurs && settleFx.to && !settleFx.loading){
    const rows = state.people.map(p=>{
      const entries = Object.entries(bbc[p.id]||{}).filter(([,c])=>c!==0);
      if(!entries.length) return '';
      const lines = entries.map(([sym,cents])=>{
        const rate = settleFx.rates[sym];
        const isPos = cents > 0;
        const label = isPos ? 'gets back' : 'owes';
        if(rate!=null){
          const converted = Math.abs(Math.round(cents*rate));
          return `<div class="hint" style="padding:2px 0 2px 32px">${label} ${money(Math.abs(cents),sym)} × ${rate.toLocaleString(undefined,{minimumFractionDigits:4,maximumFractionDigits:4})} = ${settleFx.to}${(converted/100).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</div>`;
        }
        return `<div class="hint" style="padding:2px 0 2px 32px">${label} ${money(Math.abs(cents),sym)} <span style="opacity:.6">(rate unavailable)</span></div>`;
      }).join('');
      const totalLine = entries.length>1 && hasAllRates
        ? `<div style="padding:4px 0 0 32px;font-weight:600">= ${money(Math.abs(displayBal[p.id]),settleFx.to)} total</div>` : '';
      return `<div class="row" style="flex-direction:column;align-items:flex-start;padding:12px 16px;gap:2px">
        <div style="font-weight:600">${avatar(p.id)} ${esc(personName(p.id))}</div>
        ${lines}${totalLine}
      </div>`;
    }).filter(Boolean).join('');
    if(rows) breakdownSection = `<h2 class="section">Currency breakdown</h2><div class="card">${rows}</div>`;
  }

  // Debt simplification savings
  const naive = naiveDebtCount(unpaid);
  const saved = naive - displayTx.length;

  // Spending by category
  const catTotals = {};
  for(const b of unpaid){ const k=b.category||'other'; catTotals[k]=(catTotals[k]||0)+b.totalCents; }
  const catEntries = CATEGORIES.filter(c=>catTotals[c.id]);
  const maxCat = catEntries.reduce((m,c)=>Math.max(m,catTotals[c.id]),0);
  const catSection = catEntries.length<2 ? '' : `
    <h2 class="section">Spending by category</h2>
    <div class="card">
      ${catEntries.sort((a,b)=>catTotals[b.id]-catTotals[a.id]).map(c=>`
      <div class="cat-row">
        <span class="cat-lbl">${c.icon} ${c.label}</span>
        <div class="cat-track"><div class="cat-fill" style="width:${Math.round(catTotals[c.id]/maxCat*100)}%"></div></div>
        <span class="cat-amt">${money(catTotals[c.id],settleCur)}</span>
      </div>`).join('')}
    </div>`;

  view.innerHTML = `
    <div class="card"><div class="split-preview">
      <div class="pr"><b>${unpaid.length} unpaid bill${unpaid.length>1?'s':''}</b><b>${money(totUnpaid, settleCur)}</b></div>
      <div class="pr"><span>Payments needed</span><b>${displayTx.length}${saved>0?` <span style="font-size:12px;font-weight:400;color:var(--green)">↓${saved} saved</span>`:''}</b></div>
    </div></div>

    ${mixedBanner}
    ${fxCard}
    ${breakdownSection}
    ${catSection}

    <h2 class="section">Who pays whom</h2>
    <div class="card">
      ${displayTx.length? displayTx.map(t=>{
        const debtor = state.people.find(p=>p.id===t.from);
        const waBtn = debtor?.phone ? (()=>{
          const phone = debtor.phone.replace(/\D/g,'');
          const fromFirst = esc(personName(t.from).split(' ')[0]);
          const toFirst   = esc(personName(t.to).split(' ')[0]);
          const msg = encodeURIComponent(`Hi ${fromFirst}! You owe ${toFirst} ${fm(t.amt)} — please pay when you can 🙏`);
          return `<a class="wa-btn" href="https://wa.me/${phone}?text=${msg}" target="_blank" rel="noopener" title="Send WhatsApp reminder"><svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/></svg></a>`;
        })() : '';
        const payBtn = `<button class="btn sec sm" data-recordpmt="${t.from}|${t.to}|${t.amt}|${esc(displayCur)}" title="Record this payment as done" style="flex-shrink:0;padding:6px 12px;font-size:13px">✓ Paid</button>`;
        return `<div class="settle-row">
          <div class="who">${avatar(t.from)}<span>${esc(personName(t.from).split(' ')[0])}</span>
            <span class="arrow">→</span>${avatar(t.to)}<span>${esc(personName(t.to).split(' ')[0])}</span></div>
          <div class="amt">${fm(t.amt)}</div>${payBtn}${waBtn}
        </div>`;
      }).join("")
        : `<div class="hint" style="padding:16px">Everyone's even — no payments needed.</div>`}
    </div>

    <h2 class="section">Net balance</h2>
    <div class="card">
      ${state.people.filter(p=>displayBal[p.id]).map(p=>`
        <div class="row">
          <div class="grow">${esc(p.name)}</div>
          <div class="amt ${displayBal[p.id]>0?'bal-pos':'bal-neg'}">
            ${displayBal[p.id]>0? 'gets back '+fm(displayBal[p.id]) : 'owes '+fm(-displayBal[p.id])}</div>
        </div>`).join("") || '<div class="hint" style="padding:16px">Everyone is even.</div>'}
    </div>

    ${(()=>{
      const pmts = state.payments.filter(p=>p.currency===displayCur);
      if(!pmts.length) return '';
      return `<h2 class="section">Recorded payments</h2>
      <div class="card">
        ${pmts.map(p=>`
          <div class="settle-row">
            <div class="who">${avatar(p.from)}<span>${esc(personName(p.from).split(' ')[0])}</span>
              <span class="arrow">→</span>${avatar(p.to)}<span>${esc(personName(p.to).split(' ')[0])}</span></div>
            <div class="amt bal-pos">${money(p.amtCents,p.currency)}</div>
            <span class="muted small" style="flex-shrink:0">${p.date.slice(5)}</span>
            <button class="del-x" data-delpmt="${p.id}" title="Undo payment">×</button>
          </div>`).join('')}
      </div>`;
    })()}

    <button class="btn" data-settleall="1">Mark these ${unpaid.length} bill${unpaid.length>1?'s':''} as paid</button>
    <div class="hint">This settles every currently-unpaid bill at once. You can flip any back in History.</div>`;
  bind();
}

/* ---------- PEOPLE / DATA TAB ---------- */
function renderPeople(){
  view.innerHTML = `
    <h2 class="section">People on this trip</h2>
    <div class="card">
      ${state.people.length? state.people.map(p=>`
        <div class="row" style="align-items:flex-start;padding:12px 16px;">
          <div class="grow" style="padding-top:2px">${avatar(p.id)} &nbsp;${esc(p.name)}
            <input class="phone-input" type="tel" placeholder="WhatsApp number (+65…)"
              value="${esc(p.phone||'')}" data-setphone="${p.id}">
          </div>
          <button class="del-x" style="margin-top:2px" data-delperson="${p.id}">×</button></div>`).join("")
        : '<div class="hint" style="padding:16px">No one added yet.</div>'}
      <div class="row">
        <input class="inp" id="new-person" placeholder="Add a name" enterkeyhint="done">
        <button class="btn sm" data-addperson="1">Add</button>
      </div>
    </div>

    <h2 class="section">Default currency</h2>
    <div class="card">
      <div class="hint" style="padding:10px 16px 2px">New bills will use this currency by default.</div>
      <div class="people-pick" style="padding-bottom:10px">
        ${CURRENCIES.map(s=>`<span class="chip ${cur()===s?'on':''}" data-cur="${esc(s)}">${esc(s)}</span>`).join("")}
      </div>
    </div>

    <h2 class="section">Live sync${syncId?` &nbsp;<span class="sync-dot"></span>`:''}</h2>
    ${FB_READY ? (syncId ? `
    <div class="card" style="text-align:center;padding:20px 16px 16px">
      <div class="muted small">Connected · changes sync to everyone in real time</div>
      <div class="trip-code">${esc(syncId)}</div>
      <div id="qr-box"></div>
      <div class="muted small" style="margin-bottom:14px">Scan or share the code above to join</div>
      <div style="display:flex;gap:8px;justify-content:center">
        <button class="btn sm" data-copylink="1">Copy link</button>
        <button class="btn danger sm" data-leavetrip="1">Leave trip</button>
      </div>
      <div style="border-top:.5px solid var(--sep);margin-top:12px;padding-top:12px">
        <div class="muted small" style="margin-bottom:8px">Owner actions</div>
        <button class="btn danger sm" data-deletetrip="1" style="width:100%">Delete trip for everyone</button>
      </div>
    </div>` : `
    <div class="card">
      <div class="row"><div class="grow"><div>Start a shared trip</div><div class="muted small">Real-time sync — everyone sees bill changes instantly</div></div>
        <button class="btn sm" data-createtrip="1">Create</button></div>
      <div style="border-top:.5px solid var(--sep);padding:12px 16px 8px">
        <div class="muted small" style="margin-bottom:8px">Already have a trip code?</div>
        <div style="display:flex;gap:8px">
          <input class="inp" id="join-code" placeholder="ABC123" maxlength="6" autocomplete="off" autocapitalize="characters">
          <button class="btn sm" data-jointrip="1">Join</button>
        </div>
      </div>
    </div>`) : `
    <div class="card"><div class="hint" style="padding:16px;color:var(--red)">
      ⚠️ Firebase not configured. Open index.html and fill in the FIREBASE_CONFIG block near the top of the &lt;script&gt; tag.
    </div></div>`}

    <h2 class="section">Your data</h2>
    <div class="card">
      <div class="row"><div class="grow"><div>Backup / export</div><div class="muted small">Save a JSON file of all bills</div></div>
        <button class="btn sec sm" data-export="1">Export</button></div>
      <div class="row"><div class="grow"><div>Restore / import</div><div class="muted small">Load a previously exported file</div></div>
        <button class="btn sec sm" data-import="1">Import</button></div>
      <div class="row"><div class="grow"><div>Reset everything</div><div class="muted small">Delete all people & bills</div></div>
        <button class="btn danger sm" data-reset="1">Reset</button></div>
    </div>
    <div class="hint">Everything is stored only on this device, in this browser. Export regularly so you don't lose data if you clear Safari.</div>`;
  bind();
}

/* ---------------- Shared empty state ---------------- */
function emptyState(emoji,title,text,action){
  return `<div class="empty"><div class="big">${emoji}</div>
    <div style="font-size:19px;font-weight:600;color:var(--text)">${title}</div>
    <div style="margin:8px 0 20px;max-width:300px;display:inline-block">${text}</div>
    <div>${action||''}</div></div>`;
}

/* ---------------- Event binding ---------------- */
function bind(){
  view.querySelectorAll("[data-go]").forEach(el=> el.onclick=()=>{activeTab=el.dataset.go; render();});
  // history
  view.querySelectorAll("[data-filter]").forEach(el=> el.onclick=()=>{historyFilter=el.dataset.filter; render();});
  view.querySelectorAll("[data-toggle]").forEach(el=> el.onclick=e=>{e.stopPropagation(); togglePaid(el.dataset.toggle);});
  view.querySelectorAll("[data-open]").forEach(el=> el.onclick=()=> renderDetail(el.dataset.open));
  view.querySelectorAll("[data-toggle2]").forEach(el=> el.onclick=()=>{ togglePaid(el.dataset.toggle2); });
  view.querySelectorAll("[data-edit]").forEach(el=> el.onclick=()=> startEdit(el.dataset.edit));
  view.querySelectorAll("[data-delbill]").forEach(el=> el.onclick=()=> delBill(el.dataset.delbill));
  // settle
  const sa = view.querySelector("[data-settleall]"); if(sa) sa.onclick=settleAll;
  view.querySelectorAll("[data-recordpmt]").forEach(el=> el.onclick=()=>{
    const [from,to,amt,currency]=el.dataset.recordpmt.split('|');
    state.payments.push({id:uid(),from,to,amtCents:+amt,currency,date:today()});
    save(); renderSettle(); toast("Payment recorded ✓");
  });
  view.querySelectorAll("[data-delpmt]").forEach(el=> el.onclick=()=>{
    state.payments=state.payments.filter(p=>p.id!==el.dataset.delpmt);
    save(); renderSettle();
  });
  view.querySelectorAll("[data-fx]").forEach(el=> el.onclick=()=>{
    const sym = el.dataset.fx;
    if(!sym){ settleFx={to:null,rates:{},loading:false,error:false}; renderSettle(); return; }
    if(settleFx.to===sym && !settleFx.loading && (Object.keys(settleFx.rates).length>0||settleFx.error)) return; // already loaded
    settleFx={to:sym,rates:{},loading:true,error:false};
    renderSettle();
    const unpaidNow=state.bills.filter(b=>!b.paid);
    const curs=[...new Set(unpaidNow.map(b=>b.currency||cur()))];
    Promise.all(curs.map(c=>fetchFx(c,sym).then(rate=>({c,rate})))).then(results=>{
      if(settleFx.to!==sym) return; // user changed mid-flight
      const rates={};
      let hasError=false;
      results.forEach(({c,rate})=>{ if(rate!=null) rates[c]=rate; else hasError=true; });
      settleFx={to:sym,rates,loading:false,error:hasError};
      renderSettle();
    });
  });
  // people
  const ap = view.querySelector("[data-addperson]"); if(ap) ap.onclick=addPerson;
  const np = view.querySelector("#new-person"); if(np) np.onkeydown=e=>{ if(e.key==="Enter") addPerson(); };
  view.querySelectorAll("[data-delperson]").forEach(el=> el.onclick=()=> delPerson(el.dataset.delperson));
  view.querySelectorAll("[data-setphone]").forEach(el=> el.onchange=()=>{
    const p=state.people.find(x=>x.id===el.dataset.setphone); if(p){ p.phone=el.value.trim(); save(); }
  });
  view.querySelectorAll("[data-cur]").forEach(el=> el.onclick=()=>{ state.settings.currency=el.dataset.cur; save(); render(); });
  const ct=view.querySelector("[data-createtrip]"); if(ct) ct.onclick=createTrip;
  const lt=view.querySelector("[data-leavetrip]"); if(lt) lt.onclick=leaveTrip;
  const dt=view.querySelector("[data-deletetrip]"); if(dt) dt.onclick=deleteTrip;
  const cl=view.querySelector("[data-copylink]"); if(cl) cl.onclick=copyTripLink;
  const jt=view.querySelector("[data-jointrip]"); if(jt) jt.onclick=()=>joinTrip(view.querySelector("#join-code")?.value||"");
  const jc=view.querySelector("#join-code"); if(jc){
    jc.onkeydown=e=>{ if(e.key==="Enter") joinTrip(jc.value); };
    jc.oninput=e=>{ e.target.value=e.target.value.toUpperCase().replace(/[^A-Z0-9]/g,""); };
  }
  const ex=view.querySelector("[data-export]"); if(ex) ex.onclick=exportData;
  const im=view.querySelector("[data-import]"); if(im) im.onclick=importData;
  const rs=view.querySelector("[data-reset]"); if(rs) rs.onclick=resetAll;
}

function bindAdd(){
  bind();
  const on=(sel,ev,fn)=>{ const el=view.querySelector(sel); if(el) el.addEventListener(ev,fn); };
  on("#f-desc","input",e=>draft.description=e.target.value);
  on("#f-date","input",e=>draft.date=e.target.value);
  on("#f-total","input",e=>{draft.total=e.target.value; updatePreview();});
  on("#f-tax","input",e=>{draft.tax=e.target.value; updatePreview();});
  on("#f-tip","input",e=>{draft.tip=e.target.value; updatePreview();});

  view.querySelectorAll("[data-cat]").forEach(el=> el.onclick=()=>{
    draft.category=el.dataset.cat;
    view.querySelectorAll("[data-cat]").forEach(e=>e.classList.toggle("on",e.dataset.cat===el.dataset.cat));
  });
  view.querySelectorAll("[data-billcur]").forEach(el=> el.onclick=()=>{ draft.currency=el.dataset.billcur; renderAdd(); });
  view.querySelectorAll("[data-payer]").forEach(el=> el.onclick=()=>{ draft.payerId=el.dataset.payer; renderAdd(); });
  view.querySelectorAll("[data-mode]").forEach(el=> el.onclick=()=>{ draft.mode=el.dataset.mode; renderAdd(); });
  view.querySelectorAll("[data-part]").forEach(el=> el.onclick=()=>{
    const id=el.dataset.part; draft.participants.has(id)?draft.participants.delete(id):draft.participants.add(id);
    el.classList.toggle("on"); updatePreview();
  });
  const all=view.querySelector("[data-all]"); if(all) all.onclick=()=>{
    if(draft.participants.size===state.people.length) draft.participants.clear();
    else state.people.forEach(p=>draft.participants.add(p.id));
    renderAdd();
  };
  const add=view.querySelector("[data-additem]"); if(add) add.onclick=()=>{
    draft.items.push({name:"", amount:"", sharedBy:[]}); renderAdd();
  };
  view.querySelectorAll("[data-itemall]").forEach(el=> el.onclick=()=>{
    const idx=+el.dataset.itemall; const it=draft.items[idx];
    it.sharedBy = it.sharedBy.length===state.people.length ? [] : state.people.map(p=>p.id);
    renderAdd();
  });
  const scan=view.querySelector("[data-scan]"); if(scan) scan.onclick=startScan;
  view.querySelectorAll("[data-itemname]").forEach(el=> el.addEventListener("input",e=>draft.items[+el.dataset.itemname].name=e.target.value));
  view.querySelectorAll("[data-itemamt]").forEach(el=> el.addEventListener("input",e=>{draft.items[+el.dataset.itemamt].amount=e.target.value; updatePreview();}));
  view.querySelectorAll("[data-itemshare]").forEach(el=> el.onclick=()=>{
    const [i,pid]=el.dataset.itemshare.split(":"); const arr=draft.items[+i].sharedBy;
    const k=arr.indexOf(pid); k>=0?arr.splice(k,1):arr.push(pid); el.classList.toggle("on"); updatePreview();
  });
  view.querySelectorAll("[data-delitem]").forEach(el=> el.onclick=()=>{ draft.items.splice(+el.dataset.delitem,1); renderAdd(); });
  const sv=view.querySelector("[data-save]"); if(sv) sv.onclick=saveBill;
  const ce=view.querySelector("[data-canceledit]"); if(ce) ce.onclick=()=>{ draft=freshDraft(); renderAdd(); };
}

/* ---------------- Actions ---------------- */
function saveBill(){
  if(!draft.payerId){ toast("Pick who paid"); return; }
  const b = buildBillFromDraft();
  if(b.mode==="equal"){
    if(!b.participants.length){ toast("Pick who to split with"); return; }
    if(!b.totalCents){ toast("Enter an amount"); return; }
  } else {
    if(!b.items.length){ toast("Add at least one item"); return; }
    if(!b.participants.length){ toast("Tap who shares each item"); return; }
    if(!b.totalCents){ toast("Items add up to zero"); return; }
  }
  if(draft.id){
    const i=state.bills.findIndex(x=>x.id===draft.id);
    b.paid = state.bills[i].paid; b.createdAt = state.bills[i].createdAt;
    state.bills[i]=b; toast("Bill updated");
  } else { state.bills.push(b); toast("Bill added ✓"); }
  save(); draft=freshDraft(); activeTab="history"; render();
}

function startEdit(id){
  const b=state.bills.find(x=>x.id===id); if(!b) return;
  draft={ id:b.id, description:b.description, date:b.date, payerId:b.payerId, mode:b.mode,
    currency:b.currency||cur(), category:b.category||'other',
    total:b.mode==="equal"?(b.totalCents/100).toString():"",
    participants:new Set(b.mode==="equal"?b.participants:[]),
    items:b.mode==="items"?b.items.map(it=>({name:it.name, amount:(it.amountCents/100).toString(), sharedBy:[...it.sharedBy]})):[],
    tax:b.taxCents?(b.taxCents/100).toString():"", tip:b.tipCents?(b.tipCents/100).toString():"" };
  activeTab="add"; render();
}

function delBill(id){ if(!confirm("Delete this bill?")) return; state.bills=state.bills.filter(b=>b.id!==id); save(); render(); toast("Deleted"); }
function togglePaid(id){ const b=state.bills.find(x=>x.id===id); if(!b) return; b.paid=!b.paid; save(); render(); }
function settleAll(){ if(!confirm("Mark all unpaid bills as paid?")) return; state.bills.forEach(b=>b.paid=true); save(); render(); toast("All settled ✓"); }

function addPerson(){
  const inp=$("#new-person"); const name=(inp.value||"").trim(); if(!name) return;
  if(state.people.some(p=>p.name.toLowerCase()===name.toLowerCase())){ toast("Already added"); return; }
  state.people.push({id:uid(), name}); save();
  if(!draft.payerId) draft.payerId=state.people[0].id;
  renderPeople(); $("#new-person").focus();
}
function delPerson(id){
  const used = state.bills.some(b=> b.payerId===id || b.participants.includes(id));
  if(used && !confirm("This person is in saved bills. Remove anyway? Their existing bills stay as-is.")) return;
  if(!used && !confirm("Remove this person?")) return;
  state.people=state.people.filter(p=>p.id!==id); save(); render();
}
function resetAll(){ if(!confirm("Delete ALL people and bills? This cannot be undone.")) return;
  // Reset only ever wipes THIS device. If we're in a shared trip, leave it first so
  // we never push an empty state to the DB and clear it for everyone in the group.
  if(syncRef && !confirm("You're in a shared trip. Reset will leave the trip and clear this device only — the group's data stays in the cloud. Continue?")) return;
  _disconnectSync();
  state={people:[],bills:[],settings:{currency:cur()},payments:[]}; save(); draft=freshDraft(); activeTab="people"; render(); }

function exportData(){
  const blob=new Blob([JSON.stringify(state,null,2)],{type:"application/json"});
  const url=URL.createObjectURL(blob); const a=document.createElement("a");
  a.href=url; a.download="splittrip-backup-"+today()+".json"; a.click(); URL.revokeObjectURL(url);
}
function importData(){
  const f=document.createElement("input"); f.type="file"; f.accept="application/json,.json";
  f.onchange=()=>{ const file=f.files[0]; if(!file) return; const r=new FileReader();
    r.onload=()=>{ try{ const d=JSON.parse(r.result);
      if(!d.people||!d.bills) throw 0;
      d.bills.forEach(b=>{ if(b.participants) b.participants=[...b.participants]; });
      state=d; if(!state.settings) state.settings={currency:"$"}; save(); render(); toast("Imported ✓");
    }catch{ toast("Couldn't read that file"); } };
    r.readAsText(file); };
  f.click();
}

/* ── Live sync (Firebase Realtime Database) ──────────────────────────────── */
function _stateForPush(){ return JSON.parse(JSON.stringify(state)); }
// Order-independent stringify — Firebase returns object keys re-sorted, so a
// plain JSON.stringify comparison would flag our own writes as remote changes.
function _stableStr(v){
  if(Array.isArray(v)) return "["+v.map(_stableStr).join(",")+"]";
  if(v && typeof v==="object")
    return "{"+Object.keys(v).sort().map(k=>JSON.stringify(k)+":"+_stableStr(v[k])).join(",")+"}";
  return JSON.stringify(v===undefined?null:v);
}
// Firebase strips empty arrays/objects and may return arrays as keyed objects.
// Coerce incoming data back into the shape render()/settle() expect.
function _normalizeState(s){
  s = (s && typeof s==="object") ? s : {};
  const arr = x => Array.isArray(x) ? x : (x && typeof x==="object" ? Object.values(x) : []);
  s.people   = arr(s.people);
  s.payments = arr(s.payments);
  s.bills  = arr(s.bills).map(b=>{
    if(b && typeof b==="object"){
      if("participants" in b) b.participants = arr(b.participants);
      if("items" in b) b.items = arr(b.items).map(it=>{ if(it && "sharedBy" in it) it.sharedBy = arr(it.sharedBy); return it; });
    }
    return b;
  });
  if(!s.settings || typeof s.settings!=="object") s.settings = { currency:"$" };
  if(!s.settings.currency) s.settings.currency = "$";
  return s;
}
function _genCode(){
  const c='ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I,O,0,1
  let s=''; for(let i=0;i<6;i++) s+=c[Math.floor(Math.random()*c.length)]; return s;
}
async function createTrip(){
  if(!FB_READY){ toast("Configure Firebase first — see code comments"); return; }
  const code=_genCode();
  try{
    await firebase.database().ref('trips/'+code).set(_stateForPush());
    await _doJoin(code);
  }catch(e){ console.error(e); toast("Couldn't create trip — check Firebase config"); }
}
async function joinTrip(code){
  if(!FB_READY){ toast("Configure Firebase first"); return; }
  code=(code||"").trim().toUpperCase();
  if(code.length!==6){ toast("Enter the 6-character trip code"); return; }
  try{
    const snap=await firebase.database().ref('trips/'+code).once('value');
    if(!snap.exists()){ toast('Trip "'+code+'" not found'); return; }
    const hasLocal=state.people.length||state.bills.length;
    const ok=!hasLocal||confirm("Joining will replace the local bills on this device. Continue?");
    if(!ok) return;
    await _doJoin(code);
  }catch(e){ console.error(e); toast("Couldn't join — check your connection"); }
}
async function _doJoin(code){
  if(syncRef) syncRef.off();
  syncRef=firebase.database().ref('trips/'+code);
  const snap=await syncRef.once('value');
  state=_normalizeState(snap.val()||state);
  localStorage.setItem(KEY,JSON.stringify(state));
  draft=freshDraft(); syncId=code;
  localStorage.setItem(KEY+'.sync',code);
  syncRef.on('value',snap=>{
    const d=snap.val(); if(!d) return;
    clearTimeout(_syncDebounce);
    _syncDebounce=setTimeout(()=>{
      const incoming=_normalizeState(d);
      if(_stableStr(incoming)===_stableStr(state)) return;  // our own echo / no real change
      if(activeTab==='add'&&(draft.description||draft.items.length||draft.total)) return; // don't clobber an active edit
      state=incoming;
      localStorage.setItem(KEY,JSON.stringify(state));
      render(); toast("Trip updated");
    },300);
  });
  history.replaceState(null,'',location.pathname+'#join='+code);
  render(); toast('Connected to trip '+code+' ✓');
}
// Detach from the shared trip without ever writing to it. Clears the listener,
// the in-memory refs and the saved code so nothing downstream can push to the DB.
function _disconnectSync(){
  if(syncRef){ syncRef.off(); syncRef=null; }
  syncId=null;
  clearTimeout(_syncDebounce);
  localStorage.removeItem(KEY+'.sync');
  history.replaceState(null,'',location.pathname);
}
function leaveTrip(){
  if(!confirm("Leave this shared trip? You'll stop syncing with the group.")) return;
  // Disconnect FIRST so anything below only ever touches this device, never the DB.
  _disconnectSync();
  // The group's bills/people were copied onto this device when we joined. Offer a
  // clean slate so they don't linger here or bleed into a trip you create next.
  if(confirm("Clear this trip's bills and people from this device too?\n\nOK — start fresh (recommended)\nCancel — keep a local copy")){
    state = { people:[], bills:[], settings:{ currency:cur() }, payments:[] };
    save();                 // syncRef is null now → writes localStorage only
    draft = freshDraft();
    activeTab = "people";
  }
  render(); toast("Left trip");
}
async function deleteTrip(){
  if(!confirm("Delete this trip for EVERYONE?\n\nThis permanently removes all bills and people from the cloud. Other members will lose access immediately.\n\nThis cannot be undone.")) return;
  const code=syncId;   // capture before disconnect clears it
  _disconnectSync();   // detach listener first — no further writes from this device
  // Clear this device's local state
  state={people:[],bills:[],settings:{currency:cur()},payments:[]};
  save(); draft=freshDraft(); activeTab="people";
  try{
    await firebase.database().ref('trips/'+code).remove();
    toast("Trip deleted for everyone ✓");
  }catch(e){
    console.error(e);
    toast("Deleted locally — couldn't reach Firebase. Check your connection.");
  }
  render();
}
async function copyTripLink(){
  const url=location.origin+location.pathname+'#join='+syncId;
  try{
    if(navigator.share){ await navigator.share({title:"SplitTrip",text:"Join our trip on SplitTrip!",url}); return; }
    await navigator.clipboard.writeText(url); toast("Link copied ✓");
  }catch(e){ if(e?.name==="AbortError") return; prompt("Share this link:",url); }
}
/* ── Theme toggle ── */
const _MOON = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z"/></svg>`;
const _SUN  = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>`;
function _isDark(){
  const ov=document.documentElement.dataset.theme;
  return ov==='dark'||(!ov&&window.matchMedia('(prefers-color-scheme:dark)').matches);
}
function _updateThemeIcon(){
  const btn=document.getElementById('theme-toggle'); if(!btn) return;
  const dark=_isDark();
  btn.innerHTML=dark?_SUN:_MOON;
  btn.setAttribute('aria-label',dark?'Switch to light mode':'Switch to dark mode');
}
function toggleTheme(){
  const next=_isDark()?'light':'dark';
  document.documentElement.dataset.theme=next;
  localStorage.setItem(KEY+'.theme',next);
  _updateThemeIcon();
}
async function _renderQR(){
  const box=document.getElementById('qr-box'); if(!box||!syncId) return;
  if(!window.QRCode)
    await loadScript('https://cdn.jsdelivr.net/npm/qrcodejs@1.0.0/qrcode.min.js');
  box.innerHTML='';
  new QRCode(box,{text:location.origin+location.pathname+'#join='+syncId,
    width:180,height:180,colorDark:'#000000',colorLight:'#ffffff',correctLevel:QRCode.CorrectLevel.M});
}
async function _resumeSync(){
  const saved=localStorage.getItem(KEY+'.sync');
  const m=!saved && location.hash.match(/^#join=([A-Z0-9]{6})$/i);
  if(saved) await joinTrip(saved).catch(()=>{});
  else if(m) await joinTrip(m[1]).catch(()=>{});
}

/* ---------------- OCR ---------------- */
const fileInput = $("#file");
function startScan(){ fileInput.value=""; fileInput.click(); }
fileInput.onchange = async () => {
  const file = fileInput.files[0]; if(!file) return;
  $("#ocr").classList.add("show"); $("#ocr-status").textContent="Loading OCR engine";
  try{
    if(!window.Tesseract){
      await loadScript("https://cdn.jsdelivr.net/npm/tesseract.js@5.0.5/dist/tesseract.min.js");
    }
    $("#ocr-status").textContent="Reading text…";
    const {data:{text}} = await Tesseract.recognize(file,"eng",{
      logger:m=>{ if(m.status==="recognizing text") $("#ocr-status").textContent="Reading text… "+Math.round(m.progress*100)+"%"; }
    });
    const {items, tax, tip} = parseReceipt(text);
    if(!items.length){ toast("No items detected — add them manually"); }
    else {
      draft.items.push(...items.map(it=>({name:it.name, amount:it.amount.toFixed(2), sharedBy:state.people.map(p=>p.id)})));
      if(tax && !draft.tax) draft.tax=tax.toFixed(2);
      if(tip && !draft.tip) draft.tip=tip.toFixed(2);
      toast(items.length+" item"+(items.length>1?"s":"")+" added — check & assign people");
    }
    renderAdd();
  }catch(err){ console.error(err); toast("OCR failed — check your connection"); }
  finally{ $("#ocr").classList.remove("show"); }
};

function parseReceipt(text){
  const lines=text.split("\n"); const items=[]; let tax=0, tip=0;
  for(const raw of lines){
    const line=raw.replace(/\s+/g," ").trim(); if(!line) continue;
    const m=line.match(/(\d{1,4}[.,]\d{2})\s*$/); if(!m) continue;
    const amount=parseFloat(m[1].replace(",",".")); if(!isFinite(amount)||amount<=0) continue;
    let name=line.slice(0,m.index).replace(/[*x×#@:\-_. ]+$/i,"").replace(/^\d+\s*[xX]\s*/,"").trim();
    const low=(name+" "+line).toLowerCase();
    if(/sub\s*total|^total|amount\s*due|balance|change\b|cash|visa|master|debit|credit|tender|account/i.test(low)) continue;
    if(/\btax|gst|vat|hst|pst\b/i.test(low)){ tax+=amount; continue; }
    if(/tip|gratuity|service charge/i.test(low)){ tip+=amount; continue; }
    if(!name || name.length<2) name="Item";
    if(name.length>40) name=name.slice(0,40);
    items.push({name, amount});
  }
  return {items, tax, tip};
}

/* ---------------- FX rate fetch ---------------- */
async function fetchFx(fromSym, toSym){
  const from=ISO[fromSym], to=ISO[toSym];
  if(!from||!to) return null;
  if(from===to) return 1;
  try{
    // Frankfurter — ECB official daily reference rates, no API key required
    const r = await fetch(`https://api.frankfurter.dev/v1/latest?from=${from}&to=${to}`);
    if(!r.ok) throw 0;
    const d = await r.json();
    return d.rates?.[to] ?? null;
  }catch{ return null; }
}

function loadScript(src){ return new Promise((res,rej)=>{ const s=document.createElement("script");
  s.src=src; s.onload=res; s.onerror=()=>rej(new Error("load")); document.head.appendChild(s); }); }

/* ---------------- Toast ---------------- */
let toastT;
function toast(msg){ const t=$("#toast"); t.textContent=msg; t.classList.add("show");
  clearTimeout(toastT); toastT=setTimeout(()=>t.classList.remove("show"),2200); }

/* ---------------- Nav ---------------- */
$("#nav").addEventListener("click", e=>{ const b=e.target.closest("[data-tab]"); if(!b) return;
  if(activeTab==="add" && draft.id && b.dataset.tab!=="add"){ draft=freshDraft(); }
  activeTab=b.dataset.tab; render(); });

/* ---------------- Service worker (offline, only when hosted) ---------------- */
if("serviceWorker" in navigator && location.protocol==="https:"){
  navigator.serviceWorker.register("sw.js").catch(()=>{});
}

(async()=>{ if(FB_READY) await _resumeSync(); render(); _updateThemeIcon(); })();
