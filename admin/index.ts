/// <reference types="@cloudflare/workers-types" />

export interface Env {
  DB: D1Database;
  ADMIN_PASSWORD: string;
}

const json = (d: unknown, s = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(d), { status: s, headers: { "content-type": "application/json", ...headers } });

async function sessionToken(pw: string): Promise<string> {
  const data = new TextEncoder().encode(pw + "::acupro-admin-session");
  const buf = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function getCookie(req: Request, name: string): string | null {
  const c = req.headers.get("cookie") || "";
  const m = c.match(new RegExp("(?:^|; )" + name + "=([^;]+)"));
  return m ? m[1] : null;
}
async function isAuthed(req: Request, env: Env): Promise<boolean> {
  const sess = getCookie(req, "sess");
  if (!sess) return false;
  return sess === (await sessionToken(env.ADMIN_PASSWORD));
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/api/login" && req.method === "POST") {
      const { password } = (await req.json()) as any;
      if (password !== env.ADMIN_PASSWORD) return json({ error: "Wrong password" }, 401);
      const tok = await sessionToken(env.ADMIN_PASSWORD);
      return json({ ok: true }, 200, {
        "set-cookie": `sess=${tok}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=86400`,
      });
    }

    if (url.pathname === "/api/logout") {
      return json({ ok: true }, 200, { "set-cookie": "sess=; Path=/; Max-Age=0" });
    }

    if (url.pathname === "/api/appointments" && req.method === "GET") {
      if (!(await isAuthed(req, env))) return json({ error: "unauthorized" }, 401);
      const { results } = await env.DB.prepare(
        `SELECT ca.id, ca.status, ca.notes, c.full_name, c.email, c.phone,
                s.title AS service, s.price, a.start_date, a.end_date,
                l.name AS location, st.name AS staff, ca.created_at
         FROM customer_appointments ca
         JOIN customers c ON c.id = ca.customer_id
         JOIN appointments a ON a.id = ca.appointment_id
         LEFT JOIN services s ON s.id = a.service_id
         LEFT JOIN locations l ON l.id = a.location_id
         LEFT JOIN staff st ON st.id = a.staff_id
         ORDER BY a.start_date DESC LIMIT 200`,
      ).all();
      return json({ appointments: results });
    }

    if (url.pathname === "/api/status" && req.method === "POST") {
      if (!(await isAuthed(req, env))) return json({ error: "unauthorized" }, 401);
      const { id, status } = (await req.json()) as any;
      if (!["pending", "approved", "cancelled", "done"].includes(status)) return json({ error: "bad status" }, 400);
      await env.DB.prepare("UPDATE customer_appointments SET status=? WHERE id=?").bind(status, id).run();
      return json({ ok: true });
    }

    return new Response(PAGE, { headers: { "content-type": "text/html; charset=utf-8" } });
  },
};

const PAGE = `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>AcuPro Admin · Bookings</title>
<style>
  :root{--pine:#1f4d43;--gold:#c98a3f;--bg:#f4ede2;--ink:#23201c;--line:#e0d6c6;}
  *{box-sizing:border-box}
  body{margin:0;font-family:-apple-system,system-ui,sans-serif;background:var(--bg);color:var(--ink)}
  header{background:var(--pine);color:#fff;padding:16px 20px;display:flex;justify-content:space-between;align-items:center;position:sticky;top:0}
  header h1{font-size:1.1rem;margin:0}
  header button{background:rgba(255,255,255,.15);color:#fff;border:0;padding:8px 14px;border-radius:8px;font-size:.85rem}
  .wrap{max-width:900px;margin:0 auto;padding:16px}
  .login{max-width:340px;margin:12vh auto;background:#fff;padding:28px;border-radius:16px;box-shadow:0 12px 40px -20px rgba(0,0,0,.3)}
  .login h1{font-size:1.3rem;margin:0 0 4px;color:var(--pine)}
  .login p{color:#777;font-size:.9rem;margin:0 0 18px}
  input,select{width:100%;font:inherit;padding:12px 14px;border:1px solid var(--line);border-radius:10px;background:#fff}
  .btn{width:100%;background:var(--pine);color:#fff;border:0;padding:13px;border-radius:10px;font-weight:600;margin-top:12px;font-size:1rem}
  .card{background:#fff;border:1px solid var(--line);border-radius:14px;padding:16px 18px;margin-bottom:12px}
  .card .top{display:flex;justify-content:space-between;align-items:flex-start;gap:12px}
  .card .svc{font-weight:700;color:var(--pine)}
  .card .when{font-size:.9rem;color:#555}
  .card .who{margin-top:6px;font-size:.92rem}
  .card .meta{font-size:.82rem;color:#888;margin-top:4px}
  .badge{font-size:.72rem;font-weight:700;text-transform:uppercase;padding:4px 9px;border-radius:999px;white-space:nowrap}
  .b-pending{background:#fbf0dd;color:#a9772a}.b-approved{background:#e2f0e6;color:#256b45}
  .b-cancelled{background:#f6e2dc;color:#b0553a}.b-done{background:#e7e2f0;color:#4a3f7a}
  .actions{display:flex;gap:8px;margin-top:12px;flex-wrap:wrap}
  .actions button{border:1px solid var(--line);background:#fff;border-radius:8px;padding:7px 12px;font-size:.82rem;cursor:pointer}
  .err{color:#b0553a;font-size:.85rem;margin-top:8px}
  .muted{color:#999;text-align:center;padding:30px}
  .filter{display:flex;gap:8px;margin-bottom:14px;flex-wrap:wrap}
  .filter button{border:1px solid var(--line);background:#fff;border-radius:999px;padding:6px 14px;font-size:.85rem;cursor:pointer}
  .filter button.on{background:var(--pine);color:#fff;border-color:var(--pine)}
</style></head><body>
<div id="app"></div>
<script>
const $=s=>document.querySelector(s);
let all=[],filter='all';
function esc(s){return (s||'').replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]))}
async function api(p,o){const r=await fetch(p,o);return{ok:r.ok,data:await r.json()}}
function loginView(msg){
  $('#app').innerHTML=\`<div class="login"><h1>AcuPro Admin</h1><p>Booking management</p>
    <input id="pw" type="password" placeholder="Password" autofocus>
    <button class="btn" onclick="doLogin()">Sign in</button>
    <div class="err">\${msg||''}</div></div>\`;
  $('#pw').addEventListener('keydown',e=>{if(e.key==='Enter')doLogin()});
}
async function doLogin(){
  const {ok,data}=await api('/api/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({password:$('#pw').value})});
  if(ok)load();else loginView(data.error||'Login failed');
}
async function load(){
  const {ok,data}=await api('/api/appointments');
  if(!ok)return loginView('');
  all=data.appointments||[];render();
}
function render(){
  const counts={all:all.length,pending:0,approved:0,cancelled:0,done:0};
  all.forEach(a=>counts[a.status]!==undefined&&counts[a.status]++);
  const list=all.filter(a=>filter==='all'||a.status===filter);
  const fbtn=(k,label)=>\`<button class="\${filter===k?'on':''}" onclick="setF('\${k}')">\${label} (\${counts[k]})</button>\`;
  $('#app').innerHTML=\`
    <header><h1>📅 AcuPro Bookings</h1><button onclick="logout()">Sign out</button></header>
    <div class="wrap">
      <div class="filter">\${fbtn('all','All')}\${fbtn('pending','Pending')}\${fbtn('approved','Approved')}\${fbtn('cancelled','Cancelled')}\${fbtn('done','Done')}</div>
      \${list.length?list.map(card).join(''):'<div class="muted">No bookings yet.</div>'}
    </div>\`;
}
function card(a){
  const d=new Date(a.start_date.replace(' ','T'));
  const when=isNaN(d)?a.start_date:d.toLocaleString('en-GB',{weekday:'short',day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'});
  return \`<div class="card"><div class="top">
      <div><div class="svc">\${esc(a.service)||'Service'} \${a.price?('· £'+a.price):''}</div>
      <div class="when">\${when}</div>
      <div class="who">\${esc(a.full_name)} · \${esc(a.phone)||''}</div>
      <div class="meta">\${esc(a.email)} · \${esc(a.location)||'—'} · \${esc(a.staff)||'Any'}\${a.notes?(' · "'+esc(a.notes)+'"'):''}</div></div>
      <span class="badge b-\${a.status}">\${a.status}</span></div>
      <div class="actions">
        <button onclick="setS(\${a.id},'approved')">✓ Approve</button>
        <button onclick="setS(\${a.id},'done')">Done</button>
        <button onclick="setS(\${a.id},'cancelled')">✕ Cancel</button>
      </div></div>\`;
}
function setF(k){filter=k;render()}
async function setS(id,status){await api('/api/status',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id,status})});load()}
async function logout(){await fetch('/api/logout');loginView('')}
load();
</script></body></html>`;
