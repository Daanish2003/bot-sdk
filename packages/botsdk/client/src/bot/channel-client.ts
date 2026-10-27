import type { FeatureClient } from "../chat-client";
import { type ChannelsContract, channelsContract } from "./contract";

export type { ChannelsContract };

export type ChannelsClient = FeatureClient<"channels", ChannelsContract>;

/**
 * The core's Channels client part: its contract, served under `channels` when the Host fills the
 * `channels` slot (with `@botsdk/channel-email` or its own provider). It adds no URLs.
 */
export function channelClient(): ChannelsClient {
  return { id: "channels", contract: channelsContract };
}
