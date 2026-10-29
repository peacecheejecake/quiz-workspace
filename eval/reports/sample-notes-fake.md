# Chapter note evaluation

- provider: `fake` · model: `fake-scripted-note`
- dataset: `eval/summaries/notes-seed.json` · chapters: 4 (failed 0) · questions: 11

| metric | value |
|---|---|
| footnote precision (cited question supports the item) | 93.3% (14/15) |
| items with a supported footnote | 92.3% |
| footnote coverage (questions cited) | 90.9% (10/11) |
| keyword coverage | 95.2% |
| proposed items with valid citations | 89.5% (17/19) |
| dropped items / re-requests | 1 / 1 |
| LLM calls / input / output tokens | 5 / 4976 / 710 |
| cost (USD, LLM_PRICE_*) | - |

| chapter | precision | coverage | keyword coverage | dropped | calls |
|---|---|---|---|---|---|
| book-ko/ch1 | 75.0% | 100.0% | 100.0% | 1 | 2 |
| book-ko/ch2 | 100.0% | 100.0% | 100.0% | 0 | 1 |
| book-en/ch1 | 100.0% | 66.7% | 80.0% | 0 | 1 |
| book-en/ch2 | 100.0% | 100.0% | 100.0% | 0 | 1 |
