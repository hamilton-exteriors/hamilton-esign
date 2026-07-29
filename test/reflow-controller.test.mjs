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
};

function controllerFor(labels = englishLabels) {
  return controllerTemplate.replace(
    /<%= json_escape\([\s\S]*?\.html_safe %>/,
    JSON.stringify(labels),
  );
}

function documentHtml(reflowUuid = 'u1', labels = englishLabels) {
  return `<!doctype html><html lang="en"><head><style>
    ${hamiltonCss}
    page-container{display:block;width:100%;height:520px}
    #hx-read-doc [data-hx-uuid]{position:relative;display:inline-block;width:130px;min-height:28px}
  </style></head><body>
    <header><h1>Fixture Document</h1></header>
    <main>
      <nav aria-label="Form progress"><div class="flex items-center flex-wrap steps-progress"><button type="button" aria-label="Step 1"></button><button type="button" aria-label="Step 2"></button><button type="button" aria-label="Step 3"></button></div></nav>
      <page-container id="page-attachment-0"><div class="field-area" data-uuid="${reflowUuid}" tabindex="0">Field</div></page-container>
    </main>
    <script>
      window.addEventListener('hx-reflow-ready', function () {
        var field = document.querySelector('.field-area');
        var anchor = document.querySelector('[data-hx-uuid="' + field.dataset.uuid + '"]');
        var visible = anchor && anchor.offsetParent !== null;
        (visible ? anchor : document.querySelector('page-container')).appendChild(field);
      });
    </script>
    <script>${controllerFor(labels)}</script>
  </body></html>`;
}

async function fixture(fragment, {
  signing = true,
  asyncFields = false,
  viewport = { width: 390, height: 844 },
  labels = englishLabels,
  reducedMotion = false,
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
      if (asyncFields) {
        html = html
          .replace(field, '<p>Loading signer…</p>')
          .replace('</body>', '<script>setTimeout(function(){ document.querySelector("page-container").innerHTML = "<div class=\\"field-area\\" data-uuid=\\"u1\\" tabindex=\\"0\\">Field</div>"; }, 25)</script></body>');
      }
      return route.fulfill({ contentType: 'text/html', body: html });
    }
    if (path === '/reflow/index.json') return route.fulfill({ contentType: 'application/json', body: '{"Fixture Document":"fixture"}' });
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
    assert.notEqual(await page.locator('page-container').evaluate((node) => getComputedStyle(node).display), 'none');
    assert.deepEqual(requests.filter((path) => path.startsWith('/reflow/')), []);

    await activateReadableView(page);
    assert.deepEqual(requests.filter((path) => path.startsWith('/reflow/')), ['/reflow/index.json', '/reflow/fixture.reflow.html']);

    await page.locator('#hx-read-toggle').click();
    await page.waitForSelector('page-container .field-area');
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

test('a stale UUID keeps the PDF visible and signable', async () => {
  const { browser, page } = await fixture('<span class="ds" data-hx-uuid="different"></span>');
  try {
    await page.locator('#hx-read-toggle').click();
    await page.waitForSelector('page-container .field-area');
    await page.waitForTimeout(100);
    assert.notEqual(await page.locator('page-container').evaluate((node) => getComputedStyle(node).display), 'none');
    assert.equal(await page.locator('#hx-read').evaluate((node) => getComputedStyle(node).display), 'none');
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

test('wide reflow tables scroll locally while fields remain visible and focusable', async () => {
  const fragment = `<style>
    #hx-read-doc .tbl{width:100%;min-width:0;max-width:100%;overflow-x:auto;-webkit-overflow-scrolling:touch}
    #hx-read-doc table{width:max-content;min-width:100%;border-collapse:collapse}
    #hx-read-doc td{white-space:nowrap;padding:8px}
  </style><div class="tbl"><table><tr><td><span data-hx-uuid="u1"></span></td><td>Extremely wide table content that must stay inside its local horizontal scroller</td></tr></table></div>`;
  const { browser, page } = await fixture(fragment, { viewport: { width: 320, height: 640 } });
  try {
    await activateReadableView(page);
    const metrics = await page.locator('.tbl').evaluate((table) => ({ client: table.clientWidth, scroll: table.scrollWidth }));
    assert.ok(metrics.scroll > metrics.client, JSON.stringify(metrics));
    assert.equal(await page.evaluate(() => document.body.scrollWidth <= window.innerWidth), true);
    const field = page.locator('#hx-read-doc .field-area');
    await field.focus();
    assert.equal(await field.evaluate((node) => document.activeElement === node && node.getBoundingClientRect().width > 0), true);
  } finally {
    await browser.close();
  }
});

test('all generated reflow fragments contain scoped local table scrolling', () => {
  const reflowDir = new URL('../brand/reflow/', import.meta.url);
  const files = readdirSync(reflowDir).filter((name) => name.endsWith('.reflow.html'));
  assert.equal(files.length, 14);
  for (const file of files) {
    const html = readFileSync(new URL(file, reflowDir), 'utf8');
    assert.match(html, /#hx-read-doc \.tbl\s*\{width:100%;min-width:0;max-width:100%;overflow-x:auto/);
    assert.match(html, /#hx-read-doc table\s*\{width:max-content;min-width:100%/);
    assert.doesNotMatch(html, /(?:^|})\s*body\s*\{/m);
  }
});
