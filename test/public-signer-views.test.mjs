import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const root = new URL('../', import.meta.url);
const read = (path) => readFile(new URL(path, root), 'utf8');

const terminalViews = [
  '_submit_awaiting', '_submit_declined', '_submit_delegated',
  '_submit_expired', '_submit_archived', '_submit_success',
];

test('public error pages provide a bilingual accessible recovery path', async () => {
  for (const status of ['404', '422', '500']) {
    const html = await read(`brand/${status}.html`);
    assert.match(html, /<html lang="en">/);
    assert.match(html, /<title>.*Hamilton Exteriors/);
    assert.match(html, /<main[^>]*aria-labelledby/);
    assert.match(html, /<h1 id="error-heading">/);
    assert.match(html, /alt="Hamilton Exteriors"/);
    assert.match(html, /<p lang="es">/, `${status} must include Spanish recovery copy`);
    assert.match(html, /tel:\+16509773241/);
    assert.match(html, /wa\.me\/16509773241/);
    assert.match(html, /min-height:\s*44px/);
    assert.match(html, /:focus\s*\{[^}]*outline:/);
  }
});

test('static recovery pages reflow at 320px with usable actions', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    for (const status of ['404', '422', '500']) {
      const page = await browser.newPage({ viewport: { width: 320, height: 640 } });
      await page.setContent(await read(`brand/${status}.html`));
      assert.equal(await page.evaluate(() => document.body.scrollWidth <= window.innerWidth), true, `${status} overflowed`);
      const links = await page.locator('nav a').evaluateAll((nodes) => nodes.map((node) => {
        const rect = node.getBoundingClientRect();
        return [rect.width, rect.height];
      }));
      assert.equal(links.length, 2);
      assert.ok(links.every(([, height]) => height >= 44), `${status}: ${JSON.stringify(links)}`);
      await page.close();
    }
  } finally {
    await browser.close();
  }
});

test('public verification forms preserve upstream workflow and add code semantics', async () => {
  const submitOtp = await read('brand/_submit_email_2fa.html.erb');
  const startOtp = await read('brand/_start_email_verification.html.erb');

  for (const erb of [submitOtp, startOtp]) {
    assert.match(erb, /t\('hamilton\.verify_email'/);
    assert.match(erb, /Código de un solo uso/);
    assert.match(erb, /<main[^>]*aria-labelledby/);
    assert.match(erb, /start_form\/banner/);
    assert.match(erb, /f\.label :one_time_code/);
    assert.match(erb, /autocomplete: 'one-time-code'/);
    assert.match(erb, /inputmode: 'numeric'/);
    assert.match(erb, /describedby: 'code-status'/);
    assert.match(erb, /invalid: code_error/);
    assert.match(erb, /role="status" aria-live="polite"/);
    assert.match(erb, /id: 'resend_code_form'/);
    assert.match(erb, /min-height:44px/);
    assert.match(erb, /<toggle-submit/);
    assert.match(erb, /shared\/signer_recovery/);
  }

  assert.match(submitOtp, /params\[:t\]/);
  assert.match(submitOtp, /<fetch-form data-onload="true">/);
  assert.match(submitOtp, /api_submitter_email_clicks_path/);
});

test('shared-link start form preserves upstream behavior and reports errors', async () => {
  const erb = await read('brand/_start_show.html.erb');
  assert.match(erb, /<main[^>]*aria-labelledby="start-heading"/);
  assert.match(erb, /<h1 id="start-heading"/);
  assert.match(erb, /render 'banner'/);
  assert.match(erb, /render 'start_form\/policy'/);
  assert.match(erb, /render 'shared\/attribution'/);
  assert.match(erb, /<toggle-submit/);
  assert.match(erb, /placeholder: t\(/);
  assert.match(erb, /id="start-errors"/);
  assert.match(erb, /role="alert" aria-live="assertive"/);
});

test('terminal signer states use localized branded semantic shell', async () => {
  const shell = await read('brand/_terminal_state.html.erb');
  assert.match(shell, /<main[^>]*aria-labelledby/);
  assert.match(shell, /shared\/logo/);
  assert.match(shell, /<h1/);
  assert.match(shell, /shared\/attribution/);
  assert.match(shell, /local_assigns\[:link_path\]/);

  for (const view of terminalViews) {
    const erb = await read(`brand/${view}.html.erb`);
    assert.match(erb, /heading = t\('hamilton\./);
    assert.match(erb, /I18n\.locale\.to_s\.start_with\?\('es'\)/);
    assert.match(erb, /content_for\(:html_title, "#\{heading\}/);
    assert.match(erb, /shared\/terminal_state/);
    assert.match(erb, /link_path: '\/start'/);
  }
});

test('completed states retain upstream duplicate-submit and download behavior', async () => {
  const completed = await read('brand/_submit_completed.html.erb');
  const startCompleted = await read('brand/_start_completed.html.erb');

  for (const erb of [completed, startCompleted]) {
    assert.match(erb, /<main[^>]*aria-labelledby/);
    assert.match(erb, /<h1/);
    assert.match(erb, /<toggle-submit/);
    assert.match(erb, /disabled_with:/);
    assert.match(erb, /shared\/attribution/);
    assert.match(erb, /link_path: '\/start'/);
  }

  assert.match(completed, /data-target="download-button\.defaultButton"/);
  assert.match(completed, /data-target="download-button\.loadingButton"/);
  assert.match(completed, /t\('downloading'\)/);
});

test('anonymous root localizes language without disabling zoom', async () => {
  const layout = await read('brand/application.html.erb');
  const navbar = await read('brand/_public_root_navbar.html.erb');
  assert.match(layout, /public_root && %w\[en es\]\.include\?\(params\[:lang\]\)/);
  assert.match(layout, /lang="<%= page_lang %>"/);
  assert.match(layout, /if public_root.*initial-scale=1\.0.*else.*maximum-scale=1\.0, user-scalable=no/s);
  assert.match(navbar, /Inicio de Hamilton Exteriors/);
  assert.match(navbar, /Iniciar sesión/);
  assert.match(navbar, /min-height:44px/);
  assert.match(navbar, /root_path\(lang: params\[:lang\]\)/);
});

test('phone formatting preserves international values', async () => {
  const layout = await read('brand/form.html.erb');
  assert.match(layout, /value\.trim\(\)\.charAt\(0\) === '\+'/);
  assert.match(layout, /if \(d\.length > 10\) return value/);
  assert.doesNotMatch(layout, /d = d\.slice\(0, 10\)/);
});

test('decline dialog gives both decisions explicit full-size controls', async () => {
  const decline = await read('brand/_decline_form.html.erb');
  const css = await read('brand/hamilton.css');
  assert.match(decline, /class: 'base-button hx-decline-submit'/);
  assert.match(decline, /class="hx-decline-back"/);
  assert.match(css, /\.hx-decline-submit\s*\{[^}]*min-height:\s*44px\s*!important/s);
  assert.match(css, /\.hx-decline-back button\s*\{[^}]*height:\s*44px/s);
  const rules = css.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(rules, /dialog \.btn|\[role='dialog'\] \.btn/);
});

test('Hamilton attribution keeps recovery, counters, and customer copy clean', async () => {
  const footer = await read('brand/_powered_by.html.erb');
  assert.match(footer, /local_assigns\[:with_counter\]/);
  assert.match(footer, /CompletedSubmitter\.distinct\.count/);
  assert.match(footer, /ABR Quality Resources Inc dba Hamilton Exteriors/);
  assert.doesNotMatch(footer, /&mdash;|—/);
  assert.doesNotMatch(footer, /docuseal\.com/);
});

test('Hamilton signer labels exist in English and Spanish locale data', async () => {
  const locale = await read('brand/hamilton.yml');
  const dockerfile = await read('Dockerfile');
  assert.match(locale, /^en:/m);
  assert.match(locale, /^es:/m);
  for (const key of [
    'verify_email', 'one_time_code', 'document_completed', 'form_already_completed',
    'waiting_for_signers', 'document_declined', 'document_delegated',
    'signing_link_expired', 'form_unavailable', 'submitted_successfully',
    'document_submitted_successfully', 'readable_view', 'show_readable_view', 'show_page',
    'loading_readable_view', 'readable_view_shown', 'page_shown', 'readable_view_unavailable',
  ]) assert.match(locale, new RegExp(`\\s${key}:`));
  assert.match(dockerfile, /COPY brand\/hamilton\.yml\s+\/app\/config\/locales\/hamilton\.yml/);
});

test('Spanish templates use DocuSeal public locale routing', async () => {
  const layout = await read('brand/form.html.erb');
  for (const title of [
    'Contrato de Empleo',
    'Aviso de Salario - Código Laboral 2810.5',
    'Acuse de Recibo de Políticas',
    'Registro de Capacitación en Seguridad',
    'Plan de Prevención de Enfermedades por Calor',
  ]) assert.match(layout, new RegExp(title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.equal((layout.match(/<script\b/g) || []).length, (layout.match(/<\/script>/g) || []).length);
  assert.match(layout, /url\.searchParams\.set\('lang', 'es'\)/);
  assert.match(layout, /window\.location\.replace\(url\.toString\(\)\)/);

  const localeScript = layout.match(/data-hx-spanish-locale>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(localeScript);
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const requests = [];
    await page.route('https://sign.test/**', (route) => {
      const url = new URL(route.request().url());
      requests.push(url.pathname + url.search);
      const title = url.pathname.endsWith('/spanish')
        ? 'Plan de Prevención de Enfermedades por Calor'
        : 'Heat Illness Prevention Plan';
      return route.fulfill({ contentType: 'text/html', body: `<h1>${title}</h1><script>${localeScript}</script>` });
    });
    await page.goto('https://sign.test/s/spanish');
    await page.waitForURL('**/s/spanish?lang=es');
    assert.deepEqual(requests, ['/s/spanish', '/s/spanish?lang=es']);
    requests.length = 0;
    await page.goto('https://sign.test/s/english');
    await page.waitForTimeout(25);
    assert.deepEqual(requests, ['/s/english']);
  } finally {
    await browser.close();
  }
});

test('patched signer fields expose UUIDs for complete fail-closed validation', async () => {
  const patch = await read('patches/docuseal-inline-fields.mjs');
  assert.match(patch, /:data-uuid="field\.uuid"/);
  assert.match(patch, /expose field UUID for fail-closed parity checks/);
});

test('Docker wires only public signer and error overrides', async () => {
  const dockerfile = await read('Dockerfile');
  for (const target of [
    'views/errors/404.html', 'views/errors/422.html', 'views/errors/500.html',
    'views/submit_form/email_2fa.html.erb', 'views/start_form/email_verification.html.erb',
    'views/start_form/show.html.erb', 'views/submit_form/success.html.erb',
  ]) assert.match(dockerfile, new RegExp(target.replaceAll('.', '\\.')));
  assert.doesNotMatch(dockerfile, /views\/admin/);
  assert.doesNotMatch(dockerfile, /views\/start_form\/private/);
});
