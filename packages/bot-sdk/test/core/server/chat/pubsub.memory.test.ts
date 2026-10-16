import { createMemoryPubSub } from "../../../../core/server/chat/pubsub";
import { pubsubContract } from "./pubsub.contract";

pubsubContract("memory", () => createMemoryPubSub());
