(() => {
  'use strict';

  const PAGE_SIZE = 10;
  const REQUEST_COUNT = 50;
  const SEARCH_CACHE_TTL = 5 * 60 * 1000;
  const SEARCH_CACHE_LIMIT = 20;
  const MAX_READER_CHARS = 250_000;
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const dateFormatter = new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });

  const elements = {
    homeView: document.getElementById('home-view'),
    resultsView: document.getElementById('results-view'),
    homeForm: document.getElementById('home-form'),
    resultsForm: document.getElementById('results-form'),
    homeInput: document.getElementById('home-input'),
    resultsInput: document.getElementById('results-input'),
    luckyButton: document.getElementById('lucky-button'),
    homeStatus: document.getElementById('home-status'),
    homeStatusText: document.getElementById('home-status-text'),
    homeKeyWarning: document.getElementById('home-key-warning'),
    serviceBadge: document.querySelector('.service-badge'),
    tabs: Array.from(document.querySelectorAll('.tab')),
    searchMeta: document.getElementById('search-meta'),
    keyError: document.getElementById('key-error'),
    errorState: document.getElementById('error-state'),
    errorTitle: document.getElementById('error-title'),
    errorMessage: document.getElementById('error-message'),
    emptyState: document.getElementById('empty-state'),
    emptyQuery: document.getElementById('empty-query'),
    skeletonList: document.getElementById('skeleton-list'),
    resultsList: document.getElementById('results-list'),
    pagination: document.getElementById('pagination'),
    readerDrawer: document.getElementById('reader-drawer'),
    readerBackdrop: document.getElementById('reader-backdrop'),
    readerClose: document.getElementById('reader-close'),
    readerHost: document.getElementById('reader-host'),
    readerTitle: document.getElementById('reader-title'),
    readerMeta: document.getElementById('reader-meta'),
    readerOpenLink: document.getElementById('reader-open-link'),
    readerLoading: document.getElementById('reader-loading'),
    readerError: document.getElementById('reader-error'),
    readerErrorMessage: document.getElementById('reader-error-message'),
    readerRetry: document.getElementById('reader-retry'),
    readerContent: document.getElementById('reader-content'),
    toast: document.getElementById('toast'),
  };

  const state = {
    query: '',
    results: [],
    total: 0,
    elapsedMs: null,
    page: 1,
    tab: 'all',
    hasLoaded: false,
    searchController: null,
    readerController: null,
    readerLastFocus: null,
    readerOpen: false,
    toastTimer: null,
  };

  const searchCache = new Map();

  class ApiError extends Error {
    constructor(message, code = 'unknown_error', status = 0) {
      super(message);
      this.name = 'ApiError';
      this.code = code;
      this.status = status;
    }
  }

  /* ---------- Tiny helpers ---------- */

  function codePointLength(value) {
    return Array.from(value).length;
  }

  function formatElapsed(milliseconds) {
    if (!Number.isFinite(milliseconds) || milliseconds < 0) return null;
    const seconds = milliseconds / 1000;
    return seconds < 1 ? seconds.toFixed(2) : seconds.toFixed(1);
  }

  function toSafeHttpUrl(rawUrl, base = window.location.href) {
    if (typeof rawUrl !== 'string' || !rawUrl.trim()) return null;
    try {
      const url = new URL(rawUrl, base);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
      return url;
    } catch {
      return null;
    }
  }

  function formatDate(rawDate) {
    if (typeof rawDate !== 'string' || !rawDate) return '';
    const date = new Date(rawDate);
    if (Number.isNaN(date.getTime())) return '';
    return dateFormatter.format(date);
  }

  function showToast(message, duration = 2600) {
    window.clearTimeout(state.toastTimer);
    elements.toast.textContent = message;
    elements.toast.hidden = false;
    state.toastTimer = window.setTimeout(() => {
      elements.toast.hidden = true;
    }, duration);
  }

  function setStatusBadge(isConfigured, statusText) {
    elements.homeStatus.classList.toggle('is-ready', isConfigured === true);
    elements.homeStatus.classList.toggle('is-missing', isConfigured === false);
    elements.homeStatusText.textContent = statusText;
    if (elements.serviceBadge) {
      elements.serviceBadge.classList.toggle('is-ready', isConfigured === true);
      elements.serviceBadge.classList.toggle('is-missing', isConfigured === false);
    }
  }

  /* ---------- Theme ---------- */

  function applyTheme(theme, persist = false) {
    const nextTheme = theme === 'dark' ? 'dark' : 'light';
    document.documentElement.dataset.theme = nextTheme;
    for (const button of document.querySelectorAll('.theme-toggle')) {
      const label = nextTheme === 'dark' ? '切换浅色模式' : '切换深色模式';
      button.setAttribute('aria-label', label);
      button.setAttribute('title', label);
    }
    if (persist) {
      try {
        localStorage.setItem('deepsearch-theme', nextTheme);
      } catch {
        // Storage can be unavailable in hardened browsers; the theme still applies.
      }
    }
  }

  function initTheme() {
    let stored = null;
    try {
      stored = localStorage.getItem('deepsearch-theme');
    } catch {
      stored = null;
    }
    const prefersDark =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-color-scheme: dark)').matches;
    applyTheme(stored || (prefersDark ? 'dark' : 'light'));
  }

  /* ---------- API ---------- */

  async function requestJson(path, body, signal) {
    let response;
    try {
      response = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(body),
        signal,
      });
    } catch (error) {
      if (error?.name === 'AbortError') throw error;
      throw new ApiError(
        '无法连接本地服务，请确认 npm start 仍在运行。',
        'network_error',
        0,
      );
    }

    let data = null;
    try {
      data = await response.json();
    } catch {
      data = null;
    }

    if (!response.ok) {
      const message =
        data?.error?.message || `本地服务返回了 HTTP ${response.status}。`;
      const code = data?.error?.code || 'http_error';
      throw new ApiError(message, code, response.status);
    }
    if (!data || typeof data !== 'object') {
      throw new ApiError('本地服务返回了无法解析的响应。', 'invalid_response', response.status);
    }
    return data;
  }

  function getCachedSearch(query) {
    const entry = searchCache.get(query);
    if (!entry) return null;
    if (Date.now() - entry.timestamp > SEARCH_CACHE_TTL) {
      searchCache.delete(query);
      return null;
    }
    return entry.data;
  }

  function setCachedSearch(query, data) {
    if (searchCache.size >= SEARCH_CACHE_LIMIT) {
      const oldestKey = searchCache.keys().next().value;
      if (oldestKey) searchCache.delete(oldestKey);
    }
    searchCache.set(query, { timestamp: Date.now(), data });
  }

  function sanitizeResults(rawResults) {
    if (!Array.isArray(rawResults)) return [];
    const results = [];
    for (const raw of rawResults) {
      if (!raw || typeof raw !== 'object') continue;
      const url = toSafeHttpUrl(raw.url);
      if (!url) continue;
      const title =
        typeof raw.title === 'string' && raw.title.trim()
          ? raw.title.trim()
          : url.hostname;
      let snippet = typeof raw.snippet === 'string' ? raw.snippet.trim() : '';
      if (!snippet && typeof raw.summary === 'string') {
        snippet = raw.summary.trim();
        if (codePointLength(snippet) > 260) {
          snippet = `${Array.from(snippet).slice(0, 260).join('')}…`;
        }
      }
      results.push({
        title,
        url: url.href,
        snippet,
        siteName:
          typeof raw.site_name === 'string' && raw.site_name.trim()
            ? raw.site_name.trim()
            : null,
        siteIcon: toSafeHttpUrl(raw.site_icon)?.href || null,
        date: formatDate(raw.date),
        dateValue:
          typeof raw.date === 'string' && !Number.isNaN(new Date(raw.date).getTime())
            ? new Date(raw.date).getTime()
            : 0,
      });
    }
    return results;
  }

  /* ---------- View and URL state ---------- */

  function parseLocation() {
    const params = new URLSearchParams(window.location.search);
    const query = (params.get('q') || '').trim();
    const parsedPage = Number.parseInt(params.get('page') || '1', 10);
    const page = Number.isSafeInteger(parsedPage) && parsedPage > 0 ? parsedPage : 1;
    const tab = params.get('tab') === 'recent' ? 'recent' : 'all';
    return { query, page, tab };
  }

  function updateUrl({ push = false } = {}) {
    const params = new URLSearchParams();
    if (state.query) {
      params.set('q', state.query);
      if (state.page > 1) params.set('page', String(state.page));
      if (state.tab === 'recent') params.set('tab', 'recent');
    }
    const nextUrl = params.toString() ? `/?${params.toString()}` : '/';
    const historyState = {
      query: state.query,
      page: state.page,
      tab: state.tab,
    };
    if (push) {
      window.history.pushState(historyState, '', nextUrl);
    } else {
      window.history.replaceState(historyState, '', nextUrl);
    }
  }

  function syncInputs() {
    elements.homeInput.value = state.query;
    elements.resultsInput.value = state.query;
    syncClearButtons();
  }

  function syncClearButtons() {
    for (const form of document.querySelectorAll('.search-form')) {
      const input = form.querySelector('.search-input');
      const clear = form.querySelector('.clear-button');
      if (input && clear) clear.hidden = !input.value;
    }
  }

  function setActiveTab(tab) {
    for (const button of elements.tabs) {
      const selected = button.dataset.tab === tab;
      button.setAttribute('aria-selected', selected ? 'true' : 'false');
    }
  }

  function showHomeView() {
    elements.resultsView.hidden = true;
    elements.homeView.hidden = false;
    document.title = 'deepsearch';
  }

  function showResultsView() {
    elements.homeView.hidden = true;
    elements.resultsView.hidden = false;
    document.title = state.query ? `${state.query} · deepsearch` : 'deepsearch';
    window.scrollTo({ top: 0, behavior: 'auto' });
  }

  /* ---------- Search rendering ---------- */

  function setLoadingState() {
    elements.keyError.hidden = true;
    elements.errorState.hidden = true;
    elements.emptyState.hidden = true;
    elements.skeletonList.hidden = false;
    elements.resultsList.replaceChildren();
    elements.resultsList.setAttribute('aria-busy', 'true');
    elements.pagination.hidden = true;
    elements.searchMeta.textContent = '正在通过 DeepSeek 搜索…';
  }

  function renderSearchError(error) {
    elements.skeletonList.hidden = true;
    elements.emptyState.hidden = true;
    elements.errorState.hidden = true;
    elements.keyError.hidden = true;
    elements.resultsList.replaceChildren();
    elements.resultsList.setAttribute('aria-busy', 'false');
    elements.pagination.hidden = true;
    elements.searchMeta.textContent = '搜索未完成';

    if (error?.code === 'missing_api_key') {
      elements.keyError.hidden = false;
      return;
    }

    const titles = {
      invalid_request: '搜索请求无效',
      invalid_json: '搜索请求无效',
      unauthorized: 'API Key 无效或无权限',
      insufficient_balance: 'DeepSeek 账户余额不足',
      forbidden: '请求被拒绝',
      rate_limit_exceeded: '搜索请求过于频繁',
      timeout: '搜索超时',
      network_error: '无法连接 DeepSeek',
      upstream_error: 'DeepSeek 服务暂时出错',
    };
    let title = titles[error?.code];
    if (!title) {
      if (error?.status === 401) title = 'API Key 无效或无权限';
      else if (error?.status === 402) title = 'DeepSeek 账户余额不足';
      else if (error?.status === 429) title = '搜索请求过于频繁';
      else title = '搜索时发生错误';
    }

    elements.errorTitle.textContent = title;
    elements.errorMessage.textContent =
      error?.message || '发生了未知错误，请稍后再试。';
    elements.errorState.hidden = false;
  }

  function renderEmptyState() {
    elements.skeletonList.hidden = true;
    elements.keyError.hidden = true;
    elements.errorState.hidden = true;
    elements.resultsList.replaceChildren();
    elements.resultsList.setAttribute('aria-busy', 'false');
    elements.pagination.hidden = true;
    elements.emptyQuery.textContent = state.query;
    elements.emptyState.hidden = false;
  }

  function renderResults() {
    elements.skeletonList.hidden = true;
    elements.keyError.hidden = true;
    elements.errorState.hidden = true;
    elements.emptyState.hidden = true;
    elements.resultsList.setAttribute('aria-busy', 'false');

    let orderedResults = state.results;
    if (state.tab === 'recent') {
      orderedResults = state.results
        .map((result, index) => ({ result, index }))
        .sort((a, b) => b.result.dateValue - a.result.dateValue || a.index - b.index)
        .map((entry) => entry.result);
    }

    state.total = orderedResults.length;
    const totalPages = Math.max(1, Math.ceil(state.total / PAGE_SIZE));
    state.page = Math.min(Math.max(1, state.page), totalPages);
    updateUrl({ push: false });

    const elapsed = formatElapsed(state.elapsedMs);
    const elapsedText = elapsed === null ? '' : `（用时 ${elapsed} 秒）`;
    const sortText = state.tab === 'recent' ? ' · 按发布日期排序' : '';
    const resultPrefix = state.total >= REQUEST_COUNT ? '找到约' : '找到';
    elements.searchMeta.textContent = `${resultPrefix} ${state.total} 条结果${elapsedText}${sortText}`;

    if (state.total === 0) {
      renderEmptyState();
      return;
    }

    const start = (state.page - 1) * PAGE_SIZE;
    const pageResults = orderedResults.slice(start, start + PAGE_SIZE);
    const fragment = document.createDocumentFragment();
    for (const result of pageResults) {
      fragment.append(buildResult(result));
    }
    elements.resultsList.replaceChildren(fragment);
    renderPagination(totalPages);
  }

  function buildResult(result) {
    const article = document.createElement('article');
    article.className = 'result';

    const source = document.createElement('div');
    source.className = 'result-source';

    const favicon = document.createElement('span');
    favicon.className = 'result-favicon';
    favicon.setAttribute('aria-hidden', 'true');
    const fallbackLetter = (result.siteName || new URL(result.url).hostname)
      .trim()
      .charAt(0)
      .toUpperCase();
    favicon.textContent = fallbackLetter || '·';
    if (result.siteIcon) {
      const image = document.createElement('img');
      image.src = result.siteIcon;
      image.alt = '';
      image.loading = 'lazy';
      image.decoding = 'async';
      image.referrerPolicy = 'no-referrer';
      image.addEventListener('error', () => image.remove(), { once: true });
      favicon.append(image);
    }
    source.append(favicon);

    let parsedUrl;
    try {
      parsedUrl = new URL(result.url);
    } catch {
      parsedUrl = null;
    }

    const siteName = document.createElement('span');
    siteName.className = 'result-site-name';
    siteName.textContent = result.siteName || parsedUrl?.hostname || '网页';
    source.append(siteName);

    if (parsedUrl) {
      const urlLine = document.createElement('span');
      urlLine.className = 'result-url';

      const domain = document.createElement('span');
      domain.className = 'result-domain';
      domain.textContent = parsedUrl.hostname;
      urlLine.append(domain);

      let pathText = '';
      try {
        const segments = parsedUrl.pathname
          .split('/')
          .filter(Boolean)
          .slice(0, 4)
          .map((segment) => decodeURIComponent(segment));
        pathText = segments.join(' › ');
      } catch {
        pathText = parsedUrl.pathname;
      }
      if (pathText && pathText !== '/') {
        const path = document.createElement('span');
        path.className = 'result-path';
        path.textContent = pathText;
        urlLine.append(path);
      }
      source.append(urlLine);
    }

    const previewButton = document.createElement('button');
    previewButton.type = 'button';
    previewButton.className = 'result-preview-button';
    previewButton.dataset.url = result.url;
    previewButton.dataset.title = result.title;
    previewButton.setAttribute('aria-label', `预览 ${result.title}`);
    previewButton.setAttribute('title', '通过 DeepSeek Fetch 预览此网页');
    const previewLabel = document.createElement('span');
    previewLabel.className = 'preview-label';
    previewLabel.textContent = '预览';
    previewButton.append(
      makeIcon(['M5 3h9l5 5v13H5z', 'M14 3v5h5M8 13h8M8 17h6']),
      previewLabel,
    );
    source.append(previewButton);

    const title = document.createElement('a');
    title.className = 'result-title';
    title.href = result.url;
    title.target = '_blank';
    title.rel = 'noopener noreferrer';
    title.referrerPolicy = 'no-referrer';
    appendHighlighted(title, result.title, getHighlightTerms(state.query));

    const snippet = document.createElement('div');
    snippet.className = 'result-snippet';
    if (result.date) {
      const date = document.createElement('span');
      date.className = 'result-date';
      date.textContent = result.date;
      snippet.append(date);
    }
    appendHighlighted(snippet, result.snippet, getHighlightTerms(state.query));

    article.append(source, title, snippet);
    return article;
  }

  function makeIcon(paths) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'icon');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    for (const definition of paths) {
      const path = document.createElementNS(SVG_NS, 'path');
      path.setAttribute('d', definition);
      svg.append(path);
    }
    return svg;
  }

  function getHighlightTerms(query) {
    if (!query) return [];
    const phrases = [];
    const withoutPhrases = query.replace(/"([^"]+)"/g, (_, phrase) => {
      if (phrase.trim()) phrases.push(phrase.trim());
      return ' ';
    });
    const words = withoutPhrases
      .split(/\s+/)
      .filter((word) => !/^-?(?:site|lang|after|before):/i.test(word))
      .map((word) => word.replace(/^-/, ''));
    const terms = [...phrases, ...words]
      .map((term) => term.replace(/^"|"$/g, '').trim())
      .filter((term) => codePointLength(term) >= 2);
    return [...new Set(terms)].sort((a, b) => b.length - a.length).slice(0, 8);
  }

  function appendHighlighted(container, text, terms) {
    if (!text) return;
    if (!terms.length) {
      container.append(document.createTextNode(text));
      return;
    }
    let expression;
    try {
      expression = new RegExp(terms.map(escapeRegExp).join('|'), 'giu');
    } catch {
      container.append(document.createTextNode(text));
      return;
    }
    let lastIndex = 0;
    for (const match of text.matchAll(expression)) {
      if (match.index > lastIndex) {
        container.append(document.createTextNode(text.slice(lastIndex, match.index)));
      }
      const mark = document.createElement('mark');
      mark.textContent = match[0];
      container.append(mark);
      lastIndex = match.index + match[0].length;
    }
    if (lastIndex < text.length) {
      container.append(document.createTextNode(text.slice(lastIndex)));
    }
  }

  function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function renderPagination(totalPages) {
    if (totalPages <= 1) {
      elements.pagination.hidden = true;
      elements.pagination.replaceChildren();
      return;
    }

    const fragment = document.createDocumentFragment();

    const previous = document.createElement('button');
    previous.type = 'button';
    previous.className = 'page-button page-button--wide';
    previous.textContent = '上一页';
    previous.disabled = state.page === 1;
    previous.dataset.page = String(state.page - 1);
    fragment.append(previous);

    for (let page = 1; page <= totalPages; page += 1) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'page-button';
      button.textContent = String(page);
      button.dataset.page = String(page);
      button.setAttribute('aria-label', `第 ${page} 页`);
      if (page === state.page) {
        button.setAttribute('aria-current', 'page');
      }
      fragment.append(button);
    }

    const next = document.createElement('button');
    next.type = 'button';
    next.className = 'page-button page-button--wide';
    next.textContent = '下一页';
    next.disabled = state.page === totalPages;
    next.dataset.page = String(state.page + 1);
    fragment.append(next);

    elements.pagination.replaceChildren(fragment);
    elements.pagination.hidden = false;
  }

  /* ---------- Search flow ---------- */

  async function performSearch(
    rawQuery,
    { push = true, page = 1, tab = 'all', force = false } = {},
  ) {
    const query = rawQuery.trim();
    if (!query) {
      (elements.resultsView.hidden ? elements.homeInput : elements.resultsInput).focus();
      return { ok: false, error: null };
    }

    closeReader();
    state.searchController?.abort();
    const controller = new AbortController();
    state.searchController = controller;

    state.query = query;
    state.page = page;
    state.tab = tab === 'recent' ? 'recent' : 'all';
    state.hasLoaded = false;
    state.results = [];
    state.total = 0;

    syncInputs();
    setActiveTab(state.tab);
    showResultsView();
    updateUrl({ push });
    setLoadingState();

    try {
      let data = !force ? getCachedSearch(query) : null;
      if (!data) {
        data = await requestJson(
          '/api/search',
          { query, count: REQUEST_COUNT, ori_question: query },
          controller.signal,
        );
        data = {
          ...data,
          results: sanitizeResults(data.results),
        };
        setCachedSearch(query, data);
      }

      if (controller.signal.aborted) return { ok: false, error: null };

      state.results = data.results;
      state.elapsedMs = data.elapsed_ms;
      state.hasLoaded = true;
      renderResults();
      return { ok: true, results: state.results };
    } catch (error) {
      if (error?.name === 'AbortError' || controller.signal.aborted) {
        return { ok: false, error: null };
      }
      state.hasLoaded = false;
      renderSearchError(error);
      return { ok: false, error };
    }
  }

  function handlePopState() {
    const route = parseLocation();
    if (!route.query) {
      closeReader();
      state.searchController?.abort();
      showHomeView();
      return;
    }

    const sameQuery = route.query === state.query && state.hasLoaded;
    if (sameQuery) {
      state.page = route.page;
      state.tab = route.tab;
      syncInputs();
      setActiveTab(state.tab);
      showResultsView();
      renderResults();
      return;
    }
    performSearch(route.query, {
      push: false,
      page: route.page,
      tab: route.tab,
    });
  }

  function startSearchFromInput(input, tab) {
    const query = input.value.trim();
    if (!query) {
      input.focus();
      return;
    }
    performSearch(query, { push: true, page: 1, tab });
  }

  /* ---------- Reader drawer ---------- */

  function setReaderOpen(open) {
    state.readerOpen = open;
    elements.readerDrawer.hidden = !open;
    elements.readerBackdrop.hidden = !open;
    document.body.classList.toggle('reader-open', open);
    elements.homeView.inert = open;
    elements.resultsView.inert = open;
  }

  async function openReader(url, title, { retainFocus = false } = {}) {
    const safeUrl = toSafeHttpUrl(url);
    if (!safeUrl) {
      showToast('这个结果没有可用的网页地址。');
      return;
    }

    if (!retainFocus) state.readerLastFocus = document.activeElement;
    state.readerController?.abort();
    const controller = new AbortController();
    state.readerController = controller;

    if (!state.readerOpen) {
      setReaderOpen(true);
      elements.readerClose.focus();
    }

    elements.readerTitle.textContent = title || '正在抓取网页…';
    elements.readerHost.textContent = safeUrl.hostname;
    elements.readerOpenLink.href = safeUrl.href;
    elements.readerMeta.textContent = '正在通过 DeepSeek Fetch 抓取…';
    elements.readerLoading.hidden = false;
    elements.readerError.hidden = true;
    elements.readerContent.replaceChildren();
    elements.readerDrawer.setAttribute('aria-busy', 'true');
    elements.readerDrawer.querySelector('.reader-scroll').scrollTop = 0;

    try {
      const data = await requestJson(
        '/api/fetch',
        { url: safeUrl.href },
        controller.signal,
      );
      if (controller.signal.aborted) return;

      const fetchedTitle =
        typeof data.title === 'string' && data.title.trim() ? data.title.trim() : title;
      elements.readerTitle.textContent = fetchedTitle || safeUrl.hostname;
      elements.readerOpenLink.href = safeUrl.href;

      const elapsed = formatElapsed(data.elapsed_ms);
      const elapsedText = elapsed === null ? '' : ` · 用时 ${elapsed} 秒`;
      const chars = typeof data.content === 'string' ? data.content.length : 0;
      elements.readerMeta.textContent = `由 DeepSeek Fetch 抓取${elapsedText} · ${chars.toLocaleString('zh-CN')} 字符`;

      if (!data.content || !data.content.trim()) {
        showReaderError('DeepSeek 未能从这个网页提取到可读正文。');
        return;
      }

      const fragment = renderMarkdown(data.content, safeUrl.href);
      const pageTitle = elements.readerTitle.textContent.replace(/\s+/g, ' ').trim();
      for (const block of Array.from(fragment.children).slice(0, 4)) {
        if (block.tagName !== 'H1') continue;
        const headingText = block.textContent.replace(/\s+/g, ' ').trim();
        if (
          headingText &&
          pageTitle &&
          (headingText === pageTitle ||
            headingText.startsWith(pageTitle) ||
            pageTitle.startsWith(headingText))
        ) {
          block.remove();
        }
        break;
      }
      elements.readerContent.replaceChildren(fragment);
    } catch (error) {
      if (error?.name === 'AbortError' || controller.signal.aborted) return;
      showReaderError(error?.message || '无法抓取这个网页，请稍后重试。');
    } finally {
      if (!controller.signal.aborted) {
        elements.readerLoading.hidden = true;
        elements.readerDrawer.setAttribute('aria-busy', 'false');
      }
    }
  }

  function showReaderError(message) {
    elements.readerContent.replaceChildren();
    elements.readerErrorMessage.textContent = message;
    elements.readerError.hidden = false;
    elements.readerLoading.hidden = true;
    elements.readerDrawer.setAttribute('aria-busy', 'false');
  }

  function closeReader() {
    if (!state.readerOpen && elements.readerDrawer.hidden) return;
    state.readerController?.abort();
    state.readerController = null;
    setReaderOpen(false);
    elements.readerLoading.hidden = true;
    elements.readerContent.replaceChildren();
    elements.readerDrawer.removeAttribute('aria-busy');
    const lastFocus = state.readerLastFocus;
    state.readerLastFocus = null;
    if (lastFocus && lastFocus.isConnected) {
      window.setTimeout(() => lastFocus.focus(), 0);
    }
  }

  /* ---------- Safe Markdown rendering ---------- */

  function renderMarkdown(markdown, baseUrl) {
    const fragment = document.createDocumentFragment();
    let text = String(markdown || '')
      .replace(/\r\n?/g, '\n')
      .replace(/^﻿/, '')
      .replace(/\\([\\`*_{}\[\]()#+\-.!|>~:\/,])/g, '$1');
    let truncated = false;
    if (text.length > MAX_READER_CHARS) {
      text = text.slice(0, MAX_READER_CHARS);
      truncated = true;
    }
    const lines = text.split('\n');
    renderBlocks(lines, fragment, baseUrl);
    if (truncated) {
      const note = document.createElement('p');
      note.className = 'reader-truncated-note';
      note.textContent = '预览内容过长，仅显示前 250,000 个字符。';
      fragment.append(note);
    }
    return fragment;
  }

  function isBlockStart(line) {
    return (
      /^\s{0,3}(`{3,}|~{3,})/.test(line) ||
      /^\s{0,3}#{1,6}\s+/.test(line) ||
      /^\s{0,3}>/.test(line) ||
      /^\s*(?:[-+*]|\d+[.)])\s+/.test(line) ||
      /^\s{0,3}(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/.test(line)
    );
  }

  function isCjkCharacter(character) {
    return /[⺀-鿿豈-﫿]/.test(character || '');
  }

  function joinParagraphLines(lines) {
    let result = '';
    for (const line of lines) {
      const value = line.trim();
      if (!value) continue;
      if (!result) {
        result = value;
      } else if (
        isCjkCharacter(result.slice(-1)) &&
        isCjkCharacter(value.charAt(0))
      ) {
        result += value;
      } else {
        result += ` ${value}`;
      }
    }
    return result;
  }

  function renderBlocks(lines, parent, baseUrl) {
    let index = 0;

    while (index < lines.length) {
      const line = lines[index];

      if (!line.trim()) {
        index += 1;
        continue;
      }

      const fence = line.match(/^\s{0,3}(`{3,}|~{3,})(.*)$/);
      if (fence) {
        const marker = fence[1];
        const fenceCharacter = marker.charAt(0) === '`' ? '`' : '~';
        const minimumLength = marker.length;
        const closeExpression = new RegExp(
          `^\\s{0,3}${fenceCharacter}{${minimumLength},}\\s*$`,
        );
        const codeLines = [];
        index += 1;
        while (index < lines.length && !closeExpression.test(lines[index])) {
          codeLines.push(lines[index]);
          index += 1;
        }
        if (index < lines.length) index += 1;
        const pre = document.createElement('pre');
        const code = document.createElement('code');
        code.textContent = codeLines.join('\n');
        pre.append(code);
        parent.append(pre);
        continue;
      }

      const heading = line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
      if (heading) {
        const element = document.createElement(`h${heading[1].length}`);
        appendInline(element, heading[2], baseUrl);
        parent.append(element);
        index += 1;
        continue;
      }

      if (/^\s{0,3}(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/.test(line)) {
        parent.append(document.createElement('hr'));
        index += 1;
        continue;
      }

      if (/^\s{0,3}>/.test(line)) {
        const quoteLines = [];
        while (index < lines.length && /^\s{0,3}>/.test(lines[index])) {
          quoteLines.push(lines[index].replace(/^\s{0,3}>\s?/, ''));
          index += 1;
        }
        const blockquote = document.createElement('blockquote');
        renderBlocks(quoteLines, blockquote, baseUrl);
        parent.append(blockquote);
        continue;
      }

      const listMatch = line.match(/^(\s*)([-+*]|\d+[.)])\s+(.*)$/);
      if (listMatch) {
        index = renderList(lines, index, parent, baseUrl);
        continue;
      }

      if (line.includes('|') && index + 1 < lines.length) {
        const nextLine = lines[index + 1];
        if (/^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(nextLine)) {
          index = renderTable(lines, index, parent, baseUrl);
          continue;
        }
      }

      const paragraphLines = [];
      while (index < lines.length && lines[index].trim()) {
        if (paragraphLines.length && isBlockStart(lines[index])) break;
        paragraphLines.push(lines[index]);
        index += 1;
      }
      const paragraph = document.createElement('p');
      appendInline(paragraph, joinParagraphLines(paragraphLines), baseUrl);
      parent.append(paragraph);
    }
  }

  function renderList(lines, startIndex, parent, baseUrl) {
    const firstMatch = lines[startIndex].match(/^(\s*)([-+*]|\d+[.)])\s+(.*)$/);
    const ordered = /^\d/.test(firstMatch[2]);
    const list = document.createElement(ordered ? 'ol' : 'ul');
    const startNumber = ordered ? Number.parseInt(firstMatch[2], 10) : 1;
    if (ordered && Number.isFinite(startNumber) && startNumber > 1) {
      list.start = startNumber;
    }

    let index = startIndex;
    let currentItem = null;

    while (index < lines.length) {
      const line = lines[index];

      if (!line.trim()) {
        let lookahead = index + 1;
        while (lookahead < lines.length && !lines[lookahead].trim()) lookahead += 1;
        const next = lines[lookahead];
        if (next && /^(\s*)([-+*]|\d+[.)])\s+/.test(next)) {
          const match = next.match(/^(\s*)([-+*]|\d+[.)])\s+/);
          if (/^\d/.test(match[2]) === ordered) {
            index = lookahead;
            continue;
          }
        }
        break;
      }

      const match = line.match(/^(\s*)([-+*]|\d+[.)])\s+(.*)$/);
      if (match) {
        if (/^\d/.test(match[2]) !== ordered) break;
        currentItem = document.createElement('li');
        appendInline(currentItem, match[3], baseUrl);
        list.append(currentItem);
        index += 1;
        continue;
      }

      if (currentItem && /^\s{2,}\S/.test(line)) {
        appendInline(currentItem, ` ${line.trim()}`, baseUrl);
        index += 1;
        continue;
      }

      break;
    }

    parent.append(list);
    return index;
  }

  function splitTableRow(line) {
    const normalized = line
      .trim()
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .replace(/\\\|/g, '\u0000');
    return normalized.split('|').map((cell) => cell.replace(/\u0000/g, '|').trim());
  }

  function renderTable(lines, startIndex, parent, baseUrl) {
    const headers = splitTableRow(lines[startIndex]);
    const table = document.createElement('table');
    const thead = document.createElement('thead');
    const headerRow = document.createElement('tr');
    for (const header of headers) {
      const cell = document.createElement('th');
      appendInline(cell, header, baseUrl);
      headerRow.append(cell);
    }
    thead.append(headerRow);
    table.append(thead);

    const tbody = document.createElement('tbody');
    let index = startIndex + 2;
    while (index < lines.length && lines[index].trim() && lines[index].includes('|')) {
      const cells = splitTableRow(lines[index]);
      const row = document.createElement('tr');
      for (let column = 0; column < headers.length; column += 1) {
        const cell = document.createElement('td');
        appendInline(cell, cells[column] || '', baseUrl);
        row.append(cell);
      }
      tbody.append(row);
      index += 1;
    }
    table.append(tbody);
    parent.append(table);
    return index;
  }

  function appendInline(parent, text, baseUrl) {
    if (!text) return;
    const expression =
      /!\[([^\]\n]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)|\[([^\]\n]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)|`([^`\n]+)`|\*\*([^*\n]+)\*\*|__([^_\n]+)__|~~([^~\n]+)~~|<(https?:\/\/[^>\s]+)>/g;
    let lastIndex = 0;
    let match;

    while ((match = expression.exec(text)) !== null) {
      if (match.index > lastIndex) {
        parent.append(document.createTextNode(text.slice(lastIndex, match.index)));
      }

      if (match[2] !== undefined) {
        const placeholder = document.createElement('span');
        placeholder.className = 'reader-image-placeholder';
        placeholder.textContent = `[图片${match[1] ? `：${match[1]}` : ''}]`;
        parent.append(placeholder);
      } else if (match[4] !== undefined) {
        const href = toSafeHttpUrl(match[4], baseUrl);
        if (href) {
          const link = document.createElement('a');
          link.href = href.href;
          link.target = '_blank';
          link.rel = 'noopener noreferrer';
          link.referrerPolicy = 'no-referrer';
          appendInline(link, match[3], baseUrl);
          parent.append(link);
        } else {
          parent.append(document.createTextNode(match[0]));
        }
      } else if (match[5] !== undefined) {
        const code = document.createElement('code');
        code.textContent = match[5];
        parent.append(code);
      } else if (match[6] !== undefined || match[7] !== undefined) {
        const strong = document.createElement('strong');
        appendInline(strong, match[6] ?? match[7], baseUrl);
        parent.append(strong);
      } else if (match[8] !== undefined) {
        const strike = document.createElement('del');
        appendInline(strike, match[8], baseUrl);
        parent.append(strike);
      } else if (match[9] !== undefined) {
        const href = toSafeHttpUrl(match[9], baseUrl);
        if (href) {
          const link = document.createElement('a');
          link.href = href.href;
          link.target = '_blank';
          link.rel = 'noopener noreferrer';
          link.referrerPolicy = 'no-referrer';
          link.textContent = match[9];
          parent.append(link);
        } else {
          parent.append(document.createTextNode(match[9]));
        }
      }

      lastIndex = expression.lastIndex;
    }

    if (lastIndex < text.length) {
      parent.append(document.createTextNode(text.slice(lastIndex)));
    }
  }

  /* ---------- Status ---------- */

  async function checkStatus() {
    try {
      const response = await fetch('/api/status', {
        headers: { Accept: 'application/json' },
        cache: 'no-store',
      });
      if (!response.ok) throw new Error('status request failed');
      const data = await response.json();
      if (data.configured) {
        setStatusBadge(true, '本地服务已连接');
        elements.homeKeyWarning.hidden = true;
      } else {
        setStatusBadge(false, '缺少 API Key');
        elements.homeKeyWarning.hidden = false;
      }
    } catch {
      setStatusBadge(null, '本地服务不可用');
      elements.homeKeyWarning.hidden = true;
    }
  }

  /* ---------- Events ---------- */

  function bindEvents() {
    elements.homeForm.addEventListener('submit', (event) => {
      event.preventDefault();
      startSearchFromInput(elements.homeInput, 'all');
    });

    elements.resultsForm.addEventListener('submit', (event) => {
      event.preventDefault();
      startSearchFromInput(elements.resultsInput, state.tab);
    });

    elements.luckyButton.addEventListener('click', async () => {
      const query = elements.homeInput.value.trim();
      if (!query) {
        elements.homeInput.focus();
        showToast('先输入要搜索的关键词。');
        return;
      }

      const originalText = elements.luckyButton.textContent;
      elements.luckyButton.disabled = true;
      elements.luckyButton.textContent = '搜索中…';
      try {
        const outcome = await performSearch(query, { push: true, page: 1, tab: 'all' });
        if (outcome.ok) {
          const firstResult = outcome.results?.[0];
          if (firstResult) {
            window.location.assign(firstResult.url);
            return;
          }
          showToast('这次搜索没有可直接打开的结果。');
        } else if (outcome.error?.code !== 'missing_api_key') {
          showToast('搜索失败，请查看页面上的错误提示。');
        }
      } finally {
        elements.luckyButton.disabled = false;
        elements.luckyButton.textContent = originalText;
      }
    });

    for (const form of document.querySelectorAll('.search-form')) {
      const input = form.querySelector('.search-input');
      const clear = form.querySelector('.clear-button');
      if (!input || !clear) continue;
      input.addEventListener('input', syncClearButtons);
      clear.addEventListener('click', () => {
        input.value = '';
        syncClearButtons();
        input.focus();
      });
    }

    for (const button of document.querySelectorAll('.theme-toggle')) {
      button.addEventListener('click', () => {
        const nextTheme =
          document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
        applyTheme(nextTheme, true);
      });
    }

    for (const tab of elements.tabs) {
      tab.addEventListener('click', () => {
        const nextTab = tab.dataset.tab === 'recent' ? 'recent' : 'all';
        if (nextTab === state.tab) return;
        state.tab = nextTab;
        state.page = 1;
        setActiveTab(nextTab);
        updateUrl({ push: true });
        if (state.hasLoaded) {
          renderResults();
          window.scrollTo({ top: 0, behavior: 'auto' });
        }
      });
    }

    elements.resultsList.addEventListener('click', (event) => {
      const button = event.target.closest('.result-preview-button');
      if (!button) return;
      openReader(button.dataset.url, button.dataset.title || '');
    });

    elements.pagination.addEventListener('click', (event) => {
      const button = event.target.closest('.page-button');
      if (!button || button.disabled) return;
      const nextPage = Number.parseInt(button.dataset.page, 10);
      if (!Number.isSafeInteger(nextPage) || nextPage < 1 || nextPage === state.page) {
        return;
      }
      const totalPages = Math.max(1, Math.ceil(state.total / PAGE_SIZE));
      if (nextPage > totalPages) return;
      state.page = nextPage;
      updateUrl({ push: true });
      renderResults();
      window.scrollTo({ top: 0, behavior: 'auto' });
    });

    elements.errorState
      .querySelector('[data-action="retry"]')
      .addEventListener('click', () => {
        if (!state.query) return;
        performSearch(state.query, {
          push: false,
          page: state.page,
          tab: state.tab,
          force: true,
        });
      });

    elements.keyError
      .querySelector('[data-action="reload"]')
      .addEventListener('click', () => window.location.reload());

    elements.readerClose.addEventListener('click', closeReader);
    elements.readerBackdrop.addEventListener('click', closeReader);
    elements.readerRetry.addEventListener('click', () => {
      if (!elements.readerOpenLink.href) return;
      const title = elements.readerTitle.textContent;
      openReader(elements.readerOpenLink.href, title, { retainFocus: true });
    });

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && state.readerOpen) {
        event.preventDefault();
        closeReader();
        return;
      }
      if (
        event.key === '/' &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey &&
        !state.readerOpen
      ) {
        const target = event.target;
        const typing =
          target instanceof HTMLElement &&
          (target.tagName === 'INPUT' ||
            target.tagName === 'TEXTAREA' ||
            target.isContentEditable);
        if (typing) return;
        event.preventDefault();
        if (elements.resultsView.hidden) {
          elements.homeInput.focus();
          elements.homeInput.select();
        } else {
          elements.resultsInput.focus();
          elements.resultsInput.select();
        }
      }
    });

    window.addEventListener('popstate', handlePopState);
  }

  /* ---------- Start ---------- */

  initTheme();
  bindEvents();
  checkStatus();

  const initialRoute = parseLocation();
  if (initialRoute.query) {
    performSearch(initialRoute.query, {
      push: false,
      page: initialRoute.page,
      tab: initialRoute.tab,
    });
  } else {
    showHomeView();
    syncInputs();
  }
})();
