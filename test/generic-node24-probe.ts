import { extractGeneric, GENERIC_LANGS, warmGenericGrammars } from "../src/graph/generic.js";

const languages = GENERIC_LANGS.map((lang) => lang.name);
const source = "pub fn run() -> usize { helper() }\nfn helper() -> usize { 1 }\n";

await warmGenericGrammars(languages);
for (let iteration = 0; iteration < 64; iteration++) {
  for (const language of languages) {
    extractGeneric(`src/probe-${iteration}.${language}`, source, language);
  }
}
