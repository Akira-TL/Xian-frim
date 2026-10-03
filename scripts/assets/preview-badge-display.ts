import sharp from "../../services/web/node_modules/sharp/dist/index.mjs";
import {readFile} from "node:fs/promises";
import {fileURLToPath} from "node:url";
import {join} from "node:path";
const root=fileURLToPath(new URL("../../",import.meta.url));
const folder=join(root,"logs/badge-display-v1-preview");
const pages=["home","selection","game","collection","gate-selection","poem-game"];
const panels: {input:Buffer;left:number;top:number}[]=[];
for(const [index,name] of pages.entries()){
 const ppm=await readFile(join(folder,`${name}.ppm`));
 const header=Buffer.from("P6\n360 360\n255\n");
 if(!ppm.subarray(0,header.length).equals(header)||ppm.length!==header.length+360*360*3) throw new Error(`预览格式不符：${name}`);
 const png=await sharp(ppm.subarray(header.length),{raw:{width:360,height:360,channels:3}}).png().toBuffer();
 await sharp(png).toFile(join(folder,`${name}.png`));
 panels.push({input:png,left:index%3*360,top:Math.floor(index/3)*360});
}
await sharp({create:{width:1080,height:720,channels:3,background:"#f7efdf"}}).composite(panels).png().toFile(join(folder,"overview.png"));
