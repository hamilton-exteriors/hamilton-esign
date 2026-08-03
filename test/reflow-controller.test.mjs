import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { chromium } from 'playwright';

const layout = readFileSync(new URL('../brand/form.html.erb', import.meta.url), 'utf8');
const hamiltonCss = readFileSync(new URL('../brand/hamilton.css', import.meta.url), 'utf8');
const controllerTemplate = (layout.match(/<script nonce="<%= content_security_policy_nonce %>">([\s\S]*?)<\/script>/) || [])[1];
if (!controllerTemplate) throw new Error('mobile controller script not found in form layout');

const englishLabels = {
  readable_view: 'Readable view',
  show_readable_view: 'Show readable view',
  show_page: 'Show the page',
  loading_readable_view: 'Loading readable view.',
  readable_view_shown: 'Readable view shown.',
  page_shown: 'Document page shown.',
  readable_view_unavailable: 'Readable view is unavailable. Use the document page.',
};

function controllerFor(labels = englishLabels) {
  const completeLabels = { ...englishLabels, ...labels };
  return controllerTemplate.replace(
    /<%= json_escape\([\s\S]*?\.html_safe %>/,
    JSON.stringify(completeLabels),
  );
}

function documentHtml(reflowUuid = 'u1', labels = englishLabels) {
  return `<!doctype html><html lang="en"><head><style>
    ${hamiltonCss}
    page-container{display:block;width:100%;height:520px}
    .tray-shell{position:fixed;z-index:20;right:0;bottom:0;left:0;height:0}
    .form-container{position:absolute;right:0;bottom:0;left:0;min-height:96px;background:#fff}
    #hx-read-doc [data-hx-uuid]{position:relative;display:inline-block;width:130px;min-height:44px}
    #hx-read-doc [data-hx-uuid]>.field-area{position:absolute;inset:0;width:100%;height:100%}
  </style></head><body>
    <div class="flex mt-4"><span class="hx-brand"><span class="hx-brand-mark">Hamilton</span></span></div>
    <header id="signing_form_header" class="flex items-center" style="margin-bottom:-16px">
      <h1 style="width:100%;overflow:hidden;white-space:nowrap">Fixture Document</h1>
      <div class="flex items-center gap-2 group" style="margin-left:20px;flex-shrink:0">
        <modal-button><button id="decline_button" type="button" aria-label="Decline">Decline</button></modal-button>
        <span id="complete_button_container" class="peer contents"></span>
        <download-button role="button" tabindex="0" aria-label="Download">Download</download-button>
      </div>
    </header>
    <main>
      <div class="tray-shell"><div class="form-container"><nav aria-label="Form progress"><div class="flex items-center flex-wrap steps-progress"><button type="button" aria-label="Step 1"><span class="steps-progress-current"></span></button><button type="button" aria-label="Step 2"><span></span></button><button type="button" aria-label="Step 3"><span></span></button></div></nav></div></div>
      <page-container id="page-attachment-0"><div class="field-area" data-uuid="${reflowUuid}" tabindex="0">Field</div></page-container>
    </main>
    <script>
      window.addEventListener('hx-reflow-ready', function () {
        var fields = document.querySelectorAll('.field-area');
        for (var i = 0; i < fields.length; i++) {
          var field = fields[i];
          var anchor = document.querySelector('[data-hx-uuid="' + field.dataset.uuid + '"]');
          var visible = anchor && anchor.offsetParent !== null;
          if (visible) anchor.appendChild(field);
          else if (window.__dropMissingUuid === field.dataset.uuid) field.remove();
          else document.querySelector('page-container').appendChild(field);
        }
      });
    </script>
    <script>${controllerFor(labels)}</script>
  </body></html>`;
}

async function fixture(fragment, {
  signing = true,
  asyncFields = false,
  fieldOnLaterPage = false,
  viewport = { width: 390, height: 844 },
  labels = englishLabels,
  reducedMotion = false,
  reflowFailure = false,
  reflowDelay = 0,
  secondField = false,
  dropMissingFields = false,
} = {}) {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport, reducedMotion: reducedMotion ? 'reduce' : 'no-preference' });
  const requests = [];
  await page.addInitScript(() => {
    window.__unexpectedCls = 0;
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (!entry.hadRecentInput) window.__unexpectedCls += entry.value;
      }
    }).observe({ type: 'layout-shift', buffered: true });
  });
  await page.route('https://sign.test/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    requests.push(path);
    if (path === '/s/test') {
      const field = `<div class="field-area" data-uuid="u1" tabindex="0">Field</div>`;
      let html = signing ? documentHtml('u1', labels) : documentHtml('u1', labels).replace(field, '<p>Completed</p>');
      if (fieldOnLaterPage) {
        html = html.replace(
          `<page-container id="page-attachment-0">${field}</page-container>`,
          `<page-container id="page-attachment-0"><p>Page without fields</p></page-container><page-container id="page-attachment-1">${field}</page-container>`,
        );
      }
      if (secondField) {
        html = html.replace('</page-container>', '<div class="field-area" data-uuid="u2" tabindex="0">Second field</div></page-container>');
      }
      if (dropMissingFields) {
        html = html.replace('<script>\n      window.addEventListener', '<script>window.__dropMissingUuid = "u2";</script><script>\n      window.addEventListener');
      }
      if (asyncFields) {
        html = html
          .replace(field, '<p>Loading signer…</p>')
          .replace('</body>', '<script>setTimeout(function(){ document.querySelector("page-container").innerHTML = "<div class=\\"field-area\\" data-uuid=\\"u1\\" tabindex=\\"0\\">Field</div>"; }, 25)</script></body>');
      }
      return route.fulfill({ contentType: 'text/html', body: html });
    }
    if (path === '/reflow/index.json') {
      if (reflowDelay) await new Promise((resolve) => setTimeout(resolve, reflowDelay));
      return route.fulfill(reflowFailure
        ? { status: 500, contentType: 'application/json', body: '{}' }
        : { contentType: 'application/json', body: '{"Fixture Document":"fixture"}' });
    }
    if (path === '/reflow/fixture.reflow.html') return route.fulfill({ contentType: 'text/html', body: fragment });
    return route.fulfill({ status: 404 });
  });
  await page.goto('https://sign.test/s/test');
  return { browser, page, requests };
}

async function activateReadableView(page) {
  await page.locator('#hx-read-toggle').click();
  await page.waitForSelector('#hx-read-doc .field-area');
  await page.waitForFunction(() => getComputedStyle(document.querySelector('page-container')).display === 'none');
}

test('PDF remains first until readable view is explicitly activated, then viewport changes restore it', async () => {
  const { browser, page, requests } = await fixture('<span class="ds" data-hx-uuid="u1"></span>');
  try {
    await page.waitForSelector('#hx-read-toggle');
    assert.equal(await page.locator('#hx-read-toggle').getAttribute('aria-controls'), 'hx-read-doc');
    assert.equal(await page.locator('#hx-read-toggle').getAttribute('aria-expanded'), 'false');
    assert.notEqual(await page.locator('page-container').evaluate((node) => getComputedStyle(node).display), 'none');
    assert.deepEqual(requests.filter((path) => path.startsWith('/reflow/')), []);

    await activateReadableView(page);
    await page.waitForFunction((text) => document.querySelector('#hx-read-status')?.textContent === text, englishLabels.readable_view_shown);
    assert.equal(await page.locator('#hx-read-toggle').getAttribute('aria-expanded'), 'true');
    assert.equal(await page.locator('html').evaluate((node) => node.classList.contains('hx-readable-active')), true);
    assert.equal(await page.locator('#hx-read-doc .field-area').evaluate((field) => {
      const label = document.createElement('span');
      label.className = 'field-area-active-label';
      field.appendChild(label);
      return getComputedStyle(label).display;
    }), 'none');
    assert.deepEqual(requests.filter((path) => path.startsWith('/reflow/')), ['/reflow/index.json', '/reflow/fixture.reflow.html']);

    await page.locator('#hx-read-toggle').click();
    await page.waitForSelector('page-container .field-area');
    await page.waitForFunction((text) => document.querySelector('#hx-read-status')?.textContent === text, englishLabels.page_shown);
    assert.equal(await page.locator('#hx-read-toggle').getAttribute('aria-expanded'), 'false');
    assert.equal(await page.locator('html').evaluate((node) => node.classList.contains('hx-readable-active')), false);
    assert.notEqual(await page.locator('page-container').evaluate((node) => getComputedStyle(node).display), 'none');

    await activateReadableView(page);
    await page.setViewportSize({ width: 768, height: 390 });
    await page.waitForSelector('page-container .field-area');
    assert.equal(await page.locator('html').evaluate((node) => node.classList.contains('hx-readable-active')), false);
    assert.notEqual(await page.locator('page-container').evaluate((node) => getComputedStyle(node).display), 'none');

    await page.setViewportSize({ width: 767, height: 844 });
    await page.waitForSelector('page-container .field-area');
    assert.notEqual(await page.locator('page-container').evaluate((node) => getComputedStyle(node).display), 'none');
  } finally {
    await browser.close();
  }
});

test('non-signing pages never mount a readable-view control or fetch reflow assets', async () => {
  const { browser, page, requests } = await fixture('<span class="ds" data-hx-uuid="u1"></span>', { signing: false });
  try {
    await page.waitForTimeout(50);
    assert.equal(await page.locator('#hx-read').count(), 0);
    assert.deepEqual(requests.filter((path) => path.startsWith('/reflow/')), []);
  } finally {
    await browser.close();
  }
});

test('deferred signing fields mount one readable-view control without fetching', async () => {
  const { browser, page, requests } = await fixture('<span class="ds" data-hx-uuid="u1"></span>', { asyncFields: true });
  try {
    await page.waitForSelector('#hx-read-toggle');
    assert.equal(await page.locator('#hx-read').count(), 1);
    assert.deepEqual(requests.filter((path) => path.startsWith('/reflow/')), []);
  } finally {
    await browser.close();
  }
});

test('a document whose first page has no fields still mounts and activates readable view', async () => {
  const { browser, page, requests } = await fixture('<span class="ds" data-hx-uuid="u1"></span>', { fieldOnLaterPage: true });
  try {
    await page.waitForSelector('#hx-read-toggle');
    assert.deepEqual(requests.filter((path) => path.startsWith('/reflow/')), []);
    await activateReadableView(page);
    assert.equal(await page.locator('#hx-read-doc .field-area').count(), 1);
    assert.equal(await page.locator('page-container .field-area').count(), 0);
  } finally {
    await browser.close();
  }
});

test('desktop-first sessions mount the mobile control at 767px', async () => {
  const { browser, page, requests } = await fixture('<span class="ds" data-hx-uuid="u1"></span>', { viewport: { width: 768, height: 844 } });
  try {
    assert.equal(await page.locator('#hx-read').count(), 0);
    await page.setViewportSize({ width: 767, height: 844 });
    await page.waitForSelector('#hx-read-toggle');
    assert.equal(await page.locator('#hx-read').count(), 1);
    assert.deepEqual(requests.filter((path) => path.startsWith('/reflow/')), []);
  } finally {
    await browser.close();
  }
});

test('1280px desktop sessions stay PDF-only and fetch no reflow assets', async () => {
  const { browser, page, requests } = await fixture('<span class="ds" data-hx-uuid="u1"></span>', { viewport: { width: 1280, height: 800 } });
  try {
    await page.waitForTimeout(50);
    assert.equal(await page.locator('#hx-read').count(), 0);
    assert.notEqual(await page.locator('page-container').evaluate((node) => getComputedStyle(node).display), 'none');
    assert.deepEqual(requests.filter((path) => path.startsWith('/reflow/')), []);
  } finally {
    await browser.close();
  }
});

test('a stale UUID keeps the PDF visible, announces fallback, and restores focus', async () => {
  const { browser, page } = await fixture('<span class="ds" data-hx-uuid="different"></span>');
  try {
    await page.locator('#hx-read-toggle').click();
    await page.waitForSelector('page-container .field-area');
    await page.waitForFunction((text) => document.querySelector('#hx-read-status')?.textContent === text, englishLabels.readable_view_unavailable);
    assert.notEqual(await page.locator('page-container').evaluate((node) => getComputedStyle(node).display), 'none');
    assert.equal(await page.locator('#hx-read-toggle').isHidden(), true);
    assert.equal(await page.locator('#hx-read-toggle').getAttribute('aria-expanded'), 'false');
    assert.equal(await page.evaluate(() => document.activeElement?.matches('page-container .field-area')), true);
  } finally {
    await browser.close();
  }
});

test('a vanished partial Teleport cannot hide the complete PDF', async () => {
  const { browser, page } = await fixture('<span class="ds" data-hx-uuid="u1"></span>', {
    secondField: true,
    dropMissingFields: true,
  });
  try {
    await page.locator('#hx-read-toggle').click();
    await page.waitForFunction((text) => document.querySelector('#hx-read-status')?.textContent === text, englishLabels.readable_view_unavailable);
    assert.notEqual(await page.locator('page-container').evaluate((node) => getComputedStyle(node).display), 'none');
    assert.equal(await page.locator('#hx-read-doc .field-area').count(), 0);
    assert.equal(await page.locator('page-container .field-area[data-uuid="u1"]').count(), 1);
  } finally {
    await browser.close();
  }
});

test('loading state is exposed while the PDF remains available', async () => {
  const { browser, page } = await fixture('<span class="ds" data-hx-uuid="u1"></span>', { reflowDelay: 150 });
  try {
    await page.locator('#hx-read-toggle').click();
    await page.waitForFunction((text) => document.querySelector('#hx-read-status')?.textContent === text, englishLabels.loading_readable_view);
    assert.equal(await page.locator('#hx-read-toggle').getAttribute('aria-busy'), 'true');
    assert.equal(await page.locator('#hx-read').getAttribute('aria-busy'), 'true');
    assert.notEqual(await page.locator('page-container').evaluate((node) => getComputedStyle(node).display), 'none');
    await page.waitForFunction((text) => document.querySelector('#hx-read-status')?.textContent === text, englishLabels.readable_view_shown);
    assert.equal(await page.locator('#hx-read-toggle').getAttribute('aria-busy'), null);
  } finally {
    await browser.close();
  }
});

test('a reflow request failure leaves the PDF focused and reports the unavailable view', async () => {
  const { browser, page } = await fixture('<span class="ds" data-hx-uuid="u1"></span>', { reflowFailure: true });
  try {
    await page.locator('#hx-read-toggle').click();
    await page.waitForFunction((text) => document.querySelector('#hx-read-status')?.textContent === text, englishLabels.readable_view_unavailable);
    assert.notEqual(await page.locator('page-container').evaluate((node) => getComputedStyle(node).display), 'none');
    assert.equal(await page.locator('#hx-read-toggle').isHidden(), true);
    assert.equal(await page.evaluate(() => document.activeElement?.matches('page-container .field-area')), true);
  } finally {
    await browser.close();
  }
});

test('three fresh mobile loads have no unexpected post-load layout shift', async () => {
  const samples = [];
  for (let i = 0; i < 3; i += 1) {
    const { browser, page } = await fixture('<span class="ds" data-hx-uuid="u1"></span>');
    try {
      await page.waitForSelector('#hx-read-toggle');
      await page.waitForTimeout(100);
      samples.push(await page.evaluate(() => window.__unexpectedCls));
    } finally {
      await browser.close();
    }
  }
  assert.ok(samples.every((value) => value <= 0.1), `unexpected CLS samples: ${samples.join(', ')}`);
});

test('progress semantics follow the pinned current-step marker', async () => {
  const { browser, page } = await fixture('<span class="ds" data-hx-uuid="u1"></span>');
  try {
    await page.waitForSelector('#hx-read-toggle');
    const buttons = page.locator('.steps-progress button');
    assert.equal(await buttons.nth(0).getAttribute('aria-current'), 'step');
    assert.equal(await buttons.nth(1).getAttribute('aria-current'), null);
    await page.locator('.steps-progress').evaluate((rail) => {
      rail.querySelector('.steps-progress-current').classList.remove('steps-progress-current');
      rail.querySelectorAll('button')[1].firstElementChild.classList.add('steps-progress-current');
    });
    await page.waitForFunction(() => document.querySelectorAll('.steps-progress button')[1]?.getAttribute('aria-current') === 'step');
    assert.equal(await buttons.nth(0).getAttribute('aria-current'), null);
  } finally {
    await browser.close();
  }
});

test('Spanish controls and progress targets retain full mobile sizing', async () => {
  const labels = {
    readable_view: 'Vista legible',
    show_readable_view: 'Mostrar vista legible',
    show_page: 'Mostrar la página',
  };
  const { browser, page } = await fixture('<span class="ds" data-hx-uuid="u1"></span>', { labels, viewport: { width: 320, height: 640 } });
  try {
    await page.waitForSelector('#hx-read-toggle');
    assert.equal(await page.locator('#hx-read-toggle').textContent(), labels.show_readable_view);
    const sizes = await page.locator('.steps-progress button').evaluateAll((buttons) => buttons.map((button) => {
      const rect = button.getBoundingClientRect();
      return [rect.width, rect.height];
    }));
    assert.ok(sizes.every(([width, height]) => width >= 44 && height >= 44), JSON.stringify(sizes));
    await page.locator('.form-container').evaluate((container) => {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;justify-content:space-between;align-items:flex-end;width:100%';
      const fieldLabel = document.createElement('span');
      fieldLabel.textContent = 'Fecha efectiva';
      const button = document.createElement('button');
      button.className = 'set-current-date-button';
      button.textContent = 'Establecer hoy';
      row.append(fieldLabel, button);
      container.appendChild(row);
    });
    const dateButton = await page.locator('.set-current-date-button').boundingBox();
    assert.ok(dateButton && dateButton.height >= 44, JSON.stringify(dateButton));
    await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
    const scaledDate = await page.locator('.set-current-date-button').boundingBox();
    assert.ok(scaledDate && scaledDate.x + scaledDate.width <= 320, JSON.stringify(scaledDate));
    assert.equal(await page.evaluate(() => { window.scrollTo({ left: 9999 }); const x = window.scrollX; window.scrollTo({ left: 0 }); return x; }), 0);
    assert.equal(await page.evaluate(() => document.body.scrollWidth <= window.innerWidth), true);
  } finally {
    await browser.close();
  }
});

test('keyboard activation works and reduced motion suppresses transitions', async () => {
  const { browser, page } = await fixture('<span class="ds" data-hx-uuid="u1"></span>', { reducedMotion: true });
  try {
    await page.waitForSelector('#hx-read-toggle');
    let focused = '';
    for (let i = 0; i < 10 && focused !== 'hx-read-toggle'; i += 1) {
      await page.keyboard.press('Tab');
      focused = await page.evaluate(() => document.activeElement?.id || '');
    }
    assert.equal(focused, 'hx-read-toggle');
    await page.keyboard.press('Enter');
    await page.waitForSelector('#hx-read-doc .field-area');
    await page.waitForFunction((text) => document.querySelector('#hx-read-toggle')?.textContent === text, englishLabels.show_page);
    assert.equal(await page.locator('#hx-read-toggle').textContent(), englishLabels.show_page);
    const duration = await page.locator('#hx-read-toggle').evaluate((button) => getComputedStyle(button).transitionDuration);
    assert.ok(duration === '0s' || duration === '1e-05s' || duration === '0.00001s', duration);
  } finally {
    await browser.close();
  }
});

test('200% text scaling keeps the two-column signer header and readable bar visible', async () => {
  const { browser, page } = await fixture('<span class="ds" data-hx-uuid="u1"></span>', { viewport: { width: 320, height: 640 } });
  try {
    await page.waitForSelector('#hx-read-toggle');
    await page.locator('#signing_form_header h1').evaluate((node) => { node.textContent = 'Injury and Illness Prevention Program'; });
    await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
    const metrics = await page.evaluate(() => {
      const rect = (selector) => {
        const box = document.querySelector(selector).getBoundingClientRect();
        return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: box.width, height: box.height };
      };
      return {
        overflow: document.body.scrollWidth > innerWidth,
        header: rect('#signing_form_header'),
        identity: rect('.hx-signer-identity'),
        actions: rect('.hx-signer-actions'),
        decline: rect('#decline_button'),
        download: rect('.hx-signer-actions download-button'),
        bar: rect('.hx-read-bar'),
        readLabel: rect('.hx-read-bar > span:first-child'),
        toggle: rect('#hx-read-toggle'),
      };
    });
    assert.equal(metrics.overflow, false, JSON.stringify(metrics));
    assert.ok(metrics.header.right <= 320 && metrics.identity.right <= metrics.actions.left + 0.5, JSON.stringify(metrics));
    assert.ok(Math.abs(metrics.decline.top - metrics.download.top) <= 8, JSON.stringify(metrics));
    assert.ok(metrics.decline.width >= 44 && metrics.decline.height >= 44, JSON.stringify(metrics));
    assert.ok(metrics.download.width >= 44 && metrics.download.height >= 44, JSON.stringify(metrics));
    assert.ok(metrics.toggle.width >= 44 && metrics.toggle.height >= 44 && metrics.toggle.right <= metrics.bar.right, JSON.stringify(metrics));
    assert.ok(metrics.readLabel.right <= metrics.toggle.left + 0.5, JSON.stringify(metrics));
  } finally {
    await browser.close();
  }
});

test('Spanish signer actions stay split right of the identity without widening the page', async () => {
  const labels = {
    readable_view: 'Vista legible',
    show_readable_view: 'Mostrar vista legible',
    show_page: 'Mostrar la página',
  };
  const { browser, page } = await fixture('<span class="ds" data-hx-uuid="u1"></span>', { labels, viewport: { width: 390, height: 844 } });
  try {
    await page.waitForSelector('#hx-read-toggle');
    await page.locator('#signing_form_header h1').evaluate((node) => { node.textContent = 'Plan de Prevención de Enfermedades por Calor'; });
    await page.locator('#decline_button').evaluate((node) => { node.textContent = 'Rechazar'; node.setAttribute('aria-label', 'Rechazar'); });
    await page.locator('.hx-signer-actions download-button').evaluate((node) => { node.textContent = 'Descargar'; node.setAttribute('aria-label', 'Descargar'); });
    await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
    const metrics = await page.evaluate(() => {
      const identity = document.querySelector('.hx-signer-identity').getBoundingClientRect();
      const actions = document.querySelector('.hx-signer-actions').getBoundingClientRect();
      const controls = [...document.querySelectorAll('.hx-signer-actions button, .hx-signer-actions download-button')]
        .map((node) => { const r = node.getBoundingClientRect(); return { top: r.top, width: r.width, height: r.height, right: r.right }; });
      return { overflow: document.body.scrollWidth > innerWidth, identityRight: identity.right, actionsLeft: actions.left, actionsRight: actions.right, controls };
    });
    assert.equal(metrics.overflow, false, JSON.stringify(metrics));
    assert.ok(metrics.identityRight <= metrics.actionsLeft + 0.5 && metrics.actionsRight <= 390, JSON.stringify(metrics));
    assert.ok(metrics.controls.every((control) => control.width >= 44 && control.height >= 44 && control.right <= 390), JSON.stringify(metrics));
    assert.ok(metrics.controls.every((control) => Math.abs(control.top - metrics.controls[0].top) <= 8), JSON.stringify(metrics));
  } finally {
    await browser.close();
  }
});

test('readable legal title remains larger than section headings', async () => {
  const fragment = `<style>
    #hx-read-doc h1{font-size:1.375rem;line-height:1.25;font-weight:700}
    #hx-read-doc h2{font-size:1.125rem;line-height:1.3;font-weight:700}
  </style><h1>Injury and Illness Prevention Program</h1><h2>Responsibility</h2><span data-hx-uuid="u1"></span>`;
  const { browser, page } = await fixture(fragment, { viewport: { width: 390, height: 844 } });
  try {
    await activateReadableView(page);
    const sizes = await page.evaluate(() => ({
      title: parseFloat(getComputedStyle(document.querySelector('#hx-read-doc h1')).fontSize),
      section: parseFloat(getComputedStyle(document.querySelector('#hx-read-doc h2')).fontSize),
    }));
    assert.ok(sizes.title > sizes.section, JSON.stringify(sizes));
  } finally {
    await browser.close();
  }
});

test('readable anchors reserve the full field target without covering adjacent text at 200%', async () => {
  const fragment = `<style>
    #hx-read-doc{font-size:1rem;padding:1.25rem 1.125rem calc(2rem + var(--hx-form-clearance,0px))}
    #hx-read-doc p{font-size:1rem;line-height:1.55}
    #hx-read-doc .ds{position:relative;display:inline-block;box-sizing:content-box;min-width:min(7.5rem,100%);max-width:100%;height:2.75rem;min-height:2.75rem;vertical-align:middle;border-bottom:.09375rem solid #777}
  </style><p><span class="ds" data-hx-uuid="u1"></span><span id="adjacent">Adjacent legal text</span></p>`;
  const { browser, page } = await fixture(fragment, { viewport: { width: 320, height: 640 } });
  try {
    await activateReadableView(page);
    const initialSize = await page.locator('#hx-read-doc p').evaluate((node) => parseFloat(getComputedStyle(node).fontSize));
    await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
    const metrics = await page.evaluate(() => {
      const anchor = document.querySelector('#hx-read-doc .ds').getBoundingClientRect();
      const field = document.querySelector('#hx-read-doc .field-area').getBoundingClientRect();
      const adjacent = document.querySelector('#adjacent').getBoundingClientRect();
      return {
        anchor: { left: anchor.left, right: anchor.right, top: anchor.top, bottom: anchor.bottom },
        field: { left: field.left, right: field.right, top: field.top, bottom: field.bottom },
        adjacent: { left: adjacent.left, right: adjacent.right, top: adjacent.top, bottom: adjacent.bottom },
        fontSize: parseFloat(getComputedStyle(document.querySelector('#hx-read-doc p')).fontSize),
        overflow: document.body.scrollWidth > window.innerWidth,
      };
    });
    assert.ok(metrics.field.right <= metrics.anchor.right && metrics.field.bottom <= metrics.anchor.bottom, JSON.stringify(metrics));
    assert.ok(metrics.field.right <= metrics.adjacent.left || metrics.field.bottom <= metrics.adjacent.top || metrics.field.top >= metrics.adjacent.bottom, JSON.stringify(metrics));
    assert.ok(metrics.field.right - metrics.field.left >= 44 && metrics.field.bottom - metrics.field.top >= 44, JSON.stringify(metrics));
    assert.ok(metrics.fontSize >= initialSize * 1.9, JSON.stringify(metrics));
    assert.equal(metrics.overflow, false);
  } finally {
    await browser.close();
  }
});

test('the last readable field scrolls above the fixed signer tray', async () => {
  const fragment = `<style>
    #hx-read-doc{padding:1rem 1rem calc(2rem + var(--hx-form-clearance,0px) + env(safe-area-inset-bottom))}
    #hx-read-doc .spacer{height:50rem}
    #hx-read-doc .ds{position:relative;display:inline-block;min-width:7.5rem;height:2.75rem;min-height:2.75rem}
  </style><div class="spacer"></div><span class="ds" data-hx-uuid="u1"></span>`;
  const { browser, page } = await fixture(fragment, { viewport: { width: 320, height: 640 } });
  try {
    await activateReadableView(page);
    await page.waitForFunction(() => parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--hx-form-clearance')) >= 96);
    await page.locator('.form-container').evaluate((tray) => { tray.style.minHeight = '140px'; });
    await page.waitForFunction(() => parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--hx-form-clearance')) >= 140);
    const field = page.locator('#hx-read-doc .field-area');
    await field.evaluate((node) => node.scrollIntoView({ block: 'end' }));
    const positions = await page.evaluate(() => ({
      fieldBottom: document.querySelector('#hx-read-doc .field-area').getBoundingClientRect().bottom,
      trayTop: document.querySelector('.form-container').getBoundingClientRect().top,
    }));
    assert.ok(positions.fieldBottom <= positions.trayTop - 20, JSON.stringify(positions));
  } finally {
    await browser.close();
  }
});

test('readable fields scroll below the sticky signer header', async () => {
  const fragment = `<style>
    #hx-read-doc .spacer{height:50rem}
    #hx-read-doc .ds{position:relative;display:inline-block;min-width:7.5rem;height:2.75rem;min-height:2.75rem}
  </style><div class="spacer"></div><span class="ds" data-hx-uuid="u1"></span><div class="spacer"></div>`;
  const { browser, page } = await fixture(fragment, { viewport: { width: 390, height: 844 } });
  try {
    await page.locator('#signing_form_header').evaluate((header) => {
      header.style.position = 'sticky';
      header.style.top = '0';
      header.style.zIndex = '50';
    });
    await page.setViewportSize({ width: 800, height: 844 });
    await page.setViewportSize({ width: 390, height: 844 });
    await activateReadableView(page);
    await page.waitForFunction(() => parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--hx-header-clearance')) > 0);
    const field = page.locator('#hx-read-doc .field-area');
    await field.click();
    const positions = await page.evaluate(() => ({
      fieldTop: document.querySelector('#hx-read-doc .field-area').getBoundingClientRect().top,
      headerBottom: document.querySelector('#signing_form_header').getBoundingClientRect().bottom,
      clearance: parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--hx-header-clearance')),
    }));
    assert.ok(positions.fieldTop >= positions.headerBottom + 20, JSON.stringify(positions));
  } finally {
    await browser.close();
  }
});

test('wide reflow tables scroll locally while fields remain visible and focusable', async () => {
  const fragment = `<style>
    #hx-read-doc .tbl{width:100%;min-width:0;max-width:100%;overflow-x:auto;contain:inline-size;-webkit-overflow-scrolling:touch}
    #hx-read-doc table{width:max-content;min-width:100%;border-collapse:collapse}
    #hx-read-doc td{white-space:nowrap;padding:8px}
  </style><div class="tbl"><table><tr><td><span data-hx-uuid="u1"></span></td><td>Extremely wide table content that must stay inside its local horizontal scroller</td></tr></table></div>`;
  const { browser, page } = await fixture(fragment, { viewport: { width: 320, height: 640 } });
  try {
    await activateReadableView(page);
    const metrics = await page.locator('.tbl').evaluate((table) => ({ client: table.clientWidth, scroll: table.scrollWidth }));
    assert.ok(metrics.scroll > metrics.client, JSON.stringify(metrics));
    assert.equal(await page.evaluate(() => document.body.scrollWidth <= window.innerWidth), true);
    await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
    const scaledScroll = await page.evaluate(() => {
      const table = document.querySelector('.tbl');
      table.scrollLeft = table.scrollWidth;
      window.scrollTo({ left: 9999 });
      const result = { local: table.scrollLeft, page: window.scrollX };
      window.scrollTo({ left: 0 });
      return result;
    });
    assert.ok(scaledScroll.local > 0, JSON.stringify(scaledScroll));
    assert.equal(scaledScroll.page, 0);
    const field = page.locator('#hx-read-doc .field-area');
    await field.focus();
    assert.equal(await field.evaluate((node) => {
      const rect = node.getBoundingClientRect();
      return document.activeElement === node && rect.width >= 44 && rect.height >= 44;
    }), true);
  } finally {
    await browser.close();
  }
});

test('all generated reflow fragments contain scoped, scalable, semantic document layout', () => {
  const reflowDir = new URL('../brand/reflow/', import.meta.url);
  const files = readdirSync(reflowDir).filter((name) => name.endsWith('.reflow.html'));
  // 14 single-document views + the stamped v2, v3, v4, and v5 packet pairs.
  assert.equal(files.length, 22);
  for (const file of files) {
    const html = readFileSync(new URL(file, reflowDir), 'utf8');
    assert.match(html, /#hx-read-doc \.tbl\s*\{[^}]*overflow-x:auto;contain:inline-size/);
    assert.match(html, /#hx-read-doc table\s*\{width:max-content;min-width:100%/);
    assert.match(html, /#hx-read-doc\s*\{[\s\S]*font-size:1rem/);
    assert.match(html, /#hx-read-doc \.ds\s*\{[^}]*box-sizing:content-box;[^}]*height:2\.75rem;min-height:2\.75rem/);
    assert.match(html, /var\(--hx-form-clearance, 0px\)/);
    assert.doesNotMatch(html, /-webkit-text-size-adjust|<th[^>]*>\s*<\/th>/);
    assert.doesNotMatch(html, /(?:^|})\s*body\s*\{/m);
    for (const heading of html.matchAll(/<th\b([^>]*)>/g)) {
      assert.match(heading[1], /scope="(?:col|row)"/, `${file}: ${heading[0]}`);
    }
    const markers = (html.match(/class="ds[^"]*"/g) || []).length;
    const uuids = [...html.matchAll(/data-hx-uuid="([^"]+)"/g)].map((match) => match[1]);
    assert.equal(uuids.length, markers, `${file}: unstamped anchor`);
    assert.equal(new Set(uuids).size, uuids.length, `${file}: duplicate UUID`);
  }
  const practices = readFileSync(new URL('code-of-safe-practices.reflow.html', reflowDir), 'utf8');
  assert.match(practices, /<h1 lang="es">ESPAÑOL<\/h1>/);
  assert.match(practices, /<p lang="es">/);
});
