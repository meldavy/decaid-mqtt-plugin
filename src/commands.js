const EXACT_COMMANDS = new Set(["wake", "sleep", "steam_on", "steam_off"]);

export function parseCommand(text) {
  if (typeof text !== "string") return null;
  const data = text.trim();
  if (data === "") return null;
  if (EXACT_COMMANDS.has(data)) {
    return { kind: data, argument: null };
  }
  const untrimmed = text;
  if (untrimmed.startsWith("profile_filename ")) {
    const argument = untrimmed.slice("profile_filename ".length);
    if (argument.trim() === "") return null;
    return { kind: "profile_filename", argument };
  }
  if (untrimmed.startsWith("profile ")) {
    const argument = untrimmed.slice("profile ".length);
    if (argument.trim() === "") return null;
    return { kind: "profile", argument };
  }
  return null;
}
