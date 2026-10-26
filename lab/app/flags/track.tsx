"use client";

import { track } from "@vercel/analytics";

// A custom event that names the flag; Web Analytics attaches its value from <FlagValues>.
export function TrackFlag() {
  return (
    <button onClick={() => track("Flag button clicked", {}, { flags: ["lab-flag"] })}>
      Send a Web Analytics event with the flag
    </button>
  );
}
