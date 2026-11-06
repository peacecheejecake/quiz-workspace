# Workspace 공유·Fork — 기능·보안 확정 명세 v1.3

**원칙:** 링크 소지자는 읽기 전용. **원 저작자가 Fork를 명시적으로 허용**했고 수신자가 별도 계정으로 로그인한 경우에만 독립 Workspace Fork 가능. 공유 링크는 Workspace 멤버십이 아니다.

## 1. 정책 및 공개 범위

| 항목 | 기본값·요구사항 |
|---|---|
| 링크 공유 | OFF; Workspace Owner만 발급·회수·만료·재발급 가능 |
| 링크 열람 | 유효 링크를 받은 비로그인 사용자도 조회 허용; 로그인 불필요 |
| Fork | OFF; 링크 단위 `allow_fork` 설정을 Owner만 켤 수 있음 |
| 열람 범위 | Workspace 명세, 발행된(PUBLISHED) PDF/교정 텍스트/목차, 발행된 문제·정답·해설, 범위가 제한된 검색/발췌, 현재 발행 revision의 문서 요약과 장별 최신 정리 노트(DOCSUM-SPEC 2026-10-29, §8), 발행 문제의 이미 만든 최신 AI 해설(ASK-SPEC 사용자 결정 2026-11-01, §10)과 이미 저장된 관련 본문(사용자 결정 2026-11-01, §10). 요약·정리 노트·AI 해설은 링크마다 뺄 수 있다(§12) |
| 선택 공개 | 링크 옵션 `include_owner_records`를 켠 링크에 한해 Owner 본인의 풀이 이력과 하이라이트를 읽기 전용으로 공개(기본 꺼짐, 사용자 결정 2026-11-06, §12) |
| 비공개 범위 | 초안, 미발행 revision, 개인 풀이·즐겨찾기·다시 풀기(§12 옵션을 켠 링크의 Owner 풀이 이력은 예외, 즐겨찾기·다시 풀기와 다른 구성원의 기록은 항상 비공개), owner 프로필, 공유 링크 비밀값, API 키, 관리·작업·활동 기록, 전문 텍스트 내보내기 파일, 이전 revision 요약·이전 버전 노트·요약/노트 생성 상태·오류·비용, 모의고사·범위 풀이 묶음(MOCK-SPEC 2026-11-01, §9), 구성원의 AI 질문 대화, AI 해설 생성 상태·이전 버전·비용(ASK-SPEC, §10) |
| 편집 | 링크만 가진 viewer는 업로드·편집·문제 생성·답안 제출·즐겨찾기·삭제·공유 관리 전부 불가 |
| 삭제·보관 | Archive 후 공유 read 유지(Owner revoke 가능); 삭제 요청 이후 공유와 Fork 즉시 거부 |
| Fork 결과 | 현재 published snapshot의 독립 복제; 원본과 자동 동기화 없음; 각 문서·문제 식별자는 새로 발급 |
| 저작권 | Owner에게 PDF·문제의 공유와 복제 허용 권리를 확인하도록 안내. Viewer 권한은 다운로드 방지 DRM을 보장하지 않음 |

## 2. 링크 비밀값과 접근 제어

- 링크 생성·재발급 시 서버는 `SHARE_SESSION_SECRET`에서 도메인 분리 파생한 키(`ShareSessionKey`)와 `link_id`로 32바이트(256비트) HMAC-SHA256 비밀값을 결정적으로 유도(`quiz-share-link/v1|` + `link_id`)하고, DB(`workspace_share_links.token_digest`)에는 평문 비밀값 없이 `SHA-256(secret bytes)` digest만 저장한다(SHARE-PERSIST 2026-11-05). 원시 `secret` 필드는 발급·재발급 201 응답에서만 반환하며, DB·로그·`activity_events`·`idempotency_keys`에는 평문 비밀값이나 `share_url`을 절대 기록하지 않는다. Owner의 `GET /api/v1/workspaces/{id}/share-links` 및 `PATCH /api/v1/workspaces/{id}/share-links/{linkId}`는 철회되지 않은(`revoked_at is null`) 링크에 한해 파생 후보의 SHA-256이 `token_digest`와 일치할 때만 `share_url`을 재구성해 돌려주므로, Owner는 dialog를 닫았다 다시 열거나 새로 고침·다른 기기에서도 같은 링크 주소를 확인·복사할 수 있고(철회 즉시 `share_url: null`, 재발급은 `rotate`), 이전에 무작위로 만든 레거시 링크나 키 불일치 행은 깨진 URL 대신 `share_url: null`을 반환한다.
- 예시: `https://app.example.com/share/{shareId}#k={secret}`. URL Fragment는 HTTP 요청/Referer에 전달되지 않으며, 클라이언트가 `POST /api/v1/shared/{shareId}/sessions`로 1회 교환한다. 교환 후 fragment 삭제.
- 짧은 수명의 공유 전용 세션을 `HttpOnly; Secure; SameSite=Lax` cookie로 발급한다. 이 세션에는 workspace ID·share ID·읽기 범위만 담고 실제 Supabase 로그인과 혼합하지 않는다.
- 서버는 공유 read 요청마다 현재 share link의 revoked/expired/deleted 상태를 재검증한다. Qdrant Workspace 필터는 서버에서 강제한다.
- 공유 페이지 및 자료 응답 `Cache-Control: private, no-store`, `Referrer-Policy: no-referrer`, `robots=noindex,nofollow`.
- 토큰·JWT·signed Storage URL은 API 로그, analytics, OpenGraph, 예외 출력, Playwright Trace에 남기지 않는다.
- 링크 교환과 Fork 요청에 rate limit, CSRF 및 Origin 보호, Workspace 리소스 ID 소속 확인.
- PDF는 Supabase private bucket에서 공유 세션을 재검증한 후 짧은 signed URL 또는 서버 프록시로 제공한다.

## 3. 역할·권한

| 기능 | Owner | 비로그인 링크 Viewer | 로그인 링크 Viewer, Fork OFF | 로그인 링크 Viewer, Fork ON |
|---|:---:|:---:|:---:|:---:|
| Published 문서·문제·원문 검색 읽기 | ✅ | ✅ | ✅ | ✅ |
| 원본 수정/문제 풀이 저장 | ✅ | ❌ | ❌ | ❌ |
| 공유 링크 설정·철회 | ✅ | ❌ | ❌ | ❌ |
| 개인 상태·이력 조회 | 본인 데이터 | ❌ (§12 옵션을 켠 링크는 Owner의 풀이 이력·하이라이트만 읽기) | ❌ (같음) | ❌ (같음) |
| 독립 Fork 요청 | Owner 별도 선택 | ❌ | ❌ | ✅ |
| Fork 결과 편집 | — | — | — | 본인 새 Workspace만 |

## 4. DB 및 버전

```sql
workspace_share_links(
  id uuid primary key,
  workspace_id uuid not null references workspaces(id),
  created_by uuid not null references auth.users(id),
  token_digest bytea not null,
  allow_fork boolean not null default false,
  include_notes boolean not null default true,
  include_ai_explanations boolean not null default true,
  include_summary boolean not null default true,
  include_owner_records boolean not null default false,
  expires_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null,
  updated_at timestamptz not null
);

workspace_forks(
  id uuid primary key,
  source_workspace_id uuid,
  source_share_link_id uuid,
  target_workspace_id uuid not null unique references workspaces(id),
  forked_by uuid not null references auth.users(id),
  source_snapshot_manifest jsonb not null,
  origin_attribution jsonb not null,
  status text not null, -- PENDING/COPYING/COMPLETED/FAILED/CANCELLED
  created_at timestamptz not null,
  completed_at timestamptz
);
```

- `supabase/migrations`를 유일한 DB migration owner로 둔다. FastAPI가 공유 토큰·권한 검사의 유일한 경계다.
- 원본 Workspace 삭제 후 Fork된 Workspace는 계속 존재. Source provenance는 삭제 가능한 FK와 별도의 복제 시점 attribution으로 보존한다.
- Fork는 내부 Workspace ID, document, chapter, question, revision, source references를 새 ID로 remap한다. 원본 개인별 `question_attempts`, `question_user_states`는 복사하지 않는다. 중복 정리 연결(`question_merges`, UX7-DEDUP)도 복사하지 않는다: Fork는 확정 문제만 복사하므로 사본에는 남긴 문제만 있고 보관된 중복이 없다(사용자 결정 2026-11-01, questions.md §10.2). 공유 링크 Viewer는 확정 문제만 보므로 보관된 중복도 보지 않는다.

## 5. REST API 계약

Owner 전용:
- `POST /api/v1/workspaces/{id}/share-links`: 비밀 링크 발급(`secret` + `share_url` 반환; `idempotency_keys` 재실행 응답에는 `secret: null`, `share_url: null`); 기본 Fork OFF
- `GET /api/v1/workspaces/{id}/share-links`: 링크 목록 조회(원시 `secret`·`token_digest` 미포함; 철회되지 않은 링크는 서버 키로 검증된 `share_url` 포함, 철회·복원 불가 시 `null`)
- `PATCH /api/v1/workspaces/{id}/share-links/{linkId}`: Fork 허용·만료·공개 범위(§12) 수정(철회되지 않은 링크의 `share_url` 포함)
- `POST /api/v1/workspaces/{id}/share-links/{linkId}/revoke`: 접근 즉시 철회(`share_url: null`)
- `POST /api/v1/workspaces/{id}/share-links/{linkId}/rotate`: 기존 철회 후 새 비밀 링크 발급(Fork·만료·공개 범위 옵션을 옮김)

Shared viewer (공유 session에만 허용):
- `POST /api/v1/shared/{shareId}/sessions`: fragment 비밀값을 읽기 전용 세션으로 교환
- `GET /api/v1/shared/{shareId}`: 발행 상태 Workspace·목차·Fork 정책·공개 범위 옵션(§12)
- `GET /api/v1/shared/{shareId}/documents/{docId}`: 발행 문서
- `GET /api/v1/shared/{shareId}/documents/{docId}/pdf`: private PDF 인증 접근
- `POST /api/v1/shared/{shareId}/search`: 공개 문서 범위의 제한된 검색
- `GET /api/v1/shared/{shareId}/questions`: 발행 문제 목록
- `GET /api/v1/shared/{shareId}/questions/{questionId}`: 발행 문제·해설
- `GET /api/v1/shared/{shareId}/documents/{docId}/summary`: 현재 발행 revision의 성공한 문서 요약(없으면 404, §8)
- `GET /api/v1/shared/{shareId}/chapter-notes`: 최신 정리 노트가 있는 장 목록
- `GET /api/v1/shared/{shareId}/chapters/{chapterId}/note`: 장의 최신 성공 정리 노트(각주는 발행 문제만 링크)

- `GET /api/v1/shared/{shareId}/questions/{questionId}/ai-explanation`: 발행 문제 active revision의 최신 성공 AI 해설(없으면 404, §10)
- `GET /api/v1/shared/{shareId}/questions/{questionId}/related-sources`: 발행 문제 active revision·현재 교재 fingerprint의 저장된 관련 본문(없으면 404, 계산하지 않음, §10; 사용자 결정 2026-11-01)
- `GET /api/v1/shared/{shareId}/owner-attempts`: Owner의 풀이 이력(`include_owner_records`가 꺼지면 404, §12)
- `GET /api/v1/shared/{shareId}/owner-highlights`: Owner의 하이라이트(`include_owner_records`가 꺼지면 404, §12)

Fork (공유 session + **Supabase 사용자 JWT** 동시 필요):
- `POST /api/v1/shared/{shareId}/forks`: 이름·멱등 키; 202 Accepted + job id
- `GET /api/v1/me/forks/{forkId}`: 본인 Fork 진행 상태만 조회

## 6. 비동기 Fork 처리

1. 수신자는 유효한 공유 페이지에서 Fork ON 정책을 확인하고 로그인한다. 로그인 후에도 share session과 `allow_fork`를 서버에서 다시 검증한다.
2. 서버는 복제 권한·용량·쿼터·멱등성을 확인하고 원본의 현재 **published revision IDs**와 링크의 포함 옵션(§12, `include`)을 immutable snapshot manifest에 고정한다.
3. `workspace_forks(PENDING)`과 Celery job을 생성한다. Worker는 새 Workspace를 비공개 상태로 만들고 PDF·문서·목차·정답·해설·문제들을 별도 storage prefix와 새로운 ID로 복제한다.
4. 개인별 풀이, Favorite/Retry, 하이라이트, Owner 활동 로그, 공유 설정, draft는 제외한다(§12 `include_owner_records`를 켠 링크도 같다). 문제 lineage와 source references는 새 ID로 매핑한다.
5. 커밋 직전 링크 revoke/expire 및 allow_fork OFF 여부를 다시 검사한다. 도중 철회되면 Fork는 CANCELLED하고 임시 DB·Storage 복제물을 청소한다. 포함 옵션도 다시 읽어, 고정한 값과 지금 값이 모두 켜진 항목만 복사한다(§12; 옵션 변경은 취소 사유가 아니다).
6. 성공 시에만 target Workspace를 ACTIVE로 공개하며 `COMPLETED` 기록. 완료된 복제본은 원본 링크 철회/삭제의 영향을 받지 않는다.

## 7. Screen-first E2E 및 릴리스

화면 3개 추가: [Owner 공유 관리](screens/workspace-sharing.md), [게스트 읽기](screens/workspace-shared-view.md), [수신자 Fork](screens/workspace-fork.md).

AC 5+6+6=17개를 각각 Playwright로 먼저 RED 테스트로 작성한다. 검증 시나리오:
- 일반 비로그인 Workspace URL 401 vs 유효 공유 링크만 읽기 허용
- 잘못된 secret / revoke / expire / delete 이후 **기존 공유 세션까지** 차단
- 타 Workspace ID·비발행 revision·개인별 진도·쓰기 API 차단
- allow_fork OFF, 비로그인 사용자, 잘못된 링크는 Fork 거부
- Fork 승인·완료 후 데이터 복제와 ID 재매핑·개인 상태 초기화
- 작업 중 철회는 취소 및 리소스 정리, 완료 후 철회는 Fork 데이터 유지
- 토큰/URL 및 개인정보 유출 방지, 복제 및 공유·저작권 안내

개발 순서: S0(명세/E2E) → S1(share API/인가) → S2(공유 UI) → S3(Fork Worker) → S4(보안·성능·배포 검증). M3/M4 및 Auth A 트랙 의존.

## 8. 문서 요약·정리 노트·텍스트 내보내기 (DOCSUM-SPEC 2026-10-29)

원칙은 §1과 같다: 게스트는 **발행된 것만, 읽기만** 한다.

| 기능 | Owner·editor | viewer(멤버) | 링크 게스트 |
|---|:---:|:---:|:---:|
| 문서 요약 읽기 | ✅ 마지막 성공 요약(+stale) | ✅ 같음 | 현재 발행 revision의 성공 요약만 |
| 요약 만들기·다시 시도 | ✅ 활성 Workspace | ❌ | ❌ |
| 정리 노트 읽기 | ✅ 모든 버전 | ✅ 모든 버전 | 장마다 최신 성공 버전이 출처 일치일 때만 |
| 정리 노트 만들기·다시 만들기 | ✅ 활성 Workspace | ❌ | ❌ |
| 전문 텍스트 내보내기 | ✅ 발행본·초안 | ✅ 발행본 | ❌ |

- **결정(2026-10-29):** 요약은 발행 원문에서, 정리 노트는 발행 문제·정답·해설에서 만든 파생 내용이라 게스트에게도 원본과 같은 범위로 보인다. 요약은 게스트가 지금 읽을 수 있는 발행 revision과 일치할 때만 준다(이전 revision 요약은 이미 바뀐 원문을 담을 수 있으므로 404). 정리 노트는 **출처 일치**(인용한 모든 문제가 살아 있고 CONFIRMED이며 active revision이 노트에 고정된 revision과 같음)일 때만 게스트에게 준다 — 인용 문제가 삭제·보관·수정되면 노트 본문에 공개 범위 밖이 된 정답·해설이 남을 수 있으므로 다시 만들 때까지 본문 없이 "정리 노트가 갱신 중이거나 없습니다."(API 404, 목록 제외; Codex P1). 텍스트 내보내기는 사용자 결정 Q9로 멤버 전용이다(게스트는 화면에서 원문을 읽을 수만 있다; DRM 아님 — §1 저작권 행).
- 공유 응답은 §2의 header(`no-store`, `no-referrer`)를 따르고, 생성 상태·오류 코드·usage·job id·`question_refs`의 revision id를 주지 않는다. 매 요청 링크 상태를 재검증하므로 철회 후에는 이미 열린 panel의 요청도 거부된다.
- Fork는 요약(현재 snapshot revision의 성공 요약과 자동 갱신 설정)과, 장마다 최신 정리 노트 중 snapshot 기준 출처 일치인 것만 새 id로 복제한다(일치하지 않으면 그 장은 노트 없이 복제)(§6 개인 데이터 제외 규칙 유지; 이전 기록·실패 run·usage 제외).

## 9. 모의고사·범위 풀이 (MOCK-SPEC 2026-11-01)

모의고사([MOCK-01](screens/mock-exams.md))와 범위 풀이([QVIEW-01](screens/question-viewer.md))는 구성원 기능이다.

| 기능 | Owner·editor | viewer(멤버) | 링크 게스트 |
|---|:---:|:---:|:---:|
| 모의고사 목록·문제 보기 | ✅ (정답·해설 포함 관리 보기) | ✅ (풀기 전 정답 없음) | ❌ |
| 모의고사 만들기·편집·다시 만들기·삭제 | ✅ 활성 Workspace | ❌ | ❌ |
| 모의고사·등록 문제 범위 풀이(개인 기록) | ✅ (보관 Workspace는 제출 불가) | ✅ (같음) | ❌ |

- **사용자 결정(2026-11-01):** 모의고사는 공유 링크 게스트에게 보이지 않고 Fork에 복제되지 않는다. 근거: 모의고사 문제는 사람이 승인하지 않은 AI 생성 문제이고 발행(PUBLISHED) 범위에 들어가지 않는다(§1 "열람 범위"는 발행된 문제만). 공유 세션으로 모의고사·`practice-runs` API를 부르면 404다. 게스트 공유 화면의 문제 미리보기는 `QuestionViewer` `read-only` 방식으로 바뀌지만 범위는 그대로(발행 문제·정답·해설, 저장 없음)다.
- Fork는 §6 그대로 개인 데이터(풀이 묶음·모의고사 풀이 기록)를 복제하지 않는다. 모의고사를 Fork에 넣을지(예: 발행 문제 원본이 모두 snapshot에 있을 때만 복제)는 후속 결정이다.

## 10. AI 질문·AI 문제 해설·관련 본문 (ASK-SPEC 2026-11-01 사용자 결정, ASK-SYNC 2026-11-02)

| 기능 | Owner·editor | viewer(멤버) | 링크 게스트 |
|:--|:---:|:---:|:---:|
| AI 질문(ASK-01) | ✅ 자기 대화만, 활성 Workspace에서 질문 | ✅ 같음 | ❌ (버튼 없음, API 401/404) |
| 남의 AI 질문 대화 보기 | ❌ (Owner도 404, 사용자 결정 2026-11-01) | ❌ | ❌ |
| AI 해설 읽기(AIEXPL-01) | ✅ 제출 후·문제 상세 | ✅ 같음 | 이미 만든 최신 해설만, 읽기 전용 |
| AI 해설(만들기) | ✅ 활성 Workspace | ✅ 활성 Workspace | ❌ |
| AI 해설 다시 만들기 | ✅ 하루 3번/revision | ❌ | ❌ |
| 관련 본문(RELSRC-01) | ✅ 제출 후·문제 상세(처음 읽을 때 계산·저장) | ✅ 같음 | 이미 저장된 목록만, 읽기 전용(사용자 결정 2026-11-01) |
| 모의고사 문제의 `질문하기`·AI 해설·관련 본문(ASK-SYNC) | ✅ 풀이(`sequence(mock)`)·문제 관리(`manage(mock)`) | ✅ 풀이 | ❌ (모의고사가 게스트에게 없음, §9) |

- **결정(사용자 결정 2026-11-01):** AI 질문은 비용이 들고 질문이 개인 기록이라 게스트에게 열지 않는다. AI 해설은 발행 문제의 정답·해설에서 나온 파생물이라 이미 만든 것은 게스트에게도 같은 범위로 보이고, 게스트 요청으로는 생성(비용)이 일어나지 않는다. 공유 응답에는 상태·버전·오류·usage·job id가 없고 §2 header를 따른다.
- **Fork:** AI 질문 대화·usage는 개인 데이터라 복제하지 않는다(§6). AI 해설은 snapshot 문제 revision의 최신 성공 해설만 새 id로 복제하고(문제·revision·출처 블록 id 재매핑) 이전 버전·실패·usage는 뺀다(사용자 결정 2026-11-01). 관련 본문은 복제하지 않는다 — 사본의 문서 id가 달라 교재 fingerprint가 바뀌므로 처음 읽을 때 다시 계산된다(LLM 비용 없음; 사용자 결정 2026-11-01).
- **모의고사 문제 (ASK-SYNC 2026-11-02):** 모의고사는 공유 링크 게스트에게 보이지 않고 Fork에 복제되지 않으므로(§9), 모의고사 문제의 AI 해설(`mock_exam_question_ai_explanations`)·관련 본문(`mock_exam_question_related_sources`)·그 문제를 첨부한 대화도 공유 API가 없고 복제되지 않는다. 공유 세션으로 `/mock-exam-questions/{id}/ai-explanation`·`/related-sources`를 부르면 401/404다.

## 11. 하이라이트·챕터 재분배·정리 노트 읽기 도구 (UX9-SPEC 2026-11-02)

| 기능 | 구성원 | 공유 링크 게스트 | Fork |
|---|---|---|---|
| 하이라이트·`내 하이라이트` ([HILITE-01](screens/highlights.md)) | 자기 것만(다른 구성원 것은 보이지 않음) | ❌ — 공유 API 응답에 하이라이트 필드 없음, 선택 메뉴 없음. 예외: `include_owner_records`를 켠 링크는 Owner의 하이라이트만 `/owner-highlights`로 읽기(§12) | ❌ — `user_highlights`를 복제하지 않음(개인 기록, `question_user_states`와 같은 범위) |
| 챕터 재분배 ([CHREDIST-01](screens/chapter-redistribution.md)) | 편집 권한 | ❌ (공유 router에 없음, 404) | 사본의 문제는 `chapter_id`·`chapter_source`를 그대로(재매핑) 가짐, 이력 행(`question_chapter_changes`)은 복제하지 않음 |
| 정리 노트 검색·각주 미리보기 ([CHNOTE-02](screens/chapter-note-tools.md)) | ✅ | ✅ — 미리보기는 `GET /shared/{shareId}/questions/{questionId}/preview`(발문·보기만, 발행 범위 문제만) | 사본 노트에 같은 도구 |

- 챕터를 옮겨도 공유 정리 노트의 출처 일치 판정(§8)은 바뀌지 않는다(인용 문제의 상태·revision이 그대로).

## 12. 공유 범위 선택·Owner 기록 읽기 전용 (UX12-SHARE, 사용자 결정 2026-11-06)

화면 AC는 [UX12-SHARE](screens/ux12-share-scope.md)에 있다. 2026-11-02 결정(하이라이트·풀이는 게스트에게 없음, §1·§3·§11)을 옵션을 켠 링크에 한해 개정한다. 옵션을 끈 링크는 이전 결정 그대로다.

| 옵션 | 기본값 | 게스트 | Fork |
|---|:---:|---|---|
| `include_notes` | 켜짐 | 끄면 노트 route 404, 카드 없음 | 끄면 노트 복사 없음 |
| `include_ai_explanations` | 켜짐 | 끄면 AI 해설 route 404, 영역 없음 | 끄면 AI 해설 복사 없음 |
| `include_summary` | 켜짐 | 끄면 요약 route 404, 버튼 없음 | 끄면 요약과 자동 갱신 설정(`summary_enabled_at`) 복사 없음 |
| `include_owner_records` | 꺼짐 | 켜면 Owner의 풀이 이력·하이라이트 읽기. 끄면 404, 카드 없음 | 항상 복사 없음 |

- **권한:** 옵션은 Owner만 바꾼다(PATCH `workspace.share.manage`). 보관 Workspace에서도 정책 수정으로 허용한다. 재발급은 네 옵션을 옮긴다. 기존 링크는 기본값으로 지금과 같게 동작한다.
- **검사 위치:** 모든 해당 공유 route가 요청마다 DB의 링크 값을 읽고, 꺼지면 없는 id와 같은 본문의 404를 준다. 화면에서 숨기는 것은 편의일 뿐 API 검사가 경계다. 관련 본문(`related-sources`)과 문제 미리보기(`preview`)는 옵션 대상이 아니다. 둘 다 원문과 발행 문제에서 나오고 AI 생성물이 아니기 때문이다.
- **Fork:** `POST /shared/{id}/forks`가 세 옵션을 manifest `include`(`notes`, `ai_explanations`, `summary`)에 고정하고, `worker_fork_commit`과 복사 trigger가 잠근 링크의 현재 값과 AND 한다. 옵션 키가 없는 이전 manifest는 고정값을 켜짐으로 읽는다(그래도 현재 값은 검사한다). 진행 중 Fork에서 옵션을 꺼도 취소되지 않고 그 항목만 빠지며, 도중에 켜도 고정값이 꺼져 있으면 복사되지 않는다.
- **Owner 기록의 Owner:** `workspaces.owner_id`다. 링크를 만든 사람이나 다른 구성원의 기록은 읽지 않는다. 클라이언트가 사용자를 고를 수 없다.
- **풀이 이력(`/owner-attempts`):** 확정되어 게스트가 지금 읽을 수 있는 문제의 풀이만, 최신순. 문제 id·번호·발문 앞 40자·유형·결과(`correct`/`incorrect`/`pending`)·제출 시각만 준다. 제출 답안, 표시 순서, 풀이 묶음 id, revision id는 주지 않는다. 이전 revision의 보기 내용이나 Owner가 쓴 답을 공개 범위로 끌어오지 않기 위해서다. 모의고사 풀이(`mock_exam_attempts`)는 없다(§9).
- **하이라이트(`/owner-highlights`):** 살아 있는 행만, 최신순. 인용문·색·만든 시각과 대상(문제 번호·발문 앞 40자, 또는 장 이름)만 준다. 해설 하이라이트는 확정 문제의 현재 해설에서 다시 찾은 것(`exact`·`relocated`)만, 노트 하이라이트는 `include_notes`가 켜져 있고 그 장에서 게스트가 지금 읽는 노트 버전의 것만 준다. 이전 내용의 인용문은 공개 범위 밖이다(§8과 같은 이유).
- **읽기 전용:** 공유 세션에는 쓰기 route가 없다. 게스트 요청은 Owner 기록을 만들거나 바꾸지 않는다. 응답에 Owner의 id·이름·이메일이 없고, 화면은 `공유자`로만 부른다.
