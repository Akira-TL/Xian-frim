import sharp from "../../services/web/node_modules/sharp/dist/index.mjs";
import {mkdir} from "node:fs/promises";
import {fileURLToPath} from "node:url";
import {join} from "node:path";

const root = fileURLToPath(new URL("../../", import.meta.url));
const output = join(root, "services/web/public/images/display-v1");
await mkdir(output, {recursive: true});
const assets: ReadonlyArray<readonly [string, number]> = [
  ["explore-hero", 1080], ["collection-hero", 1080], ["route-panorama", 1200],
  ["collection-heading", 960], ["qin-card", 480], ["gate-card", 480], ["poem-card", 480],
];
for (const [name, width] of assets) {
  const result = await sharp(join(root, "assets/web-display-v1", `${name}.png`))
    .resize({width, withoutEnlargement: true}).webp({quality: 84, effort: 6})
    .toFile(join(output, `${name}.webp`));
  console.log(`${name}: ${result.width}×${result.height}, ${result.size} 字节`);
}
