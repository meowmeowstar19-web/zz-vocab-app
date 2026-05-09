// Edge Function: send-feedback-email
// Triggered by a Database Webhook on INSERT into public.feedback.
// Forwards the new row to meowmeowstar19@gmail.com via Resend.

const RESEND_API_URL = 'https://api.resend.com/emails';
const FROM = 'PlushieWord Feedback <feedback@plushieword.com>';
const TO = 'meowmeowstar19@gmail.com';

interface FeedbackRow {
  id?: string;
  user_id?: string;
  email?: string | null;
  message?: string;
  native_lang?: string | null;
  target_lang?: string | null;
  user_agent?: string | null;
  created_at?: string;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function buildEmail(row: FeedbackRow): { subject: string; html: string; text: string } {
  const message = row.message ?? '';
  const preview = message.slice(0, 60).replace(/\s+/g, ' ');
  const subject = `[PlushieWord] New feedback — ${preview}${message.length > 60 ? '…' : ''}`;

  const fields: Array<[string, string]> = [
    ['From', row.email || '(not provided)'],
    ['User ID', row.user_id || '(unknown)'],
    ['Native → Target', `${row.native_lang || '?'} → ${row.target_lang || '?'}`],
    ['Submitted', row.created_at || new Date().toISOString()],
    ['User Agent', row.user_agent || '(unknown)'],
  ];

  const html = `
    <div style="font-family:-apple-system,BlinkMacSystemFont,sans-serif;max-width:560px;margin:0 auto;padding:20px;color:#222;">
      <h2 style="margin:0 0 16px;font-size:18px;">New PlushieWord feedback</h2>
      <div style="background:#f6f6f4;border-radius:10px;padding:16px;white-space:pre-wrap;font-size:14px;line-height:1.55;">${escapeHtml(message)}</div>
      <table style="margin-top:16px;font-size:12px;color:#555;border-collapse:collapse;">
        ${fields
          .map(
            ([k, v]) =>
              `<tr><td style="padding:4px 12px 4px 0;color:#888;">${escapeHtml(k)}</td><td style="padding:4px 0;">${escapeHtml(v)}</td></tr>`,
          )
          .join('')}
      </table>
    </div>
  `.trim();

  const text =
    `New PlushieWord feedback\n\n${message}\n\n` +
    fields.map(([k, v]) => `${k}: ${v}`).join('\n');

  return { subject, html, text };
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'method_not_allowed' }), { status: 405 });
  }

  const expectedSecret = Deno.env.get('FEEDBACK_WEBHOOK_SECRET');
  if (expectedSecret) {
    const provided = req.headers.get('x-webhook-secret');
    if (provided !== expectedSecret) {
      return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
    }
  }

  const apiKey = Deno.env.get('RESEND_API_KEY');
  if (!apiKey) {
    console.error('RESEND_API_KEY not set');
    return new Response(JSON.stringify({ error: 'server_misconfigured' }), { status: 500 });
  }

  let row: FeedbackRow;
  try {
    const body = await req.json();
    row = body?.record ?? body;
  } catch {
    return new Response(JSON.stringify({ error: 'invalid_body' }), { status: 400 });
  }

  if (!row || typeof row.message !== 'string' || row.message.trim() === '') {
    return new Response(JSON.stringify({ error: 'missing_message' }), { status: 400 });
  }

  const { subject, html, text } = buildEmail(row);

  const res = await fetch(RESEND_API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: FROM,
      to: [TO],
      reply_to: row.email || undefined,
      subject,
      html,
      text,
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    console.error('Resend send failed:', res.status, errText);
    return new Response(JSON.stringify({ error: 'send_failed', status: res.status, detail: errText }), {
      status: 502,
    });
  }

  const data = await res.json();
  return new Response(JSON.stringify({ ok: true, id: data?.id }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
});
