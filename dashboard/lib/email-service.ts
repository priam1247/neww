import nodemailer from 'nodemailer';

export interface EmailSendResult {
  delivered: boolean;
  devPreviewCode?: string;
}

export function isResendConfigured(): boolean {
  return Boolean(process.env.RESEND_API_KEY?.trim());
}

export function isDirectSmtpConfigured(): boolean {
  return Boolean(process.env.SMTP_USER?.trim() && process.env.SMTP_PASS?.trim());
}

export function isMailDeliveryConfigured(): boolean {
  return isResendConfigured() || isDirectSmtpConfigured();
}

async function sendViaResend(options: {
  to: string;
  subject: string;
  text: string;
  html: string;
}): Promise<EmailSendResult> {
  const apiKey = process.env.RESEND_API_KEY?.trim() || '';
  const from =
    process.env.EMAIL_FROM?.trim() ||
    (process.env.SMTP_USER?.trim()
      ? `ZaFar Portal <${process.env.SMTP_USER.trim()}>`
      : 'ZaFar Portal <onboarding@resend.dev>');

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from,
      to: [options.to],
      subject: options.subject,
      text: options.text,
      html: options.html,
    }),
    cache: 'no-store',
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    const errBody = await res.json().catch(() => null);
    throw new Error(
      errBody?.message || `Email API error (${res.status})`,
    );
  }
  return { delivered: true };
}

async function dispatchMail(options: {
  to: string;
  subject: string;
  text: string;
  html: string;
  code: string;
}): Promise<EmailSendResult> {
  if (isResendConfigured()) {
    return sendViaResend(options);
  }

  if (!isDirectSmtpConfigured()) {
    if (process.env.NODE_ENV !== 'production') {
      console.info(
        `[ZaFar Local Dev Outbox] Mail provider not configured — code for ${options.to}: ${options.code}`,
      );
      return { delivered: false, devPreviewCode: options.code };
    }
    throw new Error(
      'Email delivery is not configured yet. Set RESEND_API_KEY or SMTP_USER + SMTP_PASS in dashboard environment variables.',
    );
  }

  const host = process.env.SMTP_HOST?.trim() || 'smtp.gmail.com';
  const port = Number(process.env.SMTP_PORT || 587);
  const user = process.env.SMTP_USER?.trim() || '';
  const pass = process.env.SMTP_PASS?.trim() || '';

  const transporter = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    requireTLS: port !== 465,
    auth: { user, pass },
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 12_000,
  });

  try {
    await transporter.sendMail({
      from: process.env.EMAIL_FROM?.trim() || `"ZaFar Portal" <${user}>`,
      to: options.to,
      subject: options.subject,
      text: options.text,
      html: options.html,
    });
    return { delivered: true };
  } catch (err) {
    if (
      process.env.NODE_ENV !== 'production' &&
      !(err as { responseCode?: number })?.responseCode
    ) {
      console.info(
        `[ZaFar Local Dev Outbox] Outbound SMTP unreachable in dev container — code for ${options.to}: ${options.code}`,
      );
      return { delivered: false, devPreviewCode: options.code };
    }
    throw err;
  }
}

export async function sendVerificationEmail(
  email: string,
  name: string,
  code: string,
): Promise<EmailSendResult> {
  const greeting = name.trim() ? `Hi ${name.trim()},` : 'Hello,';
  const text = [
    greeting,
    '',
    `Your ZaFar verification code is: ${code}`,
    '',
    'This 6-digit code expires in 10 minutes.',
    'If you did not request this email, you can safely ignore it.',
  ].join('\n');

  const html = `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:480px;margin:0 auto;padding:28px;background:#ffffff;color:#0f172a;border-radius:16px;border:1px solid #e2e8f0;">
      <div style="font-size:11px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:#0d9488;">ZaFar Portal</div>
      <h2 style="margin:10px 0 8px;font-size:20px;color:#0f172a;">Verify your email address</h2>
      <p style="margin:0 0 20px;font-size:14px;line-height:1.6;color:#475569;">${greeting} enter the 6-digit code below to activate your ZaFar account:</p>
      <div style="padding:18px;text-align:center;background:#f8fafc;border:1px solid #cbd5e1;border-radius:12px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:30px;font-weight:800;letter-spacing:0.28em;color:#0f766e;">
        ${code}
      </div>
      <p style="margin:20px 0 0;font-size:12px;line-height:1.5;color:#64748b;">This code expires in 10 minutes. If you didn't request this verification email, you can safely ignore it.</p>
    </div>
  `;

  return dispatchMail({
    to: email,
    subject: `${code} is your ZaFar verification code`,
    text,
    html,
    code,
  });
}

export async function sendPasswordResetEmail(
  email: string,
  code: string,
): Promise<EmailSendResult> {
  const text = [
    'Hello,',
    '',
    `Your ZaFar password reset code is: ${code}`,
    '',
    'This code expires in 10 minutes.',
    'If you did not request a password reset, you can safely ignore this email — your password will stay unchanged.',
  ].join('\n');

  const html = `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:480px;margin:0 auto;padding:28px;background:#ffffff;color:#0f172a;border-radius:16px;border:1px solid #e2e8f0;">
      <div style="font-size:11px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:#0d9488;">ZaFar Security</div>
      <h2 style="margin:10px 0 8px;font-size:20px;color:#0f172a;">Reset your password</h2>
      <p style="margin:0 0 20px;font-size:14px;line-height:1.6;color:#475569;">Use the 6-digit code below to set a new password for your ZaFar account:</p>
      <div style="padding:18px;text-align:center;background:#f8fafc;border:1px solid #cbd5e1;border-radius:12px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:30px;font-weight:800;letter-spacing:0.28em;color:#0f766e;">
        ${code}
      </div>
      <p style="margin:20px 0 0;font-size:12px;line-height:1.5;color:#64748b;">This code expires in 10 minutes. If you didn't request this reset, your password will remain unchanged.</p>
    </div>
  `;

  return dispatchMail({
    to: email,
    subject: `${code} is your ZaFar password reset code`,
    text,
    html,
    code,
  });
}
