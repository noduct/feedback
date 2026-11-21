// Automatic triage for noduct/feedback.
//
// Security model: issue titles and bodies are untrusted data. This file only reads them as
// strings from the event payload; it never builds shell commands, never downloads attachments and
// never echoes issue content back in comments. The workflow grants `issues: write` and nothing else.

export const MARKER = 'noduct-triage';
export const NEW_ACCOUNT_DAYS = 7;
export const BURST_WINDOW_HOURS = 24;
export const BURST_LIMIT = 3;
export const MIN_DESCRIPTION_LENGTH = 20;

const TRUSTED_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);
const ALLOWED_ATTACHMENT_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'mp4', 'mov', 'webm', 'txt', 'log'
]);
const RISKY_EXTENSIONS = new Set([
  'zip', 'rar', '7z', 'gz', 'tar', 'html', 'htm', 'svg', 'js', 'mjs', 'exe', 'msi', 'bat', 'cmd',
  'ps1', 'sh', 'scr', 'jar', 'apk', 'dmg', 'pkg', 'iso', 'docm', 'xlsm', 'pdf'
]);

/** Required sections per form, keyed by the label the form applies. */
const REQUIRED_SECTIONS = {
  bug: ['What happened?', 'Steps to reproduce', 'What did you expect?'],
  improvement: ['What would you like to change?'],
  'tool-request': ['What do you need to do?']
};

const CONFIRMATION = /^- \[[xX]\] I did not attach my documents/m;

/** Splits an issue-form body into `{ heading: text }`; empty answers become `''`. */
export function parseSections(body) {
  const sections = {};
  const parts = String(body ?? '').split(/^### /m).slice(1);
  for (const part of parts) {
    const newline = part.indexOf('\n');
    const heading = (newline === -1 ? part : part.slice(0, newline)).trim();
    const text = (newline === -1 ? '' : part.slice(newline + 1)).trim();
    sections[heading] = text === '_No response_' ? '' : text;
  }
  return sections;
}

/** Returns the file extensions of linked files that are not allowed as attachments. */
export function riskyAttachments(body) {
  const found = new Set();
  for (const match of String(body ?? '').matchAll(/https?:\/\/[^\s)<>"']+/g)) {
    let url;
    try {
      url = new URL(match[0]);
    } catch {
      continue;
    }
    const last = url.pathname.split('/').pop() ?? '';
    const dot = last.lastIndexOf('.');
    if (dot === -1) continue;
    const ext = last.slice(dot + 1).toLowerCase();
    const isUpload = url.hostname === 'github.com' && url.pathname.startsWith('/user-attachments/files/');
    if (RISKY_EXTENSIONS.has(ext) || (isUpload && !ALLOWED_ATTACHMENT_EXTENSIONS.has(ext))) {
      found.add(ext);
    }
  }
  return [...found].sort();
}

/**
 * Decides what to do with an issue. Pure: all inputs are plain data.
 *
 * @param {object} input
 * @param {{ body: string, labels: string[], state: string, authorAssociation: string }} input.issue
 * @param {string} input.authorCreatedAt ISO date of the author's account.
 * @param {number} input.recentIssueCount Issues by the same author in the burst window, this one included.
 * @param {string[]} input.previousReasons Reasons already handled in earlier runs (from markers).
 * @param {Date} input.now
 * @returns {{ addLabels: string[], close: boolean, reopen: boolean, comments: { reason: string, text: string }[] }}
 */
export function evaluate({ issue, authorCreatedAt, recentIssueCount, previousReasons = [], now }) {
  const result = { addLabels: [], close: false, reopen: false, comments: [] };
  if (TRUSTED_ASSOCIATIONS.has(issue.authorAssociation)) return result;

  const handled = new Set(previousReasons);
  const labels = new Set();
  const comment = (reason) => {
    if (!handled.has(reason)) result.comments.push({ reason, text: COMMENTS[reason] });
  };

  const confirmed = CONFIRMATION.test(issue.body ?? '');
  if (!confirmed) {
    if (issue.state === 'open') result.close = true;
    comment('missing-confirmation');
  } else if (issue.state === 'closed' && handled.has('missing-confirmation')) {
    result.reopen = true;
  }

  const form = Object.keys(REQUIRED_SECTIONS).find((label) => issue.labels.includes(label));
  if (form) {
    const sections = parseSections(issue.body);
    const required = REQUIRED_SECTIONS[form];
    const missing = required.some((heading) => !sections[heading]);
    const tooShort = (sections[required[0]] ?? '').length < MIN_DESCRIPTION_LENGTH;
    if (missing || tooShort) labels.add('needs-triage');
  } else {
    // Created without a form (API or old link): a person needs to look at it.
    labels.add('needs-triage');
  }

  const ageMs = now.getTime() - new Date(authorCreatedAt).getTime();
  const newAccount = ageMs < NEW_ACCOUNT_DAYS * 24 * 60 * 60 * 1000;
  if (newAccount || recentIssueCount > BURST_LIMIT) {
    labels.add('needs-triage');
    labels.add('possible-spam');
  }

  if (riskyAttachments(issue.body).length > 0) {
    labels.add('unsafe-attachment');
    comment('unsafe-attachment');
  }

  result.addLabels = [...labels].filter((label) => !issue.labels.includes(label)).sort();
  return result;
}

const COMMENTS = {
  'missing-confirmation': [
    'Thanks for writing in. This issue was closed automatically because the privacy confirmation was not ticked.',
    'Please **edit the issue**, make sure no documents or personal information are attached, and tick the box at the end. It will reopen on its own.',
    '',
    '**pt-BR:** a issue foi fechada porque a confirmação de privacidade não foi marcada. Edite a issue, confira que nada pessoal foi anexado e marque a caixa no fim. Ela reabre sozinha.',
    '',
    '**es:** el issue se cerró porque no se marcó la confirmación de privacidad. Edita el issue, comprueba que no adjuntaste nada personal y marca la casilla del final. Se volverá a abrir solo.'
  ].join('\n'),
  'unsafe-attachment': [
    'This issue links a file type we don\'t accept for safety reasons. Only images, videos and plain-text logs are allowed.',
    'Please **edit the issue to remove that file**. It will be reviewed without being opened.',
    '',
    '**pt-BR:** a issue tem um arquivo de um tipo que não aceitamos por segurança. Edite e remova o arquivo; só imagens, vídeos e logs em texto são aceitos.',
    '',
    '**es:** el issue enlaza un tipo de archivo que no aceptamos por seguridad. Edita el issue y quita el archivo; solo se aceptan imágenes, videos y registros de texto.'
  ].join('\n')
};

const markerFor = (reason) => `<!-- ${MARKER}:${reason} -->`;

/** Entry point for actions/github-script. */
export async function run({ github, context, now = new Date() }) {
  const { owner, repo } = context.repo;
  const payload = context.payload.issue;
  const issue_number = payload.number;

  const issue = {
    body: payload.body ?? '',
    labels: (payload.labels ?? []).map((label) => label.name),
    state: payload.state,
    authorAssociation: payload.author_association
  };
  if (TRUSTED_ASSOCIATIONS.has(issue.authorAssociation)) return;

  const login = payload.user.login;
  const { data: author } = await github.rest.users.getByUsername({ username: login });
  const since = new Date(now.getTime() - BURST_WINDOW_HOURS * 60 * 60 * 1000);
  const recent = await github.paginate(github.rest.issues.listForRepo, {
    owner, repo, creator: login, state: 'all', since: since.toISOString(), per_page: 100
  });
  const recentIssueCount = recent.filter(
    (item) => !item.pull_request && new Date(item.created_at) >= since
  ).length;

  const existing = await github.paginate(github.rest.issues.listComments, {
    owner, repo, issue_number, per_page: 100
  });
  const previousReasons = existing
    .filter((c) => c.user?.type === 'Bot')
    .flatMap((c) => [...String(c.body).matchAll(new RegExp(`<!-- ${MARKER}:([a-z-]+) -->`, 'g'))])
    .map((m) => m[1]);

  const decision = evaluate({
    issue, authorCreatedAt: author.created_at, recentIssueCount, previousReasons, now
  });

  if (decision.addLabels.length > 0) {
    await github.rest.issues.addLabels({ owner, repo, issue_number, labels: decision.addLabels });
  }
  for (const { reason, text } of decision.comments) {
    await github.rest.issues.createComment({
      owner, repo, issue_number, body: `${text}\n\n${markerFor(reason)}`
    });
  }
  if (decision.close) {
    await github.rest.issues.update({
      owner, repo, issue_number, state: 'closed', state_reason: 'not_planned'
    });
  } else if (decision.reopen) {
    await github.rest.issues.update({ owner, repo, issue_number, state: 'open' });
  }
}
