# Running the Embedding Backend CPU-Only

If your machine has no usable GPU (or you want to keep the GPU free), Ollama can
be forced to run the embedding model on the CPU. Two reliable methods:

## Method 1: `CUDA_VISIBLE_DEVICES` — most reliable (all models on CPU)

```bash
# 1. Stop the systemd service (needs sudo)
sudo systemctl stop ollama

# 2. Start Ollama manually, CPU-only
CUDA_VISIBLE_DEVICES="" ollama serve &

# 3. Start the cidx daemon (model name stays the same → no reindex needed)
cidx start

# 4. To go back to the GPU when done:
kill %1                          # stop the manually started serve
sudo systemctl start ollama     # bring back the GPU-backed service
```

## Method 2: Modelfile with `num_gpu 0` — per-model (only this model on CPU)

```bash
# Create a CPU-only variant of the embedding model
mkdir -p ~/.cidx/models
cat > ~/.cidx/models/qwen3-embedding-cpu.Modelfile <<'EOF'
FROM qwen3-embedding:0.6b
PARAMETER num_gpu 0
EOF

ollama create qwen3-embedding-cpu -f ~/.cidx/models/qwen3-embedding-cpu.Modelfile

# Point cidx at it: set model: qwen3-embedding-cpu in config.yml
# CAUTION: the model name changes → cidx requires a full reindex
# (an index built with model X is incompatible with model Y for vector search).

# To switch back:
#   1. set model: qwen3-embedding:0.6b in config.yml
#   2. ollama rm qwen3-embedding-cpu
#   3. restart the daemon + reindex
```

## Important notes

- The `OLLAMA_NUM_GPU` and `OLLAMA_GPU_LAYERS` environment variables **do not
  work** (confirmed by the Ollama developers).
- `CUDA_VISIBLE_DEVICES=""` hides ALL GPUs — it forces every loaded model onto
  the CPU, not just one.
- With the Modelfile `num_gpu 0` approach the model name changes, so cidx needs
  a full reindex (see the model-compatibility rule in `docs/architecture.md`).
- With Method 1 the model name stays the same → no reindex needed.

## Shrink the context buffer too (`num_ctx`)

Memory is not only the weights — Ollama also allocates the **context buffer**
up front and holds it for as long as the model stays resident, and it defaults
to `num_ctx` **4096**. cidx pins it explicitly:

- `ollama.numCtx` (default **1024**) for the embed calls — chunks are capped at
  ~512 tokens, and `num_ctx` applies to each input of a batch individually, not
  to the concatenated batch.
- `search.rerank.numCtx` (default **1024**) for the reranker prompt.

Measured on `qwen3-embedding:0.6b` (Ollama 0.33.2, one model loaded):

| `num_ctx` | Resident (ollama ps) |
| --------- | -------------------- |
| 4096 (Ollama default) | 2.4 GB |
| 1024 (cidx default)   | 1.4 GB |

Embeddings are unchanged for inputs that fit. Raise both keys if you raise
`indexing.maxChunkSize` past ~4000 chars (~1024 tokens).

## cidx management commands

```bash
cidx start                # start the daemon (optionally: cidx start /path/project)
cidx stop                 # stop the daemon
cidx list                 # list projects
cidx status <name>        # project status / progress
cidx reindex <name>       # full reindex
cidx sync <name>          # incremental sync
cidx remove <name>        # remove a project and its index
cidx config               # show the active configuration
```
---

# Alternative: llama.cpp CPU-only

`llama-server` runs the same embedding models CPU-only with `-ngl 0` (no GPU layers):

```bash
llama-server -m qwen3-embedding-0.6b-Q8_0.gguf -a qwen3-embedding:0.6b \
  --ctx-size 2048 --embedding -ngl 0 --host 127.0.0.1 --port 8080
```

`--ctx-size` is the total context; with `--parallel N` each request gets `ctx-size / N`, and char-capped chunks can tokenize denser than the chars/4 estimate, so keep the per-slot value above ~1000 tokens.

Point cidx at it with `embedding.provider: llamacpp` + `embedding.llamacppUrl` (or set
just those and leave other projects on Ollama). One llama-server serves one model; a
llama.cpp **reranker** similarly needs its own server via `search.rerank.url` (an
`--embedding` server cannot compute logits).

## Keeping the backend and the daemon in sync

If the embedding server runs as its own systemd **user** unit (e.g. a
`llamacpp-eg2.service`), tell the installer to wire the dependency:

```bash
EMBED_SERVICE=llamacpp-eg2 ./install.sh        # or ... | bash for web-install.sh
```

The generated `cidx.service` then carries `Wants=llamacpp-eg2.service` +
`After=llamacpp-eg2.service`, so the backend is started first. Without it the
daemon may boot before the backend and hit the fail-fast path below.

**Fail-fast (default on).** If the backend is unreachable after
`embedding.readyTimeoutMs` (default 20 s), an index job now aborts *before*
the deleted-file cleanup and any write — the existing index is preserved, and
the error names the backend and suggests `cidx doctor`. Three consecutive
connection-level failures **mid-job** stop new work, commit the slice already
prepared, then fail the job instead of grinding through every file. A 503
"Loading model" is not a connection failure and keeps its transparent retry.
Set `embedding.failFast: false` (or `EMBED_FAIL_FAST=false`) to restore the
legacy per-file attempt/count behavior.
