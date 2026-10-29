# Document summary evaluation

- provider: `fake` · model: `fake-extractive-summary`
- support threshold: 0.65 · chapter chars: 24000
- documents: 2 · non-empty chapters: 4

| metric | value |
|---|---|
| chapter coverage (summary + key point) | 100.0% |
| chapters reached by the document summary | 100.0% |
| proposed key points with pages | 100.0% (16/16) |
| proposed page citations in range | 100.0% |
| proposed page citations supported by the page text | 100.0% (mean support 1.0) |
| stored page citations supported | 100.0% (16/16) |
| input / output tokens | 2907 / 1334 |
| cost (USD, LLM_PRICE_*) | - |

| document | chapters | coverage | in doc summary | citations supported | calls |
|---|---|---|---|---|---|
| book-ko | 2 | 100.0% | 100.0% | 100.0% | 2+0+1 |
| book-en | 2 | 100.0% | 100.0% | 100.0% | 2+0+1 |
