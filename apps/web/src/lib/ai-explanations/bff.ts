// AIEXPL-01 relays (src/app/api/**/ai-explanation*): the gate query parameters each one forwards
// (anything else is dropped; a malformed value is refused before FastAPI).
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const EXPLANATION_QUERY = {
  question: { practice_session_id: UUID, view: /^detail$/ },
  mock: { mock_practice_session_id: UUID, view: /^manage$/ },
} as const;
