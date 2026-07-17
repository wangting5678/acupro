// Progressive enhancement: pull live data from the admin (D1) after the static page loads.
// - Service cards ([data-svc-id]): live "from £X" price + hover tooltip with the admin description.
// - Team grid (#teamGrid): rebuilt from the practitioner roster (photos + hover bio).
(function () {
  var esc = function (s) { return (s == null ? "" : "" + s).replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); };

  // ---- Arabic dictionary for site chrome + static pages (booking/cancel islands translate themselves) ----
  var AR = {
    "Services": "الخدمات", "Conditions": "الحالات", "Our Team": "فريقنا", "Pricing": "الأسعار", "Branches": "الفروع",
    "Book Now": "احجز الآن", "Book an appointment →": "احجز موعدًا →", "Book an appointment": "احجز موعدًا",
    "Free 15-min enquiry": "استشارة مجانية 15 دقيقة", "Book a treatment →": "احجز جلسة علاج →", "Book a treatment": "احجز جلسة علاج",
    "Meet the full team →": "تعرّف على الفريق كاملًا →", "Book again": "احجز مرة أخرى", "Enquire": "استفسر",
    "Traditional Chinese Medicine · London": "الطب الصيني التقليدي · لندن",
    "What we offer": "ما نقدمه", "Treatments & pricing": "العلاجات والأسعار", "Treatments &amp; pricing": "العلاجات والأسعار",
    "Meet the practitioners": "تعرّف على المعالجين", "Our team": "فريقنا", "Our services": "خدماتنا",
    "5,500+ patients cared for": "أكثر من 5,500 مريض تلقّوا الرعاية", "Since 2013": "منذ 2013", "3 ways to visit": "٣ طرق للزيارة",
    "TCM Practitioner": "معالج طب صيني", "Online consultation": "استشارة عبر الإنترنت", "Online video consultation": "استشارة فيديو عبر الإنترنت",
    "In-person clinic": "عيادة حضورية", "min": "دقيقة", "from": "من",
    "Award-winning acupuncture, herbal medicine and wellness care from experienced TCM practitioners. Trusted by thousands across London.":
      "وخز إبر حائز على جوائز، وطب أعشاب ورعاية صحية على يد معالجين ذوي خبرة في الطب الصيني. موضع ثقة الآلاف.",
    "AcuPro CLINIC": "عيادة أكيوبرو", "All rights reserved.": "جميع الحقوق محفوظة.",
    "Online booking": "الحجز عبر الإنترنت", "Book your appointment": "احجز موعدك",
    "Manage your appointment": "إدارة موعدك", "View or cancel": "عرض أو إلغاء",
    "Conditions we treat": "الحالات التي نعالجها", "Our conditions": "الحالات", "Get in touch": "تواصل معنا", "Contact": "اتصل بنا"
  };

  function translateEl(el, toAr) {
    if (el.closest("astro-island")) return; // React islands (booking/cancel) translate themselves
    if (el.children.length > 0) return;
    var stored = el.getAttribute("data-en");
    var en = stored != null ? stored : el.textContent.trim();
    if (!en) return;
    if (toAr) {
      if (AR[en]) { if (stored == null) el.setAttribute("data-en", el.textContent); el.textContent = AR[en]; }
    } else if (stored != null) {
      el.textContent = stored; el.removeAttribute("data-en");
    }
  }
  function translateDOM(toAr) {
    var els = document.querySelectorAll("a,button,h1,h2,h3,h4,h5,p,span,li,label,strong,em,small,div");
    for (var i = 0; i < els.length; i++) translateEl(els[i], toAr);
  }

  // ---- styled tooltip (replaces ugly native title boxes) ----
  var tip = document.createElement("div");
  tip.id = "info-tip";
  document.body.appendChild(tip);
  var showTip = function (el) {
    var t = el.getAttribute("data-info");
    if (!t) { return; }
    tip.textContent = t;
    tip.classList.add("show");
    var r = el.getBoundingClientRect();
    // horizontally: align near the element, clamped to viewport
    var w = tip.offsetWidth, h = tip.offsetHeight;
    var left = Math.min(Math.max(10, r.left), window.innerWidth - w - 10);
    var below = r.bottom + 12 + h < window.innerHeight;
    var top = below ? r.bottom + 10 : r.top - h - 10;
    tip.style.left = left + "px";
    tip.style.top = top + "px";
    tip.classList.toggle("below", below);
    tip.classList.toggle("above", !below);
    var cx = Math.min(Math.max(r.left + r.width / 2, left + 16), left + w - 16);
    tip.style.setProperty("--tip-arrow", (cx - left - 5) + "px");
  };
  var hideTip = function () { tip.classList.remove("show"); };
  document.addEventListener("mouseover", function (e) { var el = e.target.closest && e.target.closest("[data-info]"); if (el) { showTip(el); } else { hideTip(); } });
  document.addEventListener("mouseout", function (e) { var el = e.target.closest && e.target.closest("[data-info]"); if (el) { hideTip(); } });
  document.addEventListener("click", hideTip, true);
  window.addEventListener("scroll", hideTip, true);

  // ---- site config: region pill + language toggle (EN/AR) ----
  fetch("/api/site").then(function (r) { return r.json(); }).then(function (cfg) {
    var pill = document.getElementById("regionPill");
    if (pill && cfg.region === "UAE") { pill.textContent = "🇦🇪 UAE"; }
    var langs = cfg.langs || [];
    var btn = document.getElementById("langToggle");
    if (btn && langs.indexOf("ar") >= 0) {
      btn.style.display = "";
      var apply = function (lang) {
        var ar = lang === "ar";
        document.documentElement.setAttribute("lang", ar ? "ar" : "en");
        document.documentElement.setAttribute("dir", ar ? "rtl" : "ltr");
        btn.textContent = ar ? "English" : "العربية";
        try { localStorage.setItem("acupro_lang", lang); } catch (e) {}
        translateDOM(ar);
        window.dispatchEvent(new CustomEvent("acupro-lang", { detail: lang }));
      };
      var cur = "en";
      try { cur = localStorage.getItem("acupro_lang") || "en"; } catch (e) {}
      apply(cur);
      btn.addEventListener("click", function () { apply(document.documentElement.getAttribute("dir") === "rtl" ? "en" : "ar"); });
    }
  }).catch(function () {});

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
        if (s.description) { row.setAttribute("data-info", s.description); row.style.cursor = "help"; }
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
        return '<div class="card team-card"' + (bio ? ' data-info="' + bio + '" style="cursor:help"' : "") + ">" +
          av +
          '<h3 style="font-family:var(--font-head)">' + esc(p.name) + "</h3>" +
          '<div class="role">TCM Practitioner</div>' +
          "</div>";
      }).join("");
    }).catch(function () {});
  }
})();
