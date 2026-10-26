import Link from "next/link";

const routes = [
  ["/api/blob", "Vercel Blob: put, head, list, del"],
  ["/api/config", "Global Config: read one key"],
  ["/flags", "Flags SDK with the Vercel adapter"],
  ["/image", "Image Optimization via next/image"],
  ["/api/metric", "Custom Metrics via metric()"],
  ["/botid", "BotID: POST to /api/botid"],
  ["/api/sandbox", "Vercel Sandbox (needs ?secret=)"],
];

export default function Home() {
  return (
    <main>
      <h1>Vercel observability lab</h1>
      <ul>
        {routes.map(([href, label]) => (
          <li key={href}>
            <Link href={href} prefetch={false}>{href}</Link> — {label}
          </li>
        ))}
      </ul>
    </main>
  );
}
