/** A provider's verdict on one sender check of a mail it received. */
export type AuthVerdict = "pass" | "fail" | "none";

/** One mail as a provider received it, parsed. */
export type InboundMail = {
  /** The From header, `Name <address>` or a bare address. */
  from: string;
  /** The recipients, each `Name <address>` or a bare address. */
  to: string[];
  /** The Message-ID header, with or without its angle brackets. */
  messageId: string;
  subject: string;
  /** The plain-text body. */
  text: string;
  headers: Record<string, string>;
  /** The names of the attachments, which aren't kept. */
  attachments: string[];
  /**
   * The provider's sender checks. A DMARC `pass` is an aligned one: DMARC passes only when an SPF or
   * DKIM pass is for the From's domain.
   */
  authentication: { spf: AuthVerdict; dkim: AuthVerdict; dmarc: AuthVerdict };
};

/** One mail a provider sends. */
export type OutboundMail = {
  /** `Name <address>` or a bare address. */
  from: string;
  to: string;
  subject: string;
  text: string;
  html?: string;
  /** The Message-ID header, with its angle brackets. */
  messageId: string;
  inReplyTo?: string;
  references?: string[];
};

/**
 * The seam between the email Channel and a mail service (spec #761): it parses what the service
 * POSTs to the Host's inbound route, and sends a mail. The fake (`plugins/channel/fake`) is one.
 */
export type EmailProvider = {
  /** The mail an inbound request carries, or why the request was refused (answered 400). */
  parseInbound: (request: Request) => Promise<InboundMail | { rejected: string }>;
  send: (mail: OutboundMail) => Promise<void>;
};

/** The email Channel as the `channel` plugin takes it. */
export type EmailChannel = {
  id: "email";
  provider: EmailProvider;
  /** The domain the Bots' addresses are on, which the provider receives mail for. */
  domain: string;
};

/**
 * The email Channel (spec #761) over `provider`: each Bot gets an address on `domain`, and the
 * owner's mail to it wakes the Bot.
 */
export function emailChannel({
  provider,
  domain,
}: {
  provider: EmailProvider;
  domain: string;
}): EmailChannel {
  return { id: "email", provider, domain: domain.toLowerCase() };
}

/** The bare address of `Name <address>` or `address`, lowercase. */
export function bareAddress(header: string): string {
  const bracketed = /<([^<>]*)>\s*$/.exec(header);
  return (bracketed ? bracketed[1]! : header).trim().toLowerCase();
}
