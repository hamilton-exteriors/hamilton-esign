import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';

const layout = readFileSync(new URL('../brand/form.html.erb', import.meta.url), 'utf8');
const controller = (layout.match(/<script nonce="<%= content_security_policy_nonce %>">([\s\S]*?)<\/script>/) || [])[1];
if (!controller) throw new Error('mobile controller script not found in form layout');

function documentHtml(reflowUuid = 'u1') {
  return `<!doctype html><html><head><style>
    page-container{display:block;width:700px;height:900px}
    #hx-read-doc [data-hx-uuid]{position:relative;display:inline-block;width:130px;height:28px}
    @media (min-width:768px){#hx-read{display:none!important}}
  </style></head><body>
    <h1>Fixture Document</h1>
    <page-container id="page-attachment-0"><div class="field-area" data-uuid="${reflowUuid}">Field</div></page-container>
    <script>
      window.addEventListener('hx-reflow-ready', function () {
        var field = document.querySelector('.field-area');
        var anchor = document.querySelector('[data-hx-uuid="' + field.dataset.uuid + '"]');
        var visible = anchor && anchor.offsetParent !== null;
        (visible ? anchor : document.querySelector('page-container')).appendChild(field);
      });
    </script>
    <script>${controller}</script>
  </body></html>`;
}

async function fixture(fragment) {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.route('https://sign.test/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/s/test') return route.fulfill({ contentType: 'text/html', body: documentHtml() });
    if (path === '/reflow/index.json') return route.fulfill({ contentType: 'application/json', body: '{"Fixture Document":"fixture"}' });
    if (path === '/reflow/fixture.reflow.html') return route.fulfill({ contentType: 'text/html', body: fragment });
    return route.fulfill({ status: 404 });
  });
  await page.goto('https://sign.test/s/test');
  return { browser, page };
}

test('page toggle and viewport changes always retarget fields to the visible view', async () => {
  const { browser, page } = await fixture('<span class="ds" data-hx-uuid="u1"></span>');
  try {
    await page.waitForSelector('#hx-read-doc .field-area');
    await page.waitForFunction(() => getComputedStyle(document.querySelector('page-container')).display === 'none');

    await page.locator('#hx-read-toggle').click();
    await page.waitForSelector('page-container .field-area');
    assert.notEqual(await page.locator('page-container').evaluate((node) => getComputedStyle(node).display), 'none');

    await page.locator('#hx-read-toggle').click();
    await page.waitForSelector('#hx-read-doc .field-area');

    await page.setViewportSize({ width: 844, height: 390 });
    await page.waitForSelector('page-container .field-area');
    assert.notEqual(await page.locator('page-container').evaluate((node) => getComputedStyle(node).display), 'none');

    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForSelector('#hx-read-doc .field-area');
    await page.waitForFunction(() => getComputedStyle(document.querySelector('page-container')).display === 'none');
  } finally {
    await browser.close();
  }
});

test('a stale UUID keeps the PDF visible and signable', async () => {
  const { browser, page } = await fixture('<span class="ds" data-hx-uuid="different"></span>');
  try {
    await page.waitForSelector('page-container .field-area');
    await page.waitForTimeout(100);
    assert.notEqual(await page.locator('page-container').evaluate((node) => getComputedStyle(node).display), 'none');
    assert.equal(await page.locator('#hx-read').evaluate((node) => getComputedStyle(node).display), 'none');
  } finally {
    await browser.close();
  }
});
