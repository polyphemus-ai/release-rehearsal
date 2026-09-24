import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import webpush from 'web-push';

export interface PushPayload {
  title: string;
  body: string;
  /** Where tapping the notification goes, e.g. "/#3c127d73". */
  url: string;
  /** Notifications with the same tag replace each other. */
  tag: string;
}

/** Sends Web Push messages. `gone` means the subscription no longer exists and should be dropped. */
export interface PushSender {
  publicKey: string;
  send(subscription: { endpoint: string }, payload: PushPayload): Promise<'ok' | 'gone' | 'failed'>;
}

/**
 * Web Push with this daemon's own VAPID keys (made once, kept in the polyphemus
 * home, readable only by you). Payloads are encrypted for the receiving browser,
 * so the push service in between can't read them.
 */
export function webPushSender(home: string, subject: () => string): PushSender {
  const file = join(home, 'vapid.json');
  let keys: { publicKey: string; privateKey: string };
  if (existsSync(file)) {
    keys = JSON.parse(readFileSync(file, 'utf8')) as typeof keys;
  } else {
    keys = webpush.generateVAPIDKeys();
    writeFileSync(file, `${JSON.stringify(keys)}\n`, { mode: 0o600 });
  }
  return {
    publicKey: keys.publicKey,
    async send(subscription, payload) {
      try {
        await webpush.sendNotification(subscription as webpush.PushSubscription, JSON.stringify(payload), {
          vapidDetails: { subject: subject(), publicKey: keys.publicKey, privateKey: keys.privateKey },
          TTL: 3600,
          urgency: 'high',
        });
        return 'ok';
      } catch (err) {
        const status = (err as { statusCode?: number }).statusCode;
        return status === 404 || status === 410 ? 'gone' : 'failed';
      }
    },
  };
}
