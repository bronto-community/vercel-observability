import { metric } from "@vercel/functions";

export const dynamic = "force-dynamic";

const plans = ["free", "pro"] as const;

export async function GET() {
  const plan = plans[Math.floor(Math.random() * plans.length)];
  metric("lab.orders.created", 1, { plan });
  return Response.json({ metric: "lab.orders.created", value: 1, plan });
}
