import { initBotId } from "botid/client/core";

// BotID client: attaches its challenge headers to the protected requests.
initBotId({
  protect: [{ path: "/api/botid", method: "POST" }],
});
