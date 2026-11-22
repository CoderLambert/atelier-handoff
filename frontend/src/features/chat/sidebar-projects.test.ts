import assert from 'node:assert/strict';
import test from 'node:test';
import type { Project, Session } from '@shared/types';
import {
  buildProjectSessionGroups,
  findSessionPath,
  paginateSessionTree,
} from '@/app/session-tree';

function project(id: string, name: string): Project {
  return {
    id,
    name,
    path: `/tmp/${id}`,
    branch: 'main',
    available: true,
    createdAt: '2026-11-01T00:00:00Z',
  };
}
function session(id: string, projectId: string, updatedAt: string, parent?: string): Session {
  return {
    id,
    projectId,
    title: id,
    status: 'active',
    sdkSessionId: null,
    createdAt: updatedAt,
    updatedAt,
    draft: { text: '', mode: 'readonly', contextPaths: [], attachmentIds: [] },
    ...(parent
      ? { fork: { sourceSessionId: parent, sourceMessageId: 'origin', sourceTitle: parent } }
      : {}),
  };
}
const projects = [project('a', 'Alpha'), project('b', 'Beta'), project('empty', 'Empty')];
const sessions = [
  session('source', 'a', '2026-11-10'),
  session('needle branch', 'a', '2026-11-22', 'source'),
  session('separate', 'b', '2026-11-20', 'source'),
  { ...session('archive', 'b', '2026-11-19'), status: 'archived' as const },
  session('orphan', 'missing', '2026-11-18'),
];

test('projects contain only their own full trees, sorted by newest descendant activity', () => {
  const groups = buildProjectSessionGroups(sessions, projects, '');
  assert.deepEqual(
    groups.map((group) => group.projectId),
    ['a', 'b', 'missing', 'empty'],
  );
  assert.deepEqual(
    groups[0]?.nodes.map((node) => node.session.id),
    ['source'],
  );
  assert.deepEqual(findSessionPath(groups[1]?.nodes ?? [], 'separate'), ['separate']);
  assert.equal(groups[0]?.sessionCount, 2);
  assert.equal(groups[1]?.archivedCount, 1);
  assert.equal(groups[2]?.project, undefined);
  assert.equal(groups[2]?.nodes[0]?.session.id, 'orphan');
  assert.deepEqual(groups[3]?.nodes, []);
});

test('session search retains its project and source ancestry without mixing projects', () => {
  const groups = buildProjectSessionGroups(sessions, projects, ' NEEDLE ');
  assert.deepEqual(
    groups.map((group) => group.projectId),
    ['a'],
  );
  assert.deepEqual(findSessionPath(groups[0]?.nodes ?? [], 'needle branch'), [
    'source',
    'needle branch',
  ]);
  assert.equal(buildProjectSessionGroups(sessions, projects, 'unmatched').length, 0);
});

test('project-name search shows the complete project and archived sessions remain searchable', () => {
  const beta = buildProjectSessionGroups(sessions, projects, 'beta');
  assert.deepEqual(
    beta.map((group) => group.projectId),
    ['b'],
  );
  assert.deepEqual(
    beta[0]?.nodes.map((node) => node.session.id),
    ['separate', 'archive'],
  );
  const archive = buildProjectSessionGroups(sessions, projects, 'archive');
  assert.equal(archive[0]?.nodes[0]?.session.status, 'archived');
});

test('searching a rewind history keeps the newest head and its prior version reachable', () => {
  const source = session('earlier draft', 'a', '2026-11-10');
  const head: Session = {
    ...session('rewound', 'a', '2026-11-22'),
    fork: {
      sourceSessionId: source.id,
      sourceMessageId: 'origin',
      sourceTitle: source.title,
      kind: 'rewind',
    },
  };
  const groups = buildProjectSessionGroups([source, head], projects, 'earlier');
  assert.deepEqual(findSessionPath(groups[0]?.nodes ?? [], source.id), [head.id, source.id]);
  assert.equal(groups[0]?.nodes[0]?.children[0]?.priorVersion, true);
});

test('pagination keeps complete root groups and follows a newly selected descendant', () => {
  const roots = Array.from({ length: 52 }, (_, i) =>
    session(`root-${String(i).padStart(2, '0')}`, 'a', '2026-11-10'),
  );
  const child = session('last child', 'a', '2026-11-10', 'root-51');
  const nodes = buildProjectSessionGroups([...roots, child], projects, '')[0]?.nodes ?? [];
  const selected = paginateSessionTree(nodes, child.id, '');
  assert.equal(selected.page, 1);
  assert.deepEqual(findSessionPath(selected.nodes, child.id), ['root-51', child.id]);
  assert.equal(
    paginateSessionTree(nodes, child.id, '', { filter: '', selected: 'root-00', page: 0 }).page,
    1,
  );
  assert.equal(
    paginateSessionTree(nodes, child.id, '', { filter: '', selected: child.id, page: 0 }).page,
    0,
  );
  assert.equal(
    paginateSessionTree(nodes, child.id, 'changed', { filter: '', selected: child.id, page: 1 })
      .page,
    0,
  );
  assert.equal(
    paginateSessionTree(nodes.slice(0, 2), child.id, '', {
      filter: '',
      selected: child.id,
      page: 1,
    }).page,
    0,
  );
});
