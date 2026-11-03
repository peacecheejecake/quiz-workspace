# AI question and AI explanation evaluation

- provider: `fake` · model: `scripted-ask`
- dataset: `eval/ask/ask-seed.json` · ask cases: 18 · explanation cases: 6

| metric | value |
|---|---|
| citation validity (known tags / raw tags) | 91.7% (24 tags, 1 answers lost a tag) |
| answers that had passages but cited none | 1 / 14 |
| grounding (cited paragraph supported by its passage) | 86.4% (22 paragraphs) |
| grounding, LLM judge | - (0) |
| not-found accuracy | 88.9% (refused 3/4, false refusals 1/14) |
| `hint` answer leakage | 33.3% (2/6; registered 1/3, mock exam 1/3) |
| AI explanation answer agreement | 83.3% (6 cases) |
| AI explanation valid at once / after the re-request | 66.7% / 83.3% (1 re-request) |
| AI explanation failures | {'explanation_answer_mismatch': 1} |
| LLM calls | 25 |
| input / output tokens | 11502 / 1492 |
| cost (USD, LLM_PRICE_*) | - |
| first text p50 / p95 (ms, this process; queue wait and worker RAM are measured on the stack) | 0.002 / 0.005 |

| ask case | kind | answer | tags (known) | cited paragraphs (supported) | leaked |
|---|---|---|---|---|---|
| plain-evaporation | answerable | answered | 2 (2) | 2 (2) | - |
| plain-condensation | answerable | answered | 2 (2) | 2 (2) | - |
| plain-runoff | answerable | answered | 1 (1) | 1 (1) | - |
| plain-flocculation | answerable | answered | 3 (3) | 3 (3) | - |
| unknown-tag | answerable | answered | 4 (2) | 2 (2) | - |
| uncited | answerable | answered | 0 (0) | 0 (0) | - |
| unsupported-sentence | answerable | answered | 2 (2) | 2 (1) | - |
| false-refusal | answerable | refused | 0 (0) | 0 (0) | - |
| nothing-relevant | not_found | refused | 0 (0) | 0 (0) | - |
| nothing-relevant-english | not_found | refused | 0 (0) | 0 (0) | - |
| nothing-relevant-no-sources | not_found | refused | 0 (0) | 0 (0) | - |
| invents-an-answer | not_found | answered | 1 (1) | 1 (0) | - |
| hint-evaporation | hint | answered | 2 (2) | 2 (1) | False |
| hint-flocculation | hint | answered | 2 (2) | 2 (2) | False |
| hint-names-number | hint | answered | 1 (1) | 1 (1) | True |
| mock-hint-disinfection | hint | answered | 2 (2) | 2 (2) | False |
| mock-hint-runoff | hint | answered | 1 (1) | 1 (1) | False |
| mock-hint-final-answer | hint | answered | 1 (1) | 1 (1) | True |

| explanation case | answer line | valid at once | after re-request | error |
|---|---|---|---|---|
| explain-evaporation | ok | True | True | - |
| explain-condensation | ok | True | True | - |
| explain-flocculation | ok | True | True | - |
| explain-wrong-answer-line | wrong | False | False | explanation_answer_mismatch |
| explain-skips-an-option | ok | False | True | explanation_incomplete |
| explain-no-passage | ok | True | True | - |
