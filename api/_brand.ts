// COPY of Timesheet-app/src/mail/brand.ts (the firm mail design). Edit THERE, then copy here.
// The proxy sends hiring mails server-side, so it needs its own copy.
// ---------------------------------------------------------------------------
// The look of every reminder mail — change the words, never the frame.
// ---------------------------------------------------------------------------
// Staff write only the message text (+ an optional button). Logo, header,
// colours and the address footer are fixed HERE, so every mail looks the same.
// To change the logo or address, edit this file (and public/abhl-logo.jpg).
// Gmail blocks data: images, so the logo is a hosted URL on the app's own site.
// Email clients ignore custom fonts and many CSS tricks: layout is tables,
// the "button" is a link in a rounded cell, colours are plain hex.
// ---------------------------------------------------------------------------

const LOGO_URL = 'https://abhl-timesheet.web.app/abhl-logo.jpg';
const NAVY = '#1f285f';
const TEAL = '#28a6a3'; // links in the message
const INK = '#2b3340';
const MUTED = '#6b7686';
const FONT = `-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif`;

const ADDRESS = 'D-0013, D-Wing, GR Floor, Plot No. 3, Akshar Business Park, Vashi, Navi Mumbai - 400 703, Maharashtra.';
const MOBILE = '8767395641 / 8767686268';
const EMAILS = ['harishladdhaca@gmail.com', 'arpit@abcca.in'];
const WEBSITE = 'www.abcca.in';
const LINKEDIN = 'https://www.linkedin.com/company/abhl-and-associates';

export interface MailButton { label: string; url: string }

const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Plain message text → paragraphs. A blank line starts a new paragraph, a
// single newline is a line break; URLs become links.
const paragraphs = (text: string) =>
  text.trim().split(/\n{2,}/).map((p) =>
    `<p style="margin:0 0 16px;">${esc(p).replace(/(https?:\/\/[^\s<]+)/g, `<a href="$1" style="color:${TEAL};">$1</a>`).replace(/\n/g, '<br>')}</p>`,
  ).join('');

// A rounded "button": a table cell with a link filling it (works in Gmail/Outlook).
// Exported so the compose toolbar can drop the same button into a message.
export const button = (b: MailButton | undefined, bg = NAVY) => !b?.label || !b.url ? '' : `
<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 6px;"><tr>
  <td style="background:${bg};border-radius:999px;"><a href="${esc(b.url)}" style="display:inline-block;padding:13px 30px;font:600 15px ${FONT};color:#ffffff;text-decoration:none;border-radius:999px;">${esc(b.label)}</a></td>
</tr></table>`;

const pill = (label: string, url: string) =>
  `<a href="${url}" style="display:inline-block;margin:0 4px 6px 0;padding:6px 14px;border:1px solid #cfd8e3;border-radius:999px;font:600 12px ${FONT};color:${NAVY};text-decoration:none;background:#ffffff;">${label}</a>`;

const mailLinks = EMAILS.map((e) => `<a href="mailto:${e}" style="color:inherit;text-decoration:none;">${e}</a>`).join(', ');

const CLIENT_NOTE = 'You are receiving this because you are a client of A B H L &amp; Associates.';
const footer = (bg: string, color: string, strong: string, note = CLIENT_NOTE) => `
<tr><td style="padding:0 20px 20px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
  <td style="background:${bg};border-radius:14px;padding:22px 24px;font:13px/1.7 ${FONT};color:${color};">
    <div style="font:700 13px ${FONT};color:${strong};letter-spacing:.3px;margin-bottom:6px;">A B H L &amp; Associates · Chartered Accountants</div>
    ${esc(ADDRESS)}<br>
    Mob.: ${MOBILE}<br>
    E-mail: ${mailLinks}<br>
    <div style="margin-top:12px;">${pill('Website', `https://${WEBSITE}`)}${pill('LinkedIn', LINKEDIN)}${pill('Email us', `mailto:${EMAILS[0]}`)}</div>
  </td></tr></table>
  <p style="margin:14px 4px 0;font:11px/1.6 ${FONT};color:#98a2b0;">${note} This message and any attachments may contain confidential information meant only for the addressee. If it reached you by mistake, please tell us and delete it.</p>
</td></tr>`;

const shell = (page: string, inner: string) => `<!doctype html><html><body style="margin:0;padding:0;background:${page};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${page};padding:28px 12px;"><tr><td align="center">
<table role="presentation" width="620" cellpadding="0" cellspacing="0" style="max-width:620px;width:100%;background:#ffffff;border-radius:22px;overflow:hidden;font-family:${FONT};">
${inner}
</table></td></tr></table></body></html>`;

const logo = (w: number, align = 'left') => `<img src="${LOGO_URL}" alt="A B H L &amp; Associates" width="${w}" style="display:block;width:${w}px;max-width:100%;height:auto;border:0;${align === 'center' ? 'margin:0 auto;' : ''}">`;

const body = (content: string, btn: MailButton | undefined, btnBg: string) => `
<tr><td style="padding:30px 36px 8px;font:16px/1.65 ${FONT};color:${INK};">
  ${content}${button(btn, btnBg)}
</td></tr><tr><td style="height:18px;"></td></tr>`;

// The subject is NOT repeated inside the mail — it is already the subject.
// `html` = an already-formatted message (the compose editor); otherwise the
// plain `text` becomes paragraphs. `note` replaces the "you are a client" line.
export function brandedHtml(text: string, o: { html?: string; button?: MailButton; note?: string } = {}): string {
  return shell('#f5f5f7', `
<tr><td style="padding:34px 36px 6px;">${logo(210, 'center')}</td></tr>
<tr><td style="padding:0 36px;"><div style="height:1px;background:#e8e8ed;margin-top:22px;"></div></td></tr>
${body(o.html ?? paragraphs(text), o.button, NAVY)}
${footer('#f5f5f7', MUTED, INK, o.note)}`);
}
