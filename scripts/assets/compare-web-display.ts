import sharp from "../../services/web/node_modules/sharp/dist/index.mjs";
import {fileURLToPath} from "node:url";
import {join} from "node:path";
const root=fileURLToPath(new URL("../../",import.meta.url));
for(const page of ["explore","collection","route"]){
 const reference=await sharp(join(root,`assets/web-display-v1/references/${page}.png`)).resize(390,844,{fit:"fill"}).png().toBuffer();
 const actual=await sharp(join(root,`logs/display-${page}.png`)).resize(390,844,{fit:"fill"}).png().toBuffer();
 await sharp({create:{width:780,height:844,channels:3,background:"#ffffff"}}).composite([{input:reference,left:0,top:0},{input:actual,left:390,top:0}]).png().toFile(join(root,`logs/display-${page}-comparison.png`));
}
