import { Sandbox } from "@vercel/sandbox";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function GET(request: Request) {
  const secret = new URL(request.url).searchParams.get("secret");
  if (!process.env.LAB_SECRET || secret !== process.env.LAB_SECRET) {
    return new Response("Unauthorized", { status: 401 });
  }

  const sandbox = await Sandbox.create({
    resources: { vcpus: 1 },
    timeout: 60_000,
    persistent: false,
  });
  try {
    const echo = await sandbox.runCommand("echo", ["hello"]);
    const node = await sandbox.runCommand("node", ["-v"]);
    const result = {
      sandbox: sandbox.name,
      echo: (await echo.stdout()).trim(),
      node: (await node.stdout()).trim(),
    };
    console.log(JSON.stringify({ msg: "sandbox run", ...result }));
    return Response.json(result);
  } finally {
    await sandbox.stop();
  }
}
