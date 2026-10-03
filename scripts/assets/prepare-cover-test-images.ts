import sharp from "../../services/web/node_modules/sharp/dist/index.mjs";
import {mkdir} from "node:fs/promises";
import {resolve} from "node:path";

const directory = resolve(process.argv[2] ?? "build/cover-test-images");
await mkdir(directory, {recursive: true});
for (const [name, width, progressive, background] of [
  ["red", 360, false, "#ed2418"],
  ["green", 360, false, "#24bd42"],
  ["wrong-size", 361, false, "#ed2418"],
  ["progressive", 360, true, "#ed2418"],
] as const) {
  await sharp({create: {width, height: 360, channels: 3, background}})
    .jpeg({quality: 75, progressive}).toFile(resolve(directory, `${name}.jpg`));
}
