import { Drive, Sandbox } from "@vercel/sandbox";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

// One small Drive, reused across runs. A drive lives in one region, and a
// sandbox that mounts it must run there.
const DRIVE_NAME = "lab-drive";
const REGION = "iad1";

export async function GET(request: Request) {
  // The secret goes in a header, not the query string, so it never appears in request logs.
  const auth = request.headers.get("authorization");
  if (!process.env.LAB_SECRET || auth !== `Bearer ${process.env.LAB_SECRET}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  const drive = await Drive.getOrCreate({ name: DRIVE_NAME, region: REGION, maxSize: 1024 ** 3 });
  const sandbox = await Sandbox.create({
    region: REGION,
    resources: { vcpus: 1 },
    timeout: 60_000,
    persistent: false,
    mounts: { "/data": drive },
  });
  try {
    const file = `/data/run-${Date.now()}.txt`;
    const write = await sandbox.runCommand("bash", ["-c", `echo "written $(date -u +%FT%TZ)" > ${file}`]);
    // Reads this run's file and every earlier run's file on the drive.
    const read = await sandbox.runCommand("bash", ["-c", "cat /data/*.txt"]);
    const result = {
      msg: "drive run",
      drive: drive.name,
      driveId: drive.driveId,
      sandbox: sandbox.name,
      session: sandbox.currentSession().sessionId,
      file,
      writeExitCode: write.exitCode,
      readExitCode: read.exitCode,
      filesRead: (await read.stdout()).trim().split("\n").length,
    };
    console.log(JSON.stringify(result));
    return Response.json(result);
  } finally {
    await sandbox.stop();
  }
}
