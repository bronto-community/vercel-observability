import { get } from "@vercel/global-config";

export const dynamic = "force-dynamic";

export async function GET() {
  const greeting = await get<string>("greeting");
  console.log(JSON.stringify({ msg: "global config read", key: "greeting", found: greeting !== undefined }));
  return Response.json({ key: "greeting", value: greeting ?? null });
}
