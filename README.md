# 카페 메뉴 웹사이트 (QR 스캔용)

QR을 찍으면 열리는 모바일용 한 페이지 메뉴판.
상단에 **스크롤에 맞춰 움직이는 이미지**, 아래에 메뉴가 들어갑니다.

## 파일 구조

```
index.html          페이지 뼈대 (히어로 + 메뉴 + 푸터)
qr.html             배포 주소를 넣으면 QR 이미지를 만들어 주는 페이지
css/style.css       전체 스타일. 맨 위 :root 에 색/폰트 토큰
js/menu-data.js     ★ 메뉴 내용 — 보통 여기만 고치면 됨
js/app.js           스크롤 연동 + 메뉴 렌더링 로직
assets/hero.svg     상단 이미지 임시 플레이스홀더
```

## 사진을 받으면 할 일 (2가지)

1. **상단 이미지**
   `assets/hero.jpg` 로 저장하고, `index.html` 의
   `<img class="hero__img" src="assets/hero.svg">` → `src="assets/hero.jpg"` 로 변경.
   세로로 긴 사진(권장 1600×2000 이상)이 가장 잘 맞습니다.

2. **톤 맞추기**
   `css/style.css` 맨 위 `:root` 의 색값을 사진 톤에 맞게 조정.
   `--bg`(배경) `--ink`(글자) `--accent`(가격·강조) 세 개만 바꿔도 분위기가 바뀝니다.

## 메뉴 수정

`js/menu-data.js` 의 `sections` 배열만 고치면 됩니다. HTML은 건드릴 필요 없습니다.

```js
{ name: "아메리카노", desc: "HOT / ICED", price: "4,000", tag: "SIGNATURE" }
```
`desc`, `tag` 는 생략 가능. `price` 는 적은 문자열이 그대로 출력됩니다.

## 스크롤 애니메이션 조절

- 움직임 길이: `css/style.css` 의 `--hero-scroll` (기본 `220vh`, 크게 할수록 천천히)
- 확대/이동 폭: `.hero__media` 의 `scale(...)`, `translate3d(...)` 안의 숫자
- `js/app.js` 가 스크롤 진행도를 `0 → 1` 로 계산해 CSS 변수 `--p` 로 넘겨줍니다.
  움직임을 추가하고 싶으면 CSS에서 `var(--p)` 를 쓰면 됩니다.
- 기기 설정이 "동작 줄이기"면 애니메이션은 자동으로 꺼집니다.

## 로컬에서 보기

```bash
python3 -m http.server 8000
# http://localhost:8000
```

## 배포 + QR

1. GitHub 저장소 → Settings → Pages → Source: 이 브랜치 / 루트
2. 발급된 주소를 `qr.html` 에 넣고 QR 생성 → 저장 → 인쇄
