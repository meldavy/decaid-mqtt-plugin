import { parseCommand } from "./commands.js";

export function createCommandHandler(dispatcher, log) {
  return function handleCommandMessage(topic, payload) {
    const parsed = parseCommand(String(payload));
    if (!parsed) {
      log(`ignoring unknown MQTT command: ${payload}`);
      return;
    }
    dispatcher
      .dispatch(parsed)
      .then((result) => {
        if (result && result.ok) {
          log(`command ${parsed.kind} applied`);
        } else {
          log(`command ${parsed.kind} not applied: ${result?.reason ?? result?.status}`);
        }
      })
      .catch((e) => {
        log(`command ${parsed.kind} failed: ${e?.message ?? e}`);
      });
  };
}

export { parseCommand };
