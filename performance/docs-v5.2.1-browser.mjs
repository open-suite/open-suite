#!/usr/bin/env node
/** Measure authenticated Docs list/open/collaboration behavior with Playwright. */

import fs from 'node:fs';
import { chromium } from 'playwright';

const baseURL = process.env.DOCS_BENCHMARK_URL;
const sessionFile = process.env.DOCS_BENCHMARK_SESSION_FILE;
const unauthorizedSessionFile = process.env.DOCS_BENCHMARK_UNAUTHORIZED_SESSION_FILE;
const csrfTokenFile = process.env.DOCS_BENCHMARK_CSRF_TOKEN_FILE;
if (!baseURL || !sessionFile || !unauthorizedSessionFile) {
  throw new Error(
    'Set DOCS_BENCHMARK_URL, DOCS_BENCHMARK_SESSION_FILE, and ' +
      'DOCS_BENCHMARK_UNAUTHORIZED_SESSION_FILE.',
  );
}
const session = fs.readFileSync(sessionFile, 'utf8').trim();
const unauthorizedSession = fs.readFileSync(
  unauthorizedSessionFile,
  'utf8',
).trim();
const csrfToken = csrfTokenFile
  ? fs.readFileSync(csrfTokenFile, 'utf8').trim()
  : null;

function sessionCookie(value) {
  return {
    name: 'docs_sessionid',
    value,
    url: baseURL,
    httpOnly: true,
    sameSite: 'Lax',
    secure: baseURL.startsWith('https:'),
  };
}

function authenticatedCookies(value) {
  const cookies = [sessionCookie(value)];
  if (csrfToken) {
    cookies.push({
      name: 'csrftoken',
      value: csrfToken,
      url: baseURL,
      httpOnly: false,
      sameSite: 'Lax',
      secure: baseURL.startsWith('https:'),
    });
  }
  return cookies;
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ serviceWorkers: 'block' });
  await context.addCookies(authenticatedCookies(session));
  const page = await context.newPage();

  const listStart = performance.now();
  const listResponsePromise = page.waitForResponse(
    (response) =>
      response.status() === 200 &&
      /\/api\/v1\.0\/documents\/\?/.test(response.url()),
  );
  await page.goto(baseURL, { waitUntil: 'domcontentloaded' });
  const listResponse = await listResponsePromise;
  await listResponse.finished();
  const listResponseMs = performance.now() - listStart;
  const grid = page.getByTestId('docs-grid');
  await grid.waitFor({ state: 'visible' });
  await page.getByTestId('grid-loader').waitFor({ state: 'hidden' });
  const listUsableMs = performance.now() - listStart;

  const firstLink = grid.locator('a[href^="/docs/"]').first();
  const href = await firstLink.getAttribute('href');
  if (!href) throw new Error('No document link found');
  const docId = href.split('/').filter(Boolean).pop();

  const unauthorizedContext = await browser.newContext({
    serviceWorkers: 'block',
  });
  await unauthorizedContext.addCookies([
    sessionCookie(unauthorizedSession),
  ]);
  const unauthorizedResponse = await unauthorizedContext.request.get(
    `${baseURL}/api/v1.0/documents/${docId}/`,
  );
  const unauthorizedStatus = unauthorizedResponse.status();
  if (![403, 404].includes(unauthorizedStatus)) {
    throw new Error(
      `Unauthorized user read document: HTTP ${unauthorizedStatus}`,
    );
  }
  await unauthorizedContext.close();

  const openStart = performance.now();
  const detailPromise = page.waitForResponse(
    (response) =>
      response.status() === 200 &&
      response.url().endsWith(`/api/v1.0/documents/${docId}/`),
  );
  const contentPromise = page.waitForResponse(
    (response) =>
      response.status() === 200 &&
      response.url().endsWith(`/api/v1.0/documents/${docId}/content/`),
  );
  const websocketPromise = page.waitForEvent('websocket', (websocket) =>
    websocket.url().includes('/collaboration/ws/?room='),
  );
  await firstLink.click();
  const detail = await detailPromise;
  await detail.finished();
  const detailMs = performance.now() - openStart;
  const content = await contentPromise;
  await content.finished();
  const contentBeforeEdit = await content.body();
  const contentMs = performance.now() - openStart;
  const websocket = await websocketPromise;
  const websocketMs = performance.now() - openStart;
  const editor = page.locator('.ProseMirror');
  await editor.waitFor({ state: 'visible', timeout: 30000 });
  await page.getByLabel('Document title').waitFor({ state: 'visible' });
  const editorVisibleMs = performance.now() - openStart;
  const firstDocumentUsableMs = performance.now() - listStart;

  const secondContext = await browser.newContext({ serviceWorkers: 'block' });
  await secondContext.addCookies(authenticatedCookies(session));
  const secondPage = await secondContext.newPage();
  await secondPage.goto(`${baseURL}${href}`, { waitUntil: 'domcontentloaded' });
  const secondEditor = secondPage.locator('.ProseMirror');
  await secondEditor.waitFor({ state: 'visible', timeout: 30000 });
  const token = `collaboration-${Date.now()}`;
  const collaborationStart = performance.now();
  await editor.click();
  await page.keyboard.type(token);
  await secondEditor.getByText(token).waitFor({
    state: 'visible',
    timeout: 10000,
  });
  const remoteEditMs = performance.now() - collaborationStart;
  const websocketStayedOpen = !websocket.isClosed();

  let persisted = null;
  if (process.env.DOCS_BENCHMARK_CHECK_PERSISTENCE === 'true') {
    if (!csrfToken) {
      throw new Error(
        'DOCS_BENCHMARK_CSRF_TOKEN_FILE is required for persistence checks.',
      );
    }
    const savePromise = page.waitForResponse(
      (response) =>
        response.request().method() === 'PATCH' &&
        response.url().endsWith(`/api/v1.0/documents/${docId}/content/`),
      { timeout: 70000 },
    );
    await page.waitForTimeout(61000);
    const saveResponse = await savePromise;
    if (!saveResponse.ok()) {
      throw new Error(`Content save failed: HTTP ${saveResponse.status()}`);
    }
    const persistedResponse = await context.request.get(
      `${baseURL}/api/v1.0/documents/${docId}/content/`,
    );
    const persistedContent = await persistedResponse.body();
    persisted =
      persistedResponse.ok() && !persistedContent.equals(contentBeforeEdit);
    if (!persisted) throw new Error('Collaborative edit was not persisted');
  }

  console.log(
    JSON.stringify({
      list_response_ms: Math.round(listResponseMs * 10) / 10,
      list_usable_ms: Math.round(listUsableMs * 10) / 10,
      document_detail_ms: Math.round(detailMs * 10) / 10,
      document_content_ms: Math.round(contentMs * 10) / 10,
      websocket_open_ms: Math.round(websocketMs * 10) / 10,
      editor_visible_ms: Math.round(editorVisibleMs * 10) / 10,
      document_open_usable_ms:
        Math.round(Math.max(contentMs, websocketMs, editorVisibleMs) * 10) / 10,
      first_document_usable_ms:
        Math.round(firstDocumentUsableMs * 10) / 10,
      remote_edit_visible_ms: Math.round(remoteEditMs * 10) / 10,
      unauthorized_document_status: unauthorizedStatus,
      collaboration_persisted: persisted,
      websocket_closed_before_save: !websocketStayedOpen,
    }),
  );
  await secondContext.close();
  await context.close();
  await browser.close();
}

await main();
