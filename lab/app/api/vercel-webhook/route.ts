import { createHmac, timingSafeEqual } from "node:crypto";

export const dynamic = "force-dynamic";

// Receiver for Vercel's signed webhooks (Spend Management budget alerts, account
// webhooks). Vercel signs the raw body with HMAC-SHA1 using the secret shown when
// the webhook is saved, and sends the hex digest in `x-vercel-signature`.
// The payload is logged as one JSON line, so it leaves through the log drain.
export async function POST(request: Request) {
  const secret = process.env.VERCEL_WEBHOOK_SECRET;
  if (!secret) {
    return new Response("Webhook secret not configured", { status: 503 });
  }

  const body = Buffer.from(await request.arrayBuffer());
  const expected = createHmac("sha1", secret).update(body).digest();
  const received = Buffer.from(request.headers.get("x-vercel-signature") ?? "", "hex");
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
    return Response.json({ code: "invalid_signature" }, { status: 403 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(body.toString("utf8"));
  } catch {
    return Response.json({ code: "invalid_json" }, { status: 400 });
  }
  console.log(JSON.stringify({ msg: "vercel webhook", payload }));
  return new Response("OK");
}
