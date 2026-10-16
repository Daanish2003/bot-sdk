import { createMemoryCounters } from "../../../../core/server/chat/counters";
import { counterStoreContract } from "./counters.contract";

counterStoreContract("memory", () => createMemoryCounters());
