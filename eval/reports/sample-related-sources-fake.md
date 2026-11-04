# Related passages evaluation

- embedder: `fake-embedder` (keyword half of the search; offline) · limit: 5 rows · dataset: `eval/related_sources/related-seed.json` · cases: 9

| metric | value |
|---|---|
| question source blocks in the list | 100.0%, first: True |
| recall@5 of the gold passages | 72.7% (6/9 lists hold every gold passage) |
| rows per list | 4.0 |
| rows from a question paper / a mixed document's question part / an imported source | 0 / 0 / 0 |
| repeated pages in a list | 0 |
| control without the rules: paper hits / question-part hits / imported refs | 61 / 10 / 1 |

| case | rows | source blocks in list | gold in list | gold ranks |
|---|---|---|---|---|
| evaporation | 4 | 1/1 | 1/1 | [1] |
| condensation | 4 | 1/1 | 1/2 | [1, None] |
| precipitation | 4 | 0/0 | 1/1 | [1] |
| runoff | 4 | 1/1 | 1/1 | [1] |
| flocculation | 4 | 0/0 | 0/1 | [None] |
| sedimentation | 4 | 1/1 | 1/2 | [1, None] |
| filtration | 4 | 0/0 | 1/1 | [1] |
| disinfection | 4 | 1/1 | 1/1 | [1] |
| imported-source | 4 | 0/0 | 1/1 | [1] |
