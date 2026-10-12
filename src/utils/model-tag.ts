/**
 * Model-tag matching shared by every backend probe consumer.
 *
 * Ollama resolves a bare name to its `:latest` tag, so `qwen3-embedding` must
 * match `qwen3-embedding:latest` (and a pinned `…:8b-q8_0` matches exactly).
 * llama-server serves a single model whose id is the `-a` alias (or the model
 * file basename); the same name/prefix semantics apply and keep the one
 * implementation true for both backends.
 */
export function modelTagPresent(models: string[], model: string): boolean {
  if (model.length === 0) return false;
  return models.some((m) => m === model || m.startsWith(`${model}:`));
}