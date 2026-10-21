# QIMPORT-01 — 문제 PDF 가져오기

**상태:** 확정 화면 요구사항 v1.4 · UX3c 개정 2026-10-20 (문제 PDF 관리 dialog) · UX4 개정 2026-10-21 (`문제` 메뉴 진입, `PDF 가져오기` 버튼 삭제) · QIMP-AUTO 개정 2026-10-21 (서버 측 추출 시작, `문제 추출`/`문제 검토`)
**Route:** `/workspaces/:workspaceId/questions/import` (업로드·추출·검토 페이지; 뒤로가기·breadcrumb `Workspace 이름 › 문제 PDF 가져오기`; `?document=<문서 id>`이면 그 문제 PDF의 가장 최근 추출을, 없으면 Workspace의 가장 최근 추출을 보인다) · 문제 PDF 관리 dialog `/workspaces/:workspaceId?panel=question-pdfs`
**테스트:** `tests/e2e/questions/questions-import.spec.ts`
**연계:** [전체 아키텍처](../architecture.md), [디자인 시스템](../design-system.md), [E2E 규칙](../e2e-strategy.md)

## 레이아웃 및 컴포넌트
- 상태별 Empty/Loading/Failure/Success UI, 반응형 Layout과 Floating Side Panel, 접근성 지원.
- API와 화면은 owner / viewer / 로그인 상태에 따라 기능과 데이터 표시 범위를 구분한다.
- 모든 편집·상태 변경은 서버 측 인가·revision 일관성을 검증한다.
- **문제 PDF 관리 dialog (UX3c 2026-10-20):** 문제 PDF(`document_type = question_paper`)는 책 문서와 다른 목록에서 관리한다. Workspace 홈 header의 `문제` 메뉴 › `PDF 관리`(UX4 2026-10-21; 이전 문제 영역의 `문제 PDF 관리` 버튼)와 문제은행의 `PDF 가져오기`(QBANK-01-AC06)가 같은 non-modal floating dialog "문제 PDF 관리"를 연다: 등록된 문제 PDF 목록(문서 관리와 같은 행 형식, badge 없음)과 점선 Dropzone(놓거나 "PDF 선택" 버튼으로 고른 PDF를 들고 이 페이지로 이동해 바로 업로드·추출을 시작). dialog 안의 별도 `PDF 가져오기` 버튼은 없다(UX4) — Dropzone의 "PDF 선택"이 키보드·터치 경로다. 목록이 비면 "등록된 문제 pdf가 없습니다." 문구. 추출 결과 검토(초안 편집·원본 비교·승인)는 dialog에 담기에 넓어 이 페이지에 남긴다. 홈의 다른 "PDF 가져오기" 버튼(빈 상태 등)은 없다.

- **서버 측 추출 시작 (QIMP-AUTO 2026-10-21):** 문제 추출은 브라우저가 아니라 서버가 시작한다. 문제 PDF의 처리(파싱·색인, `document.parse`)가 성공하면 같은 트랜잭션에서 그 문서의 import run과 `question.import` job이 업로드한 사용자 이름으로, 문서의 Workspace에 한 번만 만들어진다(문서당 서버 시작 run 1개; 재시도·중복 전달·이후 revision은 새 run을 만들지 않는다; 보관·삭제된 Workspace, 편집 권한을 잃은 사용자, 이미 run이 있는 문서는 시작하지 않는다). 따라서 업로드가 끝나면 페이지를 떠나도 되며, 진행 표시 아래에 "이 페이지를 떠나도 PDF 분석과 문제 추출은 서버에서 계속됩니다. 다시 열면 결과를 이어서 볼 수 있습니다."를 보인다(업로드 단계 제외). 페이지에 남아 있으면 처리 완료 후 `POST /question-imports`가 그 run에 붙어(attach) 진행과 결과를 보인다 — 같은 문서의 활성 revision에 run이 이미 있으면 POST는 새 run을 만들지 않고 그 run을 돌려준다.
- **문제 PDF 관리의 행 동작 (QIMP-AUTO):** 준비 완료된 문제 PDF 행은 추출 run이 있으면 `문제 검토` 링크(모든 구성원, `?document=<id>` 가져오기 페이지로 이동), 없으면(QIMP-AUTO 이전에 처리된 PDF) 편집 권한자에게 `문제 추출` 버튼을 보인다. `문제 추출`은 추출을 시작(POST)하고 그 문서의 가져오기 페이지로 이동해 진행·검토를 보인다. 처리 중이거나 실패한 행에는 둘 다 없다. 시작에 실패하면 dialog 안에 이유를 alert로 보인다.

## 수용 기준

### QIMPORT-01-AC01

- **Given:** 해당 화면과 테스트용 데이터 및 권한이 주어진 상태
- **When:** 관련 조작/네트워크 요청을 수행
- **Then:** 문제 5개 포함 PDF 업로드/추출 시 원본 PDF 페이지를 연결한 draft 5개를 표시한다.

### QIMPORT-01-AC02

- **Given:** 해당 화면과 테스트용 데이터 및 권한이 주어진 상태
- **When:** 관련 조작/네트워크 요청을 수행
- **Then:** 정답 없는 PDF의 추출 결과는 정답 null로 저장하며 모델이 임의로 정답을 생성하지 않는다.

### QIMPORT-01-AC03

- **Given:** 해당 화면과 테스트용 데이터 및 권한이 주어진 상태
- **When:** 관련 조작/네트워크 요청을 수행
- **Then:** 사용자가 검토·승인한 초안만 문제은행에 확정 등록하고 Heatmap 마커를 증가시킨다.

### QIMPORT-01-AC04

- **Given:** 해당 화면과 테스트용 데이터 및 권한이 주어진 상태
- **When:** 관련 조작/네트워크 요청을 수행
- **Then:** 작업 실패 후 재시도 시 초안·확정 문제를 중복 등록하지 않는다.

### QIMPORT-01-AC05

- **Given:** 문제 PDF와 책 문서가 등록된 Workspace 홈(그리고 문제 PDF가 없는 Workspace)
- **When:** header의 `문제` 메뉴에서 `PDF 관리`를 고름(UX4)
- **Then:** "문제 PDF 관리" floating dialog가 열려(`?panel=question-pdfs`) 문제 PDF만 나열하고(책 문서는 없음), Dropzone과 그 "PDF 선택" 버튼을 보인다(편집 권한). dialog에도 홈에도 별도의 "PDF 가져오기" 버튼은 없다(UX4). 문제 PDF가 없으면 "등록된 문제 pdf가 없습니다."를 보인다. Dropzone에 PDF를 놓거나 "PDF 선택"으로 고르면 가져오기 페이지로 이동해 그 파일의 업로드를 바로 시작한다(UX3c).

### QIMPORT-01-AC06

- **Given:** 편집 권한자가 문제 PDF를 올린 Workspace (그리고 추출 run 없이 처리만 끝난 문제 PDF)
- **When:** 업로드가 끝난 뒤 처리 완료 전에 가져오기 페이지를 떠났다가 나중에 다시 연다 (그리고 문제 PDF 관리 dialog에서 그 PDF의 `문제 추출`을 누른다)
- **Then:** 처리가 끝나면 서버가 브라우저 없이 추출을 시작해(업로드한 사용자의 run 1개) 다시 연 가져오기 페이지에 추출된 초안이 보인다. 추출 run이 없는 처리 완료 문제 PDF는 `문제 추출`을 제공하고, 누르면 추출을 시작해 그 문서의 가져오기 페이지(`?document=`)에서 초안을 보이며, 이후 그 행은 `문제 검토` 링크를 보인다. 어떤 경우에도 한 문서에 run이 중복 생성되지 않는다(QIMP-AUTO).

## Test-first 규칙
- 위 AC ID를 Playwright test title에 포함하고 RED를 확인한 다음 API/UI를 구현한다.
- 단위·통합 테스트는 source page mapping, auth denial, revision consistency 등 화면으로 확인하기 어려운 경계 검증을 보완한다.
