import { chat } from "@/lib/chat";

/** Node runtime only (the Bot SDK needs Node's crypto and pg): the reaper, and the SIGTERM drain. */
export async function startChat() {
  await chat.start();
  // Local Runs get up to 250 s to finish (the SDK refuses new ones meanwhile), then the process
  // exits. Node would exit on SIGTERM by itself, so this listener is what keeps the drain.
  process.once("SIGTERM", () => {
    void chat.stop().finally(() => process.exit(0));
  });
}
