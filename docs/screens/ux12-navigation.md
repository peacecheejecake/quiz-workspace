# UX12-NAV — 페이지 이동 반응

**Route:** Workspace 하위 페이지의 breadcrumb·`Workspace 홈` 뒤로 링크, `문서 관리` 행의 문서 제목 링크

**Phase:** UX12-NAV.0
**테스트:** `tests/e2e/quality/ux12-navigation.spec.ts`

```yaml
id: UX12-NAV
linked_tests: [UX12-NAV-AC01, UX12-NAV-AC02]
```

**명세:** [UX12 VIEW-6](../implementation/ux12/index.md) (결정 D-13), [QOV-01-AC09](questions-overview.md), [DOC-02](documents-editor.md)

사용자 피드백 "breadcrumb 반응이 너무 느림". 화면을 지정하지 않았으므로 클릭부터 페이지 표시까지로 보고 측정했다.

### 측정 (2026-11-06)

로컬 production build, Chromium, 문제 60개, 경로별 7회 중앙값(ms). "첫 반응"은 클릭부터 화면이 처음 바뀔 때까지(skeleton 또는 이동 표시의 DOM 삽입), "완료"는 대상 페이지가 그려질 때까지다. `+400`은 RSC 응답마다 400ms를 더해 원격 서버를 흉내 낸 조건이다.

| 경로 | 조건 | 변경 전 첫 반응 / 완료 | 변경 후 첫 반응 / 완료 |
|---|---|---|---:|
| 문서 → 홈 (breadcrumb) | prefetch 끝남 | 26 / 341 | 25 / 336 |
| 문서 → 홈 (뒤로 링크) | prefetch 끝남 | 27 / 341 | 25 / 342 |
| 문제 PDF 가져오기 → 홈 | prefetch 끝남 | 29 / 341 | 29 / 345 |
| 문서 → 홈 (breadcrumb) | `+400`, 페이지가 뜨자마자 클릭 | 425 / 740 | 9 / 769 |
| 홈 → 문서 | prefetch 없음 | 59 / 59 | 14 / 59 |
| 홈 → 문서 | `+400` | 454 / 454 | 14 / 477 |

`문서 → 홈`의 `+400`, 바로 클릭 행의 변경 후 값은 부하가 큰 시점의 측정이다. 나머지는 같은 조건의 조용한 실행이다.

**읽은 내용:**

- 코드에 breadcrumb만의 지연은 없다. 뒤로 링크와 수치가 같다.
- 홈으로 갈 때의 약 340ms 중 약 300ms는 서버가 아니라 React가 Suspense fallback을 최소 시간 유지하는 throttle이다. 서버 응답이 빨라도 홈 skeleton이 그만큼 남는다. 시험 삼아 `(home)/loading.tsx`를 뺀 build에서는 완료가 문서 → 홈 114ms, 가져오기 → 홈 82ms였다. skeleton을 뺄지는 사용자 결정이라 이 Task에서 바꾸지 않았다.
- 반응이 전혀 없던 구간은 두 곳이다. prefetch가 도착하기 전의 클릭, 그리고 boundary가 없는 `documents/[documentId]`로 가는 클릭. 둘 다 서버 왕복 내내 화면이 그대로였다.
- prefetch는 추가하지 않았다. 링크는 이미 보이는 순간 prefetch하고, prefetch가 끝나면 첫 반응이 약 26ms다.

**`documents/[documentId]/loading.tsx`를 넣지 않은 이유:** 계획의 후보였으나 시험 결과 빼기로 했다. 넣으면 첫 반응은 29ms가 되지만 알 수 없는 문서가 HTTP 404 대신 200으로 답하고, 빠른 응답의 완료가 59ms에서 329ms로 늘어난다(위 throttle). AC01의 이동 표시가 같은 구간을 비용 없이 덮는다.

### UX12-NAV-AC01

breadcrumb 링크, `Workspace 홈` 뒤로 링크(본문 검색 포함), `문서 관리` 행의 문서 제목 링크는 눌린 뒤 응답이 없는 동안 링크 아래에 이동 표시(2px accent 막대)를 보인다. 막대는 흐름 밖에 있어 뒤 항목이나 페이지를 밀지 않고, 100ms 뒤에 나타나 빠른 이동에서는 깜박이지 않으며, `prefers-reduced-motion`이면 움직이지 않는다. 막대는 장식이다(`aria-hidden`, 표시는 `data-link-pending`). prefetch가 끝난 경로는 skeleton이 바로 보이므로 표시가 나타나지 않는다.

### UX12-NAV-AC02

알 수 없는 문서 주소는 HTTP 404와 찾을 수 없음 페이지로 답한다. DOC-02 위에 `loading.tsx` boundary를 두지 않는다.

**E2E:** `tests/e2e/quality/ux12-navigation.spec.ts`
