/* ============================================================
   app.js — (1) 스크롤 연동 히어로  (2) 메뉴 렌더  (3) 등장 애니메이션
   ============================================================ */
(function () {
  "use strict";

  var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ---------- 1. 스크롤 진행도(0~1)를 CSS 변수 --p 로 전달 ----------
     히어로 통(.hero)의 스크롤 구간을 0~1로 정규화해서 넘긴다.
     CSS 쪽에서 scale / translate / opacity 가 이 값을 받아 움직임.
     사진을 바꿔도 이 로직은 그대로 쓰면 됨.
  ------------------------------------------------------------------ */
  function initHero() {
    var hero = document.querySelector(".hero");
    if (!hero || reduceMotion) return;

    var ticking = false;

    function update() {
      ticking = false;
      var rect = hero.getBoundingClientRect();
      var travel = rect.height - window.innerHeight;   // 실제 움직일 수 있는 거리
      if (travel <= 0) return;
      var p = -rect.top / travel;
      p = p < 0 ? 0 : p > 1 ? 1 : p;
      hero.style.setProperty("--p", p.toFixed(4));
    }

    function onScroll() {
      if (!ticking) {
        ticking = true;
        window.requestAnimationFrame(update);
      }
    }

    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    update();
  }

  /* ---------- 2. 메뉴 렌더 ---------- */
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function renderMenu(data) {
    var root = document.getElementById("menu-root");
    if (!root || !data) return;

    data.sections.forEach(function (section) {
      var sec = el("section", "section");

      var head = el("div", "section__head");
      var h2 = el("h2", "section__title", section.title);
      if (section.en) h2.appendChild(el("small", null, section.en));
      head.appendChild(h2);
      head.appendChild(el("div", "section__rule"));
      sec.appendChild(head);

      var ul = el("ul", "items");
      section.items.forEach(function (item) {
        var li = el("li", "item");

        var main = el("div", "item__main");
        var name = el("div", "item__name");
        name.appendChild(document.createTextNode(item.name));
        if (item.tag) name.appendChild(el("span", "tag", item.tag));
        main.appendChild(name);
        if (item.desc) main.appendChild(el("p", "item__desc", item.desc));

        li.appendChild(main);
        li.appendChild(el("div", "item__price", item.price));
        ul.appendChild(li);
      });

      sec.appendChild(ul);
      root.appendChild(sec);
    });
  }

  /* ---------- 3. 가게 정보 채우기 ---------- */
  function renderInfo(data) {
    var c = data.cafe;
    document.title = c.name + " · MENU";

    var map = {
      "cafe-name":     c.name,
      "cafe-tagline":  c.tagline,
      "foot-name":     c.name,
      "foot-address":  c.address,
      "foot-hours":    c.hours,
      "foot-phone":    c.phone
    };
    Object.keys(map).forEach(function (id) {
      var node = document.getElementById(id);
      if (node && map[id]) node.textContent = map[id];
    });

    var ig = document.getElementById("foot-instagram");
    if (ig) {
      if (c.instagram) {
        ig.textContent = c.instagram;
        ig.href = "https://instagram.com/" + c.instagram.replace(/^@/, "");
      } else {
        ig.remove();
      }
    }

    var notice = document.getElementById("foot-notice");
    if (notice && data.notice) notice.textContent = data.notice;
  }

  /* ---------- 4. 메뉴 항목 등장 애니메이션 ---------- */
  function initReveal() {
    var items = document.querySelectorAll(".item");
    if (reduceMotion || !("IntersectionObserver" in window)) {
      items.forEach(function (i) { i.classList.add("is-in"); });
      return;
    }
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) {
          e.target.classList.add("is-in");
          io.unobserve(e.target);
        }
      });
    }, { rootMargin: "0px 0px -8% 0px", threshold: 0.1 });

    items.forEach(function (item, i) {
      item.style.transitionDelay = (Math.min(i, 6) * 45) + "ms";
      io.observe(item);
    });
  }

  document.addEventListener("DOMContentLoaded", function () {
    var data = window.CAFE;
    if (data) {
      renderInfo(data);
      renderMenu(data);
    }
    initHero();
    initReveal();
  });
})();
