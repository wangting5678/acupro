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
    if (url.pathname === "/api/logout") {
      return json({ ok: true }, 200, { "set-cookie": "sess=; Path=/; Max-Age=0" });
    }

    // everything below requires auth
    if (url.pathname.startsWith("/api/")) {
      if (!(await isAuthed(req, env))) return json({ error: "unauthorized" }, 401);
    }

    if (url.pathname === "/api/meta" && req.method === "GET") {
      const [services, staff, locations] = await Promise.all([
        env.DB.prepare("SELECT id,title,price,duration_min FROM services ORDER BY title").all(),
        env.DB.prepare("SELECT id,name,photo FROM staff ORDER BY name").all(),
        env.DB.prepare("SELECT id,name,abbr FROM locations ORDER BY name").all(),
      ]);
      return json({ services: services.results, staff: staff.results, locations: locations.results });
    }

    if (url.pathname === "/api/appointments" && req.method === "GET") {
      const { results } = await env.DB.prepare(
        `SELECT ca.id, ca.status, ca.notes, ca.customer_id, ca.appointment_id,
                c.full_name, c.email, c.phone,
                a.service_id, a.staff_id, a.location_id, a.start_date, a.end_date,
                s.title AS service, s.price, s.duration_min,
                l.name AS location, l.abbr AS loc_abbr, st.name AS staff, st.photo AS staff_photo
         FROM customer_appointments ca
         JOIN customers c ON c.id = ca.customer_id
         JOIN appointments a ON a.id = ca.appointment_id
         LEFT JOIN services s ON s.id = a.service_id
         LEFT JOIN locations l ON l.id = a.location_id
         LEFT JOIN staff st ON st.id = a.staff_id
         ORDER BY a.start_date DESC LIMIT 500`,
      ).all();
      return json({ appointments: results });
    }

    if (url.pathname === "/api/status" && req.method === "POST") {
      const { id, status } = (await req.json()) as any;
      if (!["pending", "approved", "cancelled", "done"].includes(status)) return json({ error: "bad status" }, 400);
      await env.DB.prepare("UPDATE customer_appointments SET status=?, status_changed_at=datetime('now') WHERE id=?").bind(status, id).run().catch(async () => {
        await env.DB.prepare("UPDATE customer_appointments SET status=? WHERE id=?").bind(status, id).run();
      });
      return json({ ok: true });
    }

    if (url.pathname === "/api/update" && req.method === "POST") {
      const b = (await req.json()) as any;
      const { ca_id, appointment_id, customer_id, start_date, service_id, staff_id, location_id, status, notes, full_name, phone, email } = b;
      // compute end_date from service duration
      let end = start_date;
      if (service_id && start_date) {
        const svc = await env.DB.prepare("SELECT duration_min FROM services WHERE id=?").bind(service_id).first<{ duration_min: number }>();
        const dur = svc?.duration_min ?? 60;
        const t = new Date(start_date.replace(" ", "T") + "Z");
        end = new Date(t.getTime() + dur * 60000).toISOString().slice(0, 19).replace("T", " ");
      }
      await env.DB.prepare(
        "UPDATE appointments SET start_date=?, end_date=?, service_id=?, staff_id=?, location_id=? WHERE id=?",
      ).bind(start_date, end, service_id ?? null, staff_id || null, location_id ?? null, appointment_id).run();
      await env.DB.prepare("UPDATE customer_appointments SET status=?, notes=? WHERE id=?").bind(status, notes ?? "", ca_id).run();
      if (customer_id) {
        await env.DB.prepare("UPDATE customers SET full_name=?, phone=?, email=? WHERE id=?").bind(full_name ?? "", phone ?? "", email ?? "", customer_id).run();
      }
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
  .wrap{max-width:1200px;margin:0 auto;padding:16px}
  .login{max-width:340px;margin:12vh auto;background:#fff;padding:28px;border-radius:16px;box-shadow:0 12px 40px -20px rgba(0,0,0,.3)}
  .login h1{font-size:1.3rem;margin:0 0 4px;color:var(--pine)}
  .login p{color:#777;font-size:.9rem;margin:0 0 18px}
  input,select,textarea{width:100%;font:inherit;padding:11px 12px;border:1px solid var(--line);border-radius:9px;background:#fff}
  .btn{background:var(--pine);color:#fff;border:0;padding:11px 18px;border-radius:9px;font-weight:600;cursor:pointer;font-size:.95rem}
  .btn.ghost{background:#fff;color:var(--pine);border:1px solid var(--line)}
  .btn.danger{background:#fff;color:#b0553a;border:1px solid #e6c4b8}
  .toolbar{display:flex;align-items:center;gap:10px;margin-bottom:14px;flex-wrap:wrap}
  .toolbar .range{font-weight:700;font-size:1.05rem;margin:0 6px}
  .nav-btn{border:1px solid var(--line);background:#fff;border-radius:8px;padding:8px 12px;cursor:pointer;font-weight:600}
  /* weekly grid */
  .week{display:grid;grid-template-columns:repeat(7,1fr);gap:8px;align-items:start}
  .day{background:var(--card);border:1px solid var(--line);border-radius:12px;min-height:120px;padding:8px;position:relative}
  .day.today{border-color:var(--pine);box-shadow:0 0 0 2px rgba(31,77,67,.12)}
  .day h4{margin:0 0 8px;font-size:.8rem;color:#7a7266;text-align:center;font-weight:700}
  .day h4 b{display:block;font-size:1.1rem;color:var(--ink)}
  .chip{background:#f3f7f4;border-left:3px solid var(--pine);border-radius:6px;padding:5px 7px;margin-bottom:6px;font-size:.76rem;cursor:pointer}
  .chip:hover{background:#e7f0ea}
  .chip .t{font-weight:700}
  .chip .n{color:#4a463f;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .chip.s-pending{border-color:var(--gold)}.chip.s-cancelled{border-color:#b0553a;opacity:.6}
  .chip.s-approved{border-color:#256b45}.chip.s-done{border-color:#4a3f7a}
  .empty{color:#bbb;font-size:.75rem;text-align:center;margin-top:20px}
  /* hover popover per day */
  .day .pop{display:none;position:absolute;top:100%;left:0;right:0;z-index:10;background:#fff;border:1px solid var(--line);border-radius:10px;box-shadow:0 16px 40px -18px rgba(0,0,0,.35);padding:10px;max-height:320px;overflow:auto}
  .day:hover .pop{display:block}
  .pop .row{font-size:.8rem;padding:6px 4px;border-bottom:1px dashed var(--line)}
  .pop .row:last-child{border:0}
  .pop .row b{color:var(--pine)}
  .badge{font-size:.68rem;font-weight:700;text-transform:uppercase;padding:2px 7px;border-radius:999px}
  .b-pending{background:#fbf0dd;color:#a9772a}.b-approved{background:#e2f0e6;color:#256b45}.b-cancelled{background:#f6e2dc;color:#b0553a}.b-done{background:#e7e2f0;color:#4a3f7a}
  .cbadge{color:#fff;font-size:.6rem;font-weight:700;padding:1px 5px;border-radius:4px;letter-spacing:.03em;margin-left:4px}
  .av{width:30px;height:30px;border-radius:50%;object-fit:cover;vertical-align:middle;margin-right:6px}
  .av.ph{display:inline-grid;place-items:center;background:var(--pine);color:#fff;font-size:.68rem;font-weight:600}
  .av.big{width:54px;height:54px;margin-right:12px}
  /* modal */
  .modal-bg{display:none;position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:50;align-items:center;justify-content:center;padding:16px}
  .modal-bg.on{display:flex}
  .modal{background:#fff;border-radius:16px;max-width:460px;width:100%;padding:24px;max-height:90vh;overflow:auto}
  .modal h3{margin:0 0 16px;color:var(--pine)}
  .fld{margin-bottom:12px}
  .fld label{display:block;font-size:.8rem;font-weight:600;margin-bottom:4px}
  .grid2{display:grid;grid-template-columns:1fr 1fr;gap:10px}
  .modal-actions{display:flex;gap:8px;justify-content:space-between;margin-top:18px}
  .muted{color:#999;text-align:center;padding:30px}
  @media(max-width:820px){.week{grid-template-columns:1fr;}.day{min-height:auto}.day .pop{position:static;display:block;box-shadow:none;border:0;padding:0;margin-top:4px}}
</style></head><body>
<div id="app"></div>
<script>
const $=s=>document.querySelector(s);
let appts=[],meta={services:[],staff:[],locations:[]},weekStart=monday(new Date());
function monday(d){d=new Date(d);const g=(d.getDay()+6)%7;d.setDate(d.getDate()-g);d.setHours(0,0,0,0);return d}
function ymd(d){return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0')}
function esc(s){return (s==null?'':''+s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]))}
const UK='https://acupro-uk.jinzhiqi19860716.workers.dev';
const CLINIC_COLOR={VCT:'#256b45',CITY:'#b0553a',ONLINE:'#4a3f7a'};
function cbadge(ab){if(!ab)return '';return '<span class="cbadge" style="background:'+(CLINIC_COLOR[ab]||'#7a7266')+'">'+esc(ab)+'</span>'}
function cleanName(n){return (''+(n||'')).replace(/[\\s-]*(vct|ct|city)\\s*$/i,'').trim()||(n||'')}
function initials(n){n=cleanName(n);return n.split(/\\s+/).map(w=>w[0]||'').slice(0,2).join('').toUpperCase()}
function avatar(photo,name,cls){return photo?'<img class="av '+(cls||'')+'" src="'+UK+photo+'" alt="">':'<span class="av ph '+(cls||'')+'">'+initials(name)+'</span>'}
function staffOpt(sel){return meta.staff.map(o=>'<option value="'+o.id+'"'+(String(o.id)===String(sel)?' selected':'')+'>'+esc(cleanName(o.name))+'</option>').join('')}
async function api(p,o){const r=await fetch(p,o);let d={};try{d=await r.json()}catch(e){};return{ok:r.ok,data:d}}

function loginView(msg){
  $('#app').innerHTML='<div class="login"><h1>AcuPro Admin</h1><p>Booking management</p><input id="pw" type="password" placeholder="Password" autofocus><button class="btn" style="width:100%;margin-top:12px" onclick="doLogin()">Sign in</button><div style="color:#b0553a;font-size:.85rem;margin-top:8px">'+(msg||'')+'</div></div>';
  $('#pw').addEventListener('keydown',e=>{if(e.key==='Enter')doLogin()});
}
async function doLogin(){const {ok,data}=await api('/api/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({password:$('#pw').value})});ok?boot():loginView(data.error||'Login failed')}
async function boot(){const m=await api('/api/meta');if(!m.ok)return loginView('');meta=m.data;await load()}
async function load(){const {ok,data}=await api('/api/appointments');if(!ok)return loginView('');appts=data.appointments||[];render()}

function render(){
  const days=[...Array(7)].map((_,i)=>{const d=new Date(weekStart);d.setDate(d.getDate()+i);return d});
  const end=new Date(weekStart);end.setDate(end.getDate()+6);
  const label=weekStart.toLocaleDateString('en-GB',{day:'numeric',month:'short'})+' – '+end.toLocaleDateString('en-GB',{day:'numeric',month:'short',year:'numeric'});
  const todayS=ymd(new Date());
  const cols=days.map(d=>{
    const ds=ymd(d);
    const list=appts.filter(a=>a.start_date&&a.start_date.slice(0,10)===ds).sort((a,b)=>a.start_date.localeCompare(b.start_date));
    const chips=list.map(a=>{
      const tm=a.start_date.slice(11,16);
      return '<div class="chip s-'+a.status+'" onclick=\\'openEdit('+a.id+')\\'><div class="t">'+tm+cbadge(a.loc_abbr)+'</div><div class="n">'+esc(a.full_name)+'</div></div>';
    }).join('')||'<div class="empty">—</div>';
    const pop=list.length?'<div class="pop">'+list.map(a=>'<div class="row">'+avatar(a.staff_photo,a.staff)+'<b>'+a.start_date.slice(11,16)+'</b> '+esc(a.full_name)+' '+cbadge(a.loc_abbr)+' <span class="badge b-'+a.status+'">'+a.status+'</span><br>'+esc(a.service||'')+' · '+esc(cleanName(a.staff)||'Any')+'<br>'+esc(a.phone||'')+'</div>').join('')+'</div>':'';
    return '<div class="day'+(ds===todayS?' today':'')+'"><h4>'+d.toLocaleDateString('en-GB',{weekday:'short'})+'<b>'+d.getDate()+'</b></h4>'+chips+pop+'</div>';
  }).join('');
  $('#app').innerHTML='<header><h1>📅 AcuPro Bookings</h1><button onclick="logout()">Sign out</button></header><div class="wrap">'+
    '<div class="toolbar"><button class="nav-btn" onclick="wk(-7)">← Prev</button><button class="nav-btn" onclick="wkToday()">This week</button><button class="nav-btn" onclick="wk(7)">Next →</button><span class="range">'+label+'</span><span style="flex:1"></span><span style="color:#7a7266;font-size:.85rem">Hover a day for details · click a booking to edit</span></div>'+
    '<div class="week">'+cols+'</div></div>'+modalHtml();
}
function wk(n){weekStart.setDate(weekStart.getDate()+n);render()}
function wkToday(){weekStart=monday(new Date());render()}

function opt(arr,val,label,sel){return arr.map(o=>'<option value="'+o[val]+'"'+(String(o[val])===String(sel)?' selected':'')+'>'+esc(o[label])+'</option>').join('')}
function modalHtml(){return '<div class="modal-bg" id="mbg"><div class="modal" id="mbox"></div></div>'}
function openEdit(id){
  const a=appts.find(x=>x.id===id);if(!a)return;
  const date=a.start_date.slice(0,10),time=a.start_date.slice(11,16);
  const box=$('#mbox');
  box.innerHTML='<h3>Edit booking</h3>'+
    '<div style="display:flex;align-items:center;margin-bottom:16px">'+avatar(a.staff_photo,a.staff,'big')+'<div><div style="font-weight:700;font-size:1.05rem">'+esc(cleanName(a.staff)||'Any practitioner')+'</div><div>'+cbadge(a.loc_abbr)+' <span style="color:#7a7266;font-size:.85rem">'+esc(a.location||'')+'</span></div></div></div>'+
    '<div class="fld"><label>Customer name</label><input id="e_name" value="'+esc(a.full_name)+'"></div>'+
    '<div class="grid2"><div class="fld"><label>Phone</label><input id="e_phone" value="'+esc(a.phone)+'"></div><div class="fld"><label>Email</label><input id="e_email" value="'+esc(a.email)+'"></div></div>'+
    '<div class="grid2"><div class="fld"><label>Date</label><input id="e_date" type="date" value="'+date+'"></div><div class="fld"><label>Time</label><input id="e_time" type="time" value="'+time+'"></div></div>'+
    '<div class="fld"><label>Service</label><select id="e_service">'+opt(meta.services,'id','title',a.service_id)+'</select></div>'+
    '<div class="grid2"><div class="fld"><label>Practitioner</label><select id="e_staff"><option value="">Any</option>'+staffOpt(a.staff_id)+'</select></div>'+
    '<div class="fld"><label>Location</label><select id="e_loc"><option value="">—</option>'+opt(meta.locations,'id','name',a.location_id)+'</select></div></div>'+
    '<div class="fld"><label>Status</label><select id="e_status">'+['pending','approved','cancelled','done'].map(s=>'<option'+(s===a.status?' selected':'')+'>'+s+'</option>').join('')+'</select></div>'+
    '<div class="fld"><label>Notes</label><textarea id="e_notes" rows="2">'+esc(a.notes)+'</textarea></div>'+
    '<div class="modal-actions"><button class="btn danger" onclick="cancelBk('+a.id+')">Cancel booking</button><div style="display:flex;gap:8px"><button class="btn ghost" onclick="closeM()">Close</button><button class="btn" onclick="saveEdit('+a.id+')">Save</button></div></div>';
  $('#mbg').classList.add('on');
}
function closeM(){$('#mbg').classList.remove('on')}
async function saveEdit(id){
  const a=appts.find(x=>x.id===id);
  const body={ca_id:a.id,appointment_id:a.appointment_id,customer_id:a.customer_id,
    start_date:$('#e_date').value+' '+$('#e_time').value+':00',
    service_id:+$('#e_service').value,staff_id:$('#e_staff').value?+$('#e_staff').value:null,
    location_id:$('#e_loc').value?+$('#e_loc').value:null,status:$('#e_status').value,notes:$('#e_notes').value,
    full_name:$('#e_name').value,phone:$('#e_phone').value,email:$('#e_email').value};
  await api('/api/update',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  closeM();load();
}
async function cancelBk(id){const a=appts.find(x=>x.id===id);await api('/api/status',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:a.id,status:'cancelled'})});closeM();load()}
async function logout(){await fetch('/api/logout');loginView('')}
boot();
</script></body></html>`;
