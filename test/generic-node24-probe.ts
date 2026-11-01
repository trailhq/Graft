import { extractGeneric, GENERIC_LANGS, warmGenericGrammars } from "../src/graph/generic.js";
import { DEPTH_WASM, warmDepthGrammars } from "../src/graph/depth-parser.js";
import { extractFile, type Language } from "../src/graph/extract.js";

const languages = GENERIC_LANGS.map((lang) => lang.name);
const source = "pub fn run() -> usize { helper() }\nfn helper() -> usize { 1 }\n";

await warmGenericGrammars(languages);
for (let iteration = 0; iteration < 64; iteration++) {
  for (const language of languages) {
    extractGeneric(`src/probe-${iteration}.${language}`, source, language);
  }
}

// The depth tier's grammars are WASM too, on their own runtime (depth-parser.ts).
const depth = Object.keys(DEPTH_WASM) as Language[];
const depthSource = "class A {\n  run() { return helper(1) }\n}\nfunction helper(x) { return x }\n";
await warmDepthGrammars(depth);
for (let iteration = 0; iteration < 64; iteration++) {
  for (const language of depth) {
    extractFile(`src/probe-${iteration}.${language}`, depthSource, language);
  }
}
