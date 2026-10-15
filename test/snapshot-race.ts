// Regression test: a push to the target branch between release-please's first
// file read and the release commit's parent lookup produces a release commit
// whose file text and parent come from different commits.
//
// The fixture models one moving branch. The commits before and after the push
// are immutable objects addressed by SHA. `main` points at the commit before
// the push until the first tree read by branch name has been served, then at
// the commit after the push. Every write is captured and the
// relationship between them is asserted after the call completes.

import * as nock from 'nock';
import {expect} from 'chai';
import {afterEach, beforeEach, describe, it} from 'mocha';
import {GitHub} from '../src/github';
import {Update} from '../src/update';
const fetch = require('node-fetch');

nock.disableNetConnect();

const HEAD_BRANCH = 'release-please--branches--main';
const PATH = 'charts/app/values.yaml';

// The push adds the extraConfig block.
const TEXT_BEFORE = 'image:\n  tag: 0.13.1\n';
const TEXT_AFTER =
  'image:\n  tag: 0.13.1\nextraConfig:\n  enabled: true\n';

interface Repo {
  mainSha: string;
  commits: Record<string, {tree: string}>;
  trees: Record<string, {path: string; sha: string}[]>;
  blobs: Record<string, string>;
}

function freshRepo(): Repo {
  return {
    mainSha: 'before',
    commits: {before: {tree: 'tree-before'}, after: {tree: 'tree-after'}},
    trees: {
      'tree-before': [{path: PATH, sha: 'blob-before'}],
      'tree-after': [{path: PATH, sha: 'blob-after'}],
    },
    blobs: {'blob-before': TEXT_BEFORE, 'blob-after': TEXT_AFTER},
  };
}

function treeReply(repo: Repo, treeSha: string) {
  return {
    sha: treeSha,
    truncated: false,
    tree: repo.trees[treeSha].map(e => ({
      ...e,
      mode: '100644',
      type: 'blob',
      size: repo.blobs[e.sha].length,
    })),
  };
}

function blobReply(repo: Repo, blobSha: string) {
  const content = repo.blobs[blobSha];
  return {
    sha: blobSha,
    size: content.length,
    encoding: 'base64',
    content: Buffer.from(content, 'utf8').toString('base64'),
  };
}

interface Writes {
  tree?: {base_tree: string; tree: {path: string; content: string}[]};
  commit?: {parents: string[]; tree: string};
}

// Wires every request the creation path can make. Branch-name lookups answer
// from repo.mainSha. SHA lookups answer from immutable objects. `afterFirst
// TreeByName` advances main: the push lands right after the snapshot.
function wire(repo: Repo, writes: Writes, moveMainAfterSnapshot: boolean) {
  const api = nock('https://api.github.com');
  // The push lands right after the first tree read, by branch name or by SHA.
  // A fix that pins only the file reads still sees main move before the
  // parent lookup.
  let snapshotTaken = () => {
    if (moveMainAfterSnapshot) repo.mainSha = 'after';
    snapshotTaken = () => {};
  };
  api.get('/repos/fake/fake').optionally().reply(200, {default_branch: 'main'});

  // git-file-utils: tree by branch name (today's path) and by SHA (fixed path)
  api
    .get('/repos/fake/fake/git/trees/main')
    .query(true)
    .optionally()
    .reply(200, () => {
      const reply = treeReply(repo, repo.commits[repo.mainSha].tree);
      snapshotTaken();
      return reply;
    });
  api
    .get(
      /\/repos\/fake\/fake\/git\/trees\/(before|after|tree-before|tree-after)$/
    )
    .query(true)
    .optionally()
    .times(4)
    .reply(200, uri => {
      const key = uri.split('/').pop()!.split('?')[0];
      const treeSha = repo.commits[key]?.tree ?? key;
      const reply = treeReply(repo, treeSha);
      snapshotTaken();
      return reply;
    });
  api
    .get(/\/repos\/fake\/fake\/git\/blobs\/(blob-before|blob-after)$/)
    .optionally()
    .times(4)
    .reply(200, uri => blobReply(repo, uri.split('/').pop()!));

  // branch resolution, both spellings
  api
    .get('/repos/fake/fake/branches/main')
    .optionally()
    .times(4)
    .reply(200, () => ({name: 'main', commit: {sha: repo.mainSha}}));
  api
    .get('/repos/fake/fake/git/ref/heads%2Fmain')
    .optionally()
    .times(4)
    .reply(200, () => ({
      ref: 'refs/heads/main',
      object: {sha: repo.mainSha, type: 'commit'},
    }));

  // release branch does not exist yet
  api
    .get(`/repos/fake/fake/git/ref/heads%2F${HEAD_BRANCH}`)
    .reply(404, {message: 'Not Found'});
  api.post('/repos/fake/fake/git/refs').reply(201, (_uri, body: any) => ({
    ref: body.ref,
    object: {sha: body.sha},
  }));

  // code-suggester: commit → tree sha, then the writes
  api
    .get(/\/repos\/fake\/fake\/git\/commits\/(before|after)$/)
    .optionally()
    .times(4)
    .reply(200, uri => {
      const sha = uri.split('/').pop()!;
      return {sha, tree: {sha: repo.commits[sha].tree}};
    });
  api.post('/repos/fake/fake/git/trees').reply(201, (_uri, body: any) => {
    writes.tree = body;
    return {sha: 'treeGen'};
  });
  api.post('/repos/fake/fake/git/commits').reply(201, (_uri, body: any) => {
    writes.commit = body;
    return {
      sha: 'C',
      url: 'https://api.github.com/repos/fake/fake/git/commits/C',
    };
  });
  api
    .patch(`/repos/fake/fake/git/refs/heads%2F${HEAD_BRANCH}`)
    .reply(200, {object: {sha: 'C'}});

  // open the PR, then release-please fetches it back
  api.get('/repos/fake/fake/pulls').query(true).reply(200, []);
  api.post('/repos/fake/fake/pulls').reply(201, {
    number: 22,
    url: 'https://api.github.com/repos/fake/fake/pulls/22',
  });
  api.get('/repos/fake/fake/pulls/22').reply(200, {
    number: 22,
    title: 'chore: release main',
    body: '',
    head: {ref: HEAD_BRANCH},
    base: {ref: 'main'},
    labels: [],
  });
  return api;
}

const bumpTag: Update = {
  path: PATH,
  createIfMissing: false,
  updater: {
    updateContent: (content?: string) =>
      content!.replace('tag: 0.13.1', 'tag: 0.14.0'),
  },
};

async function createReleasePullRequest(github: GitHub) {
  return github.createPullRequest(
    {
      title: 'chore: release main',
      headBranchName: HEAD_BRANCH,
      baseBranchName: 'main',
      number: 0,
      body: '',
      labels: [],
      files: [],
    },
    'main',
    'chore: release main',
    [bumpTag]
  );
}

// Which commit's file text the uploaded values.yaml came from.
function fileSource(writes: Writes): 'before' | 'after' | 'unknown' {
  const entry = writes.tree!.tree.find(e => e.path === PATH)!;
  if (entry.content === TEXT_BEFORE.replace('0.13.1', '0.14.0'))
    return 'before';
  if (entry.content === TEXT_AFTER.replace('0.13.1', '0.14.0')) return 'after';
  return 'unknown';
}

function treeBase(writes: Writes): 'before' | 'after' | 'unknown' {
  return writes.tree!.base_tree === 'tree-before'
    ? 'before'
    : writes.tree!.base_tree === 'tree-after'
    ? 'after'
    : 'unknown';
}

describe('snapshot race', () => {
  let github: GitHub;
  beforeEach(async () => {
    github = await GitHub.create({
      owner: 'fake',
      repo: 'fake',
      defaultBranch: 'main',
      fetch,
    });
  });
  afterEach(() => nock.cleanAll());

  it('writes a consistent commit when main holds still', async () => {
    const repo = freshRepo();
    const writes: Writes = {};
    wire(repo, writes, false);

    const pr = await createReleasePullRequest(github);

    expect(pr.number).to.eql(22);
    expect(fileSource(writes)).to.eql('before');
    expect(treeBase(writes)).to.eql('before');
    expect(writes.commit!.parents).to.eql(['before']);
  });

  it('keeps file text, tree base and parent on one commit when main moves mid-run', async () => {
    const repo = freshRepo();
    const writes: Writes = {};
    wire(repo, writes, true);

    await createReleasePullRequest(github);

    const source = fileSource(writes);
    const base = treeBase(writes);
    const parent = writes.commit!.parents[0];
    const observed = `file text from ${source}, base_tree of ${base}, parent ${parent}`;
    expect(source, observed).to.not.eql('unknown');
    expect(base, observed).to.eql(source);
    expect(parent, observed).to.eql(source);
  });
});
