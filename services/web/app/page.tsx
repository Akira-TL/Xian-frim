import OperatorPanel from "./operator-panel";
import Link from "next/link";

export default function Home() {
  return <><nav className="mx-auto max-w-5xl px-4 pt-4"><Link className="underline" href="/dashboard">查看活动数据看板</Link></nav><OperatorPanel /></>;
}
