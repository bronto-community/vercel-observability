import { flag } from "flags/next";
import { vercelAdapter } from "@flags-sdk/vercel";

export const labFlag = flag<boolean>({
  key: "lab-flag",
  description: "Boolean flag for the observability lab",
  defaultValue: false,
  options: [
    { value: false, label: "Off" },
    { value: true, label: "On" },
  ],
  adapter: vercelAdapter,
});
