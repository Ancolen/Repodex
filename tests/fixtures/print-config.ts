// Test helper (not run by bun test; not .test.ts).
// Prints the resolved CONFIG and source path as JSON; config tests run this
// as a subprocess with different environment variables and verify the output.
import { CONFIG, CONFIG_SOURCE } from "../../src/config";

console.log(JSON.stringify({ CONFIG, CONFIG_SOURCE }));
