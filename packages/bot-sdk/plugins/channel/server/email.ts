/** What a `MailFile`'s `read` throws past its `maxBytes`: the file is left out, as expected. */
export class MailFileTooLargeError extends Error {
  constructor(maxBytes: number) {
    super(`The attachment is larger than ${maxBytes} bytes`);
    this.name = "MailFileTooLargeError";
  }
}

/** One file of an inbound email: its bytes are read only once the mail is the owner's. */
export type MailFile = {
  name: string;
  contentType: string;
  size: number;
  /**
   * The file's bytes. A provider whose `size` may be missing or wrong stops reading, and throws,
   * `MailFileTooLargeError` past `maxBytes`, so a huge attachment is never held in memory.
   */
  read: (maxBytes: number) => Promise<Uint8Array>;
};

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
  /** The names of the attachments. */
  attachments: string[];
  /**
   * The attachments' bytes, read lazily, so a mail that isn't the owner's is never downloaded. A
   * provider that can't fetch them leaves it out, and the attachments are only named.
   */
  files?: MailFile[];
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
  attachments?: { name: string; contentType: string; content: Uint8Array }[];
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
  /** The Host app's URL, without a trailing slash: an email's links open `<appUrl>/bots/<botId>`. */
  appUrl: string;
};

/**
 * The email Channel (spec #761) over `provider`: each Bot gets an address on `domain`, the owner's
 * mail to it wakes the Bot, and the Bot's replies are emailed back, linking to the Bot's page in
 * the Host app at `appUrl`.
 */
export function emailChannel({
  provider,
  domain,
  appUrl,
}: {
  provider: EmailProvider;
  domain: string;
  appUrl: string;
}): EmailChannel {
  return {
    id: "email",
    provider,
    domain: domain.toLowerCase(),
    appUrl: appUrl.replace(/\/+$/, ""),
  };
}

/** The bare address of `Name <address>` or `address`, lowercase. */
export function bareAddress(header: string): string {
  const bracketed = /<([^<>]*)>\s*$/.exec(header);
  return (bracketed ? bracketed[1]! : header).trim().toLowerCase();
}
