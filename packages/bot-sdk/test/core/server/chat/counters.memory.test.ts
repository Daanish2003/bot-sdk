import { createMemoryCounters } from "@botsdk/bot/chat/counters";
import { counterStoreContract } from "./counters.contract";

counterStoreContract("memory", () => createMemoryCounters());
