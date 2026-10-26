const state = {
  csrf: '',
  status: null,
  view: 'overview',
  modal: null,
  auditEvents: null,
};

const VIEW_META = {
  overview: { eyebrow: 'OVERVIEW', title: '安全舱' },
  secrets: { eyebrow: 'SECRETS', title: '密钥' },
  mcp: { eyebrow: 'MCP', title: '连接器' },
  activity: { eyebrow: 'ACTIVITY', title: '活动' },
  settings: { eyebrow: 'SETTINGS', title: '设置' },
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

function showToast(message, bad = false) {
  const toast = $('#toast');
  toast.textContent = message;
  toast.classList.toggle('bad', bad);
  toast.classList.add('show');
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove('show'), 3200);
}

async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.method && options.method !== 'GET') {
    headers['content-type'] = 'application/json';
    headers['x-cove-csrf'] = state.csrf;
  }
  const response = await fetch(path, { ...options, headers });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || `HTTP ${response.status}`);
    error.status = response.status;
    error.data = data;
    throw error;
  }
  return data;
}

async function refresh() {
  try {
    const status = await api('/api/status');
    state.csrf = status.csrf;
    state.status = status;
    renderAll();
  } catch (error) {
    showToast(`无法连接本地服务：${error.message}`, true);
  }
}

function renderAll() {
  if (!state.status) return;
  renderTopStatus();
  renderOverview();
  renderSecrets();
  renderMcp();
  renderActivity();
  renderSettings();
}

function renderTopStatus() {
  const status = state.status;
  const node = $('#top-status');
  clear(node);
  const dot = el('span', 'dot');
  const parts = [];
  if (status.docker.ok) {
    dot.classList.add('good');
    parts.push(`Docker ${status.docker.version}`);
  } else {
    dot.classList.add('bad');
    parts.push('Docker 离线');
  }
  if (!status.ca.ok) {
    dot.className = 'dot bad';
    parts.push('CA 未初始化');
  }
  node.append(dot, el('span', '', parts.join(' · ')));
}

function stat(label, value, note, tone = '') {
  const node = el('div', `stat ${tone}`);
  const top = el('div', 'stat-top');
  top.append(el('span', 'stat-label', label), el('span', 'stat-note', tone === 'bad' ? '需要处理' : ''));
  node.append(top, el('div', 'stat-value', value), el('div', 'stat-note', note));
  return node;
}

function renderOverview() {
  const status = state.status;
  const images = status.images.broker && status.images.sandbox;
  const stats = $('#stats');
  clear(stats);
  stats.append(
    stat('Docker', status.docker.ok ? status.docker.version : '离线', status.docker.ok ? 'Linux containers' : '启动 Docker Desktop', status.docker.ok ? 'good' : 'bad'),
    stat('保险箱', `${status.vault.count} 个密钥`, 'Windows DPAPI · 仅宿主', 'good'),
    stat('出网策略', '默认拒绝', 'Docker internal + broker', 'good'),
    stat('镜像', images ? '就绪' : '缺失', images ? 'broker · sandbox' : '运行 cove build', images ? 'good' : 'warn'),
  );

  const note = $('#setup-note');
  if (!status.initialized) {
    note.textContent = '首次使用：运行 cove setup，然后保存一个密钥。';
  } else if (!images) {
    note.innerHTML = '';
    note.append(document.createTextNode('运行时镜像缺失：运行 '));
    const code = el('code', '', 'cove build');
    note.append(code, document.createTextNode('。'));
  } else {
    note.textContent = '已初始化。进入项目目录运行 cove run claude，或先接入 MCP。';
  }

  renderSteps();
  renderSessions();
  renderMiniActivity();
}

function renderSteps() {
  const status = state.status;
  const steps = $('#quick-steps');
  clear(steps);
  const hasSecret = status.vault.count > 0;
  const items = [
    {
      title: hasSecret ? '密钥已就绪' : '保存模型密钥',
      detail: '输入不回显；只保存在宿主机',
      command: 'cove secret set anthropic',
      done: hasSecret,
    },
    {
      title: '启动 Agent',
      detail: '在项目目录运行，自动创建沙箱',
      command: 'cove run claude',
      done: false,
    },
    {
      title: '接入 MCP',
      detail: 'Token 留在宿主，配置里只有占位符',
      command: 'cove mcp add github',
      done: status.mcp.servers.some((server) => server.enabled),
    },
  ];
  for (const [index, item] of items.entries()) {
    const row = el('div', 'step');
    row.append(el('span', 'step-index', String(index + 1).padStart(2, '0')));
    const body = el('div', 'step-body');
    body.append(el('strong', '', item.title), el('span', '', item.detail));
    const command = el('code', '', item.command);
    const copy = el('button', 'copy', '复制');
    copy.addEventListener('click', () => copyText(item.command));
    const right = el('div');
    right.append(command, copy);
    row.append(body, right);
    steps.append(row);
  }
}

function renderSessions() {
  const box = $('#sessions');
  clear(box);
  if (state.status.sessions.length === 0) {
    box.append(el('div', 'empty', '还没有会话。运行 cove run claude 开始。'));
    return;
  }
  const list = el('div', 'sessions');
  for (const session of state.status.sessions) {
    const row = el('div', 'session-row');
    row.append(el('span', 'session-id', session.id.slice(0, 8)));
    const project = el('span', 'session-project', session.project);
    const stateBadge = el('span', `state ${session.state}`, session.state);
    row.append(project, stateBadge);
    list.append(row);
  }
  box.append(list);
}

function renderMiniActivity() {
  const box = $('#activity-mini');
  clear(box);
  const events = state.status.audit.filter((event) => event.kind === 'http').slice(-5).reverse();
  if (events.length === 0) {
    box.append(el('div', 'empty', '会话产生出网请求后，这里会出现脱敏记录。'));
    return;
  }
  for (const event of events) {
    const row = el('div', 'activity-row');
    row.append(el('span', 'time', timeOf(event.ts)));
    row.append(el('span', 'host', `${event.method} ${event.host}`));
    row.append(actionPill(event.action));
    box.append(row);
  }
}

function renderSecrets() {
  const grid = $('#secret-grid');
  clear(grid);
  const providers = state.status.providers || [];
  const saved = new Map(state.status.secrets.map((secret) => [secret.id, secret]));
  const ids = new Set([...providers.map((provider) => provider.id), ...saved.keys()]);
  for (const id of ids) {
    const provider = providers.find((item) => item.id === id);
    const secret = saved.get(id);
    const configured = secret !== undefined;
    const card = el('div', `secret-card ${configured ? 'configured' : ''}`);
    const top = el('div', 'card-top');
    const heading = el('div');
    heading.append(el('div', 'card-title', provider?.label || secret?.label || id));
    heading.append(el('div', 'card-id', id));
    top.append(heading, el('span', configured ? 'badge on' : 'badge off', configured ? '已保存' : '未保存'));
    card.append(top);
    const hosts = secret?.hosts || provider?.hosts || [];
    card.append(el('div', 'host-list', hosts.length > 0 ? hosts.join(' · ') : '自定义主机'));
    const actions = el('div', 'card-actions');
    if (provider?.helpUrl) {
      const link = el('a', 'text-button', '获取密钥');
      link.href = provider.helpUrl;
      link.target = '_blank';
      link.rel = 'noreferrer';
      actions.append(link);
    }
    const edit = el('button', 'ghost', configured ? '更新' : '保存');
    edit.addEventListener('click', () => openSecretModal(provider || { id, label: secret?.label || id, hosts }));
    actions.append(edit);
    if (configured) {
      const remove = el('button', 'ghost danger', '移除');
      remove.addEventListener('click', async () => {
        if (!confirm(`移除密钥 ${id}？已启用且依赖它的 MCP 将无法运行。`)) return;
        await api(`/api/secrets/${encodeURIComponent(id)}`, { method: 'DELETE' });
        showToast(`已移除 ${id}`);
        await refresh();
      });
      actions.append(remove);
    }
    card.append(actions);
    grid.append(card);
  }
}

function renderMcp() {
  const grid = $('#mcp-grid');
  clear(grid);
  for (const server of state.status.mcp.servers) {
    const card = el('div', 'mcp-card');
    const top = el('div', 'card-top');
    const heading = el('div');
    heading.append(el('div', 'card-title', server.title), el('div', 'card-id', `${server.id} · ${server.transport}`));
    top.append(heading, el('span', `badge ${server.risk === 'write' ? 'write' : 'read'}`, server.risk === 'write' ? '写' : '读'));
    card.append(top, el('div', 'card-desc', server.description));
    const meta = el('div', 'card-meta');
    meta.append(el('span', `badge ${server.enabled ? 'on' : 'off'}`, server.enabled ? '已接入' : '未接入'));
    if (server.secret) {
      meta.append(el('span', `badge ${server.secret.configured ? 'on' : 'off'}`, server.secret.configured ? 'Token 已保存' : '需要 Token'));
    } else {
      meta.append(el('span', 'badge on', '无需密钥'));
    }
    card.append(meta);
    const actions = el('div', 'card-actions');
    if (server.enabled) {
      const remove = el('button', 'ghost danger', '断开');
      remove.addEventListener('click', async () => {
        await api(`/api/mcp/${encodeURIComponent(server.id)}`, { method: 'DELETE' });
        showToast(`已断开 ${server.title}`);
        await refresh();
      });
      actions.append(remove);
    } else {
      const add = el('button', 'primary', '接入');
      add.addEventListener('click', () => connectMcp(server));
      actions.append(add);
    }
    if (server.secret?.helpUrl) {
      const link = el('a', 'text-button', '获取 Token');
      link.href = server.secret.helpUrl;
      link.target = '_blank';
      link.rel = 'noreferrer';
      actions.append(link);
    }
    card.append(actions);
    grid.append(card);
  }
}

async function connectMcp(server) {
  try {
    await api('/api/mcp', { method: 'POST', body: JSON.stringify({ preset: server.id }) });
    showToast(`${server.title} 已接入`);
    await refresh();
  } catch (error) {
    if (error.status === 409 && error.data?.needsSecret) {
      openMcpSecretModal(server, error.data);
      return;
    }
    showToast(error.message, true);
  }
}

function openMcpSecretModal(server, info) {
  state.modal = { mode: 'mcp', preset: server.id, secretId: info.secretId, label: info.label, helpUrl: info.helpUrl };
  $('#modal-eyebrow').textContent = 'MCP TOKEN';
  $('#modal-title').textContent = `连接 ${server.title}`;
  $('#field-id').hidden = true;
  $('#field-label').hidden = true;
  $('#field-hosts').hidden = true;
  $('#secret-value').value = '';
  $('#secret-value').placeholder = info.label || 'Token';
  const help = $('#secret-help');
  clear(help);
  if (info.helpUrl) {
    const link = el('a', '', '在哪里获取 Token？');
    link.href = info.helpUrl;
    link.target = '_blank';
    link.rel = 'noreferrer';
    help.append(link);
  } else {
    help.textContent = 'Token 只会保存在宿主机保险箱。';
  }
  $('#modal-backdrop').hidden = false;
  $('#modal-submit').textContent = '保存并接入';
  setTimeout(() => $('#secret-value').focus(), 50);
}

function openSecretModal(provider) {
  state.modal = { mode: 'secret', id: provider.id };
  $('#modal-eyebrow').textContent = 'SECRET';
  $('#modal-title').textContent = provider.id ? `保存 ${provider.id}` : '添加密钥';
  $('#field-id').hidden = false;
  $('#field-label').hidden = false;
  $('#field-hosts').hidden = false;
  $('#secret-id').value = provider.id || '';
  $('#secret-id').disabled = Boolean(provider.id);
  $('#secret-label').value = provider.label || '';
  $('#secret-hosts').value = (provider.hosts || []).join(', ');
  $('#secret-value').value = '';
  $('#secret-help').textContent = provider.helpUrl ? '保存后不会回显。' : '真实值不会进入沙箱；自定义密钥必须声明允许主机。';
  $('#modal-backdrop').hidden = false;
  $('#modal-submit').textContent = '保存';
  setTimeout(() => $('#secret-value').focus(), 50);
}

function closeModal() {
  $('#modal-backdrop').hidden = true;
  state.modal = null;
  $('#secret-value').value = '';
}

async function submitModal(event) {
  event.preventDefault();
  const value = $('#secret-value').value;
  if (!value) {
    showToast('请输入密钥值', true);
    return;
  }
  try {
    if (state.modal?.mode === 'mcp') {
      await api('/api/mcp', {
        method: 'POST',
        body: JSON.stringify({ preset: state.modal.preset, secretValue: value }),
      });
      showToast('MCP 已接入');
    } else {
      const id = state.modal?.id || $('#secret-id').value.trim();
      const hosts = $('#secret-hosts').value.split(',').map((host) => host.trim()).filter(Boolean);
      await api('/api/secrets', {
        method: 'POST',
        body: JSON.stringify({ id, label: $('#secret-label').value.trim() || id, hosts, value }),
      });
      showToast(`已保存 ${id}`);
    }
    closeModal();
    await refresh();
  } catch (error) {
    showToast(error.message, true);
  }
}

function renderActivity() {
  const box = $('#audit-table');
  clear(box);
  const events = [...(state.auditEvents ?? state.status.audit)].reverse();
  if (events.length === 0) {
    box.append(el('div', 'empty', '还没有审计记录。'));
    return;
  }
  const table = el('table');
  const head = el('thead');
  const headRow = el('tr');
  for (const label of ['时间', '动作', '主机', '方法', '路径', '状态', '凭据', '耗时']) {
    headRow.append(el('th', '', label));
  }
  head.append(headRow);
  const body = el('tbody');
  for (const event of events) {
    const row = el('tr');
    row.append(el('td', 'mono', timeOf(event.ts)));
    const action = el('td');
    action.append(actionPill(event.action));
    row.append(action);
    row.append(el('td', 'mono', event.host || '—'));
    row.append(el('td', 'mono', event.method || '—'));
    row.append(el('td', 'mono', event.path || '—'));
    row.append(el('td', 'mono', String(event.status || '—')));
    row.append(el('td', 'mono', event.credential || '—'));
    row.append(el('td', 'mono', `${event.ms}ms`));
    if (event.reason) row.title = event.reason;
    body.append(row);
  }
  table.append(head, body);
  box.append(table);
}

function renderSettings() {
  const paths = $('#settings-paths');
  clear(paths);
  for (const [label, value] of Object.entries(state.status.paths || {})) {
    const row = el('div');
    row.append(el('dt', '', label), el('dd', '', value));
    paths.append(row);
  }
  const images = $('#settings-images');
  clear(images);
  for (const [label, value] of Object.entries(state.status.images || {})) {
    const row = el('div');
    row.append(el('dt', '', label), el('dd', '', value ? '已就绪' : '缺失'));
    images.append(row);
  }
}

function actionPill(action) {
  return el('span', `status-pill ${action}`, action === 'allow' ? '允许' : action === 'deny' ? '拒绝' : '错误');
}

function timeOf(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString('zh-CN', { hour12: false });
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    showToast('已复制');
  } catch {
    showToast('无法访问剪贴板', true);
  }
}

function navigate(view) {
  state.view = view;
  for (const item of $$('.nav-item')) item.classList.toggle('is-active', item.dataset.view === view);
  for (const section of $$('.view')) section.classList.toggle('is-active', section.dataset.section === view);
  const meta = VIEW_META[view];
  $('#view-eyebrow').textContent = meta.eyebrow;
  $('#view-title').textContent = meta.title;
  if (view === 'activity') void loadAudit();
  if (view === 'secrets' || view === 'mcp') void refresh();
}

async function loadAudit() {
  try {
    const data = await api('/api/audit?limit=200');
    state.auditEvents = data.events;
    renderActivity();
  } catch (error) {
    showToast(error.message, true);
  }
}

function bind() {
  for (const item of $$('.nav-item')) {
    item.addEventListener('click', () => navigate(item.dataset.view));
  }
  for (const trigger of $$('[data-goto]')) {
    trigger.addEventListener('click', () => navigate(trigger.dataset.goto));
  }
  $('#refresh-button').addEventListener('click', () => refresh());
  $('#refresh-audit').addEventListener('click', () => loadAudit());
  $('#modal-close').addEventListener('click', closeModal);
  $('#modal-cancel').addEventListener('click', closeModal);
  $('#modal-form').addEventListener('submit', submitModal);
  $('#modal-backdrop').addEventListener('click', (event) => {
    if (event.target === $('#modal-backdrop')) closeModal();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !$('#modal-backdrop').hidden) closeModal();
  });
  $('#add-custom-secret').addEventListener('click', () => openSecretModal({ id: '', label: '', hosts: [] }));
  $('#quick-setup').addEventListener('click', async () => {
    try {
      await api('/api/setup', { method: 'POST', body: '{}' });
      showToast('初始化完成；如镜像缺失请运行 cove build');
      await refresh();
    } catch (error) {
      showToast(error.message, true);
    }
  });
  setInterval(() => {
    if (document.visibilityState === 'visible') refresh();
  }, 8000);
}

bind();
refresh();
