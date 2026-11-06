# UX12-HOME — 홈 Heatmap 미리보기와 셀 크기

**상태:** 구현 중 · [UX12 계획](../implementation/ux12/index.md) · [QOV-01](questions-overview.md)
**Route:** `/workspaces/:workspaceId`
**테스트:** `tests/e2e/questions/ux12-home.spec.ts`
**Phase:** UX12-HOME.0

### UX12-HOME-AC01

풀이 panel을 닫기 버튼이나 Esc로 닫으면 focus는 panel을 연 dot으로 돌아오지만 미리보기는 열리지 않는다. 포인터가 dot을 떠난 뒤에도 미리보기가 남지 않는다.

### UX12-HOME-AC02

panel을 닫은 뒤에도 그 dot의 미리보기 동작은 그대로다. 포인터를 올리면 미리보기가 열리고, Tab으로 나갔다가 돌아와도 미리보기가 열린다.

### UX12-HOME-AC03

데스크톱 Heatmap 셀은 28×28px이고 marker는 21×21px, 이웃 marker 사이 간격은 7px(marker 폭의 1/3)이다. mobile·coarse pointer 셀은 24×24px을 유지한다.
