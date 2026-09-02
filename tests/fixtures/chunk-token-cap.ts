/**
 * Fixture for the token-cap integration test (spawned by tests/chunk-tokens.test.ts).
 *
 * Chunks a fixed long TS function and prints { count, contentLen }. The caller
 * sets MAX_CHUNK_TOKENS in the env so the chunker's effective char limit changes;
 * INDEXER_CONFIG points at a non-existent YAML so only defaults + env apply.
 */
import { chunkCode } from "../../src/chunking/chunker";

// ~870 chars: a single function well under the default 1500-char limit but far
// over a small token cap (e.g. MAX_CHUNK_TOKENS=50 -> effective 200 chars).
const LONG_FN = `function big() {\n${"  let x = 0;\n".repeat(60)}  return x;\n}\n`;

const chunks = await chunkCode("fixture.ts", LONG_FN);
console.log(JSON.stringify({ count: chunks.length, contentLen: LONG_FN.length }));
