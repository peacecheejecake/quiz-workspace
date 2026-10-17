# Retrieval evaluation: seed-fake

- Dataset: `retrieval-seed` (6 queries, synthetic; en 3, ko 3)
- Documents: `book-ko` (ko, 11 child chunks), `book-en` (en, 9 child chunks)
- Embedder: `fake-embedder`; reranker: `fake-reranker`
- Index: memory, 32 points
- Limits: dense 30, keyword 30, RRF k 60, rerank top 20, results 10

Metrics: Recall@5/10, MRR@10, nDCG@10 (linear gain). A judgement is a (document, section); repeated hits of one section count once. Overall = every query against every document; directions = one document language at a time.

## Overall

| run | R@5 | R@10 | MRR@10 | nDCG@10 | location ok |
|---|---:|---:|---:|---:|---:|
| keyword / rerank off | 0.500 | 0.500 | 0.917 | 0.575 | 6/6 |
| keyword / rerank top_k | 0.500 | 0.500 | 0.917 | 0.575 | 6/6 |
| semantic / rerank off | 0.500 | 0.667 | 0.736 | 0.577 | 8/8 |
| semantic / rerank top_k | 0.500 | 0.583 | 0.917 | 0.605 | 7/7 |
| hybrid / rerank off | 0.583 | 0.583 | 0.917 | 0.615 | 7/7 |
| hybrid / rerank top_k | 0.500 | 0.583 | 0.917 | 0.605 | 7/7 |

## By direction (query → documents)

**R@5**

| run | EN→EN | EN→KO | KO→EN | KO→KO |
|---|---:|---:|---:|---:|
| keyword / rerank off | 1.000 | 0.000 | 0.000 | 1.000 |
| keyword / rerank top_k | 1.000 | 0.000 | 0.000 | 1.000 |
| semantic / rerank off | 1.000 | 0.667 | 0.667 | 0.667 |
| semantic / rerank top_k | 1.000 | 0.667 | 0.667 | 1.000 |
| hybrid / rerank off | 1.000 | 0.667 | 0.667 | 1.000 |
| hybrid / rerank top_k | 1.000 | 0.667 | 0.667 | 1.000 |

**MRR@10**

| run | EN→EN | EN→KO | KO→EN | KO→KO |
|---|---:|---:|---:|---:|
| keyword / rerank off | 1.000 | 0.000 | 0.000 | 0.833 |
| keyword / rerank top_k | 1.000 | 0.000 | 0.000 | 0.833 |
| semantic / rerank off | 1.000 | 0.542 | 0.206 | 0.472 |
| semantic / rerank top_k | 1.000 | 0.542 | 0.206 | 0.833 |
| hybrid / rerank off | 1.000 | 0.542 | 0.206 | 0.833 |
| hybrid / rerank top_k | 1.000 | 0.542 | 0.206 | 0.833 |

**nDCG@10**

| run | EN→EN | EN→KO | KO→EN | KO→KO |
|---|---:|---:|---:|---:|
| keyword / rerank off | 1.000 | 0.000 | 0.000 | 0.877 |
| keyword / rerank top_k | 1.000 | 0.000 | 0.000 | 0.877 |
| semantic / rerank off | 1.000 | 0.649 | 0.391 | 0.596 |
| semantic / rerank top_k | 1.000 | 0.649 | 0.391 | 0.877 |
| hybrid / rerank off | 1.000 | 0.649 | 0.391 | 0.877 |
| hybrid / rerank top_k | 1.000 | 0.649 | 0.391 | 0.877 |

## Sweep (RRF k x candidate depth)

| run | rrf_k | depth | R@5 | R@10 | MRR@10 | nDCG@10 | cross R@5 |
|---|---:|---:|---:|---:|---:|---:|---:|
| hybrid / rerank off | 0 | 5 | 0.583 | 0.583 | 0.917 | 0.615 | 0.667 |
| hybrid / rerank off | 0 | 10 | 0.583 | 0.583 | 0.917 | 0.615 | 0.667 |
| hybrid / rerank off | 0 | 20 | 0.583 | 0.583 | 0.917 | 0.615 | 0.667 |
| hybrid / rerank off | 0 | 30 | 0.583 | 0.583 | 0.917 | 0.615 | 0.667 |
| hybrid / rerank off | 0 | 50 | 0.583 | 0.583 | 0.917 | 0.615 | 0.667 |
| hybrid / rerank off | 10 | 5 | 0.583 | 0.583 | 0.833 | 0.577 | 0.667 |
| hybrid / rerank off | 10 | 10 | 0.583 | 0.583 | 0.917 | 0.615 | 0.667 |
| hybrid / rerank off | 10 | 20 | 0.583 | 0.583 | 0.917 | 0.615 | 0.667 |
| hybrid / rerank off | 10 | 30 | 0.583 | 0.583 | 0.917 | 0.615 | 0.667 |
| hybrid / rerank off | 10 | 50 | 0.583 | 0.583 | 0.917 | 0.615 | 0.667 |
| hybrid / rerank off | 30 | 5 | 0.583 | 0.583 | 0.833 | 0.577 | 0.667 |
| hybrid / rerank off | 30 | 10 | 0.583 | 0.583 | 0.917 | 0.615 | 0.667 |
| hybrid / rerank off | 30 | 20 | 0.583 | 0.583 | 0.917 | 0.615 | 0.667 |
| hybrid / rerank off | 30 | 30 | 0.583 | 0.583 | 0.917 | 0.615 | 0.667 |
| hybrid / rerank off | 30 | 50 | 0.583 | 0.583 | 0.917 | 0.615 | 0.667 |
| hybrid / rerank off | 60 | 5 | 0.583 | 0.583 | 0.833 | 0.577 | 0.667 |
| hybrid / rerank off | 60 | 10 | 0.583 | 0.583 | 0.917 | 0.615 | 0.667 |
| hybrid / rerank off | 60 | 20 | 0.583 | 0.583 | 0.917 | 0.615 | 0.667 |
| hybrid / rerank off | 60 | 30 | 0.583 | 0.583 | 0.917 | 0.615 | 0.667 |
| hybrid / rerank off | 60 | 50 | 0.583 | 0.583 | 0.917 | 0.615 | 0.667 |
| hybrid / rerank off | 100 | 5 | 0.583 | 0.583 | 0.833 | 0.577 | 0.667 |
| hybrid / rerank off | 100 | 10 | 0.583 | 0.583 | 0.917 | 0.615 | 0.667 |
| hybrid / rerank off | 100 | 20 | 0.583 | 0.583 | 0.917 | 0.615 | 0.667 |
| hybrid / rerank off | 100 | 30 | 0.583 | 0.583 | 0.917 | 0.615 | 0.667 |
| hybrid / rerank off | 100 | 50 | 0.583 | 0.583 | 0.917 | 0.615 | 0.667 |

Best (R@5, then MRR@10, nDCG@10, then cheapest): hybrid rerank off, RRF k 0, depth 5.
