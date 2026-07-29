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
    <header><h1>Fixture Document</h1></header>
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
    assert.deepEqual(requests.filter((path) => path.startsWith('/reflow/')), ['/reflow/index.json', '/reflow/fixture.reflow.html']);

    await page.locator('#hx-read-toggle').click();
    await page.waitForSelector('page-container .field-area');
    await page.waitForFunction((text) => document.querySelector('#hx-read-status')?.textContent === text, englishLabels.page_shown);
    assert.equal(await page.locator('#hx-read-toggle').getAttribute('aria-expanded'), 'false');
    assert.notEqual(await page.locator('page-container').evaluate((node) => getComputedStyle(node).display), 'none');

    await activateReadableView(page);
    await page.setViewportSize({ width: 768, height: 390 });
    await page.waitForSelector('page-container .field-area');
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
      const button = document.createElement('button');
      button.className = 'set-current-date-button';
      button.textContent = 'Set Today';
      container.appendChild(button);
    });
    const dateButton = await page.locator('.set-current-date-button').boundingBox();
    assert.ok(dateButton && dateButton.height >= 44, JSON.stringify(dateButton));
    assert.equal(await page.evaluate(() => document.body.scrollWidth <= window.innerWidth), true);
  } finally {
    await browser.close();
  }
});

test('keyboard activation works and reduced motion suppresses transitions', async () => {
  const { browser, page } = await fixture('<span class="ds" data-hx-uuid="u1"></span>', { reducedMotion: true });
  try {
    await page.waitForSelector('#hx-read-toggle');
    for (let i = 0; i < 4; i += 1) await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'hx-read-toggle');
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

test('200% text scaling keeps signer chrome reflowed without page overflow', async () => {
  const { browser, page } = await fixture('<span class="ds" data-hx-uuid="u1"></span>', { viewport: { width: 320, height: 640 } });
  try {
    await page.waitForSelector('#hx-read-toggle');
    await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
    assert.equal(await page.evaluate(() => document.body.scrollWidth <= window.innerWidth), true);
    const toggle = await page.locator('#hx-read-toggle').boundingBox();
    assert.ok(toggle && toggle.width >= 44 && toggle.height >= 44, JSON.stringify(toggle));
    const header = await page.locator('header').boundingBox();
    assert.ok(header && header.width <= 320, JSON.stringify(header));
  } finally {
    await browser.close();
  }
});

test('200% Spanish header actions wrap without widening the page', async () => {
  const labels = {
    readable_view: 'Vista legible',
    show_readable_view: 'Mostrar vista legible',
    show_page: 'Mostrar la página',
  };
  const { browser, page } = await fixture('<span class="ds" data-hx-uuid="u1"></span>', { labels, viewport: { width: 390, height: 844 } });
  try {
    await page.waitForSelector('#hx-read-toggle');
    await page.locator('header').evaluate((header) => {
      header.style.paddingInline = '28px';
      header.innerHTML = '<div class="flex items-center gap-2 group"><h1>Contrato de Empleo</h1><download-button><button type="button">Descargar</button></download-button></div>';
    });
    assert.equal(await page.evaluate(() => document.body.scrollWidth <= window.innerWidth), true);
    await page.evaluate(() => { document.documentElement.style.fontSize = '200%'; });
    assert.equal(await page.evaluate(() => document.body.scrollWidth <= window.innerWidth), true);
    const group = await page.locator('header .group').boundingBox();
    assert.ok(group && group.x + group.width <= 390, JSON.stringify(group));
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
    assert.equal(await page.evaluate(() => document.scrollingElement.scrollWidth <= document.scrollingElement.clientWidth), true);
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
  assert.equal(files.length, 14);
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
