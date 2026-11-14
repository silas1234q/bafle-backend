import { formatGhs } from "../lib/money.js";

/**
 * Notification types and their rendering.
 *
 * Deliberately NOT included: a "you did not win" email to every losing
 * entrant. A 100-ticket raffle would send 99 of them, which on a 300/day free
 * tier is one raffle per three days, and it is the kind of mail people mark as
 * spam — which damages deliverability for the messages that matter. Losing
 * entrants see the outcome on the raffle page, which publishes the full
 * verification data anyway.
 */

export const NOTIFICATION_TYPES = {
  /** Sent to every ticket holder when the pool sells out, before the draw. */
  RAFFLE_DRAW_SCHEDULED: "raffle.draw.scheduled",
  RAFFLE_WON: "raffle.won",
  RAFFLE_DRAWN_SELLER: "raffle.drawn.seller",
  RAFFLE_REFUNDED: "raffle.refunded",
  ORDER_AWAITING_SHIPMENT: "order.awaiting_shipment",
  PAYOUT_PAID: "payout.paid",
} as const;

export type NotificationType =
  (typeof NOTIFICATION_TYPES)[keyof typeof NOTIFICATION_TYPES];

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

/** Rendering inputs, captured when the notification is queued. */
export interface NotificationPayload {
  productTitle?: string;
  raffleId?: string;
  orderId?: string;
  amountMinor?: number;
  ticketNumber?: number;
  username?: string;
  appUrl?: string;
  /** Pre-formatted for the reader's benefit; captured at queue time. */
  drawAt?: string;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** One wrapper so every message looks the same and renders in plain clients. */
function layout(heading: string, paragraphs: string[], cta?: { label: string; url: string }) {
  const safeParagraphs = paragraphs.map((p) => `<p style="margin:0 0 14px">${p}</p>`);
  const button = cta
    ? `<p style="margin:22px 0 0"><a href="${escapeHtml(cta.url)}" style="background:#111;color:#fff;padding:11px 18px;border-radius:6px;text-decoration:none;display:inline-block">${escapeHtml(cta.label)}</a></p>`
    : "";

  return [
    `<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;font-size:15px;line-height:1.55;color:#111;max-width:520px">`,
    `<h1 style="font-size:19px;margin:0 0 16px">${escapeHtml(heading)}</h1>`,
    ...safeParagraphs,
    button,
    `<p style="margin:28px 0 0;font-size:12px;color:#666">Bafle</p>`,
    `</div>`,
  ].join("");
}

function plain(heading: string, lines: string[], cta?: { label: string; url: string }): string {
  const body = [heading, "", ...lines];
  if (cta) body.push("", `${cta.label}: ${cta.url}`);
  body.push("", "— Bafle");
  return body.join("\n");
}

type Renderer = (payload: NotificationPayload) => RenderedEmail;

const item = (payload: NotificationPayload) => payload.productTitle ?? "your item";
const link = (payload: NotificationPayload, path: string) =>
  `${payload.appUrl ?? ""}${path}`;

export const RENDERERS: Record<NotificationType, Renderer> = {
  [NOTIFICATION_TYPES.RAFFLE_DRAW_SCHEDULED]: (payload) => {
    const heading = `The draw for ${item(payload)} is about to run`;
    const cta = { label: "See the draw", url: link(payload, `/raffles/${payload.raffleId ?? ""}`) };
    const lines = [
      "Every ticket has been paid for, so the draw is going ahead.",
      payload.drawAt
        ? `It runs at ${payload.drawAt}. Nothing more is needed from you — this is just so it does not happen without warning.`
        : "It runs shortly. Nothing more is needed from you — this is just so it does not happen without warning.",
      payload.ticketNumber
        ? `You are in with ticket #${payload.ticketNumber}.`
        : "You are in.",
    ];
    return {
      subject: `Drawing soon: ${item(payload)}`,
      text: plain(heading, lines, cta),
      html: layout(heading, lines.map(escapeHtml), cta),
    };
  },

  [NOTIFICATION_TYPES.RAFFLE_WON]: (payload) => {
    const heading = `You won ${item(payload)}`;
    const cta = { label: "Add your delivery address", url: link(payload, `/orders/${payload.orderId ?? ""}`) };
    const lines = [
      payload.ticketNumber
        ? `Your ticket #${payload.ticketNumber} was drawn.`
        : "Your ticket was drawn.",
      "Add your delivery address so the seller can ship it. Nothing moves until you do.",
      "When the courier arrives, generate a delivery code and read it to them. The seller is only paid once that code is used, so do not share it before you have the item.",
    ];
    return {
      subject: `You won: ${item(payload)}`,
      text: plain(heading, lines, cta),
      html: layout(heading, lines.map(escapeHtml), cta),
    };
  },

  [NOTIFICATION_TYPES.RAFFLE_DRAWN_SELLER]: (payload) => {
    const heading = `Your raffle for ${item(payload)} sold out`;
    const cta = { label: "View the order", url: link(payload, `/orders/${payload.orderId ?? ""}`) };
    const lines = [
      "All tickets sold and a winner has been drawn.",
      "You will get another email the moment the winner provides a delivery address.",
    ];
    return {
      subject: `Sold out: ${item(payload)}`,
      text: plain(heading, lines, cta),
      html: layout(heading, lines.map(escapeHtml), cta),
    };
  },

  [NOTIFICATION_TYPES.RAFFLE_REFUNDED]: (payload) => {
    const heading = `Refunded: ${item(payload)}`;
    const amount = payload.amountMinor !== undefined ? formatGhs(payload.amountMinor) : "your tickets";
    const lines = [
      `That raffle closed without selling out, so ${amount} has been refunded in full.`,
      "Refunds settle back to the payment method you used, which can take a few days.",
    ];
    return {
      subject: `Refunded: ${item(payload)}`,
      text: plain(heading, lines),
      html: layout(heading, lines.map(escapeHtml)),
    };
  },

  [NOTIFICATION_TYPES.ORDER_AWAITING_SHIPMENT]: (payload) => {
    const heading = `Ship ${item(payload)}`;
    const cta = { label: "Mark it shipped", url: link(payload, `/orders/${payload.orderId ?? ""}`) };
    const lines = [
      "The winner has added their delivery address, so you can send the item now.",
      "Mark it shipped with the courier and tracking number. At handover, ask the winner for their delivery code and enter it — that releases your payment.",
    ];
    return {
      subject: `Action needed: ship ${item(payload)}`,
      text: plain(heading, lines, cta),
      html: layout(heading, lines.map(escapeHtml), cta),
    };
  },

  [NOTIFICATION_TYPES.PAYOUT_PAID]: (payload) => {
    const amount = payload.amountMinor !== undefined ? formatGhs(payload.amountMinor) : "Your payout";
    const heading = `${amount} is on its way`;
    const lines = [
      `Delivery of ${escapeHtml(item(payload))} was confirmed, so your payout has been sent.`,
      "Bank and mobile money transfers can take a short while to appear.",
    ];
    return {
      subject: `Payout sent: ${amount}`,
      text: plain(heading, [
        `Delivery of ${item(payload)} was confirmed, so your payout has been sent.`,
        "Bank and mobile money transfers can take a short while to appear.",
      ]),
      html: layout(heading, lines),
    };
  },
};

export function renderNotification(
  type: string,
  payload: NotificationPayload,
): RenderedEmail | null {
  const renderer = RENDERERS[type as NotificationType];
  return renderer ? renderer(payload) : null;
}
