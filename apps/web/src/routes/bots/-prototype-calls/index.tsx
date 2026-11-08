// PROTOTYPE (#1366): three Call UI variants on /bots/$botId?variant=a|b|c, stub data only.
// Question: how a Call looks in the Conversation and in the SMS Channel account's settings. Never merge to main.
import { PrototypeSwitcher } from "@/components/prototype-switcher";

import { useStub } from "./stub";
import { VariantA } from "./variant-a";
import { VariantB } from "./variant-b";
import { VariantC } from "./variant-c";

const variants = [
  { key: "a", name: "Call block" },
  { key: "b", name: "Flat with markers" },
  { key: "c", name: "Call record + live dock" },
];

export function CallsPrototype({ variant }: { variant: string }) {
  const stub = useStub();
  return (
    <>
      {variant === "a" && <VariantA stub={stub} />}
      {variant === "b" && <VariantB stub={stub} />}
      {variant === "c" && <VariantC stub={stub} />}
      <PrototypeSwitcher
        variants={variants}
        current={variant}
        extra={
          <button
            type="button"
            className="ml-2 rounded-full bg-yellow-400 px-2 text-black"
            onClick={() => stub.setLive(!stub.live)}
          >
            {stub.live ? "Hang up" : "Back to live"}
          </button>
        }
      />
    </>
  );
}
