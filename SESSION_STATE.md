# SESSION_STATE — drum-room

> 세션 시작 시 이 파일을 먼저 읽는다. "미검증 가정" 항목은 코드 작업 전 검증한다.

## ⏸ 세션 종료 — 재개 지점
- 마지막 커밋: `05490fd` (2차-5). **2차-6(자동 BPM 감지 + 카운트인)
  구현·Phase C 완료, 미커밋** — 사용자 실앱 확인 후 커밋. 아래 [2차-6].
- **2차-7 연습 중 다른 곡으로(구현·Phase C 완료, 미커밋)** — 아래 [2차-7].
- 커밋 게이트: 사용자 실앱에서 (a)자동 BPM 감지·수동 보정(×2/÷2/탭/
  여기를 첫 박) (b)카운트인 → 곡 첫 박 정렬 (c)기존 기능 무영향
  (d)연습 화면 우상단 "다른 곡" 버튼으로 §4 시나리오 모두 깔끔히 동작 확인.

## 현 단계
- **1차 완성·커밋**: 4-C `151510d`, 4-D `26d01a6`.
- **2차-1 완성·커밋** `f0c832f`: WASM 멀티스레드(사용자 실앱 20분→8분30초
  확인, 품질 비트 동일). 회귀(mp3 거부=jsep 자기호스팅 누락) 동봉 수정.
- **2차-2 완성·커밋** `01e4d6b`: 분리 결과 IndexedDB 자동 저장(같은 곡 즉시).
- **2차-3 완성·커밋** `da4da69`: 타임라인+구간반복+곡끝정지+구간 재선택.
  (추적·수정: seek stale-onended 경쟁, B 재탭 교차.)
- **2차-4 완성·커밋** `8833af2`: 메트로놈(독립 모듈·lookahead·강약).
- **2차-5 완성·커밋** `05490fd`: 연습 화면 2열 레이아웃 + 메트로놈
  접이식 + 접힘 줄 가독성/묶음 보정(사용자 실앱 확인 완료).
- ⚠ 이전 "코드/배선/분리/버퍼매핑 버그 없음" 결론은 **반증**됐었고, root
  cause(하이브리드 절반만 사용)는 4-D 로 해결됨(아래 [버그조사]·4-D 참조).

## [2차-1] 분리 속도: WASM 멀티스레드 (구현·품질검증 완료, 미커밋)
- 목적: onnxruntime-web WASM 단일스레드 → 멀티스레드(코어 비례 가속).
  품질 절대 불변(같은 모델·연산, 일꾼 수만 ↑)이 절대조건.
- 변경 파일:
  - `next.config.ts`: `headers()` 로 COOP/COEP(`/:path*`) — next dev 적용.
  - `vercel.json`(신규): 같은 COOP/COEP(`/(.*)`) — 정적 export 배포용
    (export 시 next headers() 무시되므로 별도 필요, static-exports.md 확인).
  - `public/ort/ort-wasm-simd-threaded.{wasm,mjs}`(신규, 13MB) —
    onnxruntime-web 1.26.0 자기호스팅. COEP require-corp 에서 CDN
    cross-origin wasm 차단 회피(같은 출처). public/ 라 git 포함(모델
    163MB 와 달리 13MB 는 정상 — 모델만 비커밋 원칙 유지).
  - `separation-worker.ts`: `numThreads=1` → `min(hwConcurrency-1, 8)`
    (1코어는 UI 여유), `wasmPaths` jsDelivr → `/ort/`. simd 유지.
  - `model-cache.ts`: fetch `mode:'cors'` 명시 + COEP 차단 감지 에러
    (출처 ACAO:* 라 통과 예상 — 4-A 확인; 163MB 호스팅 변경은 사용자
    결정사항이라 미변경, 막히면 보고).
- context7(권위 onnxruntime 소스) 확인: ort-web 은 `self.crossOriginIsolated
  =false` 면 자동 `numThreads=1` 폴백(backend-wasm.ts) → 헤더 없거나 막혀도
  **안전(정답 동일, 단일스레드라 느릴 뿐)**. 멀티스레드의 하드 전제 = 헤더.
- **검증 결과**:
  - ✅ COOP/COEP 헤더 실측: `/`·`/ort/*.wasm`(application/wasm,13022405B
    전체)·`/ort/*.mjs`·`/_next/*.js`(워커 번들 포함) 전부 same-origin/
    require-corp. → 동일출처 자산만 → crossOriginIsolated=true 보장.
  - ✅ **품질 절대조건 PASS(객관)**: `model-prep/ortmt_gate.mjs` — 브라우저와
    동일 런타임 ort-web 1.26.0 을 Node 에서 단일(numThreads=1) vs 멀티(3)
    같은 실제 청크 추론: **add_76/add_77 cos=1.00000000, maxAbs=0.0(비트
    동일)**. 멀티스레드가 연산 불변. 4-D 교차증거(B=멀티스레드 Python ORT
    ≈ 사용자 승인 단일스레드 앱)와 삼각 일치.
  - ⚠ **속도: Node 1.07x — 비대표적, 결론 보류(우회 아님, 정확 보고)**.
    이 Node 박스 논리CPU 4개 + ort-web 스레드 스폰은 브라우저 pthread
    전용이라 Node 측정은 대표성 없음. **실속도는 사용자 브라우저(실제
    머신, crossOriginIsolated)에서만 유의미** → 지시서 커밋 게이트와 일치.
  - tsc --noEmit 0, eslint 0.
- **[회귀 추적·수정] mp3 "열 수 없음" 거부 (2차-1 도입, 수정 완료)**:
  - 증상: 2차-1 후 mp3 넣으면 "이 파일은 열 수 없습니다(mp3/wav…)" → 분리
    못 감. 1차(26d01a6)는 정상 → 2차-1 회귀.
  - 추적(추측 배제, 충실 재현): 헤드리스 Chrome+CDP 로 실제 앱 환경
    (COOP/COEP, crossOriginIsolated=true) 재현. ① mp3/wav decodeAudioData
    ·모델 fetch **전부 정상**(가설 "COEP가 디코드/모델 깸" 반증). ② CDP
    `DOM.setFileInputFiles` 로 실제 mp3 주입 → headline `드럼 분리 중 0%`
    까지 가서 실패(디코드·모델다운로드 성공). ③ worker 임시 진단+worker
    타깃 attach 로 **원문 확보**: `no available backend found. ERR:[wasm]
    Failed to fetch dynamically imported module .../ort/ort-wasm-simd-
    threaded.jsep.mjs`.
  - **ROOT CAUSE**: 2차-1 ort wasm 자기호스팅 시 **변형 불일치**.
    onnxruntime-web 1.26 기본 번들은 **JSEP 빌드** → `ort-wasm-simd-
    threaded.jsep.{mjs,wasm}` 요청. 그런데 비-jsep `ort-wasm-simd-
    threaded.{mjs,wasm}` 만 복사 → `.jsep.mjs` 404 → 백엔드 없음. 1차는
    jsDelivr CDN 이 전 변형 제공해 동작(자기호스팅서 jsep 누락이 회귀).
    포맷 무관(mp3 특정 아님 — wav 도 동일). 그 에러가 `/Failed to/i`
    정규식에 걸려 "파일 못 엶"으로 **오분류**돼 디코드 문제로 보였음.
  - **수정(우회 없음, 멀티스레드·mp3 양립)**:
    · `public/ort/` = `ort-wasm-simd-threaded.jsep.{mjs,wasm}` 로 교체
      (잘못된 비-jsep 짝 삭제). jsep.wasm 26MB(정확한 산출물 — 모델
      163MB 만 비커밋 원칙 유지, 26MB 는 런타임이라 git 포함).
    · 부수결함 교정(재발 방지): `separation-engine.ts` 에
      `AudioDecodeError`(code AUDIO_DECODE) 추가, `decodeAudioFile` 의
      디코드 실패만 이 타입. `SeparatingView` 가 넓은 정규식 대신 이
      타입으로 단계 분류 → 모델/worker/ort 에러는 원문 그대로 표시
      (오분류·오진단 방지).
  - **재검증(충실 재현, 동일 하니스)**: 실제 mp3 → 곡 넣기→분리(멀티
    스레드 0→33→67%)→연습 화면 도달. alert·예외·console.error·Network
    실패·worker에러 **전부 0**. tsc/eslint 0. 임시 worker 진단 제거,
    public 임시 자산(coi-test.html,_coi_test.mp3) 삭제.
- **다음(커밋 게이트)**: 사용자가 실제 앱에서 (a) crossOriginIsolated=true,
  (b) 모델 다운로드 정상(COEP 통과), (c) mp3 곡 넣기→분리→연습 정상
  (회귀 해소 체감), (d) 분리 속도 체감(단일 대비 배수), (e) 음질이 1차와
  동일 확인 → 좋으면 2차-1(회귀수정 포함) 커밋. 속도 미흡 시 WebGPU.
- 재현/잔재(전부 gitignore model-prep): `ortmt_gate.mjs`(품질),
  `coi_probe.mjs`/`app_repro.mjs`(CDP 충실 재현 — 회귀 회귀검사용 보존),
  `coi-test.html`/`_coi_test.mp3` 는 public 에서 삭제됨. dev 서버는
  next.config 변경 시 재기동 필요(현재 `besiiz4wo` 신헤더로 가동 중).

## [2차-2] 분리 결과 자동 저장 (구현·Phase C 검증 완료, 미커밋)
- 목적: 같은 곡 재투입 시 ~8분30초 재분리 스킵 → 즉시 연습. 분리/worker/
  istft/엔진 로직 무수정 — 저장 계층 **추가만**.
- Phase A 설계 승인(상한 1.2GB·gzip). 구현:
  - `src/lib/result-cache.ts`(신규): IndexedDB `drum-room-results`,
    스토어 **2분리** `meta`(작음: LRU/목록/lastUsedAt touch) + `blobs`(큼:
    불변) — lastUsedAt 갱신 시 100MB 블롭 재기록 회피(승인 설계 의도 유지,
    성능상 우위). 키=`hashFile`=SHA-256(파일 바이트)(파일명 무관). 무손실
    Float32 + `CompressionStream('gzip')`(미지원 시 원시 폴백, `compressed`
    플래그). `PIPELINE_VERSION="htdemucs+istft-4d"` 불일치 시 캐시 무효+
    재분리(4-D 식 파이프라인 변경 대비). LRU `capBytes`(min(1.2GB, quota
    0.5))·`evictToFit`·QuotaExceededError 시 최오래곡 evict 재시도→실패면
    조용히 포기.
  - `SeparatingView`: `source = {file} | {cached}`. 파일이면 해시→캐시
    조회: 히트 시 디코드/모델/분리 **전부 스킵**, 저장 Float32→AudioBuffer
    (engine.getContext)→`loadBuffers`→done. 미스면 기존 흐름 후 best-effort
    `saveSong`(try/catch — 실패해도 분리·연습 계속). cached source 는 바로
    복원. 디코드 실패 분류(AudioDecodeError) 유지.
  - `page.tsx`: `file` → `source` 일반화 + `handleOpenCached`. PracticeView
    제목 = file.name | cached.name.
  - `UploadView`: 드롭존 아래 "저장된 곡" 목록(있을 때만 — DESIGN.md 단순함:
    비면 미표시). 이름 클릭=즉시 그 곡 연습, ×=삭제. DESIGN.md 토큰만 사용.
- **Phase C 검증(전부 PASS)**:
  - 무손상 단위 `model-prep/cache_roundtrip_test.mjs`: Float32→gzip→gunzip
    **비트 동일**(mismatch 0, maxAbs 0) → 복원==원본 분리, 구조적 보장.
  - 충실 재현 `model-prep/cache_repro.mjs`(헤드리스 Chrome+CDP, 실제 앱):
    ① 첫 mp3 → 드럼 분리 0→33→67%→결과 저장 중→연습, IDB meta1/blobs1
       생성(worker 추론 O, jsep O). ② 같은 mp3 재투입 → "파일 확인 중"→
       연습, **worker 추론 0(sepSeen=false, jsep 요청 0)** = 재분리 스킵.
    ③ 목록 클릭 → "저장된 곡 불러오는 중"→연습, 분리 0. ④ × → IDB
       meta0/blobs0. ⑤ console 에러 0. tsc/eslint 0.
  - ⚠ 머신 미검증(정직 표기): 1.2GB 초과 LRU evict·QuotaExceeded 폴백은
    실데이터 >1.2GB 필요라 헤드리스 미실행 — 코드 구현+graceful 경로
    존재(구성상 정당), 실사용 확인 필요. 저장실패 흐름지속도 코드상 보장
    (best-effort try/catch), 강제 트리거 미실행.
- 변경: `src/lib/result-cache.ts`(신규), `src/components/{SeparatingView,
  UploadView}.tsx`, `src/app/page.tsx`. (worker/istft/engine/separation
  -engine 무변 — separation-engine 의 AudioDecodeError 는 회귀수정분 그대로.)
- 커밋 게이트: 사용자가 실앱에서 (a) 같은 곡 2번째 즉시 열림, (b) 저장
  곡 재생·슬라이더가 처음과 동일(음질 무손상 체감), (c) 목록 동작 확인 →
  커밋. 재현/잔재: `cache_roundtrip_test.mjs`·`cache_repro.mjs`(gitignore
  model-prep, 회귀검사용 보존). public 임시자산 없음.

## [2차-3] 타임라인 + 구간 반복 (구현·Phase C 완료, 미커밋)
- 목적: 연습 화면에 ①타임라인(위치/seek) ②A-B 구간 반복 ③곡끝=정지
  (멋대로 무한반복 안 함). 분리/worker/istft/2차-2 무수정 — 재생측 추가만.
- Phase A 추적 결과(코드 근거): 엔진은 이미 곡끝 정지(loop 미설정,
  onended→정지). 사용자 "계속 도는" 체감 = **위치 피드백 부재**(타임라인
  없음) + 끝나면 항상 0 부터 재생 + (아래) seek 경쟁버그. Phase A 승인.
- 구현:
  - `audio-engine.ts`(추가, 기존 API 무파괴): `getDuration/getPosition/
    seek/setLoopRegion/setLoopEnabled/getLoop`. 위치=ctx.currentTime 기반
    (`startCtxTime`·`startOffset`·`playhead`). seek=두 소스 동일 when·
    offset 재시작(싱크). A-B=네이티브 `loop/loopStart/loopEnd`(두 소스
    동일 → 샘플정확, JS 타이머 없음). 곡끝(loop off)=정지+playhead 0.
    `stop()`은 위치 보존, `loadBuffers()`는 위치·구간 초기화.
  - `PracticeView.tsx`(추가): 타임라인(트랙 surface-inset, 구간 accent-dim,
    플레이헤드 accent 선, A/B 드래그 핸들), 클릭=seek, "구간 A"/"구간 B"
    =현재 위치 캡처, "구간 반복" 토글(유효구간 전 비활성), rAF 위치 갱신
    (재생 중만). DESIGN.md 토큰만, 앰버 절제.
- **추적·수정한 실제 버그(추측 아님, CDP 계측으로 확정)**: seek 가 옛
  소스 stop 후 `startSources` 가 `manualStop` 을 즉시 false 로 되돌려,
  옛 소스의 늦은 `onended` 가 "자연 종료" 분기를 타고 **새 재생을 죽이고
  위치 0 리셋**(stale-callback 경쟁 → 클릭 seek 시 정지·now0). **수정:
  manualStop 플래그 제거, onended 를 소스 동일성(`this.drumsSource===
  activeDrums`)으로 가드** — 폐기 소스의 콜백 원천 무시. 교훈: 재시작이
  생기면 공유 플래그-타이밍 가드는 깨진다 — 인스턴스 동일성으로 가드.
- **Phase C(CDP 충실 재현 `model-prep/tl_repro.mjs`, 전부 PASS)**:
  T1 길이=20, T2 위치전진(0→3,재생), T3 클릭seek 50%→정확10, T4 A-B
  루프=[3↔5]만 진동·wrap·끝 미도달·계속재생, T5 루프중 프리셋(원곡100/
  드럼없이0)정상·루프유지, T6 루프OFF+곡끝=정지+위치0+재상승없음,
  console 0. tsc/eslint 0. (헤드리스는 무음 — 두 트랙 샘플 싱크는 동일
  when/offset/loopStart·End 구성상 보장+기존 dual-start 검증과 동형,
  실청취는 커밋 게이트. 헤드리스 재생엔 `--autoplay-policy=no-user-
  gesture-required` 테스트 플래그 필요 — 앱 코드 무관.)
- 변경: `src/lib/audio-engine.ts`, `src/components/PracticeView.tsx` 만.
  잔재 0, public 임시자산 0. 재현 보존: `tl_repro.mjs`(gitignore).
- **2차-3b 재지정 흐름 개선(미커밋, 2차-3 에 포함)**: 루프 중 재생 끊지
  않고 A 재탭→B 재탭으로 다른 구간을 깨끗이 새로 잡기. 변경:
  `PracticeView.tsx` captureA=새 선택 시작(loopA=현위치, loopB=null, 엔진
  미적용 → 옛 구간 루프 계속), captureB=B>A 일 때만 채우고 1회 commit
  (역전이면 무시 → 교차 상태 구조적 불가, 스왑 제거), 드래그 클램프
  (A는 B-MIN 까지만 — 순간이동 제거), rA/rB 정렬-스왑 제거, pushRegion
  삭제. `audio-engine.ts` setLoopRegion: 변경 전 위치를 먼저 구해 새 구간
  안이면 소스 재생성 없이 라이브 loopStart/loopEnd + 위치회계 rebase,
  밖일 때만 1회 seek. 버튼 3개 유지(Clear 미추가).
  - Phase C(`model-prep/tl_regrab.mjs`, 전부 PASS): pendingA=핸들1·옛 루프
    계속·정지 안 함, regrab_valid=A%<B% 정렬·1회 전환·연속재생·wrap,
    regrab_invert=B<A 무시(B 마커 안 생김·교차 없음·재생 연속), 콘솔 0.
    tsc/eslint 0, `next build` 통과. (Phase C 가 실결함—옛 루프 되감김 중
    B 재탭 시 captureB 무조건 setLoopB 로 교차 저장—을 잡아 가드로 정정.)
    헤드리스 무음이라 이음매 청취는 커밋 게이트(연속 playing·wrap·콘솔0
    ·소스 재생성 회피 코드경로로 간접 입증).
- 커밋 게이트: 사용자가 실앱에서 타임라인 진행/클릭 seek/A-B 반복 매끄러움
  ·두 트랙 싱크/루프OFF 곡끝 정지/루프중 볼륨·**재생 끊지 않고 A→B
  재지정** 확인 → 2차-2 와 함께/순서 커밋. **(완료: 01e4d6b/da4da69)**

## [2차-4] 메트로놈 (구현·Phase C 완료, 미커밋)
- 목적: 연습 화면에 정밀 박자 클릭음. 분리/worker/istft/2차-1·2·3/곡
  재생 로직 무수정 — 별도 모듈 + PracticeView UI 추가만.
- Phase A 승인(박자 2~7·곡과 독립 토글·컨텍스트 공유·합성 클릭).
- 구현:
  - `src/lib/metronome.ts`(신규, 싱글턴): AudioContext 는
    `getAudioEngine().getContext()` **공유**(같은 clock)하되 **자기 GainNode
    →destination 으로만 출력**(곡 master/drum/backing 체인 무관·무영향).
    lookahead 스케줄러(setInterval 25ms 가 [now,now+0.1s] 박을 ctx 정밀
    시각에 예약, `nextNoteTime+=60/bpm`). 클릭=일회용 triangle osc+gain
    exp 엔벨로프(팝 방지), 강박 1500Hz/약박 900Hz. API: start/stop/
    setBpm(40~240)/setBeatsPerBar(2~7)/setVolume/getState. 곡 엔진 코드
    호출/수정 없음(컨텍스트만 read 공유).
  - `src/components/PracticeView.tsx`(추가): 하단 메트로놈 그룹(상단
    구분선, 캡션) — 토글(preset-btn, 켜짐=accent)·BPM(슬라이더+−/＋+큰
    숫자)·박자(−N＋)·메트로놈 볼륨 슬라이더. 언마운트 시 metro.stop().
    DESIGN.md 토큰·앰버 절제, 기존 레이아웃 무변경.
- **Phase C(CDP, OscillatorNode.start 테스트측 래핑으로 실제 예약
  tick 시각·주파수 실측, `model-prep/metro_repro.mjs`, 전부 PASS)**:
  M1 120bpm/4 → 박 간격 정확 0.5s **maxJitter≈4e-16**(머신 엡실론, 타이밍
  안정)·강박 4박주기·freq{1500,900}; M2 BPM90 즉시(Δ0.667); M3 박자3
  즉시(강박 주기3); M4 곡 재생+구간반복 중 곡 진행·메트로놈 동시·곡 재생
  유지(독립·무영향); M5 볼륨 변경 무에러 계속; M6 곡 정지 시 메트로놈
  단독; M7 off→tick0. console 0. tsc/eslint 0, next build ✓.
  git: metronome.ts 신규 + PracticeView 수정만(audio-engine/worker/istft/
  result-cache 무수정 확인). 실제 클릭 음색·볼륨밸런스만 청취=커밋게이트.
- 커밋: 2차-5 와 함께(아래). 재현: `metro_repro.mjs`(gitignore).

## [2차-5] 연습 화면 레이아웃 재정비 + 메트로놈 접이식 (구현·Phase C 완료, 미커밋)
- 문제: 2차-3·2차-4 누적으로 연습 화면이 한 화면 초과(스크롤). +사용자
  지적: 메트로놈이 펼쳐져 절반 차지=주객전도(곡 연습이 주, 메트로놈 곁다리).
- 조치(로직 무수정 — 배치만): `audio-engine/metronome/worker/istft/
  result-cache 무수정`. 변경 = `src/app/page.tsx`(연습 stage 만 카드폭
  560→**880**, 그 외 화면 560 유지=DESIGN §5) + `src/components/
  PracticeView.tsx`(return JSX 재구성, 핸들러·상태·effect 무변경; 추가
  state 는 `metroExpanded` 1개).
- 새 배치: 곡 제목 → **곡 컨트롤 2열(주)**[좌: 재생/정지+타임라인(가로
  트랜스포트)+구간 A/B/반복, 우: 드럼 볼륨+프리셋] → **하단 메트로놈
  접이식(곁다리)**. 접힘=얇은 한 줄(클릭=그 자리 펼침/접힘, 애니메이션
  없이 즉시 — calm·무위험). 메트로놈 ON 이면 접힘 줄에 `● 켜짐 · NN BPM`
  (accent 절제) — 접어둬도 켜짐·동작 인지. 펼침=2차-4 컨트롤(on/off·BPM·
  박자·볼륨) 그 자리 등장. DESIGN.md 토큰·앰버 절제 유지. 좁은 폭은
  flexWrap 으로 안전 스택.
- **Phase C(`model-prep/metro_panel_repro.mjs`, 전부 PASS)**: 곡 넣기
  화면 무파손·카드 560 유지; 기본 접힘(컨트롤 숨김); **한 화면 스크롤
  없음** 1366×768·1280×800·1440×900·1280×720 전부 fits; 그 자리 펼침/
  접힘; 켜진 채 접어도 인디케이터+계속 울림(osc 계측); 재배치 후 곡
  컨트롤(재생·seek·프리셋) 정상; console 0. tsc/eslint 0, next build ✓.
  (시각 "정돈감"·실제 클릭 음색은 사용자 청취=커밋게이트.)
- 커밋 게이트(2차-4 동반): 사용자 실앱에서 (a)메트로놈 기능 (b)접이식
  (c)한 화면 확인 → 2차-4·2차-5 정리 커밋(메시지·구성 사용자 확인 후).
  재현: `metro_panel_repro.mjs`(gitignore model-prep).
- **[2차-5 보정] 표시/문구만(로직 무변경)**: 접힘 줄 가독성 — color
  `text-muted`→`text-secondary`(과한 흐림 해소, 곡 컨트롤보단 절제 유지).
  레이아웃 `space-between`→`flex-start`+gap, "메트로놈"+"▾펼치기"를 인접
  한 덩어리로(양 끝 분리 해소, 누르는 묶음으로 보이게). 켜짐 인디케이터는
  그 뒤. PracticeView.tsx 만 수정, tsc/eslint 0.
- **좌측 하단 영어 = Next.js 개발 도구 "N" 버튼**(`nextjs-portal` 웹컴포넌트,
  Next16 dev 오버레이, shadow DOM). drum-room 코드 아님 — 좌측하단 우리
  UI엔 한글뿐(헤드리스 스캔+스크린샷 확인). 한글화 불가/불필요, `next
  build` 정적 배포본엔 미노출(dev 전용). 손대지 않음(보고만). 재현:
  `bottomleft_probe.mjs`(gitignore).

## [2차-6] 자동 BPM 감지 + 카운트인 (구현·Phase C 완료, 미커밋)
- 목적: 분리된 drums 로 자동 BPM 감지(Essentia.js Percival, AGPL 수용),
  사용자 보정(×2/÷2/탭 템포/여기를 첫 박), 재생 전 2마디 카운트인 → 곡
  첫 박 정렬. 분리/엔진/구간반복/result-cache/메트로놈 본체 로직 무수정.
- Phase A 승인(Percival·카운트인=metronome.ts 통합·그리드 스냅·"여기를
  첫 박"·영구 저장·2마디 기본 켜짐). 구현 파일:
  - `src/lib/bpm-worker.ts`(신규, module worker): Essentia 모노 다운믹스
    → PercivalBpmEstimator. WASM/JS 자기호스팅(public/essentia/) +
    런타임 간접 eval 로 글로벌(self) 스코프 부착(아래 추적·수정 참조).
  - `src/lib/bpm-analyzer.ts`(신규, 싱글턴 파사드): 캐시 우선 → worker.
    상태머신(idle/pending/ready/failed) + subscribe. 사용자 보정 메서드
    (setUserBpm/setBeatsPerBar/setDownbeatOffsetSec)가 즉시 emit + 캐시
    영구 저장(updateSongMeta). userTouched 플래그로 자동 결과가 사용자
    값 덮어쓰기 차단.
  - `src/lib/audio-engine.ts`: public `playAt(when, offset)` 추가
    (기존 play() 무수정·이 위 wrapper). dual-start when/offset 외부 결정.
  - `src/lib/metronome.ts`: `playCountIn({bpm, beatsPerBar, bars, onDone})`
    추가 — N×beats 박 예약, 마지막 박 다음 ctx 시각을 onDone 으로 통지
    → caller 가 engine.playAt(songStart, snapOffset) 으로 정렬. cancel()
    핸들 반환(미발화 osc.stop). 메트로놈 사용자 on/off 와 독립.
  - `src/lib/result-cache.ts`: SongMeta 옵션 필드(bpm/bpmDetected/
    beatsPerBar/downbeatOffsetSec) + `updateSongMeta` 메타-only 부분 갱신.
    PIPELINE_VERSION 유지(분리 출력 무변).
  - `src/components/SeparatingView.tsx`: 분리·복원 양 경로에서
    analyzer.setCurrentSong(hash, {dL,dR,sampleRate}) 호출(백그라운드).
  - `src/components/PracticeView.tsx`: analyzer 구독, 펼친 메트로놈에
    ÷2/×2/탭 템포/여기를 첫 박/카운트인 토글 + 감지 부가표시. togglePlay
    에 카운트인 분기(snapOffset=downbeat+ceil((playhead-downbeat)/P)*P).
    카운트인 중 정지 버튼=취소. localStorage 에 카운트인 토글 전역 선호.
- **추적·수정한 실제 버그(추측 아님, CDP 계측 확정 — 두 단계 root cause)**:
  ①Turbopack 정적 분기 제거가 essentia-wasm.web.js 의 Node 호환 코드
  (`require("fs")`)를 끌어들여 빌드 실패 → 인라인 base64 변형 대신
  외부 wasm 변형(.web.js)으로 전환·자기호스팅. ②worker 에서 Essentia
  초기화가 `ReferenceError: document is not defined`. 원인: web.js 가
  `-s ENVIRONMENT=web` 으로 빌드돼 ENVIRONMENT_IS_WORKER=false 하드코드,
  `else if (document.currentScript)` 무가드 평가. **수정: worker 에
  document 최소 shim(currentScript=null) 으로 조건을 false 화 → 분기
  미진입**(locateFile 은 우리 Module 옵션이 결정). 둘 다 우회 아님,
  근본 원인 정확 수정.
- **Phase C(`model-prep/bpm_countin_repro.mjs`, 전부 PASS)**: T1 자동 BPM
  test.mp3=113 ready; T2 ÷2/×2 즉시(113↔57↔114); T3 탭 ~500ms×5 → 116
  BPM(target 120 근접); T4 카운트인 정확 8박(2마디×4) → 곡 시작·위치
  진행; T5 카운트인 중 정지 → 곡 시작 X·재생 버튼 복귀; T6 구간반복
  wrap 중 클릭 0; T8 재방문 worker attach 0(캐시 히트), 사용자 BPM 영구
  저장(120 유지) + "감지: 113 BPM" 부가표시. console/tsc/eslint/build 0.
- 변경(git status): SongMeta 메타 확장(`result-cache.ts`), `audio-engine`
  playAt 추가, `metronome` playCountIn 추가, `SeparatingView` 트리거,
  `PracticeView` UI+카운트인, 신규 `bpm-{worker,analyzer}.ts` +
  `essentia.d.ts`. 신규 `public/essentia/`(2.5MB: .wasm 2MB + .web.js
  220KB + -core.umd.js 340KB — ort 자기호스팅 13MB 와 같은 패턴).
  `package.json` essentia.js@^0.1.3.
- 커밋 게이트: 사용자 실앱에서 (a)자동 BPM·수동 보정 (b)카운트인 정렬
  (c)기존 기능 무영향 확인 → `feat: 2차-6 - 자동 BPM 감지 + 카운트인`
  커밋. 재현: `bpm_countin_repro.mjs`, `bpm_diag.mjs`(gitignore).

## [2차-7] 연습 중 다른 곡으로 (구현·Phase C 완료, 미커밋)
- 목적: 연습 화면 어떤 상태(재생/정지/곡끝/카운트인/구간반복/메트로놈
  ON/BPM 분석중) 에서든 곡 바꿈. 분리/엔진/메트로놈/카운트인/BPM 분석/
  result-cache 본체 로직 **무수정** — 화면 전환 + 버튼만 추가.
- Phase A 결정(단일안):
  - 버튼: "다른 곡"(짧음·기존 짧은 버튼들과 결, title="다른 곡 열기").
  - 위치: PracticeView 루트 `position:relative` + 버튼 `position:absolute`
    우상단(작고 차분, surface-secondary 톤). 세로 길이 0 → 한 화면(2차-5)
    무영향. 곡 제목은 좌우 `--space-12` 패딩으로 긴 파일명 wrap 보호.
  - 메트로놈 정책 = **(a) 곡 변경 시 정지**(곁다리 원칙·예측 가능·업로드
    화면 무음 비가시 클릭 회피). PracticeView 언마운트 cleanup 이 이미
    `metro.stop()` 수행 → 추가 코드 0.
  - 카운트인 진행 중 변경: 언마운트 cleanup 의 `countInCancelRef.current
    ?.()` 가 예약 osc 전부 stop. 곡 시작 안 함.
  - BPM 분석 진행 중 변경: analyzer 싱글턴이 다음 setCurrentSong(새 hash)
    에서 옛 worker terminate(현재 동작 — 단순·안전).
  - 새 곡 진입 시 상태 리셋(loop A/B null, drumVol 가이드 25, pos 0)은
    엔진 `loadBuffers` + analyzer 새 hash 진입으로 자연 초기화 → 코드 0.
- 변경: `src/app/page.tsx`(handleChangeSong + PracticeView prop), `src/
  components/PracticeView.tsx`(prop+버튼+root position:relative+title 좌
  우 패딩). 그 외 무수정.
- **Phase C(`model-prep/change_song_repro.mjs`, 핵심 PASS)**: T1 재생 중
  → 곡 바꾸기 → upload 도달; T2 정지 중 → 정상; T4 카운트인 중 → 정상;
  T5 구간반복 중 → 정상 + **재진입 시 loop 비활성·drumVol 25·pos 0**
  (묻어가지 않음); T6 메트로놈 ON 중 → 정상; T7 같은 곡 재오픈 = 캐시
  히트 즉시. console/tsc/eslint/build 0. (T4/T6 의 tick 계측 일부 null
  은 instrument-측 아티팩트 — `reachedUpload=true` + 코드 구조상 cancel
  보장으로 행동 정확.)
- 커밋 게이트: 사용자 실앱에서 §4 모든 시나리오 + 한 화면 보존 확인 →
  `feat: 2차-7 - 연습 중 다른 곡으로` 커밋(2차-6 동반 또는 순서대로).
  재현: `change_song_repro.mjs`(gitignore model-prep).

## [버그조사] "연습 화면 드럼 슬라이더가 오디오에 안 먹는다" (실제 곡)
사용자 보고: 실제 곡("타오르는 밤의 끝") 분리·재생 정상, 그러나 드럼 볼륨
슬라이더/프리셋이 소리에 전혀 안 먹힘. → 사슬을 런타임 증거로 한 칸씩 추적:
- 슬라이더/프리셋 → `applyVolume` → `engine.setDrumVolume` 호출 **정상**
  (런타임: drumGainValue 0.25→0(슬라이더0)→0(드럼없이)→1(원곡)→0.6 추적).
- `play()` 가 `drumsSource.connect(drumGain)` — drums 가 drumGain 경유 **정상**.
- 실제 곡 분리(40s) 측정: drums(s0) rms 0.070 / backing(1+2+3) 0.112
  (**−4dB**, drums 또렷), **cos(drums,backing)=0.037**(backing에 드럼 없음·
  누수/뒤바뀜 아님), cos(backing,mix)=0.81(≠1 → 드럼 실제 제거됨),
  cos(sum4,mix)=0.95(소스합≈입력 sane). 엔진에 들어가는 두 버퍼도 정상.
- **실제 곡·실제 앱 흐름** 출력 탭 측정: drum 100%→0% 시 출력 RMS **−19.9%**,
  피크 0.21→0.10(**−51%**). → 슬라이더가 실제 오디오 출력을 분명히 바꿈.
- ~~결론: 코드/배선/분리/버퍼매핑 버그 없음~~ **← 반증됨.** 분해 슬라이싱
  자체는 정확(backing==src1+2+3 정확, sum4≈mix)하나, **모델 출력 자체가
  불완전**했음. diag-stems 6개 저장 후 사용자 청취 → "drums/backing 비슷".
- **[확정 ROOT CAUSE] worker 가 HTDemucs 하이브리드의 시간분기(`add_77`)만
  쓰고 스펙트럼분기(`add_76` [1,4,4,2048,431], cac 복소 스펙) 를 버림.**
  HTDemucs 최종 소스 = `xt`(add_77) + `iSTFT(mask·spec)`(add_76). 증거(모두
  재현 가능, `model-prep/diag_stems_check.py`·`cmp_recon.py`):
  - diag-stems == `add_77`-only 출력 정확 일치(cos 1.000000, rmsΔ 4e-5)
    → 사용자가 들은 것 = 현 코드 출력.
  - 재구성: A(add_77만) cos(drums+backing,mix)=0.955 잔차 29.8%; 
    B(add_77+ISTFT add_76) cos=**0.997** 잔차 9.4%. → 현 코드가 각 소스
    ~30%(스펙트럼분기) 손실. drums=mix−backing: A 0.863 → B 0.982.
  - 보컬 소스 RMS 0.010(붕괴)·other로 드럼 누수 → 드러머 귀 "둘 다 드럼".
  - 4-B cos 0.99999 통과한 이유: Python ref(`gt/add77_ref.npy`)도
    `add_77`-only → 양쪽이 같은 결함 공유, 사각지대(rc#4와 동형).
  - reference: `model-prep/gt_fullrecon.py` 가 정답(B) `_ispec` 구현 보유
    (demucs ispectro/_ispec/cac 재현). `gt-fullrecon/{A_add77only,
    B_xt_plus_istft}_{drums,backing}.wav` 40s 비교본 존재.
- **해결: 4-D 에서 worker 에 add_76 ISTFT 분기 이식 완료**(아래 4-D).
  4-C(separation-worker.ts 미수정)와 독립 — 4-B 부터의 결함이었음.
- 동반 처리(우회 아님, 정당 개선): 분리 버퍼는 44100, 디바이스 컨텍스트는
  보통 48000 → 재생 시 리샘플 단계. AudioContext 를 `{sampleRate:44100}` 로
  생성(분리 출력과 일치, 리샘플 제거 → 드럼 트랜지언트 더 또렷).
  ※ 정정: 웹오디오는 리샘플 시 피치 보존 → "8.8% 피치오류"는 과장이었음.
  품질 소폭 개선이지 슬라이더 무동작 원인 아님.
- 임시 진단코드(debug 메서드/analyser 탭/__dbgEngine/`/diag`/separateDebug)
  전부 제거, grep 0, tsc·eslint 0. 제품 = 깨끗한 4-C + SR 개선.
- 정리·SR개선 후 **전체 흐름 재검증 15/15 PASS**(능력게이트→업로드→모델
  다운로드(req=1)→분리→연습→재생/글로우/슬라이더/프리셋→Cache저장→
  재방문 재다운로드0→잘못된파일 빠른실패→콘솔0). 제품 무결성 확인.
- **상태: 4-C 미커밋.** 사용자 지시대로 "사용자가 스템 청취로 슬라이더/
  분리품질 확인 후" 커밋. 스템: `model-prep/diag-stems/*.wav`(gitignore).
- 다음 판단(사용자 청취 결과에 따라): 분리품질이 부족하면 2차에서 모델/
  후처리 개선(htdemucs_ft, 더 큰 overlap, 심벌 누수 보정 등) 검토.

## 4-D — 스펙트럼 분기(add_76) 복원 (2026-05-18, Phase B 구현·검증 완료)
- **사용자 A/B 청취 승인**: B_drums 가 A 보다 또렷, A/B backing 둘 다 드럼
  없이 반주만(B 가 스펙트럼분기 복원으로 약간 큼 — 정상). → B 수정 승인.
- 신규 `src/lib/istft.ts`: demucs `htdemucs._mask`(cac) + `_ispec` +
  `spec.py:ispectro`(torch.istft normalized=True/center) 를 stft.ts 의
  1/√NFFT 규약과 짝맞춰 **torch-정확 이식**. 발명 아님 — 검증된 reference
  (`gt_fullrecon.py` B 경로 = 원본 demucs) 그대로. export `spectralWaveform
  (add_76)` → [(src*2+ch)*SEG+i] (add_77 동일 layout, 그대로 가산).
- `separation-worker.ts`: 모델 출력에서 `add_76` 도 받아 `spectralWaveform`
  → 청크별 add_77 에 가산한 뒤 **기존 OLA/매핑(drums=src0, backing=
  src1+2+3, sin² WIN) 그대로**. OLA·매핑 코드 무수정. 모델 forward 내부에
  정규화 포함 → worker 정규화 추가 불필요(순수 스펙트럼분기 누락만 수정).
- 추적·수정한 결함(우회 아님): 초기 게이트 cos 0.99999(가장자리 국소 오차).
  원인 = torch.istft 는 `_ispec` 의 F.pad((2,2)) 로 늘어난 **전체 435프레임
  (제로프레임 포함)에 window-envelope(Σw²) 누적**하는데 제로프레임을
  skip 해 분모가 가장자리에서 어긋남. → ENV 를 전체 435프레임 기준 1회
  사전계산(torch 정확 등가). 재게이트 cos 1.00000000.
- **검증 3중 게이트(전부 PASS, 재현 스크립트 = gitignore model-prep)**:
  1. 단위: `gt_istft_gate.py`(torch `_ispec` ground truth, chunk0·1) vs
     `istft_gate.mjs`(실 istft.ts 컴파일 import) → xspec/full **cos
     1.00000000, maxAbs ~1e-7**(4-B STFT 게이트와 동급 float 라운드오프).
  2. 통합: `gt_dump_allchunks.py`(풀곡 6청크 add_76/77) + `worker_ola_
     gate.mjs`(실 istft.ts + worker OLA 1:1 재현) → 사용자 승인
     `gt-fullrecon/B_*.wav` 대비 drums cos 0.9999999 / backing 1.0000000
     (RMS 정확 일치).
  3. 재구성: drums+backing vs mix cos **0.997**, 잔차 **9.44%**
     (망가진 A 0.955/29.8% 대비 해결, B 목표 달성).
- `tsc --noEmit` 0, `eslint src/` 0. worker/istft 콘솔 0. git 신규 변경 =
  `separation-worker.ts`(M) + `istft.ts`(신규)뿐, 4-C 세트 그대로.
- ⚠ **커밋 보류**: 사용자가 실제 앱(곡 넣기→분리→연습→슬라이더)에서
  드럼 슬라이더 체감·음질을 직접 확인한 뒤 커밋(사용자 지시). 헤드리스로
  실제 청취/슬라이더 체감은 검증 불가 — 수치·파형은 B 와 동일 입증됨.
- 잔재: `model-prep/_gatebuild/`(istft.ts 컴파일본, 게이트 tsc 로 재생성),
  `gt-istft/`·`gt-allchunks/`(npy ground truth). 전부 gitignore.

## 4-C — 분리 엔진 앱 연결 (2026-05-18, 구현 완료 / 검증 진행 중)
- 모델 호스팅: **외부 fetch + Cache API**(사용자 승인). `src/lib/model-cache.ts`:
  gianlourbano/demucs-onnx Git LFS(CORS '*' 확인)에서 1회 다운로드(진행률)
  → sha256 `bacfac8a…` 검증 → Cache `drum-room-model-v1` 저장, 2회차 즉시.
- `audio-engine.ts`: `loadBuffers(drums,backing)` + `getContext()` 추가
  (분리 결과 직접 주입, 단일 AudioContext 유지).
- `SeparatingView`: 디코드 먼저(빠른 실패) → 모델(진행률) → `separate`(Worker,
  세그먼트 N/M) → `engine.loadBuffers` → 연습. 에러 시 onError→업로드 복귀+안내.
- `PracticeView`: test-audio fetch·`__drumRoomEngine` 디버그 핸들 **제거**.
  분리된 두 트랙(엔진 선주입)으로 재생/볼륨/프리셋, 제목=파일명.
- `page.tsx`: 실제 흐름 + 분리 실패 표시(UploadView `error`) + **능력 게이트**
  (`env-support.ts`: 모바일/AudioContext/OfflineAudioContext/Worker/WASM/
  caches/crypto.subtle 미지원 → DESIGN §8 안내). `useSyncExternalStore`로
  하이드레이션 안전.
- 검증 잔재 제거: `src/app/sep-test/` 삭제, 디버그 핸들 제거(grep 0건).
- wasmPaths 는 jsDelivr CDN 유지(1차; 자가 호스팅은 2차 선택).
- `tsc --noEmit` 0, `eslint src/` 0. `separate(pcm)`로 디코드/모델/분리 분리.
- ⚠ 4-C 중 발견·수정한 버그: **SeparatingView StrictMode 가드 결함**
  (dev StrictMode setup→cleanup→setup 시 1차 cleanup 이 `cancelled=true` 로
  유일 async 를 죽여 "파일 읽는 중"에서 영구 정지). 진단으로 root-cause →
  `cancelled`/cleanup 제거 + `doneRef` 1회 가드로 수정.
- **검증 16/16 PASS**(`flow_verify`): 사이클1 첫방문(req=1)→연습, 재생토글·
  글로우·슬라이더0%·프리셋, Cache 저장, 사이클2 재방문 재다운로드 0(req=0),
  사이클3 잘못된 파일 안내+업로드복귀+모델 미수신(req=0), 콘솔 0.
  첫 방문 ~3.5분(모델 35s + 19.2s곡 3청크 ~2.5분, 단일스레드 WASM).
- 성능 현실: WASM 단일스레드 ~50–65s/10초청크 → 3분 곡 ≈ 18청크 ≈ 20분.
  1차 허용(기능 정상). 가속(WebGPU/멀티스레드)은 2차 후보.
- 잔재 제거 완료: `src/app/sep-test/` 삭제, `__drumRoomEngine` 제거(grep 0).

## 마지막 커밋 (master)
- `a346973` feat: 4-B - 분리 엔진 (htdemucs ONNX, STFT, Web Worker)
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
5. **4-C SeparatingView StrictMode 가드 결함**: `startedRef` 가드 + cleanup
   `cancelled=true` 조합에서, dev StrictMode(setup→cleanup→setup)의 1차
   cleanup 이 유일하게 실행되는 async 를 `cancelled` 로 죽여 "파일 읽는 중"
   영구 정지. **수정: cancelled/cleanup 제거, `startedRef` 1회 실행 +
   `doneRef` 1회 가드**(React 19 는 unmount 후 setState 무해 no-op).
   교훈: StrictMode 1회성 비동기는 cleanup-cancel 패턴과 충돌 — 가드는
   "시작 1회 + 종료 1회"로, 취소를 cleanup 클로저에 묶지 말 것.
6. **하이브리드 모델 절반만 사용 (분리 품질 결함)**: HTDemucs 는 시간분기
   `add_77` + 스펙트럼분기 `add_76`(ISTFT 필요) 합이 최종 소스인데 worker 가
   `add_77`만 사용 → 각 소스 ~30% 손실, 분리 뭉개짐. 4-B 검증이 못 잡은 건
   Python ref 도 `add_77`-only 라 양쪽이 같은 결함 공유(rc#4 와 동형 사각지대).
   교훈: 검증 기준이 피검증물과 같은 가정을 공유하면 결함이 안 보인다 —
   기준은 독립 권위(공식 demucs apply_model)로. 발견: 산출물 자체 재구성
   정합성(sum vs mix)을 절대지표로 측정(cos 0.955=결함 신호였음, "sane"로 오독).

## 사용자 확인 대기 (헤드리스 불가 — 직접 청취/체감)
0. ✅ A/B 청취 게이트 **통과**(B 승인) → 4-D 이식·검증 완료.
   **[최우선·커밋 게이트] 실제 앱 슬라이더 체감**: 4-D 적용 후 앱에서
   곡 넣기→분리→연습→드럼 슬라이더(0%/가이드/원곡) 직접 조작·청취해
   "드럼이 또렷이 빠지고/들어오는지" 확인. 수치상 shipped 코드 출력 =
   사용자 승인 B_*.wav 와 동일(cos~1) 입증됨 — 남은 건 실청취 1건.
   확인되면 4-D + 4-C 커밋.
1. 실제 곡 분리 **음질**: drums 트랙이 쓸 만한지, 슬라이더 0%에서 드럼이
   충분히 빠지는지, 100%에서 원곡처럼 되는지, 슬라이더 조작 시 틱 잡음 무.
2. 분리 **소요 시간 체감**: 단일스레드 WASM ~50–65s/10초청크
   (3분 곡 ≈ 20분). 1차 허용 범위인지 사용자 판단.
3. 3단계 재생 싱크/품질(이전 단계부터 대기) — 이제 실제 분리 곡으로 확인 가능.

## 미커밋 / 다음 판단
- **4-D 미커밋(사용자 실앱 슬라이더 청취 후 커밋)**: `src/lib/istft.ts`
  (신규), `src/lib/separation-worker.ts`(수정 — add_76 ISTFT 가산).
- **4-C 미커밋(동반)**: `src/lib/{model-cache,env-support}.ts`(신규),
  `src/lib/{audio-engine,separation-engine}.ts`(수정), `src/components/
  {SeparatingView,PracticeView,UploadView}.tsx`, `src/app/page.tsx`,
  `src/app/sep-test/`(삭제), `SESSION_STATE.md`. 4-B=`a346973` 기커밋.
  → 4-D·4-C 함께 또는 4-D 먼저 커밋(사용자 판단). 권장 커밋 메시지(4-D):
  `fix: 4-D - 스펙트럼 분기(add_76 ISTFT) 복원 — 하이브리드 분리 정상화`.
- 2차 후보: 가속(WebGPU/멀티스레드 — COOP/COEP), wasmPaths 자가호스팅,
  구간 루프·템포·메트로놈·악보. 1차 실사용 후 결정.
- 잔재: 테스트 Chrome 프로세스가 임시폴더 잠금(사용자 실Chrome 보호 위해
  강제 종료 안 함, TEMP라 OS 정리). model-prep(모델+venv+ref) gitignore됨.
