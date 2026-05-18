# SESSION_STATE — drum-room

> 세션 시작 시 이 파일을 먼저 읽는다. "미검증 가정" 항목은 코드 작업 전 검증한다.

## 현 단계
- **3단계(재생 엔진) 완결 — 현 시점 best baseline.** 올바른 19.2초 테스트
  세트로 엔진 기계·런타임 검증 통과(23/23). 실제 소리 청취만 사용자 확인 대기.
- 음원 교체는 엔진 코드 변경 0 — "두 버퍼 받아 재생" 에셋 비의존 설계가 의도대로 동작.

## 마지막 커밋 (master)
- `<3단계 커밋 — 아래 커밋 단계에서 채워짐>`
- `76c49e6` feat: 2단계 - 화면 셸 (3-stage 와이어프레임)
- `da4ec57` chore: 1단계 - 초기 세팅 (Next.js 16, DESIGN.md, CLAUDE.md, Pretendard)
- `42e52e7` Initial commit from Create Next App

## 테스트 음원 (블로커 해소됨)
- 2026-05-18: 사용자가 `Downloads/files.zip`로 올바른 세트 제공(앱이 알려준
  대로 public/test-audio에 직접 둔 게 아니라 zip만 받은 상태였음 → 검증 후 배치).
- `public/test-audio/`: `drums.wav` / `backing.wav` / `mix-reference.wav`
  — 전부 PCM 44100Hz/스테레오/16-bit/**정확히 19.2000초**(3,386,924 bytes 동일).
- 이전 잔재(231.97초 풀곡 드럼, 8초 톤 플레이스홀더, `__selftest-*.wav`) 전부 폐기.
  README는 플레이스홀더/블로커 문구 제거하고 사실 기록으로 정리.

## 확인된 사실 (증거 — 헤드리스 Chrome E2E)
- 3단계 엔진(신 음원 23/23 PASS): AudioContext 단일(contextCreations=1 끝까지),
  그래프(drums→drumGain, backing→backingGain,→masterGain→dest), 두 트랙 decode,
  **두 소스 동일 시각 인자 동시 start**(drums===backing=1.42),
  drumGain만 슬라이더/프리셋 반영(0→0,25→0.25,60→0.6,100→1),
  **backingGain 항상 1.0**(드럼없이 포함), play/stop,
  **onended 자동정지 ~19.6s**(19.2s 트랙+시작지연, 버튼 재생 복귀),
  contextState running, 콘솔 0.
- `tsc --noEmit` EXIT 0. 3단계 이번 작업서 엔진/컴포넌트 코드 변경 없음(음원 교체만).
- 2단계: 22/22 PASS(이전). 경로 `...\projects\drum-room`, 포트 3200, Next 16.2.6.
- 헤드리스는 실제 소리 출력·"틱 잡음 없음" 청취는 검증 못 함 → 사용자 확인 대기
  (게인 스무딩 `setTargetAtTime(0.008)` 코드 적용, 게인 타깃 수렴 확인됨).

## 과거 root-cause 기록 (참고 — 재발 방지)
1. React "setState while rendering": SeparatingView setState 업데이터 안 onDone
   → effect 분리로 해결.
2. **Tailwind v4/Lightning CSS gotcha**: `linear-gradient` 이중-위치 stop+`var()`
   가 무음 드롭(그 지점~EOF). 회피=`background-size` 기법. TSX 미참조 클래스 tree-shake.
3. 2026-05-18: 사용자가 "교체했다"고 한 음원이 실제로는 디스크에 미반영
   (mtime/크기 불변)이었음 → 추측 말고 디스크 검증 후 root cause(아직 zip 상태) 확인.

## 미검증 가정 / 다음 판단
1. 모바일/Safari 안내 화면(DESIGN.md §8) — 의도적 보류. 4단계 브라우저 능력
   게이팅과 함께 붙이는 게 자연스러움.
2. 스모크 테스트 일회성(임시 `%TEMP%\drumroom-e2eN`). 상시 회귀 E2E 도입 추후.
3. `window.__drumRoomEngine` 디버그 핸들 — 검증용. 출시 전 가드/제거 검토.
4. 실제 소리 청취(성공항목 2~4: 싱크/드럼0%면 반주만/100%면 둘 다, 틱 잡음 무)
   — 사용자가 localhost:3200에서 직접 확인 대기.

## 다음 단계 (4단계) 먼저 확인할 것
- 4단계 = 분리 엔진(Demucs ONNX, onnxruntime-web, Web Worker). UploadView가
  저장해 둔 `file`을 분리 → 결과 두 트랙을 3단계 엔진 `load()`에 그대로 주입.
- 잔존: 테스트로 띄운 Chrome 프로세스가 임시폴더 잠금(사용자 실Chrome 보호
  위해 강제 종료 안 함, TEMP라 OS 정리).
