// PROTOTYPE (#760): three variants of Channels (rich controls, email markers, address placement),
// on /bots/$botId?variant=a|b|c. Stub data in memory; nothing is wired to a server.
// Switcher buttons: email arrives, Bot pings, react (user), Bot reacts, rotate, reset.
// Lives on branch prototype/760-channels-ui only.
import { PrototypeSwitcher } from "@/components/prototype-switcher";

import { useChannelsStub } from "./stub";
import { VariantA, name as nameA } from "./variant-a";
import { VariantB, name as nameB } from "./variant-b";
import { VariantC, name as nameC } from "./variant-c";

const variants = [
  { key: "a", name: nameA },
  { key: "b", name: nameB },
  { key: "c", name: nameC },
];

export function ChannelsPrototype({ variant }: { variant: string }) {
  const stub = useChannelsStub();
  const v = variant.toLowerCase();
  const button = "ml-1 rounded bg-white/15 px-2 text-xs";
  const lastBot = [...stub.messages].reverse().find((m) => m.from === "bot");
  return (
    <>
      {v === "b" ? (
        <VariantB stub={stub} />
      ) : v === "c" ? (
        <VariantC stub={stub} />
      ) : (
        <VariantA stub={stub} />
      )}
      <PrototypeSwitcher
        variants={variants}
        current={v}
        extra={
          <>
            <button type="button" className={button} onClick={stub.emailArrives}>
              email arrives
            </button>
            <button type="button" className={button} onClick={stub.botPings}>
              bot pings
            </button>
            <button
              type="button"
              className={button}
              onClick={() => lastBot && stub.reactUser(lastBot.id)}
            >
              ❤️ last bot msg
            </button>
            <button type="button" className={button} onClick={stub.botReacts}>
              bot reacts
            </button>
            <button type="button" className={button} onClick={stub.rotate}>
              rotate
            </button>
            <button type="button" className={button} onClick={stub.reset}>
              reset
            </button>
            <span className="ml-2 font-mono text-[10px] text-white/70">
              last wrote: {stub.lastWrote} · rot {stub.rotations}
            </span>
          </>
        }
      />
    </>
  );
}
