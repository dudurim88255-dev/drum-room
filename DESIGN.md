# Design System: drum-room (드럼룸)

> 이 파일은 AI 코딩 에이전트(Claude Code 등)가 일관된 UI를 생성하기 위한 디자인 시스템 문서입니다.
> 프로젝트 루트에 `DESIGN.md`로 저장하고, 모든 UI 작업 전 반드시 먼저 읽습니다.
> Google Stitch 포맷 기반.

---

## 1. Visual Theme & Atmosphere

**분위기:** 어두운 연습 스튜디오의 콘솔. 조명을 낮춘 방에서 장비 패널만 은은하게 빛나는 느낌.

**밀도:** 여유로운 여백 중심. 1차 버전은 기능이 4개뿐이므로 화면을 꽉 채우지 않는다. 큰 컨트롤, 넉넉한 간격, 한눈에 들어오는 단일 초점.

**디자인 철학:** "연주자의 손이 먼저다. 화면은 조용히 받쳐준다." 드럼을 치는 사람이 화면을 오래 들여다보지 않는다 — 곡 넣고, 슬라이더 맞추고, 재생 누르면 끝. 모든 컨트롤은 멀리서도 보이고, 한 번에 닿아야 한다.

### 핵심 키워드
- Dark, Focused, Calm — 어둡고, 초점이 분명하고, 차분함
- Tactile, Console-like — 물리 장비 패널 같은 손맛
- Performer-first — 화면이 아니라 연주가 주인공

### 컨셉 메모
- 다크 모드 단일 운영. 라이트 모드 없음 — 스튜디오는 어둡다.
- 액센트는 단 한 색(앰버). 드럼 볼륨, 재생 상태 등 "지금 살아있는 것"에만 쓴다.
- 화려한 그라디언트·일러스트 금지. 장비는 과장하지 않는다.

---

## 2. Color Palette & Roles

다크 모드 단일 운영. 라이트 모드 팔레트는 정의하지 않는다.

### Dark Mode (유일 모드)

| 이름 | HEX | 역할 |
|------|-----|------|
| **Accent** | `#F2A33C` | 드럼 볼륨 슬라이더, 재생 중 표시, 핵심 강조. 화면에서 가장 밝은 색 |
| **Accent Hover** | `#F4B45E` | 액센트 요소 호버 |
| **Accent Dim** | `#8A6230` | 액센트의 어두운 단계 — 트랙 채움 배경 등 |
| **Background** | `#0E0F12` | 페이지 배경. 순수 검정 아님 |
| **Surface** | `#17191D` | 카드, 콘솔 패널 배경 |
| **Surface Elevated** | `#212429` | 드롭존 활성, 떠 있는 요소 |
| **Surface Inset** | `#0B0C0E` | 슬라이더 트랙 홈 등 파인 면 |
| **Border** | `#2A2D33` | 구분선, 카드 테두리 |
| **Border Strong** | `#3A3E45` | 강조 테두리, 드롭존 점선 |
| **Text Primary** | `#ECEDEF` | 본문, 곡 제목 |
| **Text Secondary** | `#9AA0A8` | 부가 설명, 캡션 |
| **Text Muted** | `#5F646C` | 플레이스홀더, 비활성 |
| **Success** | `#5BBF8A` | 분리 완료 표시 |
| **Error** | `#D9685E` | 분리 실패, 미지원 파일 |

### CSS Variables (그대로 사용)

```css
:root {
  /* Accent — 화면에서 살아있는 것에만 */
  --color-accent: #F2A33C;
  --color-accent-hover: #F4B45E;
  --color-accent-dim: #8A6230;

  /* Surfaces — 어두운 콘솔 층위 */
  --color-bg: #0E0F12;
  --color-surface: #17191D;
  --color-surface-elevated: #212429;
  --color-surface-inset: #0B0C0E;

  /* Border */
  --color-border: #2A2D33;
  --color-border-strong: #3A3E45;

  /* Text */
  --color-text: #ECEDEF;
  --color-text-secondary: #9AA0A8;
  --color-text-muted: #5F646C;

  /* Semantic */
  --color-success: #5BBF8A;
  --color-error: #D9685E;

  /* Spacing scale (4px 기반) */
  --space-1: 4px;
  --space-2: 8px;
  --space-3: 12px;
  --space-4: 16px;
  --space-6: 24px;
  --space-8: 32px;
  --space-12: 48px;
  --space-16: 64px;

  /* Radius */
  --radius-sm: 8px;
  --radius-md: 12px;
  --radius-lg: 16px;
  --radius-full: 999px;
}
```

> 색상은 반드시 위 CSS 변수로 참조한다. HEX 값을 컴포넌트에 직접 쓰지 않는다.

---

## 3. Typography Rules

**폰트 패밀리:**
- **한글 + 영문 본문:** Pretendard — `'Pretendard Variable', Pretendard, -apple-system, sans-serif`
- **숫자 강조(볼륨 %, 진행률):** Pretendard의 `tabular-nums` 사용 — 숫자 폭이 흔들리지 않게
- **코드:** 1차 UI에 코드 표기 없음. 필요 시 `'JetBrains Mono', monospace`

### 타이포그래피 스케일

| 용도 | 크기 | 굵기 | 행간 | 자간 |
|------|------|------|------|------|
| **H1 (서비스명/곡 제목)** | 30px / 1.875rem | 700 | 1.25 | -0.02em |
| **H2 (단계 안내)** | 22px / 1.375rem | 600 | 1.35 | -0.01em |
| **Body Large (드롭존 안내)** | 18px / 1.125rem | 400 | 1.7 | 0 |
| **Body (일반 텍스트)** | 16px / 1rem | 400 | 1.7 | 0 |
| **Body Small (캡션·보조)** | 14px / 0.875rem | 400 | 1.6 | 0 |
| **Caption (라벨)** | 13px / 0.8125rem | 500 | 1.5 | 0.02em |
| **Numeric Display (볼륨 %)** | 28px / 1.75rem | 600 | 1 | 0 |
| **Button** | 15px / 0.9375rem | 500 | 1 | 0.01em |

### 한글 규칙 (필수)
- `word-break: keep-all` — 단어 단위로만 줄바꿈
- 본문 최소 16px, 행간 1.7
- 순수 검정(`#000000`) 금지 — 배경은 `#0E0F12`

---

## 4. Component Stylings

1차 버전에 등장하는 컴포넌트만 정의한다.

### 드롭존 (곡 파일 입력)

| 상태 | 스타일 |
|------|--------|
| 기본 | `background: var(--color-surface)`, 점선 테두리 `2px dashed var(--color-border-strong)`, radius `--radius-lg`, 내부 패딩 `--space-16` |
| 드래그 오버 | `background: var(--color-surface-elevated)`, 테두리 `2px dashed var(--color-accent)`, 미세 확대 `scale(1.01)` |
| 안내 문구 | Body Large, `--color-text-secondary`. 보조 문구("파일은 브라우저 밖으로 안 나갑니다")는 Body Small, `--color-text-muted` |

### 1차 액션 버튼 (재생/정지)

- 형태: 원형 또는 큰 알약형. 지름/높이 최소 `64px` — 멀리서 보이고 한 번에 누름
- 기본: `background: var(--color-accent)`, 아이콘 `var(--color-bg)`
- 호버: `background: var(--color-accent-hover)`
- 액티브(눌림): `scale(0.96)`
- 재생 중: 정지 아이콘으로 전환, 버튼 둘레에 은은한 글로우 `box-shadow: 0 0 24px rgba(242,163,60,0.35)`

### 보조 버튼 (프리셋: 드럼없이 / 가이드 / 원곡)

| 상태 | 스타일 |
|------|--------|
| 기본 | `background: var(--color-surface-elevated)`, 텍스트 `--color-text-secondary`, 테두리 `1px solid var(--color-border)`, radius `--radius-full`, 패딩 `--space-2 --space-4` |
| 호버 | 테두리 `--color-border-strong`, 텍스트 `--color-text` |
| 선택됨 | 테두리 `1px solid var(--color-accent)`, 텍스트 `--color-accent`, 배경 `rgba(242,163,60,0.08)` |

### 드럼 볼륨 슬라이더 (1차의 핵심 컨트롤)

- 트랙: 높이 `8px`, `background: var(--color-surface-inset)`, radius `--radius-full`
- 채워진 부분: `background: var(--color-accent)` (0%면 채움 없음)
- 핸들(thumb): 지름 `24px`, `background: var(--color-accent)`, 테두리 `3px solid var(--color-bg)`, 그림자 `--shadow-md`
- 라벨: 위쪽에 "드럼 볼륨" Caption, 오른쪽에 현재 % Numeric Display
- 슬라이더는 화면에서 시각적으로 가장 큰 단일 컨트롤 — 폭을 넉넉히

### 진행률 바 (분리 중)

- 트랙: 높이 `6px`, `background: var(--color-surface-inset)`, radius `--radius-full`
- 채움: `background: var(--color-accent)`, 부드러운 width 트랜지션 (`transition: width 300ms ease`)
- 보조 텍스트: "세그먼트 8/13" 형식, Body Small, `--color-text-secondary`

### 콘솔 카드 (연습 화면 컨테이너)

- `background: var(--color-surface)`, radius `--radius-lg`, 테두리 `1px solid var(--color-border)`
- 내부 패딩 `--space-8`
- 그림자는 4번 항목(Depth) 참조

---

## 5. Layout Principles

**스페이싱 스케일:** 4px 기반 — `4 / 8 / 12 / 16 / 24 / 32 / 48 / 64` (CSS 변수 `--space-*`)

**그리드:** 1차는 단일 컬럼 중앙 정렬. 콘텐츠 최대 폭 `560px` — 컨트롤이 4개뿐이므로 넓게 펼치지 않고 한 줄기로 모은다.

**여백 철학:**
- 화면 전체를 채우려 하지 않는다. 중앙에 콘솔 하나, 위아래로 충분한 빈 공간.
- 컨트롤 사이 간격은 최소 `--space-6`. 드럼을 치다 손이 갈 때 잘못 누르지 않도록.
- 단계 전환(곡 넣기 → 분리 중 → 연습)은 같은 중앙 위치에서 내용만 교체.

**수직 리듬:** 서비스명(상단) → 콘솔 카드(중앙) → 여백(하단). 콘솔 카드는 세로 중앙보다 살짝 위.

---

## 6. Depth & Elevation

어두운 화면에서 깊이는 그림자보다 **표면 밝기 차이**로 표현한다.

| 층위 | 표면색 | 용도 |
|------|--------|------|
| 0 — 바닥 | `--color-bg` | 페이지 배경 |
| 1 — 패널 | `--color-surface` | 콘솔 카드 |
| 2 — 떠있음 | `--color-surface-elevated` | 드래그 오버, 보조 버튼 |
| -1 — 파인 면 | `--color-surface-inset` | 슬라이더 트랙, 진행률 트랙 |

### 그림자 (절제해서 사용)

```css
--shadow-sm: 0 1px 2px rgba(0,0,0,0.4);
--shadow-md: 0 4px 12px rgba(0,0,0,0.5);
--shadow-glow: 0 0 24px rgba(242,163,60,0.35);  /* 재생 중 버튼에만 */
```

- 그림자는 콘솔 카드와 슬라이더 핸들에만. 남발 금지.
- 글로우(`--shadow-glow`)는 "지금 재생 중"이라는 단 하나의 상태에만 쓴다.

---

## 7. Do's and Don'ts

### Do
- 다크 단일 모드로 일관되게 — 스튜디오는 어둡다
- 액센트(앰버)는 "지금 살아있는 것"에만 — 드럼 볼륨, 재생 상태
- 컨트롤은 크게, 간격은 넉넉히 — 연주자가 멀리서 보고 한 번에 누름
- 단계 전환은 같은 자리에서 내용만 교체 — 화면이 튀지 않게
- 숫자(%, 진행률)는 `tabular-nums`로 — 폭이 흔들리지 않게
- `word-break: keep-all`로 한글 줄바꿈 처리

### Don't
- 라이트 모드 만들지 않기 — 다크 단일
- 액센트 색을 여기저기 쓰지 않기 — 한 색의 절제가 콘셉트
- 그라디언트·일러스트·장식 금지 — 장비는 과장하지 않는다
- 순수 검정(`#000000`) 금지 — 배경은 `#0E0F12`
- 화면을 정보로 채우지 않기 — 1차는 기능 4개, 여백이 핵심
- HEX 값 직접 쓰지 않기 — 반드시 CSS 변수
- 작은 버튼·촘촘한 간격 금지 — 연주 중 오조작 방지

---

## 8. Responsive Behavior

**1차 지원 타깃:** 크롬 데스크톱. 모바일·태블릿·타 브라우저는 1차 지원 범위 밖.

**브레이크포인트:**
- 데스크톱 기준 단일 레이아웃 (콘텐츠 최대 폭 `560px`, 중앙 정렬)
- 좁은 창(<600px)에서는 콘솔 카드가 좌우 `--space-4` 여백만 두고 폭에 맞춤
- 모바일 접속 시: 레이아웃을 억지로 맞추지 않고, "드럼룸은 데스크톱 크롬에 맞춰져 있습니다" 안내 화면 표시

**터치 타겟:** 1차는 데스크톱 전용이라 마우스 기준. 단 모든 클릭 대상은 최소 `44px` 확보(향후 확장 대비).

---

## 9. Agent Prompt Guide

### 빠른 색상 참조

```
배경:        #0E0F12  (--color-bg)
콘솔 패널:    #17191D  (--color-surface)
액센트(앰버): #F2A33C  (--color-accent)  ← 드럼 볼륨·재생 상태에만
본문 텍스트:  #ECEDEF  (--color-text)
보조 텍스트:  #9AA0A8  (--color-text-secondary)
테두리:       #2A2D33  (--color-border)
```

### 바로 쓸 수 있는 프롬프트 조각

> drum-room의 UI를 만든다. 어두운 연습 스튜디오 콘솔 컨셉. 다크 단일 모드.
> 배경 `--color-bg`, 콘솔 카드는 `--color-surface`에 radius `--radius-lg`.
> 액센트 앰버(`--color-accent`)는 드럼 볼륨 슬라이더와 재생 상태에만 쓴다.
> 폰트는 Pretendard, 한글은 `word-break: keep-all`.
> 컨트롤은 크게(재생 버튼 최소 64px), 간격은 `--space-6` 이상 넉넉히.
> 콘텐츠는 최대 폭 560px 중앙 정렬, 화면을 채우지 말고 여백을 둔다.
> 그라디언트·일러스트·장식 금지. HEX 직접 쓰지 말고 CSS 변수 사용.

### 1차 화면 체크리스트
- [ ] 곡 넣기: 드롭존 (기본/드래그오버 상태)
- [ ] 분리 중: 진행률 바 + 세그먼트 카운트 + 모델 다운로드 안내
- [ ] 연습: 곡 제목 + 재생/정지 버튼 + 드럼 볼륨 슬라이더 + 프리셋 3버튼
- [ ] 단계 전환은 중앙 같은 자리에서 내용 교체
- [ ] 모바일/타 브라우저 접속 시 안내 화면
