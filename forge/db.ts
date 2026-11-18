// The forge's REST-side records: labels, issues, comments and pull requests, one set per repository.
// A trial is one process, so these live in memory; every timestamp comes from the trial's own clock
// (trees.ts trialIso), and every id is a counter, so two runs on one seed write the same JSON.

import { trialIso } from './trees.ts';

export interface LabelRecord {
  readonly id: number;
  readonly name: string;
  readonly color: string;
  readonly description: string;
}

export interface CommentRecord {
  readonly id: number;
  readonly body: string;
  readonly createdAt: string;
  readonly login: string;
}

export interface IssueRecord {
  readonly id: number;
  readonly number: number;
  readonly title: string;
  readonly body: string;
  state: 'open' | 'closed';
  readonly labels: string[];
  readonly createdAt: string;
  readonly updatedAt: string;
  closedAt: string | null;
  readonly comments: CommentRecord[];
  readonly login: string;
}

export interface PullRecord {
  readonly id: number;
  readonly number: number;
  readonly title: string;
  readonly body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  readonly head: string;
  readonly base: string;
  headSha: string;
  baseSha: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly login: string;
}

/** One repository's records and counters. */
export class RepoRecords {
  readonly labels = new Map<string, LabelRecord>();
  readonly issues: IssueRecord[] = [];
  readonly pulls: PullRecord[] = [];
  private nextLabelId = 1;
  private nextIssueId = 1;
  private nextIssueNumber = 1;
  private nextCommentId = 1;
  private nextPullId = 1;
  private nextPullNumber = 1;

  addLabel(name: string, color: string, description: string): LabelRecord {
    const existing = this.labels.get(name);
    if (existing !== undefined) return existing;
    const label: LabelRecord = { id: this.nextLabelId, name, color, description };
    this.nextLabelId += 1;
    this.labels.set(name, label);
    return label;
  }

  hasLabel(name: string): boolean {
    return this.labels.has(name);
  }

  addIssue(input: { title: string; body: string; labels: readonly string[]; login: string }): IssueRecord {
    const now = trialIso();
    const issue: IssueRecord = {
      id: this.nextIssueId,
      number: this.nextIssueNumber,
      title: input.title,
      body: input.body,
      state: 'open',
      labels: [...input.labels],
      createdAt: now,
      updatedAt: now,
      closedAt: null,
      comments: [],
      login: input.login,
    };
    this.nextIssueId += 1;
    this.nextIssueNumber += 1;
    this.issues.push(issue);
    return issue;
  }

  issueByNumber(number: number): IssueRecord | null {
    return this.issues.find((issue) => issue.number === number) ?? null;
  }

  addComment(issue: IssueRecord, body: string, login: string): CommentRecord {
    const comment: CommentRecord = { id: this.nextCommentId, body, createdAt: trialIso(), login };
    this.nextCommentId += 1;
    issue.comments.push(comment);
    return comment;
  }

  /** One comment by its id across every issue (the GraphQL node lookup). */
  commentById(id: number): { issue: IssueRecord; comment: CommentRecord } | null {
    for (const issue of this.issues) {
      const comment = issue.comments.find((candidate) => candidate.id === id);
      if (comment !== undefined) return { issue, comment };
    }
    return null;
  }

  addPull(input: {
    title: string;
    body: string;
    head: string;
    base: string;
    headSha: string;
    baseSha: string;
    login: string;
  }): PullRecord {
    const now = trialIso();
    const pull: PullRecord = {
      id: this.nextPullId,
      number: this.nextPullNumber,
      title: input.title,
      body: input.body,
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      head: input.head,
      base: input.base,
      headSha: input.headSha,
      baseSha: input.baseSha,
      createdAt: now,
      updatedAt: now,
      login: input.login,
    };
    this.nextPullId += 1;
    this.nextPullNumber += 1;
    this.pulls.push(pull);
    return pull;
  }

  pullByNumber(number: number): PullRecord | null {
    return this.pulls.find((pull) => pull.number === number) ?? null;
  }
}

/** Every repository's records, created on first use. */
export class Records {
  private readonly byRepo = new Map<string, RepoRecords>();

  of(repo: string): RepoRecords {
    let records = this.byRepo.get(repo);
    if (records === undefined) {
      records = new RepoRecords();
      this.byRepo.set(repo, records);
    }
    return records;
  }

  remove(repo: string): void {
    this.byRepo.delete(repo);
  }

  names(): string[] {
    return [...this.byRepo.keys()];
  }
}

/**
 * The GraphQL global id: base64 of "<kind>:<id>", the form the documents read back and the node()
 * lookup parses. Stable for a record's lifetime, which is the whole trial.
 */
export function globalId(kind: string, id: number): string {
  return Buffer.from(`${kind}:${id}`, 'utf8').toString('base64');
}

/** Parse a global id back to its kind and numeric id; null when it is not one of ours. */
export function parseGlobalId(value: string): { kind: string; id: number } | null {
  let text: string;
  try {
    text = Buffer.from(value, 'base64').toString('utf8');
  } catch {
    return null;
  }
  const match = /^([A-Za-z]+):(\d+)$/.exec(text);
  if (match === null) return null;
  return { kind: match[1] as string, id: Number(match[2]) };
}
