// Progressive enhancement: pull live data from the admin (D1) after the static page loads.
// - Service cards ([data-svc-id]): live "from £X" price + hover tooltip with the admin description.
// - Team grid (#teamGrid): rebuilt from the practitioner roster (photos + hover bio).
(function () {
  var esc = function (s) { return (s == null ? "" : "" + s).replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); };

  // ---- services ----
  var rows = document.querySelectorAll("[data-svc-id]");
  if (rows.length) {
    fetch("/api/services").then(function (r) { return r.json(); }).then(function (d) {
      var cur = d && d.currency === "AED" ? "AED " : "£";
      var m = {};
      (d && d.services || []).forEach(function (s) { m[String(s.id)] = s; });
      rows.forEach(function (row) {
        var s = m[row.getAttribute("data-svc-id")];
        if (!s) { return; }
        var pe = row.querySelector(".price");
        if (pe) { pe.innerHTML = s.price > 0 ? ("from " + cur + s.price) : "<small>Enquire</small>"; }
        if (s.description) { row.setAttribute("title", s.description); row.style.cursor = "help"; }
      });
    }).catch(function () {});
  }

  // ---- team ----
  var grid = document.getElementById("teamGrid");
  if (grid) {
    var limit = +(grid.getAttribute("data-limit") || 0);
    fetch("/api/practitioners").then(function (r) { return r.json(); }).then(function (d) {
      var list = (d && d.practitioners) || [];
      if (limit) { list = list.slice(0, limit); }
      if (!list.length) { return; }
      grid.innerHTML = list.map(function (p) {
        var initials = (p.name || "?").replace(/\(.*\)/, "").trim().split(/\s+/).map(function (w) { return w[0] || ""; }).slice(0, 2).join("").toUpperCase();
        var av = p.photo
          ? '<img src="' + esc(p.photo) + '" alt="' + esc(p.name) + '" style="width:96px;height:96px;border-radius:50%;object-fit:cover;margin:0 auto 14px;display:block">'
          : '<div class="team-avatar">' + initials + "</div>";
        var bio = p.bio ? esc(p.bio) : "";
        return '<div class="card team-card"' + (bio ? ' title="' + bio + '" style="cursor:help"' : "") + ">" +
          av +
          '<h3 style="font-family:var(--font-head)">' + esc(p.name) + "</h3>" +
          '<div class="role">TCM Practitioner</div>' +
          "</div>";
      }).join("");
    }).catch(function () {});
  }
})();
