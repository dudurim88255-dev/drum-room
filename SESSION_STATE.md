# SESSION_STATE — drum-room

> 세션 시작 시 이 파일을 먼저 읽는다. "미검증 가정" 항목은 코드 작업 전 검증한다.

## 현 단계
- **2단계(움직이는 와이어프레임) — 현 시점 best baseline.**
  세 화면 + stage 전환 동작. 소리/실제 분리 없음(3·4단계).
- 2026-05-17 후속: 동일한 2단계 지시서 재제출됨 → 코드 변경 없이 현재 상태
  재검증만 수행(재구축 안 함). 정적/타입/HTTP/컴파일CSS 무회귀 + 헤드리스
  Chrome E2E 22/22 재PASS. 글로우는 트랜지션 종료 후 측정으로 강증거 확보:
  OFF=`none`, ON=`rgba(242,163,60,0.35) 0px 0px 24px 0px`(=`--shadow-glow` 일치).

## 마지막 커밋
- `42e52e7` — Initial commit from Create Next App
- ⚠ 1·2단계 변경분 **전부 미커밋** — 사용자 검토/승인 대기.
  2단계 신규/변경: `src/app/page.tsx`(client, stage 전환),
  `src/components/{UploadView,SeparatingView,PracticeView}.tsx`,
  `src/app/globals.css`(컴포넌트 클래스), `CLAUDE.md`(기술스택 줄 정정).

## 확인된 사실 (증거 있음 — 헤드리스 Chrome E2E 22/22 PASS)
- 경로 `C:\Users\윤중현\projects\drum-room`, 포트 3200, Next.js 16.2.6.
- 스모크 테스트(playwright-core + 시스템 Chrome, computed style 검증)로 전 흐름 확인:
  upload→파일선택→separating(4초 0→100, 세그먼트 N/13, 모델 81MB 안내)
  →practice 자동전환→재생토글(data-playing+글로우)→슬라이더 %→프리셋 0/25/100·선택표시.
- `tsc --noEmit` EXIT 0. 콘솔 에러 0.
- 1단계 `turbopack.root` 픽스 유지(콜드 재시작 시 워크스페이스 root 경고 없음).

## 2단계에서 root-cause 추적·해결한 결함 2건
1. **React "setState while rendering"**: SeparatingView가 `setProgress` 업데이터
   안에서 부모 `onDone()` 호출 → 콘솔 에러. → 진행률 갱신과 완료감지를
   별도 useEffect로 분리. `doneRef`/`intervalRef`로 StrictMode·중복 가드.
2. **CSS 무음 드롭**: `globals.css`의 `body{}` 이후 컴포넌트 블록 전체가
   컴파일 결과에서 사라짐. 원인 = `linear-gradient`의 **이중-위치 stop + `var()`**
   (`var(--accent) 0 var(--fill,25%)`)를 Tailwind v4의 Lightning CSS가
   파싱 실패 → 그 지점~EOF 무음 드롭(서버 로그에 에러도 없음).
   → 채움을 `background-image: linear-gradient(accent,accent)` +
   `background-size: var(--fill) 100%`(이중-위치 미사용)로 교체해 복구.
   부수 관찰: TSX에서 참조 안 되는 클래스 규칙은 이 파이프라인이 tree-shake함
   (실제 클래스는 전부 컴포넌트에서 참조 → 산출물 영향 없음).

## 미검증 가정 / 다음 판단 필요
1. 모바일/Safari 안내 화면(DESIGN.md §8, §9 체크리스트)은 2단계 task
   명시 산출물에 없어 **의도적 보류** — 브라우저 능력 게이팅이 실제로 필요한
   3·4단계(Web Audio/Worker 지원 감지)와 함께 붙이는 게 자연스러움.
2. 스모크 테스트는 일회성(임시 `%TEMP%\drumroom-e2e`, 영구화 안 함).
   회귀 방지용 상시 E2E를 둘지는 추후 결정.
3. 1·2단계 변경분 커밋 시점/단위 — 사용자 지시 대기.

## 다음 단계 (3단계) 먼저 확인할 것
- 3단계 = 재생 엔진(1차 핵심). UploadView가 저장해 둔 `file`(File 객체)을
  Web Audio로 디코드, 드럼/드럼외 2트랙 동시 재생, 드럼 게인에 슬라이더 연결.
- 잔존: 테스트로 띄운 Chrome 프로세스 일부가 남아 임시폴더 잠금
  (사용자 실제 Chrome 보호 위해 강제 종료 안 함, TEMP라 OS가 정리).
