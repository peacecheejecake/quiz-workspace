# AI question and AI explanation evaluation

- provider: `fake` · model: `scripted-ask`
- dataset: `eval/ask/ask-seed.json` · ask cases: 21 · explanation cases: 6

| metric | value |
|---|---|
| citation validity (known tags / raw tags) | 92.6% (27 tags, 1 answers lost a tag) |
| answers that had passages but cited none | 1 / 17 |
| grounding (cited paragraph supported by its passage) | 84.0% (25 paragraphs) |
| grounding, LLM judge | - (0) |
| not-found accuracy | 90.5% (refused 3/4, false refusals 1/17) |
| `hint` answer leakage | 22.2% (2/9; registered 1/5, mock exam 1/4) |
| AI explanation answer agreement | 83.3% (6 cases) |
| AI explanation valid at once / after the re-request | 66.7% / 83.3% (1 re-request) |
| AI explanation failures | {'explanation_answer_mismatch': 1} |
| LLM calls (generation + judge) | 28 (28 + 0) |
| input / output tokens | 12989 / 1627 |
| cost (USD, LLM_PRICE_*) | - |
| first text p50 / p95 (ms, answer and explanation generation only, judges excluded; this process, queue wait and worker RAM are measured on the stack) | 0.002 / 0.025 |

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
| hint-refuses-the-answer | hint | answered | 1 (1) | 1 (1) | False |
| hint-declines-the-final-answer | hint | answered | 1 (1) | 1 (1) | False |
| mock-hint-self-solve | hint | answered | 1 (1) | 1 (0) | False |
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
