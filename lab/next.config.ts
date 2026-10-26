import type { NextConfig } from "next";
import { withBotId } from "botid/next/config";

const nextConfig: NextConfig = {};

// withBotId adds the rewrites the BotID client script needs.
export default withBotId(nextConfig);
