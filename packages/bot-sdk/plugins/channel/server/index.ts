// The public channel export composes the Bot's channel plugin, which owns delivery and inbound mail.
export { channel } from "../../bot/server/channels";
export type { ChannelAdapter, ChannelApi, ChannelOptions, ChannelPlugin } from "./plugin";
export {
  emailChannel,
  type AuthVerdict,
  type EmailChannel,
  type EmailProvider,
  type InboundMail,
  type OutboundMail,
} from "./email";
