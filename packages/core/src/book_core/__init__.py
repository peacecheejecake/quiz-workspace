"""Quiz Workspace core: PDF processing, search and question drafting.

Contracts live in :mod:`book_core.contracts`; model/LLM adapters and their deterministic fakes
live in :mod:`book_core.embedding`, :mod:`book_core.reranker` and :mod:`book_core.llm`. The core
has no notion of users or authorization; that is the service API's job.
"""

__version__ = "0.0.0"
