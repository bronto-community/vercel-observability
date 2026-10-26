import { checkBotId } from "botid/server";

export async function POST() {
  const verification = await checkBotId();
  console.log(JSON.stringify({ msg: "botid check", isBot: verification.isBot }));
  if (verification.isBot) {
    return Response.json({ error: "Access denied" }, { status: 403 });
  }
  return Response.json({ isBot: false });
}
