import express from 'express';
import { createServer as createViteServer } from 'vite';
import path from 'path';

const app = express();
const PORT = Number(process.env.PORT) || 3000;

app.use(express.json());

// In-memory automation store for extensions and headless bots
let currentGlobalEmail = '';
let currentGlobalProvider = 'guerrilla';
let currentGlobalOtp: {
  code: string;
  service: string;
  timestamp: string;
  context?: string;
} | null = null;

// Cache message details so we don't spam the upstream APIs repeatedly
const guerrillaBodyCache = new Map<string, { body: string; subject: string; from: string; timestamp: number }>();

const COMMON_WORDS = new Set([
  'hello', 'thank', 'thanks', 'please', 'regards', 'support', 'welcome',
  'account', 'security', 'device', 'service', 'expires', 'minute', 'minutes',
  'seconds', 'ignore', 'anyone', 'notice', 'center', 'privacy', 'team',
  'click', 'verify', 'verification', 'confirm', 'email', 'address', 'password',
  'guerrilla', 'temporary', 'disposable', 'friend', 'inbox'
]);

function isValidOtp(code: string): boolean {
  if (!code) return false;
  const clean = code.trim().toLowerCase();
  if (COMMON_WORDS.has(clean)) return false;
  const num = parseInt(code, 10);
  if (!isNaN(num) && num >= 2020 && num <= 2035 && code.length === 4) return false;
  if (!/\d/.test(code) && code.length < 5) return false;
  return code.length >= 4 && code.length <= 10;
}

// Backend OTP Extraction Engine
function extractOtpFromText(subject: string, text: string, html?: string): string | null {
  const cleanHtml = (html || '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ');

  const fullText = `${subject}\n\n${text}\n\n${cleanHtml}`;

  // 1. High-confidence contextual regexes
  const contextual = [
    /([A-Z0-9-]{4,10})\s+(?:is\s+your\s+(?:verification|security|confirmation|login|one-time|otp)\s+code)/i,
    /(?:verification|security|confirmation|validation|one-time|otp|login|auth|device|access)\s+(?:code|passcode|pin|password|token)(?:\s+is)?[\s:=-]+([A-Z0-9-]{4,10})/i,
    /(?:your|the)\s+(?:verification|security|login|otp|confirmation)?\s*(?:code|pin|otp)(?:\s+is)?[\s:=-]+([A-Z0-9-]{4,10})/i,
    /(?:use|enter)\s+([A-Z0-9-]{4,10})\s+(?:to\s+(?:verify|login|sign\s?in|confirm|authenticate))/i,
    /\b([A-Z]{1,4}-\d{4,8})\b/i,
    /\b(\d{3,4}-\d{3,4})\b/,
  ];

  for (const regex of contextual) {
    const match = fullText.match(regex);
    if (match && match[1]) {
      const code = match[1].trim().replace(/[.,;:!?)]$/, '');
      if (isValidOtp(code)) return code;
    }
  }

  // 2. HTML styled container
  if (html) {
    const htmlMatches = [
      /<(?:td|span|div|p|h[1-4]|b|strong)[^>]*class=["'][^"']*(?:code|otp|token|pin|digit)[^"']*["'][^>]*>\s*([A-Z0-9\s-]{4,10})\s*<\//i,
      /<(?:td|span|div|p|h[1-4]|b|strong)[^>]*style=["'][^"']*(?:font-size:\s*(?:2[0-9]|3[0-9]|4[0-9])px|letter-spacing)[^"']*["'][^>]*>\s*([A-Z0-9\s-]{4,10})\s*<\//i,
    ];
    for (const hm of htmlMatches) {
      const m = html.match(hm);
      if (m && m[1]) {
        const clean = m[1].replace(/\s+/g, '').trim().replace(/[.,;:!?)]$/, '');
        if (isValidOtp(clean)) return clean;
      }
    }
  }

  // 3. Subject line standalone 4-8 digits
  const subjMatch = subject.match(/\b(\d{4,8})\b/);
  if (subjMatch && isValidOtp(subjMatch[1])) return subjMatch[1];

  // 4. Standalone 6 digits in body
  const sixDigits = fullText.match(/\b(\d{6})\b/);
  if (sixDigits && isValidOtp(sixDigits[1])) return sixDigits[1];

  // 5. Standalone 4, 5, 7, 8 digits
  const anyDigits = fullText.match(/\b(\d{4,5}|\d{7,8})\b/);
  if (anyDigits && isValidOtp(anyDigits[1])) return anyDigits[1];

  return null;
}

// -------------------------------------------------------------
// PROVIDER 1: Guerrilla Mail (Universal, High-Delivery Rate)
// -------------------------------------------------------------
const GUERRILLA_BASE = 'https://api.guerrillamail.com/ajax.php';

async function createGuerrillaInbox(customUsername?: string, domainChoice?: string) {
  const initRes = await fetch(`${GUERRILLA_BASE}?f=get_email_address`, {
    headers: { 'User-Agent': 'Mozilla/5.0 AutoTempMail/1.0' },
  });
  if (!initRes.ok) throw new Error(`Guerrilla Mail initialization failed: ${initRes.status}`);
  const data = await initRes.json();
  const sid_token = data.sid_token;
  let email = data.email_addr;

  if (customUsername || domainChoice) {
    const site = domainChoice || 'guerrillamail.com';
    const cleanUser = (customUsername || email.split('@')[0])
      .toLowerCase()
      .replace(/[^a-z0-9_.-]/g, '')
      .slice(0, 16);

    try {
      const setRes = await fetch(`${GUERRILLA_BASE}?f=set_email_user`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'Mozilla/5.0 AutoTempMail/1.0',
        },
        body: `email_user=${encodeURIComponent(cleanUser)}&lang=en&site=${encodeURIComponent(site)}&sid_token=${encodeURIComponent(sid_token)}`,
      });
      if (setRes.ok) {
        const setData = await setRes.json();
        if (setData.email_addr) {
          email = setData.email_addr;
        }
      }
    } catch (e) {
      console.warn('Could not set custom username on Guerrilla Mail:', e);
    }
  }

  return {
    id: `gm_${Date.now()}`,
    address: email,
    provider: 'guerrilla',
    token: sid_token,
    createdAt: new Date().toISOString(),
  };
}

async function fetchGuerrillaMessages(sid_token: string) {
  // Use get_email_list with offset=0 to retrieve ALL messages persistently (never wipes out!)
  const listRes = await fetch(`${GUERRILLA_BASE}?f=get_email_list&offset=0&sid_token=${encodeURIComponent(sid_token)}`, {
    headers: { 'User-Agent': 'Mozilla/5.0 AutoTempMail/1.0' },
  });
  if (!listRes.ok) throw new Error(`Guerrilla get_email_list failed: ${listRes.status}`);
  const data = await listRes.json();
  const list = data.list || [];

  const processedMessages = await Promise.all(
    list.map(async (m: any) => {
      const mailId = String(m.mail_id);
      const cacheKey = `${sid_token}_${mailId}`;

      let fullBody = '';
      if (guerrillaBodyCache.has(cacheKey)) {
        fullBody = guerrillaBodyCache.get(cacheKey)!.body;
      } else {
        // Fetch full email body so we can extract OTP accurately from the complete message
        try {
          const detailRes = await fetch(
            `${GUERRILLA_BASE}?f=fetch_email&email_id=${encodeURIComponent(mailId)}&sid_token=${encodeURIComponent(sid_token)}`,
            { headers: { 'User-Agent': 'Mozilla/5.0 AutoTempMail/1.0' } }
          );
          if (detailRes.ok) {
            const detailData = await detailRes.json();
            fullBody = detailData.mail_body || '';
            guerrillaBodyCache.set(cacheKey, {
              body: fullBody,
              subject: detailData.mail_subject || m.mail_subject,
              from: detailData.mail_from || m.mail_from,
              timestamp: detailData.mail_timestamp || m.mail_timestamp,
            });
          }
        } catch (fetchErr) {
          console.warn(`Could not prefetch body for message ${mailId}:`, fetchErr);
        }
      }

      // Extract OTP from subject + excerpt + full HTML/text body
      const otp = extractOtpFromText(m.mail_subject || '', m.mail_excerpt || '', fullBody);

      return {
        id: mailId,
        accountId: sid_token,
        msgid: `<gm_${mailId}@guerrilla>`,
        from: {
          address: m.mail_from || 'unknown@sender.com',
          name: m.mail_from ? m.mail_from.split('@')[0] : 'Sender',
        },
        to: [{ address: currentGlobalEmail || 'user@guerrillamail.com', name: 'User' }],
        subject: m.mail_subject || '(No subject)',
        intro: m.mail_excerpt || fullBody.substring(0, 150),
        seen: m.mail_read === 1,
        isDeleted: false,
        hasAttachments: false,
        size: m.mail_size || fullBody.length || 1024,
        createdAt: m.mail_timestamp ? new Date(m.mail_timestamp * 1000).toISOString() : new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        detectedOtp: otp,
        text: fullBody ? fullBody.replace(/<[^>]+>/g, ' ') : m.mail_excerpt || '',
        html: fullBody ? [fullBody] : [],
      };
    })
  );

  return processedMessages;
}

async function fetchGuerrillaMessageDetail(sid_token: string, mailId: string) {
  const cacheKey = `${sid_token}_${mailId}`;
  let body = '';
  let subject = '';
  let from = '';
  let timestamp = 0;

  if (guerrillaBodyCache.has(cacheKey)) {
    const cached = guerrillaBodyCache.get(cacheKey)!;
    body = cached.body;
    subject = cached.subject;
    from = cached.from;
    timestamp = cached.timestamp;
  } else {
    const res = await fetch(`${GUERRILLA_BASE}?f=fetch_email&email_id=${encodeURIComponent(mailId)}&sid_token=${encodeURIComponent(sid_token)}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 AutoTempMail/1.0' },
    });
    if (!res.ok) throw new Error(`Guerrilla fetch_email failed: ${res.status}`);
    const data = await res.json();
    body = data.mail_body || '';
    subject = data.mail_subject || '';
    from = data.mail_from || '';
    timestamp = data.mail_timestamp || 0;

    guerrillaBodyCache.set(cacheKey, { body, subject, from, timestamp });
  }

  const otp = extractOtpFromText(subject, body.replace(/<[^>]+>/g, ' '), body);

  return {
    id: mailId,
    accountId: sid_token,
    msgid: `<gm_${mailId}@guerrilla>`,
    from: {
      address: from || 'unknown@sender.com',
      name: from ? from.split('@')[0] : 'Sender',
    },
    to: [{ address: currentGlobalEmail || 'user@guerrillamail.com', name: 'User' }],
    subject: subject || '(No subject)',
    intro: body.replace(/<[^>]+>/g, ' ').substring(0, 150),
    seen: true,
    isDeleted: false,
    hasAttachments: false,
    size: body.length,
    createdAt: timestamp ? new Date(timestamp * 1000).toISOString() : new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    detectedOtp: otp,
    text: body.replace(/<[^>]+>/g, ' '),
    html: [body],
    attachments: [],
  };
}

// -------------------------------------------------------------
// PROVIDER 2: TempMail.lol (Fresh Dynamic Domains)
// -------------------------------------------------------------
async function createTempMailLolInbox() {
  const res = await fetch('https://api.tempmail.lol/v2/inbox/create', {
    headers: { 'User-Agent': 'Mozilla/5.0 AutoTempMail/1.0' },
  });
  if (!res.ok) throw new Error(`tempmail.lol creation failed: ${res.status}`);
  const data = await res.json();
  return {
    id: `tl_${Date.now()}`,
    address: data.address,
    provider: 'tempmaillol',
    token: data.token,
    createdAt: new Date().toISOString(),
  };
}

async function fetchTempMailLolMessages(token: string) {
  const res = await fetch(`https://api.tempmail.lol/v2/inbox?token=${encodeURIComponent(token)}`, {
    headers: { 'User-Agent': 'Mozilla/5.0 AutoTempMail/1.0' },
  });
  if (!res.ok) return [];
  const data = await res.json();
  const emails = data.emails || [];

  return emails.map((m: any, idx: number) => {
    const body = m.body || m.html || '';
    const otp = extractOtpFromText(m.subject || '', body, m.html);
    return {
      id: `tl_msg_${idx}_${Date.now()}`,
      accountId: token,
      msgid: `<tl_${idx}@tempmail.lol>`,
      from: { address: m.from || 'unknown', name: (m.from || 'Sender').split('@')[0] },
      to: [{ address: m.to || currentGlobalEmail, name: 'User' }],
      subject: m.subject || '(No subject)',
      intro: (m.body || '').substring(0, 150),
      seen: false,
      isDeleted: false,
      hasAttachments: false,
      size: body.length,
      createdAt: m.date ? new Date(m.date).toISOString() : new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      detectedOtp: otp,
      text: m.body || '',
      html: m.html ? [m.html] : [m.body || ''],
      attachments: [],
    };
  });
}

// -------------------------------------------------------------
// PROVIDER 3: Mail.tm (Classic API)
// -------------------------------------------------------------
const MAIL_TM_BASE = 'https://api.mail.tm';

async function createMailTmInbox(customUsername?: string, domainChoice?: string) {
  const dRes = await fetch(`${MAIL_TM_BASE}/domains`);
  const dData = await dRes.json();
  const domains = (dData['hydra:member'] || []).filter((d: any) => d.isActive).map((d: any) => d.domain);
  const domain = domainChoice && domains.includes(domainChoice) ? domainChoice : (domains[0] || 'maxxspace.com');

  const randomSuffix = Math.random().toString(36).substring(2, 9);
  const cleanPrefix = (customUsername || 'tmp').toLowerCase().replace(/[^a-z0-9_.-]/g, '').slice(0, 16);
  const address = `${cleanPrefix}_${randomSuffix}@${domain}`;
  const password = `Tmp_${Math.random().toString(36).substring(2, 10)}!`;

  const accRes = await fetch(`${MAIL_TM_BASE}/accounts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address, password }),
  });
  if (!accRes.ok) throw new Error(`Mail.tm account creation failed: ${accRes.status}`);

  const tokRes = await fetch(`${MAIL_TM_BASE}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address, password }),
  });
  if (!tokRes.ok) throw new Error(`Mail.tm token failed: ${tokRes.status}`);
  const tokData = await tokRes.json();

  return {
    id: `mtm_${Date.now()}`,
    address,
    provider: 'mailtm',
    token: tokData.token,
    createdAt: new Date().toISOString(),
  };
}

async function fetchMailTmMessages(token: string) {
  const res = await fetch(`${MAIL_TM_BASE}/messages?page=1`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return [];
  const data = await res.json();
  const list = data['hydra:member'] || [];
  return list.map((m: any) => {
    const otp = extractOtpFromText(m.subject || '', m.intro || '');
    return {
      ...m,
      detectedOtp: otp,
    };
  });
}

// -------------------------------------------------------------
// UNIFIED API ENDPOINTS
// -------------------------------------------------------------

app.get('/api/inbox/providers', (req, res) => {
  res.json({
    providers: [
      {
        id: 'guerrilla',
        name: 'Guerrilla Mail (Recommended)',
        badge: 'Highest Real OTP Delivery',
        domains: ['guerrillamailblock.com', 'sharklasers.com', 'guerrillamail.com', 'grr.la', 'pokemail.net'],
        defaultDomain: 'guerrillamailblock.com',
      },
      {
        id: 'tempmaillol',
        name: 'TempMail.lol',
        badge: 'Fresh Dynamic Domains',
        domains: ['lucktaro.com', 'xzcoot.com'],
        defaultDomain: 'lucktaro.com',
      },
      {
        id: 'mailtm',
        name: 'Mail.tm',
        badge: 'Permanent Account Token',
        domains: ['maxxspace.com'],
        defaultDomain: 'maxxspace.com',
      },
    ],
  });
});

app.post('/api/inbox/create', async (req, res) => {
  const { provider = 'guerrilla', customUsername, domain } = req.body;
  try {
    let inboxData: any = null;

    if (provider === 'guerrilla') {
      inboxData = await createGuerrillaInbox(customUsername, domain);
    } else if (provider === 'tempmaillol') {
      inboxData = await createTempMailLolInbox();
    } else if (provider === 'mailtm') {
      inboxData = await createMailTmInbox(customUsername, domain);
    } else {
      inboxData = await createGuerrillaInbox(customUsername, domain);
    }

    currentGlobalEmail = inboxData.address;
    currentGlobalProvider = inboxData.provider;
    currentGlobalOtp = null;

    return res.json(inboxData);
  } catch (err: any) {
    console.error(`Error creating inbox for ${provider}:`, err);
    try {
      const fallback = await createGuerrillaInbox();
      currentGlobalEmail = fallback.address;
      currentGlobalProvider = fallback.provider;
      return res.json(fallback);
    } catch {
      return res.status(500).json({ error: 'Failed to provision inbox across providers.' });
    }
  }
});

app.get('/api/inbox/messages', async (req, res) => {
  const { provider = 'guerrilla', token } = req.query as { provider?: string; token?: string };
  if (!token) {
    return res.json([]);
  }

  try {
    let messages: any[] = [];
    if (provider === 'guerrilla') {
      messages = await fetchGuerrillaMessages(token);
    } else if (provider === 'tempmaillol') {
      messages = await fetchTempMailLolMessages(token);
    } else if (provider === 'mailtm') {
      messages = await fetchMailTmMessages(token);
    } else {
      messages = await fetchGuerrillaMessages(token);
    }

    // Inspect if any message has an OTP and register it globally
    for (const msg of messages) {
      if (msg.detectedOtp) {
        currentGlobalOtp = {
          code: msg.detectedOtp,
          service: msg.from?.name || 'Verification Service',
          timestamp: new Date().toISOString(),
          context: msg.subject,
        };
        break;
      }
    }

    return res.json(messages);
  } catch (err: any) {
    console.error(`Error fetching messages for ${provider}:`, err);
    return res.json([]);
  }
});

app.get('/api/inbox/message/:id', async (req, res) => {
  const { id } = req.params;
  const { provider = 'guerrilla', token } = req.query as { provider?: string; token?: string };
  if (!token) {
    return res.status(400).json({ error: 'Token is required' });
  }

  try {
    if (provider === 'guerrilla') {
      const detail = await fetchGuerrillaMessageDetail(token, id);
      return res.json(detail);
    } else if (provider === 'mailtm') {
      const resp = await fetch(`${MAIL_TM_BASE}/messages/${id}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await resp.json();
      const otp = extractOtpFromText(data.subject || '', data.text || data.intro || '', data.html?.[0]);
      return res.json({ ...data, detectedOtp: otp });
    } else {
      return res.status(404).json({ error: 'Detail not supported on this provider' });
    }
  } catch (err: any) {
    console.error(`Error fetching message detail for ${provider}:`, err);
    return res.status(500).json({ error: 'Failed to fetch message detail' });
  }
});

app.delete('/api/inbox/message/:id', async (req, res) => {
  const { id } = req.params;
  const { provider = 'guerrilla', token } = req.query as { provider?: string; token?: string };
  if (!token) return res.status(400).json({ error: 'Token required' });

  try {
    if (provider === 'guerrilla') {
      await fetch(`${GUERRILLA_BASE}?f=del_email`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `email_ids[]=${encodeURIComponent(id)}&sid_token=${encodeURIComponent(token)}`,
      });
      guerrillaBodyCache.delete(`${token}_${id}`);
      return res.status(204).end();
    } else if (provider === 'mailtm') {
      await fetch(`${MAIL_TM_BASE}/messages/${id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
      return res.status(204).end();
    }
    return res.status(204).end();
  } catch {
    return res.status(204).end();
  }
});

// Extension Automation Endpoints
app.get('/api/automation/active', (req, res) => {
  res.json({
    email: currentGlobalEmail,
    provider: currentGlobalProvider,
    latestOtp: currentGlobalOtp?.code || null,
    metadata: currentGlobalOtp,
  });
});

app.get('/api/automation/latest-otp', (req, res) => {
  const format = req.query.format;
  if (format === 'text') {
    return res.type('text/plain').send(currentGlobalOtp?.code || '');
  }
  return res.json({
    otp: currentGlobalOtp?.code || null,
    service: currentGlobalOtp?.service || null,
    timestamp: currentGlobalOtp?.timestamp || null,
  });
});

app.post('/api/automation/report-otp', (req, res) => {
  const { code, service, context } = req.body;
  if (code) {
    currentGlobalOtp = {
      code,
      service: service || 'Service',
      timestamp: new Date().toISOString(),
      context,
    };
  }
  res.json({ success: true, latestOtp: currentGlobalOtp });
});

async function main() {
  const isProd = process.env.NODE_ENV === 'production';

  if (!isProd) {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.resolve(__dirname, 'dist')));
    app.get('*', (req, res) => {
      res.sendFile(path.resolve(__dirname, 'dist', 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`AutoTempMail server running on http://0.0.0.0:${PORT}`);
  });
}

main().catch((err) => {
  console.error('Fatal server startup error:', err);
  process.exit(1);
});
