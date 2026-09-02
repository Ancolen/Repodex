# Ollama CPU-Only Çalıştırma Notları

## Yöntem 1: CUDA_VISIBLE_DEVICES — En güvenilir (tüm modeller CPU'da)

```bash
# 1. Systemd serve'i durdur (sudo gerekli)
sudo systemctl stop ollama

# 2. CPU-only olarak elle başlat
CUDA_VISIBLE_DEVICES="" ollama serve &

# 3. Repodex'i başlat (model adı aynı kalır, reindex gerekmez)
cd ~/repodex && bun run src/cli.ts start

# 4. İş bitince GPU'ya dönmek için:
kill %1                          # elle başlatılan serve'i durdur
sudo systemctl start ollama     # GPU'lu serve'i geri getir
```

## Yöntem 2: Modelfile ile num_gpu 0 — Model bazlı (sadece o model CPU'da)

```bash
# CPU-only model oluştur
mkdir -p ~/.mcp-indexer/models
cat > ~/.mcp-indexer/models/qwen3-embedding-cpu.Modelfile <<'EOF'
FROM qwen3-embedding
PARAMETER num_gpu 0
EOF

ollama create qwen3-embedding-cpu -f ~/.mcp-indexer/models/qwen3-embedding-cpu.Modelfile

# Repodex config'de model: qwen3-embedding-cpu yap
# DİKKAT: Model adı değiştiği için full reindex başlar!

# Geri dönmek için:
#   1. config.yml'de model: qwen3-embedding yap
#   2. ollama rm qwen3-embedding-cpu
#   3. Repodex restart + reindex
```

## Önemli Notlar

- `OLLAMA_NUM_GPU` ve `OLLAMA_GPU_LAYERS` ortam değişkenleri **çalışmıyor** (Ollama geliştiricisi tarafından onaylanmadı).
- `CUDA_VISIBLE_DEVICES=""` tüm GPU'ları gizler — sadece belirli bir modeli değil, hepsini CPU'ya zorlar.
- Modelfile `num_gpu 0` yaklaşımında model adı değiştiği için repodex full reindex yapar.
- Model adı aynı kalırsa (Yöntem 1) reindex gerekmez.

## Repodex Yönetim Komutları

```bash
cd ~/repodex
bun run src/cli.ts start                # daemon başlat
bun run src/cli.ts stop                 # daemon durdur
bun run src/cli.ts list                  # projeleri listele
bun run src/cli.ts status <name>         # proje durumu
bun run src/cli.ts reindex <name>        # full reindex
bun run src/cli.ts sync <name>           # artımlı senkronizasyon
bun run src/cli.ts remove <name>          # projeyi ve indeksi sil
bun run src/cli.ts config                # aktif config'i göster
```