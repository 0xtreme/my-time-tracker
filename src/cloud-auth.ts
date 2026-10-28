// Shared sign-in for personal apps, plain DOM so it works with or without a framework.
// Copied into each app as src/cloud-auth.ts next to cloud-sync.ts; change this template first.
//
// Data access needs an MFA (aal2) session, so a password alone shows nothing. The first
// sign-in enrols an authenticator app; the factor belongs to the account, so one enrolment
// covers every personal app.
import { supabase } from './cloud-sync';

const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export async function hasCloudSession() {
  if (!supabase) return false;
  const { data } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
  return data?.currentLevel === 'aal2';
}

export async function signOut() { await supabase?.auth.signOut() }

// Renders the sign-in flow into `root` and resolves once the session is MFA-verified.
export function mountAuth(root: HTMLElement, appName: string): Promise<void> {
  const auth = supabase!.auth;
  return new Promise(resolve => {
    let factorId = '';
    const view = (body: string, error = '') => {
      root.innerHTML = `<section class="auth-panel">${body}${error ? `<p class="auth-error" role="alert">${esc(error)}</p>` : ''}</section>`;
    };
    const fail = (e: unknown) => e instanceof Error ? e.message : 'Something went wrong. Try again.';

    async function next(error = '') {
      const { data: { session } } = await auth.getSession();
      if (!session) return signInView(error);
      const { data: level } = await auth.mfa.getAuthenticatorAssuranceLevel();
      if (level?.currentLevel === 'aal2') { root.innerHTML = ''; resolve(); return }
      const { data: factors, error: listError } = await auth.mfa.listFactors();
      if (listError) return signInView(listError.message);
      const verified = factors.totp.find(f => f.status === 'verified');
      if (verified) { factorId = verified.id; return codeView('', '') }
      for (const f of factors.all.filter(f => f.status === 'unverified')) await auth.mfa.unenroll({ factorId: f.id });
      const { data, error: enrollError } = await auth.mfa.enroll({ factorType: 'totp', friendlyName: 'Personal Apps' });
      if (enrollError) return signInView(enrollError.message);
      factorId = data.id;
      codeView(data.totp.qr_code, data.totp.secret);
    }

    function signInView(error = '') {
      view(`<form data-auth="sign-in">
        <h2>Sign in to ${esc(appName)}</h2>
        <p class="auth-muted">Your records are stored in your private cloud database. Sign in with your Personal Apps account.</p>
        <label for="auth-email">Email</label><input id="auth-email" name="email" type="email" autocomplete="username" required>
        <label for="auth-password">Password</label><input id="auth-password" name="password" type="password" autocomplete="current-password" required>
        <button class="auth-primary" type="submit">Sign in</button>
      </form>`, error);
      root.querySelector('form')!.addEventListener('submit', async e => {
        e.preventDefault();
        const form = new FormData(e.target as HTMLFormElement);
        (root.querySelector('button') as HTMLButtonElement).disabled = true;
        const { error } = await auth.signInWithPassword({ email: String(form.get('email')), password: String(form.get('password')) });
        if (error) return signInView(error.message);
        next().catch(err => signInView(fail(err)));
      });
    }

    function codeView(qr: string, secret: string, error = '') {
      view(`<form data-auth="mfa">
        <h2>${qr ? 'Set up two-step verification' : 'Two-step verification'}</h2>
        ${qr ? `<p class="auth-muted">Scan this code with your authenticator app. It is used once for all your personal apps.</p>
          <img class="auth-qr" src="${esc(qr)}" alt="Authenticator QR code" width="180" height="180">
          <p class="auth-muted">Can't scan? Enter this key: <code>${esc(secret)}</code></p>` : ''}
        <label for="auth-code">6-digit code</label><input id="auth-code" name="code" inputmode="numeric" autocomplete="one-time-code" pattern="\\d{6}" required autofocus>
        <button class="auth-primary" type="submit">Verify</button>
      </form>`, error);
      root.querySelector('form')!.addEventListener('submit', async e => {
        e.preventDefault();
        const code = String(new FormData(e.target as HTMLFormElement).get('code')).trim();
        (root.querySelector('button') as HTMLButtonElement).disabled = true;
        const { error } = await auth.mfa.challengeAndVerify({ factorId, code });
        if (error) return codeView(qr, secret, error.message);
        root.innerHTML = '';
        resolve();
      });
    }

    view('<p class="auth-muted">Checking your session…</p>');
    next().catch(err => signInView(fail(err)));
  });
}

// Minimal styles; each app can override with its own tokens.
export const authStyles = `
.auth-panel{max-width:420px;margin:48px auto;padding:24px;border:1px solid color-mix(in srgb,currentColor 15%,transparent);border-radius:10px}
.auth-panel form{display:grid;gap:8px}
.auth-panel h2{margin:0 0 4px;font-size:1.15rem}
.auth-panel input{font:inherit;padding:8px 10px;border-radius:6px;border:1px solid color-mix(in srgb,currentColor 25%,transparent);background:transparent;color:inherit}
.auth-primary{font:inherit;margin-top:8px;padding:9px 14px;border-radius:6px;border:0;background:#2563eb;color:#fff;cursor:pointer}
.auth-primary:disabled{opacity:.6}
.auth-muted{opacity:.7;font-size:.9rem;margin:0}
.auth-error{color:#dc2626;margin:8px 0 0}
.auth-qr{background:#fff;padding:8px;border-radius:6px}
.auth-panel code{word-break:break-all}
`;
