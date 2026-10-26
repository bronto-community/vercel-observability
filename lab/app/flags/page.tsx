import { FlagValues } from "flags/react";
import { labFlag } from "../../flags";
import { TrackFlag } from "./track";

export const dynamic = "force-dynamic";

export default async function FlagsPage() {
  // Evaluating the flag also calls reportValue(), which surfaces it in Runtime Logs.
  const enabled = await labFlag();
  return (
    <main>
      <h1>Flags</h1>
      <p>
        <code>lab-flag</code> is <strong>{enabled ? "on" : "off"}</strong>.
      </p>
      {/* Exposes the value to the page so Web Analytics events can carry it. */}
      <FlagValues values={{ [labFlag.key]: enabled }} />
      <TrackFlag />
    </main>
  );
}
