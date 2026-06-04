"""RAG / code retrieval subsystem.

Three responsibilities:
  - vector: lazy-loaded Qdrant client (local or remote)
  - chunker: splits source files into overlapping line windows
  - indexer / retriever: walk corpus, embed via Ollama, store / query

The bge-m3 model used for embeddings is multilingual (strong in Korean)
and 1024-dim; it must be pulled into Ollama once with
`ollama pull bge-m3` on whichever box runs OLLAMA_BASE_URL.
"""
