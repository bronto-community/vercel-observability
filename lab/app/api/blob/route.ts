import { put, head, list, del } from "@vercel/blob";

export const dynamic = "force-dynamic";

export async function GET() {
  const pathname = `lab/hello-${Date.now()}.txt`;
  const blob = await put(pathname, "hello from the observability lab", {
    access: "public",
    contentType: "text/plain",
  });
  const meta = await head(blob.url);
  const { blobs } = await list({ prefix: "lab/" });
  await del(blob.url);
  console.log(JSON.stringify({ msg: "blob roundtrip", pathname, size: meta.size, listed: blobs.length }));
  return Response.json({ pathname, size: meta.size, listed: blobs.length, deleted: true });
}
