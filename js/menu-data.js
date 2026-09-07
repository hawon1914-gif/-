/* ============================================================
   메뉴 데이터 — 사진의 종이 메뉴판을 그대로 옮긴 것.
   수정은 이 파일만 고치면 됩니다. (HTML/CSS 안 건드려도 됨)

   구조
     groups[]            큰 묶음 (BOISSONS / ALIMENTS)
       sections[]        카테고리 (CAFÉ, MATCHA ...)
         items[]         { fr, ko, price, sig }
                         fr    불어(또는 영어) 이름 — 대문자로 출력됨
                         ko    한글 이름 (없으면 "")
                         price 적은 문자열 그대로 출력 ("5.5 / 6.0" 가능)
                         sig   true 면 ✱ 표시
   ============================================================ */
window.CAFE = {
  cafe: {
    name: "CAFÉ",                 // ← 실제 가게 이름으로 바꾸세요
    tagline: "BOISSONS · ALIMENTS",
    address: "",                  // 예: "1234 Rue Saint-Denis, Montréal"
    hours: "",                    // 예: "TOUS LES JOURS 10:00 – 20:00"
    phone: "",
    instagram: ""                 // 예: "@cafe_name"
  },

  groups: [
    {
      title: "BOISSONS",
      sections: [
        {
          title: "CAFÉ",
          items: [
            { fr: "Espresso",              ko: "에스프레소",      price: "4.0" },
            { fr: "Americano",             ko: "아메리카노",      price: "4.0" },
            { fr: "Allongé",               ko: "알롱제",          price: "4.0" },
            { fr: "Macchiato",             ko: "마끼아또",        price: "4.5" },
            { fr: "Cortado",               ko: "콜타도",          price: "5.0" },
            { fr: "Cappuccino",            ko: "카푸치노",        price: "5.5" },
            { fr: "Mocha",                 ko: "모카",            price: "6.0" },
            { fr: "Latte",                 ko: "라떼",            price: "5.5 / 6.0" },
            { fr: "Latte à la vanille",    ko: "바닐라 라떼",     price: "6.5" },
            { fr: "Cold brew",             ko: "콜드 브루",       price: "5.0" }
          ]
        },
        {
          title: "SIGNATURE",
          mark: "✱",
          items: [
            { fr: "Latte Noon",            ko: "라떼 눈",         price: "6.0" },
            { fr: "Yuzu Americano",        ko: "유자 아메리카노", price: "6.0" },
            { fr: "Cold brew crème",       ko: "콜드 브루 크림",  price: "6.5" }
          ]
        },
        {
          title: "MATCHA",
          items: [
            { fr: "Koicha",                ko: "코이차",          price: "5.0" },
            { fr: "Usucha",                ko: "우슈차",          price: "5.0" }
          ]
        },
        {
          title: "MATCHA AU LAIT",
          items: [
            { fr: "Matcha cortado",             ko: "마차 콜타도",              price: "5.5" },
            { fr: "Latte au matcha",            ko: "마차 라떼",                price: "6.25" },
            { fr: "Latte Noon au matcha",       ko: "라떼 눈 마차",             price: "6.5" },
            { fr: "Matcha fraise (glacé)",      ko: "마차 스트로베리 (아이스)", price: "6.75" }
          ]
        },
        {
          title: "RAFRAÎCHISSEMENT",
          items: [
            { fr: "Yuzu matcha",                          ko: "유자 마차",              price: "6.75" },
            { fr: "Thé vert à la pêche avec limonade",    ko: "피치 그린티 레모네이드", price: "6.75" },
            { fr: "Lime pétillant (durée limitée)",       ko: "스파클링 라임 (시즌 한정)", price: "6.75" },
            { fr: "Pamplemousse pétillant",               ko: "스파클링 자몽",          price: "6.75" },
            { fr: "Poire au miel",                        ko: "삼다꿀배",               price: "6.75" }
          ]
        },
        {
          title: "AUTRES",
          items: [
            { fr: "Thé vert / noir / tisane",  ko: "녹차. 홍차. 허브차",  price: "4.0" },
            { fr: "Chocolat chaud",            ko: "핫초코",              price: "6.0" },
            { fr: "Thé au lait royal",         ko: "로얄 밀크티",         price: "6.25" },
            { fr: "Latte au hojicha",          ko: "호지차 라떼",         price: "6.25" },
            { fr: "Affogato",                  ko: "아포가토",            price: "7.0" }
          ]
        },
        {
          title: "EXTRA",
          items: [
            { fr: "+ Shot", ko: "샷", price: "1.0" },
            { fr: "+ Glacé. Sirop maison à la gousse de vanille. Lait végétal",
              ko: "아이스. 홈메이드 바닐라빈 시럽. 대체 우유", price: "0.5" }
          ]
        }
      ]
    },

    {
      title: "ALIMENTS",
      sections: [
        {
          title: "BINGSU",
          items: [
            { fr: "Injeolmi",                        ko: "인절미",        price: "14.0" },
            { fr: "Mangue",                          ko: "망고",          price: "15.0" },
            { fr: "Tomate au miel avec basilic",     ko: "꿀 바질 토마토", price: "16.0" },
            { fr: "Tiramisu au matcha",              ko: "마차 티라미수",  price: "17.0" },
            { fr: "Fraise",                          ko: "딸기",          price: "15.0" },
            { fr: "Double chocolat",                 ko: "더블 초콜릿",    price: "14.0" }
          ]
        },
        {
          title: "EXTRA",
          items: [
            { fr: "+ Garniture", ko: "토핑", price: "2.0" },
            { fr: "+ Grande",    ko: "라지", price: "10.0" }
          ]
        },
        {
          title: "BOUCHÉE",
          items: [
            { fr: "Toast matcha banane brûlée", ko: "마차 바나나 브륄레 토스트", price: "8.0" },
            { fr: "Toast avocat",               ko: "아보카도 토스트",          price: "13.0" },
            { fr: "Tteokbokki",                 ko: "떡볶이",                   price: "13.0" },
            { fr: "Buldak tteokbokki",          ko: "불닭 떡볶이",              price: "14.0" },
            { fr: "Poke",                       ko: "포케",                     price: "23.0" }
          ]
        },
        {
          title: "CRÈME GLACÉE",
          items: [
            { fr: "Matcha",             ko: "마차",         price: "6.0" },
            { fr: "Vanille",            ko: "바닐라",       price: "6.0" },
            { fr: "Matcha & vanille",   ko: "마차 & 바닐라", price: "6.0" }
          ]
        }
      ]
    }
  ],

  /* ✱ 표시 설명 / 안내 문구 */
  notice: "✱ SIGNATURE\n메뉴와 가격은 변동될 수 있습니다"
};
