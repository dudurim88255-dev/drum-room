# SESSION_STATE — drum-room

> 세션 시작 시 이 파일을 먼저 읽는다. "미검증 가정" 항목은 코드 작업 전 검증한다.

## 현 단계
- **4-B(분리 엔진) 완료 — 현 시점 best baseline.** STFT 게이트 통과 + 브라우저
  onnxruntime-web 파이프라인이 Python ground truth 와 일치(검증 13/13 PASS).
  앱 UI 연결(4-C) 미착수. 실제 곡 분리 청취는 4-C 에서 사용자 확인.
- 4-A: htdemucs_optimized.onnx 확보·검증 완료(model-prep, gitignore).
- 3단계 재생 엔진 완결(23/23). 음원 교체에 엔진 코드 변경 0.

## 마지막 커밋 (master)
- `6fe1c76` feat: 3단계 - 재생 엔진 (드럼/반주 동시 재생, 드럼 볼륨 조절)
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

## 4-A — 분리 모델 확보 (2026-05-18, Path 1 성공)
- 파일: `model-prep/htdemucs_optimized.onnx` (gitignore됨, 앱 레포 무오염).
  크기 **171,038,235 B**, sha256 `bacfac8a892cc63515716e2eb1a652228a478bf798ecc12935a7faf708e65877`
  (LFS 포인터값과 일치 검증). `onnx.checker` OK.
- 출처: `gianlourbano/demucs-onnx` (공개 GitHub, Git LFS) —
  `public/htdemucs_optimized.onnx`. media.githubusercontent LFS로 단일 파일 다운로드.
  사용자 사전 승인 받음. (대안: 같은 레포 `demucs.onnx` 171,047,462B / `htdemucs.onnx`
  174,490,597B. HF webai-community는 gated라 부적합. GitHub releases 0개.)
- 변형: **htdemucs (Hybrid Transformer Demucs v4), 4-source.** 원본 가중치
  Meta `955717e8-8726e21a.th`에서 `convert_to_onnx.py`(torch.onnx.export, dynamo,
  opset 18)로 변환 후 onnxscript 최적화. producer=torch 2.5.0.dev.
- **입력 2개:**
  - `mix`  FLOAT `[1, 2, 441000]` — 시간영역 파형(스테레오, 441000=10s@44100Hz)
  - `spec` FLOAT `[1, 2, 2048, 431, 2]` — 호스트가 미리 계산한 STFT
    (nfft=4096, hop=1024, complex=마지막 dim 2). **STFT/ISTFT는 네트워크 밖**.
- **출력 2개(이름 자동 명명 — 4-B에서 인덱스/이 이름으로 참조):**
  - `add_76` FLOAT `[1, 4, 4, 2048, 431]` — 분리 스펙트로그램(4소스, host ISTFT 필요)
  - `add_77` FLOAT `[1, 4, 2, 441000]` — 분리 **파형**(4소스×스테레오) ← drum-room에
    바로 쓰기 좋음(ISTFT 불필요). 소스 순서 **drums, bass, other, vocals**(0..3).
- **제약:** 모든 shape **static** → 441000샘플(10s) **고정 청크**. 곡을 10s 단위로
  잘라 추론(겹침/꼬리 처리 4-B 설계 필요). SR 44100 고정, 스테레오 고정.
- drum-room 매핑: 출력 source0=drums → drums 트랙, source1+2+3 합 → backing 트랙.
- 환경: Python 3.14.4, `model-prep/venv`(onnx 1.21.0). PyTorch는 4-A 불필요(Path1).
  py3.14에 PyTorch 휠 부재 가능 → Path2였다면 변수였을 것(미발생).

## 4-B — 분리 엔진 (2026-05-18, 검증 13/13 PASS)
- 신규: `src/lib/stft.ts`(검증된 STFT), `src/lib/separation-worker.ts`(Web
  Worker: onnxruntime-web WASM 단일스레드 추론 + 10s 고정청크 + 가중 OLA
  overlap0.25/sin²창 + 진행률 + drums=src0·backing=src1+2+3),
  `src/lib/separation-engine.ts`(메인: `separate`/`separateFile` → {drumsBuffer,
  backingBuffer}, 3단계 audio-engine 입력과 맞물림). `onnxruntime-web@1.26.0` 설치.
- **STFT 검증 게이트 PASS**: JS STFT vs Python `torch.stft` ground truth
  (demucs._spec 정확 재현; demucs 패키지 없이 torch.stft 인라인 + onnxruntime
  로 .onnx 직접 실행) → **max abs err 9.5e-7 / RMSE 1.6e-8** (ref|max|6.14).
- **브라우저 ORT-web == Python ORT-py**: 단일청크 drums cos 0.99999989
  errRel 0.048%, all cos 0.999999 errRel 0.236% (구조 동일, WASM↔CPU 양성
  드리프트). 멀티청크 `separateFile` firstRegion vs Python cos 0.99999990
  errRel 0.046%, drumsRms 0.0735≪mixRms 0.234, 경계 매끄러움(seam<typ),
  진행률 3틱/3청크(Worker 비블로킹), 콘솔 0. `tsc`·`eslint` 클린.
- 레퍼런스 정정: `gianlourbano/demucs-onnx`의 useModel.js 는 Math.random()
  입력 **속도 벤치마크**(STFT/오디오/ISTFT/트랙 없음) → 이식 불가. 권위 정의
  Python `_spec`(demucs.spec.spectro=torch.stft normalized/center/reflect +
  pad1d(1536,1880) + freq/frame 트림 + complex→re/im)을 ground truth 로 재현.
- ⚠ 4-B 중 root-cause 한 실제 버그(아래 §4) — 수정·재검증 완료.
- 검증 전용 잔재(4-C 에서 제거/가드): 라우트 `src/app/sep-test/page.tsx`,
  CORS 모델서버, model-prep/gt·ref-* 클론. 모델은 4-B 에선 model-prep 로컬
  참조(앱 통합·163MB 캐시는 4-C). wasmPaths 는 jsDelivr CDN(자기호스팅 4-C 결정).

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
4. **4-B decodeAudioData 리샘플 버그**: `separateFile` 가 디바이스
   `AudioContext`(시스템 SR=48000)로 decodeAudioData → 44100 WAV 가 48000 으로
   리샘플 → 모델 입력 어긋나 출력이 Python 과 **무상관(cos≈0)**. STFT 게이트는
   Python input_chunk.npy 로 검증해 이 경로를 우회 → 못 잡음. 코사인/errRMS 로
   "드리프트 vs 버그" 판별해 발견. **수정: `OfflineAudioContext(2,1,44100)`
   로 디코드(항상 정확 44100, 임의 SR 곡도 브라우저가 44100 리샘플)**.
   재검증 cos 0.99999989. 교훈: 브라우저 오디오 디코드는 디바이스 컨텍스트 SR 로
   리샘플된다 — 모델 입력은 OfflineAudioContext 로 SR 고정.

## 미검증 가정 / 다음 판단
1. 모바일/Safari 안내 화면(DESIGN.md §8) — 의도적 보류. 4단계 브라우저 능력
   게이팅과 함께 붙이는 게 자연스러움.
2. 스모크 테스트 일회성(임시 `%TEMP%\drumroom-e2eN`). 상시 회귀 E2E 도입 추후.
3. `window.__drumRoomEngine` 디버그 핸들 — 검증용. 출시 전 가드/제거 검토.
4. 실제 소리 청취(성공항목 2~4: 싱크/드럼0%면 반주만/100%면 둘 다, 틱 잡음 무)
   — 사용자가 localhost:3200에서 직접 확인 대기.

## 다음 단계 (4-C — 1차 완성) 먼저 확인할 것
- 4-C = 분리 엔진을 앱에 연결: 곡 넣기 화면(파일) → `separateFile` →
  분리 중 화면에 **진짜 진행률**(worker progress 청크 N/총M) → 결과
  {drumsBuffer,backingBuffer} 를 3단계 audio-engine 에 주입(현재 load()는 URL
  입력 → AudioBuffer 직접 주입 오버로드 필요).
- 모델 ~163MB **첫 방문 1회 다운로드 + 캐시**(Cache API/IndexedDB) — 4-C 핵심.
  wasmPaths 자기호스팅 여부도 4-C 결정(현재 jsDelivr CDN).
- **제거/가드 대상(검증 잔재)**: `src/app/sep-test/` 라우트,
  `window.__drumRoomEngine` 디버그 핸들, sep-worker 의 디버그성 경로.
- 미커밋 변경분(4-B 커밋은 사용자 지시 대기): `package.json`/lock
  (onnxruntime-web), `src/lib/{stft,separation-worker,separation-engine}.ts`,
  `src/app/sep-test/page.tsx`, `.gitignore`(model-prep/), `SESSION_STATE.md`.
- 잔존: 테스트 Chrome 프로세스가 임시폴더 잠금(사용자 실Chrome 보호 위해
  강제 종료 안 함, TEMP라 OS 정리). model-prep(모델+venv+ref클론) gitignore됨.
