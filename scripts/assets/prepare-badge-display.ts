import sharp from "../../services/web/node_modules/sharp/dist/index.mjs";
import {fileURLToPath} from "node:url";
import {join} from "node:path";
// 只缩小已有生成插画；游戏点击区域、奖励和三片拼图素材保持不变。
const root=fileURLToPath(new URL("../../",import.meta.url));
await sharp(join(root,"assets/web-display-v1/explore-hero.png"))
 .resize(360,360,{fit:"cover",position:"centre"}).png({palette:true,colours:128})
 .toFile(join(root,"assets/qin/cover.png"));
console.log("圆屏封面：360×360，128色；复用网页生成插画。");
