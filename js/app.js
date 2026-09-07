/* ============================================================
   app.js
     1) 스크롤 → 히어로 연출 진행도 계산
     2) 메뉴 렌더링
     3) 등장 애니메이션
   ============================================================ */
(function () {
  "use strict";

  var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* 0~1 사이 구간 진행도 */
  function seg(p, a, b) {
    var v = (p - a) / (b - a);
    return v < 0 ? 0 : v > 1 ? 1 : v;
  }
  function easeIn(v)  { return v * v; }
  function easeOut(v) { return 1 - (1 - v) * (1 - v); }

  /* ---------- 1. 히어로 ---------- */
  function initHero() {
    var hero = document.getElementById("hero");
    var art  = document.getElementById("art");
    if (!hero) return;

    /* 가로로 넓은 화면에서는 그림 전체가 보이게 */
    function fitArt() {
      if (!art) return;
      var wide = window.innerWidth / window.innerHeight > 0.9;
      art.setAttribute("preserveAspectRatio", wide ? "xMidYMid meet" : "xMidYMid slice");
    }

    if (reduceMotion) { fitArt(); return; }

    var ticking = false;

    function update() {
      ticking = false;
      var rect = hero.getBoundingClientRect();
      var travel = rect.height - window.innerHeight;
      if (travel <= 0) return;

      var p = -rect.top / travel;
      p = p < 0 ? 0 : p > 1 ? 1 : p;

      var s = hero.style;
      /* 음료 줄기가 위에서 내려옴 */
      s.setProperty("--pour",   easeOut(seg(p, 0.04, 0.32)).toFixed(4));
      /* 줄기가 잔에 닿는 순간 */
      s.setProperty("--jet",    seg(p, 0.26, 0.31).toFixed(4));
      /* 잔이 차오름 */
      s.setProperty("--level",  seg(p, 0.30, 0.56).toFixed(4));
      /* 표면 스플래시 */
      s.setProperty("--splash", seg(p, 0.31, 0.45).toFixed(4));
      /* 가게 이름 / 스크롤 안내는 먼저 사라짐 */
      s.setProperty("--copy",   (1 - seg(p, 0.02, 0.14)).toFixed(4));
      s.setProperty("--cue",    (1 - seg(p, 0.00, 0.10)).toFixed(4));
      /* 줄기로 줌인 */
      s.setProperty("--zoom",   (1 + easeIn(seg(p, 0.58, 0.86)) * 26).toFixed(3));
      /* 크림색이 화면을 덮고 메뉴 타이틀이 떠오름 */
      s.setProperty("--wash",   seg(p, 0.78, 0.90).toFixed(4));
      s.setProperty("--end",    seg(p, 0.87, 0.96).toFixed(4));
    }

    function onScroll() {
      if (!ticking) { ticking = true; window.requestAnimationFrame(update); }
    }

    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", function () { fitArt(); onScroll(); });
    fitArt();
    update();
  }

  /* ---------- 2. 메뉴 렌더링 ---------- */
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  /* 종이 메뉴판 1면의 남색 얼룩 (표지) */
  function renderCover(title) {
    var cover = document.getElementById("cover");
    if (!cover) return;

    var NS = "http://www.w3.org/2000/svg";
    var svg = document.createElementNS(NS, "svg");
    svg.setAttribute("class", "cover__blob");
    svg.setAttribute("viewBox", "0 0 400 180");
    svg.setAttribute("preserveAspectRatio", "none");
    svg.setAttribute("aria-hidden", "true");
    var path = document.createElementNS(NS, "path");
    path.setAttribute("fill", "#1e1a4b");
    path.setAttribute("d", "M0 0 H400 V74 C374 80 360 112 326 126 " +
                           "C292 140 258 130 222 140 C184 151 146 160 110 152 " +
                           "C72 143 36 124 0 130 Z");
    svg.appendChild(path);

    var inner = el("div", "cover__inner");
    inner.appendChild(el("h2", "cover__title", title));

    cover.appendChild(svg);
    cover.appendChild(inner);
  }

  function renderMenu(data) {
    var root = document.getElementById("menu-root");
    if (!root || !data || !data.groups) return;

    data.groups.forEach(function (group, gi) {
      var g = el("section", "group");

      /* 첫 묶음의 제목은 표지 얼룩 위에 (종이 1면과 동일) */
      if (gi === 0) {
        renderCover(group.title);
      } else {
        var head = el("div", "group__head");
        head.appendChild(el("h2", "group__title", group.title));
        g.appendChild(head);
      }

      group.sections.forEach(function (section) {
        var sec = el("section", "section");

        var t = el("h3", "section__title", section.title);
        if (section.mark) t.appendChild(el("span", "section__mark", section.mark));
        sec.appendChild(t);

        var ul = el("ul", "items");
        section.items.forEach(function (item) {
          var li = el("li", "item");

          var name = el("div", "item__name", item.fr);
          if (item.sig) name.appendChild(el("span", "item__sig", "✱"));
          if (item.ko)  name.appendChild(el("span", "item__ko", item.ko));

          li.appendChild(name);
          li.appendChild(el("div", "item__price", item.price));
          ul.appendChild(li);
        });

        sec.appendChild(ul);
        g.appendChild(sec);
      });

      root.appendChild(g);
    });
  }

  /* ---------- 3. 가게 정보 ---------- */
  function renderInfo(data) {
    var c = data.cafe || {};
    if (c.name) document.title = c.name + " · MENU";

    var map = {
      "cafe-name": c.name, "cafe-tagline": c.tagline,
      "end-name": c.name,  "foot-name": c.name,
      "foot-address": c.address, "foot-hours": c.hours, "foot-phone": c.phone
    };
    Object.keys(map).forEach(function (id) {
      var node = document.getElementById(id);
      if (!node) return;
      if (map[id]) node.textContent = map[id];
      else if (id.indexOf("foot-") === 0) node.remove();
    });

    var ig = document.getElementById("foot-instagram");
    if (ig) {
      if (c.instagram) {
        ig.textContent = c.instagram;
        ig.href = "https://instagram.com/" + c.instagram.replace(/^@/, "");
      } else if (ig.parentNode) {
        ig.parentNode.remove();
      }
    }

    var notice = document.getElementById("foot-notice");
    if (notice && data.notice) notice.textContent = data.notice;
  }

  /* ---------- 4. 메뉴 등장 애니메이션 ---------- */
  function initReveal() {
    var items = document.querySelectorAll(".item");
    if (reduceMotion || !("IntersectionObserver" in window)) {
      Array.prototype.forEach.call(items, function (i) { i.classList.add("is-in"); });
      return;
    }
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) { e.target.classList.add("is-in"); io.unobserve(e.target); }
      });
    }, { rootMargin: "0px 0px -6% 0px", threshold: 0.05 });

    Array.prototype.forEach.call(items, function (item, i) {
      item.style.transitionDelay = (Math.min(i % 8, 6) * 40) + "ms";
      io.observe(item);
    });
  }

  document.addEventListener("DOMContentLoaded", function () {
    var data = window.CAFE;
    if (data) { renderInfo(data); renderMenu(data); }
    initHero();
    initReveal();
  });
})();
