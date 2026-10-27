import { createMemoryCounters } from "../../src/chat/counters";
import { counterStoreContract } from "@ai-chat/test-support/counters.contract";

counterStoreContract("memory", () => createMemoryCounters());
