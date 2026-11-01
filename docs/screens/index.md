# Screen Requirements Index — Platform v1.3

화면별 요구사항의 Source of Truth. 기능 구현 전 AC 문서와 Playwright E2E를 먼저 작성한다. 변경 PR은 Spec ID ↔ Test ID 추적 가능해야 한다.

| ID | Screen | Route | Requirements |
|---|---|---|---|
| AUTH-01 | 로그인 | `/login` | [auth-login.md](auth-login.md) |
| AUTH-02 | 회원가입 | `/signup` | [auth-signup.md](auth-signup.md) |
| AUTH-03 | 이메일 인증 대기 | `/auth/verify` | [auth-verify.md](auth-verify.md) |
| AUTH-04 | 인증 콜백 | `/auth/callback` | [auth-callback.md](auth-callback.md) |
| AUTH-05 | 비밀번호 재설정 요청 | `/forgot-password` | [auth-forgot.md](auth-forgot.md) |
| AUTH-06 | 새 비밀번호 설정 | `/reset-password` | [auth-reset.md](auth-reset.md) |
| AUTH-07 | 인증 오류 안내 | `/auth/error` | [auth-error.md](auth-error.md) |
| ACCOUNT-01 | 계정 보안 설정 | `/settings/security` | [account-security.md](account-security.md) |
| WS-01 | Workspace 목록 | `/workspaces` | [workspaces.md](workspaces.md) |
| DOC-01 | 문서 관리 Floating Dialog | `/workspaces/:workspaceId?panel=documents` | [documents-library.md](documents-library.md) |
| DOC-02 | PDF 열람·원문 교정 | `/workspaces/:workspaceId/documents/:documentId` | [documents-editor.md](documents-editor.md) |
| DOC-03 | 문서 전문 텍스트 내보내기 | DOC-01 행 메뉴 · DOC-02 header (`GET /documents/:documentId/text`) | [documents-text-export.md](documents-text-export.md) |
| DOCSUM-01 | 문서 요약 Floating Side Panel | `/workspaces/:workspaceId?panel=document-summary&document=:documentId` | [documents-summary.md](documents-summary.md) |
| SEARCH-01 | 문제 검색·본문 검색 | `/workspaces/:workspaceId?q=:query` | [search.md](search.md) |
| QOV-01 | Workspace 홈 (문제 Heatmap) | `/workspaces/:workspaceId` | [questions-overview.md](questions-overview.md) |
| QPLAY-01 | 문제 풀이 Floating Side Panel | `/workspaces/:workspaceId?question=:questionId` | [questions-practice.md](questions-practice.md) |
| CHNOTE-01 | 챕터 정리 노트 Floating Side Panel | `/workspaces/:workspaceId?panel=chapter-note&chapter=:chapterId` | [chapter-notes.md](chapter-notes.md) |
| QIMPORT-01 | 문제 PDF 가져오기 | `/workspaces/:workspaceId/questions/import` | [questions-import.md](questions-import.md) |
| QGEN-01 | 문제 변형 출제 | `/workspaces/:workspaceId/questions/generate` | [questions-generation.md](questions-generation.md) |
| HISTORY-01 | 이력 Floating Dialog | `/workspaces/:workspaceId?panel=history` | [history-jobs.md](history-jobs.md) |
| WS-SHARE-01 | Workspace 공유 관리 (Owner) | `/workspaces/:workspaceId?panel=share` | [workspace-sharing.md](workspace-sharing.md) |
| WS-VIEW-01 | 공유 Workspace 조회 (Guest) | `/share/:shareId` | [workspace-shared-view.md](workspace-shared-view.md) |
| WS-FORK-01 | 공유 Workspace Fork (Recipient) | `/share/:shareId?panel=fork` | [workspace-fork.md](workspace-fork.md) |

## 공통 규칙

- 총 23개 화면, AC 153개(UX7-QDISPLAY 2026-11-01: 객관식 채점 결과 테두리 QPLAY-01-AC12, `보기` 글자·끝 빈 괄호 표시 AC13 신규 2개. 이전 집계 151개 — UX7-BANK-2 2026-11-01: 전체 문제 폐기로 빠졌던 기능 복원 — 정답·해설 보기 QPLAY-01-AC09, 수정 이력·출처 AC10, 보관 AC11, 보관·초안 문제 dialog QOV-01-AC15 신규 4개. 이전 집계 147개 — UX7-SEARCH-2: SEARCH-01-AC13 신규 1개. 이전 집계 146개 — UX7-BACK 2026-11-01: 닫은 dialog를 뒤로가기로 다시 열지 않음 QOV-01-AC14 신규 1개. 이전 집계 145개 — UX7-SEARCH 2026-11-01: 통합 검색창 SEARCH-01-AC07 폐기, 검색창 분리 SEARCH-01-AC09~AC12 신규 4개. 이전 집계 142개 — UX7-DOCS 2026-11-01: 문제 PDF 관리 통합 DOC-01-AC09 신규 1개. 그 전 141개 — UX7-BANK 2026-11-01: 전체 문제 페이지 QBANK-01 폐기 — AC 6개 중 AC01·AC02·AC05는 QOV-01-AC12·AC13, AC03·AC04는 QPLAY-01-AC07·AC08로 옮기고 AC06은 폐기, 기록은 [questions-bank.md](questions-bank.md). 이하 이전 집계: 24개 화면, AC 135개 — 기존 70개, 공유·Fork 신규 17개, Auth CAPTCHA 신규 8개 — A4, 검색 저하 SEARCH-01-AC06 1개 — M7.4b, 처리 진행 표시 DOC-01-AC05 1개 — UX3-JOB, Workspace 홈 통합 10개 — UX3c: QOV-01-AC07~AC10, SEARCH-01-AC07, DOC-01-AC06, QIMPORT-01-AC05, QGEN-01-AC05, HISTORY-01-AC04, QBANK-01-AC05, UX4 2개: 홈 `문제` 메뉴 QOV-01-AC11, 문제은행 검색·필터 접기·PDF dialog QBANK-01-AC06, 서버 측 문제 추출 시작 1개 — QIMP-AUTO: QIMPORT-01-AC06, 여러 문제·임의 선택 묶음 변형 출제 3개 — QGEN-MULTI: QGEN-01-AC06~AC08, 서버 측 등록 1개 — QIMP-JOB: QIMPORT-01-AC07, 교재 챕터 매칭 1개 — CHAPTER-MAP: QIMPORT-01-AC08, 모든 PDF 한 곳 업로드·자동 분류 2개 — UX6-UPLOAD: DOC-01-AC07·AC08, 대량 초안 즉시 선택 1개 — UX6-SELECT: QIMPORT-01-AC09, 문서 전문·요약·챕터 정리 노트 신규 화면 3개·17개 — DOCSUM-SPEC 2026-10-29: DOC-03-AC01~AC03(phase DOCTXT.0), DOCSUM-01-AC01~AC08(DOCSUM.0), CHNOTE-01-AC01~AC06(CHNOTE.0)).
- **Workspace 홈 통합(UX3c 2026-10-20):** Workspace 안에는 왼쪽 메뉴(문서/검색/문제/이력/공유 설정)가 없고 `/workspaces/:workspaceId` 하나가 홈이다(QOV-01). 홈 상단의 Workspace header가 문제 검색·본문 검색(UX7-SEARCH)과 `문서 n`·`문제`(메뉴: 직접 추가·변형 출제, UX4; `전체 문제`는 UX7-BANK, `PDF 관리`는 UX7-DOCS에서 폐기) 버튼 묶음, 오른쪽 정렬된 `이력`·`공유하기` 아이콘 버튼 묶음을 갖는다. 문서 관리·문제 생성·이력·링크 공유는 홈 위에 겹쳐 뜨는 non-modal Floating Dialog(`?panel=documents|generate|history|share`; 문제 PDF 관리 `question-pdfs`는 UX7-DOCS에서 문서 관리로 통합·redirect)이며 나중에 연 dialog가 위에 온다. 검색 상태는 홈 URL(문제 검색 `?q=`, 본문 검색 `?text=…`; UX7-SEARCH에서 검색창 분리)에 둔다. 이전 경로(`/documents`, `/search`, `/questions`, `/history`, `/settings/sharing`)는 같은 상태의 홈으로 redirect한다. 실제 페이지로 남는 하위 화면(DOC-02, QIMPORT-01·QGEN-01의 검토 화면)은 뒤로가기와 breadcrumb을 둔다(QOV-01-AC13). 이전 전체 문제 페이지 `/questions/bank`는 홈으로 redirect한다(UX7-BANK). 문제 직접 등록은 홈 위의 modal "문제 등록" dialog(`?panel=question-create`, QOV-01-AC12), 문제 편집·삭제·보관은 풀이 panel의 `문제 관리` 메뉴(QPLAY-01-AC07·AC08·AC11), 정답·해설·수정 이력·출처 보기는 모든 구성원의 풀이 panel 메뉴(QPLAY-01-AC09·AC10), 초안·보관 문제 목록은 `문제` › `보관·초안 문제` dialog(`?panel=inactive-questions`, QOV-01-AC15)다(UX7-BANK-2). 홈과 dialog에는 화면 제목·설명 header가 없다(접근성 `h1`은 시각적으로 숨겨 유지).
- **문서 전문·요약·정리 노트 (DOCSUM-SPEC 2026-10-29):** 모두 Workspace 홈에서 닿는다(사용자 결정 "모두 홈에서 볼 수 있게"). 문서 관리 dialog 행의 `텍스트 내보내기` 메뉴(DOC-03)와 `요약` 버튼(DOCSUM-01, `?panel=document-summary&document=`), Heatmap 챕터 그룹 header의 `정리 노트` 버튼(CHNOTE-01, `?panel=chapter-note&chapter=`). 요약·정리 노트 panel은 다른 홈 dialog와 같은 non-modal `FloatingSidePanel` 쌓기 규칙을 따른다. 세 화면의 phase(DOCTXT.0·DOCSUM.0·CHNOTE.0)는 구현 Task(DOCTXT·DOCSUM-W·CHNOTE-W)가 CI `E2E_PHASES`에 추가해 strict trace·E2E에 포함된다. 품질 suite(`tests/e2e/quality/`): axe `A11Y-11`(내보내기 메뉴·요약 panel)·`A11Y-12`(정리 노트 panel, "정답·해설 포함" 접힘·펼침, `a11y-docsum.spec.ts`), visual `VISUAL-06`(내보내기 메뉴·요약 panel·본문을 접은 정리 노트 panel; 정답·해설이 펼쳐진 상태는 screenshot에 남기지 않는다) (implementation-plan §3 DOCSUM-X).
- 버튼으로 화면이 바뀌면 UI가 먼저 바뀌고 데이터는 skeleton을 보이는 동안 불러온다(route `loading.tsx`, dialog는 즉시 열리고 내용 skeleton).

- 인증 없는 접근 / 권한 오류 / Workspace archive / deleted / 실패 / 빈 데이터 상태를 정의한다.
- `/workspaces/:workspaceId` 내부에서는 `workspace_id` 권한을 서버에서 확인한다. 클라이언트 필터만으로 데이터 격리를 구현하지 않는다.
- 외부 인증 콜백은 `auth.md`, upload/배포 설정은 `deployment.md`, 상태/marker·변형 정책은 `questions.md`, UI 토큰은 `design-system.md`가 기준이다.
- AC ↔ test mapping은 `e2e-strategy.md` 참조.
