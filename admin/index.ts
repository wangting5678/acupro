/// <reference types="@cloudflare/workers-types" />

export interface Env {
  DB: D1Database;
  ADMIN_PASSWORD: string;
}

const json = (d: unknown, s = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(d), { status: s, headers: { "content-type": "application/json", ...headers } });

async function sessionToken(pw: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(pw + "::acupro-admin-session"));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function getCookie(req: Request, name: string): string | null {
  const m = (req.headers.get("cookie") || "").match(new RegExp("(?:^|; )" + name + "=([^;]+)"));
  return m ? m[1] : null;
}
async function isAuthed(req: Request, env: Env): Promise<boolean> {
  const sess = getCookie(req, "sess");
  return !!sess && sess === (await sessionToken(env.ADMIN_PASSWORD));
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/api/login" && req.method === "POST") {
      const { password } = (await req.json()) as any;
      if (password !== env.ADMIN_PASSWORD) return json({ error: "Wrong password" }, 401);
      const tok = await sessionToken(env.ADMIN_PASSWORD);
      return json({ ok: true }, 200, { "set-cookie": `sess=${tok}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=86400` });
    }
    if (url.pathname === "/api/logout") return json({ ok: true }, 200, { "set-cookie": "sess=; Path=/; Max-Age=0" });

    if (url.pathname.startsWith("/api/") && !(await isAuthed(req, env))) return json({ error: "unauthorized" }, 401);

    if (url.pathname === "/api/meta" && req.method === "GET") {
      const [services, practitioners, locations] = await Promise.all([
        env.DB.prepare("SELECT id,title,price,duration_min FROM services ORDER BY title").all(),
        env.DB.prepare("SELECT id,name,photo,clinics FROM practitioners ORDER BY position").all(),
        env.DB.prepare("SELECT id,name,abbr FROM locations ORDER BY name").all(),
      ]);
      return json({ services: services.results, practitioners: practitioners.results, locations: locations.results });
    }

    if (url.pathname === "/api/appointments" && req.method === "GET") {
      const { results } = await env.DB.prepare(
        `SELECT ca.id, ca.notes, ca.customer_id, ca.appointment_id,
                c.full_name, c.email, c.phone,
                a.service_id, a.staff_id, a.location_id, a.start_date, a.end_date,
                s.title AS service, s.price, s.duration_min,
                l.name AS location, l.abbr AS loc_abbr,
                p.name AS practitioner, p.photo AS practitioner_photo
         FROM customer_appointments ca
         JOIN customers c ON c.id = ca.customer_id
         JOIN appointments a ON a.id = ca.appointment_id
         LEFT JOIN services s ON s.id = a.service_id
         LEFT JOIN locations l ON l.id = a.location_id
         LEFT JOIN practitioners p ON p.id = a.staff_id
         ORDER BY a.start_date LIMIT 1000`,
      ).all();
      return json({ appointments: results });
    }

    // drag-drop: reassign practitioner
    if (url.pathname === "/api/assign" && req.method === "POST") {
      const { appointment_id, staff_id } = (await req.json()) as any;
      await env.DB.prepare("UPDATE appointments SET staff_id=? WHERE id=?").bind(staff_id || null, appointment_id).run();
      return json({ ok: true });
    }

    if (url.pathname === "/api/update" && req.method === "POST") {
      const b = (await req.json()) as any;
      const { ca_id, appointment_id, customer_id, start_date, service_id, staff_id, location_id, notes, full_name, phone, email } = b;
      let end = start_date;
      if (service_id && start_date) {
        const svc = await env.DB.prepare("SELECT duration_min FROM services WHERE id=?").bind(service_id).first<{ duration_min: number }>();
        const t = new Date(start_date.replace(" ", "T") + "Z");
        end = new Date(t.getTime() + (svc?.duration_min ?? 60) * 60000).toISOString().slice(0, 19).replace("T", " ");
      }
      await env.DB.prepare("UPDATE appointments SET start_date=?, end_date=?, service_id=?, staff_id=?, location_id=? WHERE id=?")
        .bind(start_date, end, service_id ?? null, staff_id || null, location_id ?? null, appointment_id).run();
      await env.DB.prepare("UPDATE customer_appointments SET notes=? WHERE id=?").bind(notes ?? "", ca_id).run();
      if (customer_id) await env.DB.prepare("UPDATE customers SET full_name=?, phone=?, email=? WHERE id=?").bind(full_name ?? "", phone ?? "", email ?? "", customer_id).run();
      return json({ ok: true });
    }

    // admin creates a booking (back-fill / 补单 — any date/time allowed)
    if (url.pathname === "/api/create" && req.method === "POST") {
      const b = (await req.json()) as any;
      const { start_date, service_id, staff_id, location_id, notes, full_name, phone, email } = b;
      if (!start_date || !full_name) return json({ error: "missing fields" }, 400);
      let end = start_date;
      if (service_id) {
        const svc = await env.DB.prepare("SELECT duration_min FROM services WHERE id=?").bind(service_id).first<{ duration_min: number }>();
        const t = new Date(start_date.replace(" ", "T") + "Z");
        end = new Date(t.getTime() + (svc?.duration_min ?? 60) * 60000).toISOString().slice(0, 19).replace("T", " ");
      }
      const cust = await env.DB.prepare("INSERT INTO customers(full_name,phone,email) VALUES(?,?,?) RETURNING id").bind(full_name, phone ?? "", email ?? "").first<{ id: number }>();
      const appt = await env.DB.prepare("INSERT INTO appointments(location_id,staff_id,service_id,start_date,end_date) VALUES(?,?,?,?,?) RETURNING id").bind(location_id ?? null, staff_id || null, service_id ?? null, start_date, end).first<{ id: number }>();
      await env.DB.prepare("INSERT INTO customer_appointments(customer_id,appointment_id,notes) VALUES(?,?,?)").bind(cust!.id, appt!.id, notes ?? "").run();
      return json({ ok: true });
    }

    // move a booking: change practitioner AND time (drag-drop)
    if (url.pathname === "/api/move" && req.method === "POST") {
      const { appointment_id, staff_id, start_date } = (await req.json()) as any;
      let end = start_date;
      const a = await env.DB.prepare("SELECT service_id FROM appointments WHERE id=?").bind(appointment_id).first<{ service_id: number }>();
      if (a?.service_id && start_date) {
        const svc = await env.DB.prepare("SELECT duration_min FROM services WHERE id=?").bind(a.service_id).first<{ duration_min: number }>();
        const t = new Date(start_date.replace(" ", "T") + "Z");
        end = new Date(t.getTime() + (svc?.duration_min ?? 60) * 60000).toISOString().slice(0, 19).replace("T", " ");
      }
      await env.DB.prepare("UPDATE appointments SET staff_id=?, start_date=?, end_date=? WHERE id=?").bind(staff_id || null, start_date, end, appointment_id).run();
      return json({ ok: true });
    }

    // ---- practitioner roster CRUD ----
    if (url.pathname === "/api/prac" && req.method === "GET") {
      const { results } = await env.DB.prepare("SELECT id,name,photo,clinics,position FROM practitioners ORDER BY position, id").all();
      return json({ practitioners: results });
    }
    if (url.pathname === "/api/prac_save" && req.method === "POST") {
      const { id, name, clinics, photo } = (await req.json()) as any;
      if (!name) return json({ error: "name required" }, 400);
      if (id) {
        await env.DB.prepare("UPDATE practitioners SET name=?, clinics=?, photo=? WHERE id=?").bind(name, clinics ?? "", photo ?? null, id).run();
        return json({ ok: true, id });
      }
      const mx = await env.DB.prepare("SELECT COALESCE(MAX(id),0)+1 AS nid, COALESCE(MAX(position),0)+1 AS npos FROM practitioners").first<{ nid: number; npos: number }>();
      await env.DB.prepare("INSERT INTO practitioners(id,name,photo,clinics,position) VALUES(?,?,?,?,?)").bind(mx!.nid, name, photo ?? null, clinics ?? "", mx!.npos).run();
      return json({ ok: true, id: mx!.nid });
    }
    if (url.pathname === "/api/prac_delete" && req.method === "POST") {
      const { id } = (await req.json()) as any;
      await env.DB.prepare("UPDATE appointments SET staff_id=NULL WHERE staff_id=?").bind(id).run(); // unassign their bookings
      await env.DB.prepare("DELETE FROM practitioners WHERE id=?").bind(id).run();
      return json({ ok: true });
    }

    // cancel = delete (no status)
    if (url.pathname === "/api/delete" && req.method === "POST") {
      const { ca_id, appointment_id } = (await req.json()) as any;
      await env.DB.prepare("DELETE FROM customer_appointments WHERE id=?").bind(ca_id).run();
      await env.DB.prepare("DELETE FROM appointments WHERE id=?").bind(appointment_id).run();
      return json({ ok: true });
    }

    return new Response(PAGE, { headers: { "content-type": "text/html; charset=utf-8" } });
  },
};

const PAGE = `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>AcuPro Admin · Bookings</title>
<style>
  :root{--pine:#1f4d43;--pine2:#163830;--gold:#c98a3f;--bg:#f4ede2;--ink:#23201c;--line:#e0d6c6;--card:#fff}
  *{box-sizing:border-box}
  body{margin:0;font-family:-apple-system,system-ui,sans-serif;background:var(--bg);color:var(--ink)}
  header{background:var(--pine);color:#fff;padding:14px 20px;display:flex;justify-content:space-between;align-items:center;position:sticky;top:0;z-index:5}
  header h1{font-size:1.05rem;margin:0}
  header button{background:rgba(255,255,255,.15);color:#fff;border:0;padding:8px 14px;border-radius:8px;font-size:.85rem;cursor:pointer}
  .wrap{max-width:100%;margin:0 auto;padding:16px}
  .login{max-width:340px;margin:12vh auto;background:#fff;padding:28px;border-radius:16px;box-shadow:0 12px 40px -20px rgba(0,0,0,.3)}
  .login h1{font-size:1.3rem;margin:0 0 4px;color:var(--pine)}.login p{color:#777;font-size:.9rem;margin:0 0 18px}
  input,select,textarea{width:100%;font:inherit;padding:11px 12px;border:1px solid var(--line);border-radius:9px;background:#fff}
  .btn{background:var(--pine);color:#fff;border:0;padding:10px 16px;border-radius:9px;font-weight:600;cursor:pointer;font-size:.92rem}
  .btn.ghost{background:#fff;color:var(--pine);border:1px solid var(--line)}
  .btn.danger{background:#fff;color:#b0553a;border:1px solid #e6c4b8}
  .toolbar{display:flex;align-items:center;gap:10px;margin-bottom:14px;flex-wrap:wrap}
  .toolbar .range{font-weight:700;font-size:1.05rem;margin:0 6px}
  .nav-btn{border:1px solid var(--line);background:#fff;border-radius:8px;padding:8px 12px;cursor:pointer;font-weight:600}
  .nav-btn.on{background:var(--pine);color:#fff;border-color:var(--pine)}
  .cbadge{color:#fff;font-size:.6rem;font-weight:700;padding:1px 5px;border-radius:4px;letter-spacing:.03em;margin-left:4px}
  .av{width:30px;height:30px;border-radius:50%;object-fit:cover;vertical-align:middle;margin-right:6px}
  .av.ph{display:inline-grid;place-items:center;background:var(--pine);color:#fff;font-size:.68rem;font-weight:600}
  .av.big{width:54px;height:54px;margin-right:12px}
  /* week */
  .week{display:grid;grid-template-columns:repeat(7,1fr);gap:8px}
  .day{background:var(--card);border:1px solid var(--line);border-radius:12px;min-height:110px;padding:8px;cursor:pointer}
  .day.today{border-color:var(--pine);box-shadow:0 0 0 2px rgba(31,77,67,.12)}
  .day:hover{border-color:var(--pine)}
  .day h4{margin:0 0 8px;font-size:.8rem;color:#7a7266;text-align:center;font-weight:700}.day h4 b{display:block;font-size:1.1rem;color:var(--ink)}
  .chip{background:#f3f7f4;border-left:3px solid var(--pine);border-radius:6px;padding:5px 7px;margin-bottom:6px;font-size:.76rem}
  .chip .t{font-weight:700}.chip .n{color:#4a463f;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .empty{color:#bbb;font-size:.75rem;text-align:center;margin-top:16px}
  /* day time-grid */
  .daygrid{display:flex;overflow-x:auto;border:1px solid var(--line);border-radius:12px;background:#fff}
  .col{min-width:150px;flex:1 0 150px;border-right:1px solid var(--line);position:relative}
  .col:last-child{border-right:0}
  .col.gutter{min-width:64px;flex:0 0 64px;background:#faf6ef}
  .colhead{height:56px;display:flex;flex-direction:column;align-items:center;justify-content:center;border-bottom:1px solid var(--line);position:sticky;top:0;background:#fff;z-index:2;font-size:.82rem;font-weight:600;text-align:center;padding:4px}
  .colhead img,.colhead .ph{width:26px;height:26px;border-radius:50%;margin-bottom:2px}
  .colbody{position:relative;height:660px}
  .hourline{position:absolute;left:0;right:0;border-top:1px dashed #eee}
  .gutter .hourlabel{position:absolute;right:6px;font-size:.72rem;color:#999;transform:translateY(-7px)}
  .col.drop-hi{background:#eef5f0}
  .appt{position:absolute;background:#fbe7cf;border-left:3px solid var(--gold);border-radius:6px;padding:4px 6px;font-size:.74rem;cursor:grab;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.08)}
  /* roster */
  .rosterbox{background:#fff;border:1px solid var(--line);border-radius:12px;overflow:hidden}
  .prow{display:flex;align-items:center;gap:12px;padding:10px 14px;border-bottom:1px solid var(--line)}
  .prow:last-child{border-bottom:0}
  .pname{flex:1;max-width:280px}
  .clset{display:flex;gap:6px}
  .clchip{border:1px solid var(--line);background:#fff;color:#7a7266;border-radius:999px;padding:5px 12px;font-size:.78rem;font-weight:700;cursor:pointer}
  .addrow{display:flex;align-items:center;gap:12px;margin-top:14px;background:#fff;border:1px dashed var(--gold);border-radius:12px;padding:12px 14px}
  .addrow input{flex:1;max-width:280px}
  .appt:hover{filter:brightness(.97)}
  .appt .t{font-weight:700}.appt .n{color:#4a463f}
  .appt.dragging{opacity:.4}
  /* unassigned strip */
  .unassigned{background:#fff;border:1px dashed var(--gold);border-radius:10px;padding:8px;margin-bottom:12px;min-height:44px}
  .unassigned h5{margin:0 0 6px;font-size:.75rem;color:#a9772a;text-transform:uppercase;letter-spacing:.05em}
  .uchip{display:inline-block;background:#fbe7cf;border:1px solid #eacb97;border-radius:8px;padding:6px 10px;margin:0 6px 6px 0;font-size:.8rem;cursor:grab}
  /* modal */
  .modal-bg{display:none;position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:50;align-items:center;justify-content:center;padding:16px}
  .modal-bg.on{display:flex}
  .modal{background:#fff;border-radius:16px;max-width:460px;width:100%;padding:24px;max-height:90vh;overflow:auto}
  .modal h3{margin:0 0 16px;color:var(--pine)}
  .fld{margin-bottom:12px}.fld label{display:block;font-size:.8rem;font-weight:600;margin-bottom:4px}
  .grid2{display:grid;grid-template-columns:1fr 1fr;gap:10px}
  .modal-actions{display:flex;gap:8px;justify-content:space-between;margin-top:18px}
</style></head><body>
<div id="app"></div>
<script>
const $=s=>document.querySelector(s);
const UK='https://acupro-uk.jinzhiqi19860716.workers.dev';
const CLINIC_COLOR={VCT:'#256b45',CITY:'#b0553a',ONLINE:'#4a3f7a'};
const START=9,END=20,HPX=60; // 9am-8pm, 60px/hour
let appts=[],meta={services:[],practitioners:[],locations:[]},view='week',cursor=monday(new Date()),dayDate=new Date();
let page='bookings',pracList=[],newClin=new Set();
const CLINIC_ALL=['VCT','CITY','ONLINE'];
function mins(sd){return +sd.slice(11,13)*60 + +sd.slice(14,16)}
function monday(d){d=new Date(d);const g=(d.getDay()+6)%7;d.setDate(d.getDate()-g);d.setHours(0,0,0,0);return d}
function ymd(d){return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0')}
function esc(s){return (s==null?'':''+s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]))}
function initials(n){n=(''+(n||'')).replace(/\\(.*\\)/,'').trim();return n.split(/\\s+/).map(w=>w[0]||'').slice(0,2).join('').toUpperCase()}
function avatar(photo,name,cls){return photo?'<img class="av '+(cls||'')+'" src="'+UK+photo+'" alt="">':'<span class="av ph '+(cls||'')+'">'+initials(name)+'</span>'}
function cbadge(ab){if(!ab)return '';return '<span class="cbadge" style="background:'+(CLINIC_COLOR[ab]||'#7a7266')+'">'+esc(ab)+'</span>'}
async function api(p,o){const r=await fetch(p,o);let d={};try{d=await r.json()}catch(e){};return{ok:r.ok,data:d}}

function loginView(msg){$('#app').innerHTML='<div class="login"><h1>AcuPro Admin</h1><p>Booking management</p><input id="pw" type="password" placeholder="Password" autofocus><button class="btn" style="width:100%;margin-top:12px" onclick="doLogin()">Sign in</button><div style="color:#b0553a;font-size:.85rem;margin-top:8px">'+(msg||'')+'</div></div>';$('#pw').addEventListener('keydown',e=>{if(e.key==='Enter')doLogin()})}
async function doLogin(){const {ok,data}=await api('/api/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({password:$('#pw').value})});ok?boot():loginView(data.error||'Login failed')}
async function boot(){const m=await api('/api/meta');if(!m.ok)return loginView('');meta=m.data;await load()}
async function load(){const {ok,data}=await api('/api/appointments');if(!ok)return loginView('');appts=data.appointments||[];render()}

function navbtn(p,label){return '<button style="background:'+(page===p?'#fff':'rgba(255,255,255,.15)')+';color:'+(page===p?'#1f4d43':'#fff')+';font-weight:600" onclick="'+(p==='roster'?'goRoster':'goBookings')+'()">'+label+'</button>'}
function shell(inner){return '<header><h1>📅 AcuPro</h1><div style="display:flex;gap:8px">'+navbtn('bookings','Bookings')+navbtn('roster','Practitioners')+'</div><button onclick="logout()">Sign out</button></header><div class="wrap">'+inner+'</div>'+modalHtml()}
function render(){if(page==='roster')return renderRoster();view==='day'?renderDay():renderWeek()}
function goBookings(){page='bookings';render()}
function goRoster(){page='roster';loadPrac()}

function renderWeek(){
  const days=[...Array(7)].map((_,i)=>{const d=new Date(cursor);d.setDate(d.getDate()+i);return d});
  const end=new Date(cursor);end.setDate(end.getDate()+6);
  const label=cursor.toLocaleDateString('en-GB',{day:'numeric',month:'short'})+' – '+end.toLocaleDateString('en-GB',{day:'numeric',month:'short',year:'numeric'});
  const todayS=ymd(new Date());
  const cols=days.map(d=>{const ds=ymd(d);
    const list=appts.filter(a=>a.start_date&&a.start_date.slice(0,10)===ds).sort((a,b)=>a.start_date.localeCompare(b.start_date));
    const chips=list.map(a=>'<div class="chip"><div class="t">'+a.start_date.slice(11,16)+cbadge(a.loc_abbr)+'</div><div class="n">'+esc(a.full_name)+'</div></div>').join('')||'<div class="empty">—</div>';
    return '<div class="day'+(ds===todayS?' today':'')+'" onclick=\\'openDay("'+ds+'")\\'><h4>'+d.toLocaleDateString('en-GB',{weekday:'short'})+'<b>'+d.getDate()+'</b></h4>'+chips+'</div>';
  }).join('');
  $('#app').innerHTML=shell('<div class="toolbar"><button class="nav-btn on">Week</button><button class="nav-btn" onclick="toDayView()">Day</button><span style="width:12px"></span><button class="nav-btn" onclick="wk(-7)">←</button><button class="nav-btn" onclick="wkToday()">This week</button><button class="nav-btn" onclick="wk(7)">→</button><span class="range">'+label+'</span><span style="flex:1"></span><button class="btn" onclick="openCreate()">+ New booking</button></div><div class="week">'+cols+'</div>');
}
function wk(n){cursor.setDate(cursor.getDate()+n);render()}
function wkToday(){cursor=monday(new Date());render()}
function openDay(ds){dayDate=new Date(ds+'T00:00:00');view='day';render()}
function toDayView(){dayDate=new Date();view='day';render()}
function toWeek(){view='week';render()}

function renderDay(){
  const ds=ymd(dayDate);
  const label=dayDate.toLocaleDateString('en-GB',{weekday:'long',day:'numeric',month:'short',year:'numeric'});
  const list=appts.filter(a=>a.start_date&&a.start_date.slice(0,10)===ds);
  const cols=meta.practitioners;
  // unassigned
  const un=list.filter(a=>!a.staff_id);
  const unHtml='<div class="unassigned" data-pid="" ondragover="dOver(event)" ondragleave="dLeave(event)" ondrop="dDrop(event,\\'\\')"><h5>Unassigned — drag onto a practitioner</h5>'+
    (un.map(a=>'<span class="uchip" draggable="true" ondragstart="dStart(event,'+a.id+')" ondragend="dEnd(event)" onclick="openEdit('+a.id+')">'+a.start_date.slice(11,16)+' '+esc(a.full_name)+cbadge(a.loc_abbr)+'</span>').join('')||'<span style="color:#bbb;font-size:.8rem">none</span>')+'</div>';
  // gutter
  let gutter='<div class="col gutter"><div class="colhead"></div><div class="colbody">';
  for(let h=START;h<=END;h++){gutter+='<div class="hourlabel" style="top:'+((h-START)*HPX)+'px">'+((h%12)||12)+(h<12?'am':'pm')+'</div>'}
  gutter+='</div></div>';
  const body=cols.map(p=>{
    const items=list.filter(a=>String(a.staff_id)===String(p.id));
    let lines='';for(let h=START;h<=END;h++){lines+='<div class="hourline" style="top:'+((h-START)*HPX)+'px"></div>'}
    const laid=layoutLanes(items);
    const blocks=laid.map(a=>{
      const sm=mins(a.start_date), dur=a.duration_min||60;
      const top=(sm-START*60)/60*HPX, hgt=Math.max(dur/60*HPX-2,24);
      const w=100/a._lanes, left=a._lane*w;
      return '<div class="appt" draggable="true" style="top:'+top+'px;height:'+hgt+'px;left:calc('+left+'% + 2px);width:calc('+w+'% - 4px)" ondragstart="dStart(event,'+a.id+')" ondragend="dEnd(event)" onclick="openEdit('+a.id+')"><div class="t">'+a.start_date.slice(11,16)+cbadge(a.loc_abbr)+'</div><div class="n">'+esc(a.full_name)+'</div></div>';
    }).join('');
    return '<div class="col" data-pid="'+p.id+'" ondragover="dOver(event)" ondragleave="dLeave(event)" ondrop="dDrop(event,'+p.id+')"><div class="colhead">'+avatar(p.photo,p.name)+esc(p.name)+'</div><div class="colbody">'+lines+blocks+'</div></div>';
  }).join('');
  $('#app').innerHTML=shell('<div class="toolbar"><button class="nav-btn" onclick="toWeek()">Week</button><button class="nav-btn on">Day</button><span style="width:12px"></span><button class="nav-btn" onclick="dy(-1)">←</button><button class="nav-btn" onclick="dyToday()">Today</button><button class="nav-btn" onclick="dy(1)">→</button><span class="range">'+label+'</span><span style="flex:1"></span><button class="btn" onclick="openCreate()">+ New booking</button></div>'+unHtml+'<div class="daygrid">'+gutter+body+'</div>');
}
function dy(n){dayDate.setDate(dayDate.getDate()+n);render()}
function dyToday(){dayDate=new Date();render()}

// drag-drop
let dragId=null;
function dStart(e,id){dragId=id;e.target.classList.add('dragging');e.dataTransfer.effectAllowed='move'}
function dEnd(e){e.target.classList.remove('dragging')}
function dOver(e){e.preventDefault();e.currentTarget.classList.add('drop-hi')}
function dLeave(e){e.currentTarget.classList.remove('drop-hi')}
function layoutLanes(items){const arr=items.slice().sort((a,b)=>a.start_date.localeCompare(b.start_date));const laneEnd=[];arr.forEach(a=>{const s=mins(a.start_date),e=s+(a.duration_min||60);let ln=laneEnd.findIndex(x=>x<=s);if(ln<0){ln=laneEnd.length;laneEnd.push(e)}else laneEnd[ln]=e;a._lane=ln});const total=Math.max(laneEnd.length,1);arr.forEach(a=>a._lanes=total);return arr}
async function dDrop(e,pid){e.preventDefault();e.currentTarget.classList.remove('drop-hi');if(dragId==null)return;
  const a=appts.find(x=>x.id===dragId);if(!a){dragId=null;return}
  if(pid===''||pid==null){
    await api('/api/assign',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({appointment_id:a.appointment_id,staff_id:null})});
  }else{
    const bodyEl=e.currentTarget.querySelector('.colbody');const rect=bodyEl.getBoundingClientRect();
    let m=START*60+Math.round(((e.clientY-rect.top)/HPX*60)/15)*15; m=Math.max(START*60,Math.min(m,END*60-15));
    const sd=ymd(dayDate)+' '+String(Math.floor(m/60)).padStart(2,'0')+':'+String(m%60).padStart(2,'0')+':00';
    await api('/api/move',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({appointment_id:a.appointment_id,staff_id:pid,start_date:sd})});
  }
  dragId=null;load();
}

// modal
function opt(arr,val,label,sel){return arr.map(o=>'<option value="'+o[val]+'"'+(String(o[val])===String(sel)?' selected':'')+'>'+esc(o[label])+'</option>').join('')}
function modalHtml(){return '<div class="modal-bg" id="mbg"><div class="modal" id="mbox"></div></div>'}
function openEdit(id){const a=appts.find(x=>x.id===id);if(!a)return;
  const date=a.start_date.slice(0,10),time=a.start_date.slice(11,16);
  $('#mbox').innerHTML='<h3>Edit booking</h3>'+
    '<div class="fld"><label>Customer name</label><input id="e_name" value="'+esc(a.full_name)+'"></div>'+
    '<div class="grid2"><div class="fld"><label>Phone</label><input id="e_phone" value="'+esc(a.phone)+'"></div><div class="fld"><label>Email</label><input id="e_email" value="'+esc(a.email)+'"></div></div>'+
    '<div class="grid2"><div class="fld"><label>Date</label><input id="e_date" type="date" value="'+date+'"></div><div class="fld"><label>Time</label><input id="e_time" type="time" value="'+time+'"></div></div>'+
    '<div class="fld"><label>Service</label><select id="e_service">'+opt(meta.services,'id','title',a.service_id)+'</select></div>'+
    '<div class="grid2"><div class="fld"><label>Practitioner</label><select id="e_staff"><option value="">Unassigned</option>'+opt(meta.practitioners,'id','name',a.staff_id)+'</select></div>'+
    '<div class="fld"><label>Location</label><select id="e_loc"><option value="">—</option>'+opt(meta.locations,'id','name',a.location_id)+'</select></div></div>'+
    '<div class="fld"><label>Notes</label><textarea id="e_notes" rows="2">'+esc(a.notes)+'</textarea></div>'+
    '<div class="modal-actions"><button class="btn danger" onclick="delBk('+a.id+')">Delete booking</button><div style="display:flex;gap:8px"><button class="btn ghost" onclick="closeM()">Close</button><button class="btn" onclick="saveEdit('+a.id+')">Save</button></div></div>';
  $('#mbg').classList.add('on');
}
function closeM(){$('#mbg').classList.remove('on')}
async function saveEdit(id){const a=appts.find(x=>x.id===id);
  await api('/api/update',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({ca_id:a.id,appointment_id:a.appointment_id,customer_id:a.customer_id,start_date:$('#e_date').value+' '+$('#e_time').value+':00',service_id:+$('#e_service').value,staff_id:$('#e_staff').value?+$('#e_staff').value:null,location_id:$('#e_loc').value?+$('#e_loc').value:null,notes:$('#e_notes').value,full_name:$('#e_name').value,phone:$('#e_phone').value,email:$('#e_email').value})});
  closeM();load();
}
async function delBk(id){const a=appts.find(x=>x.id===id);if(!confirm('Delete this booking?'))return;await api('/api/delete',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({ca_id:a.id,appointment_id:a.appointment_id})});closeM();load()}
function openCreate(){const d=view==='day'?ymd(dayDate):ymd(new Date());
  $('#mbox').innerHTML='<h3>New booking</h3>'+
    '<div class="fld"><label>Customer name</label><input id="c_name" placeholder="Full name"></div>'+
    '<div class="grid2"><div class="fld"><label>Phone</label><input id="c_phone"></div><div class="fld"><label>Email</label><input id="c_email"></div></div>'+
    '<div class="grid2"><div class="fld"><label>Date</label><input id="c_date" type="date" value="'+d+'"></div><div class="fld"><label>Time</label><input id="c_time" type="time" value="10:00"></div></div>'+
    '<div class="fld"><label>Service</label><select id="c_service">'+opt(meta.services,'id','title','')+'</select></div>'+
    '<div class="grid2"><div class="fld"><label>Practitioner</label><select id="c_staff"><option value="">Unassigned</option>'+opt(meta.practitioners,'id','name','')+'</select></div>'+
    '<div class="fld"><label>Location</label><select id="c_loc">'+opt(meta.locations,'id','name','')+'</select></div></div>'+
    '<div class="fld"><label>Notes</label><textarea id="c_notes" rows="2"></textarea></div>'+
    '<div class="modal-actions"><span style="color:#999;font-size:.78rem;align-self:center">Back-fill: past times allowed</span><div style="display:flex;gap:8px"><button class="btn ghost" onclick="closeM()">Close</button><button class="btn" onclick="createBk()">Create</button></div></div>';
  $('#mbg').classList.add('on');
}
async function createBk(){const body={start_date:$('#c_date').value+' '+$('#c_time').value+':00',service_id:+$('#c_service').value,staff_id:$('#c_staff').value?+$('#c_staff').value:null,location_id:$('#c_loc').value?+$('#c_loc').value:null,notes:$('#c_notes').value,full_name:$('#c_name').value,phone:$('#c_phone').value,email:$('#c_email').value};
  if(!body.full_name){alert('Enter customer name');return}
  await api('/api/create',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});closeM();load()}
// ---- practitioner roster ----
async function loadPrac(){const {ok,data}=await api('/api/prac');if(!ok)return loginView('');pracList=data.practitioners||[];renderRoster()}
function clchip(ab,on,cb){return '<button class="clchip'+(on?' on':'')+'" style="'+(on?'background:'+CLINIC_COLOR[ab]+';color:#fff;border-color:'+CLINIC_COLOR[ab]:'')+'" onclick="'+cb+'">'+ab+'</button>'}
function renderRoster(){
  const rows=pracList.map(p=>{const set=new Set((p.clinics||'').split(',').map(s=>s.trim()).filter(Boolean));
    const chips=CLINIC_ALL.map(ab=>clchip(ab,set.has(ab),'toggleClinic('+p.id+',\\''+ab+'\\')')).join('');
    return '<div class="prow">'+avatar(p.photo,p.name)+'<input class="pname" value="'+esc(p.name)+'" onchange="renamePrac('+p.id+',this.value)"><div class="clset">'+chips+'</div><button class="btn danger" onclick="delPrac('+p.id+')">Delete</button></div>';
  }).join('');
  const nc=CLINIC_ALL.map(ab=>clchip(ab,newClin.has(ab),'toggleNewClin(\\''+ab+'\\')')).join('');
  $('#app').innerHTML=shell('<h2 style="margin:4px 0 6px;font-size:1.25rem">Practitioners</h2><p style="color:#7a7266;font-size:.85rem;margin:0 0 16px">Click a clinic chip to toggle where a practitioner works. This roster drives the day-view columns and auto-assignment.</p><div class="rosterbox">'+rows+'</div><div class="addrow"><input id="np_name" placeholder="New practitioner name"><div class="clset">'+nc+'</div><button class="btn" onclick="addPrac()">+ Add</button></div>');
}
function toggleNewClin(ab){newClin.has(ab)?newClin.delete(ab):newClin.add(ab);renderRoster()}
async function saveP(p){await api('/api/prac_save',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(p)})}
async function toggleClinic(id,ab){const p=pracList.find(x=>x.id===id);const set=new Set((p.clinics||'').split(',').map(s=>s.trim()).filter(Boolean));set.has(ab)?set.delete(ab):set.add(ab);p.clinics=CLINIC_ALL.filter(a=>set.has(a)).join(',');renderRoster();await saveP({id:p.id,name:p.name,clinics:p.clinics,photo:p.photo})}
async function renamePrac(id,name){const p=pracList.find(x=>x.id===id);p.name=name;await saveP({id:p.id,name:name,clinics:p.clinics,photo:p.photo})}
async function delPrac(id){if(!confirm('Delete this practitioner? Their bookings become Unassigned.'))return;await api('/api/prac_delete',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id})});loadPrac()}
async function addPrac(){const name=$('#np_name').value.trim();if(!name){alert('Enter a name');return}await saveP({name,clinics:CLINIC_ALL.filter(a=>newClin.has(a)).join(',')});newClin=new Set();loadPrac()}
async function logout(){await fetch('/api/logout');loginView('')}
boot();
</script></body></html>`;
