# Mock exam validation evaluation

- provider: `fake` · model: `fake-mock-exam-llm`
- dataset: `eval/mock_exams/mock-seed.json` · cases: 6 (no question: 1) · requested questions: 24

| metric | value |
|---|---|
| pass rate (stored / requested) | 87.5% (21/24) |
| first-pass rate (before the re-request) | 87.5% (21/24) |
| re-requested items / unreadable answers | 3 / 2 |
| stored with a warning (확인 필요) | 0 |
| skipped (final code) | `answer_not_in_options` 1, `citation_not_in_passage` 1, `inverted_answer_mismatch` 1 |
| LLM calls / validated batches | 12 / 10 |
| calls per stored question | 0.5714 |
| input / output tokens | 19514 / 21917 |
| cost (USD, LLM_PRICE_*) | - |

| case | type | pass rate | re-requested | unreadable | calls | skipped |
|---|---|---|---|---|---|---|
| paraphrase-6 | PARAPHRASE | 100.0% (6/6) | 0 | 0 | 1 | - |
| invert-6 | INVERT_POLARITY | 100.0% (6/6) | 0 | 0 | 1 | - |
| invert-faults | INVERT_POLARITY | 66.7% (2/3) | 1 | 0 | 2 | `inverted_answer_mismatch` 1 |
| broken-batch | PARAPHRASE | 100.0% (4/4) | 0 | 1 | 3 | - |
| truncated-batch | PARAPHRASE | 100.0% (3/3) | 0 | 1 | 3 | - |
| all-fail | PARAPHRASE | 0.0% (0/2) | 2 | 0 | 2 | `answer_not_in_options` 1, `citation_not_in_passage` 1 |
