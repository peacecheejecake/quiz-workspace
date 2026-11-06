# UX11-RETURN — 현재 문제 다시 풀기와 풀이 복귀

**상태:** 구현 중 · [UX11 요구](../implementation/ux11/return.md) · [문제 보기](question-viewer.md)
**Route:** 인증된 `/workspaces/**`, `/settings/**`; 복귀 대상은 `/workspaces/:workspaceId?question=:questionId` 또는 `/workspaces/:workspaceId?practice=:runId&i=:position`
**테스트:** `tests/e2e/questions/ux11-return.spec.ts` · `apps/web` Vitest 및 풀이 계약 테스트
**Phase:** UX11-RETURN

### UX11-RETURN-AC01

현재 문제를 다시 풀면 새 시도가 시작되고 기존 시도 기록은 보존된다. 범위·모의고사의 기존 회차 점수와 결과를 유지하고 별도 연습으로 기록한다.

### UX11-RETURN-AC02

풀이 화면을 떠나면 `보던 문제로 돌아가기`가 나타나고, 누르면 마지막 문제 또는 묶음의 같은 위치를 다시 연다. 풀이 화면이 열려 있는 동안에는 표시하지 않는다.

### UX11-RETURN-AC03

닫기 버튼과 아래로 스와이프(UX12 DESIGN-3 개정, [UX12-GESTURE-AC08](ux12-gesture.md))는 복귀 표시만 없애며 풀이와 기록을 변경하지 않는다. 다음 명시적 풀이 활동은 대상을 갱신하고 표시를 다시 활성화한다.

### UX11-RETURN-AC04

복귀 상태는 현재 인증 사용자와 탭의 메모리에 필요한 식별자만 둔다. 정답·발문·인증 정보·전체 URL은 보관하지 않는다. 계정 변경과 로그아웃 시 비우고, 대상 접근 권한과 유효성은 복귀 전에 서버에서 확인한다. 삭제되거나 접근할 수 없으면 대상을 제거하고 안내한다.

같은 사용자의 재확인(창 복귀·`pageshow`·복귀 클릭)은 화면을 가리지 않고 문구도 표시하지 않으며, 복귀 버튼은 유지된다(클릭 시 busy만). 계정 변경 또는 로그아웃이 서버 검증으로 확인되면 즉시 이전 화면을 가리고, 계속 가린 채 `/workspaces` 또는 `/login`으로 이동한다. 일시적인 검증 실패는 화면과 draft를 유지한 채 조용히 재시도하고, 약 10초 뒤 작은 `role=status` 안내를 표시한다.

### UX11-RETURN-AC05

작은 화면과 문서 전체 화면에서도 안전 영역과 44px 터치 대상을 지킨다. 키보드와 터치로 사용할 수 있고 다른 modal 아래에서는 표시와 포커스를 숨긴다. 색만으로 상태를 전달하지 않으며 다크 모드와 축소 모션을 지원한다. 표시의 모양은 [UX12-GLASS](ux12-glass.md) AC04~AC06을 따른다(UX12 SHELL-2 개정). 모바일 가상키보드가 열려 있으면 복귀 표시와 안내 문구는 키보드 바로 위에 뜬다([UX12-KEYBOARD-AC05](ux12-keyboard.md), UX12 SHELL-5 개정).
