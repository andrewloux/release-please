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
import {Manifest} from '../src/manifest';
import {Update} from '../src/update';
import {PullRequestBody} from '../src/util/pull-request-body';
const fetch = require('node-fetch');

nock.disableNetConnect();

const HEAD_BRANCH = 'release-please--branches--main';
const PATH = 'charts/app/values.yaml';

// The push adds the extraConfig block.
const TEXT_BEFORE = 'image:\n  tag: 0.13.1\n';
const TEXT_AFTER = 'image:\n  tag: 0.13.1\nextraConfig:\n  enabled: true\n';

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

// The same moving branch, driven through Manifest.fromManifest and
// createPullRequests. Both trees carry the config and the versions manifest
// beside values.yaml; the push changes only values.yaml. `main` moves on the
// first GraphQL request, after fromManifest has read the config and the
// versions manifest and before the commit walk.

function config(extraFile: object): string {
  return JSON.stringify({
    // One commit per page, so the walk takes two GraphQL pages.
    'commit-batch-size': 1,
    packages: {
      '.': {'release-type': 'simple', 'extra-files': [extraFile]},
    },
  });
}
const CONFIG = config({type: 'yaml', path: PATH, jsonpath: '$.image.tag'});
// The simple strategy resolves this glob with findFilesByGlobAndRef.
const GLOB_CONFIG = config({
  type: 'yaml',
  path: 'charts/**/values.yaml',
  glob: true,
  jsonpath: '$.image.tag',
});
const VERSIONS = JSON.stringify({'.': '0.13.1'});

// Newest first: the push sits on top of the commit before it.
const HISTORY: Record<string, {message: string; parent?: string}> = {
  after: {message: 'feat: add the extraConfig block', parent: 'before'},
  before: {message: 'feat: add the app chart', parent: 'root'},
  root: {message: 'chore: initial commit'},
};

const RELEASE_PR = {
  number: 22,
  title: 'chore(main): release 0.13.2',
  body: new PullRequestBody([{notes: 'old release notes'}]).toString(),
  head: {ref: HEAD_BRANCH, label: `fake:${HEAD_BRANCH}`},
  base: {ref: 'main'},
  labels: [{name: 'autorelease: pending'}],
  merged_at: null,
  merge_commit_sha: null,
};

interface GraphQLRequest {
  query: string;
  variables: {
    sha?: string;
    targetBranch?: string;
    cursor?: string;
    num: number;
  };
}

// nock hands over a JSON body parsed or as text, depending on the request.
function json<T>(body: nock.Body): T {
  return (typeof body === 'string' ? JSON.parse(body) : body) as T;
}

interface RunWrites extends Writes {
  treeReads: string[];
  commitWalks: (GraphQLRequest & {start: string})[];
  createdRef?: string;
}

function manifestRepo(configText = CONFIG): Repo {
  const repo = freshRepo();
  for (const tree of Object.values(repo.trees)) {
    tree.push(
      {path: 'release-please-config.json', sha: 'blob-config'},
      {path: '.release-please-manifest.json', sha: 'blob-versions'}
    );
  }
  repo.blobs['blob-config'] = configText;
  repo.blobs['blob-versions'] = VERSIONS;
  return repo;
}

function commitHistory(start: string, cursor: string | undefined, num: number) {
  const shas: string[] = [];
  for (let sha: string | undefined = start; sha; sha = HISTORY[sha].parent) {
    shas.push(sha);
  }
  const offset = cursor ? Number(cursor) : 0;
  return {
    nodes: shas.slice(offset, offset + num).map(sha => ({
      sha,
      message: HISTORY[sha].message,
      associatedPullRequests: {nodes: []},
      author: {name: 'dev', email: 'dev@example.com', user: null},
    })),
    pageInfo: {
      hasNextPage: offset + num < shas.length,
      endCursor: String(offset + num),
    },
  };
}

// Wires every request a Manifest run makes. Branch-name lookups answer from
// repo.mainSha. SHA lookups answer from immutable objects. With
// `existing`, an open release pull request and its branch already exist.
function wireManifestRun(
  repo: Repo,
  writes: RunWrites,
  existing?: typeof RELEASE_PR
) {
  const api = nock('https://api.github.com');

  api
    .get('/repos/fake/fake/branches/main')
    .optionally()
    .times(4)
    .reply(200, () => ({name: 'main', commit: {sha: repo.mainSha}}));
  api
    .get(/\/repos\/fake\/fake\/git\/trees\/[^/?]+$/)
    .query(true)
    .optionally()
    .times(4)
    .reply(200, uri => {
      const key = uri.split('?')[0].split('/').pop()!;
      const commit = key === 'main' ? repo.mainSha : key;
      // Record the commit this fetch served. A fetch by branch name and a
      // fetch by SHA then compare equal when they return the same tree.
      writes.treeReads.push(commit);
      return treeReply(repo, repo.commits[commit]?.tree ?? commit);
    });
  api
    .get(/\/repos\/fake\/fake\/git\/blobs\/[^/]+$/)
    .optionally()
    .times(8)
    .reply(200, uri => blobReply(repo, uri.split('/').pop()!));

  // releases (none yet) and the commit walk share the GraphQL endpoint
  api
    .post('/graphql')
    .optionally()
    .times(4)
    .reply(200, (_uri, body) => {
      repo.mainSha = 'after';
      const request = json<GraphQLRequest>(body);
      if (request.query.includes('releases(')) {
        return {
          data: {
            repository: {
              releases: {
                nodes: [],
                pageInfo: {hasNextPage: false, endCursor: null},
              },
            },
          },
        };
      }
      const {sha, cursor, num} = request.variables;
      const start = sha ?? repo.mainSha;
      writes.commitWalks.push({...request, start});
      const history = commitHistory(start, cursor, num);
      return {
        data: {
          repository: sha ? {object: {history}} : {ref: {target: {history}}},
        },
      };
    });
  api
    .get(/\/repos\/fake\/fake\/commits\/(after|before|root)$/)
    .query(true)
    .optionally()
    .times(3)
    .reply(200, uri => ({
      sha: uri.split('?')[0].split('/').pop(),
      files: [{filename: PATH}],
    }));
  api.get('/repos/fake/fake/tags').query(true).reply(200, []);

  // merged, open and closed release pull requests; code-suggester's lookup by head
  api
    .get('/repos/fake/fake/pulls')
    .query(true)
    .times(4)
    .reply(200, uri => {
      const query = new URL(uri, 'https://api.github.com').searchParams;
      const open = query.get('state') === 'open' || query.has('head');
      return open && existing ? [existing] : [];
    });

  if (existing) {
    api.get(`/repos/fake/fake/git/ref/heads%2F${HEAD_BRANCH}`).reply(200, {
      ref: `refs/heads/${HEAD_BRANCH}`,
      object: {sha: 'previous-release', type: 'commit'},
    });
  } else {
    api
      .get(`/repos/fake/fake/git/ref/heads%2F${HEAD_BRANCH}`)
      .reply(404, {message: 'Not Found'});
    api.post('/repos/fake/fake/git/refs').reply(201, (_uri, body) => {
      const ref = json<{ref: string; sha: string}>(body);
      writes.createdRef = ref.sha;
      return {ref: ref.ref, object: {sha: ref.sha}};
    });
  }

  api
    .get(/\/repos\/fake\/fake\/git\/commits\/(before|after)$/)
    .optionally()
    .times(2)
    .reply(200, uri => {
      const sha = uri.split('/').pop()!;
      return {sha, tree: {sha: repo.commits[sha].tree}};
    });
  api.post('/repos/fake/fake/git/trees').reply(201, (_uri, body) => {
    writes.tree = json<Writes['tree']>(body);
    return {sha: 'treeGen'};
  });
  api.post('/repos/fake/fake/git/commits').reply(201, (_uri, body) => {
    writes.commit = json<Writes['commit']>(body);
    return {
      sha: 'C',
      url: 'https://api.github.com/repos/fake/fake/git/commits/C',
    };
  });
  api
    .patch(`/repos/fake/fake/git/refs/heads%2F${HEAD_BRANCH}`)
    .reply(200, {object: {sha: 'C'}});

  if (existing) {
    api.patch('/repos/fake/fake/pulls/22').reply(200, existing);
  } else {
    api.post('/repos/fake/fake/pulls').reply(201, {
      number: 22,
      url: 'https://api.github.com/repos/fake/fake/pulls/22',
    });
    api
      .post('/repos/fake/fake/issues/22/labels')
      .reply(200, [{name: 'autorelease: pending'}]);
    api.get('/repos/fake/fake/pulls/22').reply(200, RELEASE_PR);
  }
  return api;
}

// Which commit's file text the bumped values.yaml came from.
function bumpedFileSource(writes: Writes): 'before' | 'after' | 'unknown' {
  const content = writes.tree!.tree.find(e => e.path === PATH)?.content;
  if (!content || !content.includes('tag: 0.14.0')) return 'unknown';
  return content.includes('extraConfig') ? 'after' : 'before';
}

// The commit each part of the release commit came from. One run must land
// on one commit; which one is secondary.
function snapshots(writes: RunWrites) {
  return {
    walk: writes.commitWalks[0]?.start,
    file: bumpedFileSource(writes),
    tree: treeBase(writes),
    parent: writes.commit!.parents[0],
  };
}

function expectOneCommit(writes: RunWrites, commit: string) {
  const seen = snapshots(writes);
  expect(new Set(Object.values(seen)).size, JSON.stringify(seen)).to.eql(1);
  expect(seen.parent).to.eql(commit);
  expect([...new Set(writes.treeReads)]).to.eql([commit]);
  for (const walk of writes.commitWalks) {
    expect(walk.start).to.eql(commit);
  }
}

function newRunWrites(): RunWrites {
  return {treeReads: [], commitWalks: []};
}

describe('snapshot race through Manifest', () => {
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

  it('reads config, manifest, commits and files from the commit before the push', async () => {
    const repo = manifestRepo();
    const writes = newRunWrites();
    wireManifestRun(repo, writes);

    const manifest = await Manifest.fromManifest(github, 'main');
    const pullRequests = await manifest.createPullRequests();

    expect(pullRequests.map(pullRequest => pullRequest?.number)).to.eql([22]);
    expectOneCommit(writes, 'before');
    expect(writes.createdRef).to.eql('before');
    expect(writes.commitWalks).lengthOf(2);
  });

  it('force-pushes an open release pull request onto the commit before the push', async () => {
    const repo = manifestRepo();
    const writes = newRunWrites();
    wireManifestRun(repo, writes, RELEASE_PR);

    const manifest = await Manifest.fromManifest(github, 'main');
    const pullRequests = await manifest.createPullRequests();

    expect(pullRequests.map(pullRequest => pullRequest?.number)).to.eql([22]);
    expectOneCommit(writes, 'before');
    expect(writes.createdRef).to.be.undefined;
  });

  it('resolves a strategy extra-files glob against the commit before the push', async () => {
    const repo = manifestRepo(GLOB_CONFIG);
    const writes = newRunWrites();
    wireManifestRun(repo, writes);

    const manifest = await Manifest.fromManifest(github, 'main');
    const [pullRequest] = await manifest.buildPullRequests();

    // The glob runs after the push. It must search the tree fetched before
    // the push, like every other read in the run.
    expect(pullRequest.updates.map(update => update.path)).to.include(PATH);
    expect([...new Set(writes.treeReads)]).to.eql(['before']);
  });
});
