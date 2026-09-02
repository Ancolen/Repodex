# Running Ollama CPU-Only

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
mkdir -p ~/.mcp-indexer/models
cat > ~/.mcp-indexer/models/qwen3-embedding-cpu.Modelfile <<'EOF'
FROM qwen3-embedding
PARAMETER num_gpu 0
EOF

ollama create qwen3-embedding-cpu -f ~/.mcp-indexer/models/qwen3-embedding-cpu.Modelfile

# Point cidx at it: set model: qwen3-embedding-cpu in config.yml
# CAUTION: the model name changes → cidx requires a full reindex
# (an index built with model X is incompatible with model Y for vector search).

# To switch back:
#   1. set model: qwen3-embedding in config.yml
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