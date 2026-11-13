import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { type HookApi, registerRouter } from "./plugin.ts";

export default definePluginEntry({
  id: "a3-router", // Must match the id in openclaw.plugin.json exactly.
  name: "Model Router",
  description: "Routes prompts to a local or cloud model.",
  register(api: HookApi) {
    registerRouter(api);
  },
});