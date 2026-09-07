/* ============================================================
   메뉴 데이터 — 사진 받으면 이 파일만 고치면 됩니다.
   (HTML/CSS 건드릴 필요 없음)

   cafe    : 가게 이름 / 한 줄 소개 / 정보
   sections: 카테고리 배열
     title : 한글 카테고리명
     en    : 아래 작게 들어가는 영문 (없으면 "")
     items : { name, desc, price, tag } 목록
             desc, tag 는 생략 가능
             price 는 문자열 그대로 출력 (예: "4,500" 또는 "4,500 / 5,000")
   ============================================================ */
window.CAFE = {
  cafe: {
    name: "CAFE NAME",
    tagline: "Roastery & Dessert",
    address: "서울시 ○○구 ○○로 00",
    hours: "매일 10:00 – 22:00",
    phone: "02-000-0000",
    instagram: ""            // 예: "@cafe_name" (없으면 빈 문자열)
  },

  sections: [
    {
      title: "커피",
      en: "Coffee",
      items: [
        { name: "에스프레소",   desc: "싱글 오리진 · 데일리 블렌드", price: "3,500" },
        { name: "아메리카노",   desc: "HOT / ICED",                 price: "4,000", tag: "SIGNATURE" },
        { name: "카페라떼",     desc: "HOT / ICED",                 price: "4,500" },
        { name: "바닐라 라떼",  desc: "",                           price: "5,000" },
        { name: "콜드브루",     desc: "12시간 저온 추출",            price: "5,000" }
      ]
    },
    {
      title: "논커피",
      en: "Non-Coffee",
      items: [
        { name: "곡물 라떼",   desc: "", price: "5,000" },
        { name: "말차 라떼",   desc: "우지 말차", price: "5,500" },
        { name: "초콜릿",      desc: "HOT / ICED", price: "5,000" },
        { name: "제철 에이드", desc: "당일 과일에 따라 변경", price: "6,000", tag: "SEASONAL" }
      ]
    },
    {
      title: "티",
      en: "Tea",
      items: [
        { name: "얼그레이",     desc: "", price: "4,500" },
        { name: "캐모마일",     desc: "", price: "4,500" },
        { name: "페퍼민트",     desc: "", price: "4,500" }
      ]
    },
    {
      title: "디저트",
      en: "Dessert",
      items: [
        { name: "바스크 치즈케이크", desc: "", price: "6,500", tag: "BEST" },
        { name: "당근 케이크",       desc: "", price: "6,000" },
        { name: "휘낭시에",          desc: "플레인 / 얼그레이", price: "3,000" },
        { name: "오늘의 스콘",       desc: "품절 시 조기 마감", price: "3,500" }
      ]
    }
  ],

  notice: "· 매장 내 일회용컵 사용이 제한됩니다\n· 모든 가격은 부가세 포함입니다"
};
