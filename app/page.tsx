import type { Metadata } from "next";
import BookReader from "./BookReader";

export const metadata: Metadata = {
  title: "赵铮然的人生建议书 · 个人书房",
  description: "阅读、批注、修订并实践属于赵铮然的一本人生建议书。",
};

export default function Home() {
  return <BookReader />;
}
