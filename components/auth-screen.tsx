'use client';

import { useEffect, useState } from 'react';
import {
  ArrowLeft,
  CheckCircle2,
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  Lock,
  Mail,
  RefreshCw,
  ShieldCheck,
  User as UserIcon,
} from 'lucide-react';
import { AuthUser } from '@/lib/types';

type AuthStep = 'login' | 'register' | 'verify' | 'forgot' | 'reset';

interface AuthScreenProps {
  onAuthenticated: (payload: { token: string; user: AuthUser }) => void;
}

export function AuthScreen({ onAuthenticated }: AuthScreenProps) {
  const [step, setStep] = useState<AuthStep>('login');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [code, setCode] = useState('');
  const [showPassword, setShowPassword] = useState(false);

  const [submitting, setSubmitting] = useState(false);
  const [resending, setResending] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [devCodeHint, setDevCodeHint] = useState<string | null>(null);

  useEffect(() => {
    if (cooldown <= 0) return;
    const id = setInterval(() => setCooldown((c) => Math.max(0, c - 1)), 1000);
    return () => clearInterval(id);
  }, [cooldown]);

  const switchStep = (next: AuthStep) => {
    setStep(next);
    setError(null);
    setInfo(null);
    setDevCodeHint(null);
    setCode('');
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    setInfo(null);
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim(), password }),
      });
      const data = await res.json();
      if (!res.ok) {
        if (data?.needsVerification) {
          setStep('verify');
          setInfo(
            'Your account still needs email verification. Enter the 6-digit code from your inbox or click Resend Code.',
          );
          return;
        }
        throw new Error(data?.error || 'Sign in failed.');
      }
      onAuthenticated({ token: data.token, user: data.user });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to sign in.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    setInfo(null);
    setDevCodeHint(null);
    try {
      const res = await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          email: email.trim(),
          password,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data?.error || 'Could not create account.');
      }
      setStep('verify');
      setCooldown(45);
      setInfo(data.message || `Sent a 6-digit verification code to ${email.trim()}.`);
      if (data.devPreviewCode) {
        setDevCodeHint(String(data.devPreviewCode));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Registration failed.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleVerify = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch('/api/auth/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: email.trim(),
          code: code.trim(),
          password: password || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data?.error || 'Verification failed.');
      }
      if (data.token && data.user) {
        onAuthenticated({ token: data.token, user: data.user });
        return;
      }
      setStep('login');
      setDevCodeHint(null);
      setInfo('Email verified! Sign in with your password below.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Invalid verification code.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleResend = async () => {
    if (cooldown > 0 || resending) return;
    setResending(true);
    setError(null);
    try {
      const res = await fetch('/api/auth/resend', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Could not resend code.');
      setCooldown(45);
      setInfo(data.message || 'Sent a fresh 6-digit code to your email.');
      if (data.devPreviewCode) {
        setDevCodeHint(String(data.devPreviewCode));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not resend code.');
    } finally {
      setResending(false);
    }
  };

  const handleForgot = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    setDevCodeHint(null);
    try {
      const res = await fetch('/api/auth/forgot-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Request failed.');
      setStep('reset');
      setInfo(
        data.message ||
          'Check your email inbox for your 6-digit password reset code.',
      );
      if (data.devPreviewCode) {
        setDevCodeHint(String(data.devPreviewCode));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to send reset code.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleReset = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch('/api/auth/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: email.trim(),
          code: code.trim(),
          newPassword,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'Reset failed.');
      setPassword('');
      setNewPassword('');
      setCode('');
      setDevCodeHint(null);
      setStep('login');
      setInfo(data.message || 'Password updated! Sign in with your new password.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Reset failed.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="bg-control-grid flex min-h-screen flex-col justify-between px-4 py-8 sm:px-6">
      <div className="mx-auto flex w-full max-w-[1080px] items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-line-strong bg-obsidian-800 font-mono text-sm font-extrabold text-mint">
            ZF
          </div>
          <div>
            <div className="text-sm font-semibold text-[#f4f7fb]">
              ZaFar Control Room
            </div>
            <div className="text-xs text-[#8d98aa]">
              Verified Email Authentication
            </div>
          </div>
        </div>

        <span className="inline-flex items-center gap-1.5 rounded-full border border-line bg-obsidian-800/90 px-3 py-1.5 text-xs text-[#b5c2d6]">
          <ShieldCheck className="h-3.5 w-3.5 text-mint" />
          Protected Workspace
        </span>
      </div>

      <div className="mx-auto my-8 w-full max-w-[440px]">
        <div className="rounded-3xl border border-line-strong bg-obsidian-800/95 p-6 shadow-[0_24px_80px_rgba(0,0,0,0.55)] sm:p-8">
          {(step === 'login' || step === 'register') && (
            <div className="mb-6 grid grid-cols-2 rounded-xl border border-line bg-obsidian-900 p-1">
              <button
                type="button"
                onClick={() => switchStep('login')}
                className={`rounded-lg py-2 text-xs font-semibold transition ${
                  step === 'login'
                    ? 'bg-obsidian-700 text-[#f4f7fb] shadow-sm'
                    : 'text-[#8d98aa] hover:text-[#f4f7fb]'
                }`}
              >
                Sign in
              </button>
              <button
                type="button"
                onClick={() => switchStep('register')}
                className={`rounded-lg py-2 text-xs font-semibold transition ${
                  step === 'register'
                    ? 'bg-obsidian-700 text-[#f4f7fb] shadow-sm'
                    : 'text-[#8d98aa] hover:text-[#f4f7fb]'
                }`}
              >
                Create account
              </button>
            </div>
          )}

          {(step === 'verify' || step === 'forgot' || step === 'reset') && (
            <button
              type="button"
              onClick={() => switchStep('login')}
              className="mb-5 inline-flex items-center gap-1.5 text-xs font-medium text-[#8d98aa] transition hover:text-[#f4f7fb]"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              Back to sign in
            </button>
          )}

          <div className="mb-5">
            <h1 className="text-2xl font-bold tracking-tight text-[#f4f7fb]">
              {step === 'login' && 'Sign in with email'}
              {step === 'register' && 'Create your ZaFar account'}
              {step === 'verify' && 'Check your email inbox'}
              {step === 'forgot' && 'Reset your password'}
              {step === 'reset' && 'Enter your reset code'}
            </h1>
            <p className="mt-1 text-xs leading-relaxed text-[#8d98aa]">
              {step === 'login' &&
                'Use your verified ZaFar email account (synced across ZaFar Library & Control Room).'}
              {step === 'register' &&
                'We will send a 6-digit verification code to your email before activating access.'}
              {step === 'verify' &&
                `Enter the 6-digit verification code sent to ${email || 'your email'}.`}
              {step === 'forgot' &&
                'Enter your registered email address and we will send a 6-digit reset code.'}
              {step === 'reset' &&
                `Enter the 6-digit reset code sent to ${email} and choose a new password.`}
            </p>
          </div>

          {error && (
            <div className="mb-4 rounded-xl border border-coral/40 bg-coral-dim/55 px-3.5 py-2.5 text-xs font-medium text-[#ffc4c8]">
              {error}
            </div>
          )}

          {info && (
            <div className="mb-4 flex items-start gap-2 rounded-xl border border-mint/35 bg-mint-dim/50 px-3.5 py-2.5 text-xs text-mint">
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{info}</span>
            </div>
          )}

          {devCodeHint && (
            <div className="mb-4 rounded-xl border border-amber-400/40 bg-amber-500/10 p-3 text-xs text-amber-200">
              <div className="font-semibold">
                Local Sandbox Outbox (outbound port 587 blocked in preview container)
              </div>
              <div className="mt-1 text-[11px] text-amber-200/80">
                On Vercel production, this code goes strictly to your email inbox. Code generated:
              </div>
              <button
                type="button"
                onClick={() => setCode(devCodeHint)}
                className="mt-2 inline-flex items-center gap-2 rounded-lg border border-amber-300/30 bg-obsidian-950 px-3 py-1.5 font-mono text-sm font-bold tracking-[0.25em] text-mint"
              >
                {devCodeHint}
                <span className="font-sans text-[10px] tracking-normal text-[#9fb0c5]">
                  Click to fill
                </span>
              </button>
            </div>
          )}

          {step === 'login' && (
            <form onSubmit={handleLogin} className="space-y-4">
              <div>
                <label
                  htmlFor="login-email"
                  className="mb-1.5 block text-xs font-medium text-[#9fb0c5]"
                >
                  Email address
                </label>
                <div className="relative">
                  <Mail className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-[#697588]" />
                  <input
                    id="login-email"
                    type="email"
                    required
                    autoComplete="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="you@gmail.com"
                    className="w-full rounded-xl border border-line bg-obsidian-950 py-2.5 pl-10 pr-3.5 text-sm text-[#f4f7fb] placeholder:text-[#556072] focus:border-mint focus:outline-none"
                  />
                </div>
              </div>

              <div>
                <div className="mb-1.5 flex items-center justify-between">
                  <label
                    htmlFor="login-password"
                    className="text-xs font-medium text-[#9fb0c5]"
                  >
                    Password
                  </label>
                  <button
                    type="button"
                    onClick={() => switchStep('forgot')}
                    className="text-xs font-medium text-mint hover:underline"
                  >
                    Forgot password?
                  </button>
                </div>
                <div className="relative">
                  <Lock className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-[#697588]" />
                  <input
                    id="login-password"
                    type={showPassword ? 'text' : 'password'}
                    required
                    autoComplete="current-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="••••••••"
                    className="w-full rounded-xl border border-line bg-obsidian-950 py-2.5 pl-10 pr-10 text-sm text-[#f4f7fb] placeholder:text-[#556072] focus:border-mint focus:outline-none"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((s) => !s)}
                    aria-label={showPassword ? 'Hide password' : 'Show password'}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-[#7f8b9f] hover:text-[#f4f7fb]"
                  >
                    {showPassword ? (
                      <EyeOff className="h-4 w-4" />
                    ) : (
                      <Eye className="h-4 w-4" />
                    )}
                  </button>
                </div>
              </div>

              <button
                type="submit"
                disabled={submitting}
                className="flex w-full items-center justify-center gap-2 rounded-xl bg-mint py-2.5 text-sm font-bold text-[#071510] transition hover:brightness-110 disabled:opacity-60"
              >
                {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
                {submitting ? 'Signing in…' : 'Sign in'}
              </button>
            </form>
          )}

          {step === 'register' && (
            <form onSubmit={handleRegister} className="space-y-4">
              <div>
                <label
                  htmlFor="reg-name"
                  className="mb-1.5 block text-xs font-medium text-[#9fb0c5]"
                >
                  Full name
                </label>
                <div className="relative">
                  <UserIcon className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-[#697588]" />
                  <input
                    id="reg-name"
                    type="text"
                    required
                    maxLength={100}
                    autoComplete="name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Your name"
                    className="w-full rounded-xl border border-line bg-obsidian-950 py-2.5 pl-10 pr-3.5 text-sm text-[#f4f7fb] placeholder:text-[#556072] focus:border-mint focus:outline-none"
                  />
                </div>
              </div>

              <div>
                <label
                  htmlFor="reg-email"
                  className="mb-1.5 block text-xs font-medium text-[#9fb0c5]"
                >
                  Email address
                </label>
                <div className="relative">
                  <Mail className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-[#697588]" />
                  <input
                    id="reg-email"
                    type="email"
                    required
                    autoComplete="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="you@gmail.com"
                    className="w-full rounded-xl border border-line bg-obsidian-950 py-2.5 pl-10 pr-3.5 text-sm text-[#f4f7fb] placeholder:text-[#556072] focus:border-mint focus:outline-none"
                  />
                </div>
              </div>

              <div>
                <label
                  htmlFor="reg-password"
                  className="mb-1.5 block text-xs font-medium text-[#9fb0c5]"
                >
                  Password (minimum 6 characters)
                </label>
                <div className="relative">
                  <Lock className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-[#697588]" />
                  <input
                    id="reg-password"
                    type={showPassword ? 'text' : 'password'}
                    required
                    minLength={6}
                    autoComplete="new-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="Create a strong password"
                    className="w-full rounded-xl border border-line bg-obsidian-950 py-2.5 pl-10 pr-10 text-sm text-[#f4f7fb] placeholder:text-[#556072] focus:border-mint focus:outline-none"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((s) => !s)}
                    aria-label={showPassword ? 'Hide password' : 'Show password'}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-[#7f8b9f] hover:text-[#f4f7fb]"
                  >
                    {showPassword ? (
                      <EyeOff className="h-4 w-4" />
                    ) : (
                      <Eye className="h-4 w-4" />
                    )}
                  </button>
                </div>
              </div>

              <button
                type="submit"
                disabled={submitting}
                className="flex w-full items-center justify-center gap-2 rounded-xl bg-mint py-2.5 text-sm font-bold text-[#071510] transition hover:brightness-110 disabled:opacity-60"
              >
                {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
                {submitting ? 'Sending verification email…' : 'Send verification code'}
              </button>
            </form>
          )}

          {step === 'verify' && (
            <form onSubmit={handleVerify} className="space-y-4">
              <div>
                <label
                  htmlFor="verify-code"
                  className="mb-1.5 block text-xs font-medium text-[#9fb0c5]"
                >
                  6-digit verification code
                </label>
                <div className="relative">
                  <KeyRound className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-mint" />
                  <input
                    id="verify-code"
                    type="text"
                    inputMode="numeric"
                    pattern="\d{6}"
                    maxLength={6}
                    required
                    autoFocus
                    value={code}
                    onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                    placeholder="000000"
                    className="w-full rounded-xl border border-line bg-obsidian-950 py-3 pl-10 pr-4 font-mono text-xl font-bold tracking-[0.35em] text-[#f4f7fb] placeholder:text-[#444e5e] focus:border-mint focus:outline-none tabular-nums"
                  />
                </div>
              </div>

              <button
                type="submit"
                disabled={submitting || code.length !== 6}
                className="flex w-full items-center justify-center gap-2 rounded-xl bg-mint py-2.5 text-sm font-bold text-[#071510] transition hover:brightness-110 disabled:opacity-50"
              >
                {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
                {submitting ? 'Verifying…' : 'Verify email & continue'}
              </button>

              <div className="flex items-center justify-between pt-1 text-xs text-[#8d98aa]">
                <span>Didn&apos;t receive the email?</span>
                <button
                  type="button"
                  disabled={cooldown > 0 || resending}
                  onClick={handleResend}
                  className="inline-flex items-center gap-1 font-semibold text-mint hover:underline disabled:opacity-50"
                >
                  <RefreshCw className={`h-3 w-3 ${resending ? 'animate-spin' : ''}`} />
                  {cooldown > 0 ? `Resend in ${cooldown}s` : 'Resend code'}
                </button>
              </div>
            </form>
          )}

          {step === 'forgot' && (
            <form onSubmit={handleForgot} className="space-y-4">
              <div>
                <label
                  htmlFor="forgot-email"
                  className="mb-1.5 block text-xs font-medium text-[#9fb0c5]"
                >
                  Account email address
                </label>
                <div className="relative">
                  <Mail className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-[#697588]" />
                  <input
                    id="forgot-email"
                    type="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="you@gmail.com"
                    className="w-full rounded-xl border border-line bg-obsidian-950 py-2.5 pl-10 pr-3.5 text-sm text-[#f4f7fb] placeholder:text-[#556072] focus:border-mint focus:outline-none"
                  />
                </div>
              </div>

              <button
                type="submit"
                disabled={submitting}
                className="flex w-full items-center justify-center gap-2 rounded-xl bg-mint py-2.5 text-sm font-bold text-[#071510] transition hover:brightness-110 disabled:opacity-60"
              >
                {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
                {submitting ? 'Sending reset code…' : 'Send 6-digit reset code'}
              </button>
            </form>
          )}

          {step === 'reset' && (
            <form onSubmit={handleReset} className="space-y-4">
              <div>
                <label
                  htmlFor="reset-code"
                  className="mb-1.5 block text-xs font-medium text-[#9fb0c5]"
                >
                  6-digit reset code
                </label>
                <input
                  id="reset-code"
                  type="text"
                  inputMode="numeric"
                  pattern="\d{6}"
                  maxLength={6}
                  required
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  placeholder="000000"
                  className="w-full rounded-xl border border-line bg-obsidian-950 px-4 py-2.5 font-mono text-lg font-bold tracking-[0.3em] text-[#f4f7fb] placeholder:text-[#444e5e] focus:border-mint focus:outline-none tabular-nums"
                />
              </div>

              <div>
                <label
                  htmlFor="reset-new-pw"
                  className="mb-1.5 block text-xs font-medium text-[#9fb0c5]"
                >
                  New password
                </label>
                <input
                  id="reset-new-pw"
                  type={showPassword ? 'text' : 'password'}
                  required
                  minLength={6}
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  placeholder="At least 6 characters"
                  className="w-full rounded-xl border border-line bg-obsidian-950 px-3.5 py-2.5 text-sm text-[#f4f7fb] placeholder:text-[#556072] focus:border-mint focus:outline-none"
                />
              </div>

              <button
                type="submit"
                disabled={submitting || code.length !== 6}
                className="flex w-full items-center justify-center gap-2 rounded-xl bg-mint py-2.5 text-sm font-bold text-[#071510] transition hover:brightness-110 disabled:opacity-50"
              >
                {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
                {submitting ? 'Updating password…' : 'Update password'}
              </button>
            </form>
          )}
        </div>
      </div>

      <p className="text-center text-xs text-[#697588]">
        ZaFar Platform · Unified Email Auth &amp; Bot Operations
      </p>
    </div>
  );
}
